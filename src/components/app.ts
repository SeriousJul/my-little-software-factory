/**
 * The control plane shell: panes, refresh, selection, handoff, and the
 * herdr observation loop (ADR 0005, ADR 0006).
 *
 * The mode line carries the auto-handoff state and the live agent count
 * against the parallel limit. Enter on an open ticket hands it off; Enter
 * on an awaiting ticket opens the decision modal (close, Goto, or a
 * workflow handoff), while the factory does not decide the ticket itself
 * (auto mode, or an auto-close task type); Enter on an in-flight ticket
 * opens the Live view, which streams the agent's terminal output, offers
 * the Goto, and becomes the decision modal when the turn settles and the
 * factory waits for the operator; Enter on an in-flight ticket whose pane
 * herdr no longer lists opens the missing modal (restart or abandon).
 * `a` toggles auto-handoff.
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
	type EnvironmentKind,
	HANDOFF_ENVIRONMENT_KINDS,
	type Handoff,
	type LeftoverEnvironment,
	type Ticket,
	type TicketState,
} from "../domain/ticket.ts";
import {
	baseChoice,
	type CloseCleanupOptions,
	checkConsultationStart,
	closeCleanupReach,
	closeHandoffEnvironment,
	type HandoffChoice,
	type HandoffOutcome,
	handOffConsultation,
	handOffStoredWorkspace,
	handOffTicket,
	type NameCollision,
	type OwnNameKnowledge,
	renderConsultationPrompt,
	resolveHandoffChoice,
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
import { type TaskProfileStart, taskProfilesOf } from "../setting-resolution.ts";
import type { Consultation, FactoryState, HandoffClaim, HandoffOrigin } from "../state.ts";
import type { TicketSource } from "../ticket-source.ts";
import type { TurnLogEntry } from "../turn-log.ts";
import { ActionBar } from "./action-bar.ts";
import { ActionPanel, panelBodyCols } from "./action-panel.ts";
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
import { createControlDispatch, refusalReason, refusalText } from "./control-dispatch.ts";
import {
	availabilityFor,
	type ControlContext,
	contextFor,
	controlById,
	type InteractionMode,
} from "./controls.ts";
import { DecisionModal } from "./decision-modal.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { LiveView } from "./live-view.ts";
import { useMessageFacts } from "./message-facts.ts";
import {
	messageColor as colorOfMessage,
	formatMessage,
	type MessageFact,
	messageRowElement,
} from "./messages.ts";
import { MissingModal } from "./missing-modal.ts";
import { type ActionRow, belowMinimum, TOO_SMALL_TEXT } from "./modal-chrome.ts";
import {
	type AgentModelList,
	type AgentSettings,
	type ModelListStatus,
	OverridePanel,
} from "./override-panel.ts";
import { padToWidth, truncateToWidth, truncateWithEllipsis, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";
import {
	detailScrollRoom,
	leftoverWhere,
	TicketDetail,
	type TicketDetailHandle,
} from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";
import { KeyGuide, MessageView } from "./utility.ts";

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
	| { kind: "consultation-safety"; identity: string }
	| { kind: "leftover"; identity: string }
	| { kind: "live"; identity: string };

/**
 * The dim note under the last stream lines when the latest read failed:
 * the Stale Agent output, the glossary's name for it.
 */
const STALE_STREAM_NOTE = "Stale Agent output: the last lines stand";

/**
 * The handoff waiting behind the override panel.
 *
 * The panel edits one Handoff's settings, wherever its choice came from, so
 * it carries what the confirm step needs to claim the same handoff: which
 * Ticket, and which Origin of its dispatch. Only the two routes the panel
 * opens from appear here: an open Ticket's own handoff, and a workflow route
 * the operator edited from its decision row, in the decision modal or in the
 * Live view's decision sub-mode. The workflow route also carries which
 * ticket panel it opened from, so an Esc and a confirmed route return there
 * instead of guessing. A Restart or an automatic route never opens the
 * panel, so neither Origin reaches it. The prompt's previous message is not
 * carried here: the confirm reads it from the Ticket it claims, so an edit
 * can never send a message another Ticket left behind.
 */
type PendingOverride =
	| {
			ticketIdentity: string;
			origin: "open";
			choice: HandoffChoice;
	  }
	| {
			ticketIdentity: string;
			origin: "workflow";
			/** The ticket panel the route row was on: Esc and the confirm return there. */
			from: "decision" | "live";
			choice: HandoffChoice;
	  };

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
	| "w"
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
/**
 * The utility overlay open above the panes, if any. Overlays replace one
 * another. The ticket view and the ticket modals use the catalog's guide and
 * the Message view's captured fact, and the consultations view keeps the
 * pre-catalog Action guide and message view until it is ported to the
 * control catalog.
 */
type Utility =
	| null
	| { kind: "guide"; mode: InteractionMode }
	| { kind: "message"; mode: InteractionMode; fact: MessageFact }
	| { kind: "consultation"; utility: ActionUtility };
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
	// The ticket detail's native scroll offset survives a below-minimum
	// unmount through this slot: the pane saves its offset out, and a remount
	// of the same ticket resumes from it.
	const detailScrollSlot = useRef<{ identity: string; top: number } | null>(null);
	const [status, setStatus] = useState<StatusMessage | null>(null);
	// The handoff the override panel is editing: its ticket, where it came
	// from, and the settings it resolves to before the operator changes them.
	const [override, setOverride] = useState<PendingOverride | null>(null);
	const overrideRef = useRef<PendingOverride | null>(null);
	overrideRef.current = override;
	const [utility, setUtility] = useState<Utility>(null);
	const [healths, setHealths] = useState(() => state?.sourceHealths() ?? []);
	const [panel, setPanel] = useState<Panel>(null);
	/**
	 * The Live view's stream: the lines of the last pane read, and the stale
	 * note while the latest read failed. Null while no stream runs.
	 */
	const [liveStream, setLiveStream] = useState<{
		lines: readonly string[];
		note: string | null;
	} | null>(null);
	const [autoMode, setAutoMode] = useState<boolean>(
		() => (configProp ?? DEFAULT_CONFIG).autoHandoff,
	);
	const autoModeRef = useRef(autoMode);
	const [agents, setAgents] = useState<readonly HerdrAgent[] | null>(null);
	// The key handler outlives the render that made the decision it acts on,
	// so the marker it re-checks reads the latest list through a ref.
	const agentsRef = useRef<readonly HerdrAgent[] | null>(null);
	agentsRef.current = agents;
	// The herdr seat: one external change to a ticket's environment at a time.
	// A handoff holds it while herdr builds the environment and starts the
	// agent. Close cleanups and leftover clears queue behind that work, and a
	// queued cleanup reserves the seat until every earlier cleanup ends.
	const inFlightRef = useRef(false);
	const clearingRef = useRef(false);
	const cleanupQueuedRef = useRef(false);
	const cleanupQueueRef = useRef<readonly (() => Promise<void>)[]>([]);
	/** True while a handoff or a queued environment change owns the seat. */
	const seatHeld = () => inFlightRef.current || cleanupQueuedRef.current;
	// Handoffs claimed while another is in flight: they run in claim order
	// once the running one settles.
	const queueRef = useRef<
		readonly {
			ticket: Ticket;
			choice: HandoffChoice;
			origin: HandoffOrigin;
			claim: HandoffClaim;
			previousMessage: string;
			onStarted?: (started: DispatchResult) => void;
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
	const sourceHealthMessage = healths
		.filter((health) => health.health === "stale" || health.health === "removed")
		.map(
			(health) =>
				`${health.name}: ${health.health}${health.error === undefined ? "" : ` - ${health.error}`}`,
		)
		.join("; ");
	// The consultations view shows the same source health on its own line.
	const healthLine = sourceHealthMessage;
	const {
		message: visibleMessage,
		working: setWorkingMessage,
		notice: setNoticeMessage,
		warning: setWarningMessage,
		error: setErrorMessage,
		clearOperation: clearOperationMessage,
		clearWorking: clearWorkingMessage,
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
	const consultationCounts = state?.consultationCounts() ?? { awaitingResponse: 0, recovery: 0 };
	const attentionLine =
		state === undefined ||
		(view === "tickets" &&
			consultationCounts.awaitingResponse === 0 &&
			consultationCounts.recovery === 0)
			? ""
			: `awaiting response: ${consultationCounts.awaitingResponse}  recovery: ${consultationCounts.recovery}${bell ? "  !!!" : ""}${view === "consultations" && newOutput ? "  new output" : ""}`;
	const tooSmall = belowMinimum(terminalWidth, terminalHeight);
	// The compact frame's own arithmetic. One row holds the Action bar at any
	// height (user story 73), the Message line gives up before it, and the size
	// box takes what is left: padding first, then rows. It is handed no more
	// lines than it holds, so nothing can paint through the bar's row.
	const compactBarRows = 1;
	const compactMessageRows = terminalHeight >= 2 ? 1 : 0;
	const compactRows = Math.max(0, terminalHeight - compactBarRows - compactMessageRows);
	const compactPadding = compactRows >= 3 ? 1 : 0;
	const compactTextWidth = Math.max(1, terminalWidth - 2 * compactPadding);
	const compactLineCount = Math.max(0, compactRows - 2 * compactPadding);
	// The tickets view keeps the permanent Message line and Action bar. The
	// mode line is above its panes, and the attention line joins the bottom
	// rows when a Consultation needs the operator. Keep the compact size
	// frame focused on its size and Help controls when it cannot show the
	// normal layout.
	const showModeLine = modeLine !== "" && !tooSmall && terminalHeight >= 8;
	const showAttentionLine = attentionLine !== "" && !tooSmall;
	const reservedRows =
		view === "consultations"
			? (status === null ? 0 : 1) +
				(healthLine === "" ? 0 : 1) +
				(modeLine === "" ? 0 : 1) +
				(attentionLine === "" ? 0 : 1) +
				(state !== undefined ? 1 : 0)
			: 2 + (showModeLine ? 1 : 0) + (showAttentionLine ? 1 : 0);
	const listGeometry = usePaneGeometry("list", reservedRows);
	const detailGeometry = usePaneGeometry("detail", reservedRows);
	// The Scroll control's availability must agree with the native detail's
	// own overflow, so it asks the pane for the measurement rather than
	// repeating the pane's gutter rule here.
	const detailMaxScroll = detailScrollRoom(
		tickets[selectedIndex],
		detailGeometry.usableCols,
		detailGeometry.visibleRows,
		config.maxHandoffsPerTicket,
	);
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
		selectedInFlight:
			(tickets[selectedIndex]?.state ?? null) === "handed-off" ||
			(tickets[selectedIndex]?.state ?? null) === "running",
		selectedConsultation,
		selectedLeftover: (tickets[selectedIndex]?.leftover ?? null) !== null,
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
				contextWindow: agent.contextWindow !== undefined,
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
		return resolveHandoffChoice(configRef.current, ticket.suggestedTaskType);
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
	/**
	 * Resolve a handoff operation into the durable Message facts.
	 *
	 * The Handoff's own progress ends here. A clean handoff ends only that
	 * progress: an outcome the operator wrote while it ran - a sibling
	 * operation refused during the flight - surfaces when the Working line
	 * goes, because the handoff's start already cleared whatever sat on the
	 * slot before. The Working line of a refresh that ran while it was in
	 * flight stays.
	 *
	 * A handoff that started beside its own leftover agent says so: the name
	 * the operator knows from herdr is not the one this agent runs under, and
	 * the leftover is what to clear to get it back. That warning rides along
	 * with an outcome that did not finish - an agent that started but could
	 * not be prompted is the error the operator has to act on - and never
	 * replaces it.
	 */
	const finishOutcome = async (outcome: HandoffOutcome): Promise<void> => {
		const persistWarning =
			outcome.notes?.mappingToWrite === undefined
				? undefined
				: await persistMapping(outcome.notes.mappingToWrite);
		const nameWarning =
			outcome.collision !== undefined && outcome.collision.startedAs !== null
				? `a leftover agent still holds the herdr name ${outcome.collision.stableName}; this agent started as ${outcome.collision.startedAs}`
				: undefined;
		const lines = [
			...(outcome.status === "ok" ? [] : [outcome.reason]),
			...(nameWarning === undefined ? [] : [nameWarning]),
			...(persistWarning === undefined ? [] : [persistWarning]),
			...(outcome.status === "ok" && outcome.notes?.warning !== undefined
				? [outcome.notes.warning]
				: []),
		];
		clearWorkingMessage("handoff");
		if (outcome.status !== "ok") setErrorMessage(lines.join("; "));
		else if (lines.length > 0) setWarningMessage(lines.join("; "));
		// A clean handoff leaves the outcome slot to whatever it holds now, and
		// what holds now is a fact written during this flight, which the
		// operator reads once the progress goes.
	};
	/**
	 * What the handoff may assume about the herdr agent name it wants.
	 *
	 * The control plane recorded the handles of this ticket's own handoffs,
	 * and it may already hold the durable fact that one of them is left over
	 * in herdr. A name held by those handles is held by the ticket's own
	 * leftover agent, and the handoff starts beside it under its cycle name
	 * instead of failing on it (ADR 0012).
	 */
	const nameKnowledgeFor = (identity: string): OwnNameKnowledge | undefined => {
		if (state === undefined) return undefined;
		const handles = state.handoffHandles(identity);
		return {
			ownPaneIds: handles.paneIds,
			ownWorkspaceIds: handles.workspaceIds,
			leftoverKnown: state.leftoverEnvironment(identity) !== null,
		};
	};
	/**
	 * Make a name collision with the ticket's own leftover agent durable.
	 *
	 * The handoff started beside the leftover, so the work runs. The fact
	 * that the earlier cycle's agent still lives, and still holds the name
	 * the ticket's stable handoff would want, belongs to the ticket until
	 * the operator clears it: the detail pane says so, and `w` ends it.
	 */
	const recordNameCollision = (identity: string, collision: NameCollision) => {
		if (state === undefined || !collision.own) return;
		state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			paneId: collision.holder?.paneId ?? null,
			reason: `the leftover agent still holds the herdr name ${collision.stableName}: ${collision.reason}`,
		});
	};
	/** Start the next queued cleanup only when the handoff seat is free. */
	const drainCleanupQueue = (): void => {
		if (inFlightRef.current || clearingRef.current) return;
		const cleanup = cleanupQueueRef.current[0];
		if (cleanup === undefined) {
			cleanupQueuedRef.current = false;
			drainQueue();
			return;
		}
		clearingRef.current = true;
		cleanupQueueRef.current = cleanupQueueRef.current.slice(1);
		void cleanup().finally(() => {
			clearingRef.current = false;
			drainCleanupQueue();
		});
	};
	/** Queue one environment change and reserve the handoff seat for it. */
	const queueCleanup = <Result>(work: () => Promise<Result>): Promise<Result> => {
		cleanupQueuedRef.current = true;
		const queued = new Promise<Result>((resolve, reject) => {
			cleanupQueueRef.current = [
				...cleanupQueueRef.current,
				async () => {
					try {
						resolve(await work());
					} catch (error) {
						reject(error);
					}
				},
			];
		});
		drainCleanupQueue();
		return queued;
	};
	/**
	 * Queue one Close cleanup behind every earlier environment change.
	 *
	 * All four cleanup paths - the operator's Close, an Abandon, the automatic
	 * close in the observation loop, and the clear action's retry - use this
	 * queue. A handoff cannot drain between two cleanups, so herdr never builds
	 * an agent in an environment another cleanup is still taking away.
	 */
	const runCleanupWithSeat = (
		openState: FactoryState,
		handoff: {
			ticketIdentity: string;
			handoffId: string;
			environment: EnvironmentKind;
			tabId: string | null;
			workspaceId: string | null;
		},
		options: CloseCleanupOptions = {},
	): Promise<string | undefined> =>
		queueCleanup(() => settleCloseCleanup(openState, commandRunner, handoff, options));
	/**
	 * The Close cleanup of the handoff a cycle ends, reported on the Message
	 * line. The durable half of it (record the surviving environment, clear
	 * what the removal ended) is settleCloseCleanup's.
	 */
	const runCloseCleanup = (
		identity: string,
		handoff: {
			handoffId: string;
			environment: EnvironmentKind;
			tabId: string | null;
			workspaceId: string | null;
		},
		end: "closed" | "abandoned",
	) => {
		if (state === undefined) return;
		const openState = state;
		void runCleanupWithSeat(openState, {
			ticketIdentity: identity,
			...handoff,
		}).then(
			(failure) => {
				replaceTickets();
				if (failure === undefined) return;
				setErrorMessage(`ticket ${identity} ${end}; the close cleanup failed: ${failure}`);
			},
			// The helper records the answer and never throws on a cleanup that
			// broke; only the reporting here can still fail, and a Message line
			// that cannot be written must not go unhandled.
			(error) => {
				setErrorMessage(
					`ticket ${identity} ${end}; the close cleanup could not be reported: ${errorMessage(error)}`,
				);
			},
		);
	};
	/**
	 * Clear a ticket's leftover environments: retry the Close cleanup that
	 * failed, and reach for herdr's force only when the operator chose it.
	 *
	 * Every cleanup reaches the environment its handles name: a worktree
	 * removal takes the whole workspace with the checkout, and a tab close
	 * takes the tab and the pane inside it. So the action refuses any leftover
	 * that names a handle the ticket's own live agent works on: the operator
	 * closes that cycle first, and the leftover goes with it. A reclaimed agent
	 * shares its pane, tab, and workspace with the handoff that was closed
	 * around it (ADR 0011), so the guard reads all three handles.
	 *
	 * The guard reads the durable state at the moment of the action, not the
	 * render snapshot, which can miss a handoff that settled after it was
	 * drawn. The seat holds in both directions: a clear refuses while a
	 * handoff runs, and the clear takes the seat itself, so a handoff the
	 * operator starts during a removal waits for it.
	 */
	const clearLeftover = (ticket: Ticket, force: boolean) => {
		if (state === undefined) {
			setWarningMessage("no factory state is open, so a leftover environment cannot be cleared");
			return;
		}
		if (inFlightRef.current) {
			setWarningMessage(
				`a handoff is in flight: wait for it to settle before you clear the leftover environment of ticket ${ticket.identity}`,
			);
			return;
		}
		if (cleanupQueuedRef.current) {
			setWarningMessage(
				`a leftover clear is already in flight: wait for it to settle before you clear ticket ${ticket.identity} again`,
			);
			return;
		}
		const leftovers = state.leftoverEnvironments(ticket.identity);
		if (leftovers.length === 0) {
			setWarningMessage(`no leftover environment is recorded for ticket ${ticket.identity}`);
			replaceTickets();
			return;
		}
		const live =
			state.ticketState(ticket.identity) === "open"
				? null
				: (state.latestHandoff(ticket.identity) ?? null);
		const atRisk = live === null ? null : (liveHandleAtRisk(leftovers, live) ?? null);
		if (atRisk !== null && live !== null) {
			setWarningMessage(
				`the agent of ticket ${ticket.identity} runs in ${atRisk.text}: close its work cycle before you clear that ${atRisk.what}`,
			);
			return;
		}
		const openState = state;
		// One queue item owns the whole clear loop. A handoff cannot run between
		// the facts of one ticket while herdr takes their environments away.
		void queueCleanup(async () => {
			const failures: string[] = [];
			for (const leftover of leftovers) {
				const failure = await settleCloseCleanup(
					openState,
					commandRunner,
					{
						ticketIdentity: ticket.identity,
						handoffId: leftover.handoffId,
						environment: leftover.environment,
						tabId: leftover.tabId,
						workspaceId: leftover.workspaceId,
					},
					{ force },
				);
				if (failure !== undefined) failures.push(failure);
			}
			return failures;
		})
			.then(
				(failures) => {
					if (failures.length === 0)
						setWarningMessage(`cleared the leftover environment of ticket ${ticket.identity}`);
					else
						setErrorMessage(
							`ticket ${ticket.identity} still holds a leftover environment: ${failures.join("; ")}`,
						);
				},
				(error) => {
					setErrorMessage(`clearing the leftover environment failed: ${errorMessage(error)}`);
				},
			)
			.finally(replaceTickets);
	};
	/**
	 * The leftover panel: what still lives in herdr for this ticket, and the
	 * one action that ends it.
	 *
	 * The guidance leads the body, and the rows above the action rows are where
	 * the variable fact lines scroll, so the meaning of the rows - and the
	 * branch fact - stays on screen with them however many facts the ticket
	 * holds. Each fact carries its own reason on the line below its
	 * environment: one line, cut where the panel really renders it and marked
	 * with the ellipsis, because the panel is the hint and the detail pane
	 * carries the whole reason. Rows the window does not hold come back as a
	 * count from ActionPanel, so nothing leaves the screen silently.
	 *
	 * herdr's force is a row of its own, and its guidance stands only while a
	 * leftover worktree checkout can be discarded: a tab leftover has no
	 * checkout to force. A forced removal discards the checkout, so the
	 * control plane never reaches for it on the operator's behalf; the
	 * operator chooses it with their own hands, and the git branch stays
	 * either way.
	 */
	const createLeftoverPanel = (ticket: Ticket) => {
		const leftovers = state?.leftoverEnvironments(ticket.identity) ?? [];
		const forced = leftovers.some((leftover) => leftover.environment === "worktree");
		const cols = panelBodyCols(terminalWidth);
		const facts = leftovers.flatMap((leftover) => [
			// One row per fact and one per reason, with the meaning first: a
			// long handle list cut at a narrow width loses handles, not the
			// fact that the environment is still open.
			truncateWithEllipsis(`still open: ${leftoverWhere(leftover)}`, cols),
			truncateWithEllipsis(leftover.reason, cols),
		]);
		return createElement(ActionPanel, {
			title: `Leftover environment ${ticket.identity}`,
			bodyLines: [
				"Retry runs the Close cleanup again.",
				...(forced ? ["Force adds --force and discards the checkout."] : []),
				"The git branch stays either way.",
				"",
				...facts,
			],
			actions: [
				{ key: "retry", label: "Retry", detail: "clean the environment up again" },
				...(forced
					? [{ key: "force", label: "Force", detail: "remove the checkout by force" }]
					: []),
				{ key: "cancel", label: "Cancel", detail: "leave the environment as it is" },
			],
			onAction: (key) => {
				setPanel(null);
				if (key === "retry" || key === "force") clearLeftover(ticket, key === "force");
			},
			onCancel: () => setPanel(null),
			message: visibleMessage,
		});
	};
	/** Offer the one action that ends a ticket's leftover environment. */
	const openLeftoverPanel = () => {
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket === undefined) {
			setWarningMessage("no ticket is selected");
			return;
		}
		if (ticket.leftover === null) {
			setWarningMessage(`no leftover environment is recorded for ticket ${ticket.identity}`);
			return;
		}
		setPanel({ kind: "leftover", identity: ticket.identity });
	};
	// A leftover panel lists the facts it would clear. When the last one is
	// gone, the panel has nothing to show, and the ticket keys must return at
	// that moment: the panel closes itself.
	useEffect(() => {
		if (panel?.kind !== "leftover") return;
		const ticket = tickets.find((candidate) => candidate.identity === panel.identity);
		if (ticket === undefined || ticket.leftover === null) setPanel(null);
	}, [panel, tickets]);
	/**
	 * Run the external work of a claimed handoff, settle it, and refresh.
	 *
	 * A workflow handoff and a restart run in the workspace of the ticket's
	 * previous handoff; an open-ticket handoff builds the environment from
	 * scratch. A handoff claimed while another runs queues behind it: the
	 * claim has already moved the ticket, so only the external work waits.
	 * When the in-flight handoff settles, the queue drains: the seat is
	 * free, so the next claimed handoff starts.
	 *
	 * `onStarted` hears the one fact the claim cannot state: whether the
	 * agent started. It fires once, and last, after the attempt settled and
	 * after the handoff's own status line, so whoever asked for the route can
	 * decide the turn it came from, and say so on the line. A caller that
	 * records nothing on a start leaves it out.
	 */
	const runClaimedHandoff = (
		ticket: Ticket,
		choice: HandoffChoice,
		origin: HandoffOrigin,
		claim: HandoffClaim,
		previousMessage: string,
		onStarted?: (started: DispatchResult) => void,
	) => {
		if (state === undefined) return;
		// One report per handoff: the settle path and the error path both end
		// in it, and a route's decision answers for exactly one start.
		let reported = false;
		const reportStarted = (started: DispatchResult): void => {
			if (reported) return;
			reported = true;
			onStarted?.(started);
		};
		if (seatHeld()) {
			queueRef.current = [
				...queueRef.current,
				{ ticket, choice, origin, claim, previousMessage, onStarted },
			];
			return;
		}
		inFlightRef.current = true;
		setWorkingMessage(`handing off "${ticket.title}"...`, "handoff");
		const onStage = (stage: string) => state.advanceHandoffAttempt(claim.attemptId, stage);
		const names = nameKnowledgeFor(ticket.identity);
		const run =
			origin === "open"
				? handOffTicket(ticket, choice, {
						config: configRef.current,
						runner: commandRunner,
						home: homeDir,
						onStage,
						names,
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
						names,
					});
		void run
			.then(async (outcome) => {
				if (outcome.collision !== undefined)
					recordNameCollision(ticket.identity, outcome.collision);
				if (outcome.ownCollision !== undefined)
					recordNameCollision(ticket.identity, outcome.ownCollision);
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
								agentName: outcome.agent.name,
							},
				);
				// The route's own decision is not taken here: whoever asked for
				// the route hears the start below and records what its start
				// means for the turn it came from.
				replaceTickets();
				await finishOutcome(outcome);
				reportStarted(
					outcome.status === "failed" ? { ok: false, reason: outcome.reason } : { ok: true },
				);
				inFlightRef.current = false;
				drainCleanupQueue();
			})
			.catch((error) => {
				state.settleHandoff(claim.attemptId, false, errorMessage(error));
				replaceTickets();
				setErrorMessage(`handoff failed: ${errorMessage(error)}`);
				reportStarted({ ok: false, reason: errorMessage(error) });
				inFlightRef.current = false;
				drainCleanupQueue();
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
	 * A leftover clear holds the seat too, so a queued handoff never
	 * starts in a workspace herdr is in the middle of taking away.
	 */
	const drainQueue = (): void => {
		if (state === undefined) return;
		while (queueRef.current.length > 0 && !seatHeld()) {
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
				// The route the claim was for never started: the caller decides
				// nothing on the turn it came from.
				next.onStarted?.({ ok: false, reason: "the queued handoff was not run" });
				continue;
			}
			// The fresh projection when the ticket is visible, else the claim's
			// snapshot: the handoff runs on the ticket it claimed.
			const snapshot =
				state
					.visibleTickets(configRef.current.taskRules, configRef.current.defaultTaskType)
					.find((candidate) => candidate.identity === next.ticket.identity) ?? next.ticket;
			runClaimedHandoff(
				snapshot,
				next.choice,
				next.origin,
				next.claim,
				next.previousMessage,
				next.onStarted,
			);
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
		runClaimedHandoff(
			ticket,
			intent.choice,
			intent.origin,
			claim.claim,
			intent.previousMessage,
			intent.onStarted,
		);
		return Promise.resolve({ ok: true });
	};
	const runIntentRef = useRef(runIntent);
	runIntentRef.current = runIntent;
	// The observation loop outlives the render that built it, so its Close
	// cleanup runs through this ref: the coordinator never holds a stale seat.
	const runCleanupRef = useRef(runCleanupWithSeat);
	runCleanupRef.current = runCleanupWithSeat;
	const startHandoff = (ticket: Ticket, choice: HandoffChoice) => {
		const availability = availabilityFor(
			controlById("handoff"),
			controlContextFor(currentBaseMode()),
		);
		if (!availability.available) {
			setWarningMessage(
				refusalReason(controlById("handoff"), controlContextFor(currentBaseMode())),
			);
			return;
		}
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
		setWorkingMessage(`handing off "${ticket.title}"...`, "handoff");
		void handOffTicket(ticket, choice, { config, runner: commandRunner, home: homeDir })
			.then(async (outcome) => {
				if (outcome.status !== "failed") {
					const handoff: Handoff = {
						agentType: choice.agentType,
						environment: choice.environment,
						taskType: choice.taskType,
						model: choice.model,
						thinking: choice.thinking,
						contextWindow: choice.contextWindow,
						attemptId: "manual",
						paneId: outcome.agent.paneId,
						tabId: outcome.agent.tabId,
						workspaceId: outcome.agent.workspaceId,
					};
					setTickets((all) => {
						const next = all.map((candidate) =>
							candidate.identity === ticket.identity
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
		const overrideControl = controlById("override");
		const availability = availabilityFor(overrideControl, controlContextFor(currentBaseMode()));
		if (!availability.available) {
			setWarningMessage(refusalText(overrideControl, availability));
			return;
		}
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket === undefined) return;
		const choice = choiceFor(ticket);
		// Opening the panel is a point of use for the Model list (ADR 0010): the
		// list of the agent the panel starts on is fetched fresh, so provider
		// auth the operator changed after startup shows up here.
		requestModelList(choice.agentType);
		setOverride({
			ticketIdentity: ticket.identity,
			origin: "open",
			choice,
		});
	};

	/**
	 * Start the handoff the override panel confirmed.
	 *
	 * The claim happens here, not when the panel opened: an operator who
	 * presses Esc leaves the ticket exactly where it was, with no attempt
	 * recorded.
	 */
	const confirmOverride = (choice: HandoffChoice) => {
		const pending = overrideRef.current;
		setOverride(null);
		if (pending === null) return;
		const ticket = ticketsRef.current.find(
			(candidate) => candidate.identity === pending.ticketIdentity,
		);
		if (ticket === undefined) {
			setWarningMessage("the ticket no longer exists");
			return;
		}
		if (pending.origin === "workflow") {
			// A route confirmed from the Live view keeps the screen open, like
			// the direct route: the stream moves to the new pane on the next
			// tick. A refused claim comes back to the decision sub-mode, where
			// the route row still stands.
			if (pending.from === "live") {
				setPanel({ kind: "live", identity: pending.ticketIdentity });
			}
			runRouteHandoff(ticket, choice);
			return;
		}
		startHandoff(ticket, choice);
	};

	/**
	 * Leave the override panel with no handoff.
	 *
	 * A route edit returns to the panel it opened from - the decision modal
	 * or the Live view's decision sub-mode: only the edit is dropped, the
	 * turn is still undecided. An open-ticket edit returns to the list, where
	 * it started.
	 */
	const cancelOverride = () => {
		const pending = overrideRef.current;
		setOverride(null);
		if (pending?.origin === "workflow") {
			setPanel({ kind: pending.from, identity: pending.ticketIdentity });
		}
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

	/** The task type of the ticket's current turn: the settled turn's, else the handoff's, else the ticket's suggestion. */
	const taskTypeOf = (ticket: Ticket): string =>
		ticket.lastCompletion?.taskType ?? ticket.handoff?.taskType ?? ticket.suggestedTaskType;

	/** The Live view's context line: repository, task type, agent. No time: the turn has not settled. */
	const liveContextLine = (ticket: Ticket): string =>
		[ticket.repository, taskTypeOf(ticket), ticket.handoff?.agentType ?? "?"]
			.filter((part) => part !== "")
			.join(" · ");

	// The decision modal's rows: Close first, selected by default, then a
	// Goto, then one handoff row per outgoing workflow edge the completed
	// task type has, in config order: every edge stays reachable, and an
	// edge naming several targets offers one row per target. Two edges to
	// the same target offer two rows, and a row's detail names the Agent its
	// route resolves to, beside the edge's Environment pin. Two rows that
	// read the same start the same handoff: an edge that pins the Agent the
	// target's own Task profile names has nothing beside it to show. The
	// modal's context row names the repository, the task type, the agent,
	// and the completion time, so the operator knows what the log is about.
	const decisionFor = (
		ticket: Ticket,
	): {
		actions: ActionRow[];
		entries: readonly TurnLogEntry[];
		contextLine: string;
	} => {
		const taskType = taskTypeOf(ticket);
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
					editable: true,
				});
			}
		});
		return {
			actions,
			entries: completion?.turnLog ?? [],
			contextLine,
		};
	};

	/** The workflow row states the Agent that will receive its handoff. */
	const routeDetail = (edge: WorkflowEdge, target: string): string => {
		const choice = resolveHandoffChoice(configRef.current, target, edge);
		const detail = [`agent ${choice.agentType}`];
		if (edge.environment !== undefined) detail.push(`environment ${edge.environment}`);
		return detail.join(", ");
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
			// The Live view closes on a Goto, so the confirmation stands on the
			// Message line. The trace does not record a Goto, and a Handoff or
			// refresh still running stands alone.
			setNoticeMessage(`focused the agent of ticket ${ticket.identity}`);
		});
	};
	// Run a decision-panel action: close (with the Close cleanup), Goto, a
	// workflow handoff, or (from the missing modal) restart and abandon.
	const runDecisionAction = (ticket: Ticket, key: string) => {
		// A routed handoff from the Live view keeps the screen open: the
		// stream resumes for the new agent pane on its next tick.
		if (!(panel?.kind === "live" && key.startsWith("route:"))) setPanel(null);
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
			if (stored !== null) runCloseCleanup(ticket.identity, stored, "closed");
			// The Close action writes no progress line of its own.
			clearOperationMessage("none");
			return;
		}
		if (key === "goto") {
			runGoto(ticket);
			return;
		}
		const choice = routeChoiceOf(ticket, key);
		if (choice === null) return;
		runRouteHandoff(ticket, choice);
	};

	/**
	 * The choice a `route:<edge index>:<target>` row resolves to.
	 *
	 * The edge is re-read from the config, so a runtime config change cannot
	 * point the action at a moved or removed edge. A stale row reports on the
	 * status line and comes back null.
	 */
	const routeChoiceOf = (ticket: Ticket, key: string): HandoffChoice | null => {
		const rest = key.slice("route:".length);
		const separator = rest.indexOf(":");
		const edge = configRef.current.workflows[Number(rest.slice(0, separator))];
		const target = rest.slice(separator + 1);
		const taskType = taskTypeOf(ticket);
		if (edge === undefined || edge.from !== taskType || !edge.to.includes(target)) {
			setWarningMessage(`no workflow edge from ${taskType} to ${target}`);
			return null;
		}
		// A Workflow Handoff resolves a fresh target profile and never
		// inherits the previous handoff's choice.
		return resolveHandoffChoice(configRef.current, target, edge);
	};

	/** Start a workflow handoff with a resolved or overridden choice. */
	const runRouteHandoff = (ticket: Ticket, choice: HandoffChoice) => {
		if (state === undefined) return;
		// Claim first: a refused claim leaves the ticket where it was. The
		// turn's decision is not recorded here: it lands when the routed
		// handoff starts, on the settled turn's trace, and a route that never
		// started leaves the trace pending, so Close and Goto keep working.
		const claim = state.claimHandoff(ticket.identity, choice, "workflow");
		if (!claim.ok) {
			setWarningMessage(claim.reason);
			return;
		}
		const previousHandoffId = ticket.handoff?.attemptId ?? "";
		runClaimedHandoff(
			ticket,
			choice,
			"workflow",
			claim.claim,
			ticket.lastCompletion?.message ?? "",
			// The routed handoff started: the operator's decision on the turn
			// it routes from is `handed-off`, and the ticket reads as
			// handed-off where the agent is.
			(started) => {
				if (!started.ok || previousHandoffId === "") return;
				state.applyCompletionDecision({
					ticketIdentity: ticket.identity,
					handoffId: previousHandoffId,
					decision: "handed-off",
					decidedAt: new Date().toISOString(),
				});
				replaceTickets();
			},
		);
	};

	/**
	 * The `e` key on a decision row: edit that route's resolved settings
	 * before it starts, so the operator's override outranks the edge pin,
	 * the target Task profile, and the config defaults.
	 */
	const openRouteOverride = (ticket: Ticket, key: string) => {
		if (inFlightRef.current) {
			setWarningMessage("handoff in flight");
			return;
		}
		const choice = routeChoiceOf(ticket, key);
		if (choice === null) return;
		// The panel opens on this choice's agent: fetch its Model list (ADR 0010).
		requestModelList(choice.agentType);
		// The panel the route row was on is where an Esc and a confirmed route
		// return: the decision modal, or the Live view's decision sub-mode.
		const from = panel?.kind === "live" ? ("live" as const) : ("decision" as const);
		setPanel(null);
		setOverride({
			ticketIdentity: ticket.identity,
			origin: "workflow",
			from,
			choice,
		});
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
			contextWindow: type.contextWindow,
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
		// A restart from the Live view's Missing mode keeps the screen open:
		// it returns to the stream when the restarted agent is back.
		if (!(panel?.kind === "live" && key === "restart")) setPanel(null);
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
			if (stored !== null) runCloseCleanup(ticket.identity, stored, "abandoned");
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
						stored.contextWindow,
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
			selectedTicket: ticketsRef.current[selectedIndexRef.current],
			listCanMove: ticketsRef.current.length > 1,
			detailCanScroll: detailMaxScroll > 0,
			sourceCount: sources.length,
			refreshingSourceCount: sources.filter(
				(source) => coordinatorRef.current?.isFetching(source.name) === true,
			).length,
			handoffActive: inFlightRef.current,
			messageTruncated,
			consultationTypesConfigured: Object.keys(config.consultationTypes).length > 0,
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
	/**
	 * Refresh now, from the `r` control.
	 *
	 * The dispatcher already gated the control, so this runs the behavior and
	 * nothing else: one check, one reason. The names it starts are held so a
	 * source that fails this round can still explain itself once the refresh
	 * fact clears.
	 */
	const refreshNow = () => {
		const coordinator = coordinatorRef.current;
		if (coordinator === undefined) return;
		const started = coordinator.refreshAll();
		manualRefreshPending.current = new Set(started);
		setWorkingMessage(`refreshing ${started.length} sources`, "refresh");
	};
	useKeyboard((key) => {
		// Overlays own their keys: the launcher, the utility views, the
		// override panel, and the action modals all handle input in their
		// own keyboard hooks.
		if (utility !== null || override !== null || panel !== null || launcher) {
			// The legacy Consultations surfaces keep their pre-catalogue key
			// switches, and none of them may claim the emergency exit. The
			// catalogue-driven surfaces destroy through that same control
			// anyway; the shell owns the exit for the rest.
			if (key.ctrl === true && key.name === "c") renderer.destroy();
			return;
		}
		// The legacy Consultations input paths (the view's key switch, the
		// response editor, the Agent interaction mode) match keys by name.
		// The shell owns the emergency exit before any of those matches, so
		// Ctrl+C cannot open the launcher or reach an Agent. The base tickets
		// panes dispatch Ctrl+C through the control catalogue below.
		if (
			(interaction || responseEditor || viewRef.current === "consultations") &&
			key.ctrl === true &&
			key.name === "c"
		) {
			renderer.destroy();
			return;
		}
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
		// The consultations view keeps its pre-catalogue key switch until
		// it is ported to the control catalogue.
		if (viewRef.current === "consultations") {
			switch (key.name) {
				case "q":
					renderer.destroy();
					break;
				case "?":
					setUtility({ kind: "consultation", utility: "guide" });
					break;
				case "m":
					if (status !== null) setUtility({ kind: "consultation", utility: "message" });
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
						if (
							selectedConsultation.state === "opening" ||
							selectedConsultation.state === "working"
						)
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
			return;
		}
		// The control catalogue decides the rest, through the same dispatch
		// hook every modal, panel, and overlay uses. The Consultation paths
		// above still match keys by name until the port recorded on the
		// Consultations issue lands.
		const mode = currentBaseMode();
		createControlDispatch({
			mode,
			context: controlContextFor(mode),
			ungated: ["decide-completion", "handoff", "live-view"],
			onUnavailable: setWarningMessage,
			onEmergencyExit: () => renderer.destroy(),
			handlers: {
				// A settled Ticket uses the distinct Decide control. It names
				// what Enter does instead of leaving a dimmed Hand off hint
				// that still opens a panel.
				"decide-completion": ({ context }) => decideCompletion(context),
				// An open Ticket is the only one a Hand off starts, and it can
				// queue behind nothing: the control stays ungated so a Ticket
				// with no other Enter meaning still gets the catalogue's own
				// refusal.
				handoff: ({ context, refuse }) => {
					const ticket = context.selectedTicket;
					if (ticket === undefined || !isInFlight(ticket)) {
						if (ticket === undefined) refuse();
						else startHandoff(ticket, choiceFor(ticket));
						return;
					}
					// An in-flight Ticket answers to the Live view control,
					// which resolves ahead of this one while it is available.
					refuse();
				},
				// Enter on an in-flight ticket opens the Live view, the
				// ticket's own screen, which streams the agent's output and
				// offers the Goto. A missing agent keeps its own recovery
				// screen: the restart or the abandon, and nothing else.
				"live-view": ({ context, refuse }) => {
					const ticket = context.selectedTicket;
					if (ticket === undefined || !isInFlight(ticket)) return refuse();
					if (markerOf(ticket) === "missing")
						setPanel({ kind: "missing", identity: ticket.identity });
					else setPanel({ kind: "live", identity: ticket.identity });
				},
				quit: () => renderer.destroy(),
				detail: () => focusPane("detail"),
				tickets: () => focusPane("list"),
				"move-list": ({ key }) => moveRange(key.name),
				"scroll-detail": ({ key }) => moveRange(key.name),
				consultations: openConsultations,
				launch: () => setLauncher(true),
				override: openOverride,
				refresh: refreshNow,
				leftover: openLeftoverPanel,
				"auto-handoff": () => {
					if (!openAttention()) toggleAutoHandoff();
				},
				help: () => openGuide(mode),
				message: () => openMessage(mode),
			},
		})(key);
	});
	/** The list and detail panes answer the same range of keys by name. */
	const moveRange = (name: string) => {
		if (name === "pageup") movePage(-1);
		else if (name === "pagedown") movePage(1);
		else if (name === "home") moveEdge("start");
		else if (name === "end") moveEdge("end");
		else moveVertical(name === "up" || name === "k" ? -1 : 1);
	};
	/** Whether a Ticket holds an Agent that is not finished with its work. */
	const isInFlight = (ticket: Ticket) =>
		ticket.state === "handed-off" || ticket.state === "running";
	/**
	 * Enter on a settled Ticket: decide its completion, or tell the operator
	 * why the factory decides it alone.
	 */
	const decideCompletion = (context: ControlContext) => {
		const ticket = context.selectedTicket;
		if (ticket === undefined) return;
		const taskType =
			ticket.lastCompletion?.taskType ?? ticket.handoff?.taskType ?? ticket.suggestedTaskType;
		if (autoModeRef.current) {
			// The factory decides the ticket itself: the operator gets the
			// notice on the Message line, and the observation makes the
			// decision in the background. A notice is not progress, so it holds
			// its own slot and the next fact takes the line back.
			setNoticeMessage("auto-handoff is on: the factory decides this ticket");
			return;
		}
		if (configRef.current.taskTypes[taskType]?.autoClose === true) {
			setNoticeMessage(`task type ${taskType} is auto-close: the factory decides this ticket`);
			observationRef.current?.tick();
		} else setPanel({ kind: "decision", identity: ticket.identity });
	};
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
		const coordinator = new RefreshCoordinator(
			sources,
			state,
			() => {
				replaceTickets();
				replaceConsultations();
				// A fetch may have made a ticket actionable: let the observation
				// loop act on it now instead of on the next poll.
				observationRef.current?.tick();
			},
			undefined,
			{
				settled: (sourceName) => {
					if (!manualRefreshPending.current.has(sourceName)) return;
					manualRefreshPending.current.delete(sourceName);
					if (manualRefreshPending.current.size === 0) clearWorkingMessage("refresh");
				},
			},
		);
		coordinatorRef.current = coordinator;
		coordinator.start();
		return () => {
			coordinator.stop();
			coordinatorRef.current = undefined;
		};
	}, [state, sources, replaceTickets, replaceConsultations, clearWorkingMessage]);
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
			// handoff the decision ends. A cleanup that cannot remove the
			// checkout leaves a leftover the ticket carries as a fact, so the
			// operator sees it and has one action to end it (ADR 0012).
			cleanup: (handoff) =>
				runCleanupRef.current(state, {
					ticketIdentity: handoff.ticketIdentity,
					handoffId: handoff.handoffAttemptId,
					environment: handoff.environment,
					tabId: handoff.tabId,
					workspaceId: handoff.workspaceId,
				}),
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
			onStatus: (kind, text, topic) => {
				// Both views read observation events: the consultations view keeps
				// its status line, and the tickets view keeps the durable Message
				// facts. Other informational events stay out of the Message line:
				// it is for active work and operational facts, not a log.
				setStatus({ kind, text });
				if (kind === "error") setErrorMessage(text);
				else if (kind === "warning") setWarningMessage(text);
				// The recovery topic is the structured signal that a stale
				// operation fact can clear; the text stays human-facing. The
				// observation writes no progress line of its own.
				else if (topic === "herdr-recovered") clearOperationMessage("none");
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
		replaceConsultations,
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
	// The ticket panels are the closed set: the decision on a settled turn, the
	// live view over an in-flight agent, the missing-agent choice, and the
	// leftover environment. Everything that reads an open panel goes through
	// this list, so a new consultation kind can never be taken for a ticket
	// panel by falling through the exclusions.
	const ticketPanel =
		panel !== null &&
		(panel.kind === "decision" ||
			panel.kind === "live" ||
			panel.kind === "missing" ||
			panel.kind === "leftover")
			? panel
			: null;
	const panelTicket =
		ticketPanel === null
			? undefined
			: ticketsRef.current.find((ticket) => ticket.identity === ticketPanel.identity);
	const panelConsultation =
		panel !== null && ticketPanel === null
			? consultationsRef.current.find((item) => item.id === panel.identity)
			: undefined;
	const decision =
		panel !== null && panel.kind === "decision" && panelTicket !== undefined
			? decisionFor(panelTicket)
			: undefined;
	// The mode the open Live panel shows, re-derived from the ticket's current
	// facts on every render, so the screen follows the ticket without the
	// operator asking: the stream while the agent works (a settled turn the
	// factory decides for itself keeps streaming), the decision body when
	// the factory waits for the operator, the missing box when the pane is
	// gone, and closed when the ticket leaves the in-flight states.
	const liveMode: "stream" | "decision" | "missing" | "closed" =
		panel?.kind === "live" && panelTicket !== undefined
			? panelTicket.state === "open"
				? "closed"
				: panelTicket.state === "awaiting"
					? autoMode || configRef.current.taskTypes[taskTypeOf(panelTicket)]?.autoClose === true
						? "stream"
						: "decision"
					: markerOf(panelTicket) === "missing"
						? "missing"
						: "stream"
			: "closed";
	const liveDecision =
		panelTicket !== undefined && liveMode === "decision" ? decisionFor(panelTicket) : undefined;
	/**
	 * Whether the open ticket panel has nothing left to show.
	 *
	 * Each ticket panel kind says which fact of the ticket it is drawn from,
	 * and that fact is what can run out from under the modal: the decision the
	 * observation takes, the leftover environment a clear or a Close cleanup
	 * ends, the ticket that leaves the projection. A panel that is not drawn
	 * must not keep holding the keys the ticket panels swallow.
	 */
	const panelHasNothingToShow =
		ticketPanel !== null &&
		(panelTicket === undefined ||
			(ticketPanel.kind === "decision" && decision === undefined) ||
			(ticketPanel.kind === "live" && liveMode === "closed") ||
			(ticketPanel.kind === "leftover" && panelTicket.leftover === null));
	useEffect(() => {
		if (panelHasNothingToShow) setPanel(null);
	}, [panelHasNothingToShow]);

	// The Live view's stream: while the view shows the stream, a dedicated
	// refresh reads the pane the ticket's current handoff records at the
	// one-second cadence, the cadence the Consultation agent view uses
	// outside of interaction. A routed handoff moves the stream to the new
	// pane on its next tick. A failed read stands the last lines under a
	// stale note, and the refresh continues.
	useEffect(() => {
		if (panel?.kind !== "live" || liveMode !== "stream") {
			setLiveStream(null);
			return;
		}
		const identity = panel.identity;
		let active = true;
		const reader = new HerdrAgentReader(commandRunner);
		const refresh = async () => {
			// Re-read the pane the ticket's current handoff records, so a
			// routed handoff moves the stream to the new pane on the next
			// tick.
			const ticket = ticketsRef.current.find((item) => item.identity === identity);
			const paneId = ticket?.handoff?.paneId ?? null;
			if (paneId === null) {
				if (active)
					setLiveStream({
						lines: [],
						note: "no agent pane is recorded for this ticket",
					});
				return;
			}
			const output = await reader.readPane(paneId, configRef.current.completionMessageLines);
			if (!active) return;
			if (output === null) {
				setLiveStream((previous) => ({
					lines: previous?.lines ?? [],
					note: STALE_STREAM_NOTE,
				}));
			} else {
				setLiveStream({ lines: output.split("\n"), note: null });
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 1000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [panel, liveMode, commandRunner]);
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
	const actionMode = currentBaseMode();
	const ticketContext = controlContextFor(actionMode);
	const messageColor = colorOfMessage(visibleMessage);
	const statusColor =
		status?.kind === "error"
			? COLORS.statusError
			: status?.kind === "warning"
				? COLORS.statusWarning
				: COLORS.text;
	const importantSmallMessage =
		visibleMessage !== null &&
		(visibleMessage.severity === "error" || visibleMessage.severity === "working")
			? visibleMessageText
			: undefined;
	// The size message first, then an important operation's line, capped to the
	// rows the size box actually holds.
	const compactLines = (
		importantSmallMessage === undefined
			? [{ text: TOO_SMALL_TEXT, fg: COLORS.statusWarning }]
			: [
					{ text: TOO_SMALL_TEXT, fg: COLORS.statusWarning },
					{ text: importantSmallMessage, fg: messageColor },
				]
	).slice(0, compactLineCount);
	const utilityContext =
		utility?.kind === "guide" || utility?.kind === "message"
			? controlContextFor(utility.mode)
			: ticketContext;
	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "column" } },
		view === "tickets" &&
			showModeLine &&
			createElement(
				"text",
				{ style: { width: "100%", height: 1, fg: COLORS.dim } },
				padToWidth(truncateToWidth(modeLine, terminalWidth), terminalWidth),
			),
		view === "tickets" && tooSmall
			? createElement(
					"box",
					// The bottom rows are the frame's promise: the Message line and
					// the Action bar with its Help control, at any height (user
					// stories 71 and 73). The size box pays for them first with its
					// padding, then with its own rows, and it is given no more lines
					// than it holds, so nothing can paint through the bar's row.
					{
						style: {
							width: "100%",
							height: compactRows,
							flexGrow: 0,
							flexShrink: 1,
							flexDirection: "column",
							overflow: "hidden",
							padding: compactPadding,
						},
					},
					...compactLines.map((line) =>
						createElement(
							"text",
							{
								key: line.text,
								fg: line.fg,
								// A row of a fixed box states its own height: a
								// child with none is laid out over the rows that
								// the frame has promised to the Message line and
								// the Action bar.
								style: { width: "100%", height: 1 },
							},
							padToWidth(truncateToWidth(line.text, compactTextWidth), compactTextWidth),
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
					view === "tickets"
						? createElement(TicketList, {
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
								active: override === null && panel === null && utility === null,
								reservedRows,
								handoffLimit: config.maxHandoffsPerTicket,
								suggestedChoice:
									selectedTicket?.state === "open" ? choiceFor(selectedTicket) : undefined,
								scroll: config.scroll,
								onFocus: () => focusPane("detail"),
								scrollSlot: detailScrollSlot,
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
		view === "consultations" &&
			healthLine !== "" &&
			createElement(
				"text",
				{ style: { width: "100%", fg: COLORS.statusWarning } },
				truncateToWidth(healthLine, terminalWidth),
			),
		view === "consultations" &&
			modeLine !== "" &&
			createElement(
				"text",
				{ style: { width: "100%", fg: COLORS.dim } },
				truncateToWidth(modeLine, terminalWidth),
			),
		view === "consultations" &&
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
		view === "consultations" &&
			status !== null &&
			createElement(
				"text",
				{ style: { width: "100%", fg: statusColor } },
				truncateToWidth(`${status.kind}: ${status.text}`, terminalWidth),
			),
		// showAttentionLine, not attentionLine !== "": below the minimum size
		// the compact frame keeps exactly its reserved rows, and a
		// Consultation that needs the operator still shows in the
		// consultations view and in the launcher's ring.
		view === "tickets" &&
			showAttentionLine &&
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
		view === "tickets" && terminalHeight >= 2 && messageRowElement(visibleMessage, terminalWidth),
		view === "tickets" &&
			createElement(ActionBar, {
				mode: actionMode,
				context: ticketContext,
				width: terminalWidth,
				compactAnchor: tooSmall,
			}),
		override !== null &&
			createElement(OverridePanel, {
				agents: Object.keys(config.agents),
				environments: HANDOFF_ENVIRONMENT_KINDS,
				taskTypes: Object.keys(config.taskTypes),
				agentSettings,
				profiles,
				modelList,
				onAgentChange: requestModelList,
				initial: override.choice,
				context: ticketContext,
				inputActive: utility === null,
				onHelp: (mode) => openGuide(mode),
				onMessage: (mode) => openMessage(mode),
				onUnavailable: setWarningMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
				onConfirm: confirmOverride,
				onCancel: cancelOverride,
			}),
		// Each ticket panel kind renders its own modal: a leftover panel is neither
		// a decision nor a missing-agent choice, and must not fall through to one.
		panel !== null &&
			panelTicket !== undefined &&
			panel.kind === "decision" &&
			decision !== undefined &&
			createElement(DecisionModal, {
				title: panelTicket.title,
				contextLine: decision.contextLine,
				entries: decision.entries,
				actions: decision.actions,
				onAction: (key) => runDecisionAction(panelTicket, key),
				onEditAction: (key) => openRouteOverride(panelTicket, key),
				onCancel: () => setPanel(null),
				context: ticketContext,
				inputActive: utility === null,
				onHelp: () => openGuide("decision-modal"),
				onMessage: () => openMessage("decision-modal"),
				onUnavailable: setWarningMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		// The Live view streams the agent's terminal while the ticket is in
		// flight. When the turn settles and the factory waits for the
		// operator, the same box carries the decision sub-mode: the turn
		// log, the decision's rows, and their keys.
		panel !== null &&
			panel.kind === "live" &&
			panelTicket !== undefined &&
			liveMode !== "closed" &&
			liveMode !== "missing" &&
			createElement(LiveView, {
				title: panelTicket.title,
				contextLine: liveContextLine(panelTicket),
				blocked: markerOf(panelTicket) === "blocked",
				body:
					liveDecision !== undefined
						? { kind: "turn-log" as const, entries: liveDecision.entries }
						: liveStream === null
							? { kind: "stream" as const, lines: [], note: null }
							: { kind: "stream" as const, lines: liveStream.lines, note: liveStream.note },
				actions:
					liveDecision !== undefined
						? liveDecision.actions
						: [
								{
									key: "goto",
									label: "Goto",
									detail: "focus the agent's pane; the handoff stays open",
								},
							],
				decideable: liveDecision !== undefined,
				onAction: (key) => runDecisionAction(panelTicket, key),
				onEditAction: (key) => openRouteOverride(panelTicket, key),
				onCancel: () => setPanel(null),
			}),
		panel !== null &&
			panelTicket !== undefined &&
			(panel.kind === "missing" || liveMode === "missing") &&
			createElement(MissingModal, {
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
				context: ticketContext,
				inputActive: utility === null,
				onHelp: () => openGuide("missing-modal"),
				onMessage: () => openMessage("missing-modal"),
				onUnavailable: setWarningMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		panel !== null &&
			panel.kind === "leftover" &&
			panelTicket !== undefined &&
			panelTicket.leftover !== null &&
			createLeftoverPanel(panelTicket),
		panel !== null &&
			panel.kind === "consultation-safety" &&
			panelConsultation !== undefined &&
			consultationSafety?.consultationId === panelConsultation.id &&
			createElement(ActionPanel, {
				message: visibleMessage,
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
				message: visibleMessage,
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
				message: visibleMessage,
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
				message: visibleMessage,
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
		utility?.kind === "guide" &&
			createElement(KeyGuide, {
				message: visibleMessage,
				context: utilityContext,
				onClose: () => setUtility(null),
				onMessage: () => openMessage(utilityContext.mode),
				onEmergencyExit: () => renderer.destroy(),
			}),
		utility?.kind === "message" &&
			createElement(MessageView, {
				message: visibleMessage,
				fact: utility.fact,
				context: utilityContext,
				onClose: () => setUtility(null),
				onHelp: () => openGuide(utilityContext.mode),
				onEmergencyExit: () => renderer.destroy(),
			}),
		utility?.kind === "consultation" &&
			createElement(ActionGuide, {
				context: actionContext,
				utility: utility.utility,
				onClose: () => setUtility(null),
				onMessage: () => setUtility({ kind: "consultation", utility: "message" }),
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

/**
 * The handle a clear would end that the ticket's own live agent runs on.
 *
 * A cleanup reaches the environment its row names: a worktree removal closes a
 * whole workspace with every agent in it, and a tab close ends the tab and the
 * panes inside it. So a worktree leftover is refused when it names the live
 * agent's workspace, and any leftover is refused when it names the live
 * agent's own tab or pane - the shape a reclaimed agent leaves behind, where
 * the closed handoff and the running one name the same handles (ADR 0011).
 * The answer carries the word the operator uses for what was refused.
 */
function liveHandleAtRisk(
	leftovers: readonly LeftoverEnvironment[],
	live: { paneId: string | null; tabId: string | null; workspaceId: string | null },
): { text: string; what: string } | null {
	for (const leftover of leftovers) {
		if (
			leftover.environment === "worktree" &&
			live.workspaceId !== null &&
			leftover.workspaceId === live.workspaceId
		)
			return { text: `herdr workspace ${live.workspaceId}`, what: "workspace" };
		if (live.tabId !== null && leftover.tabId === live.tabId)
			return { text: `herdr tab ${live.tabId}`, what: "tab" };
		if (live.paneId !== null && leftover.paneId === live.paneId)
			return { text: `herdr pane ${live.paneId}`, what: "pane" };
	}
	return null;
}

/**
 * The Close cleanup of one handoff, with its durable outcome.
 *
 * A cleanup that fails leaves the herdr environment alive: the workspace, its
 * pane, and the agent in it. That is a fact on the ticket, not only a message
 * line that fades. A cleanup that succeeds clears the leftovers it reached:
 * the whole workspace it closed, the single tab it closed, or - when it ran no
 * command at all - only the fact of its own handoff (ADR 0012).
 *
 * Every path that runs the cleanup goes through here: the operator's Close, an
 * Abandon, the automatic close in the observation loop, and the clear action's
 * retry, so the record and the clear cannot drift apart. `force` reaches herdr
 * only when the operator chose that row.
 *
 * Returns herdr's readable failure, or undefined when the environment is gone.
 * A cleanup that could not run at all is a failure to record too, so a caller
 * that only reports the answer never has to guard a throw of its own.
 */
async function settleCloseCleanup(
	state: FactoryState,
	runner: CommandRunner,
	handoff: {
		ticketIdentity: string;
		handoffId: string;
		environment: EnvironmentKind;
		tabId: string | null;
		workspaceId: string | null;
	},
	options: CloseCleanupOptions = {},
): Promise<string | undefined> {
	try {
		const failure = await closeHandoffEnvironment(
			{
				environment: handoff.environment,
				tabId: handoff.tabId,
				workspaceId: handoff.workspaceId,
			},
			runner,
			options,
		);
		if (failure === undefined) {
			// The cleanup reached as far as herdr let it: the whole workspace it
			// closed, the one tab it closed, or nothing at all. Facts outside
			// that reach stand, so a row whose cleanup ran no command cannot
			// resolve the fact of another row whose environment is still alive.
			const reach = closeCleanupReach(handoff);
			state.clearLeftoverEnvironments(
				handoff.ticketIdentity,
				reach.scope === "workspace"
					? { workspaceId: reach.workspaceId }
					: reach.scope === "tab"
						? { tabId: reach.tabId }
						: { handoffId: handoff.handoffId },
			);
			return undefined;
		}
		state.recordLeftoverEnvironment({
			ticketIdentity: handoff.ticketIdentity,
			handoffId: handoff.handoffId,
			reason: failure,
		});
		return failure;
	} catch (error) {
		// The cleanup never reached an answer: the environment still stands,
		// and the ticket still carries the fact of it.
		const reason = `the close cleanup did not run: ${errorMessage(error)}`;
		state.recordLeftoverEnvironment({
			ticketIdentity: handoff.ticketIdentity,
			handoffId: handoff.handoffId,
			reason,
		});
		return reason;
	}
}
