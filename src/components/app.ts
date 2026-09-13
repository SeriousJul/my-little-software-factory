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
 * `a` toggles auto-handoff in the Ticket section. `v` expands the Consultation
 * section on the Consultation that needs the operator, if one does.
 *
 * The Main view is one surface with two accordion sections (ADR 0013): the
 * expanded section owns the pane rows, the collapsed one shrinks to its header
 * row, and one Message line, one Action bar, and one control catalog answer
 * for both.
 */
import os from "node:os";
import { createElement, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
	DEFAULT_CONFIG,
	defaultConfigPath,
	type FactoryConfig,
	persistConfig,
	type WorkflowEdge,
} from "../config.ts";
import {
	type ConsultationRepositoryOption,
	consultationRepositoryCatalog,
	type LiveCheckoutSafety,
	translateAgentKey,
	validateConsultationRepositoryOptions,
	validateResponseInput,
} from "../consultation.ts";
import {
	type ConsultationOperations,
	createConsultationOperations,
} from "../consultation-operations.ts";
import {
	HANDOFF_ENVIRONMENT_KINDS,
	type Handoff,
	isHeldCompletion,
	type Ticket,
} from "../domain/ticket.ts";
import {
	baseChoice,
	type HandoffChoice,
	type HandoffOutcome,
	handOffTicket,
	resolveHandoffChoice,
} from "../handoff.ts";
import {
	createHandoffDispatch,
	type HandoffDispatch,
	reportHandoffOutcome,
	type StoredHandoffFacts,
} from "../handoff-dispatch.ts";
import {
	type HerdrAgent,
	HerdrAgentReader,
	normalizeAgentStatus,
	ObservationCoordinator,
} from "../observation.ts";
import { RefreshCoordinator } from "../refresh.ts";
import type { RepositoryMapping } from "../repo.ts";
import {
	type CommandRunner,
	commandFailureText,
	createChildProcessRunner,
	errorMessage,
	supportsModelList,
} from "../runner.ts";
import { type TaskProfileStart, taskProfilesOf } from "../setting-resolution.ts";
import type { Consultation, FactoryState } from "../state.ts";
import type { TicketSource } from "../ticket-source.ts";
import type { TurnEndCause, TurnLogEntry } from "../turn-log.ts";
import { ActionBar } from "./action-bar.ts";
import { ActionPanel, panelBodyCols } from "./action-panel.ts";
import { renderAnsiScreen } from "./ansi-screen.ts";
import { ConsultationDetail, consultationDetailLines } from "./consultation-detail.ts";
import { ConsultationLauncher, type LauncherDraft } from "./consultation-launcher.ts";
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
import { consultationProgressOwner, useMessageFacts } from "./message-facts.ts";
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
import { RESPONSE_EDITOR_ROWS, ResponseEditor } from "./response-editor.ts";
import { type MainSection, SectionHeader } from "./section-header.ts";
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
 * Below this width the Consultation list hides and the detail keeps focus: a
 * two-pane section this narrow cannot hold both panes, so the pane switch and
 * the list keys that walk it stay unavailable.
 */
const CONSULTATION_PANES_MIN_WIDTH = 80;

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
 * another. Every surface of the Main view opens the catalog's own Key guide
 * and Message view, captured from the mode the operator pressed the key in.
 */
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

// The workspace the control plane runs in, when it runs inside a herdr pane.
// A close cleanup that removes a workspace returns herdr's focus here,
// because the operator worked the close from the control plane and herdr
// moves the focus when a workspace disappears. Outside herdr the id is null
// and herdr's own choice stands.
const CONTROL_PLANE_WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID ?? null;

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
	const [section, setSection] = useState<MainSection>("tickets");
	const sectionRef = useRef<MainSection>("tickets");
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
	// The launcher's unfinished form, kept for this application run only. A
	// restart never sees it: closing keeps the operator's work, and Discard is
	// the one action that deletes it.
	const [launcherForm, setLauncherForm] = useState<{
		owner: string;
		draft: LauncherDraft;
	} | null>(null);
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
	// The held-turn bell: it rings the moment a held count rises, so a turn
	// that failed while the operator looked away gets their attention.
	const [heldBell, setHeldBell] = useState(false);
	const heldCountRef = useRef(-1);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selectedIndexRef = useRef(0);
	const configRef = useRef(config);
	configRef.current = config;
	sectionRef.current = section;
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
	// The no-state test projection has no durable claim or queue. The real
	// dispatch module owns the seat for every state-backed app.
	const noStateHandoffInFlightRef = useRef(false);
	const handoffDispatchRef = useRef<{ state: FactoryState; dispatch: HandoffDispatch } | undefined>(
		undefined,
	);
	const coordinatorRef = useRef<RefreshCoordinator | undefined>(undefined);
	const observationRef = useRef<ObservationCoordinator | undefined>(undefined);
	const configWriteQueue = useRef(Promise.resolve());
	// The selected Agent pane's refresh, callable the moment a forwarded
	// input lands: the operator should not wait out the refresh interval.
	const outputRefreshRef = useRef<(() => void) | null>(null);
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
		notice: setNoticeMessage,
		warning: setWarningMessage,
		error: setErrorMessage,
		clearOperation: clearOperationMessage,
		clearWorking: clearWorkingMessage,
		clearProgress: clearProgressMessage,
		// What a control that ran did, routed by the severity it named: a copy
		// that took is news, and a copy the terminal refused is a warning.
		report: reportMessage,
	} = useMessageFacts(sourceHealthMessage === "" ? undefined : sourceHealthMessage);
	/**
	 * Write one Consultation outcome onto the shared Message facts.
	 *
	 * A `null` outcome ends the fact a previous operation left and leaves every
	 * progress line alone: only the operation that owns a line ends it, and it
	 * says so through `onProgress`. Info becomes a notice, warning a warning,
	 * and error an error, so Consultation results read like Ticket results.
	 */
	const setStatus = useCallback(
		(next: StatusMessage | null): void => {
			if (next === null) clearOperationMessage("none");
			else if (next.kind === "info") setNoticeMessage(next.text);
			else if (next.kind === "warning") setWarningMessage(next.text);
			else setErrorMessage(next.text);
		},
		[clearOperationMessage, setNoticeMessage, setWarningMessage, setErrorMessage],
	);
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
	// The Dispatch pause (ADR 0016): a held failed trace holds the automatic
	// handoffs, routes, and restarts until it is decided or a turn completes.
	const dispatchPause = state?.dispatchPauseActive() ?? false;
	// The held turns (ADR 0016): the awaiting tickets whose last turn ended
	// failed, aborted, or truncated with no decision. They rest in awaiting,
	// held against every automatic decision, until the operator acts. A ticket
	// whose agent works again has left awaiting and is no longer held (its
	// next settle overwrites the trace).
	const heldCount = tickets.filter(
		(ticket) => ticket.state === "awaiting" && isHeldCompletion(ticket.lastCompletion),
	).length;
	const modeLine =
		state === undefined
			? ""
			: `auto: ${autoMode ? "on" : "off"} ${liveCount}${
					config.maxParallelAgents === 0 ? "" : `/${config.maxParallelAgents}`
				}${autoMode && dispatchPause ? " paused" : ""}`;
	const consultationCounts = state?.consultationCounts() ?? { awaitingResponse: 0, recovery: 0 };
	// The held count the bell compares against: a rise rings the terminal bell
	// and flashes the Tickets header, a fall or a steady count does not.
	useEffect(() => {
		if (heldCountRef.current >= 0 && heldCount > heldCountRef.current) {
			if (configRef.current.attentionBell) {
				setHeldBell(true);
				setTimeout(() => setHeldBell(false), 250);
				process.stdout.write("\u0007");
			}
		}
		heldCountRef.current = heldCount;
	}, [heldCount]);

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
	// The Main view keeps the permanent Message line and Action bar in both
	// sections. The mode line and the two section headers sit above the
	// expanded section's panes. Keep the compact size frame focused on its
	// size and Help controls when it cannot show the normal layout.
	// The mode line gives way before the panes' first text row: the minimum
	// frame holds the headers, one real pane row, and the two permanent rows.
	const showModeLine = modeLine !== "" && !tooSmall;
	const sectionHeaderRows = tooSmall ? 0 : 2;
	const reservedRows = 2 + sectionHeaderRows + (showModeLine ? 1 : 0);
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
	const consultationNarrow = section === "consultations" && terminalWidth < CONSULTATION_PANES_MIN_WIDTH;
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
	const consultationOperationsRef = useRef<ConsultationOperations | undefined>(undefined);
	// Capture state, replaceConsultations, and persistMapping once per mount.
	// FactoryState is created once by factory.ts, and the other callbacks read
	// the current config and projections through refs.
	if (consultationOperationsRef.current === undefined && state !== undefined) {
		consultationOperationsRef.current = createConsultationOperations({
			state,
			runner: commandRunner,
			config: () => configRef.current,
			home: homeDir,
			tickets: () => ticketsRef.current,
			controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE_ID,
			persistRepositoryMapping: persistMapping,
			callbacks: {
				onStatus: setStatus,
				// Each Consultation operation owns its progress line, so two
				// operations in two repositories never erase one another.
				onProgress: (text, owner) =>
					text === null
						? clearProgressMessage(consultationProgressOwner(owner))
						: setWorkingMessage(text, consultationProgressOwner(owner)),
				onConsultationsChanged: replaceConsultations,
				onSafetyConflict: ({ consultationId, safety }) => {
					setConsultationSafety({ consultationId, safety });
					setPanel({ kind: "consultation-safety", identity: consultationId });
				},
			},
		});
	}
	const consultationOperations = consultationOperationsRef.current;
	if (state === undefined) handoffDispatchRef.current = undefined;
	else if (handoffDispatchRef.current?.state !== state) {
		handoffDispatchRef.current = {
			state,
			dispatch: createHandoffDispatch({
				state,
				runner: commandRunner,
				config: () => configRef.current,
				home: homeDir,
				controlPlaneWorkspaceId: CONTROL_PLANE_WORKSPACE_ID,
				working: (text) => setWorkingMessage(text, "handoff"),
				warning: setWarningMessage,
				error: setErrorMessage,
				clearWorking: () => clearWorkingMessage("handoff"),
				refresh: replaceTickets,
				persistMapping,
			}),
		};
	}
	const handoffDispatch = handoffDispatchRef.current?.dispatch;
	/**
	 * Report the Close cleanup of one ended cycle.
	 *
	 * The module answers with herdr's failure and keeps the durable fact of the
	 * environment that survived it; the wording of the line is the caller's, so
	 * the operator's Close, an Abandon, and the automatic close each keep their
	 * own existing words for the same fact.
	 */
	const runCloseCleanup = (
		identity: string,
		handoff: StoredHandoffFacts,
		end: "closed" | "abandoned",
	) => {
		if (handoffDispatch === undefined) return;
		void handoffDispatch.closeCleanup(identity, handoff, end).then(
			(failure) => {
				if (failure !== undefined)
					setErrorMessage(`ticket ${identity} ${end}; the close cleanup failed: ${failure}`);
			},
			(error) => {
				setErrorMessage(
					`ticket ${identity} ${end}; the close cleanup could not be reported: ${errorMessage(error)}`,
				);
			},
		);
	};
	/**
	 * Start the Clear action. The dispatch module owns its durable work and
	 * Message-line reports; this caller only handles an unexpected rejection.
	 */
	const clearLeftover = (ticket: Ticket, force: boolean) => {
		if (handoffDispatch === undefined) {
			setWarningMessage("no factory state is open, so a leftover environment cannot be cleared");
			return;
		}
		// The module reports guards and cleanup failures on the same Message line
		// channel as the handoff. The catch is only for an unexpected module error.
		void handoffDispatch.clearLeftover(ticket.identity, force).catch((error) => {
			setErrorMessage(`clearing the leftover environment failed: ${errorMessage(error)}`);
		});
	};
	/**
	 * Report the outcome of the handoffs that stayed in the App: the no-state test
	 * projection. State-backed Ticket handoffs report through the dispatch module,
	 * and both cross the one shared wording in `reportHandoffOutcome`, so the
	 * parts of the line and the channel each one belongs on have one owner.
	 */
	const finishOutcome = (outcome: HandoffOutcome): Promise<void> =>
		reportHandoffOutcome(
			outcome,
			{
				clearWorking: () => clearWorkingMessage("handoff"),
				warning: setWarningMessage,
				error: setErrorMessage,
			},
			persistMapping,
		);
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
		if (handoffDispatch !== undefined) {
			void handoffDispatch
				.dispatch({
					origin: "open",
					ticketIdentity: ticket.identity,
					choice,
					previousMessage: "",
				})
				.then((result) => {
					if (!result.ok) setWarningMessage(result.reason);
				});
			return;
		}
		// The no-state test projection: no claim, and the settle patches the
		// ticket list by hand instead of reading it back from SQLite. It has no
		// queue, so it refuses to run behind a handoff already in flight.
		noStateHandoffInFlightRef.current = true;
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
				noStateHandoffInFlightRef.current = false;
			})
			.catch((error) => {
				setErrorMessage(`handoff failed: ${errorMessage(error)}`);
				noStateHandoffInFlightRef.current = false;
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
		/** The turn's end cause, or null when the turn has no settled record. */
		cause: TurnEndCause | null;
		/** The agent's or provider's text for the cause; empty when none. */
		detail: string;
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
			cause: completion?.cause ?? null,
			detail: completion?.detail ?? "",
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
		if (handoffDispatch === undefined) return;
		// Claim first: a refused claim leaves the ticket where it was. The
		// turn's decision is not recorded here: it lands when the routed
		// handoff starts, on the settled turn's trace, and a route that never
		// started leaves the trace pending, so Close and Goto keep working.
		const previousHandoffId = ticket.handoff?.attemptId ?? "";
		void handoffDispatch
			.dispatch({
				origin: "workflow",
				ticketIdentity: ticket.identity,
				choice,
				previousMessage: ticket.lastCompletion?.message ?? "",
				// The routed handoff started: the operator's decision on the turn
				// it routes from is `handed-off`, and the ticket reads as
				// handed-off where the agent is.
				onStarted: (started) => {
					if (!started.ok || previousHandoffId === "") return;
					state?.applyCompletionDecision({
						ticketIdentity: ticket.identity,
						handoffId: previousHandoffId,
						decision: "handed-off",
						decidedAt: new Date().toISOString(),
					});
					replaceTickets();
				},
			})
			.then((result) => {
				if (!result.ok) setWarningMessage(result.reason);
			});
	};

	/**
	 * The `e` key on a decision row: edit that route's resolved settings
	 * before it starts, so the operator's override outranks the edge pin,
	 * the target Task profile, and the config defaults.
	 */
	const openRouteOverride = (ticket: Ticket, key: string) => {
		if ((handoffDispatch?.handoffActive() ?? noStateHandoffInFlightRef.current) === true) {
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
		void consultationOperations?.launch(consultation);
	};

	const startConsultation = (
		typeName: string,
		repository: ConsultationRepositoryOption,
		input: string,
	) => {
		if (state === undefined || consultationOperations === undefined) {
			setStatus({ kind: "error", text: "Consultations require durable SQLite state" });
			return;
		}
		const replaced =
			replacementConsultationId === null
				? undefined
				: state.consultation(replacementConsultationId);
		const consultation =
			replaced === undefined
				? consultationOperations.create({
						typeName,
						repository,
						initialInput: input,
						replacementOf: replacementConsultationId,
					})
				: consultationOperations.replace(replaced, { typeName, repository, initialInput: input });
		if (consultation === undefined) return;
		setLauncher(false);
		setReplacementConsultationId(null);
		historyFilterRef.current = "open";
		setHistoryFilter("open");
		// Stay on the record the replacement points back at, or on the
		// launched Consultation when it replaces nothing.
		openConsultations(consultation.replacementOf ?? consultation.id);
		replaceConsultations();
		// A Replacement opens like a new Consultation: the module builds the
		// linked record with its bounded recovery context, then the same launch
		// route starts it.
		beginConsultationLaunch(consultation);
	};
	const recoverConsultationOpening = (consultation: Consultation) => {
		if (consultation.state !== "opening") return;
		void consultationOperations?.recover(consultation);
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
		if (
			state === undefined ||
			selectedConsultation === undefined ||
			consultationOperations === undefined
		)
			return;
		const consultation = selectedConsultation;
		const draft = responseDraftRef.current;
		// Keep this UI-side check so an invalid draft leaves the editor open;
		// respond repeats it at the module boundary for non-UI callers.
		const validation = validateResponseInput(draft);
		if (validation !== undefined) {
			setStatus({ kind: "error", text: validation });
			return;
		}
		setResponseEditor(false);
		void consultationOperations.respond(consultation, draft).then(
			() => {
				const current = state.consultation(consultation.id);
				// Keep the editor open when delivery was already pending, or when
				// a failed delivery left the draft awaiting another attempt.
				if (current?.state === "awaiting-response") setResponseEditor(true);
			},
			() => setResponseEditor(true),
		);
	};
	/**
	 * Keep the durable Response draft equal to what the field holds.
	 *
	 * The Draft field owns the text while the operator edits it, and the saved
	 * draft is what survives a close, a rejection, and a restart, so every
	 * change is stored as it happens rather than carried out of the editor by
	 * hand.
	 */
	const storeResponseDraft = (text: string) => {
		responseDraftRef.current = text;
		setResponseDraft(text);
		if (
			state !== undefined &&
			selectedConsultation !== undefined &&
			text !== selectedConsultation.draft
		)
			state.setConsultationDraft(selectedConsultation.id, text);
	};
	/** Store what the operator last saw, then run the send. */
	const sendResponseText = (text: string) => {
		storeResponseDraft(text);
		submitResponse();
	};
	/** Delete the saved Response draft. Closing the editor never does this. */
	const discardResponseDraft = () => {
		responseDraftRef.current = "";
		setResponseDraft("");
		if (state !== undefined && selectedConsultation !== undefined)
			state.setConsultationDraft(selectedConsultation.id, "");
		setResponseEditor(false);
		setStatus({ kind: "info", text: "the saved Response draft was discarded" });
	};
	/** Close the editor. The Response draft it leaves is the one already stored. */
	const closeResponseEditor = () => {
		setResponseEditor(false);
	};
	const expandSection = (next: MainSection) => {
		sectionRef.current = next;
		setSection(next);
		// The narrow Consultation layout removes its list pane, so focus the
		// visible detail pane instead of leaving navigation on hidden content.
		focusPane(next === "consultations" && terminalWidth < CONSULTATION_PANES_MIN_WIDTH ? "detail" : "list");
	};
	/**
	 * The index, in the open list, of the Consultation that needs the
	 * operator, if any.
	 *
	 * An awaiting response always wins: the Agent is working and waiting.
	 * Otherwise attention goes to the oldest unresolved recovery item: it
	 * has waited the longest for the operator. The list is newest-first, so
	 * the attention row is usually not the first one, and ties break on
	 * creation time.
	 */
	const attentionIndex = (): number | null => {
		if (state === undefined) return null;
		const current = state.consultations("open");
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
		if (target === undefined || target === null) return null;
		return current.findIndex((item) => item.id === target.id);
	};
	const openConsultations = (selectId?: string) => {
		expandSection("consultations");
		// With an explicit selection the view stays on that Consultation:
		// a launch keeps the operator on what it just created, or on the
		// record the replacement points back at. Without one the view opens
		// on the Consultation that needs the operator, if one does: it must
		// not hide behind a collapsed section. Without either the section keeps
		// its current filter and selection.
		const index =
			selectId === undefined
				? attentionIndex()
				: state === undefined
					? null
					: state.consultations("open").findIndex((item) => item.id === selectId);
		if (index === undefined || index === null) return;
		historyFilterRef.current = "open";
		setHistoryFilter("open");
		replaceConsultations();
		consultationIndexRef.current = index;
		setConsultationIndex(index);
		consultationFollowRef.current = true;
		setConsultationScroll(999999);
		setNewOutput(false);
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
		void consultationOperations?.close(consultation);
	};
	const forceCloseConsultation = (consultation: Consultation) => {
		consultationOperations?.forceClose(consultation);
	};
	const deleteConsultation = (consultation: Consultation) => {
		consultationOperations?.delete(consultation);
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
		if (handoffDispatch === undefined) return;
		void handoffDispatch
			.dispatch({
				origin: "restart",
				ticketIdentity: ticket.identity,
				choice,
				previousMessage: ticket.lastCompletion?.message ?? "",
			})
			.then((result) => {
				if (!result.ok) setWarningMessage(result.reason);
			});
	};
	const currentBaseMode = (): InteractionMode =>
		interaction
			? "consultation-interaction"
			: responseEditor
				? "form-field"
				: sectionRef.current === "consultations"
					? focusedPaneRef.current === "list"
						? "consultation-list"
						: "consultation-detail"
					: focusedPaneRef.current === "list"
						? "ticket-list"
						: "ticket-detail";
	const controlContextFor = (mode: InteractionMode) =>
		contextFor(mode, {
			selectedTicket: ticketsRef.current[selectedIndexRef.current],
			selectedConsultation: consultationsRef.current[consultationIndexRef.current],
			listCanMove:
				mode === "consultation-list"
					? consultationsRef.current.length > 1
					: ticketsRef.current.length > 1,
			detailCanScroll:
				mode === "consultation-detail" ? consultationMaxScroll > 0 : detailMaxScroll > 0,
			sourceCount: sources.length,
			refreshingSourceCount: sources.filter(
				(source) => coordinatorRef.current?.isFetching(source.name) === true,
			).length,
			handoffActive: handoffDispatch?.handoffActive() ?? noStateHandoffInFlightRef.current,
			messageTruncated,
			consultationRefreshAvailable: state !== undefined,
			consultationListVisible: !consultationNarrow,
			consultationAgentStatus: selectedConsultationAgentStatus,
			consultationTypesConfigured: Object.keys(config.consultationTypes).length > 0,
			interactionExitKey: configRef.current.interactionExitKey,
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
		if (started.length === 0) {
			setWarningMessage(
				sources.length === 0
					? "no Ticket sources exist"
					: "every Ticket source is already refreshing",
			);
			return;
		}
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
		// The shell owns the emergency exit before the Agent terminal matches a
		// key, so Ctrl+C cannot reach an Agent. Every other surface dispatches
		// Ctrl+C through the control catalogue below.
		if (interaction && key.ctrl === true && key.name === "c") {
			renderer.destroy();
			return;
		}
		// The response editor is a shared form surface: its field and actions
		// answer the keys there, and nothing below may claim them. The shell
		// keeps the emergency exit, because the field takes every other Ctrl key
		// as text editing.
		if (responseEditor && key.ctrl === true && key.name === "c") {
			renderer.destroy();
			return;
		}
		if (responseEditor) return;
		if (interaction) {
			const exit = configRef.current.interactionExitKey.toLowerCase().replace(/^ctrl-/, "ctrl+");
			const keyName = key.name.toLowerCase();
			const isExit = keyName === exit || (key.ctrl === true && exit === `ctrl+${keyName}`);
			if (isExit) {
				setInteraction(false);
				// Settle the queued input before announcing the exit: the last
				// key the operator sent still belongs to the Agent.
				void (consultationOperations?.flush() ?? Promise.resolve()).then(() =>
					setStatus({ kind: "info", text: "left Agent interaction mode" }),
				);
				return;
			}
			const selected = consultationsRef.current[consultationIndexRef.current];
			const event =
				selected?.paneId === null || selected?.paneId === undefined
					? null
					: translateAgentKey(key, configRef.current.interactionExitKey);
			if (selected !== undefined && selected.paneId !== null && event !== null) {
				const queued = consultationOperations?.enqueue(selected.paneId, event);
				if (queued === undefined) return;
				void queued.then(
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
		// The control catalogue decides every key on the Main view, through the
		// same dispatch hook every modal, panel, and overlay uses.
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
				"consultation-list": () => focusPane("list"),
				tickets: () => focusPane("list"),
				"move-list": ({ key }) => moveRange(key.name),
				"scroll-detail": ({ key }) => moveRange(key.name),
				consultations: () => openConsultations(),
				"open-tickets": () => expandSection("tickets"),
				launch: () => {
					if (Object.keys(configRef.current.consultationTypes).length === 0)
						setWarningMessage(
							"no Consultation types configured; add [consultation-types.<name>] to the config file",
						);
					else {
						// In the Consultation section, a missing or failed Consultation
						// is replaced rather than reopened: the launcher remembers which
						// row asked for the replacement.
						const selected = consultationsRef.current[consultationIndexRef.current];
						if (
							sectionRef.current === "consultations" &&
							(selected?.state === "missing" || selected?.state === "failed")
						)
							setReplacementConsultationId(selected.id);
						setLauncher(true);
					}
				},
				history: cycleConsultationHistory,
				"consultation-close": () => {
					const selected = consultationsRef.current[consultationIndexRef.current];
					if (selected === undefined) return;
					if (
						selected.state === "opening" ||
						selected.state === "working" ||
						selected.state === "closing"
					)
						setPanel({ kind: "consultation-close", identity: selected.id });
					else if (
						selected.state === "awaiting-response" ||
						selected.state === "missing" ||
						selected.state === "failed"
					)
						closeConsultation(selected);
				},
				"consultation-delete": () => {
					const selected = consultationsRef.current[consultationIndexRef.current];
					if (selected !== undefined)
						setPanel({ kind: "consultation-delete", identity: selected.id });
				},
				"consultation-respond": () => {
					const selected = consultationsRef.current[consultationIndexRef.current];
					if (selected === undefined) return;
					beginResponse(selected);
				},
				"consultation-interact": () => setInteraction(true),
				override: openOverride,
				recover: () => {
					const selected = consultationsRef.current[consultationIndexRef.current];
					if (selected?.state === "opening") recoverConsultationOpening(selected);
				},
				refresh: () => {
					// Refresh answers for the whole plane: the Ticket sources, and
					// the Consultation projection the expanded section shows.
					if (sectionRef.current === "consultations") replaceConsultations();
					refreshNow();
				},
				leftover: openLeftoverPanel,
				// `a` answers for the switch itself in the Ticket section, where
				// the catalog binds it: reaching the state must never depend on
				// whether a Consultation needs the operator. The Consultation
				// section does not bind the key, so `a` there is the catalog's
				// refusal, not this action.
				"auto-handoff": () => toggleAutoHandoff(),
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
			section !== "consultations" ||
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
			consultationOperations?.recordOutputRead(selectedConsultation.id, output);
			if (output === null) return;
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
	}, [commandRunner, consultationOperations, interaction, selectedConsultation, state, section]);
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
		const dispatch = handoffDispatch;
		if (state === undefined || dispatch === undefined || initialTickets !== undefined) return;
		const coordinator = new ObservationCoordinator({
			state,
			herdr: new HerdrAgentReader(commandRunner),
			config: () => configRef.current,
			dispatch: (intent) => dispatch.dispatch(intent),
			// The Close cleanup of an auto-ended cycle: the environment of the
			// handoff the decision ends. A cleanup that cannot remove the
			// checkout leaves a leftover the ticket carries as a fact, so the
			// operator sees it and has one action to end it (ADR 0012).
			cleanup: (handoff, end) =>
				dispatch.closeCleanup(
					handoff.ticketIdentity,
					{
						handoffId: handoff.handoffAttemptId,
						environment: handoff.environment,
						tabId: handoff.tabId,
						workspaceId: handoff.workspaceId,
					},
					end,
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
			onStatus: (kind, text, topic) => {
				// Both sections read the same observation events: an outcome is
				// a fact for the one Message line, whichever section is expanded.
				// `setStatus` maps the observation's kinds onto that line: info
				// becomes a notice, warning a warning, and error an error. The
				// observation sends only the facts an operator acts on, so the
				// Message line stays a statement of the plane and not a log.
				setStatus({ kind, text });
				// The recovery topic is the structured signal that a stale
				// operation fact can clear; the text stays human-facing. The
				// observation writes no progress line of its own.
				if (topic === "herdr-recovered") clearOperationMessage("none");
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
		handoffDispatch,
		initialTickets,
		pollIntervalMs,
		replaceTickets,
		replaceConsultations,
		commandRunner,
		onReady,
		clearOperationMessage,
		setStatus,
	]);
	function focusPane(pane: Pane) {
		focusedPaneRef.current = pane;
		setFocusedPane(pane);
	}
	// A resize can remove the narrow Consultation list without a section switch.
	// Keep both focus representations on the visible detail pane in that case.
	useLayoutEffect(() => {
		if (section === "consultations" && terminalWidth < CONSULTATION_PANES_MIN_WIDTH && focusedPaneRef.current !== "detail") {
			focusedPaneRef.current = "detail";
			setFocusedPane("detail");
		}
	}, [section, terminalWidth]);
	function selectTicket(index: number) {
		const next = clamp(index, 0, Math.max(0, ticketsRef.current.length - 1));
		if (next === selectedIndexRef.current) return;
		selectedIndexRef.current = next;
		setSelectedIndex(next);
	}
	function moveList(delta: number) {
		selectTicket(selectedIndexRef.current + delta);
	}
	function selectConsultation(index: number) {
		const next = clamp(index, 0, Math.max(0, consultationsRef.current.length - 1));
		if (next === consultationIndexRef.current) return;
		consultationIndexRef.current = next;
		setConsultationIndex(next);
		setConsultationScroll(0);
		consultationFollowRef.current = true;
		setNewOutput(false);
	}
	/** Move the Consultation detail by whole pages, keeping the follow rule. */
	function moveConsultationDetailPage(direction: 1 | -1) {
		const page = Math.max(1, detailGeometry.visibleRows - 2);
		consultationFollowRef.current = false;
		setConsultationScroll((current) => clamp(current + direction * page, 0, consultationMaxScroll));
	}
	function moveVertical(delta: number) {
		if (sectionRef.current === "consultations") {
			if (focusedPaneRef.current === "detail") {
				consultationFollowRef.current = false;
				setConsultationScroll((current) => clamp(current + delta, 0, consultationMaxScroll));
			} else selectConsultation(consultationIndexRef.current + delta);
			return;
		}
		if (focusedPaneRef.current === "detail")
			detailRef.current?.moveBy(delta * configRef.current.scroll.speed);
		else moveList(delta);
	}
	function movePage(direction: 1 | -1) {
		if (sectionRef.current === "consultations") {
			if (focusedPaneRef.current === "detail") moveConsultationDetailPage(direction);
			else selectConsultation(consultationIndexRef.current + direction * listGeometry.visibleRows);
			return;
		}
		if (focusedPaneRef.current === "detail")
			detailRef.current?.movePage(direction === 1 ? "down" : "up");
		else moveList(direction * listGeometry.visibleRows);
	}
	function moveEdge(edge: "start" | "end") {
		if (sectionRef.current === "consultations") {
			if (focusedPaneRef.current === "detail") {
				consultationFollowRef.current = edge === "end";
				setConsultationScroll(edge === "start" ? 0 : 999999);
				if (edge === "end") setNewOutput(false);
			} else selectConsultation(edge === "start" ? 0 : consultationsRef.current.length - 1);
			return;
		}
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
	// The form the launcher opens on: the one the operator left on this screen,
	// or the Replacement context the durable state holds when nothing was left.
	const launcherOwner =
		replacementConsultationId === null ? "launcher" : `replacement:${replacementConsultationId}`;
	const launcherDraft =
		launcherForm !== null && launcherForm.owner === launcherOwner
			? launcherForm.draft
			: replacementConsultation !== undefined && state !== undefined
				? // A Replacement starts from the durable recovery context, never from
					// a draft another screen left behind.
					{
						typeName: replacementConsultation.typeName,
						repositoryIdentity: replacementConsultation.repository.identity,
						input: state.replacementInput(replacementConsultation.id),
					}
				: // A fresh launcher starts on the Repository the operator was looking at.
					{
						typeName: Object.keys(config.consultationTypes)[0] ?? "",
						repositoryIdentity: selectedTicket?.repositoryRef.identity ?? "",
						input: "",
					};
	const actionMode = currentBaseMode();
	const ticketContext = controlContextFor(actionMode);
	const messageColor = colorOfMessage(visibleMessage);
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
	// Response editing and Agent interaction own all input above the Main
	// panes. Keep headers and panes mouse-inert until that mode closes.
	const mainSurfaceActive =
		override === null &&
		panel === null &&
		utility === null &&
		!launcher &&
		!responseEditor &&
		!interaction;
	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "column" } },
		// One Main frame: the mode line comes first, then the two section
		// headers, and only the expanded section renders its panes below its
		// own header.
		showModeLine &&
			createElement(
				"text",
				{ style: { width: "100%", height: 1, fg: COLORS.dim } },
				padToWidth(truncateToWidth(modeLine, terminalWidth), terminalWidth),
			),
		!tooSmall &&
			createElement(SectionHeader, {
				section: "tickets",
				expanded: section === "tickets",
				width: terminalWidth,
				held: heldCount,
				heldBell,
				active: mainSurfaceActive,
				onExpand: () => expandSection("tickets"),
			}),
		!tooSmall &&
			createElement(SectionHeader, {
				section: "consultations",
				expanded: section === "consultations",
				width: terminalWidth,
				awaitingResponse: consultationCounts.awaitingResponse,
				recovery: consultationCounts.recovery,
				bell,
				newOutput,
				active: mainSurfaceActive,
				onExpand: () => expandSection("consultations"),
			}),
		tooSmall
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
					section === "tickets"
						? createElement(TicketList, {
								tickets,
								selectedIndex,
								focused: focusedPane === "list",
								reservedRows,
								emptyMessage,
								markerOf,
								limitReached: (ticket) => ticket.handoffCount >= config.maxHandoffsPerTicket,
								active: mainSurfaceActive,
								onFocus: () => focusPane("list"),
								onSelect: selectTicket,
								onMove: moveList,
							})
						: undefined,
					section === "consultations" &&
						!consultationNarrow &&
						createElement(ConsultationList, {
							consultations,
							selectedIndex: consultationIndex,
							focused: focusedPane === "list",
							reservedRows,
							active: mainSurfaceActive,
							onFocus: () => focusPane("list"),
							onSelect: selectConsultation,
							onMove: (delta) => selectConsultation(consultationIndexRef.current + delta),
							emptyMessage:
								state === undefined
									? "Consultations require SQLite state"
									: historyFilter === "closed"
										? "no closed Consultations"
										: historyFilter === "all"
											? "no Consultations"
											: "no open Consultations",
						}),
					section === "tickets"
						? createElement(TicketDetail, {
								ref: detailRef,
								ticket: selectedTicket,
								focused: focusedPane === "detail",
								active: mainSurfaceActive,
								reservedRows,
								handoffLimit: config.maxHandoffsPerTicket,
								suggestedChoice:
									selectedTicket?.state === "open" ? choiceFor(selectedTicket) : undefined,
								scroll: config.scroll,
								onFocus: () => focusPane("detail"),
								scrollSlot: detailScrollSlot,
							})
						: undefined,
					section === "consultations" &&
						createElement(
							"box",
							{ style: { flexGrow: 1, flexDirection: "column" } },
							createElement(ConsultationDetail, {
								lines: consultationLines,
								ansiLines,
								visibleRows: Math.max(
									1,
									detailGeometry.visibleRows - (responseEditor ? RESPONSE_EDITOR_ROWS : 0),
								),
								scroll: consultationDetailScroll,
								focused: focusedPane === "detail" && !responseEditor,
								active: mainSurfaceActive,
								onFocus: () => focusPane("detail"),
								onWheel: (delta) => moveVertical(delta),
								compactHeading:
									consultationNarrow && selectedConsultation !== undefined
										? `${selectedConsultation.typeName} - ${selectedConsultation.repository.displayName}`
										: undefined,
							}),
							responseEditor &&
								createElement(ResponseEditor, {
									draft: responseDraft,
									width: consultationWidth,
									rows: RESPONSE_EDITOR_ROWS,
									focused: true,
									context: controlContextFor("form-field"),
									inputActive: utility === null,
									onSend: sendResponseText,
									onDiscard: discardResponseDraft,
									onDraftChange: storeResponseDraft,
									onClose: closeResponseEditor,
									onHelp: () => openGuide("form-field"),
									onMessage: () => openMessage("form-field"),
									onUnavailable: (reason: string) => setStatus({ kind: "warning", text: reason }),
									onCopy: reportMessage,
									message: visibleMessage,
									onEmergencyExit: () => renderer.destroy(),
								}),
						),
				),
		launcher &&
			createElement(ConsultationLauncher, {
				types: config.consultationTypes,
				repositories: repositoryOptions,
				draft: launcherDraft,
				title:
					replacementConsultation === undefined
						? "Consultation launcher"
						: "Replacement Consultation",
				onLaunch: (typeName, repository, text) => {
					// The form is with the Agent now, so nothing is left to keep.
					setLauncherForm(null);
					startConsultation(typeName, repository, text);
				},
				onClose: (kept) => {
					setLauncherForm({ owner: launcherOwner, draft: kept });
					setLauncher(false);
					setReplacementConsultationId(null);
				},
				onDiscard: () => {
					setLauncherForm(null);
					setLauncher(false);
					setReplacementConsultationId(null);
				},
				context: controlContextFor(currentBaseMode()),
				inputActive: utility === null,
				onHelp: (mode) => openGuide(mode),
				onMessage: (mode) => openMessage(mode),
				onUnavailable: setWarningMessage,
				onCopy: reportMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		terminalHeight >= 2 && messageRowElement(visibleMessage, terminalWidth),
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
				onCopy: reportMessage,
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
				cause: decision.cause,
				detail: decision.detail,
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
						const current = state?.consultation(panelConsultation.id);
						if (current !== undefined) consultationOperations?.confirmSafetyConflict(current);
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
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
