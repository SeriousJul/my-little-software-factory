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
import type { KeyEvent, Selection } from "@opentui/core";
import { createElement, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AttentionService } from "../attention.ts";
import {
	defaultConfigPath,
	type FactoryConfig,
	type GitHubAuthentication,
	type TransitionOutcome,
} from "../config.ts";
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
	type AgentStatus,
	agentPoll,
	normalizeAgentStatus,
	ticketAgentIdentity,
} from "../domain/agent.ts";
import { type DecisionFacts, decisionFacts } from "../domain/decision-facts.ts";
import type { GroupingAxis, SplitGroupingAxis } from "../domain/grouping.ts";
import { DEFAULT_GROUPING_AXIS, nextGroupingAxis } from "../domain/grouping.ts";
import { recordTicketName } from "../domain/record-name.ts";
import { heldBellRang, sectionFacts } from "../domain/section-facts.ts";
import {
	flagWithholdsRow,
	HANDOFF_ENVIRONMENT_KINDS,
	type Handoff,
	handoffLimitReached,
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
	type StartedAgent,
} from "../handoff.ts";
import {
	createHandoffDispatch,
	type HandoffDispatch,
	type HandoffDispatchAggregates,
	type HandoffDispatchOptions,
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
	type ParallelSeatFacts,
	parallelSeatAccount,
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
	type RepositoryInitFlowResult,
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
import type {
	Consultation,
	ConsultationRecordAggregate,
	ConsultationResource,
	ConsultationSnapshot,
	ConsultationTurn,
} from "../state/consultation-record.ts";
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
import { consultationClosePanel, consultationDeletePanel } from "./consultation-close-panel.ts";
import {
	ConsultationDetail,
	consultationDetailBody,
	consultationDetailLines,
	consultationDetailTitle,
} from "./consultation-detail.ts";
import { ConsultationLauncher, type LauncherDraft } from "./consultation-launcher.ts";
import { ConsultationList } from "./consultation-list.ts";
import { consultationRecoveryPanel } from "./consultation-recovery-panel.ts";
import {
	type ControlHandler,
	createControlDispatch,
	refusalReason,
	refusalText,
} from "./control-dispatch.ts";
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
import {
	consultationProgressOwner,
	type ProgressOwner,
	useMessageFacts,
	type WorkingOwner,
} from "./message-facts.ts";
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
import { padToWidth, truncateToWidth } from "./text.ts";
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
	workQueueRowFacts,
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
	/**
	 * The Live view, and the work cycle it opened on. The cycle is part of the
	 * panel because the view is one cycle's screen: when the ticket moves to the
	 * next cycle, the screen the operator was watching has ended, whatever state
	 * the ticket's row answers on the render that follows (ADR 0110).
	 */
	| { kind: "live"; identity: string; workCycle: number }
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
			/**
			 * The ticket panel the route row was on: Esc and a confirmed route return
			 * there. It is stored as the panel itself, not as the fields that panel
			 * happens to have today, so the Live view's work cycle - the fact that
			 * screen is bounded by (ADR 0110) - travels with it and a field the Live
			 * panel grows later is carried here by the compiler.
			 */
			returnTo: RouteReturnPanel;
			choice: HandoffChoice;
	  };

/**
 * The ticket panel a route override returns to: the screen the route row stood
 * on when the edit opened the panel, the Decision modal or the Live view.
 */
type RouteReturnPanel = Extract<Panel, { kind: "decision" | "live" }>;

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
	| { kind: "message"; mode: InteractionMode };

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

/** The Work queue's cursor sync: a queue that drains empties the selection, and the index clamps to the last row. */
function useAppWorkQueueSync(prev: AppSelectionFactsQueueStage) {
	const {
		selection,
		selectionRef,
		setSelection,
		workQueue,
		workQueueIndexRef,
		setWorkQueueIndex,
		workQueueWasNonEmptyRef,
	} = prev;
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
	}, [
		workQueue.length,
		selection,
		selectionRef,
		setSelection,
		workQueueIndexRef,
		setWorkQueueIndex,
		workQueueWasNonEmptyRef,
	]);
	return { ...prev };
}
type AppWorkQueueSyncStage = ReturnType<typeof useAppWorkQueueSync>;

/** The init's refusal and the terminal's copy: a refused init names the running init, and a copied selection drops its highlight. */
function useAppSelectionCopy(prev: AppWorkQueueSyncStage) {
	const { renderer, repositoryInitInFlight, setWarningMessage } = prev;
	const refuseInitInFlight = (): boolean => {
		const inFlight = repositoryInitInFlight.current;
		if (inFlight === null) return false;
		setWarningMessage(`the init for ${inFlight} is running`);
		return true;
	};
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
	return { ...prev, refuseInitInFlight };
}
type AppSelectionCopyStage = ReturnType<typeof useAppSelectionCopy>;

/** The held turns' bell: a new held count rings the shared attention bell and flashes the header's lamp (ADR 0016, ADR 0080). */
function useAppHeldBell(prev: AppSelectionCopyStage) {
	const { attention, heldCount, heldCountRef, setHeldBell } = prev;
	useEffect(() => {
		if (heldBellRang(heldCountRef.current, heldCount)) {
			// The flash stays here; the bell write and its attention-bell gate
			// live in the shared attention service (ADR 0080).
			setHeldBell(true);
			setTimeout(() => setHeldBell(false), 250);
			attention.ring();
		}
		heldCountRef.current = heldCount;
	}, [heldCount, attention, heldCountRef, setHeldBell]);
	return { ...prev };
}
type AppHeldBellStage = ReturnType<typeof useAppHeldBell>;

/** The Ticket list's re-read: one projection read for the rows, the active view, the header counts, and the cursor's anchor (ADR 0050, ADR 0060, issue #159). */
function useAppTicketReplace(props: AppProps, prev: AppHeldBellStage) {
	const { state } = props;
	const ticketReplaceFieldsRef = useRef<AppTicketReplaceFields | null>(null);
	ticketReplaceFieldsRef.current = {
		configRef: prev.configRef,
		factRows: prev.factRows,
		groupFoldsRef: prev.groupFoldsRef,
		groupOrderListRef: prev.groupOrderListRef,
		groupingAxisRef: prev.groupingAxisRef,
		listViewsRef: prev.listViewsRef,
		positionOrderOf: prev.positionOrderOf,
		selectedIndexRef: prev.selectedIndexRef,
		setHealths: prev.setHealths,
		setListViews: prev.setListViews,
		setSelectedIndex: prev.setSelectedIndex,
		setWorkQueue: prev.setWorkQueue,
		ticketFilterRef: prev.ticketFilterRef,
		ticketRowsRef: prev.ticketRowsRef,
		ticketsRef: prev.ticketsRef,
	};
	const replaceTickets = useCallback(() => {
		if (state === undefined) return;
		const fields = ticketReplaceFieldsRef.current;
		if (fields === null) return;
		const read = appTicketProjectionRead(state, fields);
		appTicketProjectionWrite(state, read, fields);
	}, [state]);
	return { ...prev, replaceTickets };
}
type AppTicketReplaceStage = ReturnType<typeof useAppTicketReplace>;

/** The fields the Ticket list's re-read reads and writes. */
type AppTicketReplaceFields = Pick<
	AppHeldBellStage,
	| "configRef"
	| "factRows"
	| "groupFoldsRef"
	| "groupOrderListRef"
	| "groupingAxisRef"
	| "listViewsRef"
	| "positionOrderOf"
	| "selectedIndexRef"
	| "setHealths"
	| "setListViews"
	| "setSelectedIndex"
	| "setWorkQueue"
	| "ticketFilterRef"
	| "ticketRowsRef"
	| "ticketsRef"
>;

/**
 * The Ticket list's one re-read: the projection, the drawn rows, and the
 * cursor's preserved index (ADR 0050, ADR 0060, issue #159).
 */
function appTicketProjectionRead(state: AppAggregates, fields: AppTicketReplaceFields) {
	const currentConfig = fields.configRef.current;
	const next = state.ticketWorkCycle.ticketListViews(
		currentConfig.workflowStates,
		currentConfig.defaultTaskType,
		fields.ticketFilterRef.current,
	);
	const currentIndex = fields.selectedIndexRef.current;
	const anchor = rowAnchorOf(fields.ticketRowsRef.current, currentIndex);
	const nextFacts = fields.factRows(next.rows);
	const nextRows = ticketRows(nextFacts, fields.groupingAxisRef.current, {
		folds: fields.groupFoldsRef.current,
		storedOrder: fields.groupOrderListRef.current,
		positionOrder: fields.positionOrderOf(),
	});
	const nextIndex = ticketRowIndexForAnchor(nextRows, anchor, currentIndex, {
		facts: nextFacts,
		axis: fields.groupingAxisRef.current,
	});
	return { next, nextRows, nextIndex };
}

/** The re-read's writes: the refs and the state setters the sections read next. */
function appTicketProjectionWrite(
	state: AppAggregates,
	read: ReturnType<typeof appTicketProjectionRead>,
	fields: AppTicketReplaceFields,
): void {
	fields.listViewsRef.current = read.next;
	fields.ticketsRef.current = read.next.rows;
	fields.ticketRowsRef.current = read.nextRows;
	fields.selectedIndexRef.current = read.nextIndex;
	fields.setListViews(read.next);
	fields.setHealths(state.sourceFact.sourceHealths());
	fields.setSelectedIndex(read.nextIndex);
	fields.setWorkQueue(state.workQueue.items());
}

/** The Consultation list's re-read: the rows the filter shows, the machine's counts, and the cursor's preserved index (story 14). */
function useAppConsultationReplace(props: AppProps, prev: AppTicketReplaceStage) {
	const { state } = props;
	const {
		consultationFollowRef,
		consultationIndexRef,
		consultationsRef,
		historyFilterRef,
		setConsultationIndex,
		setConsultationScroll,
		setConsultations,
		setLiveOutput,
		setMachineConsultations,
		setSessionEntries,
	} = prev;
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
	}, [
		state,
		historyFilterRef,
		consultationIndexRef,
		consultationsRef,
		setConsultations,
		setMachineConsultations,
		setConsultationIndex,
		setConsultationScroll,
		consultationFollowRef,
		setLiveOutput,
		setSessionEntries,
	]);
	return { ...prev, replaceConsultations };
}
type AppConsultationReplaceStage = ReturnType<typeof useAppConsultationReplace>;

/** The Model list of the agent the override panel is on: a fresh query per request, no cache (ADR 0010). */
function useAppModelList(prev: AppConsultationReplaceStage) {
	const { commandRunner } = prev;
	const [modelList, setModelList] = useState<AgentModelList>({
		agentType: "",
		status: { status: "loading" },
	});
	const modelListRequest = useRef(0);
	const fetchInitableRepositories = () => listInitableRepositories(commandRunner, "github.com");
	return { ...prev, modelList, setModelList, modelListRequest, fetchInitableRepositories };
}
type AppModelListStage = ReturnType<typeof useAppModelList>;

/** The unified cursor over the plane's sections and panes (issue #159). */
function useAppCursorShell(prev: AppOpsRefsStage) {
	const cursorFields: AppCursorFields = {
		focusedPaneRef: prev.focusedPaneRef,
		setFocusedPane: prev.setFocusedPane,
		selectionRef: prev.selectionRef,
		setSelection: prev.setSelection,
		ticketRowsRef: prev.ticketRowsRef,
		selectedIndexRef: prev.selectedIndexRef,
		setSelectedIndex: prev.setSelectedIndex,
		workQueueRef: prev.workQueueRef,
		workQueueIndexRef: prev.workQueueIndexRef,
		setWorkQueueIndex: prev.setWorkQueueIndex,
		workQueueDetailScrollRef: prev.workQueueDetailScrollRef,
		setWorkQueueDetailScroll: prev.setWorkQueueDetailScroll,
		workQueueDetailMaxScroll: prev.workQueueDetailMaxScroll,
		consultationsRef: prev.consultationsRef,
		consultationIndexRef: prev.consultationIndexRef,
		setConsultationIndex: prev.setConsultationIndex,
		setConsultationScroll: prev.setConsultationScroll,
		consultationFollowRef: prev.consultationFollowRef,
		setNewOutput: prev.setNewOutput,
		consultationMaxScroll: prev.consultationMaxScroll,
		detailGeometry: prev.detailGeometry,
		detailRef: prev.detailRef,
		configRef: prev.configRef,
		ticketsExpandedRef: prev.ticketsExpandedRef,
		setTicketsExpanded: prev.setTicketsExpanded,
		workExpandedRef: prev.workExpandedRef,
		setWorkExpanded: prev.setWorkExpanded,
		consultationsExpandedRef: prev.consultationsExpandedRef,
		setConsultationsExpanded: prev.setConsultationsExpanded,
		ticketsContentRows: prev.ticketsContentRows,
		consultationsContentRows: prev.consultationsContentRows,
		workContentRows: prev.workContentRows,
	};
	const cursor = useAppCursor(cursorFields);
	const { movePage, moveEdge, moveVertical } = cursor;
	return { ...prev, cursor, movePage, moveEdge, moveVertical };
}
type AppCursorShellStage = ReturnType<typeof useAppCursorShell>;

/** The Grouping's moves: the axis, the orders, and the folds the operator makes (ADR 0058, ADR 0071, issue #159). */
function useAppGroupOpsShell(props: AppProps, prev: AppCursorShellStage) {
	const groupOpsFields: AppGroupOpsFields = {
		state: props.state,
		groupingAxisRef: prev.groupingAxisRef,
		setGroupingAxis: prev.setGroupingAxis,
		groupOrderListRef: prev.groupOrderListRef,
		setGroupOrderList: prev.setGroupOrderList,
		groupFoldsRef: prev.groupFoldsRef,
		setGroupFolds: prev.setGroupFolds,
		groupOrdersForRunRef: prev.groupOrdersForRunRef,
		positionOrderOf: prev.positionOrderOf,
		factRows: prev.factRows,
		ticketsRef: prev.ticketsRef,
		ticketRowsRef: prev.ticketRowsRef,
		selectedIndexRef: prev.selectedIndexRef,
		setSelectedIndex: prev.setSelectedIndex,
		storedGroupOrderOf: prev.storedGroupOrderOf,
		setErrorMessage: prev.setErrorMessage,
		setNoticeMessage: prev.setNoticeMessage,
		setWarningMessage: prev.setWarningMessage,
	};
	const groupOps = useAppGroupOps(groupOpsFields);
	return { ...prev, groupOpsFields, groupOps };
}
type AppGroupOpsShellStage = ReturnType<typeof useAppGroupOpsShell>;

/** The repository init: the queued starts, the in-flight name, and the confirm's writes (ADR 0075, ADR 0083). */
function useAppRepoInitShell(props: AppProps, prev: AppGroupOpsShellStage) {
	const repoInitFields: AppRepoInitFields = {
		state: props.state,
		configRef: prev.configRef,
		ticketsRef: prev.ticketsRef,
		ticketRowsRef: prev.ticketRowsRef,
		selectedIndexRef: prev.selectedIndexRef,
		groupingAxisRef: prev.groupingAxisRef,
		repositoryInitQueue: prev.repositoryInitQueue,
		repositoryInitInFlight: prev.repositoryInitInFlight,
		commandRunner: prev.commandRunner,
		homeDir: prev.homeDir,
		configFile: prev.configFile,
		setConfig: prev.setConfig,
		setPanel: prev.setPanel,
		setWorkingMessage: prev.setWorkingMessage,
		clearWorkingMessage: prev.clearWorkingMessage,
		clearOperationMessage: prev.clearOperationMessage,
		setErrorMessage: prev.setErrorMessage,
		setWarningMessage: prev.setWarningMessage,
		setNoticeMessage: prev.setNoticeMessage,
		configWriteQueue: prev.configWriteQueue,
	};
	const repoInit = useAppRepoInit(repoInitFields);
	return { ...prev, repoInitFields, repoInit };
}
type AppRepoInitShellStage = ReturnType<typeof useAppRepoInitShell>;

/** The refs the ops fields and their callbacks read: the dispatch, the coordinator, the write queue, and the pane's refresh. */
function useAppOpsRefs(prev: AppModelListStage) {
	const handoffDispatchRef = useRef<
		{ state: HandoffDispatchAggregates; dispatch: HandoffDispatch } | undefined
	>(undefined);
	const coordinatorRef = useRef<RefreshCoordinator | undefined>(undefined);
	const configWriteQueue = useRef(Promise.resolve());
	// The selected Agent pane's refresh, callable the moment a forwarded
	// input lands: the operator should not wait out the refresh interval.
	const outputRefreshRef = useRef<(() => void) | null>(null);
	const consultationOperationsRef = useRef<ConsultationOperations | undefined>(undefined);
	const refireInFlightRef = useRef<string | null>(null);
	const ticketOpsFieldsRef = useRef<AppTicketOpsFields | null>(null);
	const handoffStartFieldsRef = useRef<AppHandoffStartFields | null>(null);
	return {
		...prev,
		handoffDispatchRef,
		coordinatorRef,
		configWriteQueue,
		outputRefreshRef,
		consultationOperationsRef,
		refireInFlightRef,
		ticketOpsFieldsRef,
		handoffStartFieldsRef,
	};
}
type AppOpsRefsStage = ReturnType<typeof useAppOpsRefs>;

/** The plane's operation fields: the state, the config's writes, the seats, and the message writers every operation shares. */
function useAppOpsFields(props: AppProps, prev: AppRepoInitShellStage) {
	const opsFields: AppOpsFields = {
		state: props.state,
		configRef: prev.configRef,
		setConfig: prev.setConfig,
		commandRunner: prev.commandRunner,
		homeDir: prev.homeDir,
		configFile: prev.configFile,
		logger: props.logger,
		modelListRequest: prev.modelListRequest,
		setModelList: prev.setModelList,
		configWriteQueue: prev.configWriteQueue,
		handoffDispatchRef: prev.handoffDispatchRef,
		consultationOperationsRef: prev.consultationOperationsRef,
		currentSeatCount: prev.currentSeatCount,
		currentMissingSeatTickets: prev.currentMissingSeatTickets,
		listViewsRef: prev.listViewsRef,
		setStartingTickets: prev.setStartingTickets,
		setWorkingMessage: prev.setWorkingMessage,
		setWarningMessage: prev.setWarningMessage,
		setErrorMessage: prev.setErrorMessage,
		setFaultWarningMessage: prev.setFaultWarningMessage,
		setFaultErrorMessage: prev.setFaultErrorMessage,
		setNoticeMessage: prev.setNoticeMessage,
		clearWorkingMessage: prev.clearWorkingMessage,
		clearProgressMessage: prev.clearProgressMessage,
		replaceTickets: prev.replaceTickets,
		replaceConsultations: prev.replaceConsultations,
		setStatus: prev.setStatus,
		setConsultationSafety: prev.setConsultationSafety,
		setPanel: prev.setPanel,
	};
	return { ...prev, opsFields };
}
type AppOpsFieldsStage = ReturnType<typeof useAppOpsFields>;

/** The shared dispatches: the Model list request, the handoff's choice, and the dispatch the state owns (ADR 0034). */
function useAppDispatches(prev: AppOpsFieldsStage) {
	const { opsFields } = prev;
	const requestModelList = (agentType: string) => appRequestModelList(opsFields, agentType);
	const choiceFor = (ticket: Ticket) => appChoiceFor(opsFields, ticket);
	const { consultationOperations, handoffDispatch } = appHandoffDispatches(opsFields);
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
	return { ...prev, requestModelList, choiceFor, consultationOperations, handoffDispatch };
}
type AppDispatchesStage = ReturnType<typeof useAppDispatches>;

/** The plane's standing facts, stated once per render (ADR 0014): the run state, the source counts, the configured Consultation types, and the exit key. */
function useAppStanding(prev: AppDispatchesStage) {
	const {
		config,
		configRef,
		coordinatorRef,
		handoffDispatch,
		liveSources,
		noStateHandoffInFlightRef,
	} = prev;
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
		messageRecorded: prev.messageRecorded,
		consultationTypesConfigured: Object.keys(config.consultationTypes).length > 0,
		sourceCount: liveSources.length,
		refreshingSourceCount: liveSources.filter(
			(source) => coordinatorRef.current?.isFetching(source.name) === true,
		).length,
		interactionExitKey: configRef.current.interactionExitKey,
		// The Queue pause's one read for the plane (ADR 0111): the brake the
		// operator set by key stands here, beside the other standing facts, and
		// the header's corner lamp and the border lamp read it from here, the
		// same value the key toggles and the drain honors.
		queuePaused: prev.queuePaused,
	};
	return { ...prev, standing };
}
type AppStandingStage = ReturnType<typeof useAppStanding>;

/** The Main view's Availability facts for every Interaction mode (ADR 0014). */
function useAppMainFacts(props: AppProps, prev: AppBaseModeStage) {
	const { currentBaseMode } = prev;
	const mainFactsFields: AppMainFactsFields = {
		standing: prev.standing,
		selectedTicket: prev.selectedTicket,
		ticketAtCursor: prev.ticketAtCursor,
		factsFor: prev.factsFor,
		ticketFilterRef: prev.ticketFilterRef,
		selectedTicketPaneAlive: prev.selectedTicketPaneAlive,
		selectedTicketPaneForeign: prev.selectedTicketPaneForeign,
		selectionRef: prev.selectionRef,
		consultationsRef: prev.consultationsRef,
		consultationIndexRef: prev.consultationIndexRef,
		state: props.state,
		selectedConsultationAgentStatus: prev.selectedConsultationAgentStatus,
		selectedConsultationPaneAlive: prev.selectedConsultationPaneAlive,
		ticketRowsRef: prev.ticketRowsRef,
		ticketsExpandedRef: prev.ticketsExpandedRef,
		consultationsExpandedRef: prev.consultationsExpandedRef,
		workExpandedRef: prev.workExpandedRef,
		workQueueRef: prev.workQueueRef,
		workQueueIndexRef: prev.workQueueIndexRef,
		selectedIndexRef: prev.selectedIndexRef,
		groupingAxis: prev.groupingAxis,
		detailMaxScroll: prev.detailMaxScroll,
		consultationMaxScroll: prev.consultationMaxScroll,
		workQueueDetailMaxScroll: prev.workQueueDetailMaxScroll,
	};
	const mainFacts = (mode: InteractionMode = currentBaseMode()) =>
		mainFactsFor(mainFactsFields, mode);
	return { ...prev, mainFactsFields, mainFacts };
}
type AppMainFactsStage = ReturnType<typeof useAppMainFacts>;

/** The handoff's callbacks: the start, the cycle's draft end, and the source refreshes the operations run. */
function useAppHandoffCallbacks(prev: AppMainFactsStage) {
	const { handoffStartFieldsRef, ticketOpsFieldsRef } = prev;
	const startHandoff = useCallback(
		(ticket: Ticket, choice: HandoffChoice) => {
			const f = handoffStartFieldsRef.current;
			if (f !== null) startHandoffTicket(f, ticket, choice);
		},
		[handoffStartFieldsRef],
	);
	const closeCycleEndDraft = useCallback(
		(identity: string) => {
			const f = ticketOpsFieldsRef.current;
			if (f !== null) appCloseCycleEndDraft(f, identity);
		},
		[ticketOpsFieldsRef],
	);
	const refreshTicketSources = useCallback(
		(identity: string) => {
			const f = ticketOpsFieldsRef.current;
			if (f !== null) appRefreshTicketSources(f, identity);
		},
		[ticketOpsFieldsRef],
	);
	const refreshPullRequestSources = useCallback(() => {
		const f = ticketOpsFieldsRef.current;
		if (f !== null) return appRefreshPullRequestSources(f);
		return Promise.resolve();
	}, [ticketOpsFieldsRef]);
	return {
		...prev,
		startHandoff,
		closeCycleEndDraft,
		refreshTicketSources,
		refreshPullRequestSources,
	};
}
type AppHandoffCallbacksStage = ReturnType<typeof useAppHandoffCallbacks>;

/** The ticket operations' fields: the ops fields plus the ticket surface's own state and callbacks. */
function useAppTicketOpsFields(prev: AppHandoffCallbacksStage) {
	const { ticketOpsFieldsRef } = prev;
	const finishOutcome = (outcome: HandoffOutcome) => appFinishOutcome(ticketOpsFields, outcome);

	const ticketOpsFields: AppTicketOpsFields = {
		...prev.opsFields,
		findTicket: prev.findTicket,
		listViews: prev.listViews,
		workQueueRef: prev.workQueueRef,
		startingTicketsRef: prev.startingTicketsRef,
		overrideRef: prev.overrideRef,
		setOverride: prev.setOverride,
		panel: prev.panel,
		setNewsMessage: prev.setNewsMessage,
		reportMessage: prev.reportMessage,
		autoModeRef: prev.autoModeRef,
		setAutoMode: prev.setAutoMode,
		setQueuePaused: prev.setQueuePaused,
		handoffDispatch: prev.handoffDispatch,
		agentsRef: prev.agentsRef,
		coordinatorRef: prev.coordinatorRef,
		mainFacts: prev.mainFacts,
		ticketRowsRef: prev.ticketRowsRef,
		selectedIndexRef: prev.selectedIndexRef,
		choiceFor: prev.choiceFor,
		startHandoff: prev.startHandoff,
		closeCycleEndDraft: prev.closeCycleEndDraft,
		clearOperationMessage: prev.clearOperationMessage,
		refireInFlightRef: prev.refireInFlightRef,
	};
	ticketOpsFieldsRef.current = ticketOpsFields;
	return { ...prev, finishOutcome, ticketOpsFields };
}
type AppTicketOpsFieldsStage = ReturnType<typeof useAppTicketOpsFields>;

/** The ticket operations the surfaces call: the override, the Auto-handoff, the Goto, and the decision's actions. */
function useAppTicketOpsActions(prev: AppTicketOpsFieldsStage) {
	const { ticketOpsFields } = prev;
	const openOverride = () => appOpenOverride(ticketOpsFields);
	const confirmOverride = (choice: HandoffChoice) => appConfirmOverride(ticketOpsFields, choice);
	const cancelOverride = () => appCancelOverride(ticketOpsFields);
	const toggleAutoHandoff = () => appToggleAutoHandoff(ticketOpsFields);
	const toggleQueuePause = () => appToggleQueuePause(ticketOpsFields);
	const decisionFor = (ticket: Ticket) => appDecisionFor(ticketOpsFields, ticket);
	const runGoto = (ticket: Ticket) => appRunGoto(ticketOpsFields, ticket);
	const runDecisionAction = (ticket: Ticket, key: string) =>
		appRunDecisionAction(ticketOpsFields, ticket, key);
	const runTicketClose = (asked: Ticket) => appRunTicketClose(ticketOpsFields, asked);
	const taskPlacementsFor = (pending: PendingOverride) =>
		appTaskPlacementsFor(ticketOpsFields, pending);
	const openRouteOverride = (ticket: Ticket, key: string) =>
		appOpenRouteOverride(ticketOpsFields, ticket, key);
	return {
		...prev,
		openOverride,
		confirmOverride,
		cancelOverride,
		toggleAutoHandoff,
		toggleQueuePause,
		decisionFor,
		runGoto,
		runDecisionAction,
		runTicketClose,
		taskPlacementsFor,
		openRouteOverride,
	};
}
type AppTicketOpsActionsStage = ReturnType<typeof useAppTicketOpsActions>;

/** The handoff start's fields: the dispatch, the standing facts, and the writes the start makes. */
function useAppHandoffStartFields(prev: AppTicketOpsActionsStage) {
	const { handoffStartFieldsRef } = prev;
	const handoffStartFields: AppHandoffStartFields = {
		handoffDispatch: prev.handoffDispatch,
		mainFacts: prev.mainFacts,
		setWarningMessage: prev.setWarningMessage,
		noStateHandoffInFlightRef: prev.noStateHandoffInFlightRef,
		setStartingTickets: prev.setStartingTickets,
		setWorkingMessage: prev.setWorkingMessage,
		setFaultErrorMessage: prev.setFaultErrorMessage,
		config: prev.config,
		commandRunner: prev.commandRunner,
		homeDir: prev.homeDir,
		finishOutcome: prev.finishOutcome,
		setListViews: prev.setListViews,
		listViewsRef: prev.listViewsRef,
		ticketsRef: prev.ticketsRef,
	};
	handoffStartFieldsRef.current = handoffStartFields;
	return { ...prev, handoffStartFields };
}
type AppHandoffStartFieldsStage = ReturnType<typeof useAppHandoffStartFields>;

/** The Consultation operations' fields: the ticket ops' fields plus the Consultation surface's own state. */
function useAppConsultationOpsFields(prev: AppHandoffStartFieldsStage) {
	const consultationOpsFields: AppConsultationOpsFields = {
		...prev.ticketOpsFields,
		consultationOperations: prev.consultationOperations,
		replacementConsultationId: prev.replacementConsultationId,
		setReplacementConsultationId: prev.setReplacementConsultationId,
		setLauncher: prev.setLauncher,
		historyFilterRef: prev.historyFilterRef,
		setHistoryFilter: prev.setHistoryFilter,
		consultationsRef: prev.consultationsRef,
		consultationIndexRef: prev.consultationIndexRef,
		setConsultationIndex: prev.setConsultationIndex,
		selectionRef: prev.selectionRef,
		setSelection: prev.setSelection,
		consultationFollowRef: prev.consultationFollowRef,
		setConsultationScroll: prev.setConsultationScroll,
		setNewOutput: prev.setNewOutput,
		responseDraftRef: prev.responseDraftRef,
		setResponseDraft: prev.setResponseDraft,
		setResponseEditor: prev.setResponseEditor,
		selectedConsultation: prev.selectedConsultation,
		ticketAtCursor: prev.ticketAtCursor,
		factsFor: prev.factsFor,
		cursor: prev.cursor,
		ticketFilterRef: prev.ticketFilterRef,
		setTicketFilter: prev.setTicketFilter,
		workQueueIndexRef: prev.workQueueIndexRef,
		setWorkQueueIndex: prev.setWorkQueueIndex,
		interaction: prev.interaction,
		responseEditor: prev.responseEditor,
		focusedPaneRef: prev.focusedPaneRef,
	};
	return { ...prev, consultationOpsFields };
}
type AppConsultationOpsFieldsStage = ReturnType<typeof useAppConsultationOpsFields>;

/** The Consultation records' operations: the submit, the recovery, and the close branches. */
function useAppConsultationCrud(prev: AppConsultationOpsFieldsStage) {
	const { consultationOpsFields } = prev;
	const submitConsultation = (
		typeName: string,
		repository: ConsultationRepositoryOption,
		input: string,
	) => appSubmitConsultation(consultationOpsFields, typeName, repository, input);
	const recoverConsultationOpening = (consultation: Consultation) =>
		appRecoverConsultationOpening(consultationOpsFields, consultation);
	const consultationHasNoAgent = (consultation: Consultation) =>
		appConsultationHasNoAgent(consultation);
	const isReplacedConsultation = consultationHasNoAgent;
	const openReplacementLauncher = (consultation: Consultation) =>
		appOpenReplacementLauncher(consultationOpsFields, consultation);
	const runConsultationClose = (consultation: Consultation) =>
		appRunConsultationClose(consultationOpsFields, consultation);
	const beginResponse = (consultation: Consultation) =>
		appBeginResponse(consultationOpsFields, consultation);
	return {
		...prev,
		submitConsultation,
		recoverConsultationOpening,
		consultationHasNoAgent,
		isReplacedConsultation,
		openReplacementLauncher,
		runConsultationClose,
		beginResponse,
	};
}
type AppConsultationCrudStage = ReturnType<typeof useAppConsultationCrud>;

/** The response editor's operations and the list's cycles: the draft's writes, the section's click, and the filter's turns. */
function useAppConsultationResponse(prev: AppConsultationCrudStage) {
	const { consultationOpsFields } = prev;
	const storeResponseDraft = (text: string) => appStoreResponseDraft(consultationOpsFields, text);
	const sendResponseText = (text: string) => appSendResponseText(consultationOpsFields, text);
	const discardResponseDraft = () => appDiscardResponseDraft(consultationOpsFields);
	const closeResponseEditor = () => appCloseResponseEditor(consultationOpsFields);
	const clickSection = (next: MainSection) => appClickSection(consultationOpsFields, next);
	const cycleTicketFilter = () => appCycleTicketFilter(consultationOpsFields);
	const toggleTicketIgnore = () => appToggleTicketIgnore(consultationOpsFields);
	const toggleSourceMute = () => appToggleSourceMute(consultationOpsFields);
	const cycleConsultationHistory = () => appCycleConsultationHistory(consultationOpsFields);
	const closeConsultation = (consultation: Consultation) =>
		appCloseConsultation(consultationOpsFields, consultation);
	const forceCloseConsultation = (consultation: Consultation) =>
		appForceCloseConsultation(consultationOpsFields, consultation);
	const deleteConsultation = (consultation: Consultation) =>
		appDeleteConsultation(consultationOpsFields, consultation);
	const runMissingAction = (ticket: Ticket, key: string) =>
		appRunMissingAction(consultationOpsFields, ticket, key);
	return {
		...prev,
		storeResponseDraft,
		sendResponseText,
		discardResponseDraft,
		closeResponseEditor,
		clickSection,
		cycleTicketFilter,
		toggleTicketIgnore,
		toggleSourceMute,
		cycleConsultationHistory,
		closeConsultation,
		forceCloseConsultation,
		deleteConsultation,
		runMissingAction,
	};
}
type AppConsultationResponseStage = ReturnType<typeof useAppConsultationResponse>;

/**
 * The plane's base Interaction mode: the mode the Main view's controls dispatch under.
 */
function useAppBaseMode(prev: AppStandingStage) {
	const { focusedPaneRef, interaction, responseEditor, selectionRef } = prev;
	const currentBaseMode = (): InteractionMode =>
		appCurrentBaseMode({
			interaction,
			responseEditor,
			selectionRef,
			focusedPaneRef,
		});
	return { ...prev, currentBaseMode };
}
type AppBaseModeStage = ReturnType<typeof useAppBaseMode>;

/** The Work queue's moves: the item's up and down, its removal, and the forced dispatch. */
function useAppQueueOps(prev: AppConsultationResponseStage) {
	const { consultationOpsFields } = prev;
	const moveQueueItem = (direction: "up" | "down", item: WorkQueueItem | null) =>
		appMoveQueueItem(consultationOpsFields, direction, item);
	const removeQueueItem = (item: WorkQueueItem | null) =>
		appRemoveQueueItem(consultationOpsFields, item);
	const forceDispatchQueueItem = (item: WorkQueueItem | null) =>
		appForceDispatchQueueItem(consultationOpsFields, item);
	return { ...prev, moveQueueItem, removeQueueItem, forceDispatchQueueItem };
}
type AppQueueOpsStage = ReturnType<typeof useAppQueueOps>;

/** The workspace's label and the guide and Message views' openers. */
function useAppWorkspaceGuides(prev: AppQueueOpsStage) {
	const { commandRunner, currentBaseMode, messageHistory, setUtility } = prev;
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

	const openGuide = (mode: InteractionMode = currentBaseMode()) => {
		setUtility({ kind: "guide", mode });
	};
	const openMessage = (mode: InteractionMode = currentBaseMode()) => {
		if (messageHistory.length === 0) return;
		// The view reads the live history, so an entry that lands while it
		// stands shows at the bottom, and the history the run recorded stays the
		// record the view shows (ADR 0119).
		setUtility({ kind: "message", mode });
	};
	return { ...prev, workspaceLabelOf, openGuide, openMessage };
}
type AppWorkspaceGuidesStage = ReturnType<typeof useAppWorkspaceGuides>;

/** The `r` control's refresh: one check, one reason, and the names the round starts. */
function useAppRefreshNow(prev: AppWorkspaceGuidesStage) {
	const { coordinatorRef, liveSources, setWarningMessage, setWorkingMessage } = prev;
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
	return { ...prev, manualRefreshPending, refreshNow };
}
type AppRefreshNowStage = ReturnType<typeof useAppRefreshNow>;

/** The range keys' moves and Enter's decision on a settled Ticket (ADR 0092). */
function useAppRangeDecision(prev: AppRefreshNowStage) {
	const { autoModeRef, moveEdge, movePage, moveVertical, setNoticeMessage, setPanel } = prev;
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
			setNoticeMessage("auto-handoff is on: the factory decides this ticket", "info");
			return;
		}
		// The mode decides the route at runtime (ADR 0092), so in manual mode the
		// operator's key opens the screen on the settled turn in every case: the
		// screen reads the turn's derived Next step and states the gate that
		// holds it.
		setPanel({ kind: "decision", identity: ticket.identity });
	};
	return { ...prev, moveRange, decideCompletion };
}
type AppRangeDecisionStage = ReturnType<typeof useAppRangeDecision>;

/** The key handler's core fields: the surfaces, the messages, and the moves. */
function appKeyHandlerFieldsCore(
	state: AppAggregates | undefined,
	p: AppRangeDecisionStage,
): Pick<
	AppKeyHandlerFields,
	| "utility"
	| "override"
	| "panel"
	| "launcher"
	| "interaction"
	| "responseEditor"
	| "renderer"
	| "configRef"
	| "setInteraction"
	| "setNewOutput"
	| "consultationOperations"
	| "setNoticeMessage"
	| "setErrorMessage"
	| "setWarningMessage"
	| "consultationsRef"
	| "consultationIndexRef"
	| "outputRefreshRef"
	| "currentBaseMode"
	| "mainFacts"
	| "decideCompletion"
	| "factsFor"
	| "startHandoff"
	| "choiceFor"
	| "setPanel"
	| "state"
	| "runGoto"
	| "cursor"
	| "moveQueueItem"
	| "removeQueueItem"
	| "forceDispatchQueueItem"
	| "moveRange"
	| "groupOps"
	| "repoInit"
> {
	return {
		utility: p.utility,
		override: p.override,
		panel: p.panel,
		launcher: p.launcher,
		interaction: p.interaction,
		responseEditor: p.responseEditor,
		renderer: p.renderer,
		configRef: p.configRef,
		setInteraction: p.setInteraction,
		setNewOutput: p.setNewOutput,
		consultationOperations: p.consultationOperations,
		setNoticeMessage: p.setNoticeMessage,
		setErrorMessage: p.setErrorMessage,
		setWarningMessage: p.setWarningMessage,
		consultationsRef: p.consultationsRef,
		consultationIndexRef: p.consultationIndexRef,
		outputRefreshRef: p.outputRefreshRef,
		currentBaseMode: p.currentBaseMode,
		mainFacts: p.mainFacts,
		decideCompletion: p.decideCompletion,
		factsFor: p.factsFor,
		startHandoff: p.startHandoff,
		choiceFor: p.choiceFor,
		setPanel: p.setPanel,
		state,
		runGoto: p.runGoto,
		cursor: p.cursor,
		moveQueueItem: p.moveQueueItem,
		removeQueueItem: p.removeQueueItem,
		forceDispatchQueueItem: p.forceDispatchQueueItem,
		moveRange: p.moveRange,
		groupOps: p.groupOps,
		repoInit: p.repoInit,
	};
}

/** The key handler's remaining fields: the ops, the queue, and the guides. */
function appKeyHandlerFieldsRest(p: AppRangeDecisionStage) {
	return {
		refuseInitInFlight: p.refuseInitInFlight,
		selectionRef: p.selectionRef,
		isReplacedConsultation: p.isReplacedConsultation,
		openReplacementLauncher: p.openReplacementLauncher,
		setLauncher: p.setLauncher,
		cycleConsultationHistory: p.cycleConsultationHistory,
		toggleTicketIgnore: p.toggleTicketIgnore,
		toggleSourceMute: p.toggleSourceMute,
		cycleTicketFilter: p.cycleTicketFilter,
		runConsultationClose: p.runConsultationClose,
		replaceTickets: p.replaceTickets,
		replaceConsultations: p.replaceConsultations,
		handoffDispatchRef: p.handoffDispatchRef,
		currentSeatCount: p.currentSeatCount,
		beginResponse: p.beginResponse,
		commandRunner: p.commandRunner,
		workspaceLabelOf: p.workspaceLabelOf,
		reportMessage: p.reportMessage,
		openOverride: p.openOverride,
		recoverConsultationOpening: p.recoverConsultationOpening,
		consultationsExpandedRef: p.consultationsExpandedRef,
		refreshNow: p.refreshNow,
		toggleQueuePause: p.toggleQueuePause,
		workQueueRef: p.workQueueRef,
		setSelection: p.setSelection,
		workQueueIndexRef: p.workQueueIndexRef,
		setWorkQueueIndex: p.setWorkQueueIndex,
		setWorkExpanded: p.setWorkExpanded,
		workExpandedRef: p.workExpandedRef,
		toggleAutoHandoff: p.toggleAutoHandoff,
		openGuide: p.openGuide,
		openMessage: p.openMessage,
	};
}

/**
 * The shell's key handler: the control catalogue's dispatch over the Main view (ADR 0111).
 */
function useAppKeyHandlers(props: AppProps, prev: AppRangeDecisionStage) {
	const { state } = props;
	const keyHandlerFields: AppKeyHandlerFields = {
		...appKeyHandlerFieldsCore(state, prev),
		...appKeyHandlerFieldsRest(prev),
	};
	useKeyboard((key) => appKeyHandler(keyHandlerFields, key));
	return prev;
}
type AppKeyHandlersStage = ReturnType<typeof useAppKeyHandlers>;

/** The Consultation session's refresh: the output, the entries, and the follow (ADR 0025). */
function useAppSessionRefresh(props: AppProps, prev: AppKeyHandlersStage) {
	const consultationSessionFields = useMemo<AppConsultationSessionFields>(
		() => ({
			state: props.state,
			selection: prev.selection,
			selectedConsultation: prev.selectedConsultation,
			setLiveOutput: prev.setLiveOutput,
			setSessionEntries: prev.setSessionEntries,
			agentsRef: prev.agentsRef,
			configRef: prev.configRef,
			commandRunner: prev.commandRunner,
			consultationOperations: prev.consultationOperations,
			interaction: prev.interaction,
			consultationFollowRef: prev.consultationFollowRef,
			setConsultationScroll: prev.setConsultationScroll,
			setNewOutput: prev.setNewOutput,
			outputRefreshRef: prev.outputRefreshRef,
		}),
		[
			props.state,
			prev.selection,
			prev.selectedConsultation,
			prev.setLiveOutput,
			prev.setSessionEntries,
			prev.agentsRef,
			prev.configRef,
			prev.commandRunner,
			prev.consultationOperations,
			prev.interaction,
			prev.consultationFollowRef,
			prev.setConsultationScroll,
			prev.setNewOutput,
			prev.outputRefreshRef,
		],
	);
	useEffect(
		() => appConsultationSessionRefresh(consultationSessionFields),
		[consultationSessionFields],
	);
	return { ...prev, consultationSessionFields };
}
type AppSessionRefreshStage = ReturnType<typeof useAppSessionRefresh>;

/** The observation loop's fields: the poll's inputs and the writes its tick makes (ADR 0034). */
function useAppObservationFields(props: AppProps, prev: AppSessionRefreshStage) {
	const observationFields = useMemo<AppObservationFields>(
		() => ({
			state: props.state,
			handoffDispatch: prev.handoffDispatch,
			initialTickets: props.initialTickets,
			pollIntervalMs: props.pollIntervalMs,
			commandRunner: prev.commandRunner,
			configRef: prev.configRef,
			autoModeRef: prev.autoModeRef,
			replaceTickets: prev.replaceTickets,
			replaceConsultations: prev.replaceConsultations,
			setAgents: prev.setAgents,
			setBell: prev.setBell,
			attention: prev.attention,
			onReady: props.onReady,
			clearOperationMessage: prev.clearOperationMessage,
			setStatus: prev.setStatus,
			refreshTicketSources: prev.refreshTicketSources,
			closeCycleEndDraft: prev.closeCycleEndDraft,
			refreshPullRequestSources: prev.refreshPullRequestSources,
			logger: props.logger,
			observationRef: prev.observationRef,
			coordinatorRef: prev.coordinatorRef,
			handoffDispatchRef: prev.handoffDispatchRef,
		}),
		[
			props.state,
			prev.handoffDispatch,
			props.initialTickets,
			props.pollIntervalMs,
			prev.commandRunner,
			prev.configRef,
			prev.autoModeRef,
			prev.replaceTickets,
			prev.replaceConsultations,
			prev.setAgents,
			prev.setBell,
			prev.attention,
			props.onReady,
			prev.clearOperationMessage,
			prev.setStatus,
			prev.refreshTicketSources,
			prev.closeCycleEndDraft,
			prev.refreshPullRequestSources,
			props.logger,
			prev.observationRef,
			prev.coordinatorRef,
			prev.handoffDispatchRef,
		],
	);
	return { ...prev, observationFields };
}
type AppObservationFieldsStage = ReturnType<typeof useAppObservationFields>;

/** The observation loop: the poll, the seats, and the dispatch's tick (ADR 0034). */
function useAppObservation(prev: AppObservationFieldsStage) {
	useEffect(() => appObservationCoordinator(prev.observationFields), [prev.observationFields]);
	return prev;
}
type AppObservationStage = ReturnType<typeof useAppObservation>;

/** The boot read: the state's tickets and Consultations, and the queue's brake the factory state holds (ADR 0052). */
function useAppInitBoot(props: AppProps, prev: AppObservationStage) {
	const { replaceConsultations, replaceTickets, setQueuePaused } = prev;
	const { state } = props;
	// A state may already hold tickets when the app boots: read them once at
	// mount, before any refresh or observation cycle runs.
	useEffect(() => {
		if (state === undefined) return;
		replaceTickets();
		replaceConsultations();
		// The queue pause is factory state (ADR 0052): a restart finds the
		// brake where the operator left it.
		setQueuePaused(state.workQueue.queuePaused());
	}, [state, replaceTickets, replaceConsultations, setQueuePaused]);
	return { ...prev };
}
type AppInitBootStage = ReturnType<typeof useAppInitBoot>;

/** The one-time init note on the Message line (ADR 0075, story 20): the operator learns the uninit or drift once per run. */
function useAppInitNote(props: AppProps, prev: AppInitBootStage) {
	const { config, groupingAxis, initNoteShownRef, machineTickets, setNoticeMessage } = prev;
	const { state } = props;
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
	}, [machineTickets, state, config, groupingAxis, setNoticeMessage, initNoteShownRef]);
	return { ...prev };
}
type AppInitNoteStage = ReturnType<typeof useAppInitNote>;

/** The repository catalog's validation: the options the launcher may start, re-validated when the catalog moves (ADR 0060). */
function useAppCatalog(prev: AppInitNoteStage) {
	const { commandRunner, config, homeDir, machineTickets, setRepositoryOptions } = prev;
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
	return { ...prev, repositoryCatalogKey };
}
type AppCatalogStage = ReturnType<typeof useAppCatalog>;

/** The refresh's settled hook: the pending source leaves the refresh's set.
 */
function appCoordinatorSettled(
	sourceName: string,
	pending: { current: Set<string> },
	clearWorkingMessage: (owner: ProgressOwner) => void,
): void {
	if (!pending.current.has(sourceName)) return;
	pending.current.delete(sourceName);
	if (pending.current.size === 0) clearWorkingMessage("refresh");
}

/** The refresh coordinator: the startup's poll, the sources, and the dispatch the key handler holds in a ref (ADR 0034). */
function useAppCoordinator(props: AppProps, prev: AppCatalogStage) {
	const {
		clearWorkingMessage,
		coordinatorRef,
		liveSources,
		manualRefreshPending,
		observationRef,
		replaceConsultations,
		replaceTickets,
		setFaultWarningMessage,
	} = prev;
	const { logger, state } = props;
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
					// The warnings a successful source read carries: a security
					// source the read skipped. The plane met them on its own, so
					// they are Faults (ADR 0118), and the dedup on the same
					// fact keeps the record quiet while they stand.
					for (const warning of outcome.warnings ?? []) setFaultWarningMessage(warning);
				replaceTickets();
				replaceConsultations();
				// A fetch may have made a ticket actionable: let the observation
				// loop act on it now instead of on the next poll.
				observationRef.current?.tick();
			},
			{
				settled: (sourceName) =>
					appCoordinatorSettled(sourceName, manualRefreshPending, clearWorkingMessage),
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
		setFaultWarningMessage,
		logger,
		observationRef,
		coordinatorRef,
		manualRefreshPending,
	]);
	return { ...prev };
}
type AppCoordinatorStage = ReturnType<typeof useAppCoordinator>;

/** The open panel's own facts: the panel's kind, its Ticket, and its Consultation copies. */
function useAppOpenPanel(prev: AppCoordinatorStage) {
	const { consultationsRef, findTicket, panel } = prev;
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
	return {
		...prev,
		ticketPanel,
		panelTicket,
		panelIdentity,
		panelConsultation,
		closePanel,
		recoveryPanel,
	};
}
type AppOpenPanelStage = ReturnType<typeof useAppOpenPanel>;

/** The open panel's decision and Live mode: the decision the view owes, and the stream's mode. */
function useAppPanelDecision(prev: AppOpenPanelStage) {
	const { autoMode, decisionFor, factsFor, panel, panelTicket } = prev;
	const decision =
		panel !== null && panel.kind === "decision" && panelTicket !== undefined
			? decisionFor(panelTicket)
			: undefined;
	// The mode the open Live panel shows, re-derived from the ticket's current
	// facts on every render, so the screen follows the ticket without the
	// operator asking: the stream while the agent works (a settled turn the
	// factory decides for itself keeps streaming), the decision body when
	// the factory waits for the operator, the missing box when the pane is
	// gone, and closed when the ticket leaves the in-flight states or leaves the
	// work cycle the view opened on.
	const liveMode = livePanelMode({ panel, panelTicket, autoMode, factsFor });
	const liveDecision =
		panelTicket !== undefined && liveMode === "decision" ? decisionFor(panelTicket) : undefined;
	return { ...prev, decision, liveMode, liveDecision };
}
type AppPanelDecisionStage = ReturnType<typeof useAppPanelDecision>;

/** The mode one open Live panel shows, from the ticket's current facts. */
function livePanelMode(fields: {
	panel: Panel;
	panelTicket: Ticket | undefined;
	autoMode: boolean;
	factsFor: (ticket: Ticket) => TicketRowFacts;
}): "stream" | "decision" | "missing" | "closed" {
	const { panel, panelTicket, autoMode, factsFor } = fields;
	if (panel === null || panel.kind !== "live" || panelTicket === undefined) return "closed";
	// The cycle the view opened on is the cycle it shows. The write that ends
	// a cycle moves the ticket to `open` and to the next cycle in one step, and
	// the queued start of the route moves it on again before the plane next
	// reads it, so the `open` frame is a moment the plane may never be handed:
	// a surface that waited for that moment alone can be given the next
	// cycle's frame first and then wait for a screen change that no longer
	// comes. The cycle number is the durable form of the same fact (ADR 0110).
	if (panelTicket.workCycle !== panel.workCycle) return "closed";
	// The route confirm ends the ticket's cycle on its own surface and
	// the screen reads the list when the ticket leaves the stream's
	// states (ADR 0072, ADR 0110).
	if (panelTicket.state === "open") return "closed";
	// Auto-handoff mode decides the settled turn on its own, so
	// the ticket keeps streaming; manual mode waits for the
	// operator's hand (ADR 0092).
	if (panelTicket.state === "awaiting") return autoMode ? "stream" : "decision";
	return factsFor(panelTicket).failure === "missing" ? "missing" : "stream";
}

/** The Consultation panel's release note and the guard that drops a panel that has nothing to show. */
function useAppPanelRelease(prev: AppPanelDecisionStage) {
	const {
		closePanel,
		decision,
		liveMode,
		panel,
		panelConsultation,
		panelTicket,
		recoveryPanel,
		reportMessage,
		setPanel,
		ticketPanel,
	} = prev;
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
	}, [panelHasNothingToShow, consultationPanelReleaseNote, reportMessage, setPanel]);
	return { ...prev, consultationPanelName, consultationPanelReleaseNote };
}
type AppPanelReleaseStage = ReturnType<typeof useAppPanelRelease>;

/** The Live view's stream: the one-second read of the pane the ticket's handoff records. */
function useAppLivePanel(prev: AppPanelReleaseStage) {
	const { commandRunner, configRef, findTicket, liveMode, panel, setLiveStream } = prev;
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
	}, [panel, liveMode, commandRunner, findTicket, configRef, setLiveStream]);
	return { ...prev };
}
type AppLivePanelStage = ReturnType<typeof useAppLivePanel>;

/** The Message line's facts: the empty list's message, the color, and the lines the size box holds. */
function useAppRenderMessages(props: AppProps, prev: AppLivePanelStage) {
	const { config, groupingAxis, healths, ignoredCount, mutedCount, ticketFilter } = prev;
	const { state } = props;
	// An empty grouped list names the axis in its message, so "no tickets" says
	// which view the operator is reading (issue #159, user story 9).
	const emptyMessage =
		state === undefined
			? undefined
			: emptyTicketMessage({
					sourceCount: config.sources.length,
					healthCount: healths.length,
					anyLoading: healths.some((health) => health.health === "loading"),
					ignoredCount,
					mutedCount,
					ticketFilter,
					groupingAxis,
				});
	return { ...prev, state, emptyMessage };
}
type AppRenderMessagesStage = ReturnType<typeof useAppRenderMessages>;

/** The one message one empty ticket list stands under. */
function emptyTicketMessage(fields: {
	sourceCount: number;
	healthCount: number;
	anyLoading: boolean;
	ignoredCount: number;
	mutedCount: number;
	ticketFilter: TicketListFilter;
	groupingAxis: GroupingAxis;
}): string {
	const {
		sourceCount,
		healthCount,
		anyLoading,
		ignoredCount,
		mutedCount,
		ticketFilter,
		groupingAxis,
	} = fields;
	if (sourceCount === 0) return groupingEmptyMessage("no ticket sources configured", groupingAxis);
	if (healthCount === 0 || anyLoading)
		return groupingEmptyMessage("loading tickets...", groupingAxis);
	// A hidden pile is not an idle factory (ADR 0060, widened by ADR 0070):
	// the empty active view points at the key that shows the rows the
	// flags took away, and a filtered view with no rows names the view the
	// operator is in. Each number is its ledger itself, the same one its
	// header cell names: where the active view stands empty, every flagged
	// row is out of it, because a row with live work or a decision owed
	// stays in.
	if ((ignoredCount > 0 || mutedCount > 0) && ticketFilter === "active")
		return groupingEmptyMessage(
			`no active Tickets; ${[
				...(ignoredCount > 0 ? [`${ignoredCount} ignored`] : []),
				...(mutedCount > 0 ? [`${mutedCount} muted`] : []),
			].join(", ")} - press f`,
			groupingAxis,
		);
	if (ticketFilter === "ignored")
		return groupingEmptyMessage("no ignored Tickets - press f", groupingAxis);
	if (ticketFilter === "muted")
		return groupingEmptyMessage("no muted Tickets - press f", groupingAxis);
	return groupingEmptyMessage("no tickets match the configured sources", groupingAxis);
}

/** The launcher's form: the Replacement context it opened on, or the fresh form's start. */
function useAppRenderLaunch(props: AppProps, prev: AppRenderMessagesStage) {
	const { config, consultations, launcherForm, replacementConsultationId, selectedTicket } = prev;
	const { state } = props;
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
	return { ...prev, replacementConsultation, launcherOwner, launcherDraft };
}
type AppRenderLaunchStage = ReturnType<typeof useAppRenderLaunch>;

/** The Main view's modes: the base mode, the Action bar's facts, and the surface's mouse state. */
function useAppRenderModes(prev: AppRenderLaunchStage) {
	const {
		compactLineCount,
		currentBaseMode,
		interaction,
		launcher,
		mainFacts,
		mainFactsFields,
		override,
		panel,
		responseEditor,
		utility,
		visibleMessage,
		visibleMessageText,
	} = prev;
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
			? mainFactsFor(mainFactsFields, utility.mode)
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
	return {
		...prev,
		actionMode,
		mainBarFacts,
		messageColor,
		importantSmallMessage,
		compactLines,
		utilityFacts,
		mainSurfaceActive,
	};
}
type AppRenderModesStage = ReturnType<typeof useAppRenderModes>;

/** The plane's base stages: the state chain and the first operations. */
function useAppBaseStages(props: AppProps): AppConsultationOpsFieldsStage {
	const chrome = useAppChrome(props);
	const cfg = useAppConfigState(props, chrome);
	const s2 = useAppListViews(props, cfg);
	const s3a = useAppGroupingState(props, s2);
	const s3b = useAppFoldsState(s3a);
	const s3c = useAppSelectionState(props, s3b);
	const s4a = useAppLauncherState(s3c);
	const s4b = useAppInteractionState(s4a);
	const s5 = useAppSectionSyncs(s4b);
	const s6 = useAppWorkQueueState(props, s5);
	const s7 = useAppDetailRefs(props, s6);
	const s7a = useAppFactoryRefs(props, s7);
	const s8 = useAppSeatFacts(props, s7a);
	const s9 = useAppSeatTickets(props, s8);
	const s9a = useAppFactReads(s9);
	const s10 = useAppTicketFacts(props, s9a);
	const s11 = useAppSourceFacts(props, s10);
	const s12 = useAppMessageState(s11);
	const s13 = useAppHeaderFacts(props, s12);
	const s14a = useAppCompactLayout(s13);
	const s14 = useAppLayoutFacts(s14a);
	const s15 = useAppSelectionFactsTicket(props, s14);
	const s16 = useAppSelectionFactsConsultation(s15);
	const s16b = useAppConsultationDetailFacts(props, s16);
	const s17 = useAppSelectionFactsQueue(s16b);
	const o1 = useAppWorkQueueSync(s17);
	const o2 = useAppSelectionCopy(o1);
	const o3 = useAppHeldBell(o2);
	const o4 = useAppTicketReplace(props, o3);
	const o5 = useAppConsultationReplace(props, o4);
	const o6 = useAppModelList(o5);
	const o7 = useAppOpsRefs(o6);
	const o8 = useAppCursorShell(o7);
	const o9 = useAppGroupOpsShell(props, o8);
	const o10 = useAppRepoInitShell(props, o9);
	const o11 = useAppOpsFields(props, o10);
	const o12 = useAppDispatches(o11);
	const o13 = useAppStanding(o12);
	const o14 = useAppBaseMode(o13);
	const o15 = useAppMainFacts(props, o14);
	const o16 = useAppHandoffCallbacks(o15);
	const o17 = useAppTicketOpsFields(o16);
	const o18 = useAppTicketOpsActions(o17);
	const o19 = useAppHandoffStartFields(o18);
	const o20 = useAppConsultationOpsFields(o19);
	return o20;
}

/** The plane's operation stages: the fields, the key handler, the reads, and the render. */
function useAppOpsStages(
	props: AppProps,
	prev: AppConsultationOpsFieldsStage,
): AppRenderModesStage {
	const o21 = useAppConsultationCrud(prev);
	const o22 = useAppConsultationResponse(o21);
	const o23 = useAppQueueOps(o22);
	const o24 = useAppWorkspaceGuides(o23);
	const o25 = useAppRefreshNow(o24);
	const o26 = useAppRangeDecision(o25);
	const o27 = useAppKeyHandlers(props, o26);
	const o28 = useAppSessionRefresh(props, o27);
	const o29a = useAppObservationFields(props, o28);
	const o29 = useAppObservation(o29a);
	const o30 = useAppInitBoot(props, o29);
	const o31 = useAppInitNote(props, o30);
	const o32 = useAppCatalog(o31);
	const o33 = useAppCoordinator(props, o32);
	const o34 = useAppOpenPanel(o33);
	const o35 = useAppPanelDecision(o34);
	const o36 = useAppPanelRelease(o35);
	const o37 = useAppLivePanel(o36);
	const o38 = useAppRenderMessages(props, o37);
	const o39 = useAppRenderLaunch(props, o38);
	const oFinal = useAppRenderModes(o39);
	return oFinal;
}

/**
 * The Main frame's body: the Ticket header, the left column's lists, and the detail pane (ADR 0019).
 */
function appMainBodyBox(o: AppRenderModesStage): React.ReactElement {
	const { bodyRows, leftCols } = o;
	return createElement(
		"box",
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
		appTicketHeader(o),
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
				appTicketsList(o),
				appConsultationHeader(o),
				appConsultationsList(o),
				appWorkHeader(o),
				appWorkList(o),
			),
			appDetailPane(o),
		),
	);
}

/** The size box the frame falls back to: the size note's lines, capped to the rows it holds. */
function appSizeBox(o: AppRenderModesStage): React.ReactElement {
	const { compactLines, compactPadding, compactRows, compactTextWidth } = o;
	return createElement(
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
	);
}

/** The Ticket header: the counts, the mode cell, and the queue pause's lamp (issue #319, ADR 0111). */
function appTicketHeader(o: AppRenderModesStage): React.ReactElement {
	const {
		autoHandoffCell,
		awaitingCount,
		clickSection,
		heldBell,
		heldCount,
		ignoredCount,
		mainSurfaceActive,
		mutedCount,
		openCount,
		queuePaused,
		runningCount,
		terminalWidth,
		ticketsExpanded,
	} = o;
	// The Ticket header owns the body's first row at the full
	// terminal width, so its counts and its mode cell stay whole
	// where the columns below split (ADR 0019).
	return createElement(SectionHeader, {
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
		// The Queue pause's corner lamp (issue #319, ADR 0111): the
		// standing brake reads beside the mode lamp at the corner
		// of the plane, from the same standing fact the key sets.
		queuePaused,
		active: mainSurfaceActive,
		onToggle: () => clickSection("tickets"),
	});
}

/** The Ticket list: the rows, the cursor's focus and moves, and the Group header's fold on a click (issue #159). */
function appTicketsList(o: AppRenderModesStage): React.ReactElement | false {
	const {
		cursor,
		emptyMessage,
		focusedPane,
		groupOps,
		mainSurfaceActive,
		selectedIndex,
		selection,
		ticketRowsRef,
		ticketRowsState,
		ticketsBoxRows,
		ticketsExpanded,
	} = o;
	return (
		ticketsExpanded &&
		createElement(TicketList, {
			rows: ticketRowsState,
			selectedIndex,
			focused: focusedPane === "list" && selection === "ticket",
			height: ticketsBoxRows,
			emptyMessage,
			active: mainSurfaceActive,
			onFocus: () => cursor.focusListSection("ticket"),
			onSelect: (index: number) => {
				cursor.focusListSection("ticket");
				// A left click on a Group header folds the Group
				// it names, the way a click on a section header
				// folds the section (issue #159, user story 33).
				const row = ticketRowsRef.current[index];
				if (row !== undefined && row.kind === "group") {
					groupOps.toggleGroupFold(row.group.value);
					return;
				}
				cursor.selectTicketRow(index);
			},
			onMove: (delta) => {
				// The first wheel spin into a section both moves the cursor
				// there and selects one adjacent row.
				cursor.focusListSection("ticket");
				cursor.moveList(delta);
			},
		})
	);
}

/** The Consultation header: the awaiting and recovery counts, the bell, and the new-output lamp. */
function appConsultationHeader(o: AppRenderModesStage): React.ReactElement {
	const {
		bell,
		clickSection,
		consultationsExpanded,
		headerFacts,
		leftCols,
		mainSurfaceActive,
		newOutput,
		terminalWidth,
	} = o;
	return createElement(SectionHeader, {
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
	});
}

/** The Consultation list: the rows, the cursor's focus and moves, and the empty message the filter names. */
function appConsultationsList(o: AppRenderModesStage): React.ReactElement | false {
	const {
		consultationIndex,
		consultationIndexRef,
		consultations,
		consultationsBoxRows,
		consultationsExpanded,
		cursor,
		focusedPane,
		historyFilter,
		mainSurfaceActive,
		selection,
		state,
	} = o;
	return (
		consultationsExpanded &&
		createElement(ConsultationList, {
			consultations,
			selectedIndex: consultationIndex,
			focused: focusedPane === "list" && selection === "consultation",
			rows: consultationsBoxRows,
			active: mainSurfaceActive,
			onFocus: () => cursor.focusListSection("consultation"),
			onSelect: (index: number) => {
				cursor.focusListSection("consultation");
				cursor.selectConsultation(index);
			},
			onMove: (delta) => {
				// The first wheel spin into a section both moves the cursor
				// there and selects one adjacent row.
				cursor.focusListSection("consultation");
				cursor.selectConsultation(consultationIndexRef.current + delta);
			},
			emptyMessage:
				state === undefined
					? "Consultations require SQLite state"
					: historyFilter === "closed"
						? "no closed Consultations"
						: historyFilter === "all"
							? "no Consultations"
							: "no open Consultations",
		})
	);
}

/** The Work header: the waiting count the queue's rows carry. */
function appWorkHeader(o: AppRenderModesStage): React.ReactElement {
	const { clickSection, headerFacts, leftCols, mainSurfaceActive, terminalWidth, workExpanded } = o;
	return createElement(SectionHeader, {
		section: "work",
		expanded: workExpanded,
		terminalWidth,
		width: leftCols,
		waiting: headerFacts.work.waiting,
		active: mainSurfaceActive,
		onToggle: () => clickSection("work"),
	});
}

/** The Work queue list: the rows, the cursor's focus and moves, and the empty message. */
function appWorkList(o: AppRenderModesStage): React.ReactElement | false {
	const {
		cursor,
		focusedPane,
		mainSurfaceActive,
		selection,
		workBoxRows,
		workExpanded,
		workQueueIndex,
		workQueueIndexRef,
		workQueueRows,
	} = o;
	return (
		workExpanded &&
		createElement(WorkQueueList, {
			rows: workQueueRows,
			selectedIndex: workQueueIndex,
			focused: focusedPane === "list" && selection === "queue",
			height: workBoxRows,
			active: mainSurfaceActive,
			onFocus: () => cursor.focusListSection("queue"),
			onSelect: (index: number) => {
				cursor.focusListSection("queue");
				cursor.selectWorkQueue(index);
			},
			onMove: (delta: number) => {
				cursor.focusListSection("queue");
				cursor.selectWorkQueue(workQueueIndexRef.current + delta);
			},
			emptyMessage: "no waiting starts",
		})
	);
}

/** The detail pane: the queue's lines, the Ticket's facts, or the Consultation's lines. */
function appDetailPane(o: AppRenderModesStage): React.ReactElement {
	const { selection } = o;
	return selection === "queue"
		? appQueueDetail(o)
		: selection === "ticket"
			? appTicketDetail(o)
			: appConsultationDetailPane(o);
}

/** The queue's detail: the item's lines in the shared detail pane. */
function appQueueDetail(o: AppRenderModesStage): React.ReactElement {
	const {
		cursor,
		detailGeometry,
		focusedPane,
		mainSurfaceActive,
		queueDetailLines,
		selection,
		workQueueDetailClampedScroll,
	} = o;
	return createElement(
		"box",
		{ style: { flexGrow: 1, flexDirection: "column" } },
		createElement(ConsultationDetail, {
			lines: queueDetailLines,
			visibleRows: Math.max(1, detailGeometry.visibleRows),
			scroll: workQueueDetailClampedScroll,
			focused: focusedPane === "detail" && selection === "queue",
			active: mainSurfaceActive,
			onFocus: () => cursor.focusPane("detail"),
			onWheel: (delta) => cursor.moveVertical(delta),
		}),
	);
}

/** The Ticket's detail: the facts, the merge attempt, and the suggested choice on an open ticket. */
function appTicketDetail(o: AppRenderModesStage): React.ReactElement {
	const {
		choiceFor,
		config,
		cursor,
		detailRef,
		detailReservedRows,
		detailScrollSlot,
		factsFor,
		focusedPane,
		mainSurfaceActive,
		selectedTicket,
		state,
	} = o;
	return createElement(TicketDetail, {
		ref: detailRef,
		fact: selectedTicket === undefined ? undefined : factsFor(selectedTicket),
		focused: focusedPane === "detail",
		active: mainSurfaceActive,
		reservedRows: detailReservedRows,
		handoffLimit: config.maxHandoffsPerTicket,
		suggestedChoice: selectedTicket?.state === "open" ? choiceFor(selectedTicket) : undefined,
		scroll: config.scroll,
		onFocus: () => cursor.focusPane("detail"),
		scrollSlot: detailScrollSlot,
		mergeAttempt:
			selectedTicket === undefined || state === undefined
				? null
				: state.planeAction.latestPlaneActionAttempt(selectedTicket.identity),
	});
}

/** The Consultation detail's pane: the lines, the body title, and the pane's focus and scroll. */
function appConsultationDetailElement(o: AppRenderModesStage): React.ReactElement {
	return createElement(ConsultationDetail, {
		lines: o.consultationLines,
		ansiLines: o.ansiLines,
		bodyTitle: consultationDetailTitle(o.consultationBody),
		visibleRows: Math.max(
			1,
			o.detailGeometry.visibleRows - (o.responseEditor ? RESPONSE_EDITOR_ROWS : 0),
		),
		scroll: o.consultationDetailScroll,
		focused: o.focusedPane === "detail" && !o.responseEditor,
		active: o.mainSurfaceActive,
		onFocus: () => o.cursor.focusPane("detail"),
		onWheel: (delta) => o.cursor.moveVertical(delta),
	});
}

/** The response editor while it stands: the draft, its writes, and the form's keys. */
function appConsultationResponseEditorElement(o: AppRenderModesStage): React.ReactElement | false {
	return (
		o.responseEditor &&
		createElement(ResponseEditor, {
			draft: o.responseDraft,
			width: o.consultationWidth,
			rows: RESPONSE_EDITOR_ROWS,
			focused: true,
			standing: o.standing,
			inputActive: o.utility === null,
			onSend: o.sendResponseText,
			onDiscard: o.discardResponseDraft,
			onDraftChange: o.storeResponseDraft,
			onClose: o.closeResponseEditor,
			onHelp: () => o.openGuide("form-field"),
			onMessage: () => o.openMessage("form-field"),
			onUnavailable: (reason: string) => o.setWarningMessage(reason),
			onCopy: o.reportMessage,
			message: o.visibleMessage,
			onEmergencyExit: () => o.renderer.destroy(),
			onQueuePause: o.toggleQueuePause,
			onAutoHandoff: o.toggleAutoHandoff,
		})
	);
}

/** The Consultation's detail: the pane, and the response editor while it stands. */
function appConsultationDetailPane(o: AppRenderModesStage): React.ReactElement {
	return createElement(
		"box",
		{ style: { flexGrow: 1, flexDirection: "column" } },
		appConsultationDetailElement(o),
		appConsultationResponseEditorElement(o),
	);
}

/** The Consultation launcher's form: its fields and its writes. */
function appLauncherProps(o: AppRenderModesStage) {
	return {
		types: o.config.consultationTypes,
		repositories: o.repositoryOptions,
		draft: o.launcherDraft,
		title:
			o.replacementConsultation === undefined
				? "Consultation launcher"
				: "Replacement Consultation",
		onLaunch: (typeName: string, repository: ConsultationRepositoryOption, text: string) => {
			// The form is with the Agent now, so nothing is left to keep.
			o.setLauncherForm(null);
			o.submitConsultation(typeName, repository, text);
		},
		onClose: (kept: LauncherDraft) => {
			o.setLauncherForm({ owner: o.launcherOwner, draft: kept });
			o.setLauncher(false);
			o.setReplacementConsultationId(null);
		},
		onDiscard: () => {
			o.setLauncherForm(null);
			o.setLauncher(false);
			o.setReplacementConsultationId(null);
		},
		standing: o.standing,
		inputActive: o.utility === null,
		onHelp: (mode: InteractionMode) => o.openGuide(mode),
		onMessage: (mode: InteractionMode) => o.openMessage(mode),
		onUnavailable: o.setWarningMessage,
		onCopy: o.reportMessage,
		message: o.visibleMessage,
		onEmergencyExit: () => o.renderer.destroy(),
		onQueuePause: o.toggleQueuePause,
		onAutoHandoff: o.toggleAutoHandoff,
	};
}

/** The Consultation launcher: the form, the Replacement context, and its writes. */
function appLauncher(o: AppRenderModesStage): React.ReactElement | false {
	const { launcher } = o;
	return launcher ? createElement(ConsultationLauncher, appLauncherProps(o)) : false;
}

/** The Message line: the visible message, drawn when the frame has a row for it. */
function appMessageRow(o: AppRenderModesStage): React.ReactElement | false {
	const { terminalHeight, terminalWidth, visibleMessage } = o;
	return terminalHeight >= 2 && messageRowElement(visibleMessage, terminalWidth);
}

/** The Action bar: the mode's keys, its facts, and the compact anchor. */
function appActionBar(o: AppRenderModesStage): React.ReactElement {
	const { actionMode, mainBarFacts, terminalWidth, tooSmall } = o;
	return createElement(ActionBar, {
		mode: actionMode,
		facts: mainBarFacts,
		width: terminalWidth,
		compactAnchor: tooSmall,
	});
}

/** The Override panel: the agents, the task types, and the Model list the operator picks. */
function appOverridePanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		cancelOverride,
		config,
		confirmOverride,
		modelList,
		openGuide,
		openMessage,
		override,
		profiles,
		renderer,
		reportMessage,
		requestModelList,
		setWarningMessage,
		standing,
		taskPlacementsFor,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		visibleMessage,
	} = o;
	return (
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
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The decision modal on a settled turn: the decision's rows and its actions. */
function appDecisionModal(o: AppRenderModesStage): React.ReactElement | false {
	const {
		decision,
		openGuide,
		openMessage,
		openRouteOverride,
		panel,
		panelTicket,
		renderer,
		runDecisionAction,
		setPanel,
		setWarningMessage,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		visibleMessage,
	} = o;
	// Each ticket panel kind renders its own modal: a decision is neither a
	// live view nor a missing-agent choice, and must not fall through to one.
	return (
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
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Live view's stream: the title, the body, and the pane's state. */
function appLiveViewProps(o: AppRenderModesStage, panelTicket: Ticket) {
	return {
		title: panelTicket.title,
		contextLine: liveContextLine(panelTicket, o.configRef.current.defaultTaskType),
		blocked: o.factsFor(panelTicket).failure === "blocked",
		body:
			o.liveDecision !== undefined
				? { kind: "turn-log" as const, entries: o.liveDecision.entries }
				: o.liveStream === null
					? { kind: "stream" as const, lines: [], note: null }
					: { kind: "stream" as const, lines: o.liveStream.lines, note: o.liveStream.note },
		cause: o.liveDecision?.cause ?? null,
		detail: o.liveDecision?.detail ?? "",
		actions: o.liveDecision?.actions ?? [],
		onAction: (key: string) => o.runDecisionAction(panelTicket, key),
		onEditAction: (key: string) => o.openRouteOverride(panelTicket, key),
		// The streaming sub-mode's Goto: the decision's own Goto row's
		// behavior, so the two paths cannot drift.
		onGoto: () => o.runDecisionAction(panelTicket, "goto"),
		onCancel: () => o.setPanel(null),
		// The view's own Ticket is the Goto's pane fact, whatever the
		// list below points at.
		standing: o.standing,
		ticket: panelTicket,
		paneAlive:
			panelTicket.handoff?.paneId !== null &&
			o.agents?.some((agent) => agent.paneId === panelTicket.handoff?.paneId) === true,
		paneForeign:
			panelTicket.handoff?.paneId !== null &&
			o.agents?.some(
				(agent) =>
					agent.paneId === panelTicket.handoff?.paneId &&
					ticketAgentIdentity(panelTicket, agent) === "foreign",
			) === true,
		inputActive: o.utility === null,
		onHelp: () => o.openGuide(o.liveMode === "decision" ? "decision-modal" : "live-view"),
		onMessage: () => o.openMessage(o.liveMode === "decision" ? "decision-modal" : "live-view"),
		onUnavailable: o.setWarningMessage,
		message: o.visibleMessage,
		onEmergencyExit: () => o.renderer.destroy(),
		onQueuePause: o.toggleQueuePause,
		onAutoHandoff: o.toggleAutoHandoff,
	};
}

/** The Live view: the stream, the decision sub-mode, and the pane's state. */
function appLiveView(o: AppRenderModesStage): React.ReactElement | false {
	// The Live view streams the agent's terminal while the ticket is in
	// flight. When the turn settles and the factory waits for the
	// operator, the same box carries the decision sub-mode: the turn
	// log in the pane, the decision's rows in the region, and their keys,
	// the border re-titled by the shared chrome.
	const { panel, panelTicket, liveMode } = o;
	return panel !== null &&
		panel.kind === "live" &&
		panelTicket !== undefined &&
		liveMode !== "closed" &&
		liveMode !== "missing"
		? createElement(LiveView, appLiveViewProps(o, panelTicket))
		: false;
}

/** The missing-agent choice: the pane is gone, and the restart or abandon. */
function appMissingModal(o: AppRenderModesStage): React.ReactElement | false {
	const {
		config,
		liveMode,
		openGuide,
		openMessage,
		panel,
		panelTicket,
		renderer,
		runMissingAction,
		setPanel,
		setWarningMessage,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		visibleMessage,
	} = o;
	return (
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
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The repository init's confirm: the plan's rows and the instruction file's choice (ADR 0075). */
function appRepoInitPanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		openGuide,
		openMessage,
		panel,
		renderer,
		repoInit,
		setErrorMessage,
		setPanel,
		setWarningMessage,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		visibleMessage,
	} = o;
	return (
		panel !== null &&
		panel.kind === "repository-init" &&
		createElement(ActionPanel, {
			message: visibleMessage,
			...repositoryInitPanel(panel.plan),
			onAction: (key) => {
				setPanel(null);
				if (key === "init")
					void repoInit
						.runRepositoryInitConfirm(panel.repository, panel.plan)
						.catch((error) => setErrorMessage(errorMessage(error)));
				// The repository owes the choice of which instruction file to create
				// (ADR 0075, story 12): the pick is the file the act stands the block in.
				else if (key === "init-claude")
					void repoInit
						.runRepositoryInitConfirm(panel.repository, panel.plan, "CLAUDE.md")
						.catch((error) => setErrorMessage(errorMessage(error)));
				else if (key === "init-agents")
					void repoInit
						.runRepositoryInitConfirm(panel.repository, panel.plan, "AGENTS.md")
						.catch((error) => setErrorMessage(errorMessage(error)));
				// The cancel of a queued entry skips it and moves on (ADR 0083).
				else repoInit.skipRepositoryInitEntry();
			},
			onCancel: () => repoInit.skipRepositoryInitEntry(),
			standing,
			inputActive: utility === null,
			onHelp: () => openGuide("action-panel"),
			onMessage: () => openMessage("action-panel"),
			onUnavailable: setWarningMessage,
			onEmergencyExit: () => renderer.destroy(),
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The repository select: the fetchable repositories and the queued start. */
function appRepoSelectPanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		fetchInitableRepositories,
		openGuide,
		openMessage,
		panel,
		renderer,
		repoInit,
		setPanel,
		setWarningMessage,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		visibleMessage,
	} = o;
	return (
		panel !== null &&
		panel.kind === "repository-select" &&
		createElement(RepositorySelectPanel, {
			fetchRepositories: fetchInitableRepositories,
			onSelect: (queue) => {
				setPanel(null);
				repoInit.startRepositoryInitQueue(queue);
			},
			onCancel: () => setPanel(null),
			standing,
			inputActive: utility === null,
			onHelp: () => openGuide("repository-select"),
			onMessage: () => openMessage("repository-select"),
			onUnavailable: setWarningMessage,
			message: visibleMessage,
			onEmergencyExit: () => renderer.destroy(),
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Ticket close's confirm: the cycle's state and the close's act. */
function appTicketClosePanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		factsFor,
		openGuide,
		openMessage,
		panel,
		panelTicket,
		renderer,
		runTicketClose,
		setPanel,
		setWarningMessage,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		visibleMessage,
	} = o;
	return (
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
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Consultation safety's confirm: the live checkout's conflicts (ADR 0103). */
function appConsultationSafetyPanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		consultationOperations,
		consultationSafety,
		panel,
		panelConsultation,
		setConsultationSafety,
		setPanel,
		setWarningMessage,
		standing,
		state,
		toggleAutoHandoff,
		toggleQueuePause,
		visibleMessage,
	} = o;
	return (
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
				setWarningMessage("Consultation launch cancelled; recover or close it explicitly");
			},
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Consultation recovery: the record's state names its rows. */
function appConsultationRecoveryPanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		openReplacementLauncher,
		panel,
		panelConsultation,
		recoverConsultationOpening,
		recoveryPanel,
		runConsultationClose,
		setPanel,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		visibleMessage,
	} = o;
	// One panel element for the Consultation recovery: the record's state
	// names its rows through consultationRecoveryPanel, the retry of an
	// interrupted opening and the replacement of a record with no Agent.
	// A `closing` record never reaches this element: its Enter opens the
	// close panel below, which already carries its recovery rows.
	return (
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
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Consultation close: the record's state names its rows. */
function appConsultationClosePanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		closeConsultation,
		closePanel,
		panel,
		panelConsultation,
		setPanel,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		visibleMessage,
	} = o;
	// One panel element for the Consultation close: the record's state
	// selects the shape through consultationClosePanel, the recovery rows
	// while the record is closing and the confirmation rows while a close
	// would stop a live Agent. A state with no shape never reaches the
	// render: the guard above already dropped the panel.
	return (
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
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Consultation force-close: the owned resources that would remain. */
function appConsultationForcePanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		forceCloseConsultation,
		panel,
		panelConsultation,
		setPanel,
		standing,
		state,
		toggleAutoHandoff,
		toggleQueuePause,
		visibleMessage,
	} = o;
	return (
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
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Consultation delete's confirm: the record's id and the delete's act. */
function appConsultationDeletePanel(o: AppRenderModesStage): React.ReactElement | false {
	const {
		deleteConsultation,
		panel,
		panelConsultation,
		setPanel,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		visibleMessage,
	} = o;
	return (
		panel !== null &&
		panelConsultation !== undefined &&
		panel.kind === "consultation-delete" &&
		createElement(ActionPanel, {
			message: visibleMessage,
			standing,
			...consultationDeletePanel(panelConsultation.id),
			onAction: (key) => {
				setPanel(null);
				if (key === "delete") deleteConsultation(panelConsultation);
			},
			onCancel: () => setPanel(null),
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Key guide: the mode's facts and the Message line. */
function appUtilityGuide(o: AppRenderModesStage): React.ReactElement | false {
	const {
		openMessage,
		renderer,
		setUtility,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		utilityFacts,
		visibleMessage,
	} = o;
	return (
		utility?.kind === "guide" &&
		createElement(KeyGuide, {
			message: visibleMessage,
			facts: utilityFacts,
			onClose: () => setUtility(null),
			onMessage: () => openMessage(utilityFacts.mode),
			onEmergencyExit: () => renderer.destroy(),
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/** The Message view: the history and the standing facts. */
function appUtilityMessage(o: AppRenderModesStage): React.ReactElement | false {
	const {
		messageHistory,
		openGuide,
		renderer,
		setUtility,
		standing,
		toggleAutoHandoff,
		toggleQueuePause,
		utility,
		utilityFacts,
		visibleMessage,
	} = o;
	return (
		utility?.kind === "message" &&
		createElement(MessageView, {
			message: visibleMessage,
			history: messageHistory,
			facts: standing,
			onClose: () => setUtility(null),
			onHelp: () => openGuide(utilityFacts.mode),
			onEmergencyExit: () => renderer.destroy(),
			onQueuePause: toggleQueuePause,
			onAutoHandoff: toggleAutoHandoff,
		})
	);
}

/**
 * The plane's one root element: the Main frame, the two bottom rows, and the surfaces that stand over them.
 */
function appElement(o: AppRenderModesStage): React.ReactElement {
	const { tooSmall, terminalHeight } = o;
	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "column" } },
		// One Main frame: the body and the two permanent bottom rows. The body's
		// left column stacks the two sections - each header row, and its list box
		// while the section is expanded - and its right column holds the one
		// detail pane for the selected item (ADR 0019).
		tooSmall ? appSizeBox(o) : appMainBodyBox(o),
		appLauncher(o),
		terminalHeight >= 2 && appMessageRow(o),
		appActionBar(o),
		appOverridePanel(o),
		appDecisionModal(o),
		appLiveView(o),
		appMissingModal(o),
		appRepoInitPanel(o),
		appRepoSelectPanel(o),
		appTicketClosePanel(o),
		appConsultationSafetyPanel(o),
		appConsultationRecoveryPanel(o),
		appConsultationClosePanel(o),
		appConsultationForcePanel(o),
		appConsultationDeletePanel(o),
		appUtilityGuide(o),
		appUtilityMessage(o),
	);
}

export function App(props: AppProps) {
	return appElement(useAppOpsStages(props, useAppBaseStages(props)));
}

/** The fields the unified cursor's moves read and write. */
interface AppCursorFields {
	focusedPaneRef: RefObject<Pane>;
	setFocusedPane: (pane: Pane) => void;
	selectionRef: RefObject<"ticket" | "consultation" | "queue">;
	setSelection: (selection: "ticket" | "consultation" | "queue") => void;
	ticketRowsRef: RefObject<readonly ListedRow<TicketRowFacts>[]>;
	selectedIndexRef: RefObject<number>;
	setSelectedIndex: (index: number) => void;
	workQueueRef: RefObject<readonly WorkQueueItem[]>;
	workQueueIndexRef: RefObject<number>;
	setWorkQueueIndex: (index: number) => void;
	workQueueDetailScrollRef: RefObject<number>;
	setWorkQueueDetailScroll: Dispatch<SetStateAction<number>>;
	workQueueDetailMaxScroll: number;
	consultationsRef: RefObject<Consultation[]>;
	consultationIndexRef: RefObject<number>;
	setConsultationIndex: (index: number) => void;
	setConsultationScroll: Dispatch<SetStateAction<number>>;
	consultationFollowRef: RefObject<boolean>;
	setNewOutput: (value: boolean) => void;
	consultationMaxScroll: number;
	detailGeometry: ReturnType<typeof usePaneGeometry>;
	detailRef: RefObject<TicketDetailHandle | null>;
	configRef: RefObject<FactoryConfig>;
	ticketsExpandedRef: RefObject<boolean>;
	setTicketsExpanded: (value: boolean) => void;
	workExpandedRef: RefObject<boolean>;
	setWorkExpanded: (value: boolean) => void;
	consultationsExpandedRef: RefObject<boolean>;
	setConsultationsExpanded: (value: boolean) => void;
	ticketsContentRows: number;
	consultationsContentRows: number;
	workContentRows: number;
}

/** Move the focus to one pane: the list, or the shared detail. */
function cursorFocusPane(fields: AppCursorFields, pane: Pane): void {
	fields.focusedPaneRef.current = pane;
	fields.setFocusedPane(pane);
}

/**
 * Move the unified cursor to one section's list: put it on that section's
 * retained row and focus the list pane. Row clicks, box focus, and list
 * wheels pass through it, so a click in one section never leaves the
 * cursor on a row the operator is not looking at.
 */
function cursorFocusListSection(
	fields: AppCursorFields,
	next: "ticket" | "consultation" | "queue",
): void {
	if (fields.selectionRef.current !== next) {
		fields.selectionRef.current = next;
		fields.setSelection(next);
	}
	cursorFocusPane(fields, "list");
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
function cursorSelectTicketRow(fields: AppCursorFields, index: number): void {
	const rows = fields.ticketRowsRef.current;
	const next = settleRowIndex(rows, clamp(index, 0, Math.max(0, rows.length - 1)));
	if (next === fields.selectedIndexRef.current) return;
	fields.selectedIndexRef.current = next;
	fields.setSelectedIndex(next);
}

function cursorMoveList(fields: AppCursorFields, delta: number): void {
	// One step moves the cursor to the next row that holds something: the
	// blank row between two Groups is crossed over, never rested on.
	cursorSelectTicketRow(
		fields,
		stepRowIndex(fields.ticketRowsRef.current, fields.selectedIndexRef.current, delta),
	);
}

function cursorSelectWorkQueue(fields: AppCursorFields, index: number): void {
	const next = clamp(index, 0, Math.max(0, fields.workQueueRef.current.length - 1));
	if (next === fields.workQueueIndexRef.current) return;
	fields.workQueueIndexRef.current = next;
	fields.setWorkQueueIndex(next);
	fields.workQueueDetailScrollRef.current = 0;
	fields.setWorkQueueDetailScroll(0);
}

function cursorSelectConsultation(fields: AppCursorFields, index: number): void {
	const next = clamp(index, 0, Math.max(0, fields.consultationsRef.current.length - 1));
	if (next === fields.consultationIndexRef.current) return;
	fields.consultationIndexRef.current = next;
	fields.setConsultationIndex(next);
	fields.setConsultationScroll(0);
	fields.consultationFollowRef.current = true;
	fields.setNewOutput(false);
}

/** Move the Consultation detail by whole pages, keeping the follow rule. */
function cursorMoveConsultationDetailPage(fields: AppCursorFields, direction: 1 | -1): void {
	const page = Math.max(1, fields.detailGeometry.visibleRows - 2);
	fields.consultationFollowRef.current = false;
	fields.setConsultationScroll((current) =>
		clamp(current + direction * page, 0, fields.consultationMaxScroll),
	);
}

/**
 * Flip one section's expanded pair - the ref and the state - and return
 * the flag after the flip. The cursor's `x` and a header click both
 * toggle through it, so one flip keeps one shape.
 */
function cursorFlipSectionExpanded(fields: AppCursorFields, section: MainSection): boolean {
	if (section === "tickets") {
		fields.ticketsExpandedRef.current = !fields.ticketsExpandedRef.current;
		fields.setTicketsExpanded(fields.ticketsExpandedRef.current);
		return fields.ticketsExpandedRef.current;
	}
	if (section === "work") {
		fields.workExpandedRef.current = !fields.workExpandedRef.current;
		fields.setWorkExpanded(fields.workExpandedRef.current);
		return fields.workExpandedRef.current;
	}
	fields.consultationsExpandedRef.current = !fields.consultationsExpandedRef.current;
	fields.setConsultationsExpanded(fields.consultationsExpandedRef.current);
	return fields.consultationsExpandedRef.current;
}

function cursorToggleSection(fields: AppCursorFields): void {
	cursorFlipSectionExpanded(
		fields,
		fields.selectionRef.current === "ticket"
			? "tickets"
			: fields.selectionRef.current === "consultation"
				? "consultations"
				: "work",
	);
}

/** The cross up from the Work queue: the last Consultation, or the last Ticket. */
function cursorCrossUpFromQueue(fields: AppCursorFields): void {
	if (fields.consultationsExpandedRef.current) {
		fields.selectionRef.current = "consultation";
		fields.setSelection("consultation");
		cursorSelectConsultation(fields, Math.max(0, fields.consultationsRef.current.length - 1));
	} else if (fields.ticketsExpandedRef.current) {
		fields.selectionRef.current = "ticket";
		fields.setSelection("ticket");
		cursorSelectTicketRow(fields, Math.max(0, fields.ticketRowsRef.current.length - 1));
	}
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
/** The Work queue branch of the unified step: its detail scroll, its rows, its crosses. */
function cursorMoveVerticalQueue(fields: AppCursorFields, delta: number): void {
	if (fields.focusedPaneRef.current === "detail") {
		fields.setWorkQueueDetailScroll((current) =>
			clamp(current + delta, 0, fields.workQueueDetailMaxScroll),
		);
		return;
	}
	if (fields.workExpandedRef.current) {
		if (delta < 0 && fields.workQueueIndexRef.current === 0) {
			// The cross reaches even an empty Consultation list: its
			// empty message is the row the cursor takes, and it crosses
			// into the Ticket list when the Consultation section is
			// collapsed.
			cursorCrossUpFromQueue(fields);
			return;
		}
		cursorSelectWorkQueue(fields, fields.workQueueIndexRef.current + delta);
		return;
	}
	// The Work section is collapsed: the cursor rests on its boundary,
	// and the only visible step is up to the last Consultation, or to
	// the last Ticket when that section is collapsed as well.
	if (delta < 0) cursorCrossUpFromQueue(fields);
}

/** The Consultation branch of the unified step: its detail scroll, its rows, its crosses. */
function cursorMoveVerticalConsultation(fields: AppCursorFields, delta: number): void {
	if (fields.focusedPaneRef.current === "detail") {
		fields.consultationFollowRef.current = false;
		fields.setConsultationScroll((current) =>
			clamp(current + delta, 0, fields.consultationMaxScroll),
		);
		return;
	}
	if (fields.consultationsExpandedRef.current) {
		if (delta < 0 && fields.consultationIndexRef.current === 0) {
			// The cross reaches even an empty Ticket list: its empty
			// message is the row the cursor takes.
			if (fields.ticketsExpandedRef.current) {
				fields.selectionRef.current = "ticket";
				fields.setSelection("ticket");
				cursorSelectTicketRow(fields, Math.max(0, fields.ticketRowsRef.current.length - 1));
			}
			return;
		}
		if (
			delta > 0 &&
			fields.consultationIndexRef.current >= fields.consultationsRef.current.length - 1 &&
			fields.workExpandedRef.current
		) {
			// The Work queue is the last section of the visible flow,
			// so down from the last Consultation crosses into it (ADR 0034).
			fields.selectionRef.current = "queue";
			fields.setSelection("queue");
			cursorSelectWorkQueue(fields, 0);
			return;
		}
		cursorSelectConsultation(fields, fields.consultationIndexRef.current + delta);
		return;
	}
	// The Consultation section is collapsed: the cursor rests on its
	// boundary, and the only visible step is up to the last Ticket.
	if (delta < 0 && fields.ticketsExpandedRef.current) {
		fields.selectionRef.current = "ticket";
		fields.setSelection("ticket");
		cursorSelectTicketRow(fields, Math.max(0, fields.ticketRowsRef.current.length - 1));
	}
}

/** The Ticket branch of the unified step: the detail, the rows, the crosses down. */
function cursorMoveVerticalTicket(fields: AppCursorFields, delta: number): void {
	if (fields.focusedPaneRef.current === "detail") {
		fields.detailRef.current?.moveBy(delta * fields.configRef.current.scroll.speed);
		return;
	}
	if (fields.ticketsExpandedRef.current) {
		if (delta > 0 && fields.selectedIndexRef.current >= fields.ticketRowsRef.current.length - 1) {
			// The cross reaches even an empty Consultation list: its empty
			// message is the row the cursor takes, and the history filter
			// still operates from there. It crosses into the Work queue when
			// the Consultation section is collapsed (ADR 0034).
			if (fields.consultationsExpandedRef.current) {
				fields.selectionRef.current = "consultation";
				fields.setSelection("consultation");
				cursorSelectConsultation(fields, 0);
			} else if (fields.workExpandedRef.current) {
				fields.selectionRef.current = "queue";
				fields.setSelection("queue");
				cursorSelectWorkQueue(fields, 0);
			}
			return;
		}
		cursorMoveList(fields, delta);
		return;
	}
	// The Ticket section is collapsed: the cursor rests on its boundary, and
	// the only visible step is down to the first Consultation.
	if (delta > 0 && fields.consultationsExpandedRef.current) {
		fields.selectionRef.current = "consultation";
		fields.setSelection("consultation");
		cursorSelectConsultation(fields, 0);
	}
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
function cursorMoveVertical(fields: AppCursorFields, delta: number): void {
	if (fields.selectionRef.current === "queue") {
		cursorMoveVerticalQueue(fields, delta);
		return;
	}
	if (fields.selectionRef.current === "consultation") {
		cursorMoveVerticalConsultation(fields, delta);
		return;
	}
	cursorMoveVerticalTicket(fields, delta);
}

function cursorMovePage(fields: AppCursorFields, direction: 1 | -1): void {
	if (fields.selectionRef.current === "queue") {
		if (fields.focusedPaneRef.current === "detail")
			fields.setWorkQueueDetailScroll((current) =>
				clamp(
					current + direction * Math.max(1, fields.detailGeometry.visibleRows - 2),
					0,
					fields.workQueueDetailMaxScroll,
				),
			);
		else
			cursorSelectWorkQueue(
				fields,
				fields.workQueueIndexRef.current + direction * fields.workContentRows,
			);
		return;
	}
	if (fields.selectionRef.current === "consultation") {
		if (fields.focusedPaneRef.current === "detail")
			cursorMoveConsultationDetailPage(fields, direction);
		else
			cursorSelectConsultation(
				fields,
				fields.consultationIndexRef.current + direction * fields.consultationsContentRows,
			);
		return;
	}
	if (fields.focusedPaneRef.current === "detail")
		fields.detailRef.current?.movePage(direction === 1 ? "down" : "up");
	else cursorMoveList(fields, direction * fields.ticketsContentRows);
}

function cursorMoveEdge(fields: AppCursorFields, edge: "start" | "end"): void {
	if (fields.selectionRef.current === "queue") {
		queueEdgeMove(fields, edge);
		return;
	}
	if (fields.selectionRef.current === "consultation") {
		consultationEdgeMove(fields, edge);
		return;
	}
	ticketEdgeMove(fields, edge);
}

/** The one edge one queue section's selection moves to. */
function queueEdgeMove(fields: AppCursorFields, edge: "start" | "end"): void {
	if (fields.focusedPaneRef.current === "detail")
		fields.setWorkQueueDetailScroll(edge === "start" ? 0 : fields.workQueueDetailMaxScroll);
	else if (fields.workExpandedRef.current)
		cursorSelectWorkQueue(fields, edge === "start" ? 0 : fields.workQueueRef.current.length - 1);
}

/** The one edge one consultation section's selection moves to. */
function consultationEdgeMove(fields: AppCursorFields, edge: "start" | "end"): void {
	if (fields.focusedPaneRef.current === "detail") {
		fields.consultationFollowRef.current = edge === "end";
		fields.setConsultationScroll(edge === "start" ? 0 : 999999);
		if (edge === "end") fields.setNewOutput(false);
	} else if (fields.consultationsExpandedRef.current)
		cursorSelectConsultation(
			fields,
			edge === "start" ? 0 : fields.consultationsRef.current.length - 1,
		);
}

/** The one edge one ticket section's selection moves to. */
function ticketEdgeMove(fields: AppCursorFields, edge: "start" | "end"): void {
	if (fields.focusedPaneRef.current === "detail") {
		if (edge === "start") fields.detailRef.current?.toStart();
		else fields.detailRef.current?.toEnd();
	} else if (fields.ticketsExpandedRef.current)
		cursorSelectTicketRow(fields, edge === "start" ? 0 : fields.ticketRowsRef.current.length - 1);
}

/** The unified cursor's moves: the section focus, the rows, the pages, the edges. */
function useAppCursor(fields: AppCursorFields) {
	const focusPane = useCallback((pane: Pane) => cursorFocusPane(fields, pane), [fields]);
	const focusListSection = useCallback(
		(next: "ticket" | "consultation" | "queue") => cursorFocusListSection(fields, next),
		[fields],
	);
	const selectTicketRow = useCallback(
		(index: number) => cursorSelectTicketRow(fields, index),
		[fields],
	);
	const moveList = useCallback((delta: number) => cursorMoveList(fields, delta), [fields]);
	const selectWorkQueue = useCallback(
		(index: number) => cursorSelectWorkQueue(fields, index),
		[fields],
	);
	const selectConsultation = useCallback(
		(index: number) => cursorSelectConsultation(fields, index),
		[fields],
	);
	const moveConsultationDetailPage = useCallback(
		(direction: 1 | -1) => cursorMoveConsultationDetailPage(fields, direction),
		[fields],
	);
	const flipSectionExpanded = useCallback(
		(section: MainSection) => cursorFlipSectionExpanded(fields, section),
		[fields],
	);
	const toggleSection = useCallback(() => cursorToggleSection(fields), [fields]);
	const moveVertical = useCallback((delta: number) => cursorMoveVertical(fields, delta), [fields]);
	const movePage = useCallback((direction: 1 | -1) => cursorMovePage(fields, direction), [fields]);
	const moveEdge = useCallback((edge: "start" | "end") => cursorMoveEdge(fields, edge), [fields]);
	return {
		focusPane,
		focusListSection,
		selectTicketRow,
		moveList,
		selectWorkQueue,
		selectConsultation,
		moveConsultationDetailPage,
		flipSectionExpanded,
		toggleSection,
		moveVertical,
		movePage,
		moveEdge,
	};
}

/** The fields the Group operations read and write. */
interface AppGroupOpsFields {
	state: AppAggregates | undefined;
	groupingAxisRef: RefObject<GroupingAxis>;
	setGroupingAxis: (axis: GroupingAxis) => void;
	groupOrderListRef: RefObject<string[]>;
	setGroupOrderList: (order: string[]) => void;
	groupFoldsRef: RefObject<GroupFolds>;
	setGroupFolds: (folds: GroupFolds) => void;
	groupOrdersForRunRef: RefObject<Partial<Record<SplitGroupingAxis, string[]>>>;
	positionOrderOf: () => string[];
	factRows: (tickets: readonly Ticket[]) => readonly TicketRowFacts[];
	ticketsRef: RefObject<readonly Ticket[]>;
	ticketRowsRef: RefObject<readonly ListedRow<TicketRowFacts>[]>;
	selectedIndexRef: RefObject<number>;
	setSelectedIndex: (index: number) => void;
	storedGroupOrderOf: (axis: SplitGroupingAxis) => string[];
	setErrorMessage: (message: string) => void;
	setNoticeMessage: (message: string, severity?: "info" | "warning") => void;
	setWarningMessage: (message: string) => void;
}

/** Write the Group order to the state file, and its failure's words. */
function saveGroupOrder(
	state: AppAggregates,
	axis: SplitGroupingAxis,
	moved: readonly string[],
): string | undefined {
	try {
		state.grouping.setGroupOrder(TICKET_GROUP_SECTION, axis, moved);
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
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
function groupCycleAxis(fields: AppGroupOpsFields): void {
	const { setGroupingAxis } = fields;
	const next = nextGroupingAxis(fields.groupingAxisRef.current);
	const writeFailure =
		fields.state === undefined ? undefined : saveGroupingAxis(fields.state, next);
	const anchor = rowAnchorOf(fields.ticketRowsRef.current, fields.selectedIndexRef.current);
	const nextOrder = next === "none" ? [] : fields.storedGroupOrderOf(next);
	const nextFacts = fields.factRows(fields.ticketsRef.current);
	const nextRows = ticketRows(nextFacts, next, {
		folds: fields.groupFoldsRef.current,
		storedOrder: nextOrder,
		positionOrder: fields.positionOrderOf(),
	});
	const nextIndex = ticketRowIndexForAnchor(nextRows, anchor, fields.selectedIndexRef.current, {
		facts: nextFacts,
		axis: next,
	});
	fields.groupingAxisRef.current = next;
	setGroupingAxis(next);
	fields.groupOrderListRef.current = nextOrder;
	fields.setGroupOrderList(nextOrder);
	fields.ticketRowsRef.current = nextRows;
	fields.selectedIndexRef.current = nextIndex;
	fields.setSelectedIndex(nextIndex);
	if (writeFailure !== undefined)
		fields.setErrorMessage(`the grouping axis did not save: ${writeFailure}`);
	else fields.setNoticeMessage(groupingAxisNotice(next), "info");
}

/** Write the grouping axis to the state file, and its failure's words. */
function saveGroupingAxis(state: AppAggregates, next: GroupingAxis): string | undefined {
	try {
		state.grouping.setGroupingAxis(TICKET_GROUP_SECTION, next);
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}

/**
 * Fold or open one Group (issue #159).
 *
 * The fold is the only thing that moves: no count, mode cell, gate, or queue
 * fact reads the row list, so a fold changes what is shown and nothing else
 * (ADR 0059). The cursor lands on the Group header the fold was made at, so
 * the fold is reversible by hand without hunting for it (user story 34).
 */
function groupToggleFold(fields: AppGroupOpsFields, value: string): void {
	const axis = fields.groupingAxisRef.current;
	const nextFolds = toggleFold(fields.groupFoldsRef.current, axis, value);
	const anchor = rowAnchorOf(fields.ticketRowsRef.current, fields.selectedIndexRef.current);
	const nextFacts = fields.factRows(fields.ticketsRef.current);
	const nextRows = ticketRows(nextFacts, axis, {
		folds: nextFolds,
		storedOrder: fields.groupOrderListRef.current,
		positionOrder: fields.positionOrderOf(),
	});
	const headerIndex = nextRows.findIndex(
		(row) => row.kind === "group" && row.group.value === value,
	);
	const nextIndex =
		headerIndex >= 0
			? headerIndex
			: ticketRowIndexForAnchor(nextRows, anchor, fields.selectedIndexRef.current, {
					facts: nextFacts,
					axis,
				});
	fields.groupFoldsRef.current = nextFolds;
	fields.setGroupFolds(nextFolds);
	fields.ticketRowsRef.current = nextRows;
	fields.selectedIndexRef.current = nextIndex;
	fields.setSelectedIndex(nextIndex);
}

/**
 * Fold or open the Group under the cursor, the `Space` route (issue #170).
 * A press anywhere else answers the catalogue's refusal: the catalogue
 * resolved the key to this route on the facts under the cursor.
 */
function groupFoldAtCursor(fields: AppGroupOpsFields): void {
	const row = fields.ticketRowsRef.current[fields.selectedIndexRef.current];
	if (row === undefined || row.kind !== "group") return;
	groupToggleFold(fields, row.group.value);
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
function groupMoveAtCursor(fields: AppGroupOpsFields, direction: "up" | "down"): void {
	const axis = fields.groupingAxisRef.current;
	if (axis === "none") return;
	const rows = fields.ticketRowsRef.current;
	const row = rows[fields.selectedIndexRef.current];
	if (row === undefined || row.kind !== "group") return;
	const value = row.group.value;
	// The neighbor is the next visible Group header in the direction, the
	// way the cursor itself crosses the blank rows between the Groups.
	const step = direction === "up" ? -1 : 1;
	const cursor = neighborGroupCursor(rows, fields.selectedIndexRef.current, step, value);
	const neighborRow = cursor >= 0 && cursor < rows.length ? rows[cursor] : undefined;
	if (neighborRow === undefined || neighborRow.kind !== "group") {
		fields.setWarningMessage(
			direction === "up" ? "the group is first in the list" : "the group is last in the list",
		);
		return;
	}
	const present = rows
		.filter((r) => r.kind === "group")
		.map((r) => (r.kind === "group" ? r.group.value : ""));
	const compare = ticketGroupCompare(axis, fields.positionOrderOf());
	const moved = movedGroupOrder(fields.groupOrderListRef.current, present, compare, {
		value,
		neighbor: neighborRow.group.value,
	});
	if (moved === null) return;
	groupMoveWrites(fields, axis, value, moved);
}

/** The row cursor the next visible Group header in the direction stands at. */
function neighborGroupCursor(
	rows: readonly ListedRow<TicketRowFacts>[],
	index: number,
	step: number,
	value: string,
): number {
	let cursor = index + step;
	while (cursor >= 0 && cursor < rows.length) {
		const candidate = rows[cursor];
		if (candidate !== undefined && candidate.kind === "group" && candidate.group.value !== value)
			break;
		cursor += step;
	}
	return cursor;
}

/** The state and view writes one group move lands, and the save failure it names. */
function groupMoveWrites(
	fields: AppGroupOpsFields,
	axis: SplitGroupingAxis,
	value: string,
	moved: readonly string[],
): void {
	const writeFailure =
		fields.state === undefined ? undefined : saveGroupOrder(fields.state, axis, moved);
	if (fields.state === undefined)
		fields.groupOrdersForRunRef.current = {
			...fields.groupOrdersForRunRef.current,
			[axis]: [...moved],
		};
	const nextRows = ticketRows(fields.factRows(fields.ticketsRef.current), axis, {
		folds: fields.groupFoldsRef.current,
		storedOrder: moved,
		positionOrder: fields.positionOrderOf(),
	});
	const headerIndex = nextRows.findIndex((r) => r.kind === "group" && r.group.value === value);
	fields.groupOrderListRef.current = [...moved];
	fields.setGroupOrderList([...moved]);
	fields.ticketRowsRef.current = nextRows;
	fields.selectedIndexRef.current =
		headerIndex >= 0 ? headerIndex : fields.selectedIndexRef.current;
	fields.setSelectedIndex(fields.selectedIndexRef.current);
	if (writeFailure !== undefined)
		fields.setErrorMessage(`the group order did not save: ${writeFailure}`);
}

/** The Group operations: the axis cycle, the fold, the order move. */
function useAppGroupOps(fields: AppGroupOpsFields) {
	const cycleGroupingAxis = useCallback(() => groupCycleAxis(fields), [fields]);
	const toggleGroupFold = useCallback((value: string) => groupToggleFold(fields, value), [fields]);
	const foldGroupAtCursor = useCallback(() => groupFoldAtCursor(fields), [fields]);
	const moveGroupAtCursor = useCallback(
		(direction: "up" | "down") => groupMoveAtCursor(fields, direction),
		[fields],
	);
	return { cycleGroupingAxis, toggleGroupFold, foldGroupAtCursor, moveGroupAtCursor };
}

/** The fields the Repository init's acts read and write. */
interface AppRepoInitFields {
	state: AppAggregates | undefined;
	configRef: RefObject<FactoryConfig>;
	ticketsRef: RefObject<readonly Ticket[]>;
	ticketRowsRef: RefObject<readonly ListedRow<TicketRowFacts>[]>;
	selectedIndexRef: RefObject<number>;
	groupingAxisRef: RefObject<GroupingAxis>;
	repositoryInitQueue: RefObject<RepositoryInitQueue | null>;
	repositoryInitInFlight: RefObject<string | null>;
	commandRunner: CommandRunner;
	homeDir: string;
	configFile: string;
	setConfig: (config: FactoryConfig) => void;
	setPanel: (panel: Panel) => void;
	setWorkingMessage: (message: string, owner: WorkingOwner) => void;
	clearWorkingMessage: (owner: ProgressOwner) => void;
	clearOperationMessage: (owner: ProgressOwner) => void;
	setErrorMessage: (message: string) => void;
	setWarningMessage: (message: string) => void;
	setNoticeMessage: (message: string, severity?: "info" | "warning") => void;
	configWriteQueue: RefObject<Promise<void>>;
}

/** Refuse a new init while one plans: the line names the init that holds. */
function repoInitInFlightCheck(fields: AppRepoInitFields): boolean {
	const inFlight = fields.repositoryInitInFlight.current;
	if (inFlight === null) return false;
	fields.setWarningMessage(`the init for ${inFlight} is running`);
	return true;
}

/**
 * The repository the Group header's `i` resolves: the ticket's identity and
 * clone URL, the configured source's host and auth, and the checkout the
 * act works in.
 */
function repoInitResolution(
	fields: AppRepoInitFields,
	displayName: string,
):
	| { ok: true; ref: Ticket["repositoryRef"]; source: FactoryConfig["sources"][number] }
	| { ok: false } {
	const factoryState = fields.state;
	if (factoryState === undefined) {
		fields.setWarningMessage("the repository init needs SQLite state");
		return { ok: false };
	}
	const cfg = fields.configRef.current;
	const ticket = fields.ticketsRef.current.find((item) => item.repository === displayName);
	if (ticket === undefined) {
		fields.setWarningMessage(`no ticket names the repository ${displayName}`);
		return { ok: false };
	}
	const source = cfg.sources.find((item) =>
		item.repositories.includes(ticket.repositoryRef.displayName),
	);
	if (source === undefined) {
		fields.setWarningMessage(`no source is configured for ${ticket.repositoryRef.displayName}`);
		return { ok: false };
	}
	return { ok: true, ref: ticket.repositoryRef, source };
}

/** The source's configured auth, resolved for the plan's gh calls. */
async function repoInitGhOptions(
	fields: AppRepoInitFields,
	source: FactoryConfig["sources"][number],
): Promise<CommandOptions | { refused: string }> {
	if (source.auth === undefined) return {};
	const resolved = await new GhAuthenticator(
		source.host,
		source.auth,
		fields.commandRunner,
		process.env,
	).resolve();
	// A configured auth that fails to resolve refuses the open: the
	// plan and the confirmed act would then run on the ambient gh
	// identity, which may be the wrong account.
	if (!resolved.ok)
		return { refused: `the source's auth for ${source.host} did not resolve: ${resolved.reason}` };
	return resolved.options;
}

/** The `i` key on a Group header: the plan, and the confirmation panel. */
async function repoInitOpenFor(fields: AppRepoInitFields, displayName: string): Promise<void> {
	const resolution = repoInitResolution(fields, displayName);
	if (resolution.ok === false) return;
	const { ref, source } = resolution;
	// The plan runs async with the base view's keyboard live (ADR 0083):
	// the marker holds until the panel stands or a refusal lands, so no
	// second init starts the first would then overwrite.
	fields.repositoryInitInFlight.current = displayName;
	// The act's checkout: the plane's own repository resolution rule, the
	// case-insensitive mapping lookup over the identity and the display name,
	// then the ~/src/<name> convention - the same rule the sources resolve
	// through, so a documented owner/name key, a sibling clone, a ~ path, and
	// an unmapped convention all find the checkout the operator already has.
	const checkout = repositoryInitCheckoutPath(
		fields.configRef.current.repos,
		ref.identity,
		ref.displayName,
		fields.homeDir,
	);
	if (!(await fileExists(checkout))) {
		fields.setWarningMessage(
			`${ref.displayName} has no local checkout at ${checkout} to work a throwaway worktree in`,
		);
		fields.repositoryInitInFlight.current = null;
		return;
	}
	const gh = await repoInitGhOptions(fields, source);
	if ("refused" in gh) {
		fields.setErrorMessage(gh.refused);
		fields.repositoryInitInFlight.current = null;
		return;
	}
	const plan = await planRepositoryInit({
		runner: fields.commandRunner,
		checkout,
		identity: ref.identity,
		displayName: ref.displayName,
		workflowStates: fields.configRef.current.workflowStates,
		taskTypes: fields.configRef.current.taskTypes,
		ghOptions: gh,
	});
	if ("reason" in plan) {
		fields.setWarningMessage(plan.reason);
		fields.repositoryInitInFlight.current = null;
		return;
	}
	fields.repositoryInitInFlight.current = null;
	repoInitSetPanel(fields, {
		identity: ref.identity,
		displayName: ref.displayName,
		host: source.host,
		auth: source.auth,
		cloneUrl: ref.cloneUrl,
		checkout,
		plan,
	});
}

/** The confirmation panel the plan opens, from the act's own facts. */
function repoInitSetPanel(
	fields: AppRepoInitFields,
	facts: {
		identity: string;
		displayName: string;
		host: string;
		auth: GitHubAuthentication | undefined;
		cloneUrl: string;
		checkout: string;
		plan: RepositoryInitPlan;
	},
): void {
	fields.setPanel({
		kind: "repository-init",
		identity: facts.identity,
		repository: {
			identity: facts.identity,
			displayName: facts.displayName,
			host: facts.host,
			auth: facts.auth,
			cloneUrl: facts.cloneUrl,
			checkout: facts.checkout,
		},
		plan: facts.plan,
	});
}

/**
 * The Repository init (ADR 0075): `i` on a Group header under the
 * repository axis opens the confirmation panel. The handler resolves the
 * repository the cursor names - a ticket in the group gives its identity
 * and clone URL, the configured source gives its host and auth, and the
 * mapping gives the checkout the act works in - and plans the change
 * against the factory's own settings. The plan is the generator's answer,
 * so the panel states exactly what the confirmed act will change.
 */
function repoInitOpen(fields: AppRepoInitFields): void {
	if (fields.groupingAxisRef.current !== "repository") return;
	const row = fields.ticketRowsRef.current[fields.selectedIndexRef.current];
	if (row === undefined || row.kind !== "group") return;
	void repoInitOpenFor(fields, row.group.value).catch((error) =>
		fields.setErrorMessage(errorMessage(error)),
	);
}

/**
 * The chosen repository from the select list: the checkout resolves by the
 * plane's own rule, the plan runs the way the Group header's `i` runs it,
 * and the confirmation panel opens. A repository without a local checkout
 * gets the refusal that names the path it needs (ADR 0082). A refusal in
 * a queue skips the entry and moves on (ADR 0083).
 */
async function repoInitSelectFor(
	fields: AppRepoInitFields,
	choice: InitableRepository,
): Promise<void> {
	if (fields.state === undefined) {
		fields.setWarningMessage("the repository init needs SQLite state");
		repoInitAdvanceQueue(fields, "failed");
		return;
	}
	// The plan runs async with the base view's keyboard live (ADR 0083):
	// the marker holds until the panel stands or a refusal lands, so no
	// second init starts the first would then overwrite.
	fields.repositoryInitInFlight.current = choice.displayName;
	const cfg = fields.configRef.current;
	const checkout = repositoryInitCheckoutPath(
		cfg.repos,
		choice.identity,
		choice.displayName,
		fields.homeDir,
	);
	if (!(await fileExists(checkout))) {
		fields.setWarningMessage(
			`${choice.displayName} has no local checkout at ${checkout} to work a throwaway worktree in`,
		);
		fields.repositoryInitInFlight.current = null;
		repoInitAdvanceQueue(fields, "refused");
		return;
	}
	const plan = await planRepositoryInit({
		runner: fields.commandRunner,
		checkout,
		identity: choice.identity,
		displayName: choice.displayName,
		workflowStates: cfg.workflowStates,
		taskTypes: cfg.taskTypes,
	});
	if ("reason" in plan) {
		fields.setWarningMessage(plan.reason);
		fields.repositoryInitInFlight.current = null;
		repoInitAdvanceQueue(fields, "refused");
		return;
	}
	fields.repositoryInitInFlight.current = null;
	repoInitSetPanel(fields, {
		identity: choice.identity,
		displayName: choice.displayName,
		host: "github.com",
		auth: undefined,
		cloneUrl: choice.htmlUrl,
		checkout,
		plan,
	});
}

/** The queue the select list's Enter hands over (ADR 0083). */
function repoInitStartQueue(fields: AppRepoInitFields, queue: readonly InitableRepository[]): void {
	if (queue.length === 0) return;
	if (repoInitInFlightCheck(fields)) return;
	const [head, ...rest] = queue;
	fields.repositoryInitQueue.current =
		rest.length > 0 ? { remaining: rest, ran: 0, skipped: 0, refused: 0 } : null;
	void repoInitSelectFor(fields, head).catch((error) =>
		fields.setErrorMessage(errorMessage(error)),
	);
}

/** One entry of the queue settles (ADR 0083). */
function repoInitAdvanceQueue(
	fields: AppRepoInitFields,
	outcome: "ran" | "skipped" | "refused" | "failed",
): void {
	const queue = fields.repositoryInitQueue.current;
	if (queue === null) return;
	if (outcome === "failed") {
		fields.repositoryInitQueue.current = null;
		return;
	}
	queue[outcome] += 1;
	if (queue.remaining.length === 0) {
		fields.repositoryInitQueue.current = null;
		// The panel under review closes with the last entry: the settle line
		// stands on the base view's Message line, not behind a panel. A
		// refusal earlier in the queue left its error on that line, and an
		// error outranks a notice: the settle line ends the fact it replaces.
		fields.setPanel(null);
		fields.clearOperationMessage("none");
		fields.setNoticeMessage(
			`the init queue settled: ${queue.ran} ran, ${queue.skipped} skipped, ${queue.refused} refused`,
			"info",
		);
		return;
	}
	const [head, ...rest] = queue.remaining;
	queue.remaining = rest;
	void repoInitSelectFor(fields, head).catch((error) =>
		fields.setErrorMessage(errorMessage(error)),
	);
}

/**
 * The cancel of a queued entry (ADR 0083): the entry leaves the queue
 * untouched, and the next stands in its place. With no queue behind it,
 * cancel is the way out with nothing changed. The panel under review
 * closes now, not when the next entry's panel opens: the plan runs async
 * behind it, and a panel the operator can still key into is a stale act
 * waiting to run twice.
 */
function repoInitSkipEntry(fields: AppRepoInitFields): void {
	fields.setPanel(null);
	if (fields.repositoryInitQueue.current !== null) repoInitAdvanceQueue(fields, "skipped");
}

/** The confirmed init's config write-back: the sources join the operator's file. */
async function repoInitWriteBack(
	fields: AppRepoInitFields,
	flow: Extract<RepositoryInitFlowResult, { ok: true }>,
): Promise<void> {
	// The sources the flow registered join the config: the operator's pane
	// shows them the moment the write-back lands, the way a repository
	// mapping does.
	let writeLine = "";
	let writeFact: ConfigWriteFact | undefined;
	const write = fields.configWriteQueue.current
		.catch(() => undefined)
		.then(async () => {
			try {
				const currentConfig = fields.configRef.current;
				const updated = {
					...currentConfig,
					sources: [...currentConfig.sources, ...flow.newSources],
				};
				fields.configRef.current = updated;
				fields.setConfig(updated);
				// The write-back appends the `[[sources]]` blocks the init
				// registered and leaves the rest of the operator's file, their
				// comments included, where they wrote it (ADR 0103).
				const fact = await writeConfigFile(fields.configFile, updated);
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
				fields.setErrorMessage(`the init's sources did not save: ${errorMessage(error)}`);
			}
		});
	fields.configWriteQueue.current = write.then(
		() => undefined,
		() => undefined,
	);
	await write;
	// The Message line is one row of the terminal's width and the act's own
	// confirmation is longer than that, so a full rewrite leads the line: the
	// warning that the file's comments did not survive is what reads (ADR 0103).
	fields.setNoticeMessage(
		writeFact === undefined
			? flow.message
			: writeFactWithConfirmation(writeFact, writeLine, flow.message),
	);
}

/** The confirmed init: the act, the write-back, the settle line. */
async function repoInitConfirm(
	fields: AppRepoInitFields,
	repository: RepositoryInitRepository,
	plan: RepositoryInitPlan,
	instructionFile?: InstructionFileName,
): Promise<void> {
	const factoryState = fields.state;
	if (factoryState === undefined) {
		fields.setWarningMessage("the repository init needs SQLite state");
		repoInitAdvanceQueue(fields, "failed");
		return;
	}
	// The act's progress on the Message line (ADR 0075, story 27): a word
	// stands while the commands run, so the operator sees the act in flight
	// without opening anything.
	fields.setWorkingMessage(`initializing ${repository.displayName}...`, "repository-init");
	const flow = await commitRepositoryInit({
		runner: fields.commandRunner,
		state: factoryState,
		config: fields.configRef.current,
		repository,
		workflowStates: fields.configRef.current.workflowStates,
		taskTypes: fields.configRef.current.taskTypes,
		plan: {
			instructionFile: instructionFile ?? plan.instructionFile,
			labelsToCreate: plan.labelsToCreate,
			fileActions: plan.files.map((file) => ({ path: file.path, action: file.action })),
		},
	}).catch((error) => ({ ok: false as const, reason: errorMessage(error) }));
	fields.clearWorkingMessage("repository-init");
	if (flow.ok === false) {
		fields.setErrorMessage(flow.reason);
		repoInitAdvanceQueue(fields, "failed");
		return;
	}
	await repoInitWriteBack(fields, flow);
	// A queue behind the act closes its panel now, the way the skip does:
	// the next entry plans async, and the panel under review must not
	// stand live behind it. A lone init keeps its panel, the way it
	// always did.
	if (fields.repositoryInitQueue.current !== null) fields.setPanel(null);
	repoInitAdvanceQueue(fields, "ran");
}

/** The Repository init's acts: the `i` key, the queue, the confirmation. */
function useAppRepoInit(fields: AppRepoInitFields) {
	const openRepositoryInit = useCallback(() => repoInitOpen(fields), [fields]);
	const startRepositoryInitQueue = useCallback(
		(queue: readonly InitableRepository[]) => repoInitStartQueue(fields, queue),
		[fields],
	);
	const advanceRepositoryInitQueue = useCallback(
		(outcome: "ran" | "skipped" | "refused" | "failed") => repoInitAdvanceQueue(fields, outcome),
		[fields],
	);
	const skipRepositoryInitEntry = useCallback(() => repoInitSkipEntry(fields), [fields]);
	const runRepositoryInitConfirm = useCallback(
		(
			repository: RepositoryInitRepository,
			plan: RepositoryInitPlan,
			instructionFile?: InstructionFileName,
		) => repoInitConfirm(fields, repository, plan, instructionFile),
		[fields],
	);
	return {
		openRepositoryInit,
		startRepositoryInitQueue,
		advanceRepositoryInitQueue,
		skipRepositoryInitEntry,
		runRepositoryInitConfirm,
	};
}

/** The fields the handoff start reads and writes. */
interface AppHandoffStartFields {
	handoffDispatch: HandoffDispatch | undefined;
	mainFacts: () => AvailabilityFacts;
	setWarningMessage: (message: string) => void;
	noStateHandoffInFlightRef: RefObject<boolean>;
	setStartingTickets: Dispatch<SetStateAction<ReadonlySet<string>>>;
	setWorkingMessage: (message: string, owner: WorkingOwner) => void;
	setFaultErrorMessage: (message: string) => void;
	config: FactoryConfig;
	commandRunner: CommandRunner;
	homeDir: string;
	finishOutcome: (outcome: HandoffOutcome) => Promise<void>;
	setListViews: Dispatch<SetStateAction<TicketListViews>>;
	listViewsRef: RefObject<TicketListViews>;
	ticketsRef: RefObject<readonly Ticket[]>;
}

/** Add the ticket to the Starting window, the no-state start's in-flight face. */
function startHandoffAddStarting(fields: AppHandoffStartFields, ticket: Ticket): void {
	fields.setStartingTickets((current) => {
		if (current.has(ticket.identity)) return current;
		const next = new Set(current);
		next.add(ticket.identity);
		return next;
	});
}

/** Drop the ticket from the Starting window, the no-state start's settle. */
function startHandoffDropStarting(fields: AppHandoffStartFields, ticket: Ticket): void {
	fields.setStartingTickets((current) => {
		if (!current.has(ticket.identity)) return current;
		const next = new Set(current);
		next.delete(ticket.identity);
		return next;
	});
}

/** The in-memory handoff fact the no-state settle writes to the row. */
function noStateHandoffFact(
	choice: HandoffChoice,
	outcome: Extract<HandoffOutcome, { agent: StartedAgent }>,
): Handoff {
	return {
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
}

/**
 * The no-state settle's list patch: the ticket's face moves to
 * `handed-off` with the fact, and every view of the list rule re-derives.
 */
function startHandoffPatchHandedOff(
	fields: AppHandoffStartFields,
	ticket: Ticket,
	handoff: Handoff,
): void {
	// The in-memory shell holds one array and derives every view from
	// it, so a patch lands once and no view of the list rule is
	// remembered by hand here.
	fields.setListViews((current) => {
		const next = inMemoryTicketViews(
			current.projection.rows.map((row: Ticket) =>
				row.identity === ticket.identity ? { ...row, state: "handed-off" as const, handoff } : row,
			),
		);
		fields.listViewsRef.current = next;
		fields.ticketsRef.current = next.rows;
		return next;
	});
}

/** The no-state start's settle: the face leaves, the outcome reports. */
async function startHandoffSettle(
	fields: AppHandoffStartFields,
	ticket: Ticket,
	choice: HandoffChoice,
	outcome: HandoffOutcome,
): Promise<void> {
	startHandoffDropStarting(fields, ticket);
	if (outcome.status !== "failed")
		startHandoffPatchHandedOff(fields, ticket, noStateHandoffFact(choice, outcome));
	await fields.finishOutcome(outcome);
	fields.noStateHandoffInFlightRef.current = false;
}

/** The no-state start's failure: the face leaves, the Fault reports. */
function startHandoffCatch(fields: AppHandoffStartFields, ticket: Ticket, error: unknown): void {
	startHandoffDropStarting(fields, ticket);
	fields.setFaultErrorMessage(`handoff failed: ${errorMessage(error)}`);
	fields.noStateHandoffInFlightRef.current = false;
}

/**
 * Start the handoff on the Ticket under the cursor: the state-backed claim
 * runs through the dispatch module, and the no-state test projection runs
 * the act itself and patches the list by hand (ADR 0064).
 *
 * The no-state projection holds no attempt ledger, so the ref plays the
 * ledger's role: the shell refuses a second start while one stands in
 * flight, the way the state-backed claim refuses it. The Starting window
 * (ADR 0030) is the in-flight handoff itself here: the add lands on the
 * keypress, and the settle leaves the face to the `handed-off` state on a
 * start and drops it on a failure.
 */
function startHandoffTicket(
	fields: AppHandoffStartFields,
	ticket: Ticket,
	choice: HandoffChoice,
): void {
	const availability = availabilityFor(controlById("handoff"), fields.mainFacts());
	if (!availability.available) {
		fields.setWarningMessage(refusalReason(controlById("handoff"), fields.mainFacts()));
		return;
	}
	if (fields.handoffDispatch !== undefined) {
		void fields.handoffDispatch
			.dispatch({
				origin: "open",
				ticketIdentity: ticket.identity,
				choice,
				previousMessage: "",
			})
			.then((result) => {
				if (!result.ok) fields.setWarningMessage(result.reason);
			});
		return;
	}
	if (fields.noStateHandoffInFlightRef.current) {
		fields.setWarningMessage("handoff in flight");
		return;
	}
	fields.noStateHandoffInFlightRef.current = true;
	startHandoffAddStarting(fields, ticket);
	fields.setWorkingMessage(`handing off "${ticket.title}"...`, "handoff");
	void handOffTicket(ticket, choice, {
		config: fields.config,
		runner: fields.commandRunner,
		home: fields.homeDir,
		claim: "open",
	})
		.then(async (outcome) => startHandoffSettle(fields, ticket, choice, outcome))
		.catch((error) => startHandoffCatch(fields, ticket, error));
}

/** The fields the Main view's mode facts read. */
interface AppMainFactsFields {
	standing: StandingFacts;
	selectedTicket: Ticket | undefined;
	ticketAtCursor: () => Ticket | undefined;
	factsFor: (ticket: Ticket) => TicketRowFacts;
	ticketFilterRef: RefObject<TicketListFilter>;
	selectedTicketPaneAlive: boolean;
	selectedTicketPaneForeign: boolean;
	selectionRef: RefObject<"ticket" | "consultation" | "queue">;
	consultationsRef: RefObject<readonly Consultation[]>;
	consultationIndexRef: RefObject<number>;
	state: AppAggregates | undefined;
	selectedConsultationAgentStatus: AgentStatus | null;
	selectedConsultationPaneAlive: boolean;
	ticketRowsRef: RefObject<readonly ListedRow<TicketRowFacts>[]>;
	ticketsExpandedRef: RefObject<boolean>;
	consultationsExpandedRef: RefObject<boolean>;
	workExpandedRef: RefObject<boolean>;
	workQueueRef: RefObject<readonly WorkQueueItem[]>;
	workQueueIndexRef: RefObject<number>;
	selectedIndexRef: RefObject<number>;
	groupingAxis: GroupingAxis;
	detailMaxScroll: number;
	consultationMaxScroll: number;
	workQueueDetailMaxScroll: number;
}

/** The facts the Main view states for a mode another surface owns. */
const MAIN_FACTS_OVERLAY_GUIDE = {
	actionRowCount: 0,
	bodyScrollable: true,
	bodyEmpty: false,
	editableActionSelected: false,
	planeActionSelected: false,
};

/** The Group facts, from the module that owns the row list they count. */
function mainFactsGroup(f: AppMainFactsFields) {
	return groupCursorFacts(
		f.ticketRowsRef.current,
		f.ticketsExpandedRef.current ? f.selectedIndexRef.current : -1,
	);
}

/** The queue facts, from the module that draws the queue it counts. */
function mainFactsQueue(f: AppMainFactsFields) {
	return workQueueCursorFacts(f.workQueueRef.current, f.workQueueIndexRef.current);
}

/** The Ticket facts the Ticket section's two modes read. */
function mainFactsTicketCursor(f: AppMainFactsFields) {
	return {
		selectedTicket: f.ticketAtCursor(),
		// The ignore's obligation read takes the row's own facts (ADR 0060): the
		// failure marker the list's badge wears, and the List filter the `f` hint
		// names the next state of.
		selectedTicketMarker:
			f.selectedTicket === undefined ? null : f.factsFor(f.selectedTicket).failure,
		ticketListFilter: f.ticketFilterRef.current,
		ticketPaneAlive: f.selectedTicketPaneAlive,
		ticketPaneForeign: f.selectedTicketPaneForeign,
	};
}

/** The Consultation facts the Consultation section's two modes read. */
function mainFactsConsultationCursor(f: AppMainFactsFields) {
	return {
		selectedConsultation:
			f.selectionRef.current === "consultation"
				? f.consultationsRef.current[f.consultationIndexRef.current]
				: undefined,
		consultationRefreshAvailable: f.state !== undefined,
		consultationAgentStatus: f.selectedConsultationAgentStatus,
		consultationPaneAlive: f.selectedConsultationPaneAlive,
	};
}

/**
 * Whether the list's cursor can step.
 *
 * The cursor walks one sequence: the rows of each expanded section, in
 * order. A step is possible past the last row of a section, into the next
 * expanded one, so the list can move as long as the cursor is not the
 * sequence's only row.
 */
function mainFactsListCanMove(f: AppMainFactsFields): boolean {
	// The Ticket section's cursor walks the row list, Group headers
	// included, so its edge is the row list's last index (issue #159).
	const t = f.ticketRowsRef.current.length;
	// The blank row between two Groups holds no cursor, so the walk asks
	// how many rows it can rest on rather than how many rows it draws.
	const tStops = cursorRowCount(f.ticketRowsRef.current);
	const c = f.consultationsRef.current.length;
	const w = f.workQueueRef.current.length;
	const tOpen = f.ticketsExpandedRef.current;
	const cOpen = f.consultationsExpandedRef.current;
	const wOpen = f.workExpandedRef.current;
	// A cross reaches an empty section too, so the step into it is
	// always possible while the other section is expanded: the empty
	// message is the row the cursor takes, and the Work section keeps
	// its header while it is empty the same way (ADR 0049).
	if (f.selectionRef.current === "queue") {
		// Up out of the queue crosses into the Consultation section, or into
		// the Ticket section while the Consultation section is collapsed, and
		// the cross opens at the queue's own first row. Where the other
		// section happens to hold its cursor says nothing about where this
		// one stands: a direct click on the Work header can land the cursor on
		// the only row of a queue the Consultation cursor never touched.
		const crossUp = cOpen || tOpen;
		return sectionCanMove({
			open: wOpen,
			stops: w,
			canStepInside: f.workQueueIndexRef.current === 0,
			canCross: crossUp,
		});
	}
	if (f.selectionRef.current === "consultation")
		return sectionCanMove({
			open: cOpen,
			stops: c,
			canStepInside: f.consultationIndexRef.current === 0,
			canCross: tOpen,
		});
	return sectionCanMove({
		open: tOpen,
		stops: tStops,
		canStepInside: f.selectedIndexRef.current >= t - 1,
		canCross: cOpen,
	});
}

/** Whether the cursor on one open section can step, past its edge or into the open section it touches. */
function sectionCanMove(fields: {
	open: boolean;
	stops: number;
	canStepInside: boolean;
	canCross: boolean;
}): boolean {
	const { open, stops, canStepInside, canCross } = fields;
	if (!open) return canCross;
	if (stops > 1) return true;
	return canStepInside && canCross;
}

/** The queue item that waits under the row the cursor holds (ADR 0049). */
function mainFactsQueueItem(f: AppMainFactsFields): WorkQueueItem | null {
	if (f.selectionRef.current === "ticket")
		return handoffItemWaitingForTicket(f.workQueueRef.current, f.selectedTicket?.identity);
	if (f.selectionRef.current === "consultation")
		return consultationItemWaitingFor(
			f.workQueueRef.current,
			f.consultationsRef.current[f.consultationIndexRef.current]?.id,
		);
	return null;
}

/** The Ticket list's mode facts. */
function mainFactsTicketList(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("ticket-list", f.standing, {
		...mainFactsTicketCursor(f),
		...mainFactsGroup(f),
		groupingAxis: f.groupingAxis,
		listCanMove: mainFactsListCanMove(f),
		queueItemForSelectedRow: mainFactsQueueItem(f),
	});
}

/** The Ticket detail's mode facts. */
function mainFactsTicketDetail(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("ticket-detail", f.standing, {
		...mainFactsTicketCursor(f),
		...mainFactsGroup(f),
		groupingAxis: f.groupingAxis,
		queueItemForSelectedRow: mainFactsQueueItem(f),
		detailCanScroll: f.detailMaxScroll > 0,
	});
}

/** The Consultation list's mode facts. */
function mainFactsConsultationList(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("consultation-list", f.standing, {
		...mainFactsConsultationCursor(f),
		listCanMove: mainFactsListCanMove(f),
		queueItemForSelectedRow: mainFactsQueueItem(f),
	});
}

/** The Consultation detail's mode facts. */
function mainFactsConsultationDetail(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("consultation-detail", f.standing, {
		...mainFactsConsultationCursor(f),
		queueItemForSelectedRow: mainFactsQueueItem(f),
		detailCanScroll: f.consultationMaxScroll > 0,
	});
}

/** The Work queue list's mode facts. */
function mainFactsWorkQueueList(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("work-queue-list", f.standing, {
		...mainFactsQueue(f),
		listCanMove: mainFactsListCanMove(f),
	});
}

/** The Work queue detail's mode facts. */
function mainFactsWorkQueueDetail(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("work-queue-detail", f.standing, {
		...mainFactsQueue(f),
		detailCanScroll: f.workQueueDetailMaxScroll > 0,
	});
}

/** The Consultation interaction's mode facts: the Agent owns every key but the exit. */
function mainFactsConsultationInteraction(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("consultation-interaction", f.standing, {});
}

/** The response editor's mode facts: it owns its own slot facts. */
function mainFactsFormField(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("form-field", f.standing, { fieldHasSelection: false });
}

/** The Decision modal's mode facts: the guide's overlay facts. */
function mainFactsDecisionModal(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("decision-modal", f.standing, MAIN_FACTS_OVERLAY_GUIDE);
}

/** The action modal's mode facts: the Decision region's one count. */
function mainFactsActionModal(
	f: AppMainFactsFields,
	mode: "missing-modal" | "action-panel",
): AvailabilityFacts {
	return availabilityFacts(mode, f.standing, { actionRowCount: 0 });
}

/** The Live view's mode facts: the cursor's facts beside the Body pane. */
function mainFactsLiveView(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("live-view", f.standing, {
		...mainFactsTicketCursor(f),
		bodyScrollable: true,
		bodyEmpty: false,
	});
}

/** The Repository select's mode facts: the list rule and its empty reads. */
function mainFactsRepositorySelect(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("repository-select", f.standing, {
		listCanMove: mainFactsListCanMove(f),
		repositoryCount: 0,
		searchText: "",
		pendingCount: 0,
	});
}

/** The Override list's mode facts: the standing facts alone. */
function mainFactsOverrideList(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("override-list", f.standing, {});
}

/** The Override field's mode facts: the form's selection read. */
function mainFactsOverrideField(
	f: AppMainFactsFields,
	mode: "override-model" | "override-text",
): AvailabilityFacts {
	return availabilityFacts(mode, f.standing, { fieldHasSelection: false });
}

/** The form selector's mode facts: the cycle read beside the selection. */
function mainFactsFormSelector(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("form-selector", f.standing, {
		fieldHasSelection: false,
		formCycleCount: 0,
	});
}

/** The form action's mode facts: the refusal read beside the selection. */
function mainFactsFormAction(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("form-action", f.standing, {
		fieldHasSelection: false,
		formRefusal: null,
	});
}

/** The Key guide's mode facts: it reads nothing beside the standing facts. */
function mainFactsKeyGuide(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("key-guide", f.standing, {});
}

/** The Message view's mode facts: it owns its body's window. */
function mainFactsMessageView(f: AppMainFactsFields): AvailabilityFacts {
	return availabilityFacts("message-view", f.standing, {
		bodyScrollable: true,
		bodyEmpty: false,
	});
}

/**
 * The Availability facts of one mode the Main view dispatches, paints on
 * its own Action bar, or catalogs in the Key guide.
 *
 * Each mode names only the facts its controls read, and the compiler
 * rejects a mode whose facts this view did not state.
 */
function mainFactsFor(f: AppMainFactsFields, mode: InteractionMode): AvailabilityFacts {
	switch (mode) {
		case "ticket-list":
			return mainFactsTicketList(f);
		case "ticket-detail":
			return mainFactsTicketDetail(f);
		case "consultation-list":
			return mainFactsConsultationList(f);
		case "consultation-detail":
			return mainFactsConsultationDetail(f);
		case "work-queue-list":
			return mainFactsWorkQueueList(f);
		case "work-queue-detail":
			return mainFactsWorkQueueDetail(f);
		case "consultation-interaction":
			return mainFactsConsultationInteraction(f);
		case "form-field":
			return mainFactsFormField(f);
		case "decision-modal":
			return mainFactsDecisionModal(f);
		case "missing-modal":
		case "action-panel":
			return mainFactsActionModal(f, mode);
		case "live-view":
			return mainFactsLiveView(f);
		case "repository-select":
			return mainFactsRepositorySelect(f);
		case "override-list":
			return mainFactsOverrideList(f);
		case "override-model":
		case "override-text":
			return mainFactsOverrideField(f, mode);
		case "form-selector":
			return mainFactsFormSelector(f);
		case "form-action":
			return mainFactsFormAction(f);
		case "key-guide":
			return mainFactsKeyGuide(f);
		case "message-view":
			return mainFactsMessageView(f);
		default: {
			// A mode the plane has never seen. The assertion is the check: a new
			// Interaction mode reaches this line as a compile error, not as a
			// record borrowed from another mode.
			const unstated: never = mode;
			throw new Error(`the Main view states no facts for ${unstated}`);
		}
	}
}

/** The fields the shell's key handler reads and writes. */
interface AppKeyHandlerFields {
	utility: Utility | null;
	override: PendingOverride | null;
	panel: Panel;
	launcher: boolean;
	interaction: boolean;
	responseEditor: boolean;
	renderer: NonNullable<ReturnType<typeof useRenderer>>;
	configRef: RefObject<FactoryConfig>;
	setInteraction: (value: boolean) => void;
	setNewOutput: (value: boolean) => void;
	consultationOperations: ConsultationOperations | undefined;
	setNoticeMessage: (message: string, severity?: "info" | "warning") => void;
	setErrorMessage: (message: string) => void;
	setWarningMessage: (message: string) => void;
	consultationsRef: RefObject<readonly Consultation[]>;
	consultationIndexRef: RefObject<number>;
	outputRefreshRef: RefObject<(() => void) | null>;
	currentBaseMode: () => InteractionMode;
	mainFacts: () => AvailabilityFacts;
	decideCompletion: (facts: AvailabilityFacts) => void;
	factsFor: (ticket: Ticket) => TicketRowFacts;
	startHandoff: (ticket: Ticket, choice: HandoffChoice) => void;
	choiceFor: (ticket: Ticket) => HandoffChoice;
	setPanel: (panel: Panel) => void;
	state: AppAggregates | undefined;
	runGoto: (ticket: Ticket) => void;
	cursor: ReturnType<typeof useAppCursor>;
	moveQueueItem: (direction: "up" | "down", item: WorkQueueItem | null) => void;
	removeQueueItem: (item: WorkQueueItem | null) => void;
	forceDispatchQueueItem: (item: WorkQueueItem | null) => void;
	moveRange: (name: string) => void;
	groupOps: ReturnType<typeof useAppGroupOps>;
	repoInit: ReturnType<typeof useAppRepoInit>;
	refuseInitInFlight: () => boolean;
	selectionRef: RefObject<"ticket" | "consultation" | "queue">;
	isReplacedConsultation: (consultation: Consultation) => boolean;
	openReplacementLauncher: (consultation: Consultation) => void;
	setLauncher: (value: boolean) => void;
	cycleConsultationHistory: () => void;
	toggleTicketIgnore: () => void;
	toggleSourceMute: () => void;
	cycleTicketFilter: () => void;
	runConsultationClose: (consultation: Consultation) => void;
	replaceTickets: () => void;
	replaceConsultations: () => void;
	handoffDispatchRef: RefObject<
		{ state: HandoffDispatchAggregates; dispatch: HandoffDispatch } | undefined
	>;
	currentSeatCount: () => number;
	beginResponse: (consultation: Consultation) => void;
	commandRunner: CommandRunner;
	workspaceLabelOf: (workspaceId: string) => Promise<string | null>;
	reportMessage: (fact: MessageFact) => void;
	openOverride: () => void;
	recoverConsultationOpening: (consultation: Consultation) => void;
	consultationsExpandedRef: RefObject<boolean>;
	refreshNow: () => void;
	toggleQueuePause: () => void;
	workQueueRef: RefObject<readonly WorkQueueItem[]>;
	setSelection: (selection: "ticket" | "consultation" | "queue") => void;
	workQueueIndexRef: RefObject<number>;
	setWorkQueueIndex: (index: number) => void;
	setWorkExpanded: (value: boolean) => void;
	workExpandedRef: RefObject<boolean>;
	toggleAutoHandoff: () => void;
	openGuide: (mode: InteractionMode) => void;
	openMessage: (mode: InteractionMode) => void;
}

/**
 * The Agent interaction mode's keys: the configured exit settles the queued
 * input and leaves the mode, and every other key translates to the Agent's
 * pane input and queues it.
 */
function appKeyInteractionHandler(f: AppKeyHandlerFields, key: KeyEvent): void {
	const exit = f.configRef.current.interactionExitKey.toLowerCase().replace(/^ctrl-/, "ctrl+");
	const keyName = key.name.toLowerCase();
	const isExit = keyName === exit || (key.ctrl === true && exit === `ctrl+${keyName}`);
	if (isExit) {
		f.setInteraction(false);
		// Settle the queued input before announcing the exit: the last
		// key the operator sent still belongs to the Agent.
		void (f.consultationOperations?.flush() ?? Promise.resolve()).then(() =>
			f.setNoticeMessage("left Agent interaction mode", "info"),
		);
		return;
	}
	const selected = f.consultationsRef.current[f.consultationIndexRef.current];
	const event =
		selected?.paneId === null || selected?.paneId === undefined
			? null
			: translateAgentKey(key, f.configRef.current.interactionExitKey);
	if (selected !== undefined && selected.paneId !== null && event !== null) {
		const queued = f.consultationOperations?.enqueue(selected.paneId, event);
		if (queued === undefined) return;
		void queued.then(
			(result) => {
				if (result.code === 0) {
					f.setNewOutput(true);
					// The key may have produced output already: re-read
					// the pane now, not on the next interval tick.
					f.outputRefreshRef.current?.();
				} else
					f.setErrorMessage(
						`Agent interaction failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
					);
			},
			(error) => f.setErrorMessage(`Agent interaction failed: ${errorMessage(error)}`),
		);
	}
}

/** The Ticket section's controls: decide, hand off, go live, go, close. */
function appKeyTicketHandlers(f: AppKeyHandlerFields): Record<string, ControlHandler> {
	return {
		// A settled Ticket uses the distinct Decide control. It names
		// what Enter does instead of leaving a dimmed Hand off hint
		// that still opens a panel.
		"decide-completion": ({ facts }) => f.decideCompletion(facts),
		// An open Ticket is the only one a Hand off starts, and it can
		// queue behind nothing: the control stays ungated so a Ticket
		// with no other Enter meaning still gets the catalogue's own
		// refusal.
		handoff: ({ facts, refuse }) => {
			if (!ticketSectionFacts(facts)) return;
			const ticket = facts.selectedTicket;
			if (ticket === undefined || !inFlight(ticket)) {
				if (ticket === undefined) refuse();
				else f.startHandoff(ticket, f.choiceFor(ticket));
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
			if (f.factsFor(ticket).failure === "missing")
				f.setPanel({ kind: "missing", identity: ticket.identity });
			else f.setPanel({ kind: "live", identity: ticket.identity, workCycle: ticket.workCycle });
		},
		// `g` focuses the agent's pane in herdr and changes nothing
		// (ADR 0033): the catalogue gated the pane, so this runs the
		// focus and the confirmation stands on the Message line.
		"ticket-goto": ({ facts }) => {
			if (!ticketSectionFacts(facts)) return;
			const ticket = facts.selectedTicket;
			if (ticket !== undefined) f.runGoto(ticket);
		},
		// The Delete key ends the selected Ticket's work cycle (ADR 0031,
		// ADR 0122). The catalogue refused an open Ticket, so every Ticket
		// that reaches here has a live Agent or a settled turn behind it,
		// and both confirm first: the dialog states who is alive and what
		// survives, and nothing runs until the operator answers it.
		"ticket-close": ({ facts }) => {
			if (!ticketSectionFacts(facts)) return;
			const ticket = facts.selectedTicket;
			if (ticket === undefined) return;
			if (f.state === undefined) {
				// A work cycle is durable factory state: the projection the App
				// holds in memory has none to end, and the key says so instead of
				// opening a dialog that could run nothing.
				f.setWarningMessage("closing a Ticket needs SQLite state");
				return;
			}
			f.setPanel({ kind: "ticket-close", identity: ticket.identity });
		},
		quit: () => f.renderer.destroy(),
		detail: () => f.cursor.focusPane("detail"),
		"consultation-list": () => f.cursor.focusPane("list"),
		tickets: () => f.cursor.focusPane("list"),
		"queue-list": () => f.cursor.focusPane("list"),
	};
}

/** The Work queue's controls: rank, remove, force-dispatch, move, groups. */
function appKeyQueueHandlers(f: AppKeyHandlerFields): Record<string, ControlHandler> {
	return {
		// `+` (or `=`, its unshifted form) promotes the item under the
		// cursor, `-` demotes it (ADR 0049): the keys the operator already
		// knew for raising and lowering a rank, with the queue's own
		// refusal when the item already stands where the move would put it.
		"queue-promote": ({ facts }) => {
			if (!workQueueSectionFacts(facts)) return;
			f.moveQueueItem("up", facts.selectedWorkQueueItem);
		},
		"queue-demote": ({ facts }) => {
			if (!workQueueSectionFacts(facts)) return;
			f.moveQueueItem("down", facts.selectedWorkQueueItem);
		},
		// The queue's removal is one control in every base section
		// (ADR 0122): the queue's own panes remove the item under the
		// cursor, and the Ticket and Consultation panes remove the row
		// the cursor's item waits with, where the catalogue gated the
		// key on the state under the cursor.
		"queue-remove": ({ facts }) => {
			if (workQueueSectionFacts(facts)) f.removeQueueItem(facts.selectedWorkQueueItem);
			else if (ticketSectionFacts(facts)) f.removeQueueItem(facts.queueItemForSelectedRow);
			else if (consultationSectionFacts(facts)) f.removeQueueItem(facts.queueItemForSelectedRow);
		},
		// Enter on a queue row force-dispatches the item under the cursor over a
		// full Parallel limit (issue #89). The catalogue gated the availability,
		// so this runs the dispatch and nothing else; the module owns every line
		// the start or its failure leaves.
		"queue-force-dispatch": ({ facts }) => {
			if (!workQueueSectionFacts(facts)) return;
			f.forceDispatchQueueItem(facts.selectedWorkQueueItem);
		},
		"move-list": ({ key }) => f.moveRange(key.name),
		"scroll-detail": ({ key }) => f.moveRange(key.name),
		"section-toggle": () => f.cursor.toggleSection(),
		// `Tab` steps the Ticket list's Grouping axis (issue #159): the
		// shell writes the durable value and states the axis on the
		// Message line, and the list redraws with its Group headers.
		"group-axis": () => f.groupOps.cycleGroupingAxis(),
		// `i` on a Group header under the repository axis opens the
		// Repository init's confirmation panel (ADR 0075); the catalogue
		// splits it from the ignore's `i` on the row the cursor stands on.
		"repository-init": () => f.repoInit.openRepositoryInit(),
		// `o` opens the select list of the repositories the operator's
		// gh identity can init (ADR 0082): the bootstrap path for a
		// repository that has no ticket and no source yet.
		"repository-select-open": () => {
			if (f.refuseInitInFlight()) return;
			f.setPanel({ kind: "repository-select" });
		},
		// `Space` on a Group header folds that Group; the catalogue
		// resolved the key here on the facts under the cursor (issue #170).
		"group-fold": () => f.groupOps.foldGroupAtCursor(),
		// `+` (or `=`, its unshifted form) and `-` move the Group under the
		// cursor to its visible neighbor (ADR 0071): the same keys the
		// queue's promote and demote read, scoped by the catalogue to the
		// Ticket section's Group headers.
		"group-move-up": () => f.groupOps.moveGroupAtCursor("up"),
		"group-move-down": () => f.groupOps.moveGroupAtCursor("down"),
	};
}

/** The launcher and list controls: launch, history, ignore, mute, filter. */
function appKeyLauncherHandlers(f: AppKeyHandlerFields): Record<string, ControlHandler> {
	return {
		launch: () => {
			if (Object.keys(f.configRef.current.consultationTypes).length === 0)
				f.setWarningMessage(
					"no Consultation types configured; add [consultation-types.<name>] to the config file",
				);
			else {
				// While a Consultation is under the cursor, a missing or failed
				// Consultation is replaced rather than reopened: the launcher
				// remembers which row asked for the replacement.
				const selected =
					f.selectionRef.current === "consultation"
						? f.consultationsRef.current[f.consultationIndexRef.current]
						: undefined;
				if (selected !== undefined && f.isReplacedConsultation(selected))
					f.openReplacementLauncher(selected);
				else f.setLauncher(true);
			}
		},
		history: f.cycleConsultationHistory,
		// `i` ignores the selected Ticket or takes it back, and `f` cycles the
		// Ticket section's List filter (ADR 0060). The catalogue gated the
		// obligation and the section, so both run the act and nothing else.
		"ticket-ignore": () => f.toggleTicketIgnore(),
		"ticket-mute": () => f.toggleSourceMute(),
		"ticket-filter": () => f.cycleTicketFilter(),
	};
}

/** The Consultation record's controls: recover, close, delete. */
function appKeyConsultationRecordHandlers(f: AppKeyHandlerFields): Record<string, ControlHandler> {
	return {
		"consultation-recovery": ({ facts }) => {
			if (!consultationSectionFacts(facts)) return;
			const selected = facts.selectedConsultation;
			if (selected === undefined) return;
			// A closing record's recovery is the close panel's own: its Retry
			// and Force-close rows already answer the stuck cleanup. Every other
			// broken or stuck state opens the recovery panel, whose rows the
			// record's state names.
			f.setPanel({
				kind: selected.state === "closing" ? "consultation-close" : "consultation-recovery",
				identity: selected.id,
			});
		},
		// The Delete key's Consultation Close (ADR 0122): the catalogue
		// refused a `queued`, an `unscheduled`, and a `closed` record, so
		// every record that reaches here is a live one the panel confirms,
		// a no-Agent one that closes direct, or a `closing` one the panel
		// recovers with its Retry and Force-close rows.
		"consultation-close": ({ facts }) => {
			if (!consultationSectionFacts(facts)) return;
			const selected = facts.selectedConsultation;
			if (selected === undefined) return;
			f.runConsultationClose(selected);
		},
		// The Delete key's record removal (issue #91, ADR 0122): a `closed`
		// or an `unscheduled` record goes behind the removal panel, which
		// always confirms before the record and its history leave.
		"consultation-delete": ({ facts }) => {
			if (!consultationSectionFacts(facts)) return;
			const selected = facts.selectedConsultation;
			if (selected === undefined) return;
			f.setPanel({ kind: "consultation-delete", identity: selected.id });
		},
	};
}

/** The schedule's controls: schedule, respond, interact, override, recover. */
function appKeyConsultationOpsHandlers(f: AppKeyHandlerFields): Record<string, ControlHandler> {
	return {
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
			const operations = f.consultationOperations;
			if (operations === undefined) {
				f.setWarningMessage("Consultations require SQLite state");
				return;
			}
			void operations.checkEnqueue(selected.typeName).then((refusal) => {
				if (refusal !== undefined) {
					f.setWarningMessage(`consultation not scheduled: ${refusal}`);
					return;
				}
				// The operations own the Message line and the Consultation rows,
				// but the queue rows re-read only here: the item lands at the
				// queue's tail in the same write the section's Delete path
				// refreshes, so the schedule path does the same. An immediate
				// pickup pass follows every enqueue (ADR 0049), so the scheduled
				// record takes a free seat in this tick instead of waiting for the
				// next poll; the pause and the cap are the pickup's own checks.
				const scheduled = operations.schedule(selected);
				if (scheduled) {
					f.replaceTickets();
					void f.handoffDispatchRef.current?.dispatch.pickupWorkQueue();
				}
			});
		},
		"consultation-respond": ({ facts }) => {
			if (!consultationSectionFacts(facts)) return;
			const selected = facts.selectedConsultation;
			if (selected === undefined) return;
			f.beginResponse(selected);
		},
		"consultation-interact": () => f.setInteraction(true),
		override: f.openOverride,
		recover: ({ facts }) => {
			if (!consultationSectionFacts(facts)) return;
			const selected = facts.selectedConsultation;
			if (selected?.state === "opening") f.recoverConsultationOpening(selected);
		},
	};
}

/** The start-now and goto controls: the record's own starts. */
function appKeyConsultationStartHandlers(f: AppKeyHandlerFields): Record<string, ControlHandler> {
	return {
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
			const operations = f.consultationOperations;
			if (operations === undefined) {
				f.setWarningMessage("Consultations require SQLite state");
				return;
			}
			// The line states only what the key measured, the way the
			// queue's force-dispatch line does: the cap stands when the
			// seat count stood over the limit at the key.
			const cap = f.configRef.current.maxParallelAgents;
			const overCap = overParallelLimit(cap, f.currentSeatCount());
			void operations.pickup(selected.id, "force-dispatch").then((outcome) => {
				if (outcome.kind === "moved") {
					f.setWarningMessage(
						`consultation ${selected.id.slice(0, 8)}: the record is no longer unscheduled`,
					);
					return;
				}
				if (outcome.kind === "started")
					f.setNoticeMessage(
						overCap
							? `starting Consultation ${selected.id.slice(0, 8)} over the Parallel limit`
							: `starting Consultation ${selected.id.slice(0, 8)}`,
						"info",
					);
			});
		},
		"consultation-goto": ({ facts }) => {
			if (!consultationSectionFacts(facts)) return;
			const selected = facts.selectedConsultation;
			if (selected === undefined || selected.paneId === null) return;
			// Navigation only (ADR 0025): the Consultation record stays
			// untouched, and the confirmation stands on the Message line
			// as a result, never as a warning. The Goto moves herdr's view
			// to the Agent's pane (ADR 0061), and the line names the
			// workspace it landed in.
			void f.commandRunner
				.run("herdr", ["agent", "focus", selected.paneId])
				.then(async (result) => {
					if (result.code !== 0) {
						f.setErrorMessage(`agent focus failed: ${commandFailureText(result)}`);
						return;
					}
					const workspaceId = selected.workspaceId;
					const label = workspaceId === null ? null : await f.workspaceLabelOf(workspaceId);
					f.reportMessage({
						severity: "info",
						text:
							label === null
								? `focused the Agent pane for Consultation ${selected.id.slice(0, 8)}`
								: `focused the Agent pane for Consultation ${selected.id.slice(0, 8)} in workspace ${label}`,
					});
				});
		},
	};
}

/** The plane-wide controls: refresh, pause, jump, auto-handoff, help. */
function appKeyPlaneHandlers(f: AppKeyHandlerFields): Record<string, ControlHandler> {
	return {
		refresh: () => {
			// Refresh answers for the whole plane: the Ticket sources, and
			// the Consultation projection while its section is visible or its
			// Consultation is under the cursor.
			if (f.consultationsExpandedRef.current || f.selectionRef.current === "consultation")
				f.replaceConsultations();
			f.refreshNow();
		},
		// The brake reaches the whole plane (issue #319, ADR 0111): the
		// one toggle stands in its own function, and every surface that
		// dispatches the key runs it through the callback the screen owns.
		"queue-pause": () => f.toggleQueuePause(),
		// Enter on a Ticket or Consultation row that waits in the Work
		// queue (ADR 0049): the cursor jumps to the item's row, where the
		// queue's keys act on it. The catalogue resolved it ahead of the
		// other Enter meanings, so this only moves the cursor and never
		// starts or decides.
		"queue-jump": ({ facts }) => {
			if (facts.mode !== "ticket-list" && facts.mode !== "consultation-list") return;
			const item = facts.queueItemForSelectedRow;
			if (item === null) return;
			const index = f.workQueueRef.current.findIndex(
				(candidate) => workQueueIdentityOf(candidate) === workQueueIdentityOf(item),
			);
			if (index < 0) return;
			f.selectionRef.current = "queue";
			f.setSelection("queue");
			f.workQueueIndexRef.current = index;
			f.setWorkQueueIndex(index);
			f.setWorkExpanded(true);
			f.workExpandedRef.current = true;
			f.cursor.focusPane("list");
		},
		// `a` answers for the switch itself in the Ticket section, where
		// the catalog binds it: reaching the state must never depend on
		// whether a Consultation needs the operator. The Consultation
		// section does not bind the key, so `a` there is the catalog's
		// refusal, not this action.
		"auto-handoff": () => f.toggleAutoHandoff(),
	};
}

/**
 * The shell's key handler for the Main view: the overlay guards, the Agent
 * interaction mode, and the control catalogue's one dispatch.
 */
function appKeyHandler(f: AppKeyHandlerFields, key: KeyEvent): void {
	// Overlays own their keys: the launcher, the utility views, the
	// override panel, and the action modals all handle input in their
	// own keyboard hooks.
	if (f.utility !== null || f.override !== null || f.panel !== null || f.launcher) {
		// The legacy Consultations surfaces keep their pre-catalogue key
		// switches, and none of them may claim the emergency exit. The
		// catalogue-driven surfaces destroy through that same control
		// anyway; the shell owns the exit for the rest.
		if (key.ctrl === true && key.name === "c") f.renderer.destroy();
		return;
	}
	// The shell owns the emergency exit before the Agent terminal matches a
	// key, so Ctrl+C cannot reach an Agent. Every other surface dispatches
	// Ctrl+C through the control catalogue below.
	if (f.interaction && key.ctrl === true && key.name === "c") {
		f.renderer.destroy();
		return;
	}
	// The response editor is a shared form surface: its field and actions
	// answer the keys there, and nothing below may claim them. The shell
	// keeps the emergency exit, because the field takes every other Ctrl key
	// as text editing.
	if (f.responseEditor && key.ctrl === true && key.name === "c") {
		f.renderer.destroy();
		return;
	}
	if (f.responseEditor) return;
	if (f.interaction) {
		appKeyInteractionHandler(f, key);
		return;
	}
	// The control catalogue decides every key on the Main view, through the
	// same dispatch hook every modal, panel, and overlay uses.
	const mode = f.currentBaseMode();
	createControlDispatch({
		facts: f.mainFacts(),
		ungated: ["decide-completion", "handoff", "live-view"],
		onUnavailable: f.setWarningMessage,
		onEmergencyExit: () => f.renderer.destroy(),
		handlers: {
			...appKeyTicketHandlers(f),
			...appKeyQueueHandlers(f),
			...appKeyLauncherHandlers(f),
			...appKeyConsultationRecordHandlers(f),
			...appKeyConsultationOpsHandlers(f),
			...appKeyConsultationStartHandlers(f),
			...appKeyPlaneHandlers(f),
			help: () => f.openGuide(mode),
			message: () => f.openMessage(mode),
		},
	})(key);
}

/** The fields the Consultation session refresh effect reads and writes. */
interface AppConsultationSessionFields {
	state: AppAggregates | undefined;
	selection: "ticket" | "consultation" | "queue";
	selectedConsultation: Consultation | undefined;
	setLiveOutput: (value: string | null) => void;
	setSessionEntries: (value: readonly SessionEntry[] | null) => void;
	agentsRef: RefObject<readonly HerdrAgent[] | null>;
	configRef: RefObject<FactoryConfig>;
	commandRunner: CommandRunner;
	consultationOperations: ConsultationOperations | undefined;
	interaction: boolean;
	consultationFollowRef: RefObject<boolean>;
	setConsultationScroll: (value: number) => void;
	setNewOutput: (value: boolean) => void;
	outputRefreshRef: RefObject<(() => void) | null>;
}

/** The session record read the effect takes for the selected Consultation. */
function consultationSessionRead(f: AppConsultationSessionFields, consultation: Consultation) {
	const sessionPath = (): string => {
		const polled = f.agentsRef.current;
		if (polled === null) return "";
		const match = matchConsultationAgent(consultation, polled);
		return match === undefined || match === "ambiguous" ? "" : match.sessionId;
	};
	return (): readonly SessionEntry[] | null => {
		const kind = f.configRef.current.agents[consultation.agentType]?.kind;
		const path = sessionPath();
		const read =
			kind !== undefined && path !== ""
				? readSessionExchange(kind, path)
				: ({ kind: "unavailable" } as const);
		return read.kind === "readable" ? read.entries : null;
	};
}

/** One tick of the Consultation pane and session read. */
async function consultationPaneRefresh(
	f: AppConsultationSessionFields,
	tick: {
		reader: HerdrAgentReader;
		consultation: Consultation;
		paneId: string;
		readSessionNow: () => readonly SessionEntry[] | null;
		previous: { current: string | null };
		active: { current: boolean };
	},
): Promise<void> {
	const output = f.interaction
		? await tick.reader.readPaneAnsi(tick.paneId, f.configRef.current.completionMessageLines)
		: await tick.reader.readPane(tick.paneId, f.configRef.current.completionMessageLines);
	if (!tick.active.current) return;
	f.consultationOperations?.recordOutputRead(tick.consultation.id, output);
	const session = f.interaction ? null : tick.readSessionNow();
	if (!tick.active.current) return;
	if (output !== null) f.setLiveOutput(output);
	f.setSessionEntries(session);
	// The body the operator is looking at: the Session view when it
	// renders, the pane read otherwise. Its growth is what the
	// follow and the new-output marker watch.
	const shown =
		session !== null && session.length > 0
			? JSON.stringify(session)
			: f.interaction
				? null
				: output;
	const changed = shown !== null && shown !== tick.previous.current;
	tick.previous.current = shown;
	if (f.consultationFollowRef.current) {
		f.setConsultationScroll(999999);
		f.setNewOutput(false);
	} else if (changed) {
		f.setNewOutput(true);
	}
}

/**
 * The selected Consultation's bodies refresh at one-second cadence. The
 * pane read stays on its own interval, and the Session view (ADR 0025)
 * reads the Agent's session record in the same tick. Lifecycle polling
 * remains owned by the shared observation coordinator. A closed
 * Consultation is a record the operator reads: its detail pane shows the
 * session record when it reads, else the captured history, and the
 * record does not grow while nothing runs, so it gets one read and no
 * timer.
 */
function appConsultationSessionRefresh(f: AppConsultationSessionFields): (() => void) | undefined {
	if (
		f.state === undefined ||
		f.selection !== "consultation" ||
		f.selectedConsultation === undefined
	) {
		f.setLiveOutput(null);
		f.setSessionEntries(null);
		return undefined;
	}
	const consultation = f.selectedConsultation;
	const paneId = consultation.paneId;
	const readSessionNow = consultationSessionRead(f, consultation);
	if (paneId === null || consultation.state === "closed") {
		// A closed Consultation, or one whose Agent pane is gone: one
		// read of the record, then the captured history stands in.
		f.setLiveOutput(null);
		f.setSessionEntries(readSessionNow());
		return undefined;
	}
	let active = true;
	const activeBox = { current: active };
	const previous = { current: null as string | null };
	const reader = new HerdrAgentReader(f.commandRunner);
	const tick = { reader, consultation, paneId, readSessionNow, previous, active: activeBox };
	const refresh = async () => {
		await consultationPaneRefresh(f, tick);
	};
	f.outputRefreshRef.current = () => void refresh();
	void refresh();
	const timer = setInterval(() => void refresh(), f.interaction ? 250 : 1000);
	return () => {
		active = false;
		f.outputRefreshRef.current = null;
		clearInterval(timer);
	};
}

/** The fields the observation coordinator effect reads and writes. */
interface AppObservationFields {
	state: AppAggregates | undefined;
	handoffDispatch: HandoffDispatch | undefined;
	initialTickets: readonly Ticket[] | undefined;
	pollIntervalMs: number | undefined;
	commandRunner: CommandRunner;
	configRef: RefObject<FactoryConfig>;
	autoModeRef: RefObject<boolean>;
	replaceTickets: () => void;
	replaceConsultations: () => void;
	setAgents: Dispatch<SetStateAction<readonly HerdrAgent[] | null>>;
	setBell: (value: boolean) => void;
	attention: AttentionService;
	onReady: ((ready: AppTeardown) => void) | undefined;
	clearOperationMessage: (owner: ProgressOwner) => void;
	setStatus: (next: StatusMessage | null) => void;
	refreshTicketSources: (identity: string) => void;
	closeCycleEndDraft: (identity: string) => void;
	refreshPullRequestSources: () => Promise<void>;
	logger: Logger | undefined;
	observationRef: RefObject<ObservationCoordinator | undefined>;
	coordinatorRef: RefObject<RefreshCoordinator | undefined>;
	handoffDispatchRef: RefObject<
		{ state: HandoffDispatchAggregates; dispatch: HandoffDispatch } | undefined
	>;
}

/** The coordinator's base options: the plane's reads and the report lines. */
type AppObservationOptions = ConstructorParameters<typeof ObservationCoordinator>[0];

function observationCoordinatorBase(
	f: AppObservationFields,
	state: AppAggregates,
	dispatch: HandoffDispatch,
): Omit<AppObservationOptions, "cleanup"> {
	return {
		state,
		herdr: new HerdrAgentReader(f.commandRunner),
		config: () => f.configRef.current,
		dispatch: (intent) => dispatch.dispatch(intent),
		// The plane action's ask (ADR 0068): the top-up's walks cross it for
		// the positions their task type resolves on the plane action.
		dispatchPlaneAction: (intent) => dispatch.dispatchPlaneAction(intent),
		// The Work queue's pickup (ADR 0034): the cycle starts the waiting
		// manual starts before auto-dispatch, in queue order.
		pickupWorkQueue: () => dispatch.pickupWorkQueue(),
		now: () => Date.now(),
		mode: () => f.autoModeRef.current,
		// The Ticket header's seat count and the cycle's gates share this
		// grace, so the booting seats they count agree.
		startupGraceMs: STARTUP_GRACE_MS,
		intervalMs: f.pollIntervalMs ?? f.configRef.current.agentPollIntervalSeconds * 1000,
		onChanged: () => {
			f.replaceTickets();
			f.replaceConsultations();
		},
		onAgents: (agents) => f.setAgents(agents),
		onConsultationsChanged: f.replaceConsultations,
		onConsultationAttention: (_id) => {
			// The flash stays here; the bell write and its attention-bell gate
			// live in the shared attention service (ADR 0080).
			f.setBell(true);
			setTimeout(() => f.setBell(false), 250);
			f.attention.ring();
		},
		reconcileOnly: true,
		// The cycle's record lines: each hold its automatic walks take
		// (issue #223).
		log: f.logger,
		onStatus: (kind, text, topic) => {
			// Both sections read the same observation events: an outcome is
			// a fact for the one Message line, whichever section is expanded.
			// `setStatus` maps the observation's kinds onto that line: info
			// becomes a notice, warning a warning, and error an error. The
			// observation sends only the facts an operator acts on, so the
			// Message line stays a statement of the plane and not a log.
			f.setStatus({ kind, text });
			// The recovery topic is the structured signal that a stale
			// operation fact can clear; the text stays human-facing. The
			// observation writes no progress line of its own.
			if (topic === "herdr-recovered") f.clearOperationMessage("none");
		},
	};
}

/** The coordinator's transition flows: fire, re-fire, cycle end, cleanup. */
function observationCoordinatorFlows(
	f: AppObservationFields,
	state: AppAggregates,
	dispatch: HandoffDispatch,
): Pick<AppObservationOptions, "cleanup" | "fireCompleted" | "refireRecordedSkips" | "onCycleEnd"> {
	return {
		// The transition fire of a completed settle (ADR 0027): pull the
		// pull request sources fresh - the agent's new pull request must
		// be in the list before the machine can find it - and fire the
		// task type's transition through the command runner.
		fireCompleted: async (ticket) => {
			return await fireTransition({
				config: f.configRef.current,
				state,
				runner: f.commandRunner,
				ticketIdentity: ticket.ticketIdentity,
				taskType: ticket.taskType,
				refresh: f.refreshPullRequestSources,
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
				config: f.configRef.current,
				state,
				runner: f.commandRunner,
				refresh: f.refreshPullRequestSources,
			}),
		// The cycle's end may have changed the ticket's source item (a merged
		// pull request, a closed issue): re-read the sources now, so the
		// ticket is re-verified - or drops off the list - before the next
		// automatic dispatch of it.
		onCycleEnd: (identity) => {
			f.refreshTicketSources(identity);
			f.closeCycleEndDraft(identity);
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
	};
}

/**
 * The observation loop runs only on the real projection: a test
 * projection has no agents to observe, and a deterministic frame test
 * must not race a poll.
 */
function appObservationCoordinator(f: AppObservationFields): (() => void) | undefined {
	const dispatch = f.handoffDispatch;
	if (f.state === undefined || dispatch === undefined || f.initialTickets !== undefined)
		return undefined;
	const state = f.state;
	const coordinator = new ObservationCoordinator({
		...observationCoordinatorBase(f, state, dispatch),
		...observationCoordinatorFlows(f, state, dispatch),
	});

	f.observationRef.current = coordinator;
	coordinator.start();
	f.onReady?.({
		stop: () => {
			f.coordinatorRef.current?.stop();
			f.observationRef.current?.stop();
			// The handoff dispatch is the one background loop that outlives the
			// state: its run settles asynchronously, so stop it before the
			// owner closes the state, or the settlement reads a closed database.
			f.handoffDispatchRef.current?.dispatch.stop();
		},
	});
	return () => {
		// Only the loop this run made. The dispatch module outlives it: the
		// effect re-runs on a config write-back, and a stopped module is a
		// plane that starts nothing for the rest of the run.
		coordinator.stop();
		f.observationRef.current = undefined;
	};
}

/** The fields the App's operations read and write. */
interface AppOpsFields {
	state: AppAggregates | undefined;
	configRef: RefObject<FactoryConfig>;
	setConfig: (config: FactoryConfig) => void;
	commandRunner: CommandRunner;
	homeDir: string;
	configFile: string;
	logger: Logger | undefined;
	modelListRequest: RefObject<number>;
	setModelList: Dispatch<SetStateAction<AgentModelList>>;
	configWriteQueue: RefObject<Promise<void>>;
	handoffDispatchRef: RefObject<
		{ state: HandoffDispatchAggregates; dispatch: HandoffDispatch } | undefined
	>;
	consultationOperationsRef: RefObject<ConsultationOperations | undefined>;
	currentSeatCount: () => number;
	currentMissingSeatTickets: () => string[];
	listViewsRef: RefObject<TicketListViews>;
	setStartingTickets: Dispatch<SetStateAction<ReadonlySet<string>>>;
	setWorkingMessage: (message: string, owner: WorkingOwner) => void;
	setWarningMessage: (message: string) => void;
	setErrorMessage: (message: string) => void;
	setFaultWarningMessage: (message: string) => void;
	setFaultErrorMessage: (message: string) => void;
	setNoticeMessage: (message: string, severity?: "info" | "warning") => void;
	clearWorkingMessage: (owner: ProgressOwner) => void;
	clearProgressMessage: (owner: ProgressOwner) => void;
	replaceTickets: () => void;
	replaceConsultations: () => void;
	setStatus: (next: StatusMessage | null) => void;
	setConsultationSafety: Dispatch<
		SetStateAction<{ consultationId: string; safety: LiveCheckoutSafety } | null>
	>;
	setPanel: (panel: Panel) => void;
}

/**
 * The Model list of the agent the override panel is on (ADR 0010). The
 * panel asks for it when it opens and whenever the operator switches
 * agents inside it, so it reflects provider auth changed after startup.
 * There is no cache: every request runs a fresh query, and a request a
 * newer one overtakes is dropped.
 */
function appRequestModelList(f: AppOpsFields, agentType: string): void {
	const request = f.modelListRequest.current + 1;
	f.modelListRequest.current = request;
	const agent = f.configRef.current.agents[agentType];
	const settle = (status: ModelListStatus) => {
		// Only the newest request may show: a stale answer for another
		// agent must never reach the row.
		if (f.modelListRequest.current !== request) return;
		f.setModelList({ agentType, status });
	};
	if (agent === undefined || agent.model === undefined || !supportsModelList(agent.kind)) {
		// The kind reports no list: the row keeps the Text field, and no
		// agent CLI runs for it.
		settle({ status: "unavailable", cause: "no-list" });
		return;
	}
	settle({ status: "loading" });
	void f.commandRunner
		.listModels(agent.kind)
		.then((result) =>
			settle(
				result.ok
					? { status: "available", models: result.models }
					: { status: "unavailable", cause: "query-failed" },
			),
		)
		.catch(() => settle({ status: "unavailable", cause: "query-failed" }));
}

/**
 * The resolved Task profile of the ticket's suggested task type: the
 * panel prefills it, and Enter applies it (ADR 0009). The operator
 * changes a row in the panel, or clears one to leave the setting to the
 * agent. A ticket on a parking state suggests nothing, and the plane
 * starts nothing on its own: this manual path is the operator's choice,
 * so it prefills the default task type (ADR 0027).
 */
function appChoiceFor(f: AppOpsFields, ticket: Ticket): HandoffChoice {
	return resolveHandoffChoice(
		f.configRef.current,
		ticket.suggestedTaskType ?? f.configRef.current.defaultTaskType,
	);
}

/**
 * The repository mapping write-back: the `[repos]` key the mapping owns,
 * through the config write queue, with the shared line wording.
 */
function appPersistMapping(
	f: AppOpsFields,
	mapping: RepositoryMapping,
): Promise<ConfigWriteReport | undefined> {
	const write = f.configWriteQueue.current
		.catch(() => undefined)
		.then(async (): Promise<ConfigWriteReport | undefined> => {
			try {
				const currentConfig = f.configRef.current;
				const updated = {
					...currentConfig,
					repos: { ...currentConfig.repos, [mapping.repository]: mapping.path },
				};
				f.configRef.current = updated;
				f.setConfig(updated);
				// The write-back edits the `[repos]` key it owns and leaves the
				// rest of the operator's file where they put it (ADR 0103). The
				// line names the file the write landed on.
				const fact = await writeConfigFile(f.configFile, updated);
				const line = configWriteLine(fact, "saved the mapping");
				return line === "" ? undefined : { line, landed: true, mode: fact.mode };
			} catch (error) {
				return {
					line: `could not persist the repository mapping: ${errorMessage(error)}`,
					landed: false,
				};
			}
		});
	f.configWriteQueue.current = write.then(
		() => undefined,
		() => undefined,
	);
	return write;
}

/**
 * The Handoff dispatch and the Consultation operations of the run: one
 * module pair on the state, built once per state, the dispatch first so
 * the operations can cross its Shared checkout hold (issue #315,
 * ADR 0109).
 */
function appHandoffDispatchOptions(f: AppOpsFields, state: AppAggregates): HandoffDispatchOptions {
	return {
		state,
		runner: f.commandRunner,
		config: () => f.configRef.current,
		seatCount: f.currentSeatCount,
		// The seats a Missing Agent left, each one reserved for its own
		// restart row (ADR 0108): the pickup hands them to no other start.
		missingSeatTickets: f.currentMissingSeatTickets,
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
			f.consultationOperationsRef.current?.pickup(consultationId, mode) ??
			Promise.resolve({ kind: "moved" } as const),
		// The Consultation side of the Shared checkout gate (issue #315,
		// ADR 0109): the row the bound ends refuses in the record state the
		// Consultation operations write, beside the row the dispatch drops and
		// the refusal line it records.
		refuseConsultationPickup: (consultationId, fact) => {
			f.consultationOperationsRef.current?.refusePickup(consultationId, fact);
		},
		home: f.homeDir,
		working: (text) => f.setWorkingMessage(text, "handoff"),
		// The line-only writers (ADR 0118): the module's attended answers
		// and the plain results of the operator's own keys.
		warning: f.setWarningMessage,
		error: f.setErrorMessage,
		// The Fault writers: the line plus the desktop notification, for
		// the facts the plane met on its own.
		faultWarning: f.setFaultWarningMessage,
		faultError: f.setFaultErrorMessage,
		notice: f.setNoticeMessage,
		clearWorking: () => f.clearWorkingMessage("handoff"),
		refresh: f.replaceTickets,
		starting: (identity, active) => {
			f.setStartingTickets((current) => {
				if (current.has(identity) === active) return current;
				const next = new Set(current);
				if (active) next.add(identity);
				else next.delete(identity);
				return next;
			});
		},
		persistMapping: (mapping) => appPersistMapping(f, mapping),
		log: f.logger,
	};
}

/** The Consultation operations of the run, created once per state. */
function appConsultationOperations(f: AppOpsFields): void {
	// Capture state, replaceConsultations, and persistMapping once per mount.
	// The state is created once by factory.ts, and the other callbacks read
	// the current config and projections through refs. The dispatch block above
	// runs first on purpose (issue #315, ADR 0109): the operations cross the
	// dispatch's Shared checkout hold through the seam it exposes, and the
	// dispatch is built on this same state.
	if (f.consultationOperationsRef.current !== undefined || f.state === undefined) return;
	const state = f.state;
	f.consultationOperationsRef.current = createConsultationOperations({
		state,
		runner: f.commandRunner,
		config: () => f.configRef.current,
		home: f.homeDir,
		// The rows the machine reads, never the operator's List filter (ADR 0060):
		// the live-checkout conflict read names the in-flight Ticket whose Agent
		// holds the checkout, and a Ticket the operator judged out of the list is
		// still live work the confirmation has to name.
		tickets: () => f.listViewsRef.current.active,
		// The one shared seat count the Parallel limit gate and the mode cell
		// read: the Consultation start line states the reading this seam
		// answers, measured before the start takes its own seat (issue #220).
		seatCount: f.currentSeatCount,
		log: f.logger,
		persistRepositoryMapping: (mapping) => appPersistMapping(f, mapping),
		// The Shared checkout hold of the run (issue #315, ADR 0109): the gate a
		// worktree Consultation start crosses at its claim, the take the claim
		// runs, and the let-go where the opening settles. The dispatch owns the
		// ledger the seam crosses, so the module crosses the dispatch's one gate
		// and never a second state machine beside it.
		checkoutHold: f.handoffDispatchRef.current?.dispatch.checkoutHold,
		callbacks: {
			onStatus: f.setStatus,
			// Each Consultation operation owns its progress line, so two
			// operations in two repositories never erase one another.
			onProgress: (text, owner) =>
				text === null
					? f.clearProgressMessage(consultationProgressOwner(owner))
					: f.setWorkingMessage(text, consultationProgressOwner(owner)),
			onConsultationsChanged: f.replaceConsultations,
			onSafetyConflict: ({ consultationId, safety }) => {
				f.setConsultationSafety({ consultationId, safety });
				f.setPanel({ kind: "consultation-safety", identity: consultationId });
			},
		},
	});
}

/**
 * The Handoff dispatch and the Consultation operations of the run: one
 * module pair on the state, built once per state, the dispatch first so
 * the operations can cross its Shared checkout hold (issue #315,
 * ADR 0109).
 */
function appHandoffDispatches(f: AppOpsFields): {
	consultationOperations: ConsultationOperations | undefined;
	handoffDispatch: HandoffDispatch | undefined;
} {
	if (f.state === undefined) f.handoffDispatchRef.current = undefined;
	else if (f.handoffDispatchRef.current?.state !== f.state) {
		const state = f.state;
		f.handoffDispatchRef.current = {
			state,
			dispatch: createHandoffDispatch(appHandoffDispatchOptions(f, state)),
		};
	}
	appConsultationOperations(f);
	return {
		consultationOperations: f.consultationOperationsRef.current,
		handoffDispatch: f.handoffDispatchRef.current?.dispatch,
	};
}

/**
 * Report the Close cleanup of one ended cycle.
 *
 * The module answers with herdr's failure and keeps the durable fact of the
 * environment that survived it; the wording of the line is the caller's, so
 * the operator's Close, an Abandon, and the automatic close each keep their
 * own existing words for the same fact.
 */
function appRunCloseCleanup(
	f: AppOpsFields,
	identity: string,
	handoff: StoredHandoffFacts,
	end: "closed" | "abandoned",
): void {
	const dispatch = f.handoffDispatchRef.current?.dispatch;
	if (dispatch === undefined) return;
	void dispatch.closeCleanup(identity, handoff, end).then(
		(failure) => {
			if (failure !== undefined)
				f.setFaultErrorMessage(`ticket ${identity} ${end}; the close cleanup failed: ${failure}`);
		},
		(error) => {
			f.setFaultErrorMessage(
				`ticket ${identity} ${end}; the close cleanup could not be reported: ${errorMessage(error)}`,
			);
		},
	);
}

/** The fields the App's ticket decision operations read and write. */
interface AppTicketOpsFields extends AppOpsFields {
	findTicket: (identity: string) => Ticket | undefined;
	listViews: TicketListViews;
	workQueueRef: RefObject<readonly WorkQueueItem[]>;
	startingTicketsRef: RefObject<ReadonlySet<string>>;
	overrideRef: RefObject<PendingOverride | null>;
	setOverride: (panel: PendingOverride | null) => void;
	panel: Panel;
	setNewsMessage: (message: string) => void;
	reportMessage: (fact: MessageFact) => void;
	autoModeRef: RefObject<boolean>;
	setAutoMode: (value: boolean) => void;
	setQueuePaused: (value: boolean) => void;
	handoffDispatch: HandoffDispatch | undefined;
	agentsRef: RefObject<readonly HerdrAgent[] | null>;
	coordinatorRef: RefObject<RefreshCoordinator | undefined>;
	mainFacts: () => AvailabilityFacts;
	ticketRowsRef: RefObject<readonly ListedRow<TicketRowFacts>[]>;
	selectedIndexRef: RefObject<number>;
	choiceFor: (ticket: Ticket) => HandoffChoice;
	startHandoff: (ticket: Ticket, choice: HandoffChoice) => void;
	closeCycleEndDraft: (identity: string) => void;
	clearOperationMessage: (owner: ProgressOwner) => void;
	refireInFlightRef: RefObject<string | null>;
}

/** Re-read the sources that list one ticket, now. */
function appRefreshTicketSources(f: AppTicketOpsFields, identity: string): void {
	const state = f.state;
	if (state === undefined) return;
	const coordinator = f.coordinatorRef.current;
	if (coordinator === undefined) return;
	for (const sourceName of state.sourceFact.membershipSourceNames(identity)) {
		coordinator.refreshNow(sourceName);
	}
}

/**
 * Report the outcome of the handoffs that stayed in the App: the no-state
 * test projection. State-backed Ticket handoffs report through the dispatch
 * module, and both cross the one shared wording in `reportHandoffOutcome`,
 * so the parts of the line and the channel each one belongs on have one
 * owner.
 */
function appFinishOutcome(f: AppTicketOpsFields, outcome: HandoffOutcome): Promise<void> {
	return reportHandoffOutcome(
		outcome,
		{
			clearWorking: () => f.clearWorkingMessage("handoff"),
			// The outcome of a start the plane ran: a Fault (ADR 0118), the
			// way the state-backed dispatch reports it.
			faultWarning: f.setFaultWarningMessage,
			faultError: f.setFaultErrorMessage,
		},
		(mapping) => appPersistMapping(f, mapping),
	);
}

/**
 * Open the override panel for the Ticket at the cursor (ADR 0045).
 */
function appOpenOverride(f: AppTicketOpsFields): void {
	const overrideControl = controlById("override");
	const availability = availabilityFor(overrideControl, f.mainFacts());
	if (!availability.available) {
		f.setWarningMessage(refusalText(overrideControl, availability));
		return;
	}
	const row = f.ticketRowsRef.current[f.selectedIndexRef.current];
	// A Group header holds no Ticket: the catalogue refused the key with its
	// own words before this ran (issue #159).
	if (row === undefined || row.kind !== "item") return;
	const ticket = row.item.ticket;
	const choice = f.choiceFor(ticket);
	// Opening the panel is a point of use for the Model list (ADR 0010): the
	// list of the agent the panel starts on is fetched fresh, so provider
	// auth the operator changed after startup shows up here.
	appRequestModelList(f, choice.agentType);
	f.setOverride({
		ticketIdentity: ticket.identity,
		origin: "open",
		choice,
	});
}

/**
 * Start the handoff the override panel confirmed.
 *
 * The claim happens here, not when the panel opened: an operator who
 * presses Esc leaves the ticket exactly where it was, with no attempt
 * recorded.
 */
function appConfirmOverride(f: AppTicketOpsFields, choice: HandoffChoice): void {
	const pending = f.overrideRef.current;
	f.setOverride(null);
	if (pending === null) return;
	// The projection before the list rule (ADR 0042, ADR 0060): the override
	// confirms the Ticket it named, whether or not the list still holds the row.
	const ticket = f.findTicket(pending.ticketIdentity);
	if (ticket === undefined) {
		f.setWarningMessage("the ticket no longer exists");
		return;
	}
	if (pending.origin === "workflow") {
		// A route confirmed from the Live view keeps the screen open, like
		// the direct route: the stream moves to the new pane on the next
		// tick. A refused claim comes back to the decision sub-mode, where
		// the route row still stands.
		if (pending.returnTo.kind === "live") {
			// The screen returns to the cycle the operator left, and the route's
			// ask ends that cycle: the view goes back to the list when the
			// cycle's number moves (ADR 0072, ADR 0110).
			f.setPanel(pending.returnTo);
		}
		appRunRouteHandoff(f, ticket, ticket.lastCompletion?.transition ?? null, choice);
		return;
	}
	f.startHandoff(ticket, choice);
}

/**
 * Leave the override panel with no handoff.
 *
 * A route edit returns to the panel it opened from - the decision modal
 * or the Live view's decision sub-mode: only the edit is dropped, the
 * turn is still undecided. An open-ticket edit returns to the list, where
 * it started.
 */
function appCancelOverride(f: AppTicketOpsFields): void {
	const pending = f.overrideRef.current;
	f.setOverride(null);
	if (pending?.origin === "workflow") {
		f.setPanel(pending.returnTo);
	}
}

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
function appToggleAutoHandoff(f: AppTicketOpsFields): void {
	const next = !f.autoModeRef.current;
	f.autoModeRef.current = next;
	f.setAutoMode(next);
	const modeLine = `mode: auto-handoff is ${next ? "on" : "off"}`;
	const sessionOnly = `auto-handoff is ${next ? "on" : "off"} for this session only`;
	// The mode decides every automatic walk in the run, so the record names it
	// when it moves. A plane with no state file has nothing to persist, and the
	// record says so: a file that claims the mode moved while no run reads it back
	// is the same untrustworthy line a refused write leaves (issue #223 review).
	// Both session-only lines carry `warn`, the level the configuration reference
	// states for them, so a run filtered to `warn` keeps the news that the next
	// run reads nothing back.
	if (f.state === undefined) {
		f.logger?.warn(`${modeLine} for this session only: the plane runs with no state file`);
		return;
	}
	try {
		f.state.handoff.setAutoHandoffMode(next);
		f.logger?.info(modeLine);
	} catch (error) {
		const reason = errorMessage(error);
		f.logger?.warn(`${modeLine} for this session only: ${reason}`);
		f.setErrorMessage(`${sessionOnly}: ${reason}`);
	}
}

/**
 * `p` pauses or resumes the Work queue's drain (ADR 0052): the pickup takes
 * no item and the top-up adds none while the pause stands, and the
 * force-dispatch passes it. The state's one write owns the fact; resuming
 * asks the pickup for one more item, so the seat the pause gave back frees
 * in the same frame the key landed.
 *
 * The brake reaches the whole plane (issue #319, ADR 0111), so the toggle
 * stands in one place and every surface that dispatches the key runs it:
 * the base panes and the modals, the Live view, the panels, and the
 * utility overlays all press through to this one write. The write is
 * guarded the way the Auto-handoff mode's identical fact is (ADR 0052).
 * What differs is what a refused write means: the pickup and the top-up
 * read the pause from the state, not from this shell's copy, so a write
 * that failed left the brake where it stood. The key says so and moves
 * nothing - the corner's lamp, the border's lamp, the bar's hint, and the
 * drain all keep reading the value that stands.
 */
function appToggleQueuePause(f: AppTicketOpsFields): void {
	const { state, setQueuePaused } = f;
	if (state === undefined) return;
	const next = !state.workQueue.queuePaused();
	try {
		state.workQueue.setQueuePaused(next);
	} catch (error) {
		const reason = errorMessage(error);
		// The refused write leaves its record line the way the Auto-handoff
		// mode's identical failure does, so two facts of one kind do not fail
		// two ways (issue #223 review). The line is `warn`: the operator
		// pressed the key and the brake did not move.
		f.logger?.warn(`queue: the Work queue pause did not move: ${reason}`);
		f.setErrorMessage(`the queue pause did not move: ${reason}`);
		return;
	}
	setQueuePaused(next);
	// The pause is the other fact the operator sets by key, and it holds
	// every automatic add while it stands (issue #223). The `queue:` prefix
	// keeps this line in its own family: the cycle states its own hold line
	// about the same fact, and a reader grepping one must not get the other.
	f.logger?.info(next ? "queue: the Work queue is paused" : "queue: the Work queue resumed");
	f.setNoticeMessage(next ? "Work queue paused" : "Work queue resumed", "info");
	if (!next) void f.handoffDispatch?.pickupWorkQueue();
}

/** The method the merge action runs with, from the task type's action form (ADR 0068). */
function appMergeMethodOf(f: AppTicketOpsFields, taskType: string): string {
	return (
		planeActionSettingOf(f.configRef.current.taskTypes, taskType)?.method ?? DEFAULT_MERGE_METHOD
	);
}

/** The action rows the decision modal wears, with the decision facts. */
function appDecisionActions(
	f: AppTicketOpsFields,
	outcome: TransitionOutcome | null,
	facts: DecisionFacts,
): ActionRow[] {
	const actions: ActionRow[] = [
		{ key: "close", label: "Close", detail: "end the work cycle; the ticket returns to open" },
		{ key: "goto", label: "Goto", detail: "focus the agent's pane; the handoff stays open" },
	];
	if (outcome !== null && facts.offer !== null) {
		if (facts.offer.kind === "merge") {
			actions.push({
				key: "merge",
				label: planeActionLabel("merge-pull-request"),
				detail: `runs the merge now, with no agent and no worktree (method ${appMergeMethodOf(f, facts.offer.taskType)})`,
				planeAction: true,
			});
		} else {
			actions.push({
				key: "route",
				label: `Handoff: ${facts.offer.taskType}`,
				detail: appRouteDetail(f, outcome, facts.offer.taskType),
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
	return actions;
}

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
function appDecisionFor(
	f: AppTicketOpsFields,
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
} {
	const completion = ticket.lastCompletion;
	const outcome = completion?.transition ?? null;
	const positionIdentity = outcome?.positionTicketIdentity ?? ticket.identity;
	// The Next step the settled turn's Transition derives (ADR 0092): the
	// screen resolves it from the state, and the fact module states the gate
	// that holds it beside the row the operator can confirm.
	const nextStep =
		f.state === undefined || outcome === null
			? null
			: deriveNextStep(
					f.configRef.current,
					f.state.ticketWorkCycle,
					outcome,
					f.listViews.projection,
				);
	const facts = decisionFacts({
		ticket,
		queue: f.workQueueRef.current,
		claims: f.startingTicketsRef.current,
		position: {
			ticket: f.findTicket(positionIdentity),
			stillListed:
				f.state === undefined ||
				outcome?.positionTicketIdentity === null ||
				f.state.sourceFact.stillListed(positionIdentity),
			isPlaneAction:
				outcome?.positionTaskType != null &&
				isPlaneActionTaskType(f.configRef.current.taskTypes, outcome.positionTaskType),
			latestAttempt:
				f.state === undefined
					? null
					: f.state.planeAction.latestPlaneActionAttempt(positionIdentity),
		},
		nextStepGate: nextStep === null ? null : nextStep.gate,
		defaultTaskType: f.configRef.current.defaultTaskType,
	});
	return {
		actions: appDecisionActions(f, outcome, facts),
		entries: completion?.turnLog ?? [],
		contextLine: facts.contextLine,
		factLines: facts.factLines,
		cause: completion?.cause ?? null,
		detail: completion?.detail ?? "",
	};
}

/** The transition row states the Agent that will receive its handoff. */
function appRouteDetail(f: AppTicketOpsFields, outcome: TransitionOutcome, target: string): string {
	const choice = resolveHandoffChoice(f.configRef.current, target, {
		...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
		...(outcome.environment === undefined ? {} : { environment: outcome.environment }),
	});
	const detail = [`agent ${choice.agentType}`];
	if (outcome.environment !== undefined) detail.push(`environment ${outcome.environment}`);
	return detail.join(", ");
}

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
async function appWorkspaceLabelOf(
	f: AppTicketOpsFields,
	workspaceId: string,
): Promise<string | null> {
	const result = await f.commandRunner.run("herdr", ["workspace", "get", workspaceId]);
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
}

// Goto is navigation (ADR 0033): the operator focuses the agent's pane
// in herdr and the handoff stays open. The ticket, its work cycle, and
// its traces stay exactly where they are: an awaiting ticket rests
// awaiting until the poll or a decision moves it, and an in-flight one
// stays in flight.
function appRunGoto(f: AppTicketOpsFields, ticket: Ticket): void {
	const paneId = ticket.handoff?.paneId ?? null;
	if (paneId === null) {
		f.setWarningMessage("no agent pane is recorded for this ticket");
		return;
	}
	// Herdr hands the id of a closed pane out again: when a different agent
	// runs in the pane the handoff recorded, the focus would land on that
	// agent, not the ticket's own. Refuse the focus, and state the fact on
	// the Message line the way a refused key does.
	const paneAgent = f.agentsRef.current?.find((candidate) => candidate.paneId === paneId);
	if (paneAgent !== undefined && ticketAgentIdentity(ticket, paneAgent) === "foreign") {
		f.setWarningMessage("the pane the handoff recorded is no longer the agent's pane");
		return;
	}
	void f.commandRunner.run("herdr", ["agent", "focus", paneId]).then(async (result) => {
		if (result.code !== 0) {
			f.setErrorMessage(`agent focus failed: ${commandFailureText(result)}`);
			return;
		}
		// The Live view closes on a Goto, so the confirmation stands on the
		// Message line as a result, never as a warning. A Goto records no
		// trace, and a Handoff or refresh still running stands alone. The line
		// names the workspace herdr moved every client's view into (ADR 0061):
		// Goto is the one focus move the plane makes, and the operator asked
		// for it at the key.
		const workspaceId = ticket.handoff?.workspaceId ?? null;
		const label = workspaceId === null ? null : await appWorkspaceLabelOf(f, workspaceId);
		f.reportMessage({
			severity: "info",
			text:
				label === null
					? `focused the agent of ticket ${ticket.identity}`
					: `focused the agent of ticket ${ticket.identity} in workspace ${label}`,
		});
	});
}

// Run a decision-panel action: close (with the Close cleanup), Goto, a
// workflow handoff, the re-fire of an incomplete transition, or (from the
// missing modal) restart and abandon.
function appRunDecisionAction(f: AppTicketOpsFields, ticket: Ticket, key: string): void {
	// A routed handoff from the Live view keeps the screen open: the
	// stream resumes for the new agent pane on its next tick. A merge
	// confirmed there keeps the screen open the same way: the stream stays
	// on the pane it watches, and the run's line lands on the Message line.
	// A re-fire keeps its own screen open the same way: the operator
	// confirms on it, and the fact lines the fire writes land on the open
	// rows.
	if (!(f.panel?.kind === "live" && (key === "route" || key === "merge")) && key !== "refire") {
		f.setPanel(null);
	}
	if (f.state === undefined) return;
	if (key === "close") {
		appCloseDecidedCycle(f, ticket);
		return;
	}
	if (key === "goto") {
		appRunGoto(f, ticket);
		return;
	}
	if (key === "refire") {
		void appRunRefire(f, ticket);
		return;
	}
	if (key === "merge") {
		// The manual confirm of the merged position (ADR 0068): the merge
		// runs as a plane action, with no agent and no worktree, and the
		// decision word lands at the ask, the way the route's does. The
		// confirm bypasses the Handoff limit: the operator asked for it,
		// and the limit holds the machine's automatic asks.
		appRunMerge(f, ticket);
		return;
	}
	const choice = appRouteChoiceOf(f, ticket, key);
	if (choice === null) return;
	appRunRouteHandoff(f, ticket, ticket.lastCompletion?.transition ?? null, choice);
}

// The forced refresh of the pull request sources, the one seam the fires
// read the projection through (ADR 0027, ADR 0076): the settle-time fire,
// the manual re-fire, and the recorded skip's sweep all pull the pull
// request sources the way this answers it.
async function appRefreshPullRequestSources(f: AppTicketOpsFields): Promise<void> {
	for (const source of f.configRef.current.sources) {
		if (source.kind === "github-pull-requests")
			await f.coordinatorRef.current?.refreshAndWait(source.name);
	}
}

/** The options the manual re-fire's transition fire runs with. */
function appRefireFireOptions(
	f: AppTicketOpsFields,
	state: AppAggregates,
	ticket: Ticket,
	completion: NonNullable<Ticket["lastCompletion"]>,
) {
	return {
		config: f.configRef.current,
		state,
		runner: f.commandRunner,
		ticketIdentity: ticket.identity,
		taskType: completion.taskType,
		refresh: () => appRefreshPullRequestSources(f),
	};
}

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
async function appRunRefire(f: AppTicketOpsFields, ticket: Ticket): Promise<void> {
	const state = f.state;
	if (
		state === undefined ||
		ticket.lastCompletion === null ||
		ticket.lastCompletion.transition === null
	) {
		return;
	}
	if (f.refireInFlightRef.current !== null) return;
	// The turn the re-fire acts on: the completion the row was offered on.
	const completion = ticket.lastCompletion;
	f.refireInFlightRef.current = ticket.identity;
	f.setWorkingMessage("re-firing the turn's transition...", "refire");
	try {
		// The outcome the operator acted on, as the state stores it: the
		// swap conditions on these exact bytes.
		const recordedJson = state.ticketWorkCycle.recordedTransitionJson(ticket.identity);
		if (recordedJson === null) {
			f.reportMessage({
				severity: "warning",
				text: "the turn records no transition outcome; no re-fire stands",
			});
			return;
		}
		// Read the source as it stands now: the fire reads the projection
		// the refresh just landed, the way the settle-time fire does.
		const outcome = await fireTransition(appRefireFireOptions(f, state, ticket, completion));
		if (outcome === null) {
			f.reportMessage({
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
		f.replaceTickets();
		if (!applied) {
			f.reportMessage({
				severity: "warning",
				text: "the turn's record moved before the re-fire landed; the standing record stands",
			});
			return;
		}
		if (outcome.fired) {
			f.reportMessage({
				severity: "info",
				text: "the re-fire lands; the labels stand as written",
			});
		} else {
			f.reportMessage({
				severity: "warning",
				text: `no transition branch held on the re-fire: ${outcome.reason}`,
			});
		}
	} finally {
		f.refireInFlightRef.current = null;
		f.clearWorkingMessage("refire");
	}
}

/**
 * Close the work cycle of an `awaiting` Ticket: the `closed` decision on
 * its settled turn, then the Close cleanup.
 *
 * One function runs the close the Decision modal's Close row offers and the
 * Delete key confirms (ADR 0031, ADR 0122): the two routes are the same
 * operation, so they cannot drift. The Close cleanup goes through the dispatch seat, which
 * already holds it behind a Handoff of the same ticket. A ticket that stands
 * for a route item loses it in the same answer: a closed cycle never
 * leaves a live start in the queue (ADR 0067, ADR 0072).
 */
function appCloseDecidedCycle(f: AppTicketOpsFields, ticket: Ticket): void {
	const state = f.state;
	if (state === undefined) return;
	const applied = state.ticketWorkCycle.applyCompletionDecision({
		ticketIdentity: ticket.identity,
		handoffId: ticket.handoff?.attemptId ?? "",
		decision: "closed",
		decidedAt: new Date().toISOString(),
	});
	if (applied && ticket.state === "awaiting")
		state.workQueue.removeWorkflowRouteItem(ticket.identity);
	f.replaceTickets();
	if (!applied) {
		f.setWarningMessage(`ticket ${ticket.identity} already decided`);
		return;
	}
	appRefreshTicketSources(f, ticket.identity);
	f.closeCycleEndDraft(ticket.identity);
	// The Close cleanup: the environment of the handoff the decision ends.
	const stored = state.handoff.latestHandoff(ticket.identity);
	if (stored !== null) appRunCloseCleanup(f, ticket.identity, stored, "closed");
	// The Close action writes no progress line of its own.
	f.clearOperationMessage("none");
}

/**
 * The cycle-end draft close (ADR 0076): when the cycle ends - the Close of
 * a decided cycle, the Abandon, the handoff limit, the auto-close - the
 * draft the ticket still wears is read off the factory branch and closed.
 * It runs best-effort, after the close: a failure is an error on the line
 * and the run's only notification (the Close settled, and the cleanup is
 * the plane's own act, the auto-close's included), and a branch that
 * carries no draft - or nothing at all - closes nothing and says nothing.
 */
function appCloseCycleEndDraft(f: AppTicketOpsFields, identity: string): void {
	const ticket = f.findTicket(identity);
	if (ticket === undefined) return;
	void closeCycleEndDraftPullRequest(f.commandRunner, f.configRef.current.sources, ticket).then(
		(failure) => {
			if (failure !== null) f.setFaultErrorMessage(failure);
		},
	);
}

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
function appCloseInFlightCycle(f: AppTicketOpsFields, ticket: Ticket): void {
	const dispatch = f.handoffDispatch;
	if (dispatch === undefined) return;
	void dispatch.closeWorkCycle(ticket.identity).then(
		(outcome) => {
			if (!outcome.ended) {
				f.setWarningMessage(`ticket ${ticket.identity} did not close: ${outcome.reason}`);
				return;
			}
			// The ended cycle may have changed the ticket's source item.
			appRefreshTicketSources(f, ticket.identity);
			if (outcome.cleanupFailure === undefined)
				// The fact the operator asked for, and nothing went wrong: the
				// line wears its own prefix, the way the Abandon's does.
				f.setNewsMessage(`ticket ${ticket.identity} closed`);
			else
				f.setFaultErrorMessage(
					`ticket ${ticket.identity} closed; the close cleanup failed: ${outcome.cleanupFailure}`,
				);
		},
		(error) =>
			f.setFaultErrorMessage(
				`ticket ${ticket.identity} closed; the close could not be reported: ${errorMessage(error)}`,
			),
	);
}

/**
 * Run the Close the operator confirmed on the Delete key.
 *
 * The route reads the Ticket's state now, not the state the dialog was drawn
 * on: the poll can settle the turn, or a decision can land, while the
 * confirmation stands. An `awaiting` Ticket runs the Decision modal's Close
 * row, and an in-flight one ends its cycle with no completion record.
 */
function appRunTicketClose(f: AppTicketOpsFields, asked: Ticket): void {
	// The projection before the list rule: the row can leave the list while the
	// confirmation stands, and the Close still runs on the Ticket it named.
	const ticket = f.findTicket(asked.identity) ?? asked;
	if (ticket.state === "awaiting") {
		appCloseDecidedCycle(f, ticket);
		return;
	}
	if (inFlight(ticket)) {
		appCloseInFlightCycle(f, ticket);
		return;
	}
	// The cycle ended from under the dialog: nothing is in flight to close. The
	// refusal reads in the same words the seat close reads it in, so the one
	// fact a moved Ticket states never has two phrasings.
	f.setWarningMessage(`ticket ${ticket.identity} did not close: the ticket is ${ticket.state}`);
}

/**
 * The choice the `route` row resolves to.

 * The row stands on the settled turn's transition outcome: the plane
 * wrote the facts and re-derived the position, so the action re-reads
 * nothing from the config but the choice the position resolves to. A
 * stale row - the outcome is gone or wrote no position - reports on the
 * status line and comes back null (ADR 0027).
 */
function appRouteChoiceOf(
	f: AppTicketOpsFields,
	ticket: Ticket,
	key: string,
): HandoffChoice | null {
	if (key !== "route") return null;
	const outcome = ticket.lastCompletion?.transition ?? null;
	if (outcome === null || outcome.positionTaskType === null) {
		f.setWarningMessage(`no transition position is recorded for ticket ${ticket.identity}`);
		return null;
	}
	// A transition Handoff resolves a fresh target profile and never
	// inherits the previous handoff's choice.
	return resolveHandoffChoice(f.configRef.current, outcome.positionTaskType, {
		...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
		...(outcome.environment === undefined ? {} : { environment: outcome.environment }),
	});
}

/**
 * Ask for the merge of the position's pull request (ADR 0068): the plane
 * action's ask through the dispatch seam, the decision word landing at the
 * ask and the item entering the Work queue. The ask takes no settings: the
 * task type's action form carries the method, and the run re-reads it when
 * it starts. A refusal before the enqueue - the claim, the one-item-per-
 * ticket rule - records nothing, and the row stands again.
 */
function appRunMerge(f: AppTicketOpsFields, ticket: Ticket): void {
	const dispatch = f.handoffDispatch;
	if (dispatch === undefined) return;
	const outcome = ticket.lastCompletion?.transition ?? null;
	if (outcome === null || outcome.positionTaskType === null) {
		f.setWarningMessage(`no transition position is recorded for ticket ${ticket.identity}`);
		return;
	}
	const targetIdentity = outcome.positionTicketIdentity ?? ticket.identity;
	void dispatch
		.dispatchPlaneAction({
			origin: "workflow",
			ticketIdentity: targetIdentity,
			taskType: outcome.positionTaskType,
			routeFromIdentity: ticket.identity,
			// The start answers the ask's refresh only: the decision stands
			// at the ask (ADR 0064), and the run's line answers itself.
			onStarted: () => f.replaceTickets(),
		})
		.then((result) => {
			if (!result.ok) f.setWarningMessage(result.reason);
		});
}

/**
 * Start a transition handoff with a resolved or overridden choice. The
 * handoff starts on the position's own ticket: the machine re-derives
 * positions from the written labels, so the agent starts where the facts
 * now sit, while the decision records on the ticket whose turn settled
 * (ADR 0027).
 */
function appRunRouteHandoff(
	f: AppTicketOpsFields,
	ticket: Ticket,
	outcome: TransitionOutcome | null,
	choice: HandoffChoice,
): void {
	const dispatch = f.handoffDispatch;
	if (dispatch === undefined) return;
	// The turn's decision lands at the ask (ADR 0064): the dispatch module
	// records it when the route enqueues, on the state's clock, so the ask
	// never waits on a run. A refusal before the enqueue - the claim, the
	// one-item-per-ticket rule - records nothing, and the trace stays
	// pending, so Close and Goto keep working.
	const targetIdentity = outcome?.positionTicketIdentity ?? ticket.identity;
	void dispatch
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
			onStarted: () => f.replaceTickets(),
		})
		.then((result) => {
			if (!result.ok) f.setWarningMessage(result.reason);
		});
}

/**
 * The placement each offered task type takes on the ticket the override
 * panel edits (ADR 0045). The panel wears the answers on its Task row,
 * and the dispatch re-runs the same rule when the confirmed start claims.
 * A route places the position's own ticket, not the settled one: the
 * handoff starts where the facts sit, the way its dispatch answers.
 */
function appTaskPlacementsFor(
	f: AppTicketOpsFields,
	pending: PendingOverride,
): Record<string, PlacementEvaluation> {
	const activeConfig = f.configRef.current;
	// Both rows come from the projection before the list rule (ADR 0042,
	// ADR 0060): ADR 0042's route reaches a position whose own row is withheld,
	// and so does an ignored one - the placement facts are the position's, not
	// the view's.
	const settled = f.findTicket(pending.ticketIdentity);
	if (settled === undefined) return {};
	// A route dispatches on the position's own ticket (ADR 0027), so the
	// placement is read on that ticket, not the settled one.
	const identity =
		pending.origin === "workflow"
			? (settled.lastCompletion?.transition?.positionTicketIdentity ?? settled.identity)
			: settled.identity;
	const ticket = identity === settled.identity ? settled : f.findTicket(identity);
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
}

/**
 * The `e` key on a decision row: edit that route's resolved settings
 * before it starts, so the operator's override outranks the edge pin,
 * the target Task profile, and the config defaults.
 */
function appOpenRouteOverride(f: AppTicketOpsFields, ticket: Ticket, key: string): void {
	// The ask never waits on a run (ADR 0064): the edit stands while a
	// Handoff is active, and the start it confirms answers by its own
	// rules, like every other ask.
	const choice = appRouteChoiceOf(f, ticket, key);
	if (choice === null) return;
	// The panel opens on this choice's agent: fetch its Model list (ADR 0010).
	appRequestModelList(f, choice.agentType);
	// The panel the route row was on is where an Esc and a confirmed route
	// return: the decision modal, or the Live view's decision sub-mode on the
	// work cycle that screen opened on (ADR 0110).
	const returnTo: RouteReturnPanel =
		f.panel?.kind === "live"
			? { kind: "live", identity: ticket.identity, workCycle: ticket.workCycle }
			: { kind: "decision", identity: ticket.identity };
	f.setPanel(null);
	f.setOverride({
		ticketIdentity: ticket.identity,
		origin: "workflow",
		returnTo,
		choice,
	});
}

/** The fields the App's Consultation and queue operations read and write. */
interface AppConsultationOpsFields extends AppTicketOpsFields {
	consultationOperations: ConsultationOperations | undefined;
	replacementConsultationId: string | null;
	setReplacementConsultationId: (id: string | null) => void;
	setLauncher: (open: boolean) => void;
	historyFilterRef: RefObject<"open" | "closed" | "all">;
	setHistoryFilter: (filter: "open" | "closed" | "all") => void;
	consultationsRef: RefObject<Consultation[]>;
	consultationIndexRef: RefObject<number>;
	setConsultationIndex: (index: number) => void;
	selectionRef: RefObject<"ticket" | "consultation" | "queue">;
	setSelection: (selection: "ticket" | "consultation" | "queue") => void;
	consultationFollowRef: RefObject<boolean>;
	setConsultationScroll: (scroll: number) => void;
	setNewOutput: (fresh: boolean) => void;
	responseDraftRef: RefObject<string>;
	setResponseDraft: (draft: string) => void;
	setResponseEditor: (open: boolean) => void;
	selectedConsultation: Consultation | undefined;
	ticketAtCursor: () => Ticket | undefined;
	factsFor: (ticket: Ticket) => TicketRowFacts;
	cursor: AppCursorBundle;
	ticketFilterRef: RefObject<TicketListFilter>;
	setTicketFilter: (filter: TicketListFilter) => void;
	workQueueIndexRef: RefObject<number>;
	setWorkQueueIndex: (index: number) => void;
	interaction: boolean;
	responseEditor: boolean;
	focusedPaneRef: RefObject<Pane>;
}

/** The async enqueue of a Consultation submit: the create or the replace. */
async function appConsultationEnqueue(
	f: AppConsultationOpsFields,
	typeName: string,
	repository: ConsultationRepositoryOption,
	input: string,
): Promise<void> {
	const state = f.state;
	if (state === undefined) return;
	const replaced =
		f.replacementConsultationId === null
			? undefined
			: state.consultationRecord.consultation(f.replacementConsultationId);
	const consultation =
		replaced === undefined
			? f.consultationOperations?.create({
					typeName,
					repository,
					initialInput: input,
					replacementOf: f.replacementConsultationId,
					queued: true,
				})
			: f.consultationOperations?.replace(replaced, {
					typeName,
					repository,
					initialInput: input,
					queued: true,
				});
	if (consultation === undefined) return;
	f.setLauncher(false);
	f.setReplacementConsultationId(null);
	f.historyFilterRef.current = "open";
	f.setHistoryFilter("open");
	// Stay on the record the replacement points back at, or on the
	// launched Consultation when it replaces nothing.
	appSelectConsultationById(f, consultation.replacementOf ?? consultation.id);
	// The record and its item committed in one write: the queue re-reads
	// it through the same refresh a handoff enqueue runs.
	f.replaceTickets();
	// The immediate pickup pass may take the seat the enqueue just made,
	// the way every other start's ask does. Run it before choosing the
	// line, so the notice never claims a wait the queue no longer holds:
	// a pickup that started the record already stood its own opening line,
	// and a record that still waits is the one that keeps its queue item.
	const pickup = f.handoffDispatchRef.current?.dispatch;
	if (pickup !== undefined) await pickup.pickupWorkQueue();
	const settled = state.consultationRecord.consultation(consultation.id);
	if (settled === undefined || settled.state !== "queued") return;
	f.setNoticeMessage(
		state.workQueue.queuePaused()
			? `consultation queued: ${consultation.id.slice(0, 8)} waits in the Work queue; the queue is paused`
			: `consultation queued: ${consultation.id.slice(0, 8)} waits in the Work queue for a free Parallel limit seat`,
		"info",
	);
}

/**
 * Submit the Consultation the launcher confirmed (ADR 0049).
 *
 * The enqueue's hard check runs first: the type still exists, and the
 * settings that type resolves to still fit. A Consultation the config
 * cannot start never takes a row: the reason stands on the Message line
 * at the ask, and the launcher stays open with the operator's form for
 * the fix. The check is async - the Setting fit reads the Agent's Model
 * list - so the whole submit runs behind it, the way every other start's
 * ask does.
 */
function appSubmitConsultation(
	f: AppConsultationOpsFields,
	typeName: string,
	repository: ConsultationRepositoryOption,
	input: string,
): void {
	if (f.state === undefined || f.consultationOperations === undefined) {
		f.setWarningMessage("Consultations require durable SQLite state");
		return;
	}
	const operations = f.consultationOperations;
	void operations.checkEnqueue(typeName).then(async (refusal) => {
		if (refusal !== undefined) {
			f.setWarningMessage(`consultation not queued: ${refusal}`);
			return;
		}
		await appConsultationEnqueue(f, typeName, repository, input);
	});
}

/**
 * Re-open the pane of an `opening` Consultation the plane lost track of.
 */
function appRecoverConsultationOpening(
	f: AppConsultationOpsFields,
	consultation: Consultation,
): void {
	if (consultation.state !== "opening") return;
	void f.consultationOperations?.recover(consultation);
}

/**
 * Whether this record holds no Agent the close could stop.
 *
 * The two Recovery required states are the two an interrupted run cannot
 * bring back: herdr reports no pane, and nothing waits for a reply.
 */
function appConsultationHasNoAgent(consultation: Consultation): boolean {
	return consultation.state === "missing" || consultation.state === "failed";
}

/**
 * Whether this record's close has nothing to stop and nothing to keep.
 *
 * The two states Recovery names (issue #90): a `missing` or a `failed`
 * record has no Agent to stop and no environment to clean, so its close
 * runs on the keypress. A `queued` or an `unscheduled` record no longer
 * closes at the key (ADR 0122): the Delete key takes the queue's row out of
 * the first, and takes the second's record and history out, and neither
 * record reaches a close. A no-Agent record is not one the launcher
 * replaces: its ask still stands.
 */
function appConsultationCloseNeedsNoAgent(consultation: Consultation): boolean {
	return appConsultationHasNoAgent(consultation);
}

/**
 * Open the launcher as the Replacement launcher of one record.
 *
 * One path for both ways in: the `c` Launch of a `missing` or a `failed`
 * row, and that row's recovery panel. The panel below this one closes, so
 * the launcher holds the keys alone.
 */
function appOpenReplacementLauncher(f: AppConsultationOpsFields, consultation: Consultation): void {
	f.setPanel(null);
	f.setReplacementConsultationId(consultation.id);
	f.setLauncher(true);
}

/**
 * Run the close the operator asked for, in the shape the record needs.
 *
 * A record with no Agent to stop has nothing to confirm, so the close runs
 * on the keypress. A live record confirms first, and a `closing` one opens
 * its Retry and Force-close recovery rows.
 */
function appRunConsultationClose(f: AppConsultationOpsFields, consultation: Consultation): void {
	if (appConsultationCloseNeedsNoAgent(consultation)) appCloseConsultation(f, consultation);
	else f.setPanel({ kind: "consultation-close", identity: consultation.id });
}

/**
 * Open the Response editor on a Consultation awaiting a reply.
 */
function appBeginResponse(f: AppConsultationOpsFields, consultation: Consultation): void {
	if (consultation.state !== "awaiting-response") {
		f.setWarningMessage("the Consultation is not awaiting a response");
		return;
	}
	f.responseDraftRef.current = consultation.draft;
	f.setResponseDraft(consultation.draft);
	f.setResponseEditor(true);
}

/**
 * Send the Response the editor holds.
 */
function appSubmitResponse(f: AppConsultationOpsFields): void {
	const state = f.state;
	const selected = f.selectedConsultation;
	if (state === undefined || selected === undefined || f.consultationOperations === undefined)
		return;
	const consultation = selected;
	const draft = f.responseDraftRef.current;
	// Keep this UI-side check so an invalid draft leaves the editor open;
	// respond repeats it at the module boundary for non-UI callers.
	const validation = validateResponseInput(draft);
	if (validation !== undefined) {
		f.setWarningMessage(validation);
		return;
	}
	f.setResponseEditor(false);
	void f.consultationOperations?.respond(consultation, draft).then(
		() => {
			const current = state.consultationRecord.consultation(consultation.id);
			// Keep the editor open when delivery was already pending, or when
			// a failed delivery left the draft awaiting another attempt.
			if (current?.state === "awaiting-response") f.setResponseEditor(true);
		},
		() => f.setResponseEditor(true),
	);
}

/**
 * Keep the durable Response draft equal to what the field holds.
 *
 * The Draft field owns the text while the operator edits it, and the saved
 * draft is what survives a close, a rejection, and a restart, so every
 * change is stored as it happens rather than carried out of the editor by
 * hand.
 */
function appStoreResponseDraft(f: AppConsultationOpsFields, text: string): void {
	const state = f.state;
	const selected = f.selectedConsultation;
	f.responseDraftRef.current = text;
	f.setResponseDraft(text);
	if (state !== undefined && selected !== undefined && text !== selected.draft)
		state.consultationRecord.setConsultationDraft(selected.id, text);
}

/** Store what the operator last saw, then run the send. */
function appSendResponseText(f: AppConsultationOpsFields, text: string): void {
	appStoreResponseDraft(f, text);
	appSubmitResponse(f);
}

/** Delete the saved Response draft. Closing the editor never does this. */
function appDiscardResponseDraft(f: AppConsultationOpsFields): void {
	const state = f.state;
	const selected = f.selectedConsultation;
	f.responseDraftRef.current = "";
	f.setResponseDraft("");
	if (state !== undefined && selected !== undefined)
		state.consultationRecord.setConsultationDraft(selected.id, "");
	f.setResponseEditor(false);
	f.setNoticeMessage("the saved Response draft was discarded", "info");
}

/** Close the editor. The Response draft it leaves is the one already stored. */
function appCloseResponseEditor(f: AppConsultationOpsFields): void {
	f.setResponseEditor(false);
}

/**
 * A click on a section's header toggles that section (user story 9), the
 * same action `x` takes for the cursor. Expanding moves the cursor into
 * the section's list and focuses it. Collapsing keeps the selection and
 * its detail with the section, so the operator's place is never lost to
 * a stray click (user stories 19 and 20).
 */
function appClickSection(f: AppConsultationOpsFields, next: MainSection): void {
	if (f.cursor.flipSectionExpanded(next)) {
		f.selectionRef.current =
			next === "tickets" ? "ticket" : next === "consultations" ? "consultation" : "queue";
		f.setSelection(f.selectionRef.current);
		f.cursor.focusPane("list");
	}
}

/**
 * Put the unified cursor on one Consultation by id, from the launch
 * route. The launched record, or the record its replacement points back
 * at, is the one the operator keeps looking at: the detail follows it
 * and the observation loop starts reading its pane.
 */
function appSelectConsultationById(f: AppConsultationOpsFields, id: string): void {
	f.historyFilterRef.current = "open";
	f.setHistoryFilter("open");
	f.replaceConsultations();
	const index =
		f.state === undefined ? -1 : f.consultationsRef.current.findIndex((item) => item.id === id);
	if (index < 0) return;
	f.consultationIndexRef.current = index;
	f.setConsultationIndex(index);
	f.selectionRef.current = "consultation";
	f.setSelection("consultation");
	f.consultationFollowRef.current = true;
	f.setConsultationScroll(999999);
	f.setNewOutput(false);
}

/**
 * `f` cycles the Ticket section's List filter (ADR 0060): active, ignored,
 * all. The pile the ignore made is one keypress from view in either
 * direction, and the cursor keeps its Ticket when the new view still shows
 * it - the re-read preserves the row by identity, the way the history
 * filter's cycle does.
 */
function appCycleTicketFilter(f: AppConsultationOpsFields): void {
	if (f.state === undefined) {
		// The reveal shows the rows the list rule withholds, and the in-memory
		// projection runs no list rule at all: every view is the rows it was
		// handed, so the key has no pile to show. It says so in the same words
		// `i` says the missing fact in, rather than moving a filter the frame
		// cannot see (ADR 0060).
		f.setWarningMessage("the Ticket list filter needs SQLite state");
		return;
	}
	const next = nextTicketListFilter(f.ticketFilterRef.current);
	f.ticketFilterRef.current = next;
	f.setTicketFilter(next);
	f.replaceTickets();
}

/** The Message line the ignore act reports, from what the act measured. */
function appTicketIgnoreReport(
	f: AppConsultationOpsFields,
	report: {
		ticket: Ticket;
		ignored: boolean;
		cancelled: boolean;
		resting: boolean;
		backInList: boolean;
	},
): void {
	const { ticket, ignored, cancelled, resting, backInList } = report;
	const name = `"${ticket.title}"`;
	if (ignored) {
		f.reportMessage({
			severity: "info",
			text: cancelled
				? `${name} is ignored; its waiting start left the Work queue`
				: resting
					? `${name} is ignored: no row, no counts, no automatic start`
					: `${name} is ignored: no automatic start, and its row stays while its work is live`,
		});
	} else {
		f.reportMessage({
			severity: "info",
			text: !resting
				? `${name} is not ignored: the machine may start it again`
				: backInList
					? `${name} is not ignored: its row is back in the list`
					: `${name} is not ignored: an open fixing pull request still holds its row out of the list`,
		});
	}
}

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
function appToggleTicketIgnore(f: AppConsultationOpsFields): void {
	// The Ticket under the cursor, read the way every Ticket control reads it
	// (issue #159): a Group header holds no Ticket, and the catalogue refused
	// the key with its own words before this ran.
	const ticket = f.ticketAtCursor();
	if (ticket === undefined) return;
	const state = f.state;
	if (state === undefined) {
		// The ignore is durable factory state: the in-memory projection this
		// shell holds has nowhere to keep it, so the key says so instead of
		// acting as a view switch the operator would read as an ignore.
		f.setWarningMessage("ignoring a Ticket needs SQLite state");
		return;
	}
	const ignored = !ticket.ignored;
	const result = state.ticketWorkCycle.setTicketIgnored(
		ticket.identity,
		ignored,
		f.factsFor(ticket).failure,
	);
	if (!result.ok) {
		f.setWarningMessage(result.reason);
		return;
	}
	// The waiting start leaves with the row (ADR 0060): the cancel path keeps
	// its stated semantics - the item goes, the ticket keeps its state.
	const cancelled =
		ignored === true && f.handoffDispatch?.removeQueueItem(ticket.identity) === true;
	// The row's place in the list decides the sentence, read from the re-read the
	// act just caused: a resting Ticket's row leaves with the flag and returns
	// without it, while a Ticket with live work or a decision owed keeps its row
	// either way. `active` is the list rule's own answer - the covered rule beside
	// the ignore's - so a clear that returns no row says which rule still holds it
	// out instead of promising a row the list does not draw (ADR 0042, ADR 0060).
	const resting = flagWithholdsRow({ ...ticket, ignored: true });
	f.replaceTickets();
	const backInList = f.listViewsRef.current.active.some((row) => row.identity === ticket.identity);
	appTicketIgnoreReport(f, { ticket, ignored, cancelled, resting, backInList });
}

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
function appToggleSourceMute(f: AppConsultationOpsFields): void {
	// The Ticket under the cursor, read the way every Ticket control reads
	// it (issue #159): a Group header holds no Ticket, and the catalogue
	// refused the key with its own words before this ran.
	const ticket = f.ticketAtCursor();
	if (ticket === undefined) return;
	const state = f.state;
	if (state === undefined) {
		// The mute is durable factory state on the source's row: the
		// in-memory projection this shell holds has nowhere to keep it, so
		// the key says so instead of acting as a view switch the operator
		// would read as a mute (ADR 0070).
		f.setWarningMessage("muting a source needs SQLite state");
		return;
	}
	const sources = [
		...new Set(ticket.memberships.map((membership) => membership.sourceName)),
	].sort();
	if (sources.length === 0) {
		f.setWarningMessage("the selected Ticket names no source to mute");
		return;
	}
	const muted = ticket.muted !== true;
	let removed = 0;
	for (const sourceName of sources) {
		const result = state.sourceFact.setSourceMuted(sourceName, muted);
		if (!result.ok) {
			f.setWarningMessage(result.reason);
			return;
		}
		removed += result.removed;
	}
	f.replaceTickets();
	const label = sources.join(", ");
	const queueNote =
		removed > 0 ? `; ${removed} waiting start${removed === 1 ? "" : "s"} left the Work queue` : "";
	f.reportMessage({
		severity: "info",
		text: muted
			? `source ${label} is muted: no row while its tickets rest, no automatic start${queueNote}`
			: `source ${label} is not muted: its rows come back from the list, and the machine may start them`,
	});
}

/**
 * Cycle the Consultation section's history filter: open, closed, all.
 */
function appCycleConsultationHistory(f: AppConsultationOpsFields): void {
	const next =
		f.historyFilterRef.current === "open"
			? "closed"
			: f.historyFilterRef.current === "closed"
				? "all"
				: "open";
	f.historyFilterRef.current = next;
	f.setHistoryFilter(next);
	f.replaceConsultations();
}

/**
 * Close a Consultation through the module's seam.
 */
function appCloseConsultation(f: AppConsultationOpsFields, consultation: Consultation): void {
	void f.consultationOperations?.close(consultation);
}

/**
 * Force-close a Consultation from its recovery panel.
 */
function appForceCloseConsultation(f: AppConsultationOpsFields, consultation: Consultation): void {
	f.consultationOperations?.forceClose(consultation);
}

/**
 * Delete a Consultation's record and history through the module's seam.
 */
function appDeleteConsultation(f: AppConsultationOpsFields, consultation: Consultation): void {
	f.consultationOperations?.delete(consultation);
}

/**
 * Run a missing-agent action: the restart or the abandon.
 */
function appRunMissingAction(f: AppConsultationOpsFields, ticket: Ticket, key: string): void {
	// A restart from the Live view's Missing mode keeps the screen open:
	// it returns to the stream when the restarted agent is back.
	if (!(f.panel?.kind === "live" && key === "restart")) f.setPanel(null);
	const state = f.state;
	if (state === undefined) return;
	if (key === "abandon") {
		const applied = state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: ticket.identity,
			handoffId: ticket.handoff?.attemptId ?? "",
			decision: "abandoned",
			decidedAt: new Date().toISOString(),
		});
		f.replaceTickets();
		if (!applied) {
			f.setWarningMessage(`ticket ${ticket.identity} already decided`);
			return;
		}
		appRefreshTicketSources(f, ticket.identity);
		f.closeCycleEndDraft(ticket.identity);
		const stored = state.handoff.latestHandoff(ticket.identity);
		if (stored !== null) appRunCloseCleanup(f, ticket.identity, stored, "abandoned");
		f.setNewsMessage(`ticket ${ticket.identity} abandoned`);
		return;
	}
	// Restart: the same choices, in the workspace the handoff recorded.
	const stored = ticket.handoff;
	const choice =
		stored === null
			? f.choiceFor(ticket)
			: baseChoice(stored.agentType, stored.environment, stored.taskType, {
					model: stored.model,
					thinking: stored.thinking,
					contextWindow: stored.contextWindow,
				});
	const dispatch = f.handoffDispatch;
	if (dispatch === undefined) return;
	void dispatch
		.dispatch({
			origin: "restart",
			ticketIdentity: ticket.identity,
			choice,
			previousMessage: ticket.lastCompletion?.message ?? "",
		})
		.then((result) => {
			if (!result.ok) f.setWarningMessage(result.reason);
		});
}

/**
 * Move the queue's item under the cursor (ADR 0034): the reorder runs in
 * state, and the list re-reads the queue on the refresh the dispatch
 * module uses everywhere else. The captured choice travels with the item,
 * so a reorder changes only the order the free seats take.
 */
function appMoveQueueItem(
	f: AppConsultationOpsFields,
	direction: "up" | "down",
	item: WorkQueueItem | null,
): void {
	if (f.state === undefined) return;
	// The item is the queue module's own fact for the row under the cursor,
	// the same one the catalogue gated the key on.
	if (item === null) return;
	const state = f.state;
	if (
		!state.workQueue.moveWorkItem(
			item.kind === "consultation" ? item.consultationId : item.ticketIdentity,
			direction,
		)
	) {
		f.setWarningMessage(
			direction === "up" ? "the item is first in the queue" : "the item is last in the queue",
		);
		return;
	}
	f.selectionRef.current = "queue";
	f.setSelection("queue");
	f.workQueueIndexRef.current = f.workQueueIndexRef.current + (direction === "up" ? -1 : 1);
	f.setWorkQueueIndex(f.workQueueIndexRef.current);
	f.replaceTickets();
}

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
function appRemoveQueueItem(f: AppConsultationOpsFields, item: WorkQueueItem | null): void {
	const dispatch = f.handoffDispatch;
	if (dispatch === undefined) return;
	// The item is the queue module's own fact for the row under the cursor,
	// the same one the catalogue gated the key on.
	if (item === null) return;
	if (item.kind === "consultation") {
		// A Consultation item's removal unschedules the record (ADR 0034,
		// issue #91): the ask is kept in `unscheduled` state behind the
		// pointer it loses, and the pickup never runs for it. The module
		// holds no claim for the record, so only the row and its pickup note
		// leave through the module's seam.
		const removed = dispatch.removeConsultationQueueItem(item.consultationId);
		if (removed) {
			f.setNoticeMessage(
				`consultation ${item.consultationId.slice(0, 8)}: removed from the queue; the record is unscheduled`,
				"info",
			);
		} else {
			f.setWarningMessage(
				`consultation ${item.consultationId.slice(0, 8)}: the queue item was already gone`,
			);
		}
		f.replaceTickets();
		// The record's state moved in the same write the item left, so the
		// Consultation section re-reads its rows: the row the operator just
		// removed reappears as the `unscheduled` ask.
		f.replaceConsultations();
		return;
	}
	// Route the removal through the module so the waiting start leaves with
	// everything held for it: the row, a parked claim, and the ask's held
	// start report (ADR 0049). A bare state delete would strand the intent
	// and let it answer a later start of the same ticket.
	const removed = dispatch.removeQueueItem(item.ticketIdentity);
	// The name the operator reads on the line: the title while the ticket
	// is still in the projection, its identity once it is gone. The projection
	// before the list rule, so an ignored Ticket's waiting start names its
	// ticket instead of falling back to the raw identity (ADR 0042, ADR 0060).
	// The name rule is the shared one the dispatch, the observation cycle, and
	// the boot read, so one Ticket wears one name (issue #295 review).
	const name = recordTicketName(f.listViewsRef.current.projection, item.ticketIdentity);
	if (removed) {
		f.setNoticeMessage(`the waiting start for ${name} was removed`, "info");
	} else {
		// Nothing to cancel: the keypress met a queue that no longer held the
		// row, so the line refuses the removal it could not make.
		f.setWarningMessage(`the Work queue no longer held a waiting start for ${name}`);
	}
	f.replaceTickets();
}

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
function appForceDispatchQueueItem(f: AppConsultationOpsFields, item: WorkQueueItem | null): void {
	const dispatch = f.handoffDispatch;
	if (dispatch === undefined) return;
	// The item is the queue module's own fact for the row under the cursor,
	// the same one the catalogue gated the key on.
	if (item === null) return;
	dispatch.forceDispatchWorkQueueItem(workQueueIdentityOf(item));
}

/** The Interaction mode the Main view's own keys and bar run in. */
function appCurrentBaseMode(f: {
	interaction: boolean;
	responseEditor: boolean;
	selectionRef: RefObject<"ticket" | "consultation" | "queue">;
	focusedPaneRef: RefObject<Pane>;
}): InteractionMode {
	return f.interaction
		? "consultation-interaction"
		: f.responseEditor
			? "form-field"
			: sectionBaseMode(f.selectionRef.current, f.focusedPaneRef.current);
}

/** The Interaction mode one open section's panes run in. */
function sectionBaseMode(
	section: "ticket" | "consultation" | "queue",
	pane: Pane,
): InteractionMode {
	if (section === "consultation")
		return pane === "list" ? "consultation-list" : "consultation-detail";
	if (section === "queue") return pane === "list" ? "work-queue-list" : "work-queue-detail";
	return pane === "list" ? "ticket-list" : "ticket-detail";
}

type AppCursorBundle = ReturnType<typeof useAppCursor>;

/** The terminal chrome of the plane: the renderer, the frame, the theme note. */
function useAppChrome(props: AppProps) {
	const renderer = useRenderer();
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const themeWarning = currentThemeResolution().warning;
	return { props, renderer, terminalWidth, terminalHeight, themeWarning };
}
type AppChromeStage = ReturnType<typeof useAppChrome>;

/**
 * The config state of the plane: the in-session config and its write-back
 * seam, and the runner, home, and config file the plane runs from.
 */
function useAppConfigState(props: AppProps, chrome: AppChromeStage) {
	const { config: configProp, runner, home, configPath } = props;
	const [config, setConfig] = useState<FactoryConfig>(() => configProp);
	const configRef = useRef(config);
	configRef.current = config;
	const commandRunner = runner ?? realRunner();
	const homeDir = home ?? os.homedir();
	const configFile = configPath ?? defaultConfigPath();
	const profiles: Record<string, TaskProfileStart> = taskProfilesOf(config);
	return { ...chrome, config, setConfig, configRef, commandRunner, homeDir, configFile, profiles };
}
type AppConfigStage = ReturnType<typeof useAppConfigState>;

function useAppListViews(props: AppProps, cfg: AppConfigStage) {
	const { state, initialTickets } = props;
	const { config } = cfg;
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
	return { ...cfg, listViews, setListViews, tickets, machineTickets, ticketsRef };
}
type AppListViewsStage = ReturnType<typeof useAppListViews>;

/** The Ticket section's Grouping state (ADR 0058, issue #159). */
function useAppGroupingState(props: AppProps, prev: AppListViewsStage) {
	const { state } = props;
	const { config } = prev;
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
	return {
		...prev,
		groupingAxis,
		setGroupingAxis,
		groupingAxisRef,
		initNoteShownRef,
		groupOrderList,
		setGroupOrderList,
		groupOrderListRef,
		groupOrdersForRunRef,
		positionOrderOf,
		storedGroupOrderOf,
	};
}
type AppGroupingStage = ReturnType<typeof useAppGroupingState>;

/** The sections' folds and expansion flags (issue #159, ADR 0052). */
function useAppFoldsState(prev: AppGroupingStage) {
	/**
	 * The Group fold of each section (issue #159): a fold the operator made is
	 * kept for the run, and a restart never sees it.
	 */
	const [groupFolds, setGroupFolds] = useState<GroupFolds>(NO_GROUP_FOLDS);
	const groupFoldsRef = useRef<GroupFolds>(NO_GROUP_FOLDS);
	/** The Ticket section's expansion, and the two sections beside it. */
	const [ticketsExpanded, setTicketsExpanded] = useState(true);
	const ticketsExpandedRef = useRef(true);
	const [consultationsExpanded, setConsultationsExpanded] = useState(true);
	const consultationsExpandedRef = useRef(true);
	/** The Work section's expansion. */
	const [workExpanded, setWorkExpanded] = useState(true);
	const workExpandedRef = useRef(true);
	/** The Work queue's pause (ADR 0052). */
	const [queuePaused, setQueuePaused] = useState(false);
	const queuePausedRef = useRef(false);
	queuePausedRef.current = queuePaused;
	return {
		...prev,
		groupFolds,
		setGroupFolds,
		groupFoldsRef,
		ticketsExpanded,
		setTicketsExpanded,
		ticketsExpandedRef,
		consultationsExpanded,
		setConsultationsExpanded,
		consultationsExpandedRef,
		workExpanded,
		setWorkExpanded,
		workExpandedRef,
		queuePaused,
		setQueuePaused,
		queuePausedRef,
	};
}
type AppFoldsStage = ReturnType<typeof useAppFoldsState>;

/** The three sections' selection, indexes, and filters (ADR 0042, ADR 0060). */
function useAppSelectionState(props: AppProps, prev: AppFoldsStage) {
	const { state } = props;
	/** The section the unified cursor is on. */
	const [selection, setSelection] = useState<"ticket" | "consultation" | "queue">("ticket");
	const selectionRef = useRef<"ticket" | "consultation" | "queue">("ticket");
	/** The Work queue's cursor index and its detail scroll. */
	const [workQueueIndex, setWorkQueueIndex] = useState(0);
	const workQueueIndexRef = useRef(0);
	const [workQueueDetailScroll, setWorkQueueDetailScroll] = useState(0);
	const workQueueDetailScrollRef = useRef(0);
	/** The Consultation section's drawn records, in the history filter's view. */
	const [consultations, setConsultations] = useState<Consultation[]>(
		() => state?.consultationRecord.consultations("open") ?? [],
	);
	/**
	 * The machine's own Consultation read (story 14): the `open` list the
	 * header's counts and the seat reads take, never the operator's filter.
	 */
	const [machineConsultations, setMachineConsultations] = useState<Consultation[]>(
		() => state?.consultationRecord.consultations("open") ?? [],
	);
	const consultationsRef = useRef(consultations);
	const [consultationIndex, setConsultationIndex] = useState(0);
	const consultationIndexRef = useRef(0);
	/** The Consultation section's history filter: open, closed, all. */
	const [historyFilter, setHistoryFilter] = useState<"open" | "closed" | "all">("open");
	const historyFilterRef = useRef<"open" | "closed" | "all">("open");
	/** The Ticket section's List filter (ADR 0060): active, ignored, all. */
	const [ticketFilter, setTicketFilter] = useState<TicketListFilter>("active");
	const ticketFilterRef = useRef<TicketListFilter>("active");
	return {
		...prev,
		selection,
		setSelection,
		selectionRef,
		workQueueIndex,
		setWorkQueueIndex,
		workQueueIndexRef,
		workQueueDetailScroll,
		setWorkQueueDetailScroll,
		workQueueDetailScrollRef,
		consultations,
		setConsultations,
		consultationsRef,
		machineConsultations,
		setMachineConsultations,
		consultationIndex,
		setConsultationIndex,
		consultationIndexRef,
		historyFilter,
		setHistoryFilter,
		historyFilterRef,
		ticketFilter,
		setTicketFilter,
		ticketFilterRef,
	};
}
type AppSelectionStateStage = ReturnType<typeof useAppSelectionState>;

/** The launcher's form state and the consultation panels it opens. */
function useAppLauncherState(prev: AppSelectionStateStage) {
	const { listViews } = prev;
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
	return {
		...prev,
		listViewsRef,
		launcher,
		setLauncher,
		replacementConsultationId,
		setReplacementConsultationId,
		launcherForm,
		setLauncherForm,
		consultationSafety,
		setConsultationSafety,
		repositoryOptions,
		setRepositoryOptions,
		responseEditor,
		setResponseEditor,
		responseDraft,
		setResponseDraft,
		responseDraftRef,
	};
}
type AppLauncherStateStage = ReturnType<typeof useAppLauncherState>;

/** The Consultation interaction state: the editor, the stream, the bell. */
function useAppInteractionState(prev: AppLauncherStateStage) {
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
	return {
		...prev,
		interaction,
		setInteraction,
		liveOutput,
		setLiveOutput,
		sessionEntries,
		setSessionEntries,
		consultationScroll,
		setConsultationScroll,
		consultationFollowRef,
		newOutput,
		setNewOutput,
		bell,
		setBell,
		heldBell,
		setHeldBell,
		heldCountRef,
		selectedIndex,
		setSelectedIndex,
		selectedIndexRef,
		detailTicketIdentityRef,
		detailTicketRef,
	};
}
type AppInteractionStateStage = ReturnType<typeof useAppInteractionState>;

/** The per-render ref syncs the machine reads through the refs. */
function useAppSectionSyncs(prev: AppInteractionStateStage) {
	const {
		ticketsExpanded,
		ticketsExpandedRef,
		groupingAxis,
		groupingAxisRef,
		groupFolds,
		groupFoldsRef,
		consultationsExpanded,
		consultationsExpandedRef,
		workExpanded,
		workExpandedRef,
		selection,
		selectionRef,
		workQueueIndex,
		workQueueIndexRef,
		workQueueDetailScroll,
		workQueueDetailScrollRef,
		historyFilter,
		historyFilterRef,
		ticketFilter,
		ticketFilterRef,
	} = prev;
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
	return { ...prev };
}
type AppSectionSyncsStage = ReturnType<typeof useAppSectionSyncs>;

/** The Work queue's items and the rows it draws (ADR 0034). */
function useAppWorkQueueState(props: AppProps, prev: AppSectionSyncsStage) {
	const { state } = props;
	const { configRef, consultations, listViewsRef } = prev;
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
		[listViewsRef],
	);
	// The row the list draws, from the one conversion the detail reads too
	// (ADR 0034, issue #90): the item's ticket by its title while the ticket
	// is still in the projection, by its identity once it is gone, the
	// Consultation's item by the ask the operator typed and the record's type,
	// and the task type the start runs in every row's cell.
	const workQueueRows: readonly WorkQueueRow[] = workQueueRowFacts(workQueue, {
		ticketTitle: (identity) =>
			// The projection before the list rule (ADR 0042, ADR 0060): a waiting
			// start of an ignored or covered Ticket still names its ticket, not
			// the raw identity the row would fall back to.
			findTicket(identity)?.title,
		consultationType: (id) => consultations.find((record) => record.id === id)?.typeName,
		consultationInput: (id) => consultations.find((record) => record.id === id)?.initialInput,
		planeActionMethod: (taskType) =>
			planeActionSettingOf(configRef.current.taskTypes, taskType)?.method,
	});
	// The cursor never rests on a queue that no longer holds its row: a pickup
	// or a cancel that empties the section sends the selection home, and the
	// retained index clamps to the rows that remain. The bounce fires on the
	// emptying step alone: a focus the operator lands on a queue that is
	// already empty stays where they put it, the way the other sections' empty
	// lists do, where the empty message is the row the cursor rests on (ADR 0049).
	const workQueueWasNonEmptyRef = useRef(workQueue.length > 0);
	return {
		...prev,
		workQueue,
		setWorkQueue,
		workQueueRef,
		findTicket,
		workQueueRows,
		workQueueWasNonEmptyRef,
	};
}
type AppWorkQueueStateStage = ReturnType<typeof useAppWorkQueueState>;

/** The Live view's stream: the lines of the last pane read, and the stale note. */
type AppLiveStream = { lines: readonly string[]; note: string | null } | null;

/** The detail pane's refs: the focus, the detail handle, the override, and the utility and health state. */
function useAppDetailRefs(props: AppProps, prev: AppWorkQueueStateStage) {
	const { state } = props;
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
	return {
		...prev,
		focusedPane,
		setFocusedPane,
		focusedPaneRef,
		detailRef,
		detailScrollSlot,
		override,
		setOverride,
		overrideRef,
		utility,
		setUtility,
		healths,
		setHealths,
		panel,
		setPanel,
	};
}
type AppDetailRefsStage = ReturnType<typeof useAppDetailRefs>;

/** The factory's refs: the init queue, the Live stream, the auto-handoff mode, and the herdr poll. */
function useAppFactoryRefs(props: AppProps, prev: AppDetailRefsStage) {
	const { state } = props;
	// The queue behind a queued init (ADR 0083): the entries waiting for
	// their turn stand in the ref, not in state, because no surface renders
	// them - the confirmation panel names only the entry under review.
	const repositoryInitQueue = useRef<RepositoryInitQueue | null>(null);
	// The repository whose init plans right now (ADR 0083): the plan runs
	// async with the base view's keyboard live, and the operator must not
	// start a second init the first would then overwrite.
	const repositoryInitInFlight = useRef<string | null>(null);
	// The Live view's stream: the lines of the last pane read, and the stale
	// note while the latest read failed. Null while no stream runs.
	const [liveStream, setLiveStream] = useState<AppLiveStream>(null);
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
	return {
		...prev,
		repositoryInitQueue,
		repositoryInitInFlight,
		liveStream,
		setLiveStream,
		autoMode,
		setAutoMode,
		autoModeRef,
		agents,
		setAgents,
		agentsRef,
		observationRef,
		pollRef,
	};
}
type AppFactoryRefsStage = ReturnType<typeof useAppFactoryRefs>;

/** The seat count the limit gate and the mode cell read. */
function useAppSeatFacts(props: AppProps, prev: AppFactoryRefsStage) {
	const { state } = props;
	const { observationRef } = prev;
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
	/**
	 * The Parallel limit seat facts, read once per call (issue #202, ADR 0095):
	 * the in-flight tickets and their Agent names in one batched read each, the
	 * unresolved claims, the Consultation seats, and the latest herdr poll.
	 */
	const parallelSeatFacts = (): ParallelSeatFacts => {
		const inFlight =
			state === undefined ? [] : state.ticketWorkCycle.ticketsByState(TICKET_SEAT_STATES);
		const names =
			state === undefined
				? new Map<string, string>()
				: state.ticketWorkCycle.agentNamesForTickets(
						inFlight.map((ticket) => ticket.ticketIdentity),
					);
		return {
			tickets: inFlight.map((ticket) => ({
				ticketIdentity: ticket.ticketIdentity,
				paneId: ticket.paneId,
				startedAt: ticket.startedAt,
				agentName: names.get(ticket.ticketIdentity) ?? "",
			})),
			handoffAttemptTickets: state === undefined ? [] : state.handoff.openAttemptTickets(),
			consultations:
				state === undefined
					? []
					: state.consultationRecord
							.consultationsByState(CONSULTATION_SEAT_STATES)
							.map((consultation) => ({ state: consultation.state })),
			agents: observationRef.current?.lastAgents() ?? null,
			now: Date.now(),
			startupGraceMs: STARTUP_GRACE_MS,
		};
	};
	const currentSeatCount = (): number => parallelSeatCount(parallelSeatFacts());
	return {
		...prev,
		parallelSeatFacts,
		currentSeatCount,
	};
}
type AppSeatFactsStage = ReturnType<typeof useAppSeatFacts>;

/** The seats a Missing Agent left, and the starts in flight. */
function useAppSeatTickets(props: AppProps, prev: AppSeatFactsStage) {
	const { state } = props;
	const { autoModeRef, parallelSeatFacts, configRef } = prev;
	/**
	 * The tickets whose seat stands reserved for their own restart row (ADR 0108):
	 * the in-flight tickets whose Agent the latest poll does not list past the
	 * Startup grace, and that the Top-up can restart - the flag is out, the pane
	 * stands, the Handoff limit leaves room, and Auto-handoff mode runs the
	 * Top-up at all. A seat no restart row will ever take is not reserved: that
	 * is the seat that starves every other start in the queue.
	 */
	const currentMissingSeatTickets = (): string[] => {
		if (state === undefined || !autoModeRef.current) return [];
		const facts = parallelSeatFacts();
		const missing = parallelSeatAccount(facts).missingTickets;
		if (missing.length === 0) return [];
		const blocked = state.ticketWorkCycle.automaticStartBlockedTickets();
		const counts = state.handoff.handoffCountsFor(missing);
		const limit = configRef.current.maxHandoffsPerTicket;
		return facts.tickets
			.filter(
				(ticket) =>
					missing.includes(ticket.ticketIdentity) &&
					ticket.paneId !== null &&
					!blocked.has(ticket.ticketIdentity) &&
					!handoffLimitReached(counts.get(ticket.ticketIdentity) ?? 0, limit),
			)
			.map((ticket) => ticket.ticketIdentity);
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
	return {
		...prev,
		currentMissingSeatTickets,
		noStateHandoffInFlightRef,
		startingTickets,
		setStartingTickets,
		startingTicketsRef,
	};
}
type AppSeatTicketsStage = ReturnType<typeof useAppSeatTickets>;

/** The ticket rows' facts, through the fact module (ADR 0060). */
/**
 * The fact module's read: the screen's inputs and the rows' facts (issue #201).
 *
 * The inputs read from the refs, so the fact answers stay the same across
 * renders: the screen keeps the state, and the fact module owns the rules
 * the state is read through.
 */
function useAppFactReads(prev: AppSeatTicketsStage) {
	const { configRef, pollRef, startingTicketsRef, workQueueRef } = prev;
	const factInputs = useCallback(
		(): TicketFactInputs => ({
			maxHandoffsPerTicket: configRef.current.maxHandoffsPerTicket,
			poll: pollRef.current,
			claims: startingTicketsRef.current,
			queue: workQueueRef.current,
		}),
		[configRef, pollRef, startingTicketsRef, workQueueRef],
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
	return { ...prev, factInputs, factRows, factsFor };
}
type AppFactReadsStage = ReturnType<typeof useAppFactReads>;

/**
 * The Ticket section's list rows and the Group marker's facts (issue #159, ADR 0075).
 *
 * Each Ticket's facts, and the Group header above each run the axis in effect
 * makes. The cursor, the window, the mouse hit test, and the Action bar all
 * read this one list, so a Group header costs a row and takes the cursor
 * exactly like a ticket does. `none` draws the tickets alone in the flat
 * list's order, which is the list exactly as it stood before grouping.
 */
function appTicketListFacts(input: {
	state: AppAggregates | undefined;
	config: FactoryConfig;
	tickets: readonly Ticket[];
	rowFacts: readonly TicketRowFacts[];
	groupingAxis: GroupingAxis;
	folds: GroupFolds;
	storedOrder: string[];
	positionOrder: string[];
}): {
	currentInitHash: string;
	repositoryInitMarkerOf: (value: string) => string | null;
	ticketRowsState: readonly ListedRow<TicketRowFacts>[];
} {
	// The init marker a repository Group header wears (ADR 0075, stories 19 and
	// 22): `uninit` where the plane has not init'd the repository, `drift` where
	// it init'd it under settings that have since changed, and nowhere where the
	// stored fact matches the current settings. The display name the axis groups
	// on maps to the identity the fact keys on through a ticket the Group holds.
	// On every axis but repository the marker is absent, so the column never
	// stands where the init does not act. The current settings' hash is computed
	// once, so the marker compares each Group's fact against it without
	// re-hashing the config per Group: the hash moves only when the config does.
	const currentInitHash = repositoryInitSettingsHash(
		input.config.workflowStates,
		input.config.taskTypes,
	);
	const repositoryInitMarkerOf = (value: string): string | null => {
		if (input.groupingAxis !== "repository") return null;
		const ticket = input.tickets.find((item) => item.repository === value);
		const identity = ticket?.repositoryRef.identity ?? value;
		const fact =
			input.state === undefined ? null : input.state.repositoryInit.repositoryInitFact(identity);
		return repositoryInitStanding(fact, currentInitHash);
	};
	const ticketRowsState = ticketRows(input.rowFacts, input.groupingAxis, {
		folds: input.folds,
		storedOrder: input.storedOrder,
		positionOrder: input.positionOrder,
		groupMarker: repositoryInitMarkerOf,
	});
	return { currentInitHash, repositoryInitMarkerOf, ticketRowsState };
}

/**
 * The Ticket section's list rows and the cursor's ticket (issue #159, ADR 0075).
 */
function useAppTicketFacts(props: AppProps, prev: AppFactReadsStage) {
	const { state } = props;
	const {
		config,
		tickets,
		factRows,
		groupingAxis,
		selectedIndexRef,
		ticketsExpandedRef,
		detailTicketRef,
		groupFolds,
		groupOrderList,
		positionOrderOf,
	} = prev;
	// The list rows, the Group marker's facts, and the settings' hash (issue #159, ADR 0075).
	const { currentInitHash, repositoryInitMarkerOf, ticketRowsState } = appTicketListFacts({
		state,
		config,
		tickets,
		rowFacts: factRows(tickets),
		groupingAxis,
		folds: groupFolds,
		storedOrder: groupOrderList,
		positionOrder: positionOrderOf(),
	});
	const ticketRowsRef = useRef<readonly ListedRow<TicketRowFacts>[]>(ticketRowsState);
	ticketRowsRef.current = ticketRowsState;
	/**
	 * The Ticket under the cursor, read through the refs, so a render and a key
	 * handler see the same fact (issue #159). A Group header holds no Ticket, so
	 * the Ticket controls answer with the catalogue's own words for no
	 * selection; a collapsed Ticket section draws no list at all, so its cursor
	 * names nothing the operator can see, and the controls keep working on the
	 * Ticket the detail pane shows.
	 */
	const ticketAtCursor = (): Ticket | undefined => {
		const row = ticketRowsRef.current[selectedIndexRef.current];
		if (row !== undefined && row.kind === "item") return row.item.ticket;
		if (ticketsExpandedRef.current === false) return detailTicketRef.current;
		return undefined;
	};
	return {
		...prev,
		currentInitHash,
		repositoryInitMarkerOf,
		ticketRowsState,
		ticketRowsRef,
		ticketAtCursor,
	};
}
type AppTicketFactsStage = ReturnType<typeof useAppTicketFacts>;

/** The sources this run polls, and their stale facts. */
function useAppSourceFacts(props: AppProps, prev: AppTicketFactsStage) {
	const { logger } = props;
	const sources = props.sources ?? EMPTY_SOURCES;
	const { config, configRef, commandRunner, healths } = prev;
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
		[commandRunner, logger, configRef],
	);
	// A stale source is a failed refresh the operator must answer to. A
	// removed source is the operator's own config decision: the plane stops
	// reading it and pins no line for it, while its in-flight tickets keep
	// showing with the removed membership.
	// The Ticket sources that are stale right now, in the order the sources
	// list holds: the fact the shared Message module turns into the line and
	// the source health's own Fault at the change (ADR 0118 and ADR 0119).
	// Memoized on the healths: the module's transition effect compares the
	// facts it receives, and it should receive the same reference while the
	// set stands rather than a fresh array on every render.
	const staleSourceFacts = useMemo(
		() =>
			healths
				.filter((health) => health.health === "stale")
				.map((health) => ({ name: health.name, error: health.error })),
		[healths],
	);
	return {
		...prev,
		liveSources,
		attention,
		staleSourceFacts,
	};
}
type AppSourceFactsStage = ReturnType<typeof useAppSourceFacts>;

/** The Message line's state (ADR 0118). */
function useAppMessageState(prev: AppSourceFactsStage) {
	const { themeWarning, attention, staleSourceFacts } = prev;
	// The Theme the control plane paints in, resolved once for the run: the
	// herdr theme when the app runs inside herdr, the standalone dark theme
	// otherwise (ADR 0024). A fallback lands on the Message line and the
	// history's first row as an info notice: it never pins the line, so real
	// news takes over.
	// The Theme the control plane paints in, resolved once for the run: the
	// herdr theme when the app runs inside herdr, the standalone dark theme
	// otherwise (ADR 0024). A fallback lands on the Message line and the
	// history's first row as an info notice: it never pins the line, so real
	// news takes over.
	const messageFacts = useMessageFacts(
		staleSourceFacts,
		themeWarning === null || themeWarning === undefined
			? undefined
			: { severity: "info", text: themeWarning },
		attention,
	);
	const {
		clearOperation: clearOperationMessage,
		notice: setNoticeMessage,
		faultWarning: setFaultWarningMessage,
		faultError: setFaultErrorMessage,
	} = messageFacts;
	/**
	 * Write one machine outcome onto the shared Message facts.
	 *
	 * A `null` outcome ends the fact a previous operation left and leaves every
	 * progress line alone: only the operation that owns a line ends it, and it
	 * says so through `onProgress`. The caller is the machine: the observation
	 * loop, the Consultation operations, and a control the app runs without the
	 * operator. Info becomes a notice, and warning and error are Faults, the
	 * line plus the desktop notification (ADR 0118): the plane met these on its
	 * own, so the operator must hear them even away from the terminal.
	 */
	const setStatus = useCallback(
		(next: StatusMessage | null): void => {
			if (next === null) clearOperationMessage("none");
			else if (next.kind === "info") setNoticeMessage(next.text, "info");
			else if (next.kind === "warning") setFaultWarningMessage(next.text);
			else setFaultErrorMessage(next.text);
		},
		[clearOperationMessage, setNoticeMessage, setFaultWarningMessage, setFaultErrorMessage],
	);
	return {
		...prev,
		visibleMessage: messageFacts.message,
		messageHistory: messageFacts.history,
		setWorkingMessage: messageFacts.working,
		clearWorkingMessage: messageFacts.clearWorking,
		clearProgressMessage: messageFacts.clearProgress,
		clearOperationMessage,
		setNewsMessage: messageFacts.news,
		setNoticeMessage,
		setWarningMessage: messageFacts.warning,
		setErrorMessage: messageFacts.error,
		setFaultWarningMessage,
		setFaultErrorMessage,
		reportMessage: messageFacts.report,
		setStatus,
	};
}
type AppMessageStateStage = ReturnType<typeof useAppMessageState>;

/** The section header's counts and cells (ADR 0049). */
function useAppHeaderFacts(props: AppProps, prev: AppMessageStateStage) {
	const { state } = props;
	const {
		visibleMessage,
		messageHistory,
		currentSeatCount,
		autoMode,
		config,
		machineTickets,
		machineConsultations,
		workQueue,
		listViews,
	} = prev;
	const visibleMessageText = visibleMessage === null ? "" : formatMessage(visibleMessage);
	// The fact the Message control gates on (ADR 0119): the history holds an
	// entry, and the truncation fact goes with the old view it gated.
	const messageRecorded = messageHistory.length > 0;
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
	return {
		...prev,
		visibleMessageText,
		messageRecorded,
		liveCount,
		dispatchPause,
		autoHandoffCell,
		headerFacts,
		heldCount: headerFacts.ticket.held,
		openCount: headerFacts.ticket.open,
		runningCount: headerFacts.ticket.inFlight,
		awaitingCount: headerFacts.ticket.awaiting,
		ignoredCount: headerFacts.ticket.ignored,
		mutedCount: headerFacts.ticket.muted,
	};
}
type AppHeaderFactsStage = ReturnType<typeof useAppHeaderFacts>;

/** The compact size frame's facts: the too-small mark and the size box's own rows (user story 73). */
function useAppCompactLayout(prev: AppHeaderFactsStage) {
	const { terminalWidth, terminalHeight } = prev;
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
	return {
		...prev,
		tooSmall,
		compactBarRows,
		compactMessageRows,
		compactRows,
		compactPadding,
		compactTextWidth,
		compactLineCount,
	};
}
type AppCompactLayoutStage = ReturnType<typeof useAppCompactLayout>;

/** The Main view's layout facts: the body's rows, the sections' boxes, and the detail pane's geometry (ADR 0019, ADR 0049). */
function useAppLayoutFacts(prev: AppCompactLayoutStage) {
	const {
		tooSmall,
		terminalWidth,
		terminalHeight,
		ticketsExpanded,
		consultationsExpanded,
		workExpanded,
		selection,
	} = prev;
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
	// rows.
	const SECTION_BOX_CHROME = 4;
	// The Work section is always visible (ADR 0049): it keeps its header row
	// while it is empty, the way the Ticket and Consultation sections do, so
	// the frame floor holds three sections now.
	const sectionOpen: Record<"tickets" | "consultations" | "work", boolean> = {
		tickets: ticketsExpanded,
		consultations: consultationsExpanded,
		work: workExpanded,
	};
	const boxRows = tooSmall
		? { tickets: 0, consultations: 0, work: 0 }
		: layoutSectionBoxRows(bodyRows, sectionOpen, selection);
	const {
		tickets: ticketsBoxRows,
		consultations: consultationsBoxRows,
		work: workBoxRows,
	} = boxRows;
	const ticketsContentRows = ticketsExpanded ? Math.max(1, ticketsBoxRows - SECTION_BOX_CHROME) : 0;
	const consultationsContentRows = consultationsExpanded
		? Math.max(1, consultationsBoxRows - SECTION_BOX_CHROME)
		: 0;
	const workContentRows = workExpanded ? Math.max(1, workBoxRows - SECTION_BOX_CHROME) : 0;
	return {
		...prev,
		bodyRows,
		leftCols,
		detailReservedRows,
		detailGeometry,
		sectionOpen,
		ticketsBoxRows,
		consultationsBoxRows,
		workBoxRows,
		ticketsContentRows,
		consultationsContentRows,
		workContentRows,
	};
}
type AppLayoutFactsStage = ReturnType<typeof useAppLayoutFacts>;

/** The selected Ticket's pane facts, from the last poll. */
function useAppSelectionFactsTicket(props: AppProps, prev: AppLayoutFactsStage) {
	const { state } = props;
	const {
		ticketAtCursor,
		detailTicketIdentityRef,
		detailTicketRef,
		tickets,
		factsFor,
		detailGeometry,
		config,
	} = prev;
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
		{
			visibleRows: detailGeometry.visibleRows,
			handoffLimit: config.maxHandoffsPerTicket,
			mergeAttempt:
				detailTicket === undefined || state === undefined
					? null
					: state.planeAction.latestPlaneActionAttempt(detailTicket.identity),
		},
	);
	// The write of the render's own answer, for the next render and for the key
	// handlers; the read above is the one this frame's pane paints with.
	detailTicketRef.current = detailTicket;
	const selectedTicket = detailTicket;
	return {
		...prev,
		cursorTicket,
		detailTicket,
		detailMaxScroll,
		selectedTicket,
	};
}
type AppSelectionFactsTicketStage = ReturnType<typeof useAppSelectionFactsTicket>;

/** The selected Consultation's standing facts: the row under the cursor, its Agent pane, and the Ticket's pane facts. */
function useAppSelectionFactsConsultation(prev: AppSelectionFactsTicketStage) {
	const { selectedTicket, agents, consultations, consultationIndex, selection } = prev;
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
	return {
		...prev,
		selectedConsultation,
		selectedConsultationAgentStatus,
		selectedConsultationPaneAlive,
		selectedTicketPaneId,
		selectedTicketPaneAgent,
		selectedTicketPaneAlive,
		selectedTicketPaneForeign,
	};
}
type AppSelectionFactsConsultationStage = ReturnType<typeof useAppSelectionFactsConsultation>;

/**
 * The selected Consultation's record reads: the turns, the snapshots, the
 * replacement's ids, and the remaining resources of a closed record.
 */
function appConsultationRecordReads(
	state: AppAggregates | undefined,
	consultation: Consultation | undefined,
) {
	const closed =
		consultation !== undefined && state !== undefined && consultation.state === "closed";
	return {
		turns:
			consultation === undefined || state === undefined
				? []
				: state.consultationRecord.consultationTurns(consultation.id),
		snapshots:
			consultation === undefined || state === undefined
				? []
				: state.consultationRecord.consultationSnapshots(consultation.id),
		replacementIds:
			consultation === undefined || state === undefined
				? []
				: state.consultationRecord
						.consultations("all")
						.filter((item) => item.replacementOf === consultation.id)
						.map((item) => item.id),
		remaining: closed
			? state.consultationRecord.consultationRemainingResources(consultation.id)
			: [],
	};
}

/**
 * The detail's drawn facts (ADR 0025): the body the detail stands under,
 * the lines it wears, the ansi screen the interaction shows, and the
 * scroll the pane clamps.
 */
function appConsultationDetailFacts(args: {
	consultation: Consultation | undefined;
	agentStatus: string | null;
	interaction: boolean;
	liveOutput: string | null;
	sessionEntries: readonly SessionEntry[] | null;
	turns: readonly ConsultationTurn[];
	snapshots: readonly ConsultationSnapshot[];
	replacementIds: readonly string[];
	remainingResources: readonly ConsultationResource[];
	width: number;
	visibleRows: number;
	consultationScroll: number;
}) {
	// The body the detail stands under (ADR 0025): the Session view reads
	// from the Agent's record, the Agent view from the terminal.
	const consultationBody = consultationDetailBody(
		args.consultation,
		args.interaction ? null : args.liveOutput,
		args.interaction ? null : args.sessionEntries,
	);
	const consultationLines = consultationDetailLines({
		consultation: args.consultation,
		turns: args.turns,
		snapshots: args.snapshots,
		width: args.width,
		liveOutput: args.interaction ? null : args.liveOutput,
		sessionEntries: args.interaction ? null : args.sessionEntries,
		replacementIds: args.replacementIds,
		agentStatus: args.agentStatus,
		remainingResources: args.remainingResources,
	});
	const ansiLines =
		args.interaction && args.liveOutput !== null
			? renderAnsiScreen(args.liveOutput, args.width)
			: undefined;
	const consultationMaxScroll = maxScrollOf(
		ansiLines?.length ?? consultationLines.length,
		args.visibleRows,
	);
	const consultationDetailScroll = Math.min(args.consultationScroll, consultationMaxScroll);
	return {
		consultationBody,
		consultationLines,
		ansiLines,
		consultationMaxScroll,
		consultationDetailScroll,
	};
}

/** The selected Consultation's detail facts (ADR 0025): the record's lines, the body, and the scroll the pane clamps. */
function useAppConsultationDetailFacts(props: AppProps, prev: AppSelectionFactsConsultationStage) {
	const { state } = props;
	const {
		selectedConsultation,
		selectedConsultationAgentStatus,
		detailGeometry,
		liveOutput,
		sessionEntries,
		interaction,
		consultationScroll,
	} = prev;
	const record = appConsultationRecordReads(state, selectedConsultation);
	const detail = appConsultationDetailFacts({
		consultation: selectedConsultation,
		agentStatus: selectedConsultationAgentStatus,
		interaction,
		liveOutput,
		sessionEntries,
		turns: record.turns,
		snapshots: record.snapshots,
		replacementIds: record.replacementIds,
		remainingResources: record.remaining,
		width: detailGeometry.usableCols,
		visibleRows: detailGeometry.visibleRows,
		consultationScroll,
	});
	return {
		...prev,
		consultationTurns: record.turns,
		consultationSnapshots: record.snapshots,
		replacementIds: record.replacementIds,
		consultationWidth: detailGeometry.usableCols,
		remainingResources: record.remaining,
		consultationBody: detail.consultationBody,
		consultationLines: detail.consultationLines,
		ansiLines: detail.ansiLines,
		consultationMaxScroll: detail.consultationMaxScroll,
		consultationDetailScroll: detail.consultationDetailScroll,
	};
}
type AppConsultationDetailFactsStage = ReturnType<typeof useAppConsultationDetailFacts>;

/** The selected Work queue row's detail facts (ADR 0034). */
function useAppSelectionFactsQueue(prev: AppConsultationDetailFactsStage) {
	const { workQueueRows, workQueueIndex, consultations, detailGeometry, workQueueDetailScroll } =
		prev;
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
	return {
		...prev,
		selectedWorkQueueRow,
		selectedWorkQueueConsultationId,
		selectedWorkQueueRecord,
		queueDetailLines,
		workQueueDetailMaxScroll,
		workQueueDetailClampedScroll,
	};
}
type AppSelectionFactsQueueStage = ReturnType<typeof useAppSelectionFactsQueue>;

/** The rows each open section's box takes, split by the cursor's section (ADR 0049). */
function layoutSectionBoxRows(
	bodyRows: number,
	sectionOpen: Record<"tickets" | "consultations" | "work", boolean>,
	selection: "ticket" | "consultation" | "queue",
): { tickets: number; consultations: number; work: number } {
	const openKeys = (["tickets", "consultations", "work"] as const).filter(
		(key) => sectionOpen[key],
	);
	let ticketsBoxRows = 0;
	let consultationsBoxRows = 0;
	let workBoxRows = 0;
	if (openKeys.length > 0) {
		const total = Math.max(0, bodyRows - 3);
		const cursorKey =
			selection === "ticket" ? "tickets" : selection === "consultation" ? "consultations" : "work";
		const take = sectionBoxTake(openKeys, cursorKey, total);
		ticketsBoxRows = take.tickets ?? 0;
		consultationsBoxRows = take.consultations ?? 0;
		workBoxRows = take.work ?? 0;
	}
	return { tickets: ticketsBoxRows, consultations: consultationsBoxRows, work: workBoxRows };
}

/** The rows each open section claims, and the remainder the cursor's section takes. */
function sectionBoxTake(
	openKeys: readonly ("tickets" | "consultations" | "work")[],
	cursorKey: "tickets" | "consultations" | "work",
	total: number,
): Partial<Record<"tickets" | "consultations" | "work", number>> {
	const MIN_SECTION_BOX_ROWS = 7;
	// The section under the cursor takes the remaining rows after the
	// other open sections claim their minimum; at the minimum frame
	// every open section holds its minimum.
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
	return take;
}
function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
