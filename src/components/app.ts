/**
 * The control plane shell: panes, refresh, selection, handoff, and the
 * herdr observation loop (ADR 0005, ADR 0006).
 *
 * The mode line carries the auto-handoff state and the live agent count
 * against the parallel limit. Enter on an open ticket hands it off; Enter
 * on an awaiting ticket opens the decision modal (close, Goto, or a
 * workflow handoff), while the factory does not decide the ticket itself
 * (auto mode, or an auto-close task type);
 * Enter on a blocked ticket Gotos the agent; Enter on an in-flight ticket
 * whose pane herdr no longer lists opens the missing modal (restart or
 * abandon). `a` toggles auto-handoff.
 */
import { randomUUID } from "node:crypto";
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
	ConsultationInputQueue,
	type ConsultationRepositoryOption,
	consultationRepositoryCatalog,
	inspectLiveCheckout,
	isLiteralText,
	type LiveCheckoutSafety,
	serializeRepositoryOperation,
	translateAgentKey,
	validateConsultationRepositoryOptions,
	validateResponseInput,
} from "../consultation.ts";
import {
	HANDOFF_ENVIRONMENT_KINDS,
	type Handoff,
	type Ticket,
	type TicketState,
} from "../domain/ticket.ts";
import {
	baseChoice,
	checkConsultationStart,
	closeHandoffEnvironment,
	type HandoffChoice,
	type HandoffOutcome,
	handOffConsultation,
	handOffStoredWorkspace,
	handOffTicket,
	renderConsultationPrompt,
} from "../handoff.ts";
import { consultationAgentName } from "../naming.ts";
import {
	type DispatchResult,
	type HandoffIntent,
	type HerdrAgent,
	HerdrAgentReader,
	matchConsultationAgent,
	normalizeAgentStatus,
	ObservationCoordinator,
} from "../observation.ts";
import { RefreshCoordinator } from "../refresh.ts";
import { type RepositoryMapping, type ResolvedRepository, resolveRepository } from "../repo.ts";
import {
	type CommandRunner,
	commandFailureText,
	createChildProcessRunner,
	errorMessage,
	supportsModelList,
} from "../runner.ts";
import {
	resolveEnvironment,
	resolveSettings,
	type TaskProfileStart,
	taskProfilesOf,
} from "../setting-resolution.ts";
import type { Consultation, FactoryState, HandoffClaim, HandoffOrigin } from "../state.ts";
import type { TicketSource } from "../ticket-source.ts";
import type { TurnLogEntry } from "../turn-log.ts";
import { ActionPanel } from "./action-panel.ts";
import { renderAnsiScreen } from "./ansi-screen.ts";
import {
	type ActionContext,
	ActionGuide,
	type ActionUtility,
	actionBarElement,
} from "./consultation-actions.ts";
import { ConsultationDetail, consultationDetailLines } from "./consultation-detail.ts";
import { ConsultationLauncher } from "./consultation-launcher.ts";
import { ConsultationList } from "./consultation-list.ts";
import { DecisionModal } from "./decision-modal.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { type ActionRow, MissingModal } from "./missing-modal.ts";
import {
	type AgentModelList,
	type AgentSettings,
	type ModelListStatus,
	OverridePanel,
} from "./override-panel.ts";
import { truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";
import { TicketDetail, type TicketDetailHandle } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";

type Pane = "list" | "detail";
type MainView = "tickets" | "consultations";
interface StatusMessage {
	kind: "info" | "warning" | "error";
	text: string;
}
/** The action modal open above the panes, if any. */
type Panel =
	| null
	| { kind: "decision"; identity: string }
	| { kind: "missing"; identity: string }
	| { kind: "consultation-close"; identity: string }
	| { kind: "consultation-force"; identity: string }
	| { kind: "consultation-delete"; identity: string }
	| { kind: "consultation-safety"; identity: string };

export type AppKey =
	| "j"
	| "k"
	| "h"
	| "l"
	| "q"
	| "e"
	| "r"
	| "a"
	| "c"
	| "v"
	| "t"
	| "f"
	| "x"
	| "d"
	| "up"
	| "down"
	| "left"
	| "right"
	| "pageup"
	| "pagedown"
	| "home"
	| "end"
	| "?"
	| "m";

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
	const [view, setView] = useState<MainView>("tickets");
	const viewRef = useRef<MainView>("tickets");
	const [consultations, setConsultations] = useState<Consultation[]>(
		() => state?.consultations("open") ?? [],
	);
	const consultationsRef = useRef(consultations);
	const [consultationIndex, setConsultationIndex] = useState(0);
	const consultationIndexRef = useRef(0);
	const [historyFilter, setHistoryFilter] = useState<"open" | "closed" | "all">("open");
	const historyFilterRef = useRef<"open" | "closed" | "all">("open");
	const [launcher, setLauncher] = useState(false);
	const [replacementConsultationId, setReplacementConsultationId] = useState<string | null>(null);
	const [consultationSafety, setConsultationSafety] = useState<{
		consultationId: string;
		safety: LiveCheckoutSafety;
	} | null>(null);
	const [repositoryOptions, setRepositoryOptions] = useState<ConsultationRepositoryOption[]>([]);
	const [responseEditor, setResponseEditor] = useState(false);
	const [responseDraft, setResponseDraft] = useState("");
	const responseDraftRef = useRef("");
	const [interaction, setInteraction] = useState(false);
	const [liveOutput, setLiveOutput] = useState<string | null>(null);
	const [consultationScroll, setConsultationScroll] = useState(0);
	const consultationFollowRef = useRef(true);
	const [newOutput, setNewOutput] = useState(false);
	const [bell, setBell] = useState(false);
	const [utility, setUtility] = useState<ActionUtility | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selectedIndexRef = useRef(0);
	const configRef = useRef(config);
	configRef.current = config;
	viewRef.current = view;
	historyFilterRef.current = historyFilter;
	const [focusedPane, setFocusedPane] = useState<Pane>("list");
	// Focus keys can arrive before React publishes the next render. The ref
	// records that immediate intent, so the next navigation key stays with
	// the pane the operator just focused.
	const focusedPaneRef = useRef<Pane>("list");
	const detailRef = useRef<TicketDetailHandle | null>(null);
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
	const consultationOperationQueues = useRef(new Map<string, Promise<void>>());
	const openingLaunches = useRef(new Set<string>());
	const interactionInputQueue = useRef<ConsultationInputQueue | undefined>(undefined);
	const configWriteQueue = useRef(Promise.resolve());
	// The selected Agent pane's refresh, callable the moment a forwarded
	// input lands: the operator should not wait out the refresh interval.
	const outputRefreshRef = useRef<(() => void) | null>(null);

	const commandRunner = runner ?? realRunner();
	if (interactionInputQueue.current === undefined)
		interactionInputQueue.current = new ConsultationInputQueue(commandRunner);
	const inputQueue = interactionInputQueue.current;
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
	const consultationCounts = state?.consultationCounts() ?? { awaitingResponse: 0, recovery: 0 };
	const attentionLine =
		state === undefined ||
		(view === "tickets" &&
			consultationCounts.awaitingResponse === 0 &&
			consultationCounts.recovery === 0)
			? ""
			: `awaiting response: ${consultationCounts.awaitingResponse}  recovery: ${consultationCounts.recovery}${bell ? "  !!!" : ""}${view === "consultations" && newOutput ? "  new output" : ""}`;
	const reservedRows =
		(status === null ? 0 : 1) +
		(healthLine === "" ? 0 : 1) +
		(modeLine === "" ? 0 : 1) +
		(attentionLine === "" ? 0 : 1) +
		(view === "consultations" && state !== undefined ? 1 : 0);
	const listGeometry = usePaneGeometry("list", reservedRows);
	const detailGeometry = usePaneGeometry("detail", reservedRows);
	const selectedTicket = tickets[selectedIndex];
	const selectedConsultation = consultations[consultationIndex];
	// The status the observation last reported for the selected Consultation's
	// Agent pane: it gates the response editor and the interaction mode.
	const selectedConsultationAgentStatus =
		selectedConsultation === undefined || selectedConsultation.paneId === null || agents === null
			? null
			: normalizeAgentStatus(
					agents.find((agent) => agent.paneId === selectedConsultation.paneId)?.status ?? "unknown",
				);
	const actionContext: ActionContext = {
		view,
		focusedPane,
		selectedConsultation,
		status,
		launcher,
		modal: override !== null || panel !== null,
		responseEditor,
		interaction,
		interactionExitKey: config.interactionExitKey,
		agentStatus: selectedConsultationAgentStatus,
	};
	const consultationTurns =
		selectedConsultation === undefined || state === undefined
			? []
			: state.consultationTurns(selectedConsultation.id);
	const consultationSnapshots =
		selectedConsultation === undefined || state === undefined
			? []
			: state.consultationSnapshots(selectedConsultation.id);
	const replacementIds =
		selectedConsultation === undefined || state === undefined
			? []
			: state
					.consultations("all")
					.filter((item) => item.replacementOf === selectedConsultation.id)
					.map((item) => item.id);
	const consultationNarrow = view === "consultations" && terminalWidth < 80;
	const consultationWidth = consultationNarrow
		? Math.max(1, terminalWidth - 4)
		: detailGeometry.usableCols;
	const remainingResources =
		selectedConsultation === undefined ||
		state === undefined ||
		selectedConsultation.state !== "closed"
			? []
			: state.consultationRemainingResources(selectedConsultation.id);
	const consultationLines = consultationDetailLines(
		selectedConsultation,
		consultationTurns,
		consultationSnapshots,
		consultationWidth,
		interaction ? null : liveOutput,
		replacementIds,
		selectedConsultationAgentStatus,
		remainingResources,
	);
	const ansiLines =
		interaction && liveOutput !== null
			? renderAnsiScreen(liveOutput, consultationWidth)
			: undefined;
	const consultationMaxScroll = maxScrollOf(
		ansiLines?.length ?? consultationLines.length,
		detailGeometry.visibleRows,
	);
	const consultationDetailScroll = Math.min(consultationScroll, consultationMaxScroll);

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

	const replaceConsultations = useCallback(() => {
		if (state === undefined) return;
		const next = state.consultations(historyFilterRef.current);
		const currentIndex = consultationIndexRef.current;
		const selectedId = consultationsRef.current[currentIndex]?.id;
		const preserved =
			selectedId === undefined ? -1 : next.findIndex((item) => item.id === selectedId);
		const nextIndex =
			preserved >= 0 ? preserved : Math.max(0, Math.min(currentIndex, next.length - 1));
		consultationsRef.current = next;
		consultationIndexRef.current = nextIndex;
		setConsultations(next);
		setConsultationIndex(nextIndex);
		if (selectedId === undefined || !next.some((item) => item.id === selectedId)) {
			setConsultationScroll(0);
			consultationFollowRef.current = true;
			setLiveOutput(null);
		}
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
	// The Task profile of every task type (ADR 0009): what the panel prefills,
	// and what it re-derives when the operator switches the task type row.
	const profiles: Record<string, TaskProfileStart> = taskProfilesOf(config);
	// The Model list of the agent the override panel is on (ADR 0010). The panel
	// asks for it when it opens and whenever the operator switches agents inside
	// it, so it reflects provider auth changed after startup. There is no cache:
	// every request runs a fresh query, and a request a newer one overtakes is
	// dropped.
	const [modelList, setModelList] = useState<AgentModelList>({
		agentType: "",
		status: { status: "loading" },
	});
	const modelListRequest = useRef(0);
	const requestModelList = useCallback(
		(agentType: string) => {
			const request = modelListRequest.current + 1;
			modelListRequest.current = request;
			const agent = configRef.current.agents[agentType];
			const settle = (status: ModelListStatus) => {
				// Only the newest request may show: a stale answer for another
				// agent must never reach the row.
				if (modelListRequest.current !== request) return;
				setModelList({ agentType, status });
			};
			if (agent === undefined || agent.model === undefined || !supportsModelList(agent.kind)) {
				// The kind reports no list: the row keeps the Text field, and no
				// agent CLI runs for it.
				settle({ status: "unavailable", cause: "no-list" });
				return;
			}
			settle({ status: "loading" });
			void commandRunner
				.listModels(agent.kind)
				.then((result) =>
					settle(
						result.ok
							? { status: "available", models: result.models }
							: { status: "unavailable", cause: "query-failed" },
					),
				)
				.catch(() => settle({ status: "unavailable", cause: "query-failed" }));
		},
		[commandRunner],
	);
	const choiceFor = (ticket: Ticket): HandoffChoice => {
		// The resolved Task profile of the ticket's suggested task type: the
		// panel prefills it, and Enter applies it (ADR 0009). The operator
		// changes a row in the panel, or clears one to leave the setting to the
		// agent.
		const settings = resolveSettings({
			config: configRef.current,
			taskType: ticket.suggestedTaskType,
		});
		return baseChoice(
			settings.agentType,
			configRef.current.defaultEnvironment,
			ticket.suggestedTaskType,
			settings.model,
			settings.thinking,
		);
	};

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
		const write = configWriteQueue.current
			.catch(() => undefined)
			.then(async () => {
				try {
					const currentConfig = configRef.current;
					const updated = {
						...currentConfig,
						repos: { ...currentConfig.repos, [mapping.repository]: mapping.path },
					};
					configRef.current = updated;
					setConfig(updated);
					await persistConfig(configFile, updated);
					return undefined;
				} catch (error) {
					return `could not persist the repository mapping: ${errorMessage(error)}`;
				}
			});
		configWriteQueue.current = write.then(
			() => undefined,
			() => undefined,
		);
		return write;
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
		const choice = choiceFor(ticket);
		// Opening the panel is a point of use for the Model list (ADR 0010): the
		// list of the agent the panel starts on is fetched fresh, so provider
		// auth the operator changed after startup shows up here.
		requestModelList(choice.agentType);
		setOverride(choice);
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
		// Claim first: a refused claim leaves the ticket where it was. The
		// turn's decision is not recorded here: it lands on the settled
		// turn's trace in the handoff's settle path, and only when the
		// routed handoff actually started. A failed route leaves the trace
		// pending, so Close and Goto keep working. A routed handoff resolves
		// agent, model, and thinking through the target task profile's chain,
		// with the edge's own pin above the profile (ADR 0009); it never
		// inherits the previous handoff's model or thinking.
		const routed = resolveSettings({
			config: configRef.current,
			taskType: target,
			edgeAgent: edge.agent,
		});
		const choice = baseChoice(
			routed.agentType,
			// The same question the panel asks, through the same helper, so a
			// route that starts without a panel cannot read the pin differently.
			resolveEnvironment(configRef.current, edge.environment),
			target,
			routed.model,
			routed.thinking,
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

	const beginConsultationLaunch = (consultation: Consultation) => {
		if (state === undefined || !state.canRecoverConsultationOpening(consultation.id)) return;
		if (openingLaunches.current.has(consultation.id)) {
			setStatus({ kind: "info", text: "Consultation opening is already in progress" });
			return;
		}
		openingLaunches.current.add(consultation.id);
		const onStage = (stage: string) =>
			setStatus({ kind: "info", text: `Consultation ${consultation.id.slice(0, 8)}: ${stage}` });
		void serializeRepositoryOperation(
			consultationOperationQueues.current,
			consultation.repository.identity,
			async () => {
				// The setting fit check (ADR 0010) is this route's first step, before
				// its first external change: a live consultation resolves its
				// repository here, and a resolve can clone one. The verdict rides
				// into the start, so the Agent's Model list answers one query per
				// Consultation.
				const startCheck = await checkConsultationStart({
					consultation,
					config: configRef.current,
					runner: commandRunner,
				});
				if (!startCheck.ok) return { status: "failed" as const, reason: startCheck.reason };
				let resolvedRepository: ResolvedRepository | undefined;
				if (consultation.environment === "live-worktree") {
					onStage("resolving-repository");
					const resolution = await resolveRepository(
						{
							identity: consultation.repository.identity,
							displayName: consultation.repository.displayName,
							cloneUrl: consultation.repository.cloneUrl,
						},
						configRef.current,
						{ runner: commandRunner, home: homeDir },
					);
					if (!resolution.ok) return { status: "failed" as const, reason: resolution.reason };
					resolvedRepository = resolution.repository;
					state.setConsultationRepositoryPath(consultation.id, resolvedRepository.path);
					onStage("checking-live-checkout-safety");
					const probe = await new HerdrAgentReader(commandRunner).listAgents();
					if (probe.kind === "error")
						return {
							status: "failed" as const,
							reason: `cannot verify live checkout safety: ${probe.reason}`,
						};
					const safety = await inspectLiveCheckout(
						resolvedRepository.path,
						commandRunner,
						ticketsRef.current,
						state.consultations("open"),
						probe.agents,
					);
					if (safety.warning !== undefined)
						state.setConsultationWarning(consultation.id, safety.warning);
					if (
						safety.conflicts.length > 0 &&
						state.consultation(consultation.id)?.liveConflictOverride !== true
					)
						return { status: "conflict" as const, safety };
				}
				return handOffConsultation({
					consultation,
					config: configRef.current,
					runner: commandRunner,
					home: homeDir,
					onStage,
					startCheck,
					resolvedRepository,
					onRepositoryResolved: (path) =>
						state.setConsultationRepositoryPath(consultation.id, path),
					onAgentStarted: (agent) => {
						state.recordConsultationAgentHandles(consultation.id, agent);
						state.recordConsultationResource(consultation.id, {
							kind: "pane",
							resourceId: agent.paneId,
							owned: true,
							details: "Consultation Agent pane",
						});
						state.recordConsultationResource(consultation.id, {
							kind: "agent",
							resourceId: consultation.agentName,
							owned: true,
							details: `Agent hosted by pane ${agent.paneId}`,
						});
					},
					onResource: (kind, resourceId, owned, details) =>
						state.recordConsultationResource(consultation.id, {
							kind,
							resourceId,
							owned,
							details: details ?? "",
						}),
				});
			},
		)
			.then(async (outcome) => {
				if (outcome.status === "conflict") {
					setConsultationSafety({ consultationId: consultation.id, safety: outcome.safety });
					setPanel({ kind: "consultation-safety", identity: consultation.id });
					setStatus({
						kind: "warning",
						text: "live checkout conflict: explicit confirmation is required",
					});
					return;
				}
				if (outcome.status === "failed") {
					state.failConsultationOpening(consultation.id, outcome.reason);
					setStatus({
						kind: "error",
						text: `Consultation ${consultation.id.slice(0, 8)} failed: ${outcome.reason}`,
					});
				} else {
					state.setConsultationAgent(consultation.id, {
						paneId: outcome.agent.paneId,
						tabId: outcome.agent.tabId,
						workspaceId: outcome.agent.workspaceId,
						sessionId: outcome.agent.sessionId,
					});
					if (outcome.status === "prompt-failed") {
						state.setConsultationDraft(consultation.id, consultation.renderedOpeningPrompt);
						setStatus({ kind: "error", text: outcome.reason });
					}
				}
				await finishOutcome(outcome);
				const warning = state.consultation(consultation.id)?.warning;
				if (warning !== null && warning !== undefined)
					setStatus({ kind: "warning", text: warning });
				replaceConsultations();
			})
			.catch((error) => {
				state.failConsultationOpening(consultation.id, errorMessage(error));
				replaceConsultations();
				setStatus({
					kind: "error",
					text: `Consultation ${consultation.id.slice(0, 8)} failed: ${errorMessage(error)}`,
				});
			})
			.finally(() => openingLaunches.current.delete(consultation.id));
	};

	const startConsultation = (
		typeName: string,
		repository: ConsultationRepositoryOption,
		input: string,
	) => {
		if (state === undefined) {
			setStatus({ kind: "error", text: "Consultations require durable SQLite state" });
			return;
		}
		const type = configRef.current.consultationTypes[typeName];
		if (type === undefined) {
			setStatus({ kind: "error", text: `unknown Consultation type ${typeName}` });
			return;
		}
		const id = randomUUID();
		const consultation = state.createConsultation({
			id,
			typeName,
			agentType: type.agent,
			environment: type.environment,
			model: type.model,
			thinking: type.thinking,
			template: type.template,
			initialInput: input,
			renderedOpeningPrompt: renderConsultationPrompt(type.template, input),
			repository,
			replacementOf: replacementConsultationId ?? undefined,
			agentName: consultationAgentName(id),
		});
		setLauncher(false);
		setReplacementConsultationId(null);
		historyFilterRef.current = "open";
		setHistoryFilter("open");
		openConsultations();
		replaceConsultations();
		setStatus({ kind: "info", text: `opening Consultation ${consultation.id.slice(0, 8)}...` });
		beginConsultationLaunch(consultation);
	};

	const recoverConsultationOpening = (consultation: Consultation) => {
		if (state === undefined || consultation.state !== "opening") return;
		const current = state.consultation(consultation.id);
		if (current === undefined || !state.canRecoverConsultationOpening(current.id)) return;
		if (current.paneId === null && current.sessionId === null) {
			setStatus({ kind: "info", text: `recovering Consultation ${current.id.slice(0, 8)}...` });
			beginConsultationLaunch(current);
			return;
		}
		setStatus({ kind: "info", text: `verifying Consultation ${current.id.slice(0, 8)} Agent...` });
		void serializeRepositoryOperation(
			consultationOperationQueues.current,
			current.repository.identity,
			async () => {
				const probe = await new HerdrAgentReader(commandRunner).listAgents();
				if (probe.kind === "error") return { kind: "error" as const, reason: probe.reason };
				const agent = matchConsultationAgent(current, probe.agents);
				return agent === undefined || agent === "ambiguous"
					? {
							kind: "missing" as const,
							reason:
								agent === "ambiguous" ? "Agent session match is ambiguous" : "Agent is missing",
						}
					: { kind: "agent" as const, agent };
			},
		)
			.then((result) => {
				if (result.kind === "error") {
					setStatus({ kind: "error", text: `cannot verify Consultation Agent: ${result.reason}` });
					return;
				}
				if (result.kind === "missing") {
					state.failConsultationOpening(current.id, result.reason);
					replaceConsultations();
					setStatus({
						kind: "error",
						text: `Consultation ${current.id.slice(0, 8)} failed: ${result.reason}`,
					});
					return;
				}
				state.updateConsultationAgentHandles(current.id, {
					paneId: result.agent.paneId,
					tabId: result.agent.tabId,
					workspaceId: result.agent.workspaceId,
					sessionId: result.agent.stableSessionId ?? current.sessionId,
				});
				state.setConsultationAgent(current.id, {
					paneId: result.agent.paneId,
					tabId: result.agent.tabId,
					workspaceId: result.agent.workspaceId,
					sessionId: result.agent.stableSessionId ?? current.sessionId,
				});
				replaceConsultations();
				setStatus({ kind: "info", text: `Consultation ${current.id.slice(0, 8)} reconnected` });
			})
			.catch((error) => {
				setStatus({
					kind: "error",
					text: `cannot verify Consultation Agent: ${errorMessage(error)}`,
				});
			});
	};

	const beginResponse = (consultation: Consultation) => {
		if (consultation.state !== "awaiting-response") {
			setStatus({ kind: "warning", text: "the Consultation is not awaiting a response" });
			return;
		}
		responseDraftRef.current = consultation.draft;
		setResponseDraft(consultation.draft);
		setResponseEditor(true);
	};

	const submitResponse = () => {
		if (state === undefined || selectedConsultation === undefined) return;
		const consultation = selectedConsultation;
		const draft = responseDraftRef.current;
		const error = validateResponseInput(draft);
		if (error !== undefined) {
			setStatus({ kind: "error", text: error });
			return;
		}
		state.setConsultationDraft(consultation.id, draft);
		const pending = state.beginConsultationResponse(
			consultation.id,
			draft,
			consultation.latestSequence,
		);
		if (pending === undefined) {
			setStatus({
				kind: "warning",
				text: "a response delivery is already pending or the Consultation changed; inspect the Agent before retrying",
			});
			return;
		}
		setResponseEditor(false);
		setStatus({
			kind: "info",
			text: `sending response to Consultation ${consultation.id.slice(0, 8)}...`,
		});
		void commandRunner
			.run("herdr", ["agent", "prompt", consultation.agentName, draft])
			.then((result) => {
				if (result.code !== 0) {
					state.cancelConsultationResponse(consultation.id, pending.id);
					replaceConsultations();
					setResponseEditor(true);
					setStatus({ kind: "error", text: `response failed: ${commandFailureText(result)}` });
					return;
				}
				const accepted = state.acceptConsultationResponse(consultation.id, pending.id);
				replaceConsultations();
				if (accepted === undefined) {
					// The turn may already be settled by an observation poll; the
					// saved draft survives either way for inspection.
					setResponseEditor(true);
					setStatus({
						kind: "warning",
						text: "response was delivered; inspect the Agent output and the saved draft",
					});
				} else setStatus(null);
			})
			.catch((error) => {
				state.cancelConsultationResponse(consultation.id, pending.id);
				replaceConsultations();
				setResponseEditor(true);
				setStatus({ kind: "error", text: `response failed: ${errorMessage(error)}` });
			});
	};

	const openConsultations = () => {
		viewRef.current = "consultations";
		setView("consultations");
		setFocusedPane("list");
	};

	const openAttention = () => {
		if (state === undefined) return false;
		const current = state.consultations("open");
		// The list is newest-first, but attention goes to the oldest
		// unresolved recovery item: it has waited the longest for the
		// operator. Ties break on creation time.
		const recovery = current
			.filter(
				(item) =>
					item.state === "missing" ||
					item.state === "failed" ||
					item.state === "opening" ||
					item.state === "closing",
			)
			.reduce<Consultation | null>((oldest, item) => {
				if (oldest === null) return item;
				if (item.updatedAt < oldest.updatedAt) return item;
				if (item.updatedAt === oldest.updatedAt && item.createdAt < oldest.createdAt) return item;
				return oldest;
			}, null);
		const target = current.find((item) => item.state === "awaiting-response") ?? recovery;
		if (target === undefined || target === null) return false;
		historyFilterRef.current = "open";
		setHistoryFilter("open");
		replaceConsultations();
		openConsultations();
		const index = current.findIndex((item) => item.id === target.id);
		consultationIndexRef.current = index;
		setConsultationIndex(index);
		consultationFollowRef.current = true;
		setConsultationScroll(999999);
		setNewOutput(false);
		return true;
	};

	const cycleConsultationHistory = () => {
		const next =
			historyFilterRef.current === "open"
				? "closed"
				: historyFilterRef.current === "closed"
					? "all"
					: "open";
		historyFilterRef.current = next;
		setHistoryFilter(next);
		replaceConsultations();
	};

	const closeConsultation = (consultation: Consultation) => {
		if (state === undefined) return;
		const current = state.consultation(consultation.id) ?? consultation;
		if (current.state === "closed") return;
		const started = current.state === "closing" || state.beginConsultationClose(current.id);
		if (!started) {
			setStatus({ kind: "warning", text: "Consultation is already closing or closed" });
			return;
		}
		if (current.paneId !== null && !current.resources.some((item) => item.kind === "pane"))
			state.recordConsultationResource(current.id, {
				kind: "pane",
				resourceId: current.paneId,
				owned: true,
				details: "Recovered Consultation Agent pane",
			});
		replaceConsultations();
		setStatus({ kind: "info", text: `closing Consultation ${current.id.slice(0, 8)}...` });
		void serializeRepositoryOperation(
			consultationOperationQueues.current,
			current.repository.identity,
			async () => {
				const output =
					current.paneId === null
						? null
						: await new HerdrAgentReader(commandRunner).readPane(
								current.paneId,
								configRef.current.completionMessageLines,
							);
				if (output !== null) state.captureConsultationPartial(current.id, output);
				const refreshed = state.consultation(current.id) ?? current;
				const resources = refreshed.resources.filter((item) => item.owned && !item.confirmedClosed);
				const workspace = resources.find((item) => item.kind === "workspace");
				const tab = resources.find((item) => item.kind === "tab");
				const pane = resources.find((item) => item.kind === "pane");
				const agent = resources.find((item) => item.kind === "agent");
				const worktrees = resources.filter((item) => item.kind === "worktree");
				const WORKTREE_REMAIN = "retained after close: worktree and branch remain";
				const markWorktreesRetained = () => {
					for (const resource of worktrees)
						state.markConsultationResourceShared(
							current.id,
							resource.kind,
							resource.resourceId,
							WORKTREE_REMAIN,
						);
				};
				let command: readonly string[] | undefined;
				let closes: typeof resources = [];
				const workspaceId = workspace?.resourceId ?? current.workspaceId;
				if (workspaceId !== null && pane !== undefined) {
					const topology = await workspaceTopology(
						commandRunner,
						workspaceId,
						pane.resourceId,
						tab?.resourceId ?? current.tabId,
					);
					if (!topology.known)
						throw new Error("could not verify the Consultation workspace topology");
					if (topology.workspaceExclusive && workspace !== undefined) {
						// Only an owned workspace may be closed whole: an adopted
						// workspace belongs to someone else even while empty.
						command = ["workspace", "close", workspace.resourceId];
						closes = resources.filter((item) => item.kind !== "worktree");
						markWorktreesRetained();
					} else if (topology.ownedTabExclusive && tab !== undefined) {
						command = ["tab", "close", tab.resourceId];
						closes = [tab, pane, ...(agent === undefined ? [] : [agent])];
						if (workspace !== undefined)
							state.markConsultationResourceShared(current.id, "workspace", workspace.resourceId);
						markWorktreesRetained();
					} else {
						// A foreign pane shares the owned tab: close the pane alone.
						command = ["pane", "close", pane.resourceId];
						closes = [pane, ...(agent === undefined ? [] : [agent])];
						if (workspace !== undefined)
							state.markConsultationResourceShared(current.id, "workspace", workspace.resourceId);
						if (tab !== undefined)
							state.markConsultationResourceShared(current.id, "tab", tab.resourceId);
						markWorktreesRetained();
					}
				} else if (pane !== undefined) {
					command = ["pane", "close", pane.resourceId];
					closes = [pane, ...(agent === undefined ? [] : [agent])];
				}
				if (command === undefined) return;
				const result = await commandRunner.run("herdr", command);
				if (result.code !== 0) throw new Error(commandFailureText(result));
				for (const resource of closes)
					state.markConsultationResourceClosed(current.id, resource.kind, resource.resourceId);
			},
		)
			.then(() => {
				state.finishConsultationClose(current.id);
				replaceConsultations();
				setStatus({ kind: "info", text: `Consultation ${current.id.slice(0, 8)} closed` });
			})
			.catch((error) => {
				state.recordConsultationCloseFailure(current.id, errorMessage(error));
				replaceConsultations();
				setStatus({
					kind: "error",
					text: `Consultation close needs recovery: ${errorMessage(error)}`,
				});
			});
	};

	const forceCloseConsultation = (consultation: Consultation) => {
		if (state === undefined) return;
		if (consultation.state !== "closing" && !state.beginConsultationClose(consultation.id)) {
			setStatus({ kind: "warning", text: "Consultation cleanup has already finished" });
			return;
		}
		state.finishConsultationClose(
			consultation.id,
			"force-closed by operator; owned resources may remain",
			true,
		);
		replaceConsultations();
		setStatus({
			kind: "warning",
			text: `Consultation ${consultation.id.slice(0, 8)} force-closed; recovery resources remain recorded`,
		});
	};

	const deleteConsultation = (consultation: Consultation) => {
		if (state?.deleteConsultation(consultation.id)) {
			replaceConsultations();
			setStatus({
				kind: "info",
				text: `Consultation ${consultation.id.slice(0, 8)} deleted; backups may retain data`,
			});
		}
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
		if (override !== null || panel !== null || launcher || utility !== null) return;
		if (interaction) {
			const exit = configRef.current.interactionExitKey.toLowerCase().replace(/^ctrl-/, "ctrl+");
			const keyName = key.name.toLowerCase();
			const isExit = keyName === exit || (key.ctrl === true && exit === `ctrl+${keyName}`);
			if (isExit) {
				setInteraction(false);
				// Settle the queued input before announcing the exit: the last
				// key the operator sent still belongs to the Agent.
				void inputQueue
					.flush()
					.then(() => setStatus({ kind: "info", text: "left Agent interaction mode" }));
				return;
			}
			const selected = consultationsRef.current[consultationIndexRef.current];
			const event =
				selected?.paneId === null || selected?.paneId === undefined
					? null
					: translateAgentKey(key, configRef.current.interactionExitKey);
			if (selected !== undefined && selected.paneId !== null && event !== null) {
				void inputQueue.enqueue(selected.paneId, event).then(
					(result) => {
						if (result.code === 0) {
							setNewOutput(true);
							// The key may have produced output already: re-read
							// the pane now, not on the next interval tick.
							outputRefreshRef.current?.();
						} else
							setStatus({
								kind: "error",
								text: `Agent interaction failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
							});
					},
					(error) =>
						setStatus({
							kind: "error",
							text: `Agent interaction failed: ${errorMessage(error)}`,
						}),
				);
			}
			return;
		}
		if (responseEditor) {
			if (key.name === "escape") {
				setResponseEditor(false);
				return;
			}
			if (key.name === "return") {
				if (key.shift) {
					responseDraftRef.current += "\n";
					setResponseDraft(responseDraftRef.current);
					if (state !== undefined && selectedConsultation !== undefined)
						state.setConsultationDraft(selectedConsultation.id, responseDraftRef.current);
				} else submitResponse();
				return;
			}
			if (key.name === "backspace") {
				responseDraftRef.current = responseDraftRef.current.slice(0, -1);
				setResponseDraft(responseDraftRef.current);
				if (state !== undefined && selectedConsultation !== undefined)
					state.setConsultationDraft(selectedConsultation.id, responseDraftRef.current);
				return;
			}
			if ([...key.name].length > 0 && isLiteralText(key.name)) {
				responseDraftRef.current += key.name === "space" ? " " : key.name;
				setResponseDraft(responseDraftRef.current);
				if (state !== undefined && selectedConsultation !== undefined)
					state.setConsultationDraft(selectedConsultation.id, responseDraftRef.current);
			}
			return;
		}
		switch (key.name) {
			case "q":
				renderer.destroy();
				break;
			case "?":
				setUtility("guide");
				break;
			case "m":
				if (status !== null) setUtility("message");
				break;
			case "t":
				viewRef.current = "tickets";
				setView("tickets");
				setFocusedPane("list");
				break;
			case "v":
				openConsultations();
				break;
			case "c":
				if (Object.keys(configRef.current.consultationTypes).length === 0)
					setStatus({
						kind: "warning",
						text: "no Consultation types configured; add [consultation-types.<name>] to the config file",
					});
				else if (
					viewRef.current === "consultations" &&
					(selectedConsultation?.state === "missing" || selectedConsultation?.state === "failed")
				) {
					setReplacementConsultationId(selectedConsultation.id);
					setLauncher(true);
				} else setLauncher(true);
				break;
			case "f":
				if (viewRef.current === "consultations") cycleConsultationHistory();
				break;
			case "x":
				if (viewRef.current === "consultations" && selectedConsultation !== undefined) {
					if (selectedConsultation.state === "opening" || selectedConsultation.state === "working")
						setPanel({ kind: "consultation-close", identity: selectedConsultation.id });
					else if (
						selectedConsultation.state === "awaiting-response" ||
						selectedConsultation.state === "missing" ||
						selectedConsultation.state === "failed"
					)
						closeConsultation(selectedConsultation);
					else if (selectedConsultation.state === "closing")
						setPanel({ kind: "consultation-close", identity: selectedConsultation.id });
				}
				break;
			case "d":
				if (viewRef.current === "consultations" && selectedConsultation?.state === "closed")
					setPanel({ kind: "consultation-delete", identity: selectedConsultation.id });
				break;
			case "h":
			case "left":
				focusPane("list");
				break;
			case "l":
			case "right":
				focusPane("detail");
				break;
			case "j":
			case "down":
				moveVertical(1);
				break;
			case "k":
			case "up":
				moveVertical(-1);
				break;
			case "pagedown":
				movePage(1);
				break;
			case "pageup":
				movePage(-1);
				break;
			case "home":
				moveEdge("start");
				break;
			case "end":
				if (viewRef.current === "consultations" && focusedPaneRef.current === "detail") {
					consultationFollowRef.current = true;
					setConsultationScroll(999999);
					setNewOutput(false);
				} else moveEdge("end");
				break;
			case "return": {
				if (viewRef.current === "consultations") {
					if (selectedConsultation === undefined) break;
					if (selectedConsultation.state === "awaiting-response") {
						// The editor opens on the Agent's observed status, not on
						// the last settled turn: a blocked Agent takes the keys
						// until it stops blocking.
						if (
							selectedConsultationAgentStatus === "blocked" &&
							selectedConsultation.paneId !== null
						)
							setInteraction(true);
						else beginResponse(selectedConsultation);
					} else if (
						selectedConsultation.state === "missing" ||
						selectedConsultation.state === "failed"
					)
						setStatus({ kind: "warning", text: "use c to open a Replacement Consultation" });
					else if (selectedConsultation.state === "working" && selectedConsultation.paneId !== null)
						setInteraction(true);
					else
						setStatus({
							kind: "info",
							text: `Consultation ${selectedConsultation.id.slice(0, 8)} is ${selectedConsultation.state}`,
						});
					break;
				}
				const ticket = ticketsRef.current[selectedIndexRef.current];
				if (ticket === undefined) break;
				if (ticket.state === "open") {
					startHandoff(choiceFor(ticket));
					break;
				}
				if (ticket.state === "awaiting") {
					// The factory decides the ticket itself in auto mode, and an
					// auto-close type decides in both modes: the operator has no
					// panel for it.
					if (autoModeRef.current) {
						setStatus({
							kind: "info",
							text: "auto-handoff is on: the factory decides this ticket",
						});
						break;
					}
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
				if (!openAttention()) toggleAutoHandoff();
				break;
			case "r":
				if (viewRef.current === "consultations" && selectedConsultation?.state === "opening")
					recoverConsultationOpening(selectedConsultation);
				else coordinatorRef.current?.refreshAll();
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
		replaceConsultations();
	}, [state, replaceTickets, replaceConsultations]);

	// Repository choices are validated before the launcher presents them. A
	// stale mapping stays hidden instead of letting an operator start in an
	// unrelated checkout.
	const repositoryCatalogKey = consultationRepositoryCatalog(config, tickets)
		.map((option) => `${option.identity}\u0000${option.path}`)
		.join("\u0001");
	// biome-ignore lint/correctness/useExhaustiveDependencies: repositoryCatalogKey is derived from config and tickets and tracks both
	useEffect(() => {
		let active = true;
		void validateConsultationRepositoryOptions(
			consultationRepositoryCatalog(config, tickets),
			commandRunner,
			homeDir,
		).then((options) => {
			if (active) setRepositoryOptions(options);
		});
		return () => {
			active = false;
		};
		// Re-validate only when the catalog contents change. The tickets array
		// gets a fresh identity on every poll, and re-validating on each poll
		// would spawn git calls for every repository per tick.
	}, [commandRunner, homeDir, repositoryCatalogKey]);

	// The selected Agent output refreshes at one-second cadence. Lifecycle
	// polling remains owned by the shared observation coordinator.
	useEffect(() => {
		if (
			state === undefined ||
			view !== "consultations" ||
			selectedConsultation?.paneId === null ||
			selectedConsultation === undefined
		) {
			setLiveOutput(null);
			return;
		}
		let active = true;
		const reader = new HerdrAgentReader(commandRunner);
		const refresh = async () => {
			const output = interaction
				? await reader.readPaneAnsi(
						selectedConsultation.paneId as string,
						configRef.current.completionMessageLines,
					)
				: await reader.readPane(
						selectedConsultation.paneId as string,
						configRef.current.completionMessageLines,
					);
			if (!active) return;
			if (output === null) {
				const current = state.consultation(selectedConsultation.id);
				if (current !== undefined && current.warning !== "Stale Agent output") {
					state.setConsultationWarning(current.id, "Stale Agent output");
					replaceConsultations();
				}
				return;
			}
			const current = state.consultation(selectedConsultation.id);
			if (current?.warning === "Stale Agent output") {
				state.setConsultationWarning(current.id, null);
				replaceConsultations();
			}
			if (consultationFollowRef.current) {
				setConsultationScroll(999999);
				setNewOutput(false);
			}
			setLiveOutput((previous) => {
				if (!consultationFollowRef.current && previous !== null && previous !== output)
					setNewOutput(true);
				return output;
			});
		};
		outputRefreshRef.current = () => void refresh();
		void refresh();
		const timer = setInterval(() => void refresh(), interaction ? 250 : 1000);
		return () => {
			active = false;
			outputRefreshRef.current = null;
			clearInterval(timer);
		};
	}, [commandRunner, interaction, replaceConsultations, selectedConsultation, state, view]);

	// A ref lets the key handler use the startup coordinator without making
	// React recreate keyboard subscriptions on each frame.
	useEffect(() => {
		if (state === undefined) return;
		const coordinator = new RefreshCoordinator(sources, state, () => {
			replaceTickets();
			replaceConsultations();
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
	}, [state, sources, replaceTickets, replaceConsultations]);

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
			onChanged: () => {
				replaceTickets();
				replaceConsultations();
			},
			onAgents: (agents) => setAgents(agents),
			onConsultationsChanged: replaceConsultations,
			onConsultationAttention: (_id) => {
				if (configRef.current.attentionBell) {
					setBell(true);
					setTimeout(() => setBell(false), 250);
					process.stdout.write("\u0007");
				}
			},
			reconcileOnly: true,
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
	}, [
		state,
		initialTickets,
		pollIntervalMs,
		replaceTickets,
		replaceConsultations,
		commandRunner,
		onReady,
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
		if (viewRef.current === "consultations") {
			if (focusedPaneRef.current === "detail") {
				consultationFollowRef.current = false;
				setConsultationScroll((current) => clamp(current + delta, 0, consultationMaxScroll));
			} else {
				setConsultationIndex((index) => {
					const next = clamp(index + delta, 0, consultationsRef.current.length - 1);
					consultationIndexRef.current = next;
					return next;
				});
				setConsultationScroll(0);
				consultationFollowRef.current = true;
				setNewOutput(false);
			}
			return;
		}
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
		} else selectTicket(edge === "start" ? 0 : ticketsRef.current.length - 1);
	}

	const panelTicket =
		panel === null ||
		panel.kind === "consultation-close" ||
		panel.kind === "consultation-delete" ||
		panel.kind === "consultation-force" ||
		panel.kind === "consultation-safety"
			? undefined
			: ticketsRef.current.find((ticket) => ticket.identity === panel.identity);
	const panelConsultation =
		panel !== null &&
		(panel.kind === "consultation-close" ||
			panel.kind === "consultation-delete" ||
			panel.kind === "consultation-force" ||
			panel.kind === "consultation-safety")
			? consultationsRef.current.find((item) => item.id === panel.identity)
			: undefined;
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
	const replacementConsultation =
		replacementConsultationId === null
			? undefined
			: consultations.find((item) => item.id === replacementConsultationId);
	const launcherInitialType =
		replacementConsultation !== undefined ? replacementConsultation.typeName : undefined;
	const launcherInitialInput =
		replacementConsultation === undefined || state === undefined
			? ""
			: state.replacementInput(replacementConsultation.id);
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
			// The mode, health, and status lines reserve terminal rows below this
			// flex child. Allow it to shrink on a resize so it cannot paint its
			// bottom borders through one of those lines.
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
			view === "tickets"
				? createElement(TicketList, {
						tickets,
						selectedIndex,
						focused: focusedPane === "list",
						reservedRows,
						emptyMessage,
						markerOf,
						limitReached: (ticket) => ticket.handoffCount >= config.maxHandoffsPerTicket,
						active: override === null && panel === null,
						onFocus: () => focusPane("list"),
						onSelect: selectTicket,
						onMove: moveList,
					})
				: consultationNarrow
					? null
					: createElement(ConsultationList, {
							consultations,
							selectedIndex: consultationIndex,
							focused: focusedPane === "list",
							reservedRows,
							emptyMessage:
								state === undefined
									? "Consultations require SQLite state"
									: historyFilter === "closed"
										? "no closed Consultations"
										: historyFilter === "all"
											? "no Consultations"
											: "no open Consultations",
						}),
			view === "tickets"
				? createElement(TicketDetail, {
						ref: detailRef,
						ticket: selectedTicket,
						focused: focusedPane === "detail",
						active: override === null && panel === null,
						reservedRows,
						handoffLimit: config.maxHandoffsPerTicket,
						scroll: config.scroll,
						onFocus: () => focusPane("detail"),
					})
				: createElement(
						"box",
						{ style: { flexGrow: 1, flexDirection: "column" } },
						createElement(ConsultationDetail, {
							lines: consultationLines,
							ansiLines,
							visibleRows: Math.max(1, detailGeometry.visibleRows - (responseEditor ? 6 : 0)),
							scroll: consultationDetailScroll,
							focused: focusedPane === "detail" && !responseEditor,
							compactHeading:
								consultationNarrow && selectedConsultation !== undefined
									? `${selectedConsultation.typeName} - ${selectedConsultation.repository.displayName}`
									: undefined,
						}),
						responseEditor &&
							createElement(
								"box",
								{
									border: true,
									borderColor: COLORS.borderFocused,
									title: "Response",
									padding: 1,
									style: { flexDirection: "column" },
								},
								createElement(
									"text",
									{ fg: COLORS.textBright },
									truncateToWidth(responseDraft || "(empty)", consultationWidth),
								),
								createElement(
									"text",
									{ fg: COLORS.dim },
									truncateToWidth(
										"enter submit  shift+enter newline  esc keep draft",
										consultationWidth,
									),
								),
							),
					),
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
		attentionLine !== "" &&
			createElement(
				"text",
				{
					style: {
						width: "100%",
						fg: consultationCounts.awaitingResponse > 0 ? COLORS.textBright : COLORS.dim,
					},
				},
				truncateToWidth(attentionLine, terminalWidth),
			),
		launcher &&
			createElement(ConsultationLauncher, {
				types: config.consultationTypes,
				repositories: repositoryOptions,
				initialType: launcherInitialType,
				initialRepository:
					replacementConsultation?.repository.identity ?? selectedTicket?.repositoryRef.identity,
				initialInput: launcherInitialInput,
				title:
					replacementConsultation === undefined
						? "Consultation launcher"
						: "Replacement Consultation",
				onLaunch: startConsultation,
				onCancel: () => {
					setLauncher(false);
					setReplacementConsultationId(null);
				},
			}),
		view === "consultations" && state !== undefined && actionBarElement(actionContext),
		status !== null &&
			createElement(
				"text",
				{ style: { width: "100%", fg: statusColor } },
				truncateToWidth(`${status.kind}: ${status.text}`, terminalWidth),
			),
		override !== null &&
			createElement(OverridePanel, {
				agents: Object.keys(config.agents),
				environments: HANDOFF_ENVIRONMENT_KINDS,
				taskTypes: Object.keys(config.taskTypes),
				agentSettings,
				profiles,
				modelList,
				onAgentChange: requestModelList,
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
				? createElement(DecisionModal, {
						title: panelTicket.title,
						contextLine: decision.contextLine,
						entries: decision.entries,
						actions: decision.actions,
						onAction: (key) => runDecisionAction(panelTicket, key),
						onCancel: () => setPanel(null),
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
					})),
		panel !== null &&
			panel.kind === "consultation-safety" &&
			panelConsultation !== undefined &&
			consultationSafety?.consultationId === panelConsultation.id &&
			createElement(ActionPanel, {
				title: `Live checkout conflict ${panelConsultation.id.slice(0, 8)}`,
				bodyLines: [
					...(consultationSafety.safety.warning === undefined
						? []
						: [consultationSafety.safety.warning]),
					...consultationSafety.safety.conflicts.map((conflict) => `Conflict: ${conflict.label}`),
					"Confirm once to share this live checkout, or cancel and recover later.",
				],
				actions: [
					{ key: "confirm", label: "Confirm", detail: "allow this Consultation once" },
					{ key: "cancel", label: "Cancel", detail: "do not start the Agent" },
				],
				onAction: (key) => {
					setPanel(null);
					setConsultationSafety(null);
					if (key === "confirm") {
						state?.setConsultationLiveConflictOverride(panelConsultation.id);
						const current = state?.consultation(panelConsultation.id);
						if (current !== undefined) {
							setStatus({
								kind: "info",
								text: `opening Consultation ${current.id.slice(0, 8)}...`,
							});
							beginConsultationLaunch(current);
						}
					}
				},
				onCancel: () => {
					setPanel(null);
					setConsultationSafety(null);
					setStatus({
						kind: "warning",
						text: "Consultation launch cancelled; recover or close it explicitly",
					});
				},
			}),
		panel !== null &&
			panelConsultation !== undefined &&
			panel.kind === "consultation-close" &&
			createElement(ActionPanel, {
				title: `Close Consultation ${panelConsultation.id.slice(0, 8)}`,
				bodyLines: [
					panelConsultation.environment === "worktree"
						? "The Agent may still be working. Close keeps the worktree and branch."
						: "The Agent may still be working. Close only on an explicit operator decision.",
					...(panelConsultation.state === "closing"
						? ["Cleanup is already in progress. Force-close records remaining resources."]
						: []),
				],
				actions: [
					...(panelConsultation.state === "closing"
						? [
								{ key: "retry", label: "Retry", detail: "retry unconfirmed cleanup" },
								{ key: "force", label: "Force-close", detail: "record cleanup for later recovery" },
							]
						: [{ key: "close", label: "Close", detail: "stop the Agent and retain the checkout" }]),
					{ key: "cancel", label: "Cancel", detail: "keep the Consultation running" },
				],
				onAction: (key) => {
					if (key === "close" || key === "retry") {
						setPanel(null);
						closeConsultation(panelConsultation);
					}
					if (key === "force")
						setPanel({ kind: "consultation-force", identity: panelConsultation.id });
				},
				onCancel: () => setPanel(null),
			}),
		panel !== null &&
			panel.kind === "consultation-force" &&
			panelConsultation !== undefined &&
			state !== undefined &&
			createElement(ActionPanel, {
				title: `Force-close Consultation ${panelConsultation.id.slice(0, 8)}?`,
				bodyLines: [
					"Force-close stops the cleanup and closes the record. These owned",
					"resources remain in herdr and stay recorded for later recovery:",
					...state
						.consultationResources(panelConsultation.id)
						.filter((item) => item.owned && !item.confirmedClosed)
						.map((item) => `${item.kind} ${item.resourceId} - ${item.details}`),
					...(state
						.consultationResources(panelConsultation.id)
						.filter((item) => item.owned && !item.confirmedClosed).length === 0
						? ["No owned resources are recorded."]
						: []),
				],
				actions: [
					{ key: "force", label: "Force-close", detail: "record the remaining resources" },
					{ key: "cancel", label: "Cancel", detail: "stay in closing state" },
				],
				onAction: (key) => {
					setPanel(null);
					if (key === "force") forceCloseConsultation(panelConsultation);
				},
				onCancel: () => setPanel(null),
			}),
		panel !== null &&
			panelConsultation !== undefined &&
			panel.kind === "consultation-delete" &&
			createElement(ActionPanel, {
				title: `Delete Consultation ${panelConsultation.id.slice(0, 8)}`,
				bodyLines: [
					"Saved history will be removed. Backups and filesystem snapshots may retain copies. Data is not encrypted.",
				],
				actions: [
					{ key: "delete", label: "Delete", detail: "remove local history" },
					{ key: "cancel", label: "Cancel" },
				],
				onAction: (key) => {
					setPanel(null);
					if (key === "delete") deleteConsultation(panelConsultation);
				},
				onCancel: () => setPanel(null),
			}),
		utility !== null &&
			createElement(ActionGuide, {
				context: actionContext,
				utility,
				onClose: () => setUtility(null),
				onMessage: () => setUtility("message"),
			}),
	);
}

/**
 * What one close operation may take down, judged per level:
 *
 * - workspaceExclusive: no other tab and no other pane anywhere, so the
 *   workspace close takes down exactly the Consultation's own tab and pane.
 * - ownedTabExclusive: the Consultation's tab holds no other pane, so the tab
 *   close takes down exactly the Consultation's own pane, whatever other tabs
 *   share the workspace.
 *
 * Neither holds when a foreign pane sits in the owned tab: then only the
 *   pane close is safe. A foreign pane in another tab of the same workspace
 *   never blocks the tab close, because herdr closes tabs and panes, not
 *   workspaces, at that level.
 */
async function workspaceTopology(
	runner: CommandRunner,
	workspaceId: string,
	ownedPaneId: string | null,
	ownedTabId: string | null,
): Promise<{ known: boolean; workspaceExclusive: boolean; ownedTabExclusive: boolean }> {
	const [tabs, panes] = await Promise.all([
		runner.run("herdr", ["tab", "list", "--workspace", workspaceId]),
		runner.run("herdr", ["pane", "list", "--workspace", workspaceId]),
	]);
	if (tabs.code !== 0 || panes.code !== 0)
		return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
	try {
		const tabData = JSON.parse(tabs.stdout) as { result?: { tabs?: unknown } };
		const paneData = JSON.parse(panes.stdout) as { result?: { panes?: unknown } };
		if (!Array.isArray(tabData.result?.tabs) || !Array.isArray(paneData.result?.panes))
			return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
		if (
			!tabData.result.tabs.every((tab) => isRecordValue(tab) && typeof tab.tab_id === "string") ||
			!paneData.result.panes.every(
				(pane) =>
					isRecordValue(pane) &&
					typeof pane.pane_id === "string" &&
					typeof pane.tab_id === "string",
			)
		)
			return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
		const otherTabs = tabData.result.tabs.filter(
			(tab) => (tab as { tab_id: string }).tab_id !== ownedTabId,
		);
		const panesInOwnedTab = paneData.result.panes.filter(
			(pane) => (pane as { tab_id: string }).tab_id === ownedTabId,
		);
		const foreignPanesInOwnedTab = panesInOwnedTab.filter(
			(pane) => (pane as { pane_id: string }).pane_id !== ownedPaneId,
		);
		return {
			known: true,
			workspaceExclusive: otherTabs.length === 0 && foreignPanesInOwnedTab.length === 0,
			ownedTabExclusive: foreignPanesInOwnedTab.length === 0,
		};
	} catch {
		return { known: false, workspaceExclusive: false, ownedTabExclusive: false };
	}
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
