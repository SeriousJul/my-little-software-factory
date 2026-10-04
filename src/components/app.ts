/**
 * The control plane shell: panes, refresh, selection, handoff, and the
 * herdr observation loop (ADR 0005, ADR 0006).
 *
 * The Ticket header's mode cell carries the auto-handoff state and the live
 * agent count against the parallel limit. Enter on an open ticket hands it off; Enter
 * on an awaiting ticket opens the decision modal (close, Goto, or a
 * workflow handoff), while the factory does not decide the ticket itself
 * (auto mode, or an auto-close task type); Enter on an in-flight ticket
 * opens the Live view, which streams the agent's terminal output, offers
 * the Goto, and becomes the decision modal when the turn settles and the
 * factory waits for the operator; Enter on an in-flight ticket whose pane
 * herdr no longer lists opens the missing modal (restart or abandon).
 * `a` toggles auto-handoff in the Ticket section and writes the mode to the
 * state file at once, so the next run reads it back (ADR 0036).
 *
 * The Main view is one surface with three sections (ADR 0019, ADR 0049): the
 * Ticket, Consultation, and Work lists stay in the left column, all three
 * expanded by default, and one detail pane on the right renders the selected
 * item, whatever section it comes from. The Work section is always visible: it
 * keeps its header row while it is empty, the way the other two do. `x`
 * toggles the section under the cursor, and one Message line, one Action bar,
 * and one control catalog answer for all three.
 */
import os from "node:os";
import type { Selection } from "@opentui/core";
import { createElement, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttentionService } from "../attention.ts";
import { defaultConfigPath, type FactoryConfig, type TransitionOutcome } from "../config.ts";
import {
	type ConfigWriteFact,
	type ConfigWriteReport,
	configWriteLine,
	writeConfigFile,
	writeFactWithConfirmation,
} from "../config-write.ts";
import { translateAgentKey } from "../consultation/agent-input.ts";
import {
	type ConsultationRepositoryOption,
	consultationRepositoryCatalog,
	type LiveCheckoutSafety,
	validateConsultationRepositoryOptions,
} from "../consultation/checkout-safety.ts";
import { validateResponseInput } from "../consultation/response-draft.ts";
import {
	type ConsultationOperations,
	createConsultationOperations,
} from "../consultation-operations.ts";
import {
	type AgentPoll,
	agentPoll,
	normalizeAgentStatus,
	ticketAgentIdentity,
} from "../domain/agent.ts";
import { decisionFacts } from "../domain/decision-facts.ts";
import type { GroupingAxis, SplitGroupingAxis } from "../domain/grouping.ts";
import { DEFAULT_GROUPING_AXIS, nextGroupingAxis } from "../domain/grouping.ts";
import { heldBellRang, sectionFacts } from "../domain/section-facts.ts";
import {
	flagWithholdsRow,
	HANDOFF_ENVIRONMENT_KINDS,
	type Handoff,
	nextTicketListFilter,
	type Ticket,
	type TicketListFilter,
} from "../domain/ticket.ts";
import {
	inFlight,
	liveContextLine,
	type TicketFactInputs,
	type TicketRowFacts,
	ticketFactsFor,
	ticketRowFacts,
} from "../domain/ticket-facts.ts";
import { fileExists } from "../fs.ts";
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
	type HandoffDispatchAggregates,
	reportHandoffOutcome,
	type StoredHandoffFacts,
} from "../handoff-dispatch.ts";
import type { HerdrAgent } from "../herdr.ts";
import type { Logger } from "../logging.ts";
import {
	HerdrAgentReader,
	matchConsultationAgent,
	ObservationCoordinator,
	STARTUP_GRACE_MS,
} from "../observation.ts";
import {
	CONSULTATION_SEAT_STATES,
	overParallelLimit,
	parallelSeatCount,
	TICKET_SEAT_STATES,
} from "../parallel.ts";
import { evaluatePlacement, type PlacementEvaluation } from "../placement.ts";
import {
	DEFAULT_MERGE_METHOD,
	isPlaneActionTaskType,
	planeActionLabel,
	planeActionSettingOf,
} from "../plane-action-registry.ts";
import { closeCycleEndDraftPullRequest } from "../pull-request.ts";
import { RefreshCoordinator } from "../refresh.ts";
import type { RepositoryMapping } from "../repo.ts";
import { repositoryInitCheckoutPath } from "../repo.ts";
import {
	type InstructionFileName,
	planRepositoryInit,
	type RepositoryInitPlan,
	repositoryInitSettingsHash,
} from "../repo-init.ts";
import {
	commitRepositoryInit,
	type RepositoryInitRepository,
	repositoryInitStanding,
} from "../repo-init-flow.ts";
import { type InitableRepository, listInitableRepositories } from "../repository-list.ts";
import type { CommandOptions } from "../runner.ts";
import {
	type CommandRunner,
	commandFailureText,
	createChildProcessRunner,
	errorMessage,
	supportsModelList,
} from "../runner.ts";
import { type TaskProfileStart, taskProfilesOf } from "../setting-resolution.ts";
import type { Consultation, ConsultationRecordAggregate } from "../state/consultation-record.ts";
import type { GroupingAggregate } from "../state/grouping.ts";
import type { HandoffAggregate } from "../state/handoff.ts";
import type { PlaneActionAggregate } from "../state/plane-action.ts";
import type { RepositoryInitAggregate } from "../state/repository-init.ts";
import type { SourceFactAggregate } from "../state/source-fact.ts";
import type { TicketListViews, TicketWorkCycleAggregate } from "../state/ticket-work-cycle.ts";
import { inMemoryTicketViews } from "../state/ticket-work-cycle.ts";
import type { WorkQueueAggregate, WorkQueueItem } from "../state/work-queue.ts";
import { workQueueIdentityOf } from "../state/work-queue.ts";
import { currentThemeResolution } from "../theme-source.ts";
import type { TicketSource } from "../ticket-source.ts";
import { createTicketSource, GhAuthenticator } from "../ticket-source.ts";
import {
	readSessionExchange,
	type SessionEntry,
	type TurnEndCause,
	type TurnLogEntry,
} from "../turn-log.ts";
import { deriveNextStep, fireTransition, refireRecordedSkips } from "../workflow.ts";
import { ActionBar } from "./action-bar.ts";
import { ActionPanel } from "./action-panel.ts";
import { renderAnsiScreen } from "./ansi-screen.ts";
import { consultationClosePanel } from "./consultation-close-panel.ts";
import {
	ConsultationDetail,
	consultationDetailBody,
	consultationDetailLines,
	consultationDetailTitle,
} from "./consultation-detail.ts";
import { ConsultationLauncher, type LauncherDraft } from "./consultation-launcher.ts";
import { ConsultationList } from "./consultation-list.ts";
import { consultationRecoveryPanel } from "./consultation-recovery-panel.ts";
import { createControlDispatch, refusalReason, refusalText } from "./control-dispatch.ts";
import {
	type AvailabilityFacts,
	availabilityFacts,
	availabilityFor,
	consultationSectionFacts,
	controlById,
	type InteractionMode,
	type StandingFacts,
	ticketSectionFacts,
	workQueueSectionFacts,
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
import { type AgentModelList, type ModelListStatus, OverridePanel } from "./override-panel.ts";
import { repositoryInitPanel } from "./repository-init-panel.ts";
import { RepositorySelectPanel } from "./repository-select-panel.ts";
import { RESPONSE_EDITOR_ROWS, ResponseEditor } from "./response-editor.ts";
import { type MainSection, SectionHeader } from "./section-header.ts";
import { COPY_REFUSED_REASON } from "./shared/fields.ts";
import {
	cursorRowCount,
	type GroupFolds,
	groupCursorFacts,
	groupingAxisNotice,
	groupingEmptyMessage,
	type ListedRow,
	movedGroupOrder,
	NO_GROUP_FOLDS,
	rowAnchorOf,
	settleRowIndex,
	stepRowIndex,
	ticketGroupCompare,
	ticketRowIndexForAnchor,
	ticketRows,
	toggleFold,
} from "./shared/grouping.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { paint } from "./theme.ts";
import { ticketCloseDialog } from "./ticket-close.ts";
import { detailScrollRoom, TicketDetail, type TicketDetailHandle } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";
import { KeyGuide, MessageView } from "./utility.ts";
import { workQueueDetailLines } from "./work-queue-detail.ts";
import {
	consultationItemWaitingFor,
	handoffItemWaitingForTicket,
	WorkQueueList,
	type WorkQueueRow,
	workQueueCursorFacts,
} from "./work-queue-list.ts";

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
	| { kind: "ticket-close"; identity: string }
	| { kind: "consultation-close"; identity: string }
	| { kind: "consultation-recovery"; identity: string }
	| { kind: "consultation-force"; identity: string }
	| { kind: "consultation-delete"; identity: string }
	| { kind: "consultation-safety"; identity: string }
	| { kind: "live"; identity: string }
	| { kind: "repository-select" }
	| {
			kind: "repository-init";
			identity: string;
			repository: RepositoryInitRepository;
			plan: RepositoryInitPlan;
	  };

/**
 * The init queue (ADR 0083): the repositories the operator marked in the
 * select list, one entry per repository. The entry under review stands in
 * the confirmation panel; the rest wait here in list order, and the counts
 * stand for the settled line the queue leaves when it drains.
 */
interface RepositoryInitQueue {
	remaining: readonly InitableRepository[];
	ran: number;
	skipped: number;
	refused: number;
}
/**
 * The dim note under the last stream lines when the latest read failed:
 * the Stale Agent output, the glossary's name for it.
 */
const STALE_STREAM_NOTE = "Stale Agent output: the last lines stand";
/**
 * The one section the plane groups today, and the row its axis holds on the
 * state file (issue #159, ADR 0058).
 *
 * The record is keyed by section rather than by one section, so a second list
 * that takes grouping later writes its own row with no new schema version.
 */
const TICKET_GROUP_SECTION = "tickets" as const;
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
	| "f"
	| "x"
	| "w"
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
/**
 * The utility overlay open above the panes, if any. Overlays replace one
 * another. Every surface of the Main view opens the catalog's own Key guide
 * and Message view, captured from the mode the operator pressed the key in.
 */
type Utility =
	| null
	| { kind: "guide"; mode: InteractionMode }
	| { kind: "message"; mode: InteractionMode; fact: MessageFact };

/**
 * The aggregates the app shell reads, as a list (issue #202), and the clock it
 * hands to the modules it builds. The shell never reaches the state file: it
 * reads through these interfaces only, and a plane with no state file has none
 * of them.
 */
export interface AppAggregates {
	consultationRecord: ConsultationRecordAggregate;
	grouping: GroupingAggregate;
	handoff: HandoffAggregate;
	planeAction: PlaneActionAggregate;
	repositoryInit: RepositoryInitAggregate;
	sourceFact: SourceFactAggregate;
	ticketWorkCycle: TicketWorkCycleAggregate;
	workQueue: WorkQueueAggregate;
	/** The state clock, handed to the dispatch module the shell builds. */
	now(): number;
}

export interface AppProps {
	/**
	 * The validated config. The production entry always supplies it from the
	 * config load seam; the test harness fills a base config when a suite
	 * omits it.
	 */
	config: FactoryConfig;
	runner?: CommandRunner;
	home?: string;
	configPath?: string;
	/** SQLite state. The factory entry module owns its process lease. */
	state?: AppAggregates;
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
	/**
	 * The plane's file logger. The refresh and handoff loops leave their lines
	 * in the record it owns. Absent in tests and the gallery, where the loops
	 * stay silent.
	 */
	logger?: Logger;
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
	logger,
}: AppProps) {
	const renderer = useRenderer();
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const [config, setConfig] = useState<FactoryConfig>(() => configProp);
	// Only test callers supply deterministic tickets. Production starts with
	// the empty SQLite projection while configured sources refresh.
	// The Ticket section's list, in one read per refresh (ADR 0042, ADR 0060):
	// the rows the operator's List filter shows, the active view the section's
	// counts and the held bell read, the pile the ignore withholds, and the
	// projection before the list rule the reads that resolve a Ticket by
	// identity take. The in-memory shell holds no list rule, so all its views
	// are the rows it was given.
	const [listViews, setListViews] = useState<TicketListViews>(() => {
		if (state !== undefined)
			return state.ticketWorkCycle.ticketListViews(
				config.workflowStates,
				config.defaultTaskType,
				"active",
			);
		return inMemoryTicketViews(initialTickets ?? []);
	});
	const tickets = listViews.rows;
	/**
	 * The rows the machine reads (ADR 0060): the active view of the Ticket
	 * section's list rule, never the operator's List filter. The section's
	 * counts, the held-count bell, and the Consultation launcher's repository
	 * choices all take it, so a filter cycle moves none of them and each stays
	 * the fact the factory stands on.
	 */
	const machineTickets = listViews.active;
	const ticketsRef = useRef(tickets);
	/**
	 * The Grouping axis in effect for the Ticket section's list (issue #159).
	 *
	 * It is factory state (ADR 0058): the shell reads the operator's last choice
	 * back from the state file at boot, so a restart and a dev reload find the
	 * list split the way they left it. A plane with no state file has nothing
	 * durable to read, keeps the axis for the run, and writes nothing.
	 */
	const [groupingAxis, setGroupingAxis] = useState<GroupingAxis>(
		() => state?.grouping.groupingAxis(TICKET_GROUP_SECTION) ?? DEFAULT_GROUPING_AXIS,
	);
	const groupingAxisRef = useRef(groupingAxis);
	// The one-time init note stands once per run (ADR 0075, story 20): the flag
	// is a session fact and never durable, so a restart re-states the note.
	const initNoteShownRef = useRef(false);
	/**
	 * The operator's stored order of the Group values of the axis in effect
	 * (ADR 0071): factory state, read back at boot the way the axis itself is,
	 * and written whole on the operator's own move. Empty where the operator
	 * has moved no Group on the axis, and the list then stands the axis' own
	 * default order.
	 *
	 * Each axis keeps its own order, so this value is the stored order of the
	 * axis in effect alone; the orders of the other axes a plane with no state
	 * file stands for the run keep in the run map below.
	 */
	const [groupOrderList, setGroupOrderList] = useState<string[]>(() =>
		state !== undefined && groupingAxis !== "none"
			? state.grouping.groupOrder(TICKET_GROUP_SECTION, groupingAxis)
			: [],
	);
	const groupOrderListRef = useRef(groupOrderList);
	/**
	 * The stored orders of this run for the axes the plane does not read back
	 * from a state file (ADR 0071): a plane with no state file keeps its group
	 * orders for the run, the way it keeps its axis, and a move on an axis the
	 * operator visits twice comes back where they left it.
	 */
	const groupOrdersForRunRef = useRef<Partial<Record<SplitGroupingAxis, string[]>>>({});
	/** The Workflow's own order of its positions, the `position` axis' default order. */
	const positionOrderOf = useCallback(
		(): string[] => config.workflowStates.map((w) => w.name),
		[config],
	);
	/** The stored order of one axis: the run map's where there is no state file, the file's where there is one. */
	const storedGroupOrderOf = (axis: SplitGroupingAxis): string[] =>
		state === undefined
			? (groupOrdersForRunRef.current[axis] ?? [])
			: state.grouping.groupOrder(TICKET_GROUP_SECTION, axis);
	/**
	 * The Groups the operator folded: session facts, keyed by the axis and the
	 * Group value, and never written to disk (ADR 0058). The plane comes up with
	 * every Group open so a restart cannot hide a decision the operator owes, and
	 * it never moves a fold on its own.
	 */
	const [groupFolds, setGroupFolds] = useState<GroupFolds>(NO_GROUP_FOLDS);
	const groupFoldsRef = useRef<GroupFolds>(NO_GROUP_FOLDS);
	// The two Main sections expand independently (ADR 0019): both stay open by
	// default, and `x` collapses the one under the cursor to free rows for
	// the other. The unified selection is the item the shared detail pane
	// renders, whatever section its row comes from.
	const [ticketsExpanded, setTicketsExpanded] = useState(true);
	const ticketsExpandedRef = useRef(true);
	const [consultationsExpanded, setConsultationsExpanded] = useState(true);
	const consultationsExpandedRef = useRef(true);
	// The Work section is always visible (ADR 0049): it keeps its header row
	// while it is empty, the way the Ticket and Consultation sections do. The
	// section starts expanded: its list is the answer to "what starts next",
	// and the section is always on the Main view.
	const [workExpanded, setWorkExpanded] = useState(true);
	const workExpandedRef = useRef(true);
	// The queue pause (ADR 0052): factory state on the state file, shown on
	// the Work section's header beside the depth it holds.
	const [queuePaused, setQueuePaused] = useState(false);
	const queuePausedRef = useRef(false);
	queuePausedRef.current = queuePaused;
	const [selection, setSelection] = useState<"ticket" | "consultation" | "queue">("ticket");
	const selectionRef = useRef<"ticket" | "consultation" | "queue">("ticket");
	// The queue row under the unified cursor, kept like the Consultation's:
	// the section re-expands on the same row it left.
	const [workQueueIndex, setWorkQueueIndex] = useState(0);
	const workQueueIndexRef = useRef(0);
	const [workQueueDetailScroll, setWorkQueueDetailScroll] = useState(0);
	const workQueueDetailScrollRef = useRef(0);
	const [consultations, setConsultations] = useState<Consultation[]>(
		() => state?.consultationRecord.consultations("open") ?? [],
	);
	// The Consultation records the machine holds (issue #201, story 14): every
	// record that is not closed, whatever the section's History filter shows.
	// The Section header's attention counts read these, so the header never
	// reads `recovery: 0` while a record still needs recovery, and a cycle of
	// `f` moves no count.
	const [machineConsultations, setMachineConsultations] = useState<Consultation[]>(
		() => state?.consultationRecord.consultations("open") ?? [],
	);
	const consultationsRef = useRef(consultations);
	const [consultationIndex, setConsultationIndex] = useState(0);
	const consultationIndexRef = useRef(0);
	const [historyFilter, setHistoryFilter] = useState<"open" | "closed" | "all">("open");
	const historyFilterRef = useRef<"open" | "closed" | "all">("open");
	// The Ticket section's List filter (ADR 0060): one of ADR 0036's session view
	// facts, beside the Consultation section's history filter. It is a view, not
	// factory state, and it opens on the active rows at every boot: a restart
	// never greets the operator with the pile they dismissed.
	const [ticketFilter, setTicketFilter] = useState<TicketListFilter>("active");
	const ticketFilterRef = useRef<TicketListFilter>("active");
	// The one list read's other views, kept beside the drawn rows: the active
	// view every machine read and the section's counts take, and the projection
	// before the list rule every read that resolves a Ticket by identity takes.
	const listViewsRef = useRef(listViews);
	listViewsRef.current = listViews;
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
	// The selected Consultation's Session view rows, read from the Agent's
	// session record at the pane's own pace (ADR 0025). Null means the last
	// read was unavailable, and the detail shows the terminal body instead.
	const [sessionEntries, setSessionEntries] = useState<readonly SessionEntry[] | null>(null);
	const [consultationScroll, setConsultationScroll] = useState(0);
	const consultationFollowRef = useRef(true);
	const [newOutput, setNewOutput] = useState(false);
	const [bell, setBell] = useState(false);
	// The held-turn bell: it rings the moment a held count rises, so a turn
	// that failed while the operator looked away gets their attention.
	const [heldBell, setHeldBell] = useState(false);
	const heldCountRef = useRef<number | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selectedIndexRef = useRef(0);
	/**
	 * The Ticket the detail pane last showed, by identity (issue #159).
	 *
	 * A Group header holds no Ticket, and the pane keeps the ticket the operator
	 * was reading while the cursor rests on a header. Only the identity is kept,
	 * so the pane always paints the facts of the current read.
	 */
	const detailTicketIdentityRef = useRef<string | null>(null);
	/**
	 * The Ticket the detail pane shows, kept in a ref the key handlers read.
	 *
	 * `ticketAtCursor`, defined below, reads this ref, and the render writes it
	 * further below still, after that read. So a render asks the pane what the
	 * previous render left there. Only one path reaches the read: a collapsed
	 * Ticket section, whose cursor stands on no row the operator can see. There
	 * the answer is the ticket the pane already shows, which is the fact the ref
	 * exists to hold, and it is stable from the next frame: a collapsed section
	 * moves no cursor, so nothing but a re-read that drops the ticket can move
	 * the value. The write stands in the render body rather than in an effect, so
	 * a key handler never reads a value one commit behind the frame on screen.
	 */
	const detailTicketRef = useRef<Ticket | undefined>(undefined);
	/**
	 * The Ticket under the cursor, read through the refs, so a render and a key
	 * handler see the same fact (issue #159).
	 *
	 * A Group header holds no Ticket, so every Ticket control answers it with
	 * the catalogue's own words for no selection. A collapsed Ticket section
	 * draws no list at all, so its cursor's row is the Section's boundary and
	 * names nothing the operator can see: the controls then keep working on the
	 * Ticket the detail pane shows, exactly as they did before grouping.
	 */
	const ticketAtCursor = (): Ticket | undefined => {
		const row = ticketRowsRef.current[selectedIndexRef.current];
		if (row !== undefined && row.kind === "item") return row.item.ticket;
		return ticketsExpandedRef.current ? undefined : detailTicketRef.current;
	};
	const configRef = useRef(config);
	configRef.current = config;
	ticketsExpandedRef.current = ticketsExpanded;
	groupingAxisRef.current = groupingAxis;
	groupFoldsRef.current = groupFolds;
	consultationsExpandedRef.current = consultationsExpanded;
	workExpandedRef.current = workExpanded;
	selectionRef.current = selection;
	workQueueIndexRef.current = workQueueIndex;
	workQueueDetailScrollRef.current = workQueueDetailScroll;
	historyFilterRef.current = historyFilter;
	ticketFilterRef.current = ticketFilter;
	// The Work queue read in queue order (ADR 0034): the manual starts waiting
	// for a Parallel limit seat. It follows the other two projections: one read
	// into UI state, re-read on the refresh every change ends in - the dispatch
	// module's own report for an enqueue, a pickup, and a cancel it made, and the
	// App's own re-read for the reorder and the cancel the operator asked for.
	// The render never queries the state.
	const [workQueue, setWorkQueue] = useState<readonly WorkQueueItem[]>(
		() => state?.workQueue.items() ?? [],
	);
	const workQueueRef = useRef<readonly WorkQueueItem[]>(workQueue);
	workQueueRef.current = workQueue;
	/**
	 * The Ticket one identity names, whatever the list shows (ADR 0042, ADR 0060).
	 *
	 * The reads that resolve a Ticket by identity - a Work queue row naming the
	 * ticket its start waits for, an open panel following its Ticket across a
	 * refresh, the route's position, a confirmed override - ask the projection
	 * before the list rule, never the drawn rows. A row the list rule withholds
	 * is still the Ticket the operator named, so it keeps its title, its pane,
	 * and its placement facts instead of falling back to a raw identity or
	 * closing the screen that shows it.
	 */
	// The callback is stable on purpose: it reads the projection through the ref,
	// so a surface that takes it as an effect dependency re-runs on the facts it
	// watches, not on every render.
	const findTicket = useCallback(
		(identity: string): Ticket | undefined => listViewsRef.current.projection.rowFor(identity),
		[],
	);
	// The row the list draws: the item's ticket by its title while the ticket
	// is still in the projection, by its identity once it is gone, and the
	// Consultation's item by the record's identity prefix (ADR 0034, issue #90).
	const workQueueRows: readonly WorkQueueRow[] = workQueue.map((item) => ({
		item,
		title:
			item.kind === "consultation"
				? item.consultationId.slice(0, 8)
				: // The projection before the list rule (ADR 0042, ADR 0060): a waiting
					// start of an ignored or covered Ticket still names its ticket, not
					// the raw identity the row would fall back to.
					(findTicket(item.ticketIdentity)?.title ?? item.ticketIdentity),
		...(item.kind === "plane-action"
			? { method: planeActionSettingOf(configRef.current.taskTypes, item.taskType)?.method }
			: {}),
	}));
	// The cursor never rests on a queue that no longer holds its row: a pickup
	// or a cancel that empties the section sends the selection home, and the
	// retained index clamps to the rows that remain. The bounce fires on the
	// emptying step alone: a focus the operator lands on a queue that is
	// already empty stays where they put it, the way the other sections' empty
	// lists do, where the empty message is the row the cursor rests on (ADR 0049).
	const workQueueWasNonEmptyRef = useRef(workQueue.length > 0);
	useEffect(() => {
		const wasNonEmpty = workQueueWasNonEmptyRef.current;
		workQueueWasNonEmptyRef.current = workQueue.length > 0;
		if (workQueue.length === 0 && selection === "queue" && wasNonEmpty) {
			selectionRef.current = "ticket";
			setSelection("ticket");
		}
		const last = Math.max(0, workQueue.length - 1);
		if (workQueueIndexRef.current > last) {
			workQueueIndexRef.current = last;
			setWorkQueueIndex(last);
		}
	}, [workQueue.length, selection]);
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
	const [healths, setHealths] = useState(() => state?.sourceFact.sourceHealths() ?? []);
	const [panel, setPanel] = useState<Panel>(null);
	// The queue behind a queued init (ADR 0083): the entries waiting for
	// their turn stand in the ref, not in state, because no surface renders
	// them - the confirmation panel names only the entry under review.
	const repositoryInitQueue = useRef<RepositoryInitQueue | null>(null);
	// The repository whose init plans right now (ADR 0083): the plan runs
	// async with the base view's keyboard live, and the operator must not
	// start a second init the first would then overwrite.
	const repositoryInitInFlight = useRef<string | null>(null);
	// Refuse a new init while one plans: the line names the init that holds.
	const refuseInitInFlight = (): boolean => {
		const inFlight = repositoryInitInFlight.current;
		if (inFlight === null) return false;
		setErrorMessage(`the init for ${inFlight} is running`);
		return true;
	};
	/**
	 * The Live view's stream: the lines of the last pane read, and the stale
	 * note while the latest read failed. Null while no stream runs.
	 */
	const [liveStream, setLiveStream] = useState<{
		lines: readonly string[];
		note: string | null;
	} | null>(null);
	// The Auto-handoff mode is factory state (ADR 0036): the plane reads the
	// operator's last choice back from the state file, so a restart or a dev
	// reload finds the mode where it was left. A plane with no state has no
	// durable mode to read, and starts with the mode off.
	const [autoMode, setAutoMode] = useState<boolean>(
		() => state?.handoff.autoHandoffMode() ?? false,
	);
	const autoModeRef = useRef(autoMode);
	const [agents, setAgents] = useState<readonly HerdrAgent[] | null>(null);
	// The key handler outlives the render that made the decision it acts on,
	// so the marker it re-checks reads the latest list through a ref.
	const agentsRef = useRef<readonly HerdrAgent[] | null>(null);
	agentsRef.current = agents;
	// The observation loop, held in a ref the seat count reads (ADR 0021).
	// The loop is the plane's only herdr reader, and its poll is the fact the
	// Parallel limit counts against, so the ref stands beside the count that
	// reads it.
	const observationRef = useRef<ObservationCoordinator | undefined>(undefined);
	// The last poll as the fact record the fact module reads (issue #201). The
	// render turns the list into the poll once, and every fact read of the
	// render - the rows, the detail pane, a key handler's refusal - takes that
	// one record instead of rebuilding it.
	const pollRef = useRef<AgentPoll | null>(null);
	pollRef.current = agentPoll(agents);
	/**
	 * The one count the Parallel limit reads (issue #87, ADR 0034): the shared
	 * seat count of the in-flight tickets, the in-progress handoffs, and the
	 * Consultations in `opening` or `working`, from the latest herdr poll. The
	 * dispatch module gates a manual start on it, the observation loop gates the
	 * automatic starts on the same facts each cycle, and the Ticket header's mode
	 * cell displays it, so the three never disagree.
	 *
	 * The tickets and their Agent names each arrive in one batched read (issue
	 * #202, ADR 0095): the count costs a constant number of statements whatever
	 * the file holds, never a lookup per in-flight Ticket.
	 */
	const currentSeatCount = (): number => {
		if (state === undefined) return 0;
		const inFlight = state.ticketWorkCycle.ticketsByState(TICKET_SEAT_STATES);
		const names = state.ticketWorkCycle.agentNamesForTickets(
			inFlight.map((ticket) => ticket.ticketIdentity),
		);
		return parallelSeatCount({
			tickets: inFlight.map((ticket) => ({
				ticketIdentity: ticket.ticketIdentity,
				paneId: ticket.paneId,
				startedAt: ticket.startedAt,
				agentName: names.get(ticket.ticketIdentity) ?? "",
			})),
			handoffAttemptTickets: state.handoff.openAttemptTickets(),
			consultations: state.consultationRecord
				.consultationsByState(CONSULTATION_SEAT_STATES)
				.map((consultation) => ({ state: consultation.state })),
			agents: observationRef.current?.lastAgents() ?? null,
			now: Date.now(),
			startupGraceMs: STARTUP_GRACE_MS,
		});
	};
	// The herdr seat: one external change to a ticket's environment at a time.
	// A handoff holds it while herdr builds the environment and starts the
	// agent. Close cleanups queue behind that work, and a queued cleanup
	// reserves the seat until every earlier cleanup ends.
	// The no-state test projection has no durable claim or queue. The real
	// dispatch module owns the seat for every state-backed app.
	const noStateHandoffInFlightRef = useRef(false);
	// The tickets this run claimed and has not yet settled in a handoff
	// (ADR 0030): the Starting window the row's spinner face reads. The
	// dispatch module reports the add on the claim and the remove on the
	// settle, so the set is per run: a restart starts empty, and the
	// unresolved attempt a crashed run left behind is never in it.
	const [startingTickets, setStartingTickets] = useState<ReadonlySet<string>>(() => new Set());
	// The key handlers outlive the render that made the set, so the marker they
	// check reads the latest set through the ref.
	const startingTicketsRef = useRef(startingTickets);
	startingTicketsRef.current = startingTickets;
	/**
	 * The screen's inputs, read once (issue #201). The fact module answers the
	 * row's facts from them, so the row, the detail pane, and the ignore key's
	 * refusal state one fact and cannot disagree.
	 */
	// The fact module's inputs, read from the refs so the fact answers stay the
	// same across renders (issue #201). The screen keeps the state; the fact
	// module owns the rules the state is read through.
	const factInputs = useCallback(
		(): TicketFactInputs => ({
			maxHandoffsPerTicket: configRef.current.maxHandoffsPerTicket,
			poll: pollRef.current,
			claims: startingTicketsRef.current,
			queue: workQueueRef.current,
		}),
		[],
	);
	/** The rows' facts, read through the fact module: the values the surface wears. */
	const factRows = useCallback(
		(tickets: readonly Ticket[]): readonly TicketRowFacts[] =>
			ticketRowFacts(factInputs(), tickets),
		[factInputs],
	);
	/** The facts one Ticket wears, read through the fact module. */
	const factsFor = useCallback(
		(ticket: Ticket): TicketRowFacts => ticketFactsFor(ticket, factInputs()),
		[factInputs],
	);

	// The init marker a repository Group header wears (ADR 0075, stories 19 and
	// 22): `uninit` where the plane has not init'd the repository, `drift` where
	// it init'd it under settings that have since changed, and nowhere where the
	// stored fact matches the current settings. The display name the axis groups
	// on maps to the identity the fact keys on through a ticket the Group holds.
	// On every axis but repository the marker is absent, so the column never
	// stands where the init does not act.
	// The current settings' hash, computed once per render so the marker below
	// compares each Group's fact against it without re-hashing the config per
	// Group (ADR 0075): the hash moves only when the config does.
	const currentInitHash = repositoryInitSettingsHash(config.workflowStates, config.taskTypes);
	const repositoryInitMarkerOf = (value: string): string | null => {
		if (groupingAxis !== "repository") return null;
		const ticket = tickets.find((item) => item.repository === value);
		const identity = ticket?.repositoryRef.identity ?? value;
		const fact = state === undefined ? null : state.repositoryInit.repositoryInitFact(identity);
		return repositoryInitStanding(fact, currentInitHash);
	};
	/**
	 * The Ticket section's list rows: each Ticket's facts, and the Group header
	 * above each run the axis in effect makes (issue #159).
	 *
	 * The cursor, the window, the mouse hit test, and the Action bar all read
	 * this one list, so a Group header costs a row and takes the cursor exactly
	 * like a ticket does. `none` draws the tickets alone in the flat list's
	 * order, which is the list exactly as it stood before grouping.
	 */
	const ticketRowsState: readonly ListedRow<TicketRowFacts>[] = ticketRows(
		factRows(tickets),
		groupingAxis,
		groupFolds,
		groupOrderList,
		positionOrderOf(),
		repositoryInitMarkerOf,
	);
	const ticketRowsRef = useRef<readonly ListedRow<TicketRowFacts>[]>(ticketRowsState);
	ticketRowsRef.current = ticketRowsState;
	const handoffDispatchRef = useRef<
		{ state: HandoffDispatchAggregates; dispatch: HandoffDispatch } | undefined
	>(undefined);
	const coordinatorRef = useRef<RefreshCoordinator | undefined>(undefined);
	const configWriteQueue = useRef(Promise.resolve());
	// The selected Agent pane's refresh, callable the moment a forwarded
	// input lands: the operator should not wait out the refresh interval.
	const outputRefreshRef = useRef<(() => void) | null>(null);
	const commandRunner = runner ?? realRunner();
	const homeDir = home ?? os.homedir();
	const configFile = configPath ?? defaultConfigPath();
	/**
	 * The Ticket sources this run polls.
	 *
	 * The entry binds the config's feeds at boot and hands them in, and that
	 * binding is the whole live set only until the config gains a feed. The
	 * Repository init registers one (ADR 0075), and a source that stands in the
	 * config with no bound instance is bound here through the entry's own rule,
	 * so the plane starts fetching it in this run instead of at the next
	 * restart. An injected instance stands for the definition it names, so a
	 * test's fake stays the source the coordinator polls, and a source the
	 * harness injects beside the config keeps its place.
	 */
	const liveSources = useMemo<readonly TicketSource[]>(() => {
		const bound = new Set(sources.map((source) => source.name));
		return [
			...sources,
			...config.sources
				.filter((definition) => !bound.has(definition.name))
				.map((definition) => createTicketSource(definition, commandRunner)),
		];
	}, [sources, config.sources, commandRunner]);
	// The plane's out-of-band attention (ADR 0080): the terminal bell and the
	// desktop notification of a standing warning or error fact, one service
	// the app creates once per run from the config and the command runner.
	// The config getter keeps both gates reading the config the app holds
	// current, and the logger, where there is one, is the record a failed
	// send leaves a line in.
	const attention = useMemo(
		() => new AttentionService(() => configRef.current, commandRunner, { logger }),
		[commandRunner, logger],
	);
	// A stale source is a failed refresh the operator must answer to. A
	// removed source is the operator's own config decision: the plane stops
	// reading it and pins no line for it, while its in-flight tickets keep
	// showing with the removed membership.
	const sourceHealthMessage = healths
		.filter((health) => health.health === "stale")
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
		// The Theme the control plane paints in, resolved once for the run: the
		// herdr theme when the app runs inside herdr, the standalone dark theme
		// otherwise (ADR 0024). A fallback lands on the Message line as a
		// notice: it never pins the line, so real news takes over.
	} = useMessageFacts(
		sourceHealthMessage === "" ? undefined : sourceHealthMessage,
		currentThemeResolution().warning ?? undefined,
		attention,
	);
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
	/**
	 * Auto copy: the renderer runs the mouse selection the operator drags (left
	 * press starts it, the drag extends it, the release ends it), and it names
	 * the ended selection on one event. The shell copies the ended selection's
	 * text through the renderer's OSC 52 write - the same write a field's
	 * keyboard Copy control uses - so a drag release over any surface reaches
	 * the system clipboard without a setting. A click that did not drag ends an
	 * empty selection and runs nothing, and a copy that takes is silent: only a
	 * write the terminal refused states the shared warning on the Message line.
	 * The ended selection is cleared where the copy is made, so the highlight
	 * never outlives the copy it produced.
	 */
	useEffect(() => {
		const onSelection = (selection: Selection | null): void => {
			if (selection === null) return;
			const text = selection.getSelectedText();
			// The drag ended and the copy ran or was refused, so the highlight is
			// done: drop it instead of leaving it painted until the next click.
			renderer.clearSelection();
			if (text === "") return;
			if (!renderer.copyToClipboardOSC52(text)) setWarningMessage(COPY_REFUSED_REASON);
		};
		renderer.on("selection", onSelection);
		return () => {
			renderer.off("selection", onSelection);
		};
	}, [renderer, setWarningMessage]);
	const visibleMessageText = visibleMessage === null ? "" : formatMessage(visibleMessage);
	const messageTruncated = visibleMessage !== null && widthOf(visibleMessageText) > terminalWidth;
	// The Ticket header's mode cell carries the auto-handoff state and the
	// Parallel limit seat count: the same shared seat count the observation
	// gates and the dispatch gate read (issue #87, ADR 0034) - the in-flight
	// tickets the latest successful poll listed or still holds in their startup
	// grace, every in-progress handoff, and every Consultation in opening or
	// working - against the parallel limit. It exists only when the control
	// plane has state to observe.
	const liveCount = currentSeatCount();
	// The Dispatch pause (ADR 0016): a held failed trace holds the automatic
	// handoffs, routes, and restarts until it is decided or a turn completes.
	const dispatchPause = state?.ticketWorkCycle.dispatchPauseActive() ?? false;
	const autoHandoffCell =
		state === undefined
			? null
			: {
					mode: autoMode ? ("auto" as const) : ("manual" as const),
					seats: liveCount,
					limit: config.maxParallelAgents,
					// The gate's answer, from the one rule the dispatch gates read: the header's
					// seat color and a force-dispatch refusal cannot disagree about the cap.
					overLimit: overParallelLimit(config.maxParallelAgents, liveCount),
					dispatchPaused: autoMode && dispatchPause,
				};
	// The held turns (ADR 0016, ADR 0017): the awaiting tickets whose last turn
	// ended failed, aborted, truncated, or no-turn with no decision, read
	// through the domain's one rule so this count and a Group header's agree.
	// They rest in awaiting, held against every automatic decision, until the
	// operator acts. A ticket whose agent works again has left awaiting and is no
	// longer held (its next settle overwrites the trace). The count reads the
	// active view beside every other header count, so an ignored Ticket that owes
	// a decision is counted the moment its row returns, and a List filter cycle
	// never moves the baseline the bell compares against (ADR 0060).
	// The header's counts, answered by the fact module from the active view
	// (issue #201). The header takes them as values.
	const headerFacts = sectionFacts({
		tickets: machineTickets,
		consultations: machineConsultations,
		queue: workQueue,
		ignored: listViews.ignored.length,
		muted: listViews.muted.length,
	});
	const heldCount = headerFacts.ticket.held;
	const openCount = headerFacts.ticket.open;
	const runningCount = headerFacts.ticket.inFlight;
	const awaitingCount = headerFacts.ticket.awaiting;
	const ignoredCount = headerFacts.ticket.ignored;
	const mutedCount = headerFacts.ticket.muted;
	// The held count the bell compares against: a rise rings the terminal bell
	// and flashes the Tickets header, a fall or a steady count does not.
	useEffect(() => {
		if (heldBellRang(heldCountRef.current, heldCount)) {
			// The flash stays here; the bell write and its attention-bell gate
			// live in the shared attention service (ADR 0080).
			setHeldBell(true);
			setTimeout(() => setHeldBell(false), 250);
			attention.ring();
		}
		heldCountRef.current = heldCount;
	}, [heldCount, attention]);

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
	// The Main view keeps the permanent Message line and Action bar. The mode
	// cell rides the Ticket header's own row, so the frame spends no row on it.
	// Keep the compact size frame focused on its size and Help controls when it
	// cannot show the normal layout.
	// The body holds every row between the Ticket header and the two permanent
	// bottom rows (ADR 0019). Its first row is the Ticket section's header, run
	// the full terminal width, so its counts stay whole on a small terminal;
	// below it the left column stacks the Ticket list and the Consultation
	// section's header and list, and the right column holds the one detail pane
	// for the selected item.
	const bodyRows = terminalHeight - 2;
	const leftCols = Math.floor(terminalWidth / 2);
	// The detail pane starts one row below the body's top: the full-width Ticket
	// header owns the body's first row, so the reservation holds that row with
	// the two permanent bottom rows.
	const detailReservedRows = 3;
	const detailGeometry = usePaneGeometry("detail", detailReservedRows);
	// The rows a section's box spends on chrome: two borders and two padding
	// rows. Each section's minimum is three content rows, so its minimum box
	// is seven rows: the three sections at their minimum cost twenty-one box
	// rows beside their three header rows, and the minimum terminal holds
	// exactly that (ADR 0049).
	const SECTION_BOX_CHROME = 4;
	const MIN_SECTION_BOX_ROWS = 3 + SECTION_BOX_CHROME;
	// The Work section is always visible (ADR 0049): it keeps its header row
	// while it is empty, the way the Ticket and Consultation sections do, so
	// the frame floor holds three sections now.
	const sectionOpen: Record<"tickets" | "consultations" | "work", boolean> = {
		tickets: ticketsExpanded,
		consultations: consultationsExpanded,
		work: workExpanded,
	};
	let ticketsBoxRows = 0;
	let consultationsBoxRows = 0;
	let workBoxRows = 0;
	if (!tooSmall) {
		const openKeys = (["tickets", "consultations", "work"] as const).filter(
			(key) => sectionOpen[key],
		);
		if (openKeys.length > 0) {
			// The section under the cursor takes the remaining rows after the
			// other open sections claim their minimum; at the minimum frame
			// every open section holds its minimum. A collapsed section keeps
			// its header as the row it expands from, so the headers count
			// against the body's rows before the boxes split them.
			// The three sections each hold a header row at the floor (ADR 0049).
			const total = Math.max(0, bodyRows - 3);
			const cursorKey =
				selection === "ticket"
					? "tickets"
					: selection === "consultation"
						? "consultations"
						: "work";
			const take: Partial<Record<"tickets" | "consultations" | "work", number>> = {};
			let remaining = total;
			for (const key of openKeys) {
				if (key === cursorKey) continue;
				const claim = Math.min(
					MIN_SECTION_BOX_ROWS,
					Math.max(0, Math.floor(remaining / openKeys.length)),
				);
				take[key] = claim;
				remaining -= claim;
			}
			if (openKeys.includes(cursorKey)) {
				take[cursorKey] = Math.max(0, remaining);
			} else {
				// The cursor's section is not open (the queue emptied under
				// the cursor): the last open section takes the remainder.
				const last = openKeys[openKeys.length - 1];
				take[last] = (take[last] ?? 0) + Math.max(0, remaining);
			}
			ticketsBoxRows = take.tickets ?? 0;
			consultationsBoxRows = take.consultations ?? 0;
			workBoxRows = take.work ?? 0;
		}
	}
	const ticketsContentRows = ticketsExpanded ? Math.max(1, ticketsBoxRows - SECTION_BOX_CHROME) : 0;
	const consultationsContentRows = consultationsExpanded
		? Math.max(1, consultationsBoxRows - SECTION_BOX_CHROME)
		: 0;
	const workContentRows = workExpanded ? Math.max(1, workBoxRows - SECTION_BOX_CHROME) : 0;
	// The detail pane keeps the last Ticket it showed while the cursor stands on
	// a Group header (issue #159), so the pane never blanks out under an
	// operator who is reading a ticket and stepping across a fold. The identity
	// is what is retained, so the facts the pane states stay the live read.
	// The read of `detailTicketRef` inside `ticketAtCursor` takes the value the
	// previous render wrote: see that ref's declaration for why the order is the
	// one this pane wants.
	const cursorTicket = ticketAtCursor();
	if (cursorTicket !== undefined) detailTicketIdentityRef.current = cursorTicket.identity;
	const detailTicket =
		cursorTicket ??
		(detailTicketIdentityRef.current === null
			? undefined
			: tickets.find((ticket) => ticket.identity === detailTicketIdentityRef.current));
	// The Scroll control's availability must agree with the native detail's own
	// overflow, so it asks the pane for the measurement rather than repeating
	// the pane's gutter rule here.
	const detailMaxScroll = detailScrollRoom(
		detailTicket === undefined ? undefined : factsFor(detailTicket),
		detailGeometry.usableCols,
		detailGeometry.visibleRows,
		config.maxHandoffsPerTicket,
		detailTicket === undefined || state === undefined
			? null
			: state.planeAction.latestPlaneActionAttempt(detailTicket.identity),
	);
	// The write of the render's own answer, for the next render and for the key
	// handlers; the read above is the one this frame's pane paints with.
	detailTicketRef.current = detailTicket;
	const selectedTicket = detailTicket;
	// The Consultation the shared detail pane points at: the one under the
	// unified cursor. None while the cursor is on the Ticket list, so the
	// detail renders the ticket and no polling runs for a Consultation the
	// operator is not looking at. The Consultation list keeps its own
	// retained index either way, so re-expanding or crossing back resumes on
	// the same row.
	const selectedConsultation =
		selection === "consultation" ? consultations[consultationIndex] : undefined;
	// The status the observation last reported for the selected Consultation's
	// Agent pane: it gates the response editor and the interaction mode.
	const selectedConsultationAgentStatus =
		selectedConsultation === undefined || selectedConsultation.paneId === null || agents === null
			? null
			: normalizeAgentStatus(
					agents.find((agent) => agent.paneId === selectedConsultation.paneId)?.status ?? "unknown",
				);
	// Whether herdr's last poll still reports the selected Consultation's
	// Agent pane alive: Goto focuses that pane, so it needs it (ADR 0025).
	const selectedConsultationPaneAlive =
		typeof selectedConsultation?.paneId === "string" &&
		agents?.some((agent) => agent.paneId === selectedConsultation.paneId) === true;
	// The same fact for the selected Ticket's handoff pane (ADR 0033): Goto
	// focuses that pane, so an in-flight Ticket needs it alive in the last
	// poll. An awaiting Ticket keeps its recorded pane instead. The pane is
	// alive for the ticket only when the ticket's own agent is alive in it:
	// herdr hands a closed pane's id out again, so a different agent in the
	// id leaves the pane as missing, the way an empty one does.
	const selectedTicketPaneId = selectedTicket?.handoff?.paneId ?? null;
	const selectedTicketPaneAgent =
		selectedTicketPaneId === null
			? undefined
			: agents?.find((agent) => agent.paneId === selectedTicketPaneId);
	const selectedTicketPaneAlive =
		selectedTicket !== undefined &&
		selectedTicketPaneAgent !== undefined &&
		ticketAgentIdentity(selectedTicket, selectedTicketPaneAgent) !== "foreign";
	// The recorded pane holds a live agent that is not the ticket's own: herdr
	// handed the closed pane's id out again. Goto must not focus that pane for
	// the ticket - not on an in-flight ticket, whose missing marker the fact
	// already carries, and not on an awaiting ticket, whose recorded pane the
	// catalogue otherwise keeps (ADR 0033).
	const selectedTicketPaneForeign =
		selectedTicket !== undefined &&
		selectedTicketPaneAgent !== undefined &&
		ticketAgentIdentity(selectedTicket, selectedTicketPaneAgent) === "foreign";
	const consultationTurns =
		selectedConsultation === undefined || state === undefined
			? []
			: state.consultationRecord.consultationTurns(selectedConsultation.id);
	const consultationSnapshots =
		selectedConsultation === undefined || state === undefined
			? []
			: state.consultationRecord.consultationSnapshots(selectedConsultation.id);
	const replacementIds =
		selectedConsultation === undefined || state === undefined
			? []
			: state.consultationRecord
					.consultations("all")
					.filter((item) => item.replacementOf === selectedConsultation.id)
					.map((item) => item.id);
	const consultationWidth = detailGeometry.usableCols;
	const remainingResources =
		selectedConsultation === undefined ||
		state === undefined ||
		selectedConsultation.state !== "closed"
			? []
			: state.consultationRecord.consultationRemainingResources(selectedConsultation.id);
	// The body the detail stands under (ADR 0025): the Session view reads
	// from the Agent's record, the Agent view from the terminal. Interaction
	// mode shows the live screen, which is the Agent view.
	const consultationBody = consultationDetailBody(
		selectedConsultation,
		interaction ? null : liveOutput,
		interaction ? null : sessionEntries,
	);
	const consultationLines = consultationDetailLines(
		selectedConsultation,
		consultationTurns,
		consultationSnapshots,
		consultationWidth,
		interaction ? null : liveOutput,
		interaction ? null : sessionEntries,
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
	// The Work queue's detail pane (ADR 0034): the facts of the item under the
	// cursor - its ticket, its origin, its place in the queue, the choice it
	// captured, and the message the start would carry in. The shared line
	// pane scrolls it, like the Consultation detail.
	const selectedWorkQueueRow = workQueueRows[workQueueIndex];
	// A Consultation item's facts stand on the record it names (ADR 0034,
	// issue #90), so the pane reads the record from the Consultation
	// projection the app holds, the way the Consultation detail reads its
	// own.
	const selectedWorkQueueConsultationId =
		selectedWorkQueueRow !== undefined && selectedWorkQueueRow.item.kind === "consultation"
			? selectedWorkQueueRow.item.consultationId
			: undefined;
	const selectedWorkQueueRecord =
		selectedWorkQueueConsultationId === undefined
			? undefined
			: consultations.find((record) => record.id === selectedWorkQueueConsultationId);
	const queueDetailLines = workQueueDetailLines(
		selectedWorkQueueRow,
		workQueueRows.length,
		selectedWorkQueueRecord,
	);
	const workQueueDetailMaxScroll = maxScrollOf(queueDetailLines.length, detailGeometry.visibleRows);
	const workQueueDetailClampedScroll = Math.min(workQueueDetailScroll, workQueueDetailMaxScroll);
	const replaceTickets = useCallback(() => {
		if (state === undefined) return;
		const currentConfig = configRef.current;
		// One projection read serves the drawn rows, the active view the section's
		// counts and the held bell take, the pile the header names, and the
		// projection before the list rule the identity reads take. The list orders
		// the open state by the ticket's own task type, then the newest external
		// update (ADR 0050); the Ticket section's List filter decides which rows the
		// operator sees (ADR 0060), and no other read follows it.
		const next = state.ticketWorkCycle.ticketListViews(
			currentConfig.workflowStates,
			currentConfig.defaultTaskType,
			ticketFilterRef.current,
		);
		const currentIndex = selectedIndexRef.current;
		const anchor = rowAnchorOf(ticketRowsRef.current, currentIndex);
		const nextFacts = factRows(next.rows);
		const nextRows = ticketRows(
			nextFacts,
			groupingAxisRef.current,
			groupFoldsRef.current,
			groupOrderListRef.current,
			positionOrderOf(),
		);
		// The cursor keeps the ticket it held through a re-read and through a change
		// of the operator's List filter; a ticket that left the row list lands the
		// cursor on the row nearest the one it held (issue #159, user story 43).
		const nextIndex = ticketRowIndexForAnchor(
			nextRows,
			anchor,
			currentIndex,
			nextFacts,
			groupingAxisRef.current,
		);
		listViewsRef.current = next;
		ticketsRef.current = next.rows;
		ticketRowsRef.current = nextRows;
		selectedIndexRef.current = nextIndex;
		setListViews(next);
		setHealths(state.sourceFact.sourceHealths());
		setSelectedIndex(nextIndex);
		// The Work queue rides on the same re-read: an enqueue, a pickup, and a
		// removal all report their refresh through here, so the section never
		// shows a row the durable queue no longer holds.
		setWorkQueue(state.workQueue.items());
	}, [state, positionOrderOf, factRows]);
	const replaceConsultations = useCallback(() => {
		if (state === undefined) return;
		const filter = historyFilterRef.current;
		const next = state.consultationRecord.consultations(filter);
		// The header's counts read the machine's records, not the drawn list
		// (story 14). On the open filter the two reads are the same list, so
		// the common case costs one query.
		const machine = filter === "open" ? next : state.consultationRecord.consultations("open");
		const currentIndex = consultationIndexRef.current;
		const selectedId = consultationsRef.current[currentIndex]?.id;
		const preserved =
			selectedId === undefined ? -1 : next.findIndex((item) => item.id === selectedId);
		const nextIndex =
			preserved >= 0 ? preserved : Math.max(0, Math.min(currentIndex, next.length - 1));
		consultationsRef.current = next;
		consultationIndexRef.current = nextIndex;
		setConsultations(next);
		setMachineConsultations(machine);
		setConsultationIndex(nextIndex);
		if (selectedId === undefined || !next.some((item) => item.id === selectedId)) {
			setConsultationScroll(0);
			consultationFollowRef.current = true;
			setLiveOutput(null);
			setSessionEntries(null);
		}
	}, [state]);
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
		// agent. A ticket on a parking state suggests nothing, and the plane
		// starts nothing on its own: this manual path is the operator's choice,
		// so it prefills the default task type (ADR 0027).
		return resolveHandoffChoice(
			configRef.current,
			ticket.suggestedTaskType ?? configRef.current.defaultTaskType,
		);
	};

	const persistMapping = async (
		mapping: RepositoryMapping,
	): Promise<ConfigWriteReport | undefined> => {
		const write = configWriteQueue.current
			.catch(() => undefined)
			.then(async (): Promise<ConfigWriteReport | undefined> => {
				try {
					const currentConfig = configRef.current;
					const updated = {
						...currentConfig,
						repos: { ...currentConfig.repos, [mapping.repository]: mapping.path },
					};
					configRef.current = updated;
					setConfig(updated);
					// The write-back edits the `[repos]` key it owns and leaves the
					// rest of the operator's file where they put it (ADR 0103). The
					// line names the file the write landed on.
					const fact = await writeConfigFile(configFile, updated);
					const line = configWriteLine(fact, "saved the mapping");
					return line === "" ? undefined : { line, landed: true, mode: fact.mode };
				} catch (error) {
					return {
						line: `could not persist the repository mapping: ${errorMessage(error)}`,
						landed: false,
					};
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
	// The state is created once by factory.ts, and the other callbacks read
	// the current config and projections through refs.
	if (consultationOperationsRef.current === undefined && state !== undefined) {
		consultationOperationsRef.current = createConsultationOperations({
			state,
			runner: commandRunner,
			config: () => configRef.current,
			home: homeDir,
			// The rows the machine reads, never the operator's List filter (ADR 0060):
			// the live-checkout conflict read names the in-flight Ticket whose Agent
			// holds the checkout, and a Ticket the operator judged out of the list is
			// still live work the confirmation has to name.
			tickets: () => listViewsRef.current.active,
			// The one shared seat count the Parallel limit gate and the mode cell
			// read: the Consultation start line states the reading this seam
			// answers, measured before the start takes its own seat (issue #220).
			seatCount: currentSeatCount,
			log: logger,
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
				seatCount: currentSeatCount,
				// The Work queue's Consultation side (ADR 0034, issue #90): the
				// pickup crosses to the Consultation operations, which own the
				// record's settings re-read, its seat move, and its opening. The
				// module owns the seat and the queue's shared order. The `moved`
				// fallback stands only where the operations are absent - the
				// no-state test projection, where the module removes the item and
				// the still-`queued` record loses its pointer, and a removal of the
				// item through the module's seam moves the record to `unscheduled`
				// the way the Main view's Delete does (issue #91).
				pickupConsultation: (consultationId, mode) =>
					consultationOperationsRef.current?.pickup(consultationId, mode) ??
					Promise.resolve({ kind: "moved" } as const),
				home: homeDir,
				working: (text) => setWorkingMessage(text, "handoff"),
				warning: setWarningMessage,
				error: setErrorMessage,
				notice: setNoticeMessage,
				clearWorking: () => clearWorkingMessage("handoff"),
				refresh: replaceTickets,
				starting: (identity, active) => {
					setStartingTickets((current) => {
						if (current.has(identity) === active) return current;
						const next = new Set(current);
						if (active) next.add(identity);
						else next.delete(identity);
						return next;
					});
				},
				persistMapping,
				log: logger,
			}),
		};
	}
	const handoffDispatch = handoffDispatchRef.current?.dispatch;
	/**
	 * The Handoff dispatch is stopped when its owner leaves, never when the
	 * observation loop restarts.
	 *
	 * The module lives on the state, not on the loop that asks it (the same
	 * standing the `onReady` stop keeps), so the effect keys on the module the
	 * ref holds, which changes only when the state does. The observation effect
	 * re-runs on any fact its own body reads - a config the plane wrote back, a
	 * source list that moved - and a `stop` in that cleanup killed the module the
	 * next run of the same effect kept using. Every later ask then
	 * answered `the dispatch has been stopped` for the rest of the run: the
	 * automatic walks went silent, and the operator's own start, route, and
	 * Close were refused beside a mode cell that still read auto.
	 */
	useEffect(() => {
		if (handoffDispatch === undefined) return;
		return () => handoffDispatch.stop();
	}, [handoffDispatch]);
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
	 * Re-read the sources that list one ticket, now.
	 *
	 * Ending a work cycle can change the ticket's source item: the agent
	 * merged the pull request, or closed the issue. The ticket's membership
	 * still reads active on the stale fetch, so the cycle's end re-reads the
	 * sources at once: the fetch either confirms the ticket still wants work
	 * or drops it. The fetch's own completion already ticks the observation
	 * loop, so a re-verified ticket dispatches without waiting for the next
	 * poll, and a dropped one simply leaves the list.
	 */
	const refreshTicketSources = useCallback(
		(identity: string): void => {
			if (state === undefined) return;
			const coordinator = coordinatorRef.current;
			if (coordinator === undefined) return;
			for (const sourceName of state.sourceFact.membershipSourceNames(identity)) {
				coordinator.refreshNow(sourceName);
			}
		},
		[state],
	);
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
	const startHandoff = (ticket: Ticket, choice: HandoffChoice) => {
		const availability = availabilityFor(controlById("handoff"), mainFacts());
		if (!availability.available) {
			setWarningMessage(refusalReason(controlById("handoff"), mainFacts()));
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
		// ticket list by hand instead of reading it back from SQLite. It holds
		// no attempt ledger, so the ref plays the ledger's role (ADR 0064): the
		// shell refuses a second start while one stands in flight, the way the
		// state-backed claim refuses it. The Starting window (ADR 0030) is the
		// in-flight handoff itself here: the add lands on the keypress, and the
		// settle leaves the face to the `handed-off` state on a start and drops
		// it on a failure.
		if (noStateHandoffInFlightRef.current) {
			setWarningMessage("handoff in flight");
			return;
		}
		noStateHandoffInFlightRef.current = true;
		setStartingTickets((current) => {
			if (current.has(ticket.identity)) return current;
			const next = new Set(current);
			next.add(ticket.identity);
			return next;
		});
		setWorkingMessage(`handing off "${ticket.title}"...`, "handoff");
		void handOffTicket(ticket, choice, {
			config,
			runner: commandRunner,
			home: homeDir,
			claim: "open",
		})
			.then(async (outcome) => {
				setStartingTickets((current) => {
					if (!current.has(ticket.identity)) return current;
					const next = new Set(current);
					next.delete(ticket.identity);
					return next;
				});
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
						herdrName: outcome.agent.name,
					};
					// The in-memory shell holds one array and derives every view from
					// it, so a patch lands once and no view of the list rule is
					// remembered by hand here.
					setListViews((current) => {
						const next = inMemoryTicketViews(
							current.projection.rows.map((row: Ticket) =>
								row.identity === ticket.identity
									? { ...row, state: "handed-off" as const, handoff }
									: row,
							),
						);
						listViewsRef.current = next;
						ticketsRef.current = next.rows;
						return next;
					});
				}
				await finishOutcome(outcome);
				noStateHandoffInFlightRef.current = false;
			})
			.catch((error) => {
				setStartingTickets((current) => {
					if (!current.has(ticket.identity)) return current;
					const next = new Set(current);
					next.delete(ticket.identity);
					return next;
				});
				setErrorMessage(`handoff failed: ${errorMessage(error)}`);
				noStateHandoffInFlightRef.current = false;
			});
	};
	const openOverride = () => {
		const overrideControl = controlById("override");
		const availability = availabilityFor(overrideControl, mainFacts());
		if (!availability.available) {
			setWarningMessage(refusalText(overrideControl, availability));
			return;
		}
		const row = ticketRowsRef.current[selectedIndexRef.current];
		// A Group header holds no Ticket: the catalogue refused the key with its
		// own words before this ran (issue #159).
		if (row === undefined || row.kind !== "item") return;
		const ticket = row.item.ticket;
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
		// The projection before the list rule (ADR 0042, ADR 0060): the override
		// confirms the Ticket it named, whether or not the list still holds the row.
		const ticket = findTicket(pending.ticketIdentity);
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
			runRouteHandoff(ticket, ticket.lastCompletion?.transition ?? null, choice);
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
	 * Toggle the Auto-handoff mode (ADR 0036).
	 *
	 * The flip lands in the session at once, and the new mode is written to the
	 * state file at once: the next startup and the next dev reload read it back.
	 * A write that fails reports the state file it could not write on the Message
	 * line, and the in-session flip stands: the operator keeps working in the mode
	 * they asked for, so the failure is news about the next run, not a refusal of
	 * this one.
	 *
	 * The record states the flip the way the Message line states it (issue #223):
	 * the plain line lands when the write took, and a write the state file refused
	 * leaves the session-only line beside it. A file that says the mode moved while
	 * the next run reads the old value is a record a reviewer cannot trust. The
	 * record's line carries the `mode:` family prefix, so a reader grepping the file
	 * for the facts the operator sets by key gets this line and not the cycle's hold
	 * line about the same fact.
	 */
	const toggleAutoHandoff = () => {
		const next = !autoModeRef.current;
		autoModeRef.current = next;
		setAutoMode(next);
		const modeLine = `mode: auto-handoff is ${next ? "on" : "off"}`;
		const sessionOnly = `auto-handoff is ${next ? "on" : "off"} for this session only`;
		// The mode decides every automatic walk in the run, so the record names it
		// when it moves. A plane with no state file has nothing to persist, and the
		// record says so: a file that claims the mode moved while no run reads it back
		// is the same untrustworthy line a refused write leaves (issue #223 review).
		// Both session-only lines carry `warn`, the level the configuration reference
		// states for them, so a run filtered to `warn` keeps the news that the next
		// run reads nothing back.
		if (state === undefined) {
			logger?.warn(`${modeLine} for this session only: the plane runs with no state file`);
			return;
		}
		try {
			state.handoff.setAutoHandoffMode(next);
			logger?.info(modeLine);
		} catch (error) {
			const reason = errorMessage(error);
			logger?.warn(`${modeLine} for this session only: ${reason}`);
			setErrorMessage(`${sessionOnly}: ${reason}`);
		}
	};

	/** The method the merge action runs with, from the task type's action form (ADR 0068). */
	const mergeMethodOf = (taskType: string): string =>
		planeActionSettingOf(configRef.current.taskTypes, taskType)?.method ?? DEFAULT_MERGE_METHOD;

	// The decision modal's rows: Close first, selected by default, then a
	// Goto, then one handoff row when the settled turn's transition wrote a
	// position the machine offers a task for (ADR 0027). The fact lines, the
	// route's standing, and the modal's context line come from the fact
	// module (issue #201); the rows and the Decision region stay here. The
	// row stands only while the position's ticket is still listed in a
	// source: a refresh that finds the ticket gone - a merged or closed pull
	// request, a closed issue - withdraws the row, and a fact line states the
	// reason in its place. The row's detail names the Agent its route resolves
	// to, beside the pin's Environment, which is setting resolution and stays
	// with the screen.
	const decisionFor = (
		ticket: Ticket,
	): {
		actions: ActionRow[];
		entries: readonly TurnLogEntry[];
		contextLine: string;
		factLines: readonly string[];
		/** The turn's end cause, or null when the turn has no settled record. */
		cause: TurnEndCause | null;
		/** The agent's or provider's text for the cause; empty when none. */
		detail: string;
	} => {
		const completion = ticket.lastCompletion;
		const outcome = completion?.transition ?? null;
		const positionIdentity = outcome?.positionTicketIdentity ?? ticket.identity;
		// The Next step the settled turn's Transition derives (ADR 0092): the
		// screen resolves it from the state, and the fact module states the gate
		// that holds it beside the row the operator can confirm.
		const nextStep =
			state === undefined || outcome === null
				? null
				: deriveNextStep(configRef.current, state.ticketWorkCycle, outcome, listViews.projection);
		const facts = decisionFacts({
			ticket,
			queue: workQueueRef.current,
			claims: startingTicketsRef.current,
			position: {
				ticket: findTicket(positionIdentity),
				stillListed:
					state === undefined ||
					outcome?.positionTicketIdentity === null ||
					state.sourceFact.stillListed(positionIdentity),
				isPlaneAction:
					outcome?.positionTaskType != null &&
					isPlaneActionTaskType(configRef.current.taskTypes, outcome.positionTaskType),
				latestAttempt:
					state === undefined ? null : state.planeAction.latestPlaneActionAttempt(positionIdentity),
			},
			nextStepGate: nextStep === null ? null : nextStep.gate,
			defaultTaskType: configRef.current.defaultTaskType,
		});
		const actions: ActionRow[] = [
			{ key: "close", label: "Close", detail: "end the work cycle; the ticket returns to open" },
			{ key: "goto", label: "Goto", detail: "focus the agent's pane; the handoff stays open" },
		];
		if (outcome !== null && facts.offer !== null) {
			if (facts.offer.kind === "merge") {
				actions.push({
					key: "merge",
					label: planeActionLabel("merge-pull-request"),
					detail: `runs the merge now, with no agent and no worktree (method ${mergeMethodOf(facts.offer.taskType)})`,
					planeAction: true,
				});
			} else {
				actions.push({
					key: "route",
					label: `Handoff: ${facts.offer.taskType}`,
					detail: routeDetail(outcome, facts.offer.taskType),
					editable: true,
				});
			}
		}
		// The re-fire row stands on an outcome the fire did not complete
		// (ADR 0054): no branch held, or the label write failed. The
		// operator confirms it, and the plane reads the source as it stands
		// now and fires the turn's transition again. A complete outcome
		// shows no row: the machine's work is done.
		if (outcome !== null && (outcome.fired === false || outcome.writeFailure !== "")) {
			actions.push({
				key: "refire",
				label: "Re-fire",
				detail: "read the source as it stands now and fire the turn's transition again",
			});
		}
		return {
			actions,
			entries: completion?.turnLog ?? [],
			contextLine: facts.contextLine,
			factLines: facts.factLines,
			cause: completion?.cause ?? null,
			detail: completion?.detail ?? "",
		};
	};

	/** The transition row states the Agent that will receive its handoff. */
	const routeDetail = (outcome: TransitionOutcome, target: string): string => {
		const choice = resolveHandoffChoice(configRef.current, target, {
			...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
			...(outcome.environment === undefined ? {} : { environment: outcome.environment }),
		});
		const detail = [`agent ${choice.agentType}`];
		if (outcome.environment !== undefined) detail.push(`environment ${outcome.environment}`);
		return detail.join(", ");
	};
	/**
	 * The label of one workspace in herdr's own navigator.
	 *
	 * A Goto moves every herdr client's view to the pane it names (ADR 0061),
	 * and the confirmation still names the workspace so the operator can say
	 * where the view landed. A read that fails names nothing: the line keeps
	 * its old shape rather than stating a wrong fact. The workspace the control
	 * plane runs in is never named: the plane holds no id for it, so nothing
	 * here can aim a focus move at it (ADR 0061).
	 */
	const workspaceLabelOf = async (workspaceId: string): Promise<string | null> => {
		const result = await commandRunner.run("herdr", ["workspace", "get", workspaceId]);
		if (result.code !== 0) return null;
		try {
			const data = JSON.parse(result.stdout) as {
				result?: { workspace?: { label?: unknown } };
			};
			const label = data.result?.workspace?.label;
			return typeof label === "string" && label !== "" ? label : null;
		} catch {
			return null;
		}
	};
	// Goto is navigation (ADR 0033): the operator focuses the agent's pane
	// in herdr and the handoff stays open. The ticket, its work cycle, and
	// its traces stay exactly where they are: an awaiting ticket rests
	// awaiting until the poll or a decision moves it, and an in-flight one
	// stays in flight.
	const runGoto = (ticket: Ticket) => {
		const paneId = ticket.handoff?.paneId ?? null;
		if (paneId === null) {
			setWarningMessage("no agent pane is recorded for this ticket");
			return;
		}
		// Herdr hands the id of a closed pane out again: when a different agent
		// runs in the pane the handoff recorded, the focus would land on that
		// agent, not the ticket's own. Refuse the focus, and state the fact on
		// the Message line the way a refused key does.
		const paneAgent = agentsRef.current?.find((candidate) => candidate.paneId === paneId);
		if (paneAgent !== undefined && ticketAgentIdentity(ticket, paneAgent) === "foreign") {
			setWarningMessage("the pane the handoff recorded is no longer the agent's pane");
			return;
		}
		void commandRunner.run("herdr", ["agent", "focus", paneId]).then(async (result) => {
			if (result.code !== 0) {
				setErrorMessage(`agent focus failed: ${commandFailureText(result)}`);
				return;
			}
			// The Live view closes on a Goto, so the confirmation stands on the
			// Message line as a result, never as a warning. A Goto records no
			// trace, and a Handoff or refresh still running stands alone. The line
			// names the workspace herdr moved every client's view into (ADR 0061):
			// Goto is the one focus move the plane makes, and the operator asked
			// for it at the key.
			const workspaceId = ticket.handoff?.workspaceId ?? null;
			const label = workspaceId === null ? null : await workspaceLabelOf(workspaceId);
			reportMessage({
				severity: "info",
				text:
					label === null
						? `focused the agent of ticket ${ticket.identity}`
						: `focused the agent of ticket ${ticket.identity} in workspace ${label}`,
			});
		});
	};
	// The re-fire in flight (ADR 0054), by ticket identity: the Decision
	// region confirms once, and a second confirm - the row stays visible while
	// the fire runs - stands down. The ref holds the guard because the key
	// handler outlives the render that made it.
	const refireInFlightRef = useRef<string | null>(null);

	// Run a decision-panel action: close (with the Close cleanup), Goto, a
	// workflow handoff, the re-fire of an incomplete transition, or (from the
	// missing modal) restart and abandon.
	const runDecisionAction = (ticket: Ticket, key: string) => {
		// A routed handoff from the Live view keeps the screen open: the
		// stream resumes for the new agent pane on its next tick. A merge
		// confirmed there keeps the screen open the same way: the stream stays
		// on the pane it watches, and the run's line lands on the Message line.
		// A re-fire keeps its own screen open the same way: the operator
		// confirms on it, and the fact lines the fire writes land on the open
		// rows.
		if (!(panel?.kind === "live" && (key === "route" || key === "merge")) && key !== "refire") {
			setPanel(null);
		}
		if (state === undefined) return;
		if (key === "close") {
			closeDecidedCycle(ticket);
			return;
		}
		if (key === "goto") {
			runGoto(ticket);
			return;
		}
		if (key === "refire") {
			void runRefire(ticket);
			return;
		}
		if (key === "merge") {
			// The manual confirm of the merged position (ADR 0068): the merge
			// runs as a plane action, with no agent and no worktree, and the
			// decision word lands at the ask, the way the route's does. The
			// confirm bypasses the Handoff limit: the operator asked for it,
			// and the limit holds the machine's automatic asks.
			runMerge(ticket);
			return;
		}
		const choice = routeChoiceOf(ticket, key);
		if (choice === null) return;
		runRouteHandoff(ticket, ticket.lastCompletion?.transition ?? null, choice);
	};

	// The forced refresh of the pull request sources, the one seam the fires
	// read the projection through (ADR 0027, ADR 0076): the settle-time fire,
	// the manual re-fire, and the recorded skip's sweep all pull the pull
	// request sources the way this answers it.
	const refreshPullRequestSources = useCallback(async (): Promise<void> => {
		for (const source of configRef.current.sources) {
			if (source.kind === "github-pull-requests")
				await coordinatorRef.current?.refreshAndWait(source.name);
		}
	}, []);
	/**
	 * The manual re-fire of a settled turn's transition (ADR 0054).
	 *
	 * The Decision region offered the row because the recorded outcome did not
	 * complete the machine's work: no branch held, or the label write failed.
	 * The re-fire reads the source as it stands now - a forced refresh of the
	 * pull request sources, the same seam the settle-time fire uses - fires
	 * the turn's task type transition again through the command runner, and
	 * swaps the new outcome onto the trace in place of the one the operator
	 * acted on. The turn stays awaiting with no decision change: no cycle
	 * ends, nothing hands off. The swap declines when the trace moved between
	 * the read and the write; the fire's labels stand either way, because a
	 * fire writes convergent facts.
	 */
	const runRefire = async (ticket: Ticket): Promise<void> => {
		if (
			state === undefined ||
			ticket.lastCompletion === null ||
			ticket.lastCompletion.transition === null
		) {
			return;
		}
		if (refireInFlightRef.current !== null) return;
		// The turn the re-fire acts on: the completion the row was offered on.
		const completion = ticket.lastCompletion;
		refireInFlightRef.current = ticket.identity;
		setWorkingMessage("re-firing the turn's transition...", "refire");
		try {
			// The outcome the operator acted on, as the state stores it: the
			// swap conditions on these exact bytes.
			const recordedJson = state.ticketWorkCycle.recordedTransitionJson(ticket.identity);
			if (recordedJson === null) {
				reportMessage({
					severity: "warning",
					text: "the turn records no transition outcome; no re-fire stands",
				});
				return;
			}
			// Read the source as it stands now: the fire reads the projection
			// the refresh just landed, the way the settle-time fire does.
			const outcome = await fireTransition({
				config: configRef.current,
				state,
				runner: commandRunner,
				ticketIdentity: ticket.identity,
				taskType: completion.taskType,
				refresh: refreshPullRequestSources,
			});
			if (outcome === null) {
				reportMessage({
					severity: "warning",
					text: "the re-fire reached no ticket; the turn's record stands",
				});
				return;
			}
			const applied = state.ticketWorkCycle.recordRefiredOutcome(
				ticket.identity,
				recordedJson,
				outcome,
			);
			replaceTickets();
			if (!applied) {
				reportMessage({
					severity: "warning",
					text: "the turn's record moved before the re-fire landed; the standing record stands",
				});
				return;
			}
			if (outcome.fired) {
				reportMessage({
					severity: "info",
					text: "the re-fire lands; the labels stand as written",
				});
			} else {
				reportMessage({
					severity: "warning",
					text: `no transition branch held on the re-fire: ${outcome.reason}`,
				});
			}
		} finally {
			refireInFlightRef.current = null;
			clearWorkingMessage("refire");
		}
	};

	/**
	 * Close the work cycle of an `awaiting` Ticket: the `closed` decision on
	 * its settled turn, then the Close cleanup.
	 *
	 * One function runs the close the Decision modal's Close row offers and the
	 * one key `w` confirms (ADR 0031): the two routes are the same operation, so
	 * they cannot drift. The Close cleanup goes through the dispatch seat, which
	 * already holds it behind a Handoff of the same ticket. A ticket that stands
	 * for a route item loses it in the same answer: a closed cycle never
	 * leaves a live start in the queue (ADR 0067, ADR 0072).
	 */
	const closeDecidedCycle = (ticket: Ticket) => {
		if (state === undefined) return;
		const applied = state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: ticket.identity,
			handoffId: ticket.handoff?.attemptId ?? "",
			decision: "closed",
			decidedAt: new Date().toISOString(),
		});
		if (applied && ticket.state === "awaiting")
			state.workQueue.removeWorkflowRouteItem(ticket.identity);
		replaceTickets();
		if (!applied) {
			setWarningMessage(`ticket ${ticket.identity} already decided`);
			return;
		}
		refreshTicketSources(ticket.identity);
		closeCycleEndDraft(ticket.identity);
		// The Close cleanup: the environment of the handoff the decision ends.
		const stored = state.handoff.latestHandoff(ticket.identity);
		if (stored !== null) runCloseCleanup(ticket.identity, stored, "closed");
		// The Close action writes no progress line of its own.
		clearOperationMessage("none");
	};

	/**
	 * The cycle-end draft close (ADR 0076): when the cycle ends - the Close of
	 * a decided cycle, the Abandon, the handoff limit, the auto-close - the
	 * draft the ticket still wears is read off the factory branch and closed.
	 * It runs best-effort, after the close: a failure is a warning on the
	 * line, and a branch that carries no draft - or nothing at all - closes
	 * nothing and says nothing.
	 */
	const closeCycleEndDraft = useCallback(
		(identity: string): void => {
			const ticket = findTicket(identity);
			if (ticket === undefined) return;
			void closeCycleEndDraftPullRequest(commandRunner, configRef.current.sources, ticket).then(
				(failure) => {
					if (failure !== null) setWarningMessage(failure);
				},
			);
		},
		[commandRunner, findTicket, setWarningMessage],
	);

	/**
	 * Close the work cycle of an in-flight Ticket (ADR 0031).
	 *
	 * The turn never settled, so the cycle ends with no completion trace, and
	 * the Handoff it ran in is stopped by the Close cleanup. The dispatch module
	 * holds the whole close on the shared environment seat, so a close that met a
	 * Handoff of the same ticket ran after it settled. A cleanup herdr refused is
	 * the same failure the other close paths report, and the leftover it leaves
	 * is the ticket's fact from there on (ADR 0032).
	 */
	const closeInFlightCycle = (ticket: Ticket) => {
		const dispatch = handoffDispatch;
		if (dispatch === undefined) return;
		void dispatch.closeWorkCycle(ticket.identity).then(
			(outcome) => {
				if (!outcome.ended) {
					setWarningMessage(`ticket ${ticket.identity} did not close: ${outcome.reason}`);
					return;
				}
				// The ended cycle may have changed the ticket's source item.
				refreshTicketSources(ticket.identity);
				if (outcome.cleanupFailure === undefined)
					// The stop of a live Agent is the fact the operator asked for, so
					// it reads like the Abandon of a missing one: a warning, not an error.
					setWarningMessage(`ticket ${ticket.identity} closed`);
				else
					setErrorMessage(
						`ticket ${ticket.identity} closed; the close cleanup failed: ${outcome.cleanupFailure}`,
					);
			},
			(error) =>
				setErrorMessage(
					`ticket ${ticket.identity} closed; the close could not be reported: ${errorMessage(error)}`,
				),
		);
	};

	/**
	 * Run the Close the operator confirmed on `w`.
	 *
	 * The route reads the Ticket's state now, not the state the dialog was drawn
	 * on: the poll can settle the turn, or a decision can land, while the
	 * confirmation stands. An `awaiting` Ticket runs the Decision modal's Close
	 * row, and an in-flight one ends its cycle with no completion record.
	 */
	const runTicketClose = (asked: Ticket) => {
		// The projection before the list rule: the row can leave the list while the
		// confirmation stands, and the Close still runs on the Ticket it named.
		const ticket = findTicket(asked.identity) ?? asked;
		if (ticket.state === "awaiting") {
			closeDecidedCycle(ticket);
			return;
		}
		if (inFlight(ticket)) {
			closeInFlightCycle(ticket);
			return;
		}
		// The cycle ended from under the dialog: nothing is in flight to close. The
		// refusal reads in the same words the seat close reads it in, so the one
		// fact a moved Ticket states never has two phrasings.
		setWarningMessage(`ticket ${ticket.identity} did not close: the ticket is ${ticket.state}`);
	};

	/**
	 * The choice the `route` row resolves to.

	 * The row stands on the settled turn's transition outcome: the plane
	 * wrote the facts and re-derived the position, so the action re-reads
	 * nothing from the config but the choice the position resolves to. A
	 * stale row - the outcome is gone or wrote no position - reports on the
	 * status line and comes back null (ADR 0027).
	 */
	const routeChoiceOf = (ticket: Ticket, key: string): HandoffChoice | null => {
		if (key !== "route") return null;
		const outcome = ticket.lastCompletion?.transition ?? null;
		if (outcome === null || outcome.positionTaskType === null) {
			setWarningMessage(`no transition position is recorded for ticket ${ticket.identity}`);
			return null;
		}
		// A transition Handoff resolves a fresh target profile and never
		// inherits the previous handoff's choice.
		return resolveHandoffChoice(configRef.current, outcome.positionTaskType, {
			...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
			...(outcome.environment === undefined ? {} : { environment: outcome.environment }),
		});
	};

	/**
	 * Ask for the merge of the position's pull request (ADR 0068): the plane
	 * action's ask through the dispatch seam, the decision word landing at the
	 * ask and the item entering the Work queue. The ask takes no settings: the
	 * task type's action form carries the method, and the run re-reads it when
	 * it starts. A refusal before the enqueue - the claim, the one-item-per-
	 * ticket rule - records nothing, and the row stands again.
	 */
	const runMerge = (ticket: Ticket) => {
		if (handoffDispatch === undefined) return;
		const outcome = ticket.lastCompletion?.transition ?? null;
		if (outcome === null || outcome.positionTaskType === null) {
			setWarningMessage(`no transition position is recorded for ticket ${ticket.identity}`);
			return;
		}
		const targetIdentity = outcome.positionTicketIdentity ?? ticket.identity;
		void handoffDispatch
			.dispatchPlaneAction({
				origin: "workflow",
				ticketIdentity: targetIdentity,
				taskType: outcome.positionTaskType,
				routeFromIdentity: ticket.identity,
				// The start answers the ask's refresh only: the decision stands
				// at the ask (ADR 0064), and the run's line answers itself.
				onStarted: () => replaceTickets(),
			})
			.then((result) => {
				if (!result.ok) setWarningMessage(result.reason);
			});
	};

	/**
	 * Start a transition handoff with a resolved or overridden choice. The
	 * handoff starts on the position's own ticket: the machine re-derives
	 * positions from the written labels, so the agent starts where the facts
	 * now sit, while the decision records on the ticket whose turn settled
	 * (ADR 0027).
	 */
	const runRouteHandoff = (
		ticket: Ticket,
		outcome: TransitionOutcome | null,
		choice: HandoffChoice,
	) => {
		if (handoffDispatch === undefined) return;
		// The turn's decision lands at the ask (ADR 0064): the dispatch module
		// records it when the route enqueues, on the state's clock, so the ask
		// never waits on a run. A refusal before the enqueue - the claim, the
		// one-item-per-ticket rule - records nothing, and the trace stays
		// pending, so Close and Goto keep working.
		const targetIdentity = outcome?.positionTicketIdentity ?? ticket.identity;
		void handoffDispatch
			.dispatch({
				origin: "workflow",
				ticketIdentity: targetIdentity,
				// The route continues this ticket's settled turn: its leftover
				// environment is the handoff's own, so a name that leftover agent
				// still holds falls to the cycle name instead of failing as a
				// stranger (ADR 0027).
				routeFromIdentity: ticket.identity,
				choice,
				previousMessage: ticket.lastCompletion?.message ?? "",
				// The start answers the ask's refresh only: the decision stands
				// at the ask (ADR 0064), and the drop warning answers itself.
				onStarted: () => replaceTickets(),
			})
			.then((result) => {
				if (!result.ok) setWarningMessage(result.reason);
			});
	};

	/**
	 * The placement each offered task type takes on the ticket the override
	 * panel edits (ADR 0045). The panel wears the answers on its Task row,
	 * and the dispatch re-runs the same rule when the confirmed start claims.
	 * A route places the position's own ticket, not the settled one: the
	 * handoff starts where the facts sit, the way its dispatch answers.
	 */
	const taskPlacementsFor = (pending: PendingOverride): Record<string, PlacementEvaluation> => {
		const activeConfig = configRef.current;
		// Both rows come from the projection before the list rule (ADR 0042,
		// ADR 0060): ADR 0042's route reaches a position whose own row is withheld,
		// and so does an ignored one - the placement facts are the position's, not
		// the view's.
		const settled = findTicket(pending.ticketIdentity);
		if (settled === undefined) return {};
		// A route dispatches on the position's own ticket (ADR 0027), so the
		// placement is read on that ticket, not the settled one.
		const identity =
			pending.origin === "workflow"
				? (settled.lastCompletion?.transition?.positionTicketIdentity ?? settled.identity)
				: settled.identity;
		const ticket = identity === settled.identity ? settled : findTicket(identity);
		if (ticket === undefined) return {};
		const evaluations: Record<string, PlacementEvaluation> = {};
		for (const taskType of Object.keys(activeConfig.taskTypes)) {
			evaluations[taskType] = evaluatePlacement({
				states: activeConfig.workflowStates,
				fallbackTaskType: activeConfig.defaultTaskType,
				memberships: ticket.memberships,
				chosenTaskType: taskType,
			});
		}
		return evaluations;
	};

	/**
	 * The `e` key on a decision row: edit that route's resolved settings
	 * before it starts, so the operator's override outranks the edge pin,
	 * the target Task profile, and the config defaults.
	 */
	const openRouteOverride = (ticket: Ticket, key: string) => {
		// The ask never waits on a run (ADR 0064): the edit stands while a
		// Handoff is active, and the start it confirms answers by its own
		// rules, like every other ask.
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

	const submitConsultation = (
		typeName: string,
		repository: ConsultationRepositoryOption,
		input: string,
	) => {
		if (state === undefined || consultationOperations === undefined) {
			setStatus({ kind: "error", text: "Consultations require durable SQLite state" });
			return;
		}
		// The Consultation submit goes through the Work queue (ADR 0049). The
		// enqueue's hard check runs first: the type still exists, and the
		// settings that type resolves to still fit. A Consultation the config
		// cannot start never takes a row: the reason stands on the Message line
		// at the ask, and the launcher stays open with the operator's form for
		// the fix. The check is async - the Setting fit reads the Agent's Model
		// list - so the whole submit runs behind it, the way every other start's
		// ask does.
		void consultationOperations.checkEnqueue(typeName).then(async (refusal) => {
			if (refusal !== undefined) {
				setErrorMessage(`consultation not queued: ${refusal}`);
				return;
			}
			const replaced =
				replacementConsultationId === null
					? undefined
					: state.consultationRecord.consultation(replacementConsultationId);
			const consultation =
				replaced === undefined
					? consultationOperations.create({
							typeName,
							repository,
							initialInput: input,
							replacementOf: replacementConsultationId,
							queued: true,
						})
					: consultationOperations.replace(replaced, {
							typeName,
							repository,
							initialInput: input,
							queued: true,
						});
			if (consultation === undefined) return;
			setLauncher(false);
			setReplacementConsultationId(null);
			historyFilterRef.current = "open";
			setHistoryFilter("open");
			// Stay on the record the replacement points back at, or on the
			// launched Consultation when it replaces nothing.
			selectConsultationById(consultation.replacementOf ?? consultation.id);
			// The record and its item committed in one write: the queue re-reads
			// it through the same refresh a handoff enqueue runs.
			replaceTickets();
			// The immediate pickup pass may take the seat the enqueue just made,
			// the way every other start's ask does. Run it before choosing the
			// line, so the notice never claims a wait the queue no longer holds:
			// a pickup that started the record already stood its own opening line,
			// and a record that still waits is the one that keeps its queue item.
			const pickup = handoffDispatchRef.current?.dispatch;
			if (pickup !== undefined) await pickup.pickupWorkQueue();
			const settled = state.consultationRecord.consultation(consultation.id);
			if (settled === undefined || settled.state !== "queued") return;
			setNoticeMessage(
				state.workQueue.queuePaused()
					? `consultation queued: ${consultation.id.slice(0, 8)} waits in the Work queue; the queue is paused`
					: `consultation queued: ${consultation.id.slice(0, 8)} waits in the Work queue for a free Parallel limit seat`,
			);
		});
	};
	const recoverConsultationOpening = (consultation: Consultation) => {
		if (consultation.state !== "opening") return;
		void consultationOperations?.recover(consultation);
	};
	/**
	 * Whether this record holds no Agent the close could stop.
	 *
	 * The two Recovery required states are the two an interrupted run cannot
	 * bring back: herdr reports no pane, and nothing waits for a reply.
	 */
	const consultationHasNoAgent = (consultation: Consultation) =>
		consultation.state === "missing" || consultation.state === "failed";
	/**
	 * Whether this record's close has nothing to stop and nothing to keep.
	 *
	 * The two states Recovery names, plus a `queued` or an `unscheduled`
	 * record (issue #90, issue #91): it has never had an Agent, an
	 * environment, or a worktree, so its close confirms nothing and cleans
	 * nothing. It is not one the launcher replaces: its ask still stands, and
	 * the record closes to the delete that follows it.
	 */
	const consultationCloseNeedsNoAgent = (consultation: Consultation) =>
		consultation.state === "queued" ||
		consultation.state === "unscheduled" ||
		consultationHasNoAgent(consultation);
	/**
	 * Whether this record is one a Replacement continues.
	 *
	 * The same two states the close cannot stop: a record with no Agent left
	 * cannot be reopened, so the launcher replaces it instead, on the durable
	 * recovery context, and links the new record back here.
	 */
	const isReplacedConsultation = consultationHasNoAgent;
	/**
	 * Open the launcher as the Replacement launcher of one record.
	 *
	 * One path for both ways in: the `c` Launch of a `missing` or a `failed`
	 * row, and that row's recovery panel. The panel below this one closes, so
	 * the launcher holds the keys alone.
	 */
	const openReplacementLauncher = (consultation: Consultation) => {
		setPanel(null);
		setReplacementConsultationId(consultation.id);
		setLauncher(true);
	};
	/**
	 * Run the close the operator asked for, in the shape the record needs.
	 *
	 * A record with no Agent to stop has nothing to confirm, so the close runs
	 * on the keypress. A live record confirms first, and a `closing` one opens
	 * its Retry and Force-close recovery rows.
	 */
	const runConsultationClose = (consultation: Consultation) => {
		if (consultationCloseNeedsNoAgent(consultation)) closeConsultation(consultation);
		else setPanel({ kind: "consultation-close", identity: consultation.id });
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
				const current = state.consultationRecord.consultation(consultation.id);
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
			state.consultationRecord.setConsultationDraft(selectedConsultation.id, text);
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
			state.consultationRecord.setConsultationDraft(selectedConsultation.id, "");
		setResponseEditor(false);
		setStatus({ kind: "info", text: "the saved Response draft was discarded" });
	};
	/** Close the editor. The Response draft it leaves is the one already stored. */
	const closeResponseEditor = () => {
		setResponseEditor(false);
	};
	/**
	 * A click on a section's header toggles that section (user story 9), the
	 * same action `x` takes for the cursor. Expanding moves the cursor into
	 * the section's list and focuses it. Collapsing keeps the selection and
	 * its detail with the section, so the operator's place is never lost to
	 * a stray click (user stories 19 and 20).
	 */
	const clickSection = (next: MainSection) => {
		if (flipSectionExpanded(next)) {
			selectionRef.current =
				next === "tickets" ? "ticket" : next === "consultations" ? "consultation" : "queue";
			setSelection(selectionRef.current);
			focusPane("list");
		}
	};
	/**
	 * Put the unified cursor on one Consultation by id, from the launch
	 * route. The launched record, or the record its replacement points back
	 * at, is the one the operator keeps looking at: the detail follows it
	 * and the observation loop starts reading its pane.
	 */
	const selectConsultationById = (id: string) => {
		historyFilterRef.current = "open";
		setHistoryFilter("open");
		replaceConsultations();
		const index =
			state === undefined ? -1 : consultationsRef.current.findIndex((item) => item.id === id);
		if (index < 0) return;
		consultationIndexRef.current = index;
		setConsultationIndex(index);
		selectionRef.current = "consultation";
		setSelection("consultation");
		consultationFollowRef.current = true;
		setConsultationScroll(999999);
		setNewOutput(false);
	};
	/**
	 * `f` cycles the Ticket section's List filter (ADR 0060): active, ignored,
	 * all. The pile the ignore made is one keypress from view in either
	 * direction, and the cursor keeps its Ticket when the new view still shows
	 * it - the re-read preserves the row by identity, the way the history
	 * filter's cycle does.
	 */
	const cycleTicketFilter = () => {
		if (state === undefined) {
			// The reveal shows the rows the list rule withholds, and the in-memory
			// projection runs no list rule at all: every view is the rows it was
			// handed, so the key has no pile to show. It says so in the same words
			// `i` says the missing fact in, rather than moving a filter the frame
			// cannot see (ADR 0060).
			setWarningMessage("the Ticket list filter needs SQLite state");
			return;
		}
		const next = nextTicketListFilter(ticketFilterRef.current);
		ticketFilterRef.current = next;
		setTicketFilter(next);
		replaceTickets();
	};
	/**
	 * `i` ignores the selected Ticket, or takes it back (ADR 0060).
	 *
	 * The flag is factory state on the state file, and the plane writes nothing
	 * to the source: no label, no close, no comment. The write is the authority -
	 * it re-reads the obligation the catalogue's availability already judged, so a
	 * Ticket that owes a decision cannot be hidden from its operator.
	 *
	 * The line states what the act actually did, because the ignore hides a
	 * resting Ticket and never a live one: a Ticket whose row the list keeps for
	 * its work in flight says so, and its row goes back into the pile when the
	 * cycle ends. The flag stands under both - nothing but this key clears it.
	 *
	 * An ignore also takes the Ticket's waiting start out of the Work queue
	 * through the dispatch module's cancel path, so the queue never holds work the
	 * operator put away; a start asked for after the ignore still runs.
	 */
	const toggleTicketIgnore = () => {
		// The Ticket under the cursor, read the way every Ticket control reads it
		// (issue #159): a Group header holds no Ticket, and the catalogue refused
		// the key with its own words before this ran.
		const ticket = ticketAtCursor();
		if (ticket === undefined) return;
		if (state === undefined) {
			// The ignore is durable factory state: the in-memory projection this
			// shell holds has nowhere to keep it, so the key says so instead of
			// acting as a view switch the operator would read as an ignore.
			setWarningMessage("ignoring a Ticket needs SQLite state");
			return;
		}
		const ignored = !ticket.ignored;
		const result = state.ticketWorkCycle.setTicketIgnored(
			ticket.identity,
			ignored,
			factsFor(ticket).failure,
		);
		if (!result.ok) {
			setWarningMessage(result.reason);
			return;
		}
		// The waiting start leaves with the row (ADR 0060): the cancel path keeps
		// its stated semantics - the item goes, the ticket keeps its state.
		const cancelled =
			ignored === true && handoffDispatch?.removeQueueItem(ticket.identity) === true;
		// The row's place in the list decides the sentence, read from the re-read the
		// act just caused: a resting Ticket's row leaves with the flag and returns
		// without it, while a Ticket with live work or a decision owed keeps its row
		// either way. `active` is the list rule's own answer - the covered rule beside
		// the ignore's - so a clear that returns no row says which rule still holds it
		// out instead of promising a row the list does not draw (ADR 0042, ADR 0060).
		const resting = flagWithholdsRow({ ...ticket, ignored: true });
		replaceTickets();
		const backInList = listViewsRef.current.active.some((row) => row.identity === ticket.identity);
		const name = `"${ticket.title}"`;
		if (ignored) {
			reportMessage({
				severity: "info",
				text: cancelled
					? `${name} is ignored; its waiting start left the Work queue`
					: resting
						? `${name} is ignored: no row, no counts, no automatic start`
						: `${name} is ignored: no automatic start, and its row stays while its work is live`,
			});
		} else {
			reportMessage({
				severity: "info",
				text: !resting
					? `${name} is not ignored: the machine may start it again`
					: backInList
						? `${name} is not ignored: its row is back in the list`
						: `${name} is not ignored: an open fixing pull request still holds its row out of the list`,
			});
		}
	};
	/**
	 * `u` mutes the source the row's Ticket came in on, or takes the mute back
	 * (ADR 0070).
	 *
	 * The act is the operator's judgment on the source, written on the source's
	 * own row, and the plane writes nothing to the source: no label, no close,
	 * no comment. The row's facts carry the flag folded in - the mute of any of
	 * the Ticket's sources - so the key flips on the flag, and it mutes or
	 * un-mutes every source the Ticket's memberships name together, the way the
	 * act rides on the row and acts on the source. The state's write settles
	 * what the act takes away in the same transaction: the source's waiting
	 * starts leave the Work queue, and the machine's re-offer of a route the
	 * mute took drops out of the list where the mute dropped its ticket
	 * (ADR 0070, ADR 0072).
	 */
	const toggleSourceMute = () => {
		// The Ticket under the cursor, read the way every Ticket control reads
		// it (issue #159): a Group header holds no Ticket, and the catalogue
		// refused the key with its own words before this ran.
		const ticket = ticketAtCursor();
		if (ticket === undefined) return;
		if (state === undefined) {
			// The mute is durable factory state on the source's row: the
			// in-memory projection this shell holds has nowhere to keep it, so
			// the key says so instead of acting as a view switch the operator
			// would read as a mute (ADR 0070).
			setWarningMessage("muting a source needs SQLite state");
			return;
		}
		const sources = [
			...new Set(ticket.memberships.map((membership) => membership.sourceName)),
		].sort();
		if (sources.length === 0) {
			setWarningMessage("the selected Ticket names no source to mute");
			return;
		}
		const muted = ticket.muted !== true;
		let removed = 0;
		for (const sourceName of sources) {
			const result = state.sourceFact.setSourceMuted(sourceName, muted);
			if (!result.ok) {
				setWarningMessage(result.reason);
				return;
			}
			removed += result.removed;
		}
		replaceTickets();
		const label = sources.join(", ");
		const queueNote =
			removed > 0
				? `; ${removed} waiting start${removed === 1 ? "" : "s"} left the Work queue`
				: "";
		reportMessage({
			severity: "info",
			text: muted
				? `source ${label} is muted: no row while its tickets rest, no automatic start${queueNote}`
				: `source ${label} is not muted: its rows come back from the list, and the machine may start them`,
		});
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
			const applied = state.ticketWorkCycle.applyCompletionDecision({
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
			refreshTicketSources(ticket.identity);
			closeCycleEndDraft(ticket.identity);
			const stored = state.handoff.latestHandoff(ticket.identity);
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
	/**
	 * Move the queue's item under the cursor (ADR 0034): the reorder runs in
	 * state, and the list re-reads the queue on the refresh the dispatch
	 * module uses everywhere else. The captured choice travels with the item,
	 * so a reorder changes only the order the free seats take.
	 */
	const moveQueueItem = (direction: "up" | "down", item: WorkQueueItem | null) => {
		if (state === undefined) return;
		// The item is the queue module's own fact for the row under the cursor,
		// the same one the catalogue gated the key on.
		if (item === null) return;
		if (
			!state.workQueue.moveWorkItem(
				item.kind === "consultation" ? item.consultationId : item.ticketIdentity,
				direction,
			)
		) {
			setWarningMessage(
				direction === "up" ? "the item is first in the queue" : "the item is last in the queue",
			);
			return;
		}
		selectionRef.current = "queue";
		setSelection("queue");
		workQueueIndexRef.current = workQueueIndexRef.current + (direction === "up" ? -1 : 1);
		setWorkQueueIndex(workQueueIndexRef.current);
		replaceTickets();
	};
	/**
	 * Remove the queue's item under the cursor (ADR 0034). A handoff item's
	 * removal cancels the intent: the ticket keeps the state it has while it
	 * waits, and the row the list kept clamps to the rows that remain. A
	 * Consultation item's removal unschedules the record (issue #91): the ask
	 * is kept in `unscheduled` state, listed in the Consultation section, and
	 * the pickup never runs for it.
	 *
	 * The line states only what the module measured. Its answer says whether a
	 * row stood when the cancel ran, and a row that left between the render and
	 * the keypress had already left through its own pickup: the Agent is on its
	 * way, and the plane says that instead of a removal the operator did not
	 * cause.
	 */
	const removeQueueItem = (item: WorkQueueItem | null) => {
		if (handoffDispatch === undefined) return;
		// The item is the queue module's own fact for the row under the cursor,
		// the same one the catalogue gated the key on.
		if (item === null) return;
		if (item.kind === "consultation") {
			// A Consultation item's removal unschedules the record (ADR 0034,
			// issue #91): the ask is kept in `unscheduled` state behind the
			// pointer it loses, and the pickup never runs for it. The module
			// holds no claim for the record, so only the row and its pickup note
			// leave through the module's seam.
			const removed = handoffDispatch.removeConsultationQueueItem(item.consultationId);
			if (removed) {
				setNoticeMessage(
					`consultation ${item.consultationId.slice(0, 8)}: removed from the queue; the record is unscheduled`,
				);
			} else {
				setWarningMessage(
					`consultation ${item.consultationId.slice(0, 8)}: the queue item was already gone`,
				);
			}
			replaceTickets();
			// The record's state moved in the same write the item left, so the
			// Consultation section re-reads its rows: the row the operator just
			// removed reappears as the `unscheduled` ask.
			replaceConsultations();
			return;
		}
		// Route the removal through the module so the waiting start leaves with
		// everything held for it: the row, a parked claim, and the ask's held
		// start report (ADR 0049). A bare state delete would strand the intent
		// and let it answer a later start of the same ticket.
		const removed = handoffDispatch.removeQueueItem(item.ticketIdentity);
		// The name the operator reads on the line: the title while the ticket
		// is still in the projection, its identity once it is gone. The projection
		// before the list rule, so an ignored Ticket's waiting start names its
		// ticket instead of falling back to the raw identity (ADR 0042, ADR 0060).
		const title = findTicket(item.ticketIdentity)?.title;
		const name = title === undefined ? `ticket ${item.ticketIdentity}` : `"${title}"`;
		if (removed) {
			setNoticeMessage(`the waiting start for ${name} was removed`);
		} else {
			// Nothing to cancel: the keypress met a queue that no longer held the
			// row, so the line refuses the removal it could not make.
			setWarningMessage(`the Work queue no longer held a waiting start for ${name}`);
		}
		replaceTickets();
	};
	/**
	 * Enter on a Work queue row (issue #89, ADR 0034): the force-dispatch.
	 *
	 * The item starts now, even when the Parallel limit is full: the dispatch
	 * module re-runs every hard start check the pickup runs and skips only the
	 * cap, so the seat count may stand over the limit until the work settles.
	 * The module owns the seam end to end - the claim, the row, and every
	 * Message line the start or its failure leaves - and the catalogue gated
	 * the availability: an empty queue never reaches here, and for a Handoff
	 * item a Handoff already in flight never does. A Consultation item runs its
	 * own pickup seam, the way the queue's pickup does (ADR 0034, issue #90):
	 * the seat move is the claim, and a Consultation start never parks behind
	 * the herdr seat a Handoff in flight holds. A seat a Close cleanup holds
	 * while it queues parks a Handoff claim in the module, and the row leaves
	 * only when that parked start settles.
	 */
	const forceDispatchQueueItem = (item: WorkQueueItem | null) => {
		if (handoffDispatch === undefined) return;
		// The item is the queue module's own fact for the row under the cursor,
		// the same one the catalogue gated the key on.
		if (item === null) return;
		handoffDispatch.forceDispatchWorkQueueItem(workQueueIdentityOf(item));
	};
	const currentBaseMode = (): InteractionMode =>
		interaction
			? "consultation-interaction"
			: responseEditor
				? "form-field"
				: selectionRef.current === "consultation"
					? focusedPaneRef.current === "list"
						? "consultation-list"
						: "consultation-detail"
					: selectionRef.current === "queue"
						? focusedPaneRef.current === "list"
							? "work-queue-list"
							: "work-queue-detail"
						: focusedPaneRef.current === "list"
							? "ticket-list"
							: "ticket-detail";
	/**
	 * The plane's standing facts, stated once per render (ADR 0014).
	 *
	 * Every Interaction mode's Availability facts carry this record, and no
	 * surface restates a fact from it: the run state, the source counts, the
	 * Message line's truncation, the configured Consultation types, and the
	 * configured exit key are read the same way in every mode. The view builds
	 * the one record here and hands it to every surface, every mode's facts, and
	 * the Action bar, so the bar, the Key guide, and the dispatch read the same
	 * values in the same frame.
	 */
	const standing: StandingFacts = {
		handoffActive: handoffDispatch?.handoffActive() ?? noStateHandoffInFlightRef.current,
		messageTruncated,
		consultationTypesConfigured: Object.keys(config.consultationTypes).length > 0,
		sourceCount: liveSources.length,
		refreshingSourceCount: liveSources.filter(
			(source) => coordinatorRef.current?.isFetching(source.name) === true,
		).length,
		interactionExitKey: configRef.current.interactionExitKey,
	};
	/**
	 * The Group facts, from the module that owns the row list they count (issue
	 * #159, ADR 0071). A collapsed Ticket section draws no list, so its cursor
	 * stands on no header.
	 */
	const groupFacts = () =>
		groupCursorFacts(
			ticketRowsRef.current,
			ticketsExpandedRef.current ? selectedIndexRef.current : -1,
		);
	/** The queue facts, from the module that draws the queue it counts (ADR 0034, ADR 0052). */
	const queueFacts = () =>
		workQueueCursorFacts(workQueueRef.current, workQueueIndexRef.current, queuePausedRef.current);
	/** The Ticket facts the Ticket section's two modes read. */
	const ticketCursor = () => ({
		selectedTicket: ticketAtCursor(),
		// The ignore's obligation read takes the row's own facts (ADR 0060): the
		// failure marker the list's badge wears, and the List filter the `f` hint
		// names the next state of.
		selectedTicketMarker: selectedTicket === undefined ? null : factsFor(selectedTicket).failure,
		ticketListFilter: ticketFilterRef.current,
		ticketPaneAlive: selectedTicketPaneAlive,
		ticketPaneForeign: selectedTicketPaneForeign,
	});
	/** The Consultation facts the Consultation section's two modes read. */
	const consultationCursor = () => ({
		selectedConsultation:
			selectionRef.current === "consultation"
				? consultationsRef.current[consultationIndexRef.current]
				: undefined,
		consultationRefreshAvailable: state !== undefined,
		consultationAgentStatus: selectedConsultationAgentStatus,
		consultationPaneAlive: selectedConsultationPaneAlive,
	});
	/**
	 * Whether the list's cursor can step.
	 *
	 * The cursor walks one sequence: the rows of each expanded section, in
	 * order. A step is possible past the last row of a section, into the next
	 * expanded one, so the list can move as long as the cursor is not the
	 * sequence's only row.
	 */
	const listCanMove = (): boolean => {
		// The Ticket section's cursor walks the row list, Group headers
		// included, so its edge is the row list's last index (issue #159).
		const t = ticketRowsRef.current.length;
		// The blank row between two Groups holds no cursor, so the walk asks
		// how many rows it can rest on rather than how many rows it draws.
		const tStops = cursorRowCount(ticketRowsRef.current);
		const c = consultationsRef.current.length;
		const w = workQueueRef.current.length;
		const tOpen = ticketsExpandedRef.current;
		const cOpen = consultationsExpandedRef.current;
		const wOpen = workExpandedRef.current;
		// A cross reaches an empty section too, so the step into it is
		// always possible while the other section is expanded: the empty
		// message is the row the cursor takes, and the Work section keeps
		// its header while it is empty the same way (ADR 0049).
		if (selectionRef.current === "queue") {
			// Up out of the queue crosses into the Consultation section, or into
			// the Ticket section while the Consultation section is collapsed, and
			// the cross opens at the queue's own first row. Where the other
			// section happens to hold its cursor says nothing about where this
			// one stands: a direct click on the Work header can land the cursor on
			// the only row of a queue the Consultation cursor never touched.
			const crossUp = cOpen || tOpen;
			return (
				(wOpen && (w > 1 || (workQueueIndexRef.current === 0 && crossUp))) || (!wOpen && crossUp)
			);
		}
		if (selectionRef.current === "consultation")
			return (
				(cOpen && (c > 1 || (consultationIndexRef.current === 0 && tOpen))) || (!cOpen && tOpen)
			);
		return (
			(tOpen && (tStops > 1 || (cOpen && selectedIndexRef.current >= t - 1))) || (!tOpen && cOpen)
		);
	};
	/** The queue item that waits under the row the cursor holds (ADR 0049). */
	const queueItemForSelectedRow = (): WorkQueueItem | null => {
		if (selectionRef.current === "ticket")
			return handoffItemWaitingForTicket(workQueueRef.current, ticketAtCursor()?.identity);
		if (selectionRef.current === "consultation")
			return consultationItemWaitingFor(
				workQueueRef.current,
				consultationsRef.current[consultationIndexRef.current]?.id,
			);
		return null;
	};
	/**
	 * The facts the Main view states when it opens the Key guide or the Message
	 * view for a mode another surface owns.
	 *
	 * The guide names the keys that mode dispatches, and it gates them on what
	 * the Main view can honestly read from outside that surface: no row stands
	 * under a cursor the Main view does not hold, and no Action row count it can
	 * count. The Body pane is stated as a pane that holds rows and scrolls,
	 * because the Main view reads nothing of the open surface's body, and a Body
	 * reported as empty would refuse a key the surface can run. The surface that
	 * owns the mode states its own rows' facts for its own bar and its own keys.
	 */
	const overlayGuideFacts = {
		actionRowCount: 0,
		bodyScrollable: true,
		bodyEmpty: false,
		editableActionSelected: false,
		planeActionSelected: false,
	};
	/**
	 * The Availability facts of one mode the Main view dispatches, paints on
	 * its own Action bar, or catalogs in the Key guide.
	 *
	 * Each mode names only the facts its controls read, and the compiler
	 * rejects a mode whose facts this view did not state.
	 */
	const mainFactsFor = (mode: InteractionMode): AvailabilityFacts => {
		switch (mode) {
			case "ticket-list":
				return availabilityFacts("ticket-list", standing, {
					...ticketCursor(),
					...groupFacts(),
					groupingAxis: groupingAxisRef.current,
					listCanMove: listCanMove(),
					queueItemForSelectedRow: queueItemForSelectedRow(),
				});
			case "ticket-detail":
				return availabilityFacts("ticket-detail", standing, {
					...ticketCursor(),
					...groupFacts(),
					groupingAxis: groupingAxisRef.current,
					detailCanScroll: detailMaxScroll > 0,
				});
			case "consultation-list":
				return availabilityFacts("consultation-list", standing, {
					...consultationCursor(),
					listCanMove: listCanMove(),
					queueItemForSelectedRow: queueItemForSelectedRow(),
				});
			case "consultation-detail":
				return availabilityFacts("consultation-detail", standing, {
					...consultationCursor(),
					detailCanScroll: consultationMaxScroll > 0,
				});
			case "work-queue-list":
				return availabilityFacts("work-queue-list", standing, {
					...queueFacts(),
					listCanMove: listCanMove(),
				});
			case "work-queue-detail":
				return availabilityFacts("work-queue-detail", standing, {
					...queueFacts(),
					detailCanScroll: workQueueDetailMaxScroll > 0,
				});
			case "consultation-interaction":
				// The Agent owns every key but the configured exit.
				return availabilityFacts("consultation-interaction", standing, {});
			case "form-field":
				// The response editor owns its own slot facts and dispatches from
				// them; this record only names the mode the Main view's bar reads.
				return availabilityFacts("form-field", standing, { fieldHasSelection: false });
			case "decision-modal":
				return availabilityFacts("decision-modal", standing, overlayGuideFacts);
			case "missing-modal":
			case "action-panel":
				return availabilityFacts(mode, standing, { actionRowCount: 0 });
			case "live-view":
				return availabilityFacts("live-view", standing, {
					...ticketCursor(),
					bodyScrollable: true,
					bodyEmpty: false,
				});
			case "repository-select":
				return availabilityFacts("repository-select", standing, {
					listCanMove: listCanMove(),
					repositoryCount: 0,
					searchText: "",
					pendingCount: 0,
				});
			case "override-list":
				return availabilityFacts("override-list", standing, {});
			case "override-model":
			case "override-text":
				return availabilityFacts(mode, standing, { fieldHasSelection: false });
			case "form-selector":
				return availabilityFacts("form-selector", standing, {
					fieldHasSelection: false,
					formCycleCount: 0,
				});
			case "form-action":
				return availabilityFacts("form-action", standing, {
					fieldHasSelection: false,
					formRefusal: null,
				});
			case "key-guide":
			case "message-view":
				// The overlay's own two modes read nothing beside the standing facts.
				return availabilityFacts(mode, standing, {});
			default: {
				// A mode the plane has never seen. The assertion is the check: a new
				// Interaction mode reaches this line as a compile error, not as a
				// record borrowed from another mode.
				const unstated: never = mode;
				throw new Error(`the Main view states no facts for ${unstated}`);
			}
		}
	};
	/** The facts of the mode the Main view's own keys and bar run in. */
	const mainFacts = (): AvailabilityFacts => mainFactsFor(currentBaseMode());
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
				liveSources.length === 0
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
			facts: mainFacts(),
			ungated: ["decide-completion", "handoff", "live-view"],
			onUnavailable: setWarningMessage,
			onEmergencyExit: () => renderer.destroy(),
			handlers: {
				// A settled Ticket uses the distinct Decide control. It names
				// what Enter does instead of leaving a dimmed Hand off hint
				// that still opens a panel.
				"decide-completion": ({ facts }) => decideCompletion(facts),
				// An open Ticket is the only one a Hand off starts, and it can
				// queue behind nothing: the control stays ungated so a Ticket
				// with no other Enter meaning still gets the catalogue's own
				// refusal.
				handoff: ({ facts, refuse }) => {
					if (!ticketSectionFacts(facts)) return;
					const ticket = facts.selectedTicket;
					if (ticket === undefined || !inFlight(ticket)) {
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
				"live-view": ({ facts, refuse }) => {
					if (!ticketSectionFacts(facts)) return;
					const ticket = facts.selectedTicket;
					if (ticket === undefined || !inFlight(ticket)) return refuse();
					if (factsFor(ticket).failure === "missing")
						setPanel({ kind: "missing", identity: ticket.identity });
					else setPanel({ kind: "live", identity: ticket.identity });
				},
				// `g` focuses the agent's pane in herdr and changes nothing
				// (ADR 0033): the catalogue gated the pane, so this runs the
				// focus and the confirmation stands on the Message line.
				"ticket-goto": ({ facts }) => {
					if (!ticketSectionFacts(facts)) return;
					const ticket = facts.selectedTicket;
					if (ticket !== undefined) runGoto(ticket);
				},
				// `w` ends the selected Ticket's work cycle (ADR 0031). The catalogue
				// refused an open Ticket, so every Ticket that reaches here has a live
				// Agent or a settled turn behind it, and both confirm first: the dialog
				// states who is alive and what survives, and nothing runs until the
				// operator answers it.
				"ticket-close": ({ facts }) => {
					if (!ticketSectionFacts(facts)) return;
					const ticket = facts.selectedTicket;
					if (ticket === undefined) return;
					if (state === undefined) {
						// A work cycle is durable factory state: the projection the App
						// holds in memory has none to end, and the key says so instead of
						// opening a dialog that could run nothing.
						setWarningMessage("closing a Ticket needs SQLite state");
						return;
					}
					setPanel({ kind: "ticket-close", identity: ticket.identity });
				},
				quit: () => renderer.destroy(),
				detail: () => focusPane("detail"),
				"consultation-list": () => focusPane("list"),
				tickets: () => focusPane("list"),
				"queue-list": () => focusPane("list"),
				// `+` (or `=`, its unshifted form) promotes the item under the
				// cursor, `-` demotes it (ADR 0049): the keys the operator already
				// knew for raising and lowering a rank, with the queue's own
				// refusal when the item already stands where the move would put it.
				"queue-promote": ({ facts }) => {
					if (!workQueueSectionFacts(facts)) return;
					moveQueueItem("up", facts.selectedWorkQueueItem);
				},
				"queue-demote": ({ facts }) => {
					if (!workQueueSectionFacts(facts)) return;
					moveQueueItem("down", facts.selectedWorkQueueItem);
				},
				"queue-remove": ({ facts }) => {
					if (!workQueueSectionFacts(facts)) return;
					removeQueueItem(facts.selectedWorkQueueItem);
				},
				// Enter on a queue row force-dispatches the item under the cursor over a
				// full Parallel limit (issue #89). The catalogue gated the availability,
				// so this runs the dispatch and nothing else; the module owns every line
				// the start or its failure leaves.
				"queue-force-dispatch": ({ facts }) => {
					if (!workQueueSectionFacts(facts)) return;
					forceDispatchQueueItem(facts.selectedWorkQueueItem);
				},
				"move-list": ({ key }) => moveRange(key.name),
				"scroll-detail": ({ key }) => moveRange(key.name),
				"section-toggle": () => toggleSection(),
				// `Tab` steps the Ticket list's Grouping axis (issue #159): the
				// shell writes the durable value and states the axis on the
				// Message line, and the list redraws with its Group headers.
				"group-axis": () => cycleGroupingAxis(),
				// `i` on a Group header under the repository axis opens the
				// Repository init's confirmation panel (ADR 0075); the catalogue
				// splits it from the ignore's `i` on the row the cursor stands on.
				"repository-init": () => openRepositoryInit(),
				// `o` opens the select list of the repositories the operator's
				// gh identity can init (ADR 0082): the bootstrap path for a
				// repository that has no ticket and no source yet.
				"repository-select-open": () => {
					if (refuseInitInFlight()) return;
					setPanel({ kind: "repository-select" });
				},
				// `Space` on a Group header folds that Group; the catalogue
				// resolved the key here on the facts under the cursor (issue #170).
				"group-fold": () => foldGroupAtCursor(),
				// `+` (or `=`, its unshifted form) and `-` move the Group under the
				// cursor to its visible neighbor (ADR 0071): the same keys the
				// queue's promote and demote read, scoped by the catalogue to the
				// Ticket section's Group headers.
				"group-move-up": () => moveGroupAtCursor("up"),
				"group-move-down": () => moveGroupAtCursor("down"),
				launch: () => {
					if (Object.keys(configRef.current.consultationTypes).length === 0)
						setWarningMessage(
							"no Consultation types configured; add [consultation-types.<name>] to the config file",
						);
					else {
						// While a Consultation is under the cursor, a missing or failed
						// Consultation is replaced rather than reopened: the launcher
						// remembers which row asked for the replacement.
						const selected =
							selectionRef.current === "consultation"
								? consultationsRef.current[consultationIndexRef.current]
								: undefined;
						if (selected !== undefined && isReplacedConsultation(selected))
							openReplacementLauncher(selected);
						else setLauncher(true);
					}
				},
				history: cycleConsultationHistory,
				// `i` ignores the selected Ticket or takes it back, and `f` cycles the
				// Ticket section's List filter (ADR 0060). The catalogue gated the
				// obligation and the section, so both run the act and nothing else.
				"ticket-ignore": () => toggleTicketIgnore(),
				"ticket-mute": () => toggleSourceMute(),
				"ticket-filter": () => cycleTicketFilter(),
				"consultation-recovery": ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected === undefined) return;
					// A closing record's recovery is the close panel's own: its Retry
					// and Force-close rows already answer the stuck cleanup. Every other
					// broken or stuck state opens the recovery panel, whose rows the
					// record's state names.
					setPanel({
						kind: selected.state === "closing" ? "consultation-close" : "consultation-recovery",
						identity: selected.id,
					});
				},
				"consultation-close": ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected === undefined) return;
					runConsultationClose(selected);
				},
				"consultation-delete": ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected === undefined) return;
					setPanel({ kind: "consultation-delete", identity: selected.id });
				},
				// `s` schedules the unscheduled record back into the Work queue
				// (issue #91, ADR 0049): the enqueue's hard check runs first, the
				// same one the launcher's submit runs, so a record the config cannot
				// start never takes a row. The state's one write then moves it to
				// `queued` at the queue's tail, and the pickup is its only starter
				// from there.
				"consultation-schedule": ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected === undefined) return;
					if (consultationOperations === undefined) {
						setWarningMessage("Consultations require SQLite state");
						return;
					}
					void consultationOperations.checkEnqueue(selected.typeName).then((refusal) => {
						if (refusal !== undefined) {
							setErrorMessage(`consultation not scheduled: ${refusal}`);
							return;
						}
						// The operations own the Message line and the Consultation rows,
						// but the queue rows re-read only here: the item lands at the
						// queue's tail in the same write the section's Delete path
						// refreshes, so the schedule path does the same. An immediate
						// pickup pass follows every enqueue (ADR 0049), so the scheduled
						// record takes a free seat in this tick instead of waiting for the
						// next poll; the pause and the cap are the pickup's own checks.
						const scheduled = consultationOperations.schedule(selected);
						if (scheduled) {
							replaceTickets();
							void handoffDispatchRef.current?.dispatch.pickupWorkQueue();
						}
					});
				},
				// Enter starts the unscheduled record now (issue #91): the pickup
				// seam with the cap skipped. The operations own every line the
				// start or its failure leaves; the key names the cap when the seat
				// count stood over it at the key, the way the queue's force-
				// dispatch line does, and says when a race out-waited it. The key is
				// the operator's own start on the record, so the record's start line
				// reads `force-dispatch` whatever the seat count reads (issue #220,
				// ADR 0102).
				"consultation-start-now": ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected === undefined) return;
					if (consultationOperations === undefined) {
						setWarningMessage("Consultations require SQLite state");
						return;
					}
					// The line states only what the key measured, the way the
					// queue's force-dispatch line does: the cap stands when the
					// seat count stood over the limit at the key.
					const cap = configRef.current.maxParallelAgents;
					const overCap = overParallelLimit(cap, currentSeatCount());
					void consultationOperations.pickup(selected.id, "force-dispatch").then((outcome) => {
						if (outcome.kind === "moved") {
							setWarningMessage(
								`consultation ${selected.id.slice(0, 8)}: the record is no longer unscheduled`,
							);
							return;
						}
						if (outcome.kind === "started")
							setNoticeMessage(
								overCap
									? `starting Consultation ${selected.id.slice(0, 8)} over the Parallel limit`
									: `starting Consultation ${selected.id.slice(0, 8)}`,
							);
					});
				},
				"consultation-respond": ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected === undefined) return;
					beginResponse(selected);
				},
				"consultation-interact": () => setInteraction(true),
				"consultation-goto": ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected === undefined || selected.paneId === null) return;
					// Navigation only (ADR 0025): the Consultation record stays
					// untouched, and the confirmation stands on the Message line
					// as a result, never as a warning. The Goto moves herdr's view
					// to the Agent's pane (ADR 0061), and the line names the
					// workspace it landed in.
					void commandRunner
						.run("herdr", ["agent", "focus", selected.paneId])
						.then(async (result) => {
							if (result.code !== 0) {
								setErrorMessage(`agent focus failed: ${commandFailureText(result)}`);
								return;
							}
							const workspaceId = selected.workspaceId;
							const label = workspaceId === null ? null : await workspaceLabelOf(workspaceId);
							reportMessage({
								severity: "info",
								text:
									label === null
										? `focused the Agent pane for Consultation ${selected.id.slice(0, 8)}`
										: `focused the Agent pane for Consultation ${selected.id.slice(0, 8)} in workspace ${label}`,
							});
						});
				},
				override: openOverride,
				recover: ({ facts }) => {
					if (!consultationSectionFacts(facts)) return;
					const selected = facts.selectedConsultation;
					if (selected?.state === "opening") recoverConsultationOpening(selected);
				},
				refresh: () => {
					// Refresh answers for the whole plane: the Ticket sources, and
					// the Consultation projection while its section is visible or its
					// Consultation is under the cursor.
					if (consultationsExpandedRef.current || selectionRef.current === "consultation")
						replaceConsultations();
					refreshNow();
				},
				// `p` pauses or resumes the Work queue's drain (ADR 0052): the
				// pickup takes no item and the top-up adds none while the pause
				// stands, and the force-dispatch passes it. The state's one write
				// owns the fact; resuming asks the pickup for one more item, so
				// the seat the pause gave back frees in the same frame the key
				// landed.
				"queue-pause": () => {
					if (state === undefined) return;
					const next = !state.workQueue.queuePaused();
					// The write is guarded the way the Auto-handoff mode's identical fact
					// is (ADR 0052). What differs is what a refused write means: the
					// pickup and the top-up read the pause from the state, not from this
					// shell's copy, so a write that failed left the brake where it
					// stood. The key says so and moves nothing - the section's header, the
					// bar's hint, and the drain all keep reading the value that stands.
					try {
						state.workQueue.setQueuePaused(next);
					} catch (error) {
						const reason = errorMessage(error);
						// The refused write leaves its record line the way the Auto-handoff
						// mode's identical failure does, so two facts of one kind do not fail
						// two ways (issue #223 review). The line is `warn`: the operator pressed
						// the key and the brake did not move.
						logger?.warn(`queue: the Work queue pause did not move: ${reason}`);
						setErrorMessage(`the queue pause did not move: ${reason}`);
						return;
					}
					setQueuePaused(next);
					// The pause is the other fact the operator sets by key, and it holds
					// every automatic add while it stands (issue #223). The `queue:` prefix
					// keeps this line in its own family: the cycle states its own hold line
					// about the same fact, and a reader grepping one must not get the other.
					logger?.info(next ? "queue: the Work queue is paused" : "queue: the Work queue resumed");
					setNoticeMessage(next ? "Work queue paused" : "Work queue resumed");
					if (!next) void handoffDispatch?.pickupWorkQueue();
				},
				// Enter on a Ticket or Consultation row that waits in the Work
				// queue (ADR 0049): the cursor jumps to the item's row, where the
				// queue's keys act on it. The catalogue resolved it ahead of the
				// other Enter meanings, so this only moves the cursor and never
				// starts or decides.
				"queue-jump": ({ facts }) => {
					if (facts.mode !== "ticket-list" && facts.mode !== "consultation-list") return;
					const item = facts.queueItemForSelectedRow;
					if (item === null) return;
					const index = workQueueRef.current.findIndex(
						(candidate) => workQueueIdentityOf(candidate) === workQueueIdentityOf(item),
					);
					if (index < 0) return;
					selectionRef.current = "queue";
					setSelection("queue");
					workQueueIndexRef.current = index;
					setWorkQueueIndex(index);
					setWorkExpanded(true);
					workExpandedRef.current = true;
					focusPane("list");
				},
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
	/**
	 * Enter on a settled Ticket: open the decision screen on the turn the
	 * factory left for the operator to decide.
	 */
	const decideCompletion = (facts: AvailabilityFacts) => {
		if (!ticketSectionFacts(facts)) return;
		const ticket = facts.selectedTicket;
		if (ticket === undefined) return;
		if (autoModeRef.current) {
			// The factory decides the ticket itself: the operator gets the
			// notice on the Message line, and the observation makes the
			// decision in the background. A notice is not progress, so it holds
			// its own slot and the next fact takes the line back.
			setNoticeMessage("auto-handoff is on: the factory decides this ticket");
			return;
		}
		// The mode decides the route at runtime (ADR 0092), so in manual mode the
		// operator's key opens the screen on the settled turn in every case: the
		// screen reads the turn's derived Next step and states the gate that
		// holds it.
		setPanel({ kind: "decision", identity: ticket.identity });
	};
	// A state may already hold tickets when the app boots: read them once at
	// mount, before any refresh or observation cycle runs.
	useEffect(() => {
		if (state === undefined) return;
		replaceTickets();
		replaceConsultations();
		// The queue pause is factory state (ADR 0052): a restart finds the
		// brake where the operator left it.
		setQueuePaused(state.workQueue.queuePaused());
	}, [state, replaceTickets, replaceConsultations]);
	// The one-time note on the Message line at the first sight of an
	// uninitialized or drifted repository (ADR 0075, story 20): the operator
	// learns the act once per run, beside the marker on the repository's Group
	// header, and the plane does not repeat it on every poll. The marker stands
	// only on the repository axis, and the note explains it, so the note waits
	// for the repository axis as well as the first ticket read: it never stands
	// on an empty list, and it never outlives the axis its marker rides on.
	useEffect(() => {
		if (
			initNoteShownRef.current ||
			state === undefined ||
			machineTickets.length === 0 ||
			groupingAxis !== "repository"
		)
			return;
		// The repositories that stand uninitialized or in Init drift on this read,
		// once per repository the list carries. The hash is hoisted out of the
		// loop, the way the marker hoists it, so the note re-hashes the config
		// once, not per repository.
		const currentHash = repositoryInitSettingsHash(config.workflowStates, config.taskTypes);
		const seen = new Set<string>();
		const unprepared: { name: string; marker: "uninit" | "drift" }[] = [];
		for (const ticket of machineTickets) {
			const name = ticket.repository;
			if (seen.has(name)) continue;
			seen.add(name);
			const identity = ticket.repositoryRef.identity;
			const marker = repositoryInitStanding(
				state.repositoryInit.repositoryInitFact(identity),
				currentHash,
			);
			if (marker !== null) unprepared.push({ name, marker });
		}
		if (unprepared.length === 0) return;
		// The note stands at the first sight of one unprepared repository: the
		// flag is set only when the note actually stands, so an all-prepared
		// read never consumes the run's one-time note.
		initNoteShownRef.current = true;
		const names = unprepared.map((entry) => `${entry.name} (${entry.marker})`).join(", ");
		// The note stands on the repository axis (the marker rides the Group
		// header), so its path is the real one: the `i` key on the repository's
		// own Group header.
		setNoticeMessage(
			`Not initialized: ${names}. Press i on one of their Group headers to run the init.`,
		);
	}, [machineTickets, state, config, groupingAxis, setNoticeMessage]);
	// Repository choices are validated before the launcher presents them. A
	// stale mapping stays hidden instead of letting an operator start in an
	// unrelated checkout. The active view answers them (ADR 0060): the operator's
	// List filter never moves the catalog, so a cycle of `f` re-validates nothing.
	const repositoryCatalogKey = consultationRepositoryCatalog(config, machineTickets)
		.map((option) => `${option.identity}\u0000${option.path}`)
		.join("\u0001");
	// biome-ignore lint/correctness/useExhaustiveDependencies: repositoryCatalogKey is derived from config and machineTickets and tracks both
	useEffect(() => {
		let active = true;
		void validateConsultationRepositoryOptions(
			consultationRepositoryCatalog(config, machineTickets),
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
	// The selected Consultation's bodies refresh at one-second cadence. The
	// pane read stays on its own interval, and the Session view (ADR 0025)
	// reads the Agent's session record in the same tick. Lifecycle polling
	// remains owned by the shared observation coordinator. A closed
	// Consultation is a record the operator reads: its detail pane shows the
	// session record when it reads, else the captured history, and the
	// record does not grow while nothing runs, so it gets one read and no
	// timer.
	useEffect(() => {
		if (state === undefined || selection !== "consultation" || selectedConsultation === undefined) {
			setLiveOutput(null);
			setSessionEntries(null);
			return;
		}
		const consultation = selectedConsultation;
		const paneId = consultation.paneId;
		// The session record path the last herdr poll reported for this
		// Consultation's Agent: herdr names it per pane (ADR 0025).
		const sessionPath = (): string => {
			const polled = agentsRef.current;
			if (polled === null) return "";
			const match = matchConsultationAgent(consultation, polled);
			return match === undefined || match === "ambiguous" ? "" : match.sessionId;
		};
		const readSessionNow = (): readonly SessionEntry[] | null => {
			const kind = configRef.current.agents[consultation.agentType]?.kind;
			const path = sessionPath();
			const read =
				kind !== undefined && path !== ""
					? readSessionExchange(kind, path)
					: ({ kind: "unavailable" } as const);
			return read.kind === "readable" ? read.entries : null;
		};
		if (paneId === null || consultation.state === "closed") {
			// A closed Consultation, or one whose Agent pane is gone: one
			// read of the record, then the captured history stands in.
			setLiveOutput(null);
			setSessionEntries(readSessionNow());
			return;
		}
		let active = true;
		let previousBody: string | null = null;
		const reader = new HerdrAgentReader(commandRunner);
		const refresh = async () => {
			const output = interaction
				? await reader.readPaneAnsi(paneId, configRef.current.completionMessageLines)
				: await reader.readPane(paneId, configRef.current.completionMessageLines);
			if (!active) return;
			consultationOperations?.recordOutputRead(consultation.id, output);
			const session = interaction ? null : readSessionNow();
			if (!active) return;
			if (output !== null) setLiveOutput(output);
			setSessionEntries(session);
			// The body the operator is looking at: the Session view when it
			// renders, the pane read otherwise. Its growth is what the
			// follow and the new-output marker watch.
			const shown =
				session !== null && session.length > 0
					? JSON.stringify(session)
					: interaction
						? null
						: output;
			const changed = shown !== null && shown !== previousBody;
			previousBody = shown;
			if (consultationFollowRef.current) {
				setConsultationScroll(999999);
				setNewOutput(false);
			} else if (changed) {
				setNewOutput(true);
			}
		};
		outputRefreshRef.current = () => void refresh();
		void refresh();
		const timer = setInterval(() => void refresh(), interaction ? 250 : 1000);
		return () => {
			active = false;
			outputRefreshRef.current = null;
			clearInterval(timer);
		};
	}, [commandRunner, consultationOperations, interaction, selectedConsultation, selection, state]);
	// A ref lets the key handler use the startup coordinator without making
	// React recreate keyboard subscriptions on each frame.
	useEffect(() => {
		if (state === undefined) return;
		const coordinator = new RefreshCoordinator(
			liveSources,
			state,
			(outcome) => {
				// The pull request source's one warning line surfaces on the
				// Message line (ADR 0023).
				if (outcome?.status === "success")
					for (const warning of outcome.warnings ?? []) setWarningMessage(warning);
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
				log: logger,
			},
		);
		coordinatorRef.current = coordinator;
		coordinator.start();
		return () => {
			coordinator.stop();
			coordinatorRef.current = undefined;
		};
	}, [
		state,
		liveSources,
		replaceTickets,
		replaceConsultations,
		clearWorkingMessage,
		setWarningMessage,
		logger,
	]);
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
			// The plane action's ask (ADR 0068): the top-up's walks cross it for
			// the positions their task type resolves on the plane action.
			dispatchPlaneAction: (intent) => dispatch.dispatchPlaneAction(intent),
			// The transition fire of a completed settle (ADR 0027): pull the
			// pull request sources fresh - the agent's new pull request must
			// be in the list before the machine can find it - and fire the
			// task type's transition through the command runner.
			fireCompleted: async (ticket) => {
				return await fireTransition({
					config: configRef.current,
					state,
					runner: commandRunner,
					ticketIdentity: ticket.ticketIdentity,
					taskType: ticket.taskType,
					refresh: refreshPullRequestSources,
				});
			},
			// The re-fire of the recorded skips (ADR 0042): a refresh that found
			// the fixing pull request re-fires the transition the ticket's
			// newest completion trace recorded as the skip. The sweep reads the
			// projection the refresh just landed, so it takes no refresh of its
			// own, but the fire it runs carries the settle-time fire's refresh
			// (ADR 0076), so the publish it runs lands the pull request the
			// fire's position resolves on, and the fire writes through the
			// command runner, the way the settle-time fire does.
			refireRecordedSkips: () =>
				refireRecordedSkips({
					config: configRef.current,
					state,
					runner: commandRunner,
					refresh: refreshPullRequestSources,
				}),
			// The Work queue's pickup (ADR 0034): the cycle starts the waiting
			// manual starts before auto-dispatch, in queue order.
			pickupWorkQueue: () => dispatch.pickupWorkQueue(),
			// The cycle's end may have changed the ticket's source item (a merged
			// pull request, a closed issue): re-read the sources now, so the
			// ticket is re-verified - or drops off the list - before the next
			// automatic dispatch of it.
			onCycleEnd: (identity) => {
				refreshTicketSources(identity);
				closeCycleEndDraft(identity);
			},
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
			// The Ticket header's seat count and the cycle's gates share this
			// grace, so the booting seats they count agree.
			startupGraceMs: STARTUP_GRACE_MS,
			intervalMs: pollIntervalMs ?? configRef.current.agentPollIntervalSeconds * 1000,
			onChanged: () => {
				replaceTickets();
				replaceConsultations();
			},
			onAgents: (agents) => setAgents(agents),
			onConsultationsChanged: replaceConsultations,
			onConsultationAttention: (_id) => {
				// The flash stays here; the bell write and its attention-bell gate
				// live in the shared attention service (ADR 0080).
				setBell(true);
				setTimeout(() => setBell(false), 250);
				attention.ring();
			},
			reconcileOnly: true,
			// The cycle's record lines: each hold its automatic walks take
			// (issue #223).
			log: logger,
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
				// The handoff dispatch is the one background loop that outlives the
				// state: its run settles asynchronously, so stop it before the
				// owner closes the state, or the settlement reads a closed database.
				handoffDispatchRef.current?.dispatch.stop();
			},
		});
		return () => {
			// Only the loop this run made. The dispatch module outlives it: the
			// effect re-runs on a config write-back, and a stopped module is a
			// plane that starts nothing for the rest of the run.
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
		attention,
		onReady,
		clearOperationMessage,
		setStatus,
		refreshTicketSources,
		closeCycleEndDraft,
		refreshPullRequestSources,
		logger,
	]);
	function focusPane(pane: Pane) {
		focusedPaneRef.current = pane;
		setFocusedPane(pane);
	}
	/**
	 * Move the unified cursor to one section's list: put it on that section's
	 * retained row and focus the list pane. Row clicks, box focus, and list
	 * wheels pass through it, so a click in one section never leaves the
	 * cursor on a row the operator is not looking at.
	 */
	function focusListSection(next: "ticket" | "consultation" | "queue") {
		if (selectionRef.current !== next) {
			selectionRef.current = next;
			setSelection(next);
		}
		focusPane("list");
	}
	/**
	 * Move the Ticket cursor to one row of the section's list (issue #159).
	 *
	 * The index is a place in the row list, so it can name a Group header: the
	 * cursor rests there, the Ticket controls refuse it in the catalogue's
	 * words, and the fold takes the `Space` key there. It can also name the blank row
	 * between two Groups, which holds no cursor: the click lands on the Group
	 * that row parts, and never folds it.
	 */
	function selectTicketRow(index: number) {
		const rows = ticketRowsRef.current;
		const next = settleRowIndex(rows, clamp(index, 0, Math.max(0, rows.length - 1)));
		if (next === selectedIndexRef.current) return;
		selectedIndexRef.current = next;
		setSelectedIndex(next);
	}
	function moveList(delta: number) {
		// One step moves the cursor to the next row that holds something: the
		// blank row between two Groups is crossed over, never rested on.
		selectTicketRow(stepRowIndex(ticketRowsRef.current, selectedIndexRef.current, delta));
	}
	/**
	 * Cycle the Grouping axis (issue #159, ADR 0058).
	 *
	 * The press writes the durable value first and the view follows the press in
	 * every case: a state file that will not take the write is reported on the
	 * Message line, and the split the operator asked for still stands for the run
	 * (user story 56). The cursor keeps the ticket it held, so grouping never
	 * loses the operator's place (user story 42).
	 */
	function cycleGroupingAxis() {
		const next = nextGroupingAxis(groupingAxisRef.current);
		const writeFailure =
			state === undefined
				? undefined
				: ((): string | undefined => {
						try {
							state.grouping.setGroupingAxis(TICKET_GROUP_SECTION, next);
							return undefined;
						} catch (error) {
							return errorMessage(error);
						}
					})();
		const anchor = rowAnchorOf(ticketRowsRef.current, selectedIndexRef.current);
		const nextOrder = next === "none" ? [] : storedGroupOrderOf(next);
		const nextFacts = factRows(ticketsRef.current);
		const nextRows = ticketRows(
			nextFacts,
			next,
			groupFoldsRef.current,
			nextOrder,
			positionOrderOf(),
		);
		const nextIndex = ticketRowIndexForAnchor(
			nextRows,
			anchor,
			selectedIndexRef.current,
			nextFacts,
			next,
		);
		groupingAxisRef.current = next;
		setGroupingAxis(next);
		groupOrderListRef.current = nextOrder;
		setGroupOrderList(nextOrder);
		ticketRowsRef.current = nextRows;
		selectedIndexRef.current = nextIndex;
		setSelectedIndex(nextIndex);
		if (writeFailure !== undefined)
			setErrorMessage(`the grouping axis did not save: ${writeFailure}`);
		else setNoticeMessage(groupingAxisNotice(next));
	}
	/**
	 * Fold or open one Group (issue #159).
	 *
	 * The fold is the only thing that moves: no count, mode cell, gate, or queue
	 * fact reads the row list, so a fold changes what is shown and nothing else
	 * (ADR 0059). The cursor lands on the Group header the fold was made at, so
	 * the fold is reversible by hand without hunting for it (user story 34).
	 */
	function toggleGroupFold(value: string) {
		const axis = groupingAxisRef.current;
		const nextFolds = toggleFold(groupFoldsRef.current, axis, value);
		const anchor = rowAnchorOf(ticketRowsRef.current, selectedIndexRef.current);
		const nextFacts = factRows(ticketsRef.current);
		const nextRows = ticketRows(
			nextFacts,
			axis,
			nextFolds,
			groupOrderListRef.current,
			positionOrderOf(),
		);
		const headerIndex = nextRows.findIndex(
			(row) => row.kind === "group" && row.group.value === value,
		);
		const nextIndex =
			headerIndex >= 0
				? headerIndex
				: ticketRowIndexForAnchor(nextRows, anchor, selectedIndexRef.current, nextFacts, axis);
		groupFoldsRef.current = nextFolds;
		setGroupFolds(nextFolds);
		ticketRowsRef.current = nextRows;
		selectedIndexRef.current = nextIndex;
		setSelectedIndex(nextIndex);
	}
	/**
	 * Fold or open the Group under the cursor, the `Space` route (issue #170).
	 * A press anywhere else answers the catalogue's refusal: the catalogue
	 * resolved the key to this route on the facts under the cursor.
	 */
	function foldGroupAtCursor() {
		const row = ticketRowsRef.current[selectedIndexRef.current];
		if (row === undefined || row.kind !== "group") return;
		toggleGroupFold(row.group.value);
	}
	/**
	 * Move the Group under the cursor to its visible neighbor above or below
	 * it (ADR 0071).
	 *
	 * The two Group values trade their places in the axis' full order, and the
	 * full order is the write: the operator's fact, durable the moment the
	 * press returns, and the order every later read stands in. A Group the
	 * filter hides keeps its slot in the order, so the visible list stands
	 * exactly as the press asked for. At the first or the last visible Group
	 * the press runs no move and the Message line says so, the queue's own
	 * refusal. The cursor lands on the Group the move ran on, so the operator
	 * can press again without hunting, and a write that fails is reported the
	 * way the axis' own is, with the view following the press (user story 56).
	 */
	function moveGroupAtCursor(direction: "up" | "down") {
		const axis = groupingAxisRef.current;
		if (axis === "none") return;
		const rows = ticketRowsRef.current;
		const index = selectedIndexRef.current;
		const row = rows[index];
		if (row === undefined || row.kind !== "group") return;
		const value = row.group.value;
		// The neighbor is the next visible Group header in the direction, the
		// way the cursor itself crosses the blank rows between the Groups.
		const step = direction === "up" ? -1 : 1;
		let cursor = index + step;
		while (cursor >= 0 && cursor < rows.length) {
			const candidate = rows[cursor];
			if (candidate !== undefined && candidate.kind === "group" && candidate.group.value !== value)
				break;
			cursor += step;
		}
		const neighborRow = cursor >= 0 && cursor < rows.length ? rows[cursor] : undefined;
		if (neighborRow === undefined || neighborRow.kind !== "group") {
			setWarningMessage(
				direction === "up" ? "the group is first in the list" : "the group is last in the list",
			);
			return;
		}
		const present = rows
			.filter((r) => r.kind === "group")
			.map((r) => (r.kind === "group" ? r.group.value : ""));
		const compare = ticketGroupCompare(axis, positionOrderOf());
		const moved = movedGroupOrder(
			groupOrderListRef.current,
			present,
			compare,
			value,
			neighborRow.group.value,
		);
		if (moved === null) return;
		const writeFailure =
			state === undefined
				? undefined
				: ((): string | undefined => {
						try {
							state.grouping.setGroupOrder(TICKET_GROUP_SECTION, axis, moved);
							return undefined;
						} catch (error) {
							return errorMessage(error);
						}
					})();
		if (state === undefined)
			groupOrdersForRunRef.current = {
				...groupOrdersForRunRef.current,
				[axis]: [...moved],
			};
		const nextRows = ticketRows(
			factRows(ticketsRef.current),
			axis,
			groupFoldsRef.current,
			moved,
			positionOrderOf(),
		);
		const headerIndex = nextRows.findIndex((r) => r.kind === "group" && r.group.value === value);
		groupOrderListRef.current = [...moved];
		setGroupOrderList([...moved]);
		ticketRowsRef.current = nextRows;
		selectedIndexRef.current = headerIndex >= 0 ? headerIndex : index;
		setSelectedIndex(selectedIndexRef.current);
		if (writeFailure !== undefined)
			setErrorMessage(`the group order did not save: ${writeFailure}`);
	}
	// The Repository init (ADR 0075): `i` on a Group header under the
	// repository axis opens the confirmation panel. The handler resolves the
	// repository the cursor names - a ticket in the group gives its identity
	// and clone URL, the configured source gives its host and auth, and the
	// mapping gives the checkout the act works in - and plans the change
	// against the factory's own settings. The plan is the generator's answer,
	// so the panel states exactly what the confirmed act will change.
	function openRepositoryInit() {
		if (groupingAxisRef.current !== "repository") return;
		const row = ticketRowsRef.current[selectedIndexRef.current];
		if (row === undefined || row.kind !== "group") return;
		void openRepositoryInitFor(row.group.value).catch((error) =>
			setErrorMessage(errorMessage(error)),
		);
	}
	async function openRepositoryInitFor(displayName: string) {
		const factoryState = state;
		if (factoryState === undefined) {
			setErrorMessage("the repository init needs SQLite state");
			return;
		}
		const cfg = configRef.current;
		const ticket = ticketsRef.current.find((item) => item.repository === displayName);
		if (ticket === undefined) {
			setErrorMessage(`no ticket names the repository ${displayName}`);
			return;
		}
		const ref = ticket.repositoryRef;
		const source = cfg.sources.find((item) => item.repositories.includes(ref.displayName));
		if (source === undefined) {
			setErrorMessage(`no source is configured for ${ref.displayName}`);
			return;
		}
		// The plan runs async with the base view's keyboard live (ADR 0083):
		// the marker holds until the panel stands or a refusal lands, so no
		// second init starts the first would then overwrite.
		repositoryInitInFlight.current = displayName;
		// The act's checkout: the plane's own repository resolution rule, the
		// case-insensitive mapping lookup over the identity and the display name,
		// then the ~/src/<name> convention - the same rule the sources resolve
		// through, so a documented owner/name key, a sibling clone, a ~ path, and
		// an unmapped convention all find the checkout the operator already has.
		const checkout = repositoryInitCheckoutPath(cfg.repos, ref.identity, ref.displayName, homeDir);
		if (!(await fileExists(checkout))) {
			setErrorMessage(
				`${ref.displayName} has no local checkout at ${checkout} to work a throwaway worktree in`,
			);
			repositoryInitInFlight.current = null;
			return;
		}
		let ghOptions: CommandOptions = {};
		if (source.auth !== undefined) {
			const resolved = await new GhAuthenticator(
				source.host,
				source.auth,
				commandRunner,
				process.env,
			).resolve();
			// A configured auth that fails to resolve refuses the open: the
			// plan and the confirmed act would then run on the ambient gh
			// identity, which may be the wrong account.
			if (!resolved.ok) {
				setErrorMessage(`the source's auth for ${source.host} did not resolve: ${resolved.reason}`);
				repositoryInitInFlight.current = null;
				return;
			}
			ghOptions = resolved.options;
		}
		const plan = await planRepositoryInit({
			runner: commandRunner,
			checkout,
			identity: ref.identity,
			displayName: ref.displayName,
			taskTypes: cfg.taskTypes,
			ghOptions,
		});
		if ("reason" in plan) {
			setErrorMessage(plan.reason);
			repositoryInitInFlight.current = null;
			return;
		}
		repositoryInitInFlight.current = null;
		setPanel({
			kind: "repository-init",
			identity: ref.identity,
			repository: {
				identity: ref.identity,
				displayName: ref.displayName,
				host: source.host,
				auth: source.auth,
				cloneUrl: ref.cloneUrl,
				checkout,
			},
			plan,
		});
	}
	// The one read the select list stands on (ADR 0082): the operator's own
	// repositories and those of their organizations, on the ambient gh
	// identity, which is the identity the operator logs in to work.
	const fetchInitableRepositories = () => listInitableRepositories(commandRunner, "github.com");
	// The queue the select list's Enter hands over (ADR 0083): one repository
	// per entry, one confirmation panel per entry, in list order. A single
	// entry runs the plain select the panel has always run.
	function startRepositoryInitQueue(queue: readonly InitableRepository[]) {
		if (queue.length === 0) return;
		if (refuseInitInFlight()) return;
		const [head, ...rest] = queue;
		repositoryInitQueue.current =
			rest.length > 0 ? { remaining: rest, ran: 0, skipped: 0, refused: 0 } : null;
		void openRepositorySelectFor(head).catch((error) => setErrorMessage(errorMessage(error)));
	}
	// One entry of the queue settles (ADR 0083): the outcome counts, the next
	// entry's confirmation panel opens in the one under review's place, and
	// the drained queue leaves its settled line on the Message line. A failed
	// act stops the queue: the line above already names the repository and
	// the failure, and the operator takes the rest back by hand when ready.
	function advanceRepositoryInitQueue(outcome: "ran" | "skipped" | "refused" | "failed") {
		const queue = repositoryInitQueue.current;
		if (queue === null) return;
		if (outcome === "failed") {
			repositoryInitQueue.current = null;
			return;
		}
		queue[outcome] += 1;
		if (queue.remaining.length === 0) {
			repositoryInitQueue.current = null;
			// The panel under review closes with the last entry: the settle line
			// stands on the base view's Message line, not behind a panel. A
			// refusal earlier in the queue left its error on that line, and an
			// error outranks a notice: the settle line ends the fact it replaces.
			setPanel(null);
			clearOperationMessage("none");
			setNoticeMessage(
				`the init queue settled: ${queue.ran} ran, ${queue.skipped} skipped, ${queue.refused} refused`,
			);
			return;
		}
		const [head, ...rest] = queue.remaining;
		queue.remaining = rest;
		void openRepositorySelectFor(head).catch((error) => setErrorMessage(errorMessage(error)));
	}
	// The cancel of a queued entry (ADR 0083): the entry leaves the queue
	// untouched, and the next stands in its place. With no queue behind it,
	// cancel is the way out with nothing changed. The panel under review
	// closes now, not when the next entry's panel opens: the plan runs async
	// behind it, and a panel the operator can still key into is a stale act
	// waiting to run twice.
	function skipRepositoryInitEntry() {
		setPanel(null);
		if (repositoryInitQueue.current !== null) advanceRepositoryInitQueue("skipped");
	}
	// The chosen repository from the select list: the checkout resolves by the
	// plane's own rule, the plan runs the way the Group header's `i` runs it,
	// and the confirmation panel opens. A repository without a local checkout
	// gets the refusal that names the path it needs (ADR 0082). A refusal in
	// a queue skips the entry and moves on (ADR 0083).
	async function openRepositorySelectFor(choice: InitableRepository) {
		if (state === undefined) {
			setErrorMessage("the repository init needs SQLite state");
			advanceRepositoryInitQueue("failed");
			return;
		}
		// The plan runs async with the base view's keyboard live (ADR 0083):
		// the marker holds until the panel stands or a refusal lands, so no
		// second init starts the first would then overwrite.
		repositoryInitInFlight.current = choice.displayName;
		const cfg = configRef.current;
		const checkout = repositoryInitCheckoutPath(
			cfg.repos,
			choice.identity,
			choice.displayName,
			homeDir,
		);
		if (!(await fileExists(checkout))) {
			setErrorMessage(
				`${choice.displayName} has no local checkout at ${checkout} to work a throwaway worktree in`,
			);
			repositoryInitInFlight.current = null;
			advanceRepositoryInitQueue("refused");
			return;
		}
		const plan = await planRepositoryInit({
			runner: commandRunner,
			checkout,
			identity: choice.identity,
			displayName: choice.displayName,
			taskTypes: cfg.taskTypes,
		});
		if ("reason" in plan) {
			setErrorMessage(plan.reason);
			repositoryInitInFlight.current = null;
			advanceRepositoryInitQueue("refused");
			return;
		}
		repositoryInitInFlight.current = null;
		setPanel({
			kind: "repository-init",
			identity: choice.identity,
			repository: {
				identity: choice.identity,
				displayName: choice.displayName,
				host: "github.com",
				cloneUrl: choice.htmlUrl,
				checkout,
			},
			plan,
		});
	}
	// The confirmed init: runs the act, registers the sources, and writes the
	// init fact, then adds the sources to the config and reports the result on
	// the Message line. A refusal stands with its reason and changes nothing.
	async function runRepositoryInitConfirm(
		repository: RepositoryInitRepository,
		plan: RepositoryInitPlan,
		instructionFile?: InstructionFileName,
	) {
		const factoryState = state;
		if (factoryState === undefined) {
			setErrorMessage("the repository init needs SQLite state");
			advanceRepositoryInitQueue("failed");
			return;
		}
		// The act's progress on the Message line (ADR 0075, story 27): a word
		// stands while the commands run, so the operator sees the act in flight
		// without opening anything.
		setWorkingMessage(`initializing ${repository.displayName}...`, "repository-init");
		const flow = await commitRepositoryInit({
			runner: commandRunner,
			state: factoryState,
			config: configRef.current,
			repository,
			workflowStates: configRef.current.workflowStates,
			taskTypes: configRef.current.taskTypes,
			plan: {
				instructionFile: instructionFile ?? plan.instructionFile,
				labelsToCreate: plan.labelsToCreate,
				fileActions: plan.files.map((file) => ({ path: file.path, action: file.action })),
			},
		}).catch((error) => ({ ok: false as const, reason: errorMessage(error) }));
		clearWorkingMessage("repository-init");
		if (flow.ok === false) {
			setErrorMessage(flow.reason);
			advanceRepositoryInitQueue("failed");
			return;
		}
		// The sources the flow registered join the config: the operator's pane
		// shows them the moment the write-back lands, the way a repository
		// mapping does.
		let writeLine = "";
		let writeFact: ConfigWriteFact | undefined;
		const write = configWriteQueue.current
			.catch(() => undefined)
			.then(async () => {
				try {
					const currentConfig = configRef.current;
					const updated = {
						...currentConfig,
						sources: [...currentConfig.sources, ...flow.newSources],
					};
					configRef.current = updated;
					setConfig(updated);
					// The write-back appends the `[[sources]]` blocks the init
					// registered and leaves the rest of the operator's file, their
					// comments included, where they wrote it (ADR 0103).
					const fact = await writeConfigFile(configFile, updated);
					writeFact = fact;
					// A re-init whose planned sources already stand in the config registers
					// nothing new, so it hands the write-back no count to word. Only a full
					// rewrite of the operator's file has something to say then, and it says
					// it without a count (ADR 0103).
					writeLine = configWriteLine(
						fact,
						flow.newSources.length === 0
							? ""
							: `registered ${flow.newSources.length} new source${
									flow.newSources.length === 1 ? "" : "s"
								}`,
					);
				} catch (error) {
					setErrorMessage(`the init's sources did not save: ${errorMessage(error)}`);
				}
			});
		configWriteQueue.current = write.then(
			() => undefined,
			() => undefined,
		);
		await write;
		// The Message line is one row of the terminal's width and the act's own
		// confirmation is longer than that, so a full rewrite leads the line: the
		// warning that the file's comments did not survive is what reads (ADR 0103).
		setNoticeMessage(
			writeFact === undefined
				? flow.message
				: writeFactWithConfirmation(writeFact, writeLine, flow.message),
		);
		// A queue behind the act closes its panel now, the way the skip does:
		// the next entry plans async, and the panel under review must not
		// stand live behind it. A lone init keeps its panel, the way it
		// always did.
		if (repositoryInitQueue.current !== null) setPanel(null);
		advanceRepositoryInitQueue("ran");
	}
	function selectWorkQueue(index: number) {
		const next = clamp(index, 0, Math.max(0, workQueueRef.current.length - 1));
		if (next === workQueueIndexRef.current) return;
		workQueueIndexRef.current = next;
		setWorkQueueIndex(next);
		workQueueDetailScrollRef.current = 0;
		setWorkQueueDetailScroll(0);
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
	/**
	 * `x` toggles the section under the cursor (user story 8). Collapsing keeps
	 * the selection with the section: the detail keeps showing it, and the
	 * cursor rests on the section's boundary in the visible flow, so one step
	 * into the other section crosses to it, and the same key or a header click
	 * expands the section back on its retained row (user stories 19 and 20).
	 */
	/**
	 * Flip one section's expanded pair - the ref and the state - and return
	 * the flag after the flip. The cursor's `x` and a header click both
	 * toggle through it, so one flip keeps one shape.
	 */
	function flipSectionExpanded(section: MainSection): boolean {
		if (section === "tickets") {
			ticketsExpandedRef.current = !ticketsExpandedRef.current;
			setTicketsExpanded(ticketsExpandedRef.current);
			return ticketsExpandedRef.current;
		}
		if (section === "work") {
			workExpandedRef.current = !workExpandedRef.current;
			setWorkExpanded(workExpandedRef.current);
			return workExpandedRef.current;
		}
		consultationsExpandedRef.current = !consultationsExpandedRef.current;
		setConsultationsExpanded(consultationsExpandedRef.current);
		return consultationsExpandedRef.current;
	}
	function toggleSection() {
		flipSectionExpanded(
			selectionRef.current === "ticket"
				? "tickets"
				: selectionRef.current === "consultation"
					? "consultations"
					: "work",
		);
	}
	/**
	 * Move the unified cursor by one row. The cursor walks the visible flow,
	 * which is the concatenation of the expanded sections' rows in section
	 * order: down from the last visible Ticket crosses to the first visible
	 * Consultation, and up from the first visible Consultation crosses back to
	 * the last visible Ticket. A collapsed section contributes no rows; when
	 * it holds the cursor the flow starts or ends at its boundary, so a step
	 * that would leave the visible rows does nothing (user story 21).
	 */
	function moveVertical(delta: number) {
		if (selectionRef.current === "queue") {
			if (focusedPaneRef.current === "detail") {
				setWorkQueueDetailScroll((current) => clamp(current + delta, 0, workQueueDetailMaxScroll));
				return;
			}
			if (workExpandedRef.current) {
				if (delta < 0 && workQueueIndexRef.current === 0) {
					// The cross reaches even an empty Consultation list: its
					// empty message is the row the cursor takes, and it crosses
					// into the Ticket list when the Consultation section is
					// collapsed.
					if (consultationsExpandedRef.current) {
						selectionRef.current = "consultation";
						setSelection("consultation");
						selectConsultation(Math.max(0, consultationsRef.current.length - 1));
					} else if (ticketsExpandedRef.current) {
						selectionRef.current = "ticket";
						setSelection("ticket");
						selectTicketRow(Math.max(0, ticketRowsRef.current.length - 1));
					}
					return;
				}
				selectWorkQueue(workQueueIndexRef.current + delta);
				return;
			}
			// The Work section is collapsed: the cursor rests on its boundary,
			// and the only visible step is up to the last Consultation, or to
			// the last Ticket when that section is collapsed as well.
			if (delta < 0) {
				if (consultationsExpandedRef.current) {
					selectionRef.current = "consultation";
					setSelection("consultation");
					selectConsultation(Math.max(0, consultationsRef.current.length - 1));
				} else if (ticketsExpandedRef.current) {
					selectionRef.current = "ticket";
					setSelection("ticket");
					selectTicketRow(Math.max(0, ticketRowsRef.current.length - 1));
				}
			}
			return;
		}
		if (selectionRef.current === "consultation") {
			if (focusedPaneRef.current === "detail") {
				consultationFollowRef.current = false;
				setConsultationScroll((current) => clamp(current + delta, 0, consultationMaxScroll));
				return;
			}
			if (consultationsExpandedRef.current) {
				if (delta < 0 && consultationIndexRef.current === 0) {
					// The cross reaches even an empty Ticket list: its empty
					// message is the row the cursor takes.
					if (ticketsExpandedRef.current) {
						selectionRef.current = "ticket";
						setSelection("ticket");
						selectTicketRow(Math.max(0, ticketRowsRef.current.length - 1));
					}
					return;
				}
				if (
					delta > 0 &&
					consultationIndexRef.current >= consultationsRef.current.length - 1 &&
					workExpandedRef.current
				) {
					// The Work queue is the last section of the visible flow,
					// so down from the last Consultation crosses into it (ADR 0034).
					selectionRef.current = "queue";
					setSelection("queue");
					selectWorkQueue(0);
					return;
				}
				selectConsultation(consultationIndexRef.current + delta);
				return;
			}
			// The Consultation section is collapsed: the cursor rests on its
			// boundary, and the only visible step is up to the last Ticket.
			if (delta < 0 && ticketsExpandedRef.current) {
				selectionRef.current = "ticket";
				setSelection("ticket");
				selectTicketRow(Math.max(0, ticketRowsRef.current.length - 1));
			}
			return;
		}
		if (focusedPaneRef.current === "detail") {
			detailRef.current?.moveBy(delta * configRef.current.scroll.speed);
			return;
		}
		if (ticketsExpandedRef.current) {
			if (delta > 0 && selectedIndexRef.current >= ticketRowsRef.current.length - 1) {
				// The cross reaches even an empty Consultation list: its empty
				// message is the row the cursor takes, and the history filter
				// still operates from there. It crosses into the Work queue when
				// the Consultation section is collapsed (ADR 0034).
				if (consultationsExpandedRef.current) {
					selectionRef.current = "consultation";
					setSelection("consultation");
					selectConsultation(0);
				} else if (workExpandedRef.current) {
					selectionRef.current = "queue";
					setSelection("queue");
					selectWorkQueue(0);
				}
				return;
			}
			moveList(delta);
			return;
		}
		// The Ticket section is collapsed: the cursor rests on its boundary, and
		// the only visible step is down to the first Consultation.
		if (delta > 0 && consultationsExpandedRef.current) {
			selectionRef.current = "consultation";
			setSelection("consultation");
			selectConsultation(0);
		}
	}
	function movePage(direction: 1 | -1) {
		if (selectionRef.current === "queue") {
			if (focusedPaneRef.current === "detail")
				setWorkQueueDetailScroll((current) =>
					clamp(
						current + direction * Math.max(1, detailGeometry.visibleRows - 2),
						0,
						workQueueDetailMaxScroll,
					),
				);
			else selectWorkQueue(workQueueIndexRef.current + direction * workContentRows);
			return;
		}
		if (selectionRef.current === "consultation") {
			if (focusedPaneRef.current === "detail") moveConsultationDetailPage(direction);
			else selectConsultation(consultationIndexRef.current + direction * consultationsContentRows);
			return;
		}
		if (focusedPaneRef.current === "detail")
			detailRef.current?.movePage(direction === 1 ? "down" : "up");
		else moveList(direction * ticketsContentRows);
	}
	function moveEdge(edge: "start" | "end") {
		if (selectionRef.current === "queue") {
			if (focusedPaneRef.current === "detail")
				setWorkQueueDetailScroll(edge === "start" ? 0 : workQueueDetailMaxScroll);
			else if (workExpandedRef.current)
				selectWorkQueue(edge === "start" ? 0 : workQueueRef.current.length - 1);
			return;
		}
		if (selectionRef.current === "consultation") {
			if (focusedPaneRef.current === "detail") {
				consultationFollowRef.current = edge === "end";
				setConsultationScroll(edge === "start" ? 0 : 999999);
				if (edge === "end") setNewOutput(false);
			} else if (consultationsExpandedRef.current)
				selectConsultation(edge === "start" ? 0 : consultationsRef.current.length - 1);
			return;
		}
		if (focusedPaneRef.current === "detail") {
			if (edge === "start") detailRef.current?.toStart();
			else detailRef.current?.toEnd();
		} else if (ticketsExpandedRef.current)
			selectTicketRow(edge === "start" ? 0 : ticketRowsRef.current.length - 1);
	}
	// The ticket panels are the closed set: the decision on a settled turn, the
	// live view over an in-flight agent, the missing-agent choice, and the Close
	// confirmation. Everything that reads an open panel goes through this list,
	// so a new consultation kind can never be taken for a ticket panel by
	// falling through the exclusions.
	const ticketPanel =
		panel !== null &&
		(panel.kind === "decision" ||
			panel.kind === "live" ||
			panel.kind === "missing" ||
			panel.kind === "ticket-close")
			? panel
			: null;
	const panelTicket =
		ticketPanel === null
			? undefined
			: // The projection before the list rule (ADR 0060): an open panel follows its
				// Ticket across a refresh or a lift, and never tears itself down because the
				// row left the view the operator happens to be in.
				findTicket(ticketPanel.identity);
	// The one identity read for the open panel: the narrowing is the
	// structure, not a list, so a panel kind that names no identity needs no
	// guard here, and a kind that names one never reaches a missing field.
	const panelIdentity = panel !== null && "identity" in panel ? panel.identity : undefined;
	const panelConsultation =
		panelIdentity !== undefined && ticketPanel === null
			? consultationsRef.current.find((item) => item.id === panelIdentity)
			: undefined;
	// The open close panel's own copy, re-derived from the record on every
	// render: the record's state picks the shape, so the panel follows the
	// record without the operator asking.
	const closePanel =
		panel !== null && panel.kind === "consultation-close" && panelConsultation !== undefined
			? consultationClosePanel(panelConsultation)
			: undefined;
	// The open recovery panel's own copy, derived the same way: the record's
	// state names its rows, so the panel follows the record.
	const recoveryPanel =
		panel !== null && panel.kind === "consultation-recovery" && panelConsultation !== undefined
			? consultationRecoveryPanel(panelConsultation)
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
				? // The route confirm ends the ticket's cycle on its own surface and
					// the screen reads the list when the ticket leaves the stream's
					// states (ADR 0072).
					"closed"
				: panelTicket.state === "awaiting"
					? // Auto-handoff mode decides the settled turn on its own, so
						// the ticket keeps streaming; manual mode waits for the
						// operator's hand (ADR 0092).
						autoMode
						? "stream"
						: "decision"
					: factsFor(panelTicket).failure === "missing"
						? "missing"
						: "stream"
			: "closed";
	const liveDecision =
		panelTicket !== undefined && liveMode === "decision" ? decisionFor(panelTicket) : undefined;
	/**
	 * Whether the open panel has nothing left to show.
	 *
	 * Each panel kind says which fact it is drawn from, and that fact is what
	 * can run out from under the modal: the decision the observation takes,
	 * the agent whose pane is gone, the ticket that leaves the projection, and
	 * the Consultation whose state moves while its close confirmation is open
	 * (a background refresh that finds the Agent gone makes the record
	 * `missing`, and neither close branch draws an `missing` record). A panel
	 * that is not drawn must not keep holding the keys the panels swallow.
	 */
	const closePanelHasNothingToShow =
		panel?.kind === "consultation-close" &&
		(panelConsultation === undefined || closePanel === undefined);
	// The recovery panel reads the same fact: a record that reaches a live
	// state, or a closed one, has no recovery row left to draw.
	const recoveryPanelHasNothingToShow =
		panel?.kind === "consultation-recovery" &&
		(panelConsultation === undefined || recoveryPanel === undefined);
	const panelHasNothingToShow =
		(ticketPanel !== null &&
			(panelTicket === undefined ||
				(ticketPanel.kind === "decision" && decision === undefined) ||
				(ticketPanel.kind === "live" && liveMode === "closed") ||
				// The Close confirmation is drawn from work in flight: a cycle that
				// ended from under the dialog leaves the panel with nothing to show.
				(ticketPanel.kind === "ticket-close" && panelTicket.state === "open"))) ||
		closePanelHasNothingToShow ||
		recoveryPanelHasNothingToShow;
	// The reason the guard stands on the Message line when it drops an open
	// Consultation panel: the record moved out of the states the panel draws,
	// or it left the list while the panel was up. The panel keeps its own name
	// in the sentence, so the line says which screen let go.
	const consultationPanelName = panel?.kind === "consultation-recovery" ? "recovery" : "close";
	const consultationPanelReleaseNote =
		closePanelHasNothingToShow === true || recoveryPanelHasNothingToShow === true
			? panelConsultation === undefined
				? `the Consultation left the list; the ${consultationPanelName} panel closed`
				: `the Consultation moved to ${panelConsultation.state}; the ${consultationPanelName} panel closed`
			: null;
	useEffect(() => {
		if (consultationPanelReleaseNote !== null)
			// The note is the outcome of the operation the operator opened, so it
			// stands as news, not as a warning the plane wrote on its own.
			reportMessage({ severity: "info", text: consultationPanelReleaseNote });
		if (panelHasNothingToShow) setPanel(null);
	}, [panelHasNothingToShow, consultationPanelReleaseNote, reportMessage]);

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
			// tick. The one identity read reaches the Ticket whether or not the
			// list draws its row, so the stream never loses its pane to a filter
			// cycle or a withheld row (ADR 0042, ADR 0060).
			const ticket = findTicket(identity);
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
	}, [panel, liveMode, commandRunner, findTicket]);
	// An empty grouped list names the axis in its message, so "no tickets" says
	// which view the operator is reading (issue #159, user story 9).
	const emptyMessage =
		state === undefined
			? undefined
			: groupingEmptyMessage(
					config.sources.length === 0
						? "no ticket sources configured"
						: healths.length === 0 || healths.some((health) => health.health === "loading")
							? "loading tickets..."
							: // A hidden pile is not an idle factory (ADR 0060, widened by ADR 0070):
								// the empty active view points at the key that shows the rows the
								// flags took away, and a filtered view with no rows names the view the
								// operator is in. Each number is its ledger itself, the same one its
								// header cell names: where the active view stands empty, every flagged
								// row is out of it, because a row with live work or a decision owed
								// stays in.
								(ignoredCount > 0 || mutedCount > 0) && ticketFilter === "active"
								? `no active Tickets; ${[
										...(ignoredCount > 0 ? [`${ignoredCount} ignored`] : []),
										...(mutedCount > 0 ? [`${mutedCount} muted`] : []),
									].join(", ")} - press f`
								: ticketFilter === "ignored"
									? "no ignored Tickets - press f"
									: ticketFilter === "muted"
										? "no muted Tickets - press f"
										: "no tickets match the configured sources",
					groupingAxis,
				);
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
						input: state.consultationRecord.replacementInput(replacementConsultation.id),
					}
				: // A fresh launcher starts on the Repository the operator was looking at.
					{
						typeName: Object.keys(config.consultationTypes)[0] ?? "",
						repositoryIdentity: selectedTicket?.repositoryRef.identity ?? "",
						input: "",
					};
	const actionMode = currentBaseMode();
	const mainBarFacts = mainFacts();
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
			? [{ text: TOO_SMALL_TEXT, fg: paint("yellow") }]
			: [
					{ text: TOO_SMALL_TEXT, fg: paint("yellow") },
					{ text: importantSmallMessage, fg: messageColor },
				]
	).slice(0, compactLineCount);
	const utilityFacts =
		utility?.kind === "guide" || utility?.kind === "message"
			? mainFactsFor(utility.mode)
			: mainBarFacts;
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
		// One Main frame: the body and the two permanent bottom rows. The body's
		// left column stacks the two sections - each header row, and its list box
		// while the section is expanded - and its right column holds the one
		// detail pane for the selected item (ADR 0019).
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
							height: Math.max(0, bodyRows),
							flexGrow: 0,
							flexShrink: 1,
							flexDirection: "column",
							overflow: "hidden",
						},
					},
					// The Ticket header owns the body's first row at the full
					// terminal width, so its counts and its mode cell stay whole
					// where the columns below split (ADR 0019).
					createElement(SectionHeader, {
						section: "tickets",
						expanded: ticketsExpanded,
						terminalWidth,
						width: terminalWidth,
						open: openCount,
						running: runningCount,
						awaiting: awaitingCount,
						held: heldCount,
						ignored: ignoredCount,
						muted: mutedCount,
						heldBell,
						mode: autoHandoffCell,
						active: mainSurfaceActive,
						onToggle: () => clickSection("tickets"),
					}),
					createElement(
						"box",
						{
							style: {
								width: "100%",
								height: Math.max(0, bodyRows - 1),
								flexGrow: 0,
								flexShrink: 1,
								flexDirection: "row",
								overflow: "hidden",
							},
						},
						createElement(
							"box",
							{
								style: {
									// An exact cell count from the shared geometry, not "50%":
									// OpenTUI rounds a percentage up on odd terminal widths, and
									// the rounded box would no longer match the geometry the rows
									// and the detail pane lay their text on.
									width: leftCols,
									height: "100%",
									flexGrow: 0,
									flexShrink: 0,
									flexDirection: "column",
									overflow: "hidden",
								},
							},
							ticketsExpanded &&
								createElement(TicketList, {
									rows: ticketRowsState,
									selectedIndex,
									focused: focusedPane === "list" && selection === "ticket",
									height: ticketsBoxRows,
									emptyMessage,
									active: mainSurfaceActive,
									onFocus: () => focusListSection("ticket"),
									onSelect: (index: number) => {
										focusListSection("ticket");
										// A left click on a Group header folds the Group
										// it names, the way a click on a section header
										// folds the section (issue #159, user story 33).
										const row = ticketRowsRef.current[index];
										if (row !== undefined && row.kind === "group") {
											toggleGroupFold(row.group.value);
											return;
										}
										selectTicketRow(index);
									},
									onMove: (delta) => {
										// The first wheel spin into a section both moves the cursor
										// there and selects one adjacent row.
										focusListSection("ticket");
										moveList(delta);
									},
								}),
							createElement(SectionHeader, {
								section: "consultations",
								expanded: consultationsExpanded,
								terminalWidth,
								width: leftCols,
								awaitingResponse: headerFacts.consultation.awaitingResponse,
								recovery: headerFacts.consultation.recovery,
								bell,
								newOutput,
								active: mainSurfaceActive,
								onToggle: () => clickSection("consultations"),
							}),
							consultationsExpanded &&
								createElement(ConsultationList, {
									consultations,
									selectedIndex: consultationIndex,
									focused: focusedPane === "list" && selection === "consultation",
									rows: consultationsBoxRows,
									active: mainSurfaceActive,
									onFocus: () => focusListSection("consultation"),
									onSelect: (index: number) => {
										focusListSection("consultation");
										selectConsultation(index);
									},
									onMove: (delta) => {
										// The first wheel spin into a section both moves the cursor
										// there and selects one adjacent row.
										focusListSection("consultation");
										selectConsultation(consultationIndexRef.current + delta);
									},
									emptyMessage:
										state === undefined
											? "Consultations require SQLite state"
											: historyFilter === "closed"
												? "no closed Consultations"
												: historyFilter === "all"
													? "no Consultations"
													: "no open Consultations",
								}),
							createElement(SectionHeader, {
								section: "work",
								expanded: workExpanded,
								terminalWidth,
								width: leftCols,
								waiting: headerFacts.work.waiting,
								queuePaused,
								active: mainSurfaceActive,
								onToggle: () => clickSection("work"),
							}),
							workExpanded &&
								createElement(WorkQueueList, {
									rows: workQueueRows,
									selectedIndex: workQueueIndex,
									focused: focusedPane === "list" && selection === "queue",
									height: workBoxRows,
									active: mainSurfaceActive,
									onFocus: () => focusListSection("queue"),
									onSelect: (index: number) => {
										focusListSection("queue");
										selectWorkQueue(index);
									},
									onMove: (delta: number) => {
										focusListSection("queue");
										selectWorkQueue(workQueueIndexRef.current + delta);
									},
									emptyMessage: "no waiting starts",
								}),
						),
						selection === "queue"
							? createElement(
									"box",
									{ style: { flexGrow: 1, flexDirection: "column" } },
									createElement(ConsultationDetail, {
										lines: queueDetailLines,
										visibleRows: Math.max(1, detailGeometry.visibleRows),
										scroll: workQueueDetailClampedScroll,
										focused: focusedPane === "detail" && selection === "queue",
										active: mainSurfaceActive,
										onFocus: () => focusPane("detail"),
										onWheel: (delta) => moveVertical(delta),
									}),
								)
							: selection === "ticket"
								? createElement(TicketDetail, {
										ref: detailRef,
										fact: selectedTicket === undefined ? undefined : factsFor(selectedTicket),
										focused: focusedPane === "detail",
										active: mainSurfaceActive,
										reservedRows: detailReservedRows,
										handoffLimit: config.maxHandoffsPerTicket,
										suggestedChoice:
											selectedTicket?.state === "open" ? choiceFor(selectedTicket) : undefined,
										scroll: config.scroll,
										onFocus: () => focusPane("detail"),
										scrollSlot: detailScrollSlot,
										mergeAttempt:
											selectedTicket === undefined || state === undefined
												? null
												: state.planeAction.latestPlaneActionAttempt(selectedTicket.identity),
									})
								: createElement(
										"box",
										{ style: { flexGrow: 1, flexDirection: "column" } },
										createElement(ConsultationDetail, {
											lines: consultationLines,
											ansiLines,
											bodyTitle: consultationDetailTitle(consultationBody),
											visibleRows: Math.max(
												1,
												detailGeometry.visibleRows - (responseEditor ? RESPONSE_EDITOR_ROWS : 0),
											),
											scroll: consultationDetailScroll,
											focused: focusedPane === "detail" && !responseEditor,
											active: mainSurfaceActive,
											onFocus: () => focusPane("detail"),
											onWheel: (delta) => moveVertical(delta),
										}),
										responseEditor &&
											createElement(ResponseEditor, {
												draft: responseDraft,
												width: consultationWidth,
												rows: RESPONSE_EDITOR_ROWS,
												focused: true,
												standing,
												inputActive: utility === null,
												onSend: sendResponseText,
												onDiscard: discardResponseDraft,
												onDraftChange: storeResponseDraft,
												onClose: closeResponseEditor,
												onHelp: () => openGuide("form-field"),
												onMessage: () => openMessage("form-field"),
												onUnavailable: (reason: string) =>
													setStatus({ kind: "warning", text: reason }),
												onCopy: reportMessage,
												message: visibleMessage,
												onEmergencyExit: () => renderer.destroy(),
											}),
									),
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
					submitConsultation(typeName, repository, text);
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
				standing,
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
			facts: mainBarFacts,
			width: terminalWidth,
			compactAnchor: tooSmall,
		}),
		override !== null &&
			createElement(OverridePanel, {
				agents: config.agents,
				environments: HANDOFF_ENVIRONMENT_KINDS,
				taskTypes: Object.keys(config.taskTypes),
				profiles,
				taskPlacements: taskPlacementsFor(override),
				planeActionTaskTypes: Object.keys(config.taskTypes).filter((name) =>
					isPlaneActionTaskType(config.taskTypes, name),
				),
				onCopy: reportMessage,
				modelList,
				onAgentChange: requestModelList,
				initial: override.choice,
				standing,
				inputActive: utility === null,
				onHelp: (mode) => openGuide(mode),
				onMessage: (mode) => openMessage(mode),
				onUnavailable: setWarningMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
				onConfirm: confirmOverride,
				onCancel: cancelOverride,
			}),
		// Each ticket panel kind renders its own modal: a decision is neither a
		// live view nor a missing-agent choice, and must not fall through to one.
		panel !== null &&
			panelTicket !== undefined &&
			panel.kind === "decision" &&
			decision !== undefined &&
			createElement(DecisionModal, {
				title: panelTicket.title,
				contextLine: decision.contextLine,
				entries: decision.entries,
				actions: decision.actions,
				factLines: decision.factLines,
				cause: decision.cause,
				detail: decision.detail,
				onAction: (key) => runDecisionAction(panelTicket, key),
				onEditAction: (key) => openRouteOverride(panelTicket, key),
				onCancel: () => setPanel(null),
				standing,
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
		// log in the pane, the decision's rows in the region, and their keys,
		// the border re-titled by the shared chrome.
		panel !== null &&
			panel.kind === "live" &&
			panelTicket !== undefined &&
			liveMode !== "closed" &&
			liveMode !== "missing" &&
			createElement(LiveView, {
				title: panelTicket.title,
				contextLine: liveContextLine(panelTicket, configRef.current.defaultTaskType),
				blocked: factsFor(panelTicket).failure === "blocked",
				body:
					liveDecision !== undefined
						? { kind: "turn-log" as const, entries: liveDecision.entries }
						: liveStream === null
							? { kind: "stream" as const, lines: [], note: null }
							: { kind: "stream" as const, lines: liveStream.lines, note: liveStream.note },
				cause: liveDecision?.cause ?? null,
				detail: liveDecision?.detail ?? "",
				actions: liveDecision?.actions ?? [],
				onAction: (key) => runDecisionAction(panelTicket, key),
				onEditAction: (key) => openRouteOverride(panelTicket, key),
				// The streaming sub-mode's Goto: the decision's own Goto row's
				// behavior, so the two paths cannot drift.
				onGoto: () => runDecisionAction(panelTicket, "goto"),
				onCancel: () => setPanel(null),
				// The view's own Ticket is the Goto's pane fact, whatever the
				// list below points at.
				standing,
				ticket: panelTicket,
				paneAlive:
					panelTicket.handoff?.paneId !== null &&
					agents?.some((agent) => agent.paneId === panelTicket.handoff?.paneId) === true,
				paneForeign:
					panelTicket.handoff?.paneId !== null &&
					agents?.some(
						(agent) =>
							agent.paneId === panelTicket.handoff?.paneId &&
							ticketAgentIdentity(panelTicket, agent) === "foreign",
					) === true,
				inputActive: utility === null,
				onHelp: () => openGuide(liveMode === "decision" ? "decision-modal" : "live-view"),
				onMessage: () => openMessage(liveMode === "decision" ? "decision-modal" : "live-view"),
				onUnavailable: setWarningMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		panel !== null &&
			panelTicket !== undefined &&
			(panel.kind === "missing" || liveMode === "missing") &&
			createElement(MissingModal, {
				title: truncateToWidth(`Missing: ${panelTicket.title}`, 40),
				bodyLines: [
					"The agent's pane is not in herdr's agent list.",
					`Handoff attempts: ${panelTicket.handoffCount} of ${config.maxHandoffsPerTicket}`,
				],
				actions: [
					{ key: "restart", label: "Restart", detail: "same task type, same workspace" },
					{ key: "abandon", label: "Abandon", detail: "end the work cycle" },
				],
				onAction: (key) => runMissingAction(panelTicket, key),
				onCancel: () => setPanel(null),
				standing,
				inputActive: utility === null,
				onHelp: () => openGuide("missing-modal"),
				onMessage: () => openMessage("missing-modal"),
				onUnavailable: setWarningMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		panel !== null &&
			panel.kind === "repository-init" &&
			createElement(ActionPanel, {
				message: visibleMessage,
				...repositoryInitPanel(panel.plan),
				onAction: (key) => {
					setPanel(null);
					if (key === "init")
						void runRepositoryInitConfirm(panel.repository, panel.plan).catch((error) =>
							setErrorMessage(errorMessage(error)),
						);
					// The repository owes the choice of which instruction file to create
					// (ADR 0075, story 12): the pick is the file the act stands the block in.
					else if (key === "init-claude")
						void runRepositoryInitConfirm(panel.repository, panel.plan, "CLAUDE.md").catch(
							(error) => setErrorMessage(errorMessage(error)),
						);
					else if (key === "init-agents")
						void runRepositoryInitConfirm(panel.repository, panel.plan, "AGENTS.md").catch(
							(error) => setErrorMessage(errorMessage(error)),
						);
					// The cancel of a queued entry skips it and moves on (ADR 0083).
					else skipRepositoryInitEntry();
				},
				onCancel: () => skipRepositoryInitEntry(),
				standing,
				inputActive: utility === null,
				onHelp: () => openGuide("action-panel"),
				onMessage: () => openMessage("action-panel"),
				onUnavailable: setWarningMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		panel !== null &&
			panel.kind === "repository-select" &&
			createElement(RepositorySelectPanel, {
				fetchRepositories: fetchInitableRepositories,
				onSelect: (queue) => {
					setPanel(null);
					startRepositoryInitQueue(queue);
				},
				onCancel: () => setPanel(null),
				standing,
				inputActive: utility === null,
				onHelp: () => openGuide("repository-select"),
				onMessage: () => openMessage("repository-select"),
				onUnavailable: setWarningMessage,
				message: visibleMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		panel !== null &&
			panel.kind === "ticket-close" &&
			panelTicket !== undefined &&
			createElement(ActionPanel, {
				message: visibleMessage,
				...ticketCloseDialog(panelTicket, factsFor(panelTicket).failure),
				onAction: (key) => {
					setPanel(null);
					if (key === "close") runTicketClose(panelTicket);
				},
				// Cancel is the way out with nothing changed: the Ticket, its cycle,
				// and its Agent stay exactly where the dialog found them.
				onCancel: () => setPanel(null),
				standing,
				inputActive: utility === null,
				onHelp: () => openGuide("action-panel"),
				onMessage: () => openMessage("action-panel"),
				onUnavailable: setWarningMessage,
				onEmergencyExit: () => renderer.destroy(),
			}),
		panel !== null &&
			panel.kind === "consultation-safety" &&
			panelConsultation !== undefined &&
			consultationSafety?.consultationId === panelConsultation.id &&
			createElement(ActionPanel, {
				message: visibleMessage,
				standing,
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
						const current = state?.consultationRecord.consultation(panelConsultation.id);
						if (current !== undefined && consultationSafety !== null)
							void consultationOperations?.confirmSafetyConflict(
								current,
								consultationSafety.safety.conflicts,
							);
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
		// One panel element for the Consultation recovery: the record's state
		// names its rows through consultationRecoveryPanel, the retry of an
		// interrupted opening and the replacement of a record with no Agent.
		// A `closing` record never reaches this element: its Enter opens the
		// close panel below, which already carries its recovery rows.
		panel !== null &&
			panel.kind === "consultation-recovery" &&
			panelConsultation !== undefined &&
			recoveryPanel !== undefined &&
			createElement(ActionPanel, {
				message: visibleMessage,
				standing,
				title: recoveryPanel.title,
				bodyLines: recoveryPanel.bodyLines,
				actions: recoveryPanel.actions,
				onAction: (key) => {
					if (key === "recover") {
						setPanel(null);
						recoverConsultationOpening(panelConsultation);
					} else if (key === "replace") {
						openReplacementLauncher(panelConsultation);
					} else if (key === "close") {
						// The close path owns the dialog: an interrupted opening
						// still holds a live Agent and confirms, and a record with
						// no Agent closes on this action alone.
						setPanel(null);
						runConsultationClose(panelConsultation);
					}
				},
				onCancel: () => setPanel(null),
			}),
		// One panel element for the Consultation close: the record's state
		// selects the shape through consultationClosePanel, the recovery rows
		// while the record is closing and the confirmation rows while a close
		// would stop a live Agent. A state with no shape never reaches the
		// render: the guard above already dropped the panel.
		panel !== null &&
			panelConsultation !== undefined &&
			panel.kind === "consultation-close" &&
			closePanel !== undefined &&
			createElement(ActionPanel, {
				message: visibleMessage,
				standing,
				title: closePanel.title,
				bodyLines: closePanel.bodyLines,
				actions: closePanel.actions,
				onAction: (key) => {
					if (key === "retry") {
						setPanel(null);
						closeConsultation(panelConsultation);
					} else if (key === "force") {
						setPanel({ kind: "consultation-force", identity: panelConsultation.id });
					} else if (key === "close") {
						setPanel(null);
						closeConsultation(panelConsultation);
					}
				},
				onCancel: () => setPanel(null),
			}),
		panel !== null &&
			panel.kind === "consultation-force" &&
			panelConsultation !== undefined &&
			state !== undefined &&
			createElement(ActionPanel, {
				message: visibleMessage,
				standing,
				title: `Force-close Consultation ${panelConsultation.id.slice(0, 8)}?`,
				bodyLines: [
					"Force-close stops the cleanup and closes the record. These owned",
					"resources remain in herdr and stay recorded for later recovery:",
					...state.consultationRecord
						.consultationResources(panelConsultation.id)
						.filter((item) => item.owned && !item.confirmedClosed)
						.map((item) => `${item.kind} ${item.resourceId} - ${item.details}`),
					...(state.consultationRecord
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
				standing,
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
				facts: utilityFacts,
				onClose: () => setUtility(null),
				onMessage: () => openMessage(utilityFacts.mode),
				onEmergencyExit: () => renderer.destroy(),
			}),
		utility?.kind === "message" &&
			createElement(MessageView, {
				message: visibleMessage,
				fact: utility.fact,
				facts: utilityFacts,
				onClose: () => setUtility(null),
				onHelp: () => openGuide(utilityFacts.mode),
				onEmergencyExit: () => renderer.destroy(),
			}),
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
