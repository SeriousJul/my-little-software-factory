/**
 * The control plane shell: panes, refresh, selection, handoff, and the
 * herdr observation loop (ADR 0005, ADR 0006).
 *
 * The mode line carries the auto-handoff state and the live agent count
 * against the parallel limit. Enter on an open ticket hands it off; Enter
 * on an awaiting ticket opens the decision panel (close, Goto, or a
 * workflow handoff), unless the task type is auto-close and decides alone;
 * Enter on a blocked ticket Gotos the agent; Enter on an in-flight ticket
 * whose pane herdr no longer lists opens the missing panel (restart or
 * abandon). `a` toggles auto-handoff.
 */
import os from "node:os";
import { createElement, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
	DEFAULT_CONFIG,
	defaultConfigPath,
	type FactoryConfig,
	persistConfig,
	type WorkflowEdge,
} from "../config.ts";
import {
	HANDOFF_ENVIRONMENT_KINDS,
	type Handoff,
	type Ticket,
	type TicketState,
} from "../domain/ticket.ts";
import {
	baseChoice,
	closeHandoffEnvironment,
	type HandoffChoice,
	type HandoffOutcome,
	handOffStoredWorkspace,
	handOffTicket,
} from "../handoff.ts";
import {
	type DispatchResult,
	type HandoffIntent,
	type HerdrAgent,
	HerdrAgentReader,
	normalizeAgentStatus,
	ObservationCoordinator,
} from "../observation.ts";
import { RefreshCoordinator } from "../refresh.ts";
import { commandFailureText, type RepositoryMapping } from "../repo.ts";
import { type CommandRunner, createChildProcessRunner, errorMessage } from "../runner.ts";
import type { FactoryState, HandoffClaim, HandoffOrigin } from "../state.ts";
import type { TicketSource } from "../ticket-source.ts";
import { ActionPanel, type ActionRow } from "./action-panel.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { type AgentSettings, OverridePanel } from "./override-panel.ts";
import { truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";
import { detailLines, TicketDetail } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";

type Pane = "list" | "detail";
interface StatusMessage {
	kind: "info" | "warning" | "error";
	text: string;
}
/** The action modal open above the panes, if any. */
type Panel = null | { kind: "decision"; identity: string } | { kind: "missing"; identity: string };

export type AppKey =
	| "j"
	| "k"
	| "h"
	| "l"
	| "q"
	| "e"
	| "r"
	| "a"
	| "up"
	| "down"
	| "left"
	| "right";

export interface AppProps {
	config?: FactoryConfig;
	runner?: CommandRunner;
	home?: string;
	configPath?: string;
	/** SQLite state. The factory entry module owns its process lease. */
	state?: FactoryState;
	/** Bound sources. Tests inject deterministic sources here. */
	sources?: readonly TicketSource[];
	/** Test-only deterministic ticket projection. It has no production caller. */
	initialTickets?: readonly Ticket[];
	/**
	 * Test-only observation poll interval in milliseconds. Production reads
	 * it from the config's agent-poll-interval-seconds.
	 */
	pollIntervalMs?: number;
	/**
	 * Receives the teardown handle once the app is mounted. The owner calls
	 * stop before closing the state: the background loops must not outlive
	 * it. Production relies on process exit instead.
	 */
	onReady?: (ready: AppTeardown) => void;
}

export interface AppTeardown {
	/** Stops the refresh and observation loops. Safe to call twice. */
	stop: () => void;
}

const EMPTY_SOURCES: readonly TicketSource[] = [];
let lazyRealRunner: CommandRunner | undefined;
function realRunner(): CommandRunner {
	lazyRealRunner ??= createChildProcessRunner();
	return lazyRealRunner;
}

export function App({
	config: configProp,
	runner,
	home,
	configPath,
	state,
	sources = EMPTY_SOURCES,
	initialTickets,
	pollIntervalMs,
	onReady,
}: AppProps) {
	const renderer = useRenderer();
	const { width: terminalWidth } = useTerminalDimensions();
	const [config, setConfig] = useState<FactoryConfig>(() => configProp ?? DEFAULT_CONFIG);
	// Only test callers supply deterministic tickets. Production starts with
	// the empty SQLite projection while configured sources refresh.
	const [tickets, setTickets] = useState<Ticket[]>(() => [...(initialTickets ?? [])]);
	const ticketsRef = useRef(tickets);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selectedIndexRef = useRef(0);
	const configRef = useRef(config);
	configRef.current = config;
	const [focusedPane, setFocusedPane] = useState<Pane>("list");
	const [detailScroll, setDetailScroll] = useState(0);
	const [status, setStatus] = useState<StatusMessage | null>(null);
	const [override, setOverride] = useState<HandoffChoice | null>(null);
	const [healths, setHealths] = useState(() => state?.sourceHealths() ?? []);
	const [panel, setPanel] = useState<Panel>(null);
	const [autoMode, setAutoMode] = useState<boolean>(
		() => (configProp ?? DEFAULT_CONFIG).autoHandoff,
	);
	const autoModeRef = useRef(autoMode);
	const [agents, setAgents] = useState<readonly HerdrAgent[] | null>(null);
	// The key handler outlives the render that made the decision it acts on,
	// so the marker it re-checks reads the latest list through a ref.
	const agentsRef = useRef<readonly HerdrAgent[] | null>(null);
	agentsRef.current = agents;
	const inFlightRef = useRef(false);
	// Handoffs claimed while another is in flight: they run in claim order
	// once the running one settles.
	const queueRef = useRef<
		readonly {
			ticket: Ticket;
			choice: HandoffChoice;
			origin: HandoffOrigin;
			claim: HandoffClaim;
			previousMessage: string;
		}[]
	>([]);
	const coordinatorRef = useRef<RefreshCoordinator | undefined>(undefined);
	const observationRef = useRef<ObservationCoordinator | undefined>(undefined);

	const commandRunner = runner ?? realRunner();
	const homeDir = home ?? os.homedir();
	const configFile = configPath ?? defaultConfigPath();
	const healthLine = healths
		.filter((health) => health.health === "stale" || health.health === "removed")
		.map(
			(health) =>
				`${health.name}: ${health.health}${health.error === undefined ? "" : ` - ${health.error}`}`,
		)
		.join("; ");
	// The mode line carries the auto-handoff state and the live agent count:
	// the in-flight tickets whose agent was alive in the latest poll, against
	// the parallel limit. It exists only when the control plane has state to
	// observe.
	const liveCount =
		agents === null
			? 0
			: tickets.filter(
					(ticket) =>
						(ticket.state === "handed-off" || ticket.state === "running") &&
						(ticket.handoff?.paneId ?? null) !== null &&
						agents.some((agent) => agent.paneId === ticket.handoff?.paneId),
				).length;
	const modeLine =
		state === undefined
			? ""
			: `auto: ${autoMode ? "on" : "off"} ${liveCount}${
					config.maxParallelAgents === 0 ? "" : `/${config.maxParallelAgents}`
				}`;
	const reservedRows =
		(status === null ? 0 : 1) + (healthLine === "" ? 0 : 1) + (modeLine === "" ? 0 : 1);
	const detailGeometry = usePaneGeometry("detail", reservedRows);
	const selectedTicket = tickets[selectedIndex];
	const lines = detailLines(selectedTicket, detailGeometry.usableCols, config.maxHandoffsPerTicket);
	const maxScroll = maxScrollOf(lines.length, detailGeometry.visibleRows);
	const scroll = Math.min(detailScroll, maxScroll);

	const replaceTickets = useCallback(() => {
		if (state === undefined) return;
		const currentConfig = configRef.current;
		const next = state.visibleTickets(currentConfig.taskRules, currentConfig.defaultTaskType);
		const currentIndex = selectedIndexRef.current;
		const selectedId = ticketsRef.current[currentIndex]?.identity;
		const preserved =
			selectedId === undefined ? -1 : next.findIndex((ticket) => ticket.identity === selectedId);
		const nextIndex =
			preserved >= 0 ? preserved : Math.max(0, Math.min(currentIndex, next.length - 1));
		ticketsRef.current = next;
		selectedIndexRef.current = nextIndex;
		setTickets(next);
		setHealths(state.sourceHealths());
		setSelectedIndex(nextIndex);
		if (selectedId === undefined || !next.some((ticket) => ticket.identity === selectedId))
			setDetailScroll(0);
	}, [state]);

	const agentSettings: Record<string, AgentSettings> = Object.fromEntries(
		Object.entries(config.agents).map(([name, agent]) => [
			name,
			{
				model: agent.model !== undefined,
				thinking: agent.thinking !== undefined,
				thinkingValues: agent.thinkingValues,
			},
		]),
	);
	// The task types' thinking defaults, keyed by task type name, for the
	// override panel's thinking row.
	const thinkingDefaults: Record<string, string | undefined> = Object.fromEntries(
		Object.entries(config.taskTypes).map(([name, type]) => [name, type.thinking]),
	);
	const choiceFor = (ticket: Ticket): HandoffChoice =>
		baseChoice(
			config.defaultAgent,
			config.defaultEnvironment,
			ticket.suggestedTaskType,
			"",
			// The task type's thinking default: the panel shows it as the
			// starting value of the thinking row, and Enter applies it. The
			// operator picks another level in the panel, or clears a free-text
			// row to leave the level to the agent.
			config.taskTypes[ticket.suggestedTaskType]?.thinking ?? "",
		);

	/** The failure marker of an in-flight ticket from the last observation. */
	const markerOf = (ticket: Ticket): "blocked" | "missing" | null => {
		if (ticket.state !== "handed-off" && ticket.state !== "running") return null;
		const paneId = ticket.handoff?.paneId ?? null;
		// No successful observation yet: an unreadable herdr must not read
		// as "every pane is missing".
		if (paneId === null || agentsRef.current === null) return null;
		const agent = agentsRef.current.find((candidate) => candidate.paneId === paneId);
		if (agent === undefined) return "missing";
		return normalizeAgentStatus(agent.status) === "blocked" ? "blocked" : null;
	};

	const persistMapping = async (mapping: RepositoryMapping): Promise<string | undefined> => {
		try {
			const updated = { ...config, repos: { ...config.repos, [mapping.repository]: mapping.path } };
			setConfig(updated);
			await persistConfig(configFile, updated);
			return undefined;
		} catch (error) {
			return `could not persist the repository mapping: ${errorMessage(error)}`;
		}
	};

	/** The status line after a handoff outcome, mapping warnings included. */
	const finishOutcome = async (outcome: HandoffOutcome): Promise<void> => {
		const persistWarning =
			outcome.notes?.mappingToWrite === undefined
				? undefined
				: await persistMapping(outcome.notes.mappingToWrite);
		if (outcome.status !== "ok")
			setStatus({
				kind: "error",
				text:
					persistWarning === undefined ? outcome.reason : `${outcome.reason}; ${persistWarning}`,
			});
		else if (persistWarning !== undefined) setStatus({ kind: "warning", text: persistWarning });
		else if (outcome.notes?.warning !== undefined)
			setStatus({ kind: "warning", text: outcome.notes.warning });
		else setStatus(null);
	};

	/**
	 * Run the external work of a claimed handoff, settle it, and refresh.
	 *
	 * A workflow handoff and a restart run in the workspace of the ticket's
	 * previous handoff; an open-ticket handoff builds the environment from
	 * scratch. A handoff claimed while another runs queues behind it: the
	 * claim has already moved the ticket, so only the external work waits.
	 * When the in-flight handoff settles, the queue drains: the seat is
	 * free, so the next claimed handoff starts.
	 */
	const runClaimedHandoff = (
		ticket: Ticket,
		choice: HandoffChoice,
		origin: HandoffOrigin,
		claim: HandoffClaim,
		previousMessage: string,
	) => {
		if (state === undefined) return;
		if (inFlightRef.current) {
			queueRef.current = [...queueRef.current, { ticket, choice, origin, claim, previousMessage }];
			return;
		}
		inFlightRef.current = true;
		setStatus({ kind: "info", text: `handing off "${ticket.title}"...` });
		const onStage = (stage: string) => state.advanceHandoffAttempt(claim.attemptId, stage);
		const run =
			origin === "open"
				? handOffTicket(ticket, choice, {
						config: configRef.current,
						runner: commandRunner,
						home: homeDir,
						onStage,
					})
				: handOffStoredWorkspace({
						ticket,
						choice,
						config: configRef.current,
						runner: commandRunner,
						home: homeDir,
						workspaceId: ticket.handoff?.workspaceId ?? null,
						environment: ticket.handoff?.environment ?? configRef.current.defaultEnvironment,
						previousTabId: ticket.handoff?.tabId ?? null,
						previousMessage,
						onStage,
					});
		void run
			.then(async (outcome) => {
				state.settleHandoff(
					claim.attemptId,
					outcome.status !== "failed",
					outcome.status === "failed" ? outcome.reason : undefined,
					outcome.status === "failed"
						? undefined
						: {
								paneId: outcome.agent.paneId,
								tabId: outcome.agent.tabId,
								workspaceId: outcome.agent.workspaceId,
							},
				);
				// The manual route's decision lands here, on the settled turn's
				// trace, and only when the routed handoff actually started:
				// the agent's pane is live, so the ticket reads as handed-off
				// where the agent is. A failed route leaves the trace pending,
				// so Close and Goto keep working on the awaiting ticket.
				if (outcome.status !== "failed" && origin === "workflow") {
					const previousHandoffId = ticket.handoff?.attemptId ?? "";
					if (previousHandoffId !== "") {
						state.applyCompletionDecision({
							ticketIdentity: ticket.identity,
							handoffId: previousHandoffId,
							decision: "handed-off",
							decidedAt: new Date().toISOString(),
						});
					}
				}
				replaceTickets();
				await finishOutcome(outcome);
				inFlightRef.current = false;
				drainQueue();
			})
			.catch((error) => {
				state.settleHandoff(claim.attemptId, false, errorMessage(error));
				replaceTickets();
				setStatus({ kind: "error", text: `handoff failed: ${errorMessage(error)}` });
				inFlightRef.current = false;
				drainQueue();
			});
	};

	/**
	 * Drain the handoff queue once the seat is free.
	 *
	 * Every queued handoff re-checks the ticket's durable state before it
	 * runs: the claim passed when the queue formed, and the ticket may
	 * have moved on since (the cycle closed, the turn settled, the ticket
	 * left the state). A moved-on ticket settles its claim as failed
	 * instead of running a handoff on a stale snapshot, and the queue
	 * keeps draining, so a later item still starts when the seat frees.
	 */
	const drainQueue = (): void => {
		if (state === undefined) return;
		while (queueRef.current.length > 0 && !inFlightRef.current) {
			const next = queueRef.current[0];
			queueRef.current = queueRef.current.slice(1);
			const currentState = state.ticketState(next.ticket.identity);
			if (currentState === undefined || !handoffAllowsState(next.origin, currentState)) {
				state.settleHandoff(
					next.claim.attemptId,
					false,
					currentState === undefined
						? "the ticket no longer exists"
						: `the ticket is now ${currentState}`,
				);
				replaceTickets();
				setStatus({
					kind: "warning",
					text:
						currentState === undefined
							? `queued handoff for "${next.ticket.title}" was not run: the ticket no longer exists`
							: `queued handoff for "${next.ticket.title}" was not run: the ticket is now ${currentState}`,
				});
				continue;
			}
			// The fresh projection when the ticket is visible, else the claim's
			// snapshot: the handoff runs on the ticket it claimed.
			const snapshot =
				state
					.visibleTickets(configRef.current.taskRules, configRef.current.defaultTaskType)
					.find((candidate) => candidate.identity === next.ticket.identity) ?? next.ticket;
			runClaimedHandoff(snapshot, next.choice, next.origin, next.claim, next.previousMessage);
		}
	};

	/**
	 * The observation loop's handoff path: it decides, the app runs.
	 *
	 * The coordinator dispatches through a ref, so the loop never restarts
	 * when a render recreates this function.
	 */
	// The intent is claimed now: the ticket moves out of its current state at
	// once, so a second cycle cannot claim the same work. The external work
	// runs immediately or behind the handoff already in flight.
	const runIntent = (intent: HandoffIntent): Promise<DispatchResult> => {
		if (state === undefined) return Promise.resolve({ ok: false, reason: "the state is not open" });
		const currentConfig = configRef.current;
		const all = state.visibleTickets(currentConfig.taskRules, currentConfig.defaultTaskType);
		const ticket = all.find((candidate) => candidate.identity === intent.ticketIdentity);
		if (ticket === undefined)
			return Promise.resolve({ ok: false, reason: "the ticket no longer exists" });
		const claim = state.claimHandoff(intent.ticketIdentity, intent.choice, intent.origin);
		if (!claim.ok) return Promise.resolve({ ok: false, reason: claim.reason });
		runClaimedHandoff(ticket, intent.choice, intent.origin, claim.claim, intent.previousMessage);
		return Promise.resolve({ ok: true });
	};
	const runIntentRef = useRef(runIntent);
	runIntentRef.current = runIntent;

	const startHandoff = (choice: HandoffChoice) => {
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket === undefined) {
			setStatus({ kind: "warning", text: "no ticket is selected" });
			return;
		}
		if (ticket.state !== "open") {
			setStatus({ kind: "warning", text: "only open tickets can be handed off" });
			return;
		}
		if (ticket.actionable === false) {
			setStatus({
				kind: "warning",
				text: ticket.handoffRecoveryRequired
					? "handoff recovery is required before another handoff"
					: "ticket is not actionable because its sources are stale, removed, or absent",
			});
			return;
		}
		if (state !== undefined) {
			const claim = state.claimHandoff(ticket.identity, choice, "open");
			if (!claim.ok) {
				setStatus({ kind: "warning", text: claim.reason });
				return;
			}
			runClaimedHandoff(ticket, choice, "open", claim.claim, "");
			return;
		}
		// The no-state test projection: no claim, and the settle patches the
		// ticket list by hand instead of reading it back from SQLite. It has no
		// queue, so it refuses to run behind a handoff already in flight.
		if (inFlightRef.current) {
			setStatus({ kind: "warning", text: "handoff in flight" });
			return;
		}
		inFlightRef.current = true;
		setStatus({ kind: "info", text: `handing off "${ticket.title}"...` });
		void handOffTicket(ticket, choice, { config, runner: commandRunner, home: homeDir })
			.then(async (outcome) => {
				if (outcome.status !== "failed") {
					const handoff: Handoff = {
						agentType: choice.agentType,
						environment: choice.environment,
						taskType: choice.taskType,
						model: choice.model,
						thinking: choice.thinking,
						attemptId: "manual",
						paneId: outcome.agent.paneId,
						tabId: outcome.agent.tabId,
						workspaceId: outcome.agent.workspaceId,
					};
					setTickets((all) => {
						const next = all.map((candidate, index) =>
							index === selectedIndexRef.current
								? { ...candidate, state: "handed-off" as const, handoff }
								: candidate,
						);
						ticketsRef.current = next;
						return next;
					});
				}
				await finishOutcome(outcome);
				inFlightRef.current = false;
			})
			.catch((error) => {
				setStatus({ kind: "error", text: `handoff failed: ${errorMessage(error)}` });
				inFlightRef.current = false;
			});
	};

	const openOverride = () => {
		if (inFlightRef.current) {
			setStatus({ kind: "warning", text: "handoff in flight" });
			return;
		}
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket === undefined || ticket.state !== "open") {
			setStatus({ kind: "warning", text: "only open tickets can be handed off" });
			return;
		}
		if (ticket.actionable === false) {
			setStatus({
				kind: "warning",
				text: ticket.handoffRecoveryRequired
					? "handoff recovery is required before another handoff"
					: "ticket is not actionable because its sources are stale, removed, or absent",
			});
			return;
		}
		setOverride(choiceFor(ticket));
	};

	/**
	 * Toggle auto-handoff for this session. The config's value is the
	 * startup default only; the toggle never writes the config.
	 */
	const toggleAutoHandoff = () => {
		const next = !autoModeRef.current;
		autoModeRef.current = next;
		setAutoMode(next);
		setStatus({ kind: "info", text: `auto-handoff ${next ? "on" : "off"}` });
	};

	// The decision panel's rows: Close first, selected by default, then a Goto,
	// then one handoff row per outgoing workflow edge the completed task type
	// has, in config order: every edge stays reachable, and an edge naming
	// several targets offers one row per target. Two edges to the same target
	// offer two rows, and the row's detail shows the edge's pinning so the
	// operator can tell them apart.
	const decisionFor = (ticket: Ticket): { actions: ActionRow[]; body: string[] } => {
		const taskType =
			ticket.lastCompletion?.taskType ?? ticket.handoff?.taskType ?? ticket.suggestedTaskType;
		const actions: ActionRow[] = [
			{ key: "close", label: "Close", detail: "end the work cycle; the ticket returns to open" },
			{ key: "goto", label: "Goto", detail: "focus the agent's pane; the handoff stays open" },
		];
		configRef.current.workflows.forEach((edge, index) => {
			if (edge.from !== taskType) return;
			for (const target of edge.to) {
				actions.push({
					key: `route:${index}:${target}`,
					label: `Handoff: ${target}`,
					detail: routeDetail(edge, target),
				});
			}
		});
		return {
			actions,
			body: ticket.lastCompletion === null ? [] : ticket.lastCompletion.message.split("\n"),
		};
	};

	/** The handoff row's detail: the edge's pinning, or the target. */
	const routeDetail = (edge: WorkflowEdge, target: string): string => {
		const pin: string[] = [];
		if (edge.agent !== undefined) pin.push(`agent ${edge.agent}`);
		if (edge.environment !== undefined) pin.push(`environment ${edge.environment}`);
		return pin.length > 0 ? pin.join(", ") : target;
	};

	// Goto: the operator focuses the agent's pane in herdr and the handoff
	// stays open. The ticket moves awaiting to running; the trace does not
	// record it, and the next settle refreshes the turn's pending trace.
	const runGoto = (ticket: Ticket) => {
		if (state === undefined) return;
		const paneId = ticket.handoff?.paneId ?? null;
		if (paneId === null) {
			setStatus({ kind: "warning", text: "no agent pane is recorded for this ticket" });
			return;
		}
		void commandRunner.run("herdr", ["agent", "focus", paneId]).then((result) => {
			if (result.code !== 0) {
				setStatus({ kind: "error", text: `agent focus failed: ${commandFailureText(result)}` });
				return;
			}
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: ticket.handoff?.attemptId ?? "",
				decision: "goto",
				decidedAt: new Date().toISOString(),
			});
			replaceTickets();
			setStatus({ kind: "info", text: `focused the agent of ticket ${ticket.identity}` });
		});
	};

	// Run a decision-panel action: close (with the Close cleanup), Goto, a
	// workflow handoff, or (from the missing panel) restart and abandon.
	const runDecisionAction = (ticket: Ticket, key: string) => {
		setPanel(null);
		if (state === undefined) return;
		const handoffId = ticket.handoff?.attemptId ?? "";
		if (key === "close") {
			const applied = state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId,
				decision: "closed",
				decidedAt: new Date().toISOString(),
			});
			replaceTickets();
			if (!applied) {
				setStatus({ kind: "warning", text: `ticket ${ticket.identity} already decided` });
				return;
			}
			// The Close cleanup: the environment of the handoff the decision ends.
			const stored = state.latestHandoff(ticket.identity);
			if (stored !== null) {
				void closeHandoffEnvironment(stored, commandRunner).then((failure) => {
					if (failure !== undefined) {
						setStatus({
							kind: "error",
							text: `ticket ${ticket.identity} closed; the close cleanup failed: ${failure}`,
						});
					}
				});
			}
			setStatus({ kind: "info", text: `ticket ${ticket.identity} closed` });
			return;
		}
		if (key === "goto") {
			runGoto(ticket);
			return;
		}
		// key === `route:<edge index>:<target>`: the row's edge, re-read from
		// the config, so a runtime config change cannot point the action at a
		// moved or removed edge.
		const rest = key.slice("route:".length);
		const separator = rest.indexOf(":");
		const edge = configRef.current.workflows[Number(rest.slice(0, separator))];
		const target = rest.slice(separator + 1);
		const taskType =
			ticket.lastCompletion?.taskType ?? ticket.handoff?.taskType ?? ticket.suggestedTaskType;
		if (edge === undefined || edge.from !== taskType || !edge.to.includes(target)) {
			setStatus({ kind: "warning", text: `no workflow edge from ${taskType} to ${target}` });
			return;
		}
		const stored = ticket.handoff;
		// Claim first: a refused claim leaves the ticket where it was. The
		// turn's decision is not recorded here: it lands on the settled
		// turn's trace in the handoff's settle path, and only when the
		// routed handoff actually started. A failed route leaves the trace
		// pending, so Close and Goto keep working.
		const choice = baseChoice(
			edge.agent ?? configRef.current.defaultAgent,
			edge.environment ?? configRef.current.defaultEnvironment,
			target,
			stored?.model ?? "",
			stored?.thinking ?? "",
		);
		const claim = state.claimHandoff(ticket.identity, choice, "workflow");
		if (!claim.ok) {
			setStatus({ kind: "warning", text: claim.reason });
			return;
		}
		runClaimedHandoff(
			ticket,
			choice,
			"workflow",
			claim.claim,
			ticket.lastCompletion?.message ?? "",
		);
	};

	const runMissingAction = (ticket: Ticket, key: string) => {
		setPanel(null);
		if (state === undefined) return;
		if (key === "abandon") {
			const applied = state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: ticket.handoff?.attemptId ?? "",
				decision: "abandoned",
				decidedAt: new Date().toISOString(),
			});
			replaceTickets();
			if (!applied) {
				setStatus({ kind: "warning", text: `ticket ${ticket.identity} already decided` });
				return;
			}
			const stored = state.latestHandoff(ticket.identity);
			if (stored !== null) {
				void closeHandoffEnvironment(stored, commandRunner).then((failure) => {
					if (failure !== undefined) {
						setStatus({
							kind: "error",
							text: `ticket ${ticket.identity} abandoned; the close cleanup failed: ${failure}`,
						});
					}
				});
			}
			setStatus({ kind: "warning", text: `ticket ${ticket.identity} abandoned` });
			return;
		}
		// Restart: the same choices, in the workspace the handoff recorded.
		const stored = ticket.handoff;
		const choice =
			stored === null
				? choiceFor(ticket)
				: baseChoice(
						stored.agentType,
						stored.environment,
						stored.taskType,
						stored.model,
						stored.thinking,
					);
		const claim = state.claimHandoff(ticket.identity, choice, "restart");
		if (!claim.ok) {
			setStatus({ kind: "warning", text: claim.reason });
			return;
		}
		runClaimedHandoff(ticket, choice, "restart", claim.claim, ticket.lastCompletion?.message ?? "");
	};

	useKeyboard((key) => {
		if (override !== null || panel !== null) return;
		switch (key.name) {
			case "q":
				renderer.destroy();
				break;
			case "h":
			case "left":
				setFocusedPane("list");
				break;
			case "l":
			case "right":
				setFocusedPane("detail");
				break;
			case "j":
			case "down":
				moveVertical(1);
				break;
			case "k":
			case "up":
				moveVertical(-1);
				break;
			case "return": {
				const ticket = ticketsRef.current[selectedIndexRef.current];
				if (ticket === undefined) break;
				if (ticket.state === "open") {
					startHandoff(choiceFor(ticket));
					break;
				}
				if (ticket.state === "awaiting") {
					// An auto-close type decides by itself: the operator has no panel for
					// it.
					const taskType =
						ticket.lastCompletion?.taskType ?? ticket.handoff?.taskType ?? ticket.suggestedTaskType;
					if (configRef.current.taskTypes[taskType]?.autoClose === true) {
						setStatus({
							kind: "info",
							text: `task type ${taskType} is auto-close: the factory decides this ticket`,
						});
						break;
					}
					setPanel({ kind: "decision", identity: ticket.identity });
					break;
				}
				if (markerOf(ticket) === "blocked") {
					runGoto(ticket);
					break;
				}
				if (markerOf(ticket) === "missing") {
					setPanel({ kind: "missing", identity: ticket.identity });
					break;
				}
				setStatus({ kind: "warning", text: "only open tickets can be handed off" });
				break;
			}
			case "e":
				openOverride();
				break;
			case "a":
				toggleAutoHandoff();
				break;
			case "r":
				coordinatorRef.current?.refreshAll();
				break;
			default:
				break;
		}
	});

	// A state may already hold tickets when the app boots: read them once at
	// mount, before any refresh or observation cycle runs.
	useEffect(() => {
		if (state === undefined) return;
		replaceTickets();
	}, [state, replaceTickets]);

	// A ref lets the key handler use the startup coordinator without making
	// React recreate keyboard subscriptions on each frame.
	useEffect(() => {
		if (state === undefined) return;
		const coordinator = new RefreshCoordinator(sources, state, () => {
			replaceTickets();
			// A fetch may have made a ticket actionable: let the observation
			// loop act on it now instead of on the next poll.
			observationRef.current?.tick();
		});
		coordinatorRef.current = coordinator;
		coordinator.start();
		return () => {
			coordinator.stop();
			coordinatorRef.current = undefined;
		};
	}, [state, sources, replaceTickets]);

	// The observation loop runs only on the real projection: a test
	// projection has no agents to observe, and a deterministic frame test
	// must not race a poll.
	useEffect(() => {
		if (state === undefined || initialTickets !== undefined) return;
		const coordinator = new ObservationCoordinator({
			state,
			herdr: new HerdrAgentReader(commandRunner),
			config: () => configRef.current,
			dispatch: (intent) => runIntentRef.current(intent),
			// The Close cleanup of an auto-ended cycle: the environment of the
			// handoff the decision ends.
			cleanup: (handoff) =>
				closeHandoffEnvironment(
					{
						environment: handoff.environment,
						tabId: handoff.tabId,
						workspaceId: handoff.workspaceId,
					},
					commandRunner,
				),
			now: () => Date.now(),
			mode: () => autoModeRef.current,
			intervalMs: pollIntervalMs ?? configRef.current.agentPollIntervalSeconds * 1000,
			onChanged: replaceTickets,
			onAgents: (agents) => setAgents(agents),
			onStatus: (kind, text) => setStatus({ kind, text }),
		});
		observationRef.current = coordinator;
		coordinator.start();
		onReady?.({
			stop: () => {
				coordinatorRef.current?.stop();
				observationRef.current?.stop();
			},
		});
		return () => {
			coordinator.stop();
			observationRef.current = undefined;
		};
	}, [state, initialTickets, pollIntervalMs, replaceTickets, commandRunner, onReady]);

	function moveVertical(delta: number) {
		if (focusedPane === "detail")
			setDetailScroll((current) => clamp(current + delta, 0, maxScroll));
		else {
			setSelectedIndex((index) => {
				const next = clamp(index + delta, 0, ticketsRef.current.length - 1);
				selectedIndexRef.current = next;
				return next;
			});
			setDetailScroll(0);
		}
	}

	const panelTicket =
		panel === null
			? undefined
			: ticketsRef.current.find((ticket) => ticket.identity === panel.identity);
	const decision =
		panel !== null && panel.kind === "decision" && panelTicket !== undefined
			? decisionFor(panelTicket)
			: undefined;
	const emptyMessage =
		state === undefined
			? undefined
			: config.sources.length === 0
				? "no ticket sources configured"
				: healths.length === 0 || healths.some((health) => health.health === "loading")
					? "loading tickets..."
					: "no tickets match the configured sources";
	const statusColor =
		status?.kind === "error"
			? COLORS.statusError
			: status?.kind === "warning"
				? COLORS.statusWarning
				: COLORS.text;
	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "column" } },
		createElement(
			"box",
			{ style: { width: "100%", flexGrow: 1, flexDirection: "row" } },
			createElement(TicketList, {
				tickets,
				selectedIndex,
				focused: focusedPane === "list",
				reservedRows,
				emptyMessage,
				markerOf,
				limitReached: (ticket) => ticket.handoffCount >= config.maxHandoffsPerTicket,
			}),
			createElement(TicketDetail, {
				lines,
				visibleRows: detailGeometry.visibleRows,
				scroll,
				focused: focusedPane === "detail",
			}),
		),
		healthLine !== "" &&
			createElement(
				"text",
				{ style: { width: "100%", fg: COLORS.statusWarning } },
				truncateToWidth(healthLine, terminalWidth),
			),
		modeLine !== "" &&
			createElement(
				"text",
				{ style: { width: "100%", fg: COLORS.dim } },
				truncateToWidth(modeLine, terminalWidth),
			),
		status !== null &&
			createElement(
				"text",
				{ style: { width: "100%", fg: statusColor } },
				truncateToWidth(status.text, terminalWidth),
			),
		override !== null &&
			createElement(OverridePanel, {
				agents: Object.keys(config.agents),
				environments: HANDOFF_ENVIRONMENT_KINDS,
				taskTypes: Object.keys(config.taskTypes),
				agentSettings,
				thinkingDefaults,
				initial: override,
				onConfirm: (choice) => {
					setOverride(null);
					startHandoff(choice);
				},
				onCancel: () => setOverride(null),
			}),
		panel !== null &&
			panelTicket !== undefined &&
			(panel.kind === "decision" && decision !== undefined
				? createElement(ActionPanel, {
						title: truncateToWidth(`Decision: ${panelTicket.title}`, 40),
						bodyLines: decision.body,
						actions: decision.actions,
						onAction: (key) => runDecisionAction(panelTicket, key),
						onCancel: () => setPanel(null),
					})
				: createElement(ActionPanel, {
						title: truncateToWidth(`Missing: ${panelTicket.title}`, 40),
						bodyLines: [
							"The agent's pane is not in herdr's agent list.",
							`Handoffs: ${panelTicket.handoffCount} of ${config.maxHandoffsPerTicket}`,
						],
						actions: [
							{ key: "restart", label: "Restart", detail: "same task type, same workspace" },
							{ key: "abandon", label: "Abandon", detail: "end the work cycle" },
						],
						onAction: (key) => runMissingAction(panelTicket, key),
						onCancel: () => setPanel(null),
					})),
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

/**
 * The states a handoff origin may still start from when its turn comes.
 *
 * The claim passes in the claim's state, and the queue waits on the seat.
 * If the ticket moved on while it waited, its state no longer matches the
 * origin, and the claim settles as failed instead of starting the handoff.
 */
function handoffAllowsState(origin: HandoffOrigin, state: TicketState): boolean {
	switch (origin) {
		case "open":
			return state === "open";
		case "workflow":
			return state === "awaiting";
		case "restart":
			return state === "handed-off" || state === "running";
	}
}
