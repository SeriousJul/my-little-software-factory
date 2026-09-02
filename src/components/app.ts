/**
 * The control plane shell: panes, refresh, selection, handoff, and the
 * herdr observation loop (ADR 0005, ADR 0006).
 *
 * The mode line carries the auto-handoff state and the live agent count
 * against the parallel limit. Enter on an open ticket hands it off; Enter
 * on an awaiting ticket opens the decision modal (close, Goto, or a
 * workflow handoff), unless the task type is auto-close and decides alone;
 * Enter on a blocked ticket Gotos the agent; Enter on an in-flight ticket
 * whose pane herdr no longer lists opens the missing modal (restart or
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
import type { TurnLogEntry } from "../turn-log.ts";
import { ActionBar } from "./action-bar.ts";
import {
	availabilityFor,
	contextFor,
	controlById,
	controlForKey,
	type InteractionMode,
} from "./controls.ts";
import { DecisionModal } from "./decision-modal.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { useMessageFacts } from "./message-facts.ts";
import { formatMessage, type MessageFact } from "./messages.ts";
import { type ActionRow, MissingModal } from "./missing-modal.ts";
import { type AgentSettings, OverridePanel } from "./override-panel.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";
import { detailLines, TicketDetail, type TicketDetailHandle } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";
import { KeyGuide, MessageView } from "./utility.ts";

type Pane = "list" | "detail";
/** The action modal open above the panes, if any. */
type Panel = null | { kind: "decision"; identity: string } | { kind: "missing"; identity: string };
/** Utility overlays replace one another and retain the exact source mode. */
type Utility =
	| null
	| { kind: "guide"; mode: InteractionMode }
	| { kind: "message"; mode: InteractionMode; fact: MessageFact };

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
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
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
	// Focus keys can arrive before React publishes the next render. The ref
	// records that immediate intent, so the next navigation key stays with
	// the pane the operator just focused.
	const focusedPaneRef = useRef<Pane>("list");
	const detailRef = useRef<TicketDetailHandle | null>(null);
	const [override, setOverride] = useState<HandoffChoice | null>(null);
	const [utility, setUtility] = useState<Utility>(null);
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
	const sourceHealthMessage = healths
		.filter((health) => health.health === "stale" || health.health === "removed")
		.map(
			(health) =>
				`${health.name}: ${health.health}${health.error === undefined ? "" : ` - ${health.error}`}`,
		)
		.join("; ");
	const {
		message: visibleMessage,
		working: setWorkingMessage,
		warning: setWarningMessage,
		error: setErrorMessage,
		clearOperation: clearOperationMessage,
		clearRefreshWorking,
	} = useMessageFacts(sourceHealthMessage === "" ? undefined : sourceHealthMessage);
	const visibleMessageText = visibleMessage === null ? "" : formatMessage(visibleMessage);
	const messageTruncated = visibleMessage !== null && widthOf(visibleMessageText) > terminalWidth;

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
	const tooSmall = terminalWidth < 40 || terminalHeight < 7;
	// The Message line and Action bar are permanent. The mode line is above
	// the panes, so it also occupies one reserved row when state observation
	// is active. Keep the compact size frame focused on its size and Help
	// controls when it cannot show the normal layout.
	const showModeLine = modeLine !== "" && !tooSmall && terminalHeight >= 8;
	const reservedRows = 2 + (showModeLine ? 1 : 0);
	const listGeometry = usePaneGeometry("list", reservedRows);
	const detailGeometry = usePaneGeometry("detail", reservedRows);
	// The Scroll control's availability must agree with the native detail's
	// own overflow: the same lines, at the same gutter-aware text width.
	const detailTextCols = Math.max(
		1,
		detailGeometry.usableCols - (detailGeometry.usableCols >= 2 ? 1 : 0),
	);
	const detailMaxScroll = maxScrollOf(
		detailLines(tickets[selectedIndex], detailTextCols, config.maxHandoffsPerTicket).length,
		detailGeometry.visibleRows,
	);
	const selectedTicket = tickets[selectedIndex];

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

	/** Resolve a handoff operation into the durable Message facts. */
	const finishOutcome = async (outcome: HandoffOutcome): Promise<void> => {
		const persistWarning =
			outcome.notes?.mappingToWrite === undefined
				? undefined
				: await persistMapping(outcome.notes.mappingToWrite);
		if (outcome.status !== "ok")
			setErrorMessage(
				persistWarning === undefined ? outcome.reason : `${outcome.reason}; ${persistWarning}`,
			);
		else if (persistWarning !== undefined) setWarningMessage(persistWarning);
		else if (outcome.notes?.warning !== undefined) setWarningMessage(outcome.notes.warning);
		else clearOperationMessage();
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
		setWorkingMessage(`handing off "${ticket.title}"...`);
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
				setErrorMessage(`handoff failed: ${errorMessage(error)}`);
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
				setWarningMessage(
					currentState === undefined
						? `queued handoff for "${next.ticket.title}" was not run: the ticket no longer exists`
						: `queued handoff for "${next.ticket.title}" was not run: the ticket is now ${currentState}`,
				);
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
		const availability = availabilityFor(
			controlById("handoff"),
			controlContextFor(currentBaseMode()),
		);
		if (!availability.available) {
			setWarningMessage(availability.reason ?? "control is unavailable");
			return;
		}
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket === undefined) return;
		if (state !== undefined) {
			const claim = state.claimHandoff(ticket.identity, choice, "open");
			if (!claim.ok) {
				setWarningMessage(claim.reason);
				return;
			}
			runClaimedHandoff(ticket, choice, "open", claim.claim, "");
			return;
		}
		// The no-state test projection: no claim, and the settle patches the
		// ticket list by hand instead of reading it back from SQLite. It has no
		// queue, so it refuses to run behind a handoff already in flight.
		inFlightRef.current = true;
		setWorkingMessage(`handing off "${ticket.title}"...`);
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
				setErrorMessage(`handoff failed: ${errorMessage(error)}`);
				inFlightRef.current = false;
			});
	};

	const openOverride = () => {
		const availability = availabilityFor(
			controlById("override"),
			controlContextFor(currentBaseMode()),
		);
		if (!availability.available) {
			setWarningMessage(availability.reason ?? "control is unavailable");
			return;
		}
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket !== undefined) setOverride(choiceFor(ticket));
	};

	/**
	 * Toggle auto-handoff for this session. The config's value is the
	 * startup default only; the toggle never writes the config.
	 */
	const toggleAutoHandoff = () => {
		const next = !autoModeRef.current;
		autoModeRef.current = next;
		setAutoMode(next);
	};

	// The decision modal's rows: Close first, selected by default, then a
	// Goto, then one handoff row per outgoing workflow edge the completed
	// task type has, in config order: every edge stays reachable, and an
	// edge naming several targets offers one row per target. Two edges to
	// the same target offer two rows, and the row's detail shows the edge's
	// pinning so the operator can tell them apart. The modal's context row
	// names the repository, the task type, the agent, and the completion
	// time, so the operator knows what the log is about.
	const decisionFor = (
		ticket: Ticket,
	): {
		actions: ActionRow[];
		entries: readonly TurnLogEntry[];
		contextLine: string;
	} => {
		const taskType =
			ticket.lastCompletion?.taskType ?? ticket.handoff?.taskType ?? ticket.suggestedTaskType;
		const completion = ticket.lastCompletion;
		const time = completion === null ? "" : completion.completedAt.slice(0, 16).replace("T", " ");
		const contextLine = [ticket.repository, taskType, completion?.agentType ?? "?", time]
			.filter((part) => part !== "")
			.join(" · ");
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
			entries: completion?.turnLog ?? [],
			contextLine,
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
			setWarningMessage("no agent pane is recorded for this ticket");
			return;
		}
		void commandRunner.run("herdr", ["agent", "focus", paneId]).then((result) => {
			if (result.code !== 0) {
				setErrorMessage(`agent focus failed: ${commandFailureText(result)}`);
				return;
			}
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: ticket.handoff?.attemptId ?? "",
				decision: "goto",
				decidedAt: new Date().toISOString(),
			});
			replaceTickets();
			clearOperationMessage();
		});
	};

	// Run a decision-panel action: close (with the Close cleanup), Goto, a
	// workflow handoff, or (from the missing modal) restart and abandon.
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
				setWarningMessage(`ticket ${ticket.identity} already decided`);
				return;
			}
			// The Close cleanup: the environment of the handoff the decision ends.
			const stored = state.latestHandoff(ticket.identity);
			if (stored !== null) {
				void closeHandoffEnvironment(stored, commandRunner).then((failure) => {
					if (failure !== undefined) {
						setErrorMessage(
							`ticket ${ticket.identity} closed; the close cleanup failed: ${failure}`,
						);
					}
				});
			}
			clearOperationMessage();
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
			setWarningMessage(`no workflow edge from ${taskType} to ${target}`);
			return;
		}
		// Claim first: a refused claim leaves the ticket where it was. The
		// turn's decision is not recorded here: it lands on the settled
		// turn's trace in the handoff's settle path, and only when the
		// routed handoff actually started. A failed route leaves the trace
		// pending, so Close and Goto keep working. A Workflow Handoff never
		// inherits the previous Handoff's Model or Thinking: the model
		// starts empty, and the thinking starts on the target task type's
		// own default.
		const choice = baseChoice(
			edge.agent ?? configRef.current.defaultAgent,
			edge.environment ?? configRef.current.defaultEnvironment,
			target,
			"",
			configRef.current.taskTypes[target]?.thinking ?? "",
		);
		const claim = state.claimHandoff(ticket.identity, choice, "workflow");
		if (!claim.ok) {
			setWarningMessage(claim.reason);
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
				setWarningMessage(`ticket ${ticket.identity} already decided`);
				return;
			}
			const stored = state.latestHandoff(ticket.identity);
			if (stored !== null) {
				void closeHandoffEnvironment(stored, commandRunner).then((failure) => {
					if (failure !== undefined) {
						setErrorMessage(
							`ticket ${ticket.identity} abandoned; the close cleanup failed: ${failure}`,
						);
					}
				});
			}
			setWarningMessage(`ticket ${ticket.identity} abandoned`);
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
			setWarningMessage(claim.reason);
			return;
		}
		runClaimedHandoff(ticket, choice, "restart", claim.claim, ticket.lastCompletion?.message ?? "");
	};

	const currentBaseMode = (): InteractionMode =>
		focusedPane === "list" ? "ticket-list" : "ticket-detail";
	const controlContextFor = (mode: InteractionMode) =>
		contextFor(mode, {
			tickets: ticketsRef.current,
			selectedTicket: ticketsRef.current[selectedIndexRef.current],
			selectedIndex: selectedIndexRef.current,
			listCanMove: ticketsRef.current.length > 1,
			detailCanScroll: detailMaxScroll > 0,
			sourceCount: sources.length,
			refreshingSourceCount: sources.filter(
				(source) => coordinatorRef.current?.isFetching(source.name) === true,
			).length,
			handoffActive: inFlightRef.current,
			messageTruncated,
		});

	const openGuide = (mode: InteractionMode = currentBaseMode()) => {
		setUtility({ kind: "guide", mode });
	};
	const openMessage = (mode: InteractionMode = currentBaseMode()) => {
		if (visibleMessage === null || !messageTruncated) return;
		// The object is captured in the Utility value. Later source or operation
		// changes cannot replace the text in a Message view already open.
		setUtility({ kind: "message", mode, fact: { ...visibleMessage } });
	};

	const manualRefreshPending = useRef(new Set<string>());
	const refreshNow = () => {
		const availability = availabilityFor(
			controlById("refresh"),
			controlContextFor(currentBaseMode()),
		);
		if (!availability.available) {
			setWarningMessage(availability.reason ?? "control is unavailable");
			return;
		}
		const coordinator = coordinatorRef.current;
		if (coordinator === undefined) return;
		const idle = coordinator.idleSourceNames();
		manualRefreshPending.current = new Set(idle);
		coordinator.refreshAll();
		setWorkingMessage(`refreshing ${idle.length} sources`, "refresh");
	};

	useKeyboard((key) => {
		if (utility !== null || override !== null || panel !== null) return;
		const mode = currentBaseMode();
		const context = controlContextFor(mode);
		const control = controlForKey(mode, key, context);
		if (control === undefined) return;

		// A settled Ticket uses the distinct Decide control. It names what Enter
		// does instead of leaving a dimmed Hand off hint that still opens a panel.
		if (control.id === "decide-completion" && context.selectedTicket !== undefined) {
			const ticket = context.selectedTicket;
			const taskType =
				ticket.lastCompletion?.taskType ?? ticket.handoff?.taskType ?? ticket.suggestedTaskType;
			if (configRef.current.taskTypes[taskType]?.autoClose === true) {
				setWorkingMessage(`task type ${taskType} is auto-close: the factory decides this ticket`);
				observationRef.current?.tick();
			} else setPanel({ kind: "decision", identity: ticket.identity });
			return;
		}

		// A missing or blocked agent has its own recovery action. It can queue
		// behind another Handoff, so this route stays available even while the
		// normal Hand off control is unavailable.
		if (control.id === "handoff" && context.selectedTicket !== undefined) {
			const ticket = context.selectedTicket;
			if (ticket.state === "handed-off" || ticket.state === "running") {
				if (markerOf(ticket) === "blocked") runGoto(ticket);
				else if (markerOf(ticket) === "missing")
					setPanel({ kind: "missing", identity: ticket.identity });
				else setWarningMessage("only an open Ticket can be handed off");
				return;
			}
		}

		const availability = availabilityFor(control, context);
		if (!availability.available) {
			setWarningMessage(availability.reason ?? "control is unavailable");
			return;
		}
		switch (control.id) {
			case "emergency-exit":
			case "quit":
				renderer.destroy();
				break;
			case "detail":
				focusPane("detail");
				break;
			case "tickets":
				focusPane("list");
				break;
			case "move-list":
			case "scroll-detail":
				if (key.name === "pageup") movePage(-1);
				else if (key.name === "pagedown") movePage(1);
				else if (key.name === "home") moveEdge("start");
				else if (key.name === "end") moveEdge("end");
				else moveVertical(key.name === "up" || key.name === "k" ? -1 : 1);
				break;
			case "handoff": {
				const ticket = ticketsRef.current[selectedIndexRef.current];
				if (ticket !== undefined) startHandoff(choiceFor(ticket));
				break;
			}
			case "override":
				openOverride();
				break;
			case "refresh":
				refreshNow();
				break;
			case "auto-handoff":
				toggleAutoHandoff();
				break;
			case "help":
				openGuide(mode);
				break;
			case "message":
				openMessage(mode);
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
		const coordinator = new RefreshCoordinator(
			sources,
			state,
			() => {
				replaceTickets();
				// A fetch may have made a ticket actionable: let the observation
				// loop act on it now instead of on the next poll.
				observationRef.current?.tick();
			},
			undefined,
			{
				settled: (sourceName) => {
					if (!manualRefreshPending.current.has(sourceName)) return;
					manualRefreshPending.current.delete(sourceName);
					if (manualRefreshPending.current.size === 0) clearRefreshWorking();
				},
			},
		);
		coordinatorRef.current = coordinator;
		coordinator.start();
		return () => {
			coordinator.stop();
			coordinatorRef.current = undefined;
		};
	}, [state, sources, replaceTickets, clearRefreshWorking]);

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
			onStatus: (kind, text) => {
				if (kind === "error") setErrorMessage(text);
				else if (kind === "warning") setWarningMessage(text);
				else if (text.includes("herdr is reachable again")) clearOperationMessage();
				// Other informational observation events are intentionally quiet.
				// The Message line is for active work and operational facts, not a log.
			},
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
	}, [
		state,
		initialTickets,
		pollIntervalMs,
		replaceTickets,
		commandRunner,
		onReady,
		setErrorMessage,
		setWarningMessage,
		clearOperationMessage,
	]);

	function focusPane(pane: Pane) {
		focusedPaneRef.current = pane;
		setFocusedPane(pane);
	}

	function selectTicket(index: number) {
		const next = clamp(index, 0, Math.max(0, ticketsRef.current.length - 1));
		if (next === selectedIndexRef.current) return;
		selectedIndexRef.current = next;
		setSelectedIndex(next);
	}

	function moveList(delta: number) {
		selectTicket(selectedIndexRef.current + delta);
	}

	function moveVertical(delta: number) {
		if (focusedPaneRef.current === "detail")
			detailRef.current?.moveBy(delta * configRef.current.scroll.speed);
		else moveList(delta);
	}

	function movePage(direction: 1 | -1) {
		if (focusedPaneRef.current === "detail")
			detailRef.current?.movePage(direction === 1 ? "down" : "up");
		else moveList(direction * listGeometry.visibleRows);
	}

	function moveEdge(edge: "start" | "end") {
		if (focusedPaneRef.current === "detail") {
			if (edge === "start") detailRef.current?.toStart();
			else detailRef.current?.toEnd();
		} else {
			selectTicket(edge === "start" ? 0 : ticketsRef.current.length - 1);
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
	const actionMode = currentBaseMode();
	const actionContext = controlContextFor(actionMode);
	const messageLine = visibleMessage === null ? "" : visibleMessageText;
	const messageColor =
		visibleMessage?.severity === "error"
			? COLORS.statusError
			: visibleMessage?.severity === "warning"
				? COLORS.statusWarning
				: COLORS.statusWorking;
	const importantSmallMessage =
		visibleMessage !== null &&
		(visibleMessage.severity === "error" || visibleMessage.severity === "working")
			? visibleMessageText
			: undefined;
	const utilityContext =
		utility?.kind === "guide" || utility?.kind === "message"
			? controlContextFor(utility.mode)
			: actionContext;
	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "column" } },
		showModeLine &&
			createElement(
				"text",
				{ style: { width: "100%", height: 1, fg: COLORS.dim } },
				padToWidth(truncateToWidth(modeLine, terminalWidth), terminalWidth),
			),
		tooSmall
			? createElement(
					"box",
					{ style: { width: "100%", flexGrow: 1, flexDirection: "column", padding: 1 } },
					createElement(
						"text",
						{ fg: COLORS.statusWarning },
						padToWidth(
							truncateToWidth(
								"Terminal too small: minimum 40 columns by 7 rows",
								Math.max(1, terminalWidth - 2),
							),
							Math.max(1, terminalWidth - 2),
						),
					),
					importantSmallMessage !== undefined &&
						createElement(
							"text",
							{ fg: messageColor },
							padToWidth(
								truncateToWidth(importantSmallMessage, Math.max(1, terminalWidth - 2)),
								Math.max(1, terminalWidth - 2),
							),
						),
				)
			: createElement(
					"box",
					// The Message line and Action bar reserve terminal rows below this
					// flex child. Allow it to shrink on a resize so it cannot paint its
					// bottom borders through the Message line.
					{
						style: {
							width: "100%",
							height: Math.max(0, terminalHeight - reservedRows),
							flexGrow: 0,
							flexShrink: 1,
							flexDirection: "row",
							overflow: "hidden",
						},
					},
					createElement(TicketList, {
						tickets,
						selectedIndex,
						focused: focusedPane === "list",
						reservedRows,
						emptyMessage,
						markerOf,
						limitReached: (ticket) => ticket.handoffCount >= config.maxHandoffsPerTicket,
						active: override === null && panel === null && utility === null,
						onFocus: () => focusPane("list"),
						onSelect: selectTicket,
						onMove: moveList,
					}),
					createElement(TicketDetail, {
						ref: detailRef,
						ticket: selectedTicket,
						focused: focusedPane === "detail",
						active: override === null && panel === null && utility === null,
						reservedRows,
						handoffLimit: config.maxHandoffsPerTicket,
						scroll: config.scroll,
						onFocus: () => focusPane("detail"),
					}),
				),
		createElement(
			"text",
			{ style: { width: "100%", height: 1, fg: messageColor } },
			padToWidth(truncateToWidth(messageLine, terminalWidth), terminalWidth),
		),
		createElement(ActionBar, {
			mode: actionMode,
			context: actionContext,
			compactHelp: tooSmall,
		}),
		override !== null &&
			createElement(OverridePanel, {
				agents: Object.keys(config.agents),
				environments: HANDOFF_ENVIRONMENT_KINDS,
				taskTypes: Object.keys(config.taskTypes),
				agentSettings,
				thinkingDefaults,
				initial: override,
				context: actionContext,
				inputActive: utility === null,
				onHelp: (mode) => openGuide(mode),
				onMessage: (mode) => openMessage(mode),
				onUnavailable: setWarningMessage,
				onEmergencyExit: () => renderer.destroy(),
				onConfirm: (choice) => {
					setOverride(null);
					startHandoff(choice);
				},
				onCancel: () => setOverride(null),
			}),
		panel !== null &&
			panelTicket !== undefined &&
			(panel.kind === "decision" && decision !== undefined
				? createElement(DecisionModal, {
						title: panelTicket.title,
						contextLine: decision.contextLine,
						entries: decision.entries,
						actions: decision.actions,
						onAction: (key) => runDecisionAction(panelTicket, key),
						onCancel: () => setPanel(null),
						context: actionContext,
						inputActive: utility === null,
						onHelp: () => openGuide("decision-modal"),
						onMessage: () => openMessage("decision-modal"),
						onUnavailable: setWarningMessage,
						onEmergencyExit: () => renderer.destroy(),
					})
				: createElement(MissingModal, {
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
						context: actionContext,
						inputActive: utility === null,
						onHelp: () => openGuide("decision-modal"),
						onMessage: () => openMessage("decision-modal"),
						onUnavailable: setWarningMessage,
						onEmergencyExit: () => renderer.destroy(),
					})),
		utility?.kind === "guide" &&
			createElement(KeyGuide, {
				context: utilityContext,
				onClose: () => setUtility(null),
				onHelp: () => setUtility(null),
				onMessage: () => openMessage(utilityContext.mode),
				onEmergencyExit: () => renderer.destroy(),
			}),
		utility?.kind === "message" &&
			createElement(MessageView, {
				fact: utility.fact,
				context: utilityContext,
				onClose: () => setUtility(null),
				onHelp: () => openGuide(utilityContext.mode),
				onEmergencyExit: () => renderer.destroy(),
			}),
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
