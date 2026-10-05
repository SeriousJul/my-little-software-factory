/**
 * The Handoff dispatch module: one seat for handoffs and environment changes.
 *
 * The module owns the durable claim and settle, the handoff queue, the Close
 * cleanup, the decision screen's route close of the previous handoff's
 * environment, and the name knowledge needed by handoff work.
 * It has no React dependency. The App crosses this interface for operator
 * actions and the observation loop crosses the same interface for automatic
 * work.
 */
import type { FactoryConfig } from "./config.ts";
import type { ConfigWriteReport } from "./config-write.ts";
import type { ConsultationPickupOutcome } from "./consultation-operations.ts";
import { handoffStartFailedLine } from "./domain/attempt-record.ts";
import { queueStagingOf } from "./domain/queue-staging.ts";
import { recordTicketName } from "./domain/record-name.ts";
import type { StartMode } from "./domain/start-mode.ts";
import type { EnvironmentKind, Ticket, TicketState } from "./domain/ticket.ts";
import { inFlightState, issueReferencesOf } from "./domain/ticket.ts";
import {
	type CloseCleanupOptions,
	closeCleanupReach,
	closeHandoffEnvironment,
	closeStoredEnvironment,
	type HandoffChoice,
	type HandoffOutcome,
	handOffTicket,
	handoffReportLines,
	type NameCollision,
	type OwnNameKnowledge,
} from "./handoff.ts";
import type { Logger } from "./logging.ts";
import { overParallelLimit, parallelSeatReading } from "./parallel.ts";
import { evaluatePlacement } from "./placement.ts";
import { isPlaneActionTaskType, planeActionSettingOf } from "./plane-action-registry.ts";
import { runMergePullRequest } from "./plane-actions.ts";
import type { RepositoryMapping } from "./repo.ts";
import { type CommandRunner, errorMessage } from "./runner.ts";
import type { ConsultationRecordAggregate } from "./state/consultation-record.ts";
import type { HandoffAggregate, HandoffClaim, HandoffOrigin } from "./state/handoff.ts";
import type { PlaneActionAggregate } from "./state/plane-action.ts";
import type { SourceFactAggregate } from "./state/source-fact.ts";
import type { TicketWorkCycleAggregate } from "./state/ticket-work-cycle.ts";
import type {
	WorkQueueAggregate,
	WorkQueueConsultationItem,
	WorkQueueHandoffItem,
	WorkQueuePlaneActionItem,
} from "./state/work-queue.ts";
import { workQueueIdentityOf } from "./state/work-queue.ts";
import {
	editCommandFor,
	findFixingPullRequest,
	firePlaneActionOutcome,
	isCoveredByFixingPullRequest,
	writeMembershipLabels,
} from "./workflow.ts";

/** A renderer callback must not strand a durable claim or the dispatch seat. */
function safeReport(report: () => void): void {
	try {
		report();
	} catch {
		// Reporting is best effort. The durable operation still needs to settle.
	}
}

/** The stored handles of the handoff whose environment a cleanup ends. */
export interface StoredHandoffFacts {
	handoffId: string;
	environment: EnvironmentKind;
	tabId: string | null;
	workspaceId: string | null;
}

/**
 * What one Ticket Close leaves behind.
 *
 * The close answers with the two facts its screen words: whether the cycle
 * ended at all, and what herdr said about the environment it could not remove.
 * A close that waited over the seat and met a ticket that had moved on is the
 * refusal, and it ran no command.
 */
export type CloseCycleOutcome =
	/** The cycle ended; `cleanupFailure` is herdr's refusal, when it refused. */
	| { ended: true; cleanupFailure?: string }
	/** Nothing moved: the ticket holds no work cycle to close. */
	| { ended: false; reason: string };

/** The Handoff request crossing the dispatch seam. */
export interface HandoffIntent {
	origin: HandoffOrigin;
	ticketIdentity: string;
	choice: HandoffChoice;
	previousMessage: string;
	/**
	 * An automatic start (ADR 0051): the observation's continuation route, the
	 * re-fired skip's route, the restart, and the newest open ticket from the
	 * top-up. It enters the Work queue like every other start (ADR 0049), and
	 * the queue reads the mark to tell its own lines: the top-up adds one item
	 * at a time into an empty queue, and the pickup of an automatic item skips
	 * the placement a manual start crosses. The waiting row's own detail states
	 * whose start it is - the Work queue's detail pane names the factory's
	 * top-up ask apart from the operator's, which the origin word alone cannot
	 * do because the operator's route and the factory's continuation are both
	 * `workflow`.
	 */
	automatic?: boolean;
	/**
	 * The result of the handoff's own start, reported once when the claimed
	 * handoff settles: `{ ok: true }` when the agent is live, `{ ok: false,
	 * reason }` when it never started. The claim says the dispatch took the
	 * work; only the start says the agent runs. An intent that records nothing
	 * on a start omits it.
	 */
	onStarted?: (started: DispatchResult) => void;
	/**
	 * The ticket this route's handoff continues (ADR 0027): the settled ticket
	 * whose turn the route is the decision of. The handoff starts on the
	 * position's own ticket (`ticketIdentity`) but the settled ticket's
	 * leftover environment is the handoff's own: a name the settled ticket's
	 * leftover agent still holds falls to the cycle name instead of failing as
	 * a stranger. Omitted for a start that is no route, and for a route that
	 * stays on its own ticket.
	 */
	routeFromIdentity?: string;
}

/**
 * Whether dispatch accepted the intent. Every start enters the Work queue
 * first (ADR 0049): an accepted ask owns a queue row, and the immediate pickup
 * pass, the next free seat, or the operator's force-dispatch starts it. A
 * refused claim leaves the ticket where it was and says why, and no start
 * follows. Whether the Agent actually started arrives later, on the intent's
 * `onStarted`: `{ ok: true }` when the agent is live, `{ ok: false, reason }`
 * when the start failed or the row was cancelled.
 */
export type DispatchResult = { ok: true } | { ok: false; reason: string };

/**
 * The answer's refusal reason where the dispatch has been stopped.
 *
 * The reason is a teardown fact, not a handoff refusal: a caller that reads
 * it must not report it as one. The observation's top-up answers it with its
 * own stop instead of a warning line (ADR 0051).
 */
export const STOPPED_DISPATCH_REASON = "the dispatch has been stopped";

/**
 * The plane action's request crossing the dispatch seam (ADR 0068): the merge
 * of the ticket's pull request, asked for by the operator's confirm on the
 * decision screen, by the automatic top-up of a merged position, or by the
 * operator's force-dispatch of the waiting row. The ask owns no settings: the
 * task type's action form carries the method, and the pickup re-reads it from
 * the config when it runs, the way the Consultation's pickup re-reads the
 * type's settings.
 */
export interface PlaneActionIntent {
	/** Where the ask comes from: the decision screen's route, or the open position the top-up asks from. */
	origin: HandoffOrigin;
	/** The ticket whose pull request the merge runs on. */
	ticketIdentity: string;
	/** The task type whose action form the pickup runs. */
	taskType: string;
	/** True for the automatic ask the top-up makes. */
	automatic?: boolean;
	/**
	 * The ticket this route's action continues: the settled ticket whose turn
	 * the route is the decision of. Omitted for a start that is no route, and
	 * for a route that stays on its own ticket.
	 */
	routeFromIdentity?: string;
	/** The result of the action's own run, reported once when the row leaves the queue. */
	onStarted?: (started: DispatchResult) => void;
}

/**
 * The Message and projection callbacks the module may call.
 *
 * The callbacks are the module's one reporting channel. They carry no React
 * types, and tests replace every one with an in-memory recorder, so a module
 * test reads the same text the operator reads. The module reports what its own
 * work leaves behind: the Handoff's progress line, the outcome it settles, and
 * the queued handoff the drain refused. The two answers an operator action
 * waits on - a Close cleanup's failure - comes back as that action's result
 * instead, so one fact never reaches the Message line twice.
 */
export interface HandoffDispatchReports {
	working: (text: string) => void;
	warning: (text: string) => void;
	error: (text: string) => void;
	/** The Message line notice: news the operator should see but no error. */
	notice: (text: string) => void;
	clearWorking: () => void;
	refresh: () => void;
	/**
	 * The Starting window, as the app holds it (ADR 0030): the ticket
	 * identities this run claimed and has not yet settled, by ticket identity.
	 * The module reports the add on the claim and the remove on the settle -
	 * the agent-started outcome and the failed outcome alike - and the app
	 * holds the set as UI state. The set is per run and in memory: a module
	 * this run builds starts from an empty set, so the unresolved attempt a
	 * crashed run leaves behind never reports.
	 */
	starting: (ticketIdentity: string, starting: boolean) => void;
}

/**
 * The Message line one Handoff outcome leaves, and the channel it belongs on.
 *
 * One function owns the wording of a handoff's end, for both callers that
 * report one: the dispatch module, and the App's no-state test projection. A
 * failed outcome is an error; a clean one with something to say is a warning; a
 * clean one with nothing to say leaves no line at all. The order the parts take
 * is the Consultation's own report's order too: `handoffReportLines` in
 * `src/handoff.ts` words it for both (ADR 0103).
 */
export async function reportHandoffOutcome(
	outcome: HandoffOutcome,
	reports: Pick<HandoffDispatchReports, "clearWorking" | "warning" | "error">,
	persistMapping?: (mapping: RepositoryMapping) => Promise<ConfigWriteReport | undefined>,
): Promise<void> {
	const persistReport =
		outcome.notes?.mappingToWrite === undefined || persistMapping === undefined
			? undefined
			: await persistMapping(outcome.notes.mappingToWrite);
	const nameWarning =
		outcome.collision !== undefined && outcome.collision.startedAs !== null
			? // The Message line is one row of the terminal's width, and this fact
				// carries two herdr names. The wording stays short enough that both
				// names read whole on a normal terminal (issue #216, ADR 0098).
				`a leftover agent holds ${outcome.collision.stableName}; this agent started as ${outcome.collision.startedAs}`
			: undefined;
	const lines = handoffReportLines({
		reason: outcome.status === "ok" ? undefined : outcome.reason,
		collision: nameWarning,
		warning: outcome.status === "ok" ? outcome.notes?.warning : undefined,
		write: persistReport,
		worktreeBase: outcome.status === "ok" ? outcome.notes?.worktreeBase : undefined,
		// The moved directory is a fact on the operator's disk whether or not
		// the start landed, so this fact carries no status gate.
		leftoverWorktree: outcome.notes?.leftoverWorktree,
	});
	reports.clearWorking();
	if (outcome.status !== "ok") reports.error(lines.join("; "));
	else if (lines.length > 0) reports.warning(lines.join("; "));
}

/**
 * The aggregates the Handoff dispatch reads, as a list (issue #202), and the
 * clock it stamps its records with.
 */
export interface HandoffDispatchAggregates {
	consultationRecord: ConsultationRecordAggregate;
	handoff: HandoffAggregate;
	planeAction: PlaneActionAggregate;
	sourceFact: SourceFactAggregate;
	ticketWorkCycle: TicketWorkCycleAggregate;
	workQueue: WorkQueueAggregate;
	/** The state clock: the reading a record's timestamp is taken from. */
	now(): number;
}

/** Dependencies of the Handoff dispatch module. */
export interface HandoffDispatchOptions extends HandoffDispatchReports {
	state: HandoffDispatchAggregates;
	runner: CommandRunner;
	/** The current config. A queued handoff reads it when it starts. */
	config: () => FactoryConfig;
	/**
	 * The Parallel limit seats held now, from one shared source (ADR 0034):
	 * the ticket seats, the unresolved claims, and the Consultation seats.
	 * A manual start at a full cap enters the Work queue instead of starting.
	 */
	seatCount: () => number;
	/**
	 * The Work queue's Consultation side (ADR 0034, issue #90): start the
	 * `queued` Consultation an item names. The module crosses this to the
	 * Consultation operations, which own the settings re-read, the seat move,
	 * the Consultation start line, and the opening the record runs behind the
	 * answer (issue #220). The mode names the path this module ran the start
	 * on - the pickup, or the operator's force-dispatch - because the path is
	 * the queue's fact while the line that states it is the Consultation
	 * module's. Absent where the app has no Consultation side, and a loop
	 * without the side leaves the item standing for a later cycle.
	 */
	pickupConsultation?: (
		consultationId: string,
		mode: StartMode,
	) => Promise<ConsultationPickupOutcome>;
	home: string;
	/** Persist a repository mapping discovered during handoff, if one is found. */
	persistMapping?: (mapping: RepositoryMapping) => Promise<ConfigWriteReport | undefined>;
	/**
	 * The plane's file logger. The dispatch leaves the record's start lines and
	 * queue lines, for a Handoff and for a Plane action alike: a start with its
	 * start mode, its origin, its staging, and its seat reading, a queue, and a
	 * refusal with its reason - the standing-row refusal and a refused claim once
	 * for the fact that stands, not once per ask. A Consultation's start line is
	 * not one of them: the Consultation operations leave it (issue #220).
	 */
	log?: Logger;
}

/**
 * The small interface shared by operator and observation callers.
 *
 * A dispatch result answers only whether the claim was accepted. The optional
 * intent report answers later whether an agent actually started.
 */
export interface HandoffDispatch {
	/**
	 * Every Handoff origin: open, workflow, restart, observation loop.
	 *
	 * The route a decision screen asks for - the manual workflow start - also
	 * closes the settled ticket's previous handoff environment at the ask
	 * (ADR 0046): a start that takes its seat now closes it before it builds
	 * its own, and a start that waits in the Work queue closes it at the
	 * enqueue. The automatic route and the restart keep the stored workspace
	 * and reuse it.
	 */
	dispatch(intent: HandoffIntent): Promise<DispatchResult>;
	/**
	 * The Work queue's pickup (ADR 0049): the items the free seats take, in
	 * queue order. A pickup is a manual start: every hard check the claim
	 * runs still runs, and a pickup that fails one ends in start or drop - the
	 * item leaves the queue with the warning that names the reason, and the
	 * ticket keeps the state it wore while it waited. Returns the items that
	 * claimed a seat this call. The observation cycle calls it, before
	 * auto-dispatch, and the queue pause (ADR 0052) holds the drain.
	 */
	pickupWorkQueue(): Promise<number>;
	/**
	 * The force-dispatch of one Work queue item (issue #89, ADR 0034): starts
	 * the item now, even when the Parallel limit is full. The claim re-runs
	 * every hard start check the pickup runs - the ticket still holds the state
	 * the item's origin requires, the source is healthy, the attempt ledger is
	 * clear - and skips only the cap, so the seat count may stand over the
	 * limit until the work settles. A failure ends as a pickup failure with the
	 * one difference the operator asked for: the item leaves the queue, the
	 * Message line warns, and the ticket keeps its state and its own failure
	 * surface. A seat a Close cleanup holds while it queues parks the claim, and
	 * the item leaves only when that parked start settles.
	 *
	 * The Consultation item runs the Consultation's own pickup seam (ADR 0034,
	 * issue #90): the seat move is the claim, the opening runs on behind the
	 * answer, and the item leaves the queue on every answer, the way its pickup
	 * does - the cap was the pickup scheduler's check, not the pickup's, so the
	 * seam skips it without skipping any start check. The started line names the
	 * cap when the seat count stood over the limit at the key, and says the
	 * pickup's own words when it did not.
	 *
	 * `itemIdentity` is the row's identity: the ticket identity of a Handoff
	 * item, the Consultation id of a Consultation item. The two columns are
	 * unique and disjoint, so the string names the row (ADR 0034, issue #90).
	 */
	forceDispatchWorkQueueItem(itemIdentity: string): void;
	/**
	 * Drop one ticket's waiting start from the Work queue, and forget every fact
	 * the module holds for it: the claim a pickup already made and the held herdr
	 * seat it parked, and the start report the ask handed the module. The queue's
	 * bookkeeping lives behind this seam, so a row, its parked claim, and its
	 * held intent always leave together: a cancelled ask never answers a later
	 * start of the same ticket, and a start that had not reached herdr never
	 * runs. A run already inside herdr cannot be recalled, so it finishes, keeps
	 * the row gone, and answers its own ask (ADR 0049).
	 *
	 * The answer says whether a row left: false reports that the row had already
	 * gone, which is how a start that answers late reads the operator's cancel.
	 */
	removeQueueItem(ticketIdentity: string): boolean;
	/**
	 * Drop one Consultation's waiting item from the Work queue (ADR 0034,
	 * issue #90). The record keeps its `queued` state: the removal is the item's,
	 * not the record's, and the ask stands behind the pointer it loses. The
	 * module holds no claim and no held intent for a Consultation, so only the
	 * row leaves: a later re-enqueue of the same record starts clean.
	 *
	 * The answer says whether a row left, the way `removeQueueItem` does:
	 * false reports that the row had already gone, which is how a keypress that
	 * met a queue that no longer held the row reads it back.
	 */
	removeConsultationQueueItem(consultationId: string): boolean;
	/**
	 * The Close cleanup of one ended cycle. Returns the failure reason, or
	 * undefined. `end` stays on the seam so manual and observation callers share
	 * the same operation shape; the caller owns the wording of the answer.
	 */
	closeCleanup(
		identity: string,
		handoff: StoredHandoffFacts,
		end: "closed" | "abandoned",
	): Promise<string | undefined>;
	/**
	 * The plane action's ask (ADR 0068): the merge of the ticket's pull
	 * request, entered in the Work queue like every other start. The item
	 * takes no seat from the Parallel limit: the action holds no agent, and
	 * the pickup's walk runs it when it reaches it, whatever the cap bounds.
	 * The ask's gates are the
	 * route's: the ticket still holds the state the ask asked from, the one
	 * item per ticket rule holds, and the task type must carry the action
	 * form the registry names. The decision word lands at the ask, the way
	 * the route's does: `merged` for the operator's confirm, `auto-merged`
	 * for the top-up's. Returns whether the ask enqueued; the run's answer
	 * arrives on the intent's `onStarted`.
	 */
	dispatchPlaneAction(intent: PlaneActionIntent): Promise<DispatchResult>;
	/**
	 * Close the work cycle of a ticket whose turn never settled (ADR 0031).
	 *
	 * The cycle's end and the Close cleanup of the environment it ran in are one
	 * operation on the shared seat: a close that meets a Handoff of the same
	 * ticket runs after that Handoff settles, so no cleanup tears down an
	 * environment herdr is still building, and a hung start still ends in the
	 * close the operator asked for. The durable end writes no completion trace,
	 * because the turn never settled.
	 *
	 * The caller owns the wording of the answer, exactly as it does for
	 * `closeCleanup`.
	 */
	closeWorkCycle(identity: string): Promise<CloseCycleOutcome>;
	/**
	 * True while a Handoff holds the seat. The catalogue fact the normal Quit
	 * gates on (ADR 0064): the ask controls no longer wait on a run, and the
	 * Quit is the one control that tears down the process mid-run.
	 */
	handoffActive(): boolean;
	/**
	 * Stop the module. A handoff run still in flight settles neither state nor
	 * reports after this, and no new work starts. The app calls it on teardown,
	 * before it closes the state the module writes to: without it the run's
	 * settlement reads a closed database.
	 */
	stop(): void;
}

/** Build one Handoff dispatch module for one durable state database. */
export function createHandoffDispatch(options: HandoffDispatchOptions): HandoffDispatch {
	return new HandoffDispatchModule(options);
}

/**
 * The fact the Work queue's one-item-per-ticket rule states (ADR 0049), without
 * the ticket's name. The reason the Message line carries puts the name in front
 * of it; the record line puts the name in front of the whole fact, the way every
 * other refusal line does (issue #223).
 */
const QUEUE_ITEM_STANDS_FACT = "already has a waiting queue item; the first item keeps its place";
/** The fact a merge run already in flight refuses a re-ask with (ADR 0104, issue #223). */
const MERGE_RUN_STANDS_FACT = "already has a merge running; the first run stands";

/**
 * The key a claim refusal's standing fact stands on: the start channel and the
 * ticket. The prefix carries no colon, so the join names one pair (issue #223).
 */
function claimRefusalKey(prefix: "handoff" | "merge", ticketIdentity: string): string {
	return `${prefix}:${ticketIdentity}`;
}

/** The seat, the queues, and the work of one durable state database. */
class HandoffDispatchModule implements HandoffDispatch {
	private readonly state: HandoffDispatchAggregates;
	private readonly runner: CommandRunner;
	private readonly config: () => FactoryConfig;
	private readonly seatCount: () => number;
	private readonly pickupConsultation?: (
		consultationId: string,
		mode: StartMode,
	) => Promise<ConsultationPickupOutcome>;
	private readonly home: string;
	private readonly reports: HandoffDispatchReports;
	private readonly persistMapping?: (
		mapping: RepositoryMapping,
	) => Promise<ConfigWriteReport | undefined>;
	private readonly log?: Logger;

	/** True while external handoff work holds the seat. */
	private inFlight = false;
	/**
	 * True after `stop`. A run that finishes after the stop must not settle the
	 * state the app has already closed or report into an unmounted UI, so every
	 * settlement checks this first.
	 */
	private stopped = false;
	/** True while one cleanup is executing. */
	private clearing = false;
	/** True from the moment any cleanup queues until the cleanup queue drains. */
	private cleanupQueued = false;
	private cleanupQueue: QueuedCleanup[] = [];
	private handoffQueue: QueuedHandoff[] = [];
	/**
	 * The start report the operator's ask asked for (the intent's `onStarted`),
	 * held per ticket until the item it enqueued answers: the pickup that starts
	 * it, the drop that refuses it, or the cancel that removes it. A queued item
	 * answers its ask from wherever it leaves the queue (ADR 0049), so the ask's
	 * route decision and the test's await both resolve when the start lands.
	 */
	private intentOnStarted = new Map<string, (started: DispatchResult) => void>();
	/**
	 * The tickets whose Plane action run is in flight: from the pickup's claim,
	 * when the Work queue row leaves the queue, until that run settles.
	 *
	 * The queue's one-item-per-ticket rule can only answer for a row that still
	 * stands, and the Plane action's attempt row is written only after its run
	 * (ADR 0068), so between the claim and the settle no durable fact names the
	 * run. A re-ask in that window would stand for a second run of the same
	 * merge, and the source answers the second command as a block.
	 */
	private planeActionRunsInFlight = new Set<string>();

	/**
	 * The tickets whose standing-row refusal the record has already stated (issue #223).
	 *
	 * One entry per ticket, and the entry stands for the row that stands: the Work
	 * queue holds at most one row per ticket, so the ticket names the row, and no
	 * timestamp is read for the fact. The rule is one sentence - the entry stands
	 * while the row stands - and two paths keep it. Every path this module runs that
	 * takes a row out drops the entry, and a successful enqueue drops it too: the
	 * queue holds one row per ticket, so an enqueue can only land once the row
	 * before it left, whatever aggregate took that row out. The pickup pass sweeps
	 * the entries whose row is gone, which covers the removals this module never saw
	 * - the App's route removal at a close, another aggregate's cross-boundary drop
	 * - and bounds the set to the rows that stand (issue #223 review). The cycle
	 * prunes its held-Next-step reports on the same rule.
	 */
	private readonly queueItemRefusals = new Set<string>();

	/**
	 * The refusals of a merge run already in flight that the record has stated
	 * (issue #223). The run's mark is the fact: it stands from the claim until the
	 * run settles, and the entry stands with it, so the walks that re-ask every
	 * observation cycle while one merge lands state the refusal once, the way the
	 * standing-row refusal does. The settle drops it.
	 */
	private readonly mergeRunRefusals = new Set<string>();

	/**
	 * The claim refusals the record has already stated, keyed by the start channel
	 * and the ticket, and holding the fact each one stated beside the attempt ledger
	 * it stood on (issue #223).
	 *
	 * A claim refusal is a standing fact too: it is the answer the position's hard
	 * gates give for the state the ticket is in, and the automatic walks re-ask the
	 * same position every observation cycle. The same reason over an unchanged
	 * attempt ledger is the same fact and states itself once; another reason, or the
	 * same reason over a ledger that moved, is a new fact and states itself again.
	 * The ledger is what closes the hole the reason alone leaves: a stale claim can
	 * settle outside this module - a restart's recovery, the observation cycle's
	 * reclaim - and a refusal behind a later claim is a new fact even when no claim
	 * ever came through here (issue #223 review). A reason that names a state
	 * carries its own change in its own words: the ticket's state and the source's
	 * freshness are part of the sentence, so the reason moves with the fact.
	 *
	 * The channel is part of the key because the record line is a channel's line: a
	 * reader grepping `merge refused:` must get the merge refusals and nothing else.
	 * The map holds one entry per ticket per channel, and a new fact replaces it in
	 * place, so it cannot grow past the tickets the run refused.
	 */
	private readonly claimRefusals = new Map<string, { fact: string; attempts: number }>();

	constructor(options: HandoffDispatchOptions) {
		this.state = options.state;
		this.runner = options.runner;
		this.config = options.config;
		this.seatCount = options.seatCount;
		this.pickupConsultation = options.pickupConsultation;
		this.home = options.home;
		this.persistMapping = options.persistMapping;
		this.log = options.log;
		this.reports = {
			working: (text) => safeReport(() => options.working(text)),
			warning: (text) => safeReport(() => options.warning(text)),
			error: (text) => safeReport(() => options.error(text)),
			notice: (text) => safeReport(() => options.notice(text)),
			clearWorking: () => safeReport(options.clearWorking),
			refresh: () => safeReport(options.refresh),
			starting: (identity, active) => safeReport(() => options.starting(identity, active)),
		};
	}

	handoffActive(): boolean {
		return this.inFlight;
	}

	stop(): void {
		this.stopped = true;
	}

	/**
	 * Answer the ask's start report once, when its item leaves the queue. The
	 * callback is held per ticket and deleted on the first answer, so a pickup
	 * and a force-dispatch that race the same row answer the ask a single time.
	 */
	private settleIntentOnStarted(ticketIdentity: string, started: DispatchResult): void {
		const answer = this.intentOnStarted.get(ticketIdentity);
		if (answer === undefined) return;
		this.intentOnStarted.delete(ticketIdentity);
		safeReport(() => answer(started));
	}

	dispatch(intent: HandoffIntent): Promise<DispatchResult> {
		if (this.stopped) return Promise.resolve({ ok: false, reason: STOPPED_DISPATCH_REASON });
		// A start on a plane action's task type crosses the plane action's
		// channel, not the handoff's (ADR 0068): the action form holds no
		// template and no profile, so the handoff's pickup would refuse it with
		// `carries no prompt template`. The route keeps the Work queue as its
		// one channel, and the plane action's own gates run on its own ask.
		if (isPlaneActionTaskType(this.config().taskTypes, intent.choice.taskType)) {
			return this.dispatchPlaneAction({
				origin: intent.origin,
				ticketIdentity: intent.ticketIdentity,
				taskType: intent.choice.taskType,
				routeFromIdentity: intent.routeFromIdentity,
				automatic: intent.automatic,
				onStarted: intent.onStarted,
			});
		}
		// The Work queue is the single start channel (ADR 0049): every start,
		// manual or automatic, enters the queue first, and the immediate pickup
		// pass takes it when a seat is free. The claim's hard gates run before
		// the ask, the way the claim runs them: a gate the ask fails is a
		// refusal, not a queued item.
		const check = this.state.handoff.handoffClaimCheck(intent.ticketIdentity, intent.origin);
		if (!check.ok) {
			this.refuseClaim("handoff", intent.ticketIdentity, check.reason);
			return Promise.resolve({ ok: false, reason: check.reason });
		}
		this.forgetClaimRefusal("handoff", intent.ticketIdentity);
		const enqueued = this.enqueueWork(intent);
		if (!enqueued.ok) return Promise.resolve(enqueued);
		// The ask's start report answers from the item's pickup, drop, or cancel
		// (ADR 0049): hold it here until the item leaves the queue.
		if (intent.onStarted !== undefined)
			this.intentOnStarted.set(intent.ticketIdentity, intent.onStarted);
		// The queue pause (ADR 0052): the ask sits in the queue until the
		// resume, and the resume starts the pickup that takes it.
		if (this.state.workQueue.queuePaused()) {
			this.reports.notice(
				`handoff of ${this.ticketName(intent.ticketIdentity)} is in the Work queue; the queue is paused`,
			);
			return Promise.resolve({ ok: true });
		}
		// An immediate pickup pass follows every enqueue (ADR 0049): the ask
		// takes a free seat now, or waits in the queue for one. The pass runs on
		// behind the answer, the way every other pickup does. The pass names the
		// item the operator's own ask enqueued, so that item's start line reads
		// `direct-ask` and not the `pickup` a later cycle writes (issue #209).
		void this.runPickupPass(directAskOf(intent, intent.ticketIdentity));
		return Promise.resolve({ ok: true });
	}

	/**
	 * The plane action's ask (ADR 0068): the merge of the ticket's pull
	 * request, entered in the Work queue like every other start. The item
	 * takes no seat from the Parallel limit, so the pickup's walk runs it
	 * when it reaches it, and the queue pause holds it the way it holds
	 * every item: the ask sits in the queue until the resume.
	 */
	dispatchPlaneAction(intent: PlaneActionIntent): Promise<DispatchResult> {
		if (this.stopped) return Promise.resolve({ ok: false, reason: STOPPED_DISPATCH_REASON });
		// The registry is the one home of the names the config may name (ADR
		// 0068): a task type the registry does not hold is a refusal, not a
		// queued item.
		if (planeActionSettingOf(this.config().taskTypes, intent.taskType) === null)
			return Promise.resolve({
				ok: false,
				reason: `task type ${intent.taskType} carries no plane action`,
			});
		const check = this.planeActionClaimCheck(intent.ticketIdentity);
		if (!check.ok) {
			this.refuseClaim("merge", intent.ticketIdentity, check.reason);
			return Promise.resolve({ ok: false, reason: check.reason });
		}
		this.forgetClaimRefusal("merge", intent.ticketIdentity);
		if (this.state.workQueue.hasWorkItem(intent.ticketIdentity))
			return Promise.resolve(this.refuseStandingQueueItem("merge", intent.ticketIdentity));
		// The run's own hold, beside the queue's: the row of a merge already in
		// flight left the queue at its claim, so `hasWorkItem` cannot see it, and
		// the run's fresh read cannot either - the source still answers the pull
		// request open while the merge is landing.
		if (this.planeActionRunsInFlight.has(intent.ticketIdentity))
			return Promise.resolve(this.refuseMergeRunStanding(intent.ticketIdentity));
		const enqueued = this.state.workQueue.enqueuePlaneActionWork({
			ticketIdentity: intent.ticketIdentity,
			routeFromIdentity: intent.routeFromIdentity ?? null,
			origin: intent.origin,
			taskType: intent.taskType,
			automatic: intent.automatic === true,
		});
		if (!enqueued.ok) return Promise.resolve(enqueued);
		// A row stands for this ticket now, and it is a new one: the refusal the
		// standing row before it earned is no longer the fact it stated (issue #223).
		this.forgetStandingRowRefusal(intent.ticketIdentity);
		if (intent.onStarted !== undefined)
			this.intentOnStarted.set(intent.ticketIdentity, intent.onStarted);
		// The decision word lands at the ask, the way the route's does (ADR
		// 0064): the settled turn ends its cycle in the same write that lands
		// the decision (ADR 0072), and the open position keeps its open state,
		// the wait standing on the item alone.
		this.recordPlaneActionDecision(intent);
		if (intent.origin === "workflow") {
			// The merge ask closes the settled turn's environment at the ask, the
			// confirm's ask and the top-up's alike (ADR 0046, ADR 0068): the close
			// takes the seat, the way every environment change does, so it runs
			// the moment the seat is free and never under a run. The merge run
			// builds no environment of its own, so the close is the ask's whole
			// act on the environment. A merge that keeps the environment keeps it
			// for nobody: the run retires the ticket the moment it lands, and no
			// later act reaches the workspace herdr still holds.
			const closeIdentity = intent.routeFromIdentity ?? intent.ticketIdentity;
			void this.queueCleanup(async () => {
				const failure = await this.closePreviousHandoffEnvironment(closeIdentity);
				if (failure !== undefined)
					this.reports.warning(`the previous handoff's environment did not close: ${failure}`);
				this.reports.refresh();
			});
		}
		this.log?.info(
			`merge queued: ${this.ticketName(intent.ticketIdentity)} ` +
				`(origin ${intent.origin}, ${queueStagingOf(intent.automatic === true)})`,
		);
		this.reports.refresh();
		this.reports.notice(
			`the merge of ${this.ticketName(intent.ticketIdentity)} is in the Work queue`,
		);
		// The queue pause (ADR 0052): the ask sits in the queue until the
		// resume, and the resume starts the pickup that takes it.
		if (this.state.workQueue.queuePaused()) {
			this.reports.notice(
				`the merge of ${this.ticketName(intent.ticketIdentity)} waits in the Work queue; the queue is paused`,
			);
			return Promise.resolve({ ok: true });
		}
		// The item takes no seat, so the pickup's walk runs it when it
		// reaches it, whatever the limit reads (ADR 0068); the pass runs on
		// behind the answer, the way every other pickup does. The pass names the
		// item the operator's own ask enqueued, the way the handoff's does
		// (issue #209).
		void this.runPickupPass(directAskOf(intent, intent.ticketIdentity));
		return Promise.resolve({ ok: true });
	}

	/**
	 * The position's gates for the plane action's ask and its pickup (ADR
	 * 0068, ADR 0072): the ticket still exists, and the position the action
	 * runs on stands open or awaiting, the way the continuation's position
	 * check reads it. The claim does not ask the source ticket's state
	 * whether the route stands: the source ends its cycle at the ask and rests
	 * open behind the wait, and the wait is the item's, not a ticket state.
	 */
	private planeActionClaimCheck(
		ticketIdentity: string,
	): { ok: true } | { ok: false; reason: string } {
		const currentState = this.state.ticketWorkCycle.ticketState(ticketIdentity);
		if (currentState === undefined) return { ok: false, reason: "the ticket no longer exists" };
		if (currentState !== "open" && currentState !== "awaiting")
			return { ok: false, reason: `the ticket is now ${currentState}` };
		return { ok: true };
	}

	/**
	 * Land the plane action's decision word at the ask (ADR 0068, ADR 0064):
	 * `merged` for the operator's confirm, `auto-merged` for the top-up's. The
	 * record reads the settled ticket's latest handoff, the same fact the
	 * claim reads at the claim, and reuses the state's one decision writer:
	 * the writer takes the first decision on a turn, so a re-asked route
	 * re-lands the same decision as a no-op. A route with no settled turn has
	 * no pending row to land on, and the open position keeps its open state,
	 * the wait standing on the item alone (ADR 0072).
	 */
	private recordPlaneActionDecision(intent: PlaneActionIntent): void {
		if (intent.origin === "workflow") {
			const routeFrom = intent.routeFromIdentity ?? intent.ticketIdentity;
			const previousHandoffId = this.state.handoff.latestHandoff(routeFrom)?.handoffId ?? "";
			if (previousHandoffId !== "")
				this.state.ticketWorkCycle.applyCompletionDecision({
					ticketIdentity: routeFrom,
					handoffId: previousHandoffId,
					decision: intent.automatic === true ? "auto-merged" : "merged",
					decidedAt: new Date(this.state.now()).toISOString(),
				});
		}
	}

	/**
	 * The plane action's item pickup (ADR 0068): the merge of the ticket's
	 * pull request, run through the command runner. The item takes no seat and
	 * is not held by the cap: the pickup's walk runs it when it reaches it, and
	 * a full limit only holds it behind a seats-bound item the walk breaks
	 * at, the way it holds everything behind. The claim is the row's removal,
	 * taken before the run starts: the item takes no seat to hold the start,
	 * so the row is the claim, and two walks that both read the queue before
	 * either claims cannot both run the merge - the second claim finds no row
	 * and leaves, and the run stands once. The claim also takes the run's mark,
	 * held until the run settles: the row is the claim, and once it is gone the
	 * queue's one-item-per-ticket rule cannot see the run, so the mark is what
	 * holds a re-ask off a merge that is already landing. The run's gates are
	 * the route's -
	 * the ticket still stands, and the task type still carries the action
	 * form the registry names. The run reads the pull request fresh before
	 * it runs, so an already-merged pull request settles as merged without a
	 * command, and the run's outcome records the attempt, fires the task
	 * type's transition on the outcome alike for a merge and a block, and
	 * settles the route without a work cycle. Every pickup ends in run or
	 * drop: a refused claim drops the item with its warning, and the queued
	 * route settles to open on it, because a dropped merge leaves no
	 * re-offer standing and no machine path back to the wait.
	 */
	private async pickupPlaneActionItem(
		item: WorkQueuePlaneActionItem,
		overCap: boolean,
		mode: StartMode,
	): Promise<void> {
		// The claim: the row leaves the queue before the run starts, the way
		// the handoff pickup's seat claim takes the start. A row another walk
		// already took leaves, and its run stands.
		if (!this.removeQueueRow(item.ticketIdentity)) return;
		// The run's mark rides the claim, and the mark holds until the run
		// settles: the row is the claim, and the row is gone, so the mark is the
		// only fact that says this ticket's merge runs. Every ask in the window
		// reads it, and the run's own fresh read cannot.
		this.planeActionRunsInFlight.add(item.ticketIdentity);
		try {
			await this.runPlaneActionItem(item, overCap, mode);
		} finally {
			this.planeActionRunsInFlight.delete(item.ticketIdentity);
			// The run settled, so the fact its refusal stated is gone: a later ask
			// refused behind a new run is a new fact and states itself again.
			this.mergeRunRefusals.delete(item.ticketIdentity);
		}
	}

	private async runPlaneActionItem(
		item: WorkQueuePlaneActionItem,
		overCap: boolean,
		mode: StartMode,
	): Promise<void> {
		const check = this.planeActionClaimCheck(item.ticketIdentity);
		if (!check.ok) {
			this.settleIntentOnStarted(item.ticketIdentity, { ok: false, reason: check.reason });
			this.reports.refresh();
			this.reports.warning(
				`the merge of ${this.ticketName(item.ticketIdentity)} was not run: ${check.reason}`,
			);
			return;
		}
		const config = this.config();
		const setting = planeActionSettingOf(config.taskTypes, item.taskType);
		if (setting === null) {
			this.settleIntentOnStarted(item.ticketIdentity, {
				ok: false,
				reason: `task type ${item.taskType} carries no plane action`,
			});
			this.reports.refresh();
			this.reports.warning(
				`the merge of ${this.ticketName(item.ticketIdentity)} was not run: task type ${item.taskType} carries no plane action`,
			);
			return;
		}
		// The projection before the list rule, the way the pickup's covered gate
		// reads it: the rule withholds exactly the ticket this pickup asked for.
		const projection = this.state.ticketWorkCycle.projectedTickets(
			config.workflowStates,
			config.defaultTaskType,
		);
		const ticket = projection.find((candidate) => candidate.identity === item.ticketIdentity);
		if (ticket === undefined) {
			this.settleIntentOnStarted(item.ticketIdentity, {
				ok: false,
				reason: "the ticket is no longer visible",
			});
			this.reports.refresh();
			this.reports.warning(
				`the merge of ${this.ticketName(item.ticketIdentity)} was not run: the ticket is no longer visible`,
			);
			return;
		}
		// The merge runs on the ticket's pull request: the position's own pull
		// request when the position is one, and its fixing pull request when
		// the position is the ticket the pull request fixes.
		const pullRequest =
			ticket.sourceKind === "github-pull-request"
				? ticket
				: findFixingPullRequest(projection, ticket);
		if (pullRequest === null) {
			// No attempt for a merge that could not aim: the row drops with its
			// warning.
			this.settleIntentOnStarted(item.ticketIdentity, {
				ok: false,
				reason: "no linked pull request was found for the ticket",
			});
			this.reports.refresh();
			this.reports.warning(
				`the merge of ${this.ticketName(item.ticketIdentity)} was not run: no linked pull request was found for the ticket`,
			);
			return;
		}
		// The name the run's line words the ticket by, read while the ticket
		// still stands: the merged ticket's retirement leaves it from the
		// projection before the line lands (ADR 0068).
		const name = this.ticketName(item.ticketIdentity);
		// The merge's start line, the way a handoff's start is reported (issue
		// #209): the mode that ran it, the item's origin, and the seat reading.
		// The action takes no seat, so its reading is the count the plane stood
		// on at the start, never a count the merge raised.
		this.log?.info(
			`merge started: ${name} (mode ${mode}, origin ${item.origin}, ` +
				`${queueStagingOf(item.automatic)}, ${this.seatReading()})`,
		);
		// The Starting window the row's spinner face reads (ADR 0030, beside
		// ADR 0068): the merge wears the same face the start wears while its
		// command runs, so the operator sees the plane at work.
		this.reports.starting(item.ticketIdentity, true);
		const result = await runMergePullRequest({
			runner: this.runner,
			sources: config.sources,
			pullRequest,
			method: setting.method,
		});
		// A stop over the run's commands: the app closed or is closing the
		// state behind the run, and a settle it writes into it reads a closed
		// database. The run's settle stands on the restart the way a crash
		// does: the fresh read finds the merge landed, and the source leaves
		// the merged pull request at its next refresh.
		if (this.stopped) return;
		// The attempt is the durable record of the merge the plane ran (ADR
		// 0068): the row stands for the Handoff limit's count, and the
		// outcome's fire lands its fact on the row, because no Completion
		// trace stands for the action. No durable row stands before the
		// external change: the row is the record of the run, written after the
		// run, and a crash between the change and the record settles the same
		// way on the restart, through the fresh read.
		const attempt = this.state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: item.ticketIdentity,
			taskType: item.taskType,
			decision: item.automatic ? "auto-merged" : "merged",
			outcome: result.outcome,
			reason: result.reason,
			at: new Date(this.state.now()).toISOString(),
		});
		// The fire runs on both outcomes alike, and its fact lands on the
		// attempt's record; the label writes it converges, the way a blocked
		// merge's needs-work label does on the crash-restart.
		await firePlaneActionOutcome({
			config,
			state: this.state,
			runner: this.runner,
			ticketIdentity: item.ticketIdentity,
			taskType: item.taskType,
			attempt: { id: attempt.id, ticketIdentity: item.ticketIdentity, taskType: item.taskType },
			stopped: () => this.stopped,
		});
		// The stop over the fire's label reads: the retirement writes into the
		// state the stop closed, and a settle it skips stands on the restart
		// the same way.
		if (this.stopped) return;
		// The merged pull request leaves the projection the moment the merge
		// lands, and so does every issue it closed on the merge: the sources
		// stop returning them at the next refresh, and the retirement does it
		// now, the way that refresh would (ADR 0068).
		if (result.outcome === "merged") {
			const closedIssueIdentities = new Set<string>();
			for (const membership of pullRequest.memberships)
				for (const reference of issueReferencesOf(membership.attributes))
					if (reference.identity !== null) closedIssueIdentities.add(reference.identity);
			this.state.sourceFact.retireTicket(pullRequest.identity);
			for (const identity of closedIssueIdentities) this.state.sourceFact.retireTicket(identity);
		}
		// The row left at the claim, the way the Consultation's pickup
		// leaves it. The tickets keep the states the ask left them in
		// (ADR 0072): the source ended its cycle at the ask, and the open
		// position's wait was the item's alone.
		this.settleIntentOnStarted(item.ticketIdentity, { ok: true });
		this.reports.refresh();
		this.reports.starting(item.ticketIdentity, false);
		if (result.outcome === "merged") {
			this.reports.notice(
				overCap
					? `force-dispatched the merge of ${name} over the Parallel limit`
					: `the merge of ${name} ran from the Work queue`,
			);
		} else {
			// The block stands on the Message line in the warning voice, with
			// no bell (ADR 0068): the pull request's comment carries the fact
			// to the source, and the needs-work label the fire wrote carries it
			// to the machine.
			this.reports.warning(`the merge of ${name} was blocked: ${result.reason}`);
		}
	}

	/**
	 * The cap-full answer for a manual start (ADR 0034): the start waits in the
	 * Work queue with its origin and captured choice, and the ticket keeps its
	 * state. The queue holds at most one item per ticket: a second enqueue for
	 * a ticket that already waits is refused with the reason on the Message
	 * line, and the first item keeps its place.
	 *
	 * A refusal is reported on the Message line once, through the returned reason
	 * alone: every caller of `dispatch` writes an refused result's reason there, so
	 * a warning reported on top of it would only overwrite that first line with a
	 * shorter copy of the same fact. The file record is the other outlet, and it
	 * states a standing-row refusal once for the row that stands, not once per ask
	 * (issue #223).
	 */
	private enqueueWork(intent: HandoffIntent): DispatchResult {
		if (this.state.workQueue.hasWorkItem(intent.ticketIdentity))
			return this.refuseStandingQueueItem("handoff", intent.ticketIdentity);
		const enqueued = this.state.workQueue.enqueueWork({
			ticketIdentity: intent.ticketIdentity,
			routeFromIdentity: intent.routeFromIdentity ?? null,
			origin: intent.origin,
			choice: intent.choice,
			previousMessage: intent.previousMessage,
			automatic: intent.automatic === true,
		});
		if (!enqueued.ok) return { ok: false, reason: enqueued.reason };
		// A row stands for this ticket now, and it is a new one: the refusal the
		// standing row before it earned is no longer the fact it stated (issue #223).
		this.forgetStandingRowRefusal(intent.ticketIdentity);
		// The route's decision lands at the ask (ADR 0064): a workflow-origin
		// ask records it on the settled turn's trace the moment it enqueues, so
		// the ask never waits on a run. A refusal before the enqueue - the
		// claim, the one-item-per-ticket rule - records nothing, so a route
		// that never enqueued leaves the turn pending.
		this.recordRouteDecision(intent);
		this.log?.info(
			`handoff queued: ${this.ticketName(intent.ticketIdentity)} ` +
				`(origin ${intent.origin}, ${queueStagingOf(intent.automatic === true)})`,
		);
		this.reports.refresh();
		this.reports.notice(
			`handoff of ${this.ticketName(intent.ticketIdentity)} is in the Work queue; it starts when a seat frees`,
		);
		if (intent.origin === "workflow" && intent.automatic !== true) {
			// The decision screen's route: the previous environment goes at the
			// ask, not at the start. The close takes the seat, the way every
			// environment change does, so it runs the moment the seat is free
			// and never under a handoff run. The item's pickup closes it again
			// when it starts, and the close is its own answer when herdr holds
			// the environment no more.
			const closeIdentity = intent.routeFromIdentity ?? intent.ticketIdentity;
			void this.queueCleanup(async () => {
				const failure = await this.closePreviousHandoffEnvironment(closeIdentity);
				if (failure !== undefined)
					this.reports.warning(`the previous handoff's environment did not close: ${failure}`);
				this.reports.refresh();
			});
		}
		return { ok: true };
	}

	/** The Work queue's pickup, the seam every caller crosses (ADR 0049). */
	async pickupWorkQueue(): Promise<number> {
		return this.runPickupPass();
	}

	/**
	 * Forget the standing-row refusals whose row no longer stands (issue #223).
	 *
	 * The sweep runs at the head of every pickup pass, which the observation cycle
	 * asks for on every poll whether or not the queue takes anything. It applies the
	 * rule the entry follows everywhere else - the entry stands while the row
	 * stands - to the rows this module never saw leave, and it keeps the set bounded
	 * to the rows that stand. A row that left and never came back states no refusal
	 * again, so the sweep drops its entry and nothing else changes.
	 */
	private sweepStandingRowRefusals(): void {
		for (const identity of [...this.queueItemRefusals]) {
			if (!this.state.workQueue.hasWorkItem(identity)) this.queueItemRefusals.delete(identity);
		}
	}

	/**
	 * Start the queue's items for the free seats, in queue order (ADR 0034,
	 * ADR 0049).
	 *
	 * A pickup is a manual start: the claim runs every hard check - the
	 * ticket still holds the state the origin requires, the source is healthy
	 * and re-read since the last cycle, the attempt ledger is clear - and the
	 * Setting fit runs inside the handoff itself. The automatic gates, the
	 * Dispatch pause and the Same-type hold, do not hold a pickup, and the
	 * queue pause does not hold an item that already claimed its seat. Every
	 * pickup ends in start or drop (ADR 0049): a pickup that fails a check
	 * drops its item with a Message line warning, and the ticket keeps its
	 * state, so the queue never sits stuck on a row no seat would take.
	 *
	 * An unlimited cap holds a free seat for every waiting start, so it picks
	 * up the whole queue: an operator who lifts the cap while items wait frees
	 * them all in the same cycle.
	 *
	 * `directAskIdentity` is the ticket the operator's own ask just enqueued,
	 * and only the immediate pass that ask ran carries it (issue #209). A start
	 * of that row by that pass is the ask taking a free seat at once; the same
	 * row started by a later pass - the observation cycle's pickup, or the pass
	 * a settling run frees the seat for - is a pickup. The mode is what the
	 * start line states, so it names the path that actually took the seat.
	 */
	private async runPickupPass(directAskIdentity?: string): Promise<number> {
		// The record's standing-fact entries follow their rows, whatever path took a
		// row out (issue #223). This runs ahead of the brake and the seat checks
		// because it is bookkeeping and not a pickup: a paused queue and a full cap
		// still sweep.
		this.sweepStandingRowRefusals();
		// The queue pause (ADR 0052): the brake holds the drain. The items keep
		// their places, the force-dispatch passes it, and the resume starts the
		// pickup that takes them.
		if (this.state.workQueue.queuePaused()) return 0;
		const limit = this.config().maxParallelAgents;
		const items = this.state.workQueue.items();
		if (items.length === 0) return 0;
		const freeSeats = limit === 0 ? items.length : limit - this.seatCount();
		// The plane action's items take no seat and are not held by the cap
		// (ADR 0068): the walk runs them when it reaches them, and a queue
		// that stands under a full cap is one whose first plane item sits
		// behind a seats-bound item the walk breaks at.
		const hasPlaneAction = items.some((candidate) => candidate.kind === "plane-action");
		if (freeSeats <= 0 && !hasPlaneAction) return 0;
		// One count for the whole call, on purpose: the loop takes at most
		// `freeSeats` items, so it cannot start more than the cap allows even when
		// a claim dedups to a seat the ticket already holds. That dedup is real and
		// deliberate: `parallelSeatCount` counts one seat per ticket, so a picked
		// ticket that already holds its own seat (a restart whose agent the latest
		// poll still lists) claims no new seat, and the free-seat figure counts it
		// against the same ceiling the mode cell shows.
		let claimed = 0;
		for (const item of items) {
			if (this.stopped) break;
			if (item.kind === "plane-action") {
				// The shared order is one across kinds, and the plane action's item
				// takes no seat, so the walk runs it when it reaches it, whatever
				// the cap bounds (ADR 0068) - and a cap that breaks the walk at a
				// held seats-bound item holds it, the way it holds every item
				// behind.
				await this.pickupPlaneActionItem(item, false, startModeOf(item, directAskIdentity));
				continue;
			}
			// In-flight items skip without taking a free seat, so the walk reaches
			// the starts that wait behind them; the cap still bounds how many the
			// pickup starts, not how many it reads. A full cap bounds the whole
			// seats-bound walk the same way, the moment its early return was
			// lifted for the plane action's items.
			if (claimed >= freeSeats) break;
			if (item.kind === "consultation") {
				// The shared order is one across kinds (ADR 0034, issue #90): a
				// Consultation item takes its place in the same walk, and a pickup
				// that starts holds its seat for the rest of the cycle, the way a
				// handoff pickup does. The Consultation's own start line names this
				// pass as the path that took the seat (issue #220).
				if (await this.pickupConsultationItem(item, "pickup", false)) claimed += 1;
				continue;
			}
			if (this.pickupItem(item, startModeOf(item, directAskIdentity))) claimed += 1;
		}
		if (claimed > 0) this.reports.refresh();
		return claimed;
	}

	/**
	 * Cancel one ticket's waiting start by the operator's hand and forget
	 * everything the module holds for it: the Work queue's row, the claim a
	 * pickup parked behind the held herdr seat, and the start report the ask
	 * handed the module. The row, the parked claim, and the held intent are one
	 * waiting start seen three ways, so the cancel ends all three together, and
	 * a run already inside herdr cannot be recalled, so it finishes, keeps the
	 * row gone, and answers its own ask (ADR 0049).
	 *
	 * The cancel is the operator's act on the row the queue shows, so it carries
	 * the row's own consequence: a route the row named takes its mark on the
	 * turn's trace in the same write, and the machine's re-offer skips the
	 * marked trace, the way the re-fired skip's mark stands (ADR 0042,
	 * ADR 0072). The source's cycle already ended at the ask, so the removal
	 * takes the item alone. A start with no route leaves the ticket in the
	 * state it wears.
	 *
	 * The false answer is a fact too: the row had already left, which is how the
	 * answer of a pickup whose work was already inside herdr knows the operator
	 * cancelled the start it can no longer recall. The App reads the same answer
	 * to choose its own line, so a cancel states a removal only for a row that
	 * stood when the keypress ran.
	 */
	removeQueueItem(ticketIdentity: string): boolean {
		const removed = this.state.workQueue.cancelWorkItem(ticketIdentity);
		this.cancelParkedPickup(ticketIdentity);
		this.forgetStandingRowRefusal(ticketIdentity);
		// A row that leaves without a claim still holds the ask's start report:
		// the cancel answers it here, once, with the cancellation. Without this
		// settle the held callback would survive the row and answer the next
		// automatic start of the same ticket - a callback leak with a
		// wrong-owner answer (ADR 0049). A row the pickup already took into a
		// live run is not that case: the run answers its own ask when it
		// settles, and a row that had already left answers through the path
		// that took it, so the cancel settles nothing twice.
		if (removed && !this.state.handoff.handoffInFlight(ticketIdentity))
			this.settleIntentOnStarted(ticketIdentity, {
				ok: false,
				reason: "the waiting start was cancelled",
			});
		return removed;
	}

	/**
	 * The row's removal and the parked claim's cancellation, without the ask's
	 * answer. This is the claim's and the drop's removal: the pickup that takes
	 * the row, the drop that leaves it with its warning, and the restart race
	 * that clears it, and the ticket keeps the state it wore while it waited
	 * (ADR 0049, ADR 0067). Every internal path that drops a row settles the
	 * held intent with its own reason around this call, so the ask hears the
	 * reason that ended its item, not the cancel's.
	 */
	private removeQueueRow(ticketIdentity: string): boolean {
		const removed = this.state.workQueue.removeWorkItem(ticketIdentity);
		this.cancelParkedPickup(ticketIdentity);
		this.forgetStandingRowRefusal(ticketIdentity);
		return removed;
	}

	removeConsultationQueueItem(consultationId: string): boolean {
		return this.state.consultationRecord.removeConsultationWorkItem(consultationId);
	}

	/**
	 * Record the decision of a routed ask on the settled turn's trace (ADR
	 * 0064): `handed-off` for the operator's route, `auto-handed-off` for the
	 * factory's. The record reads the settled ticket's latest handoff, the same
	 * fact the claim reads at the claim, so the two moments cannot disagree,
	 * and it reuses the state's one decision writer. The writer takes the first
	 * decision on a turn, so a re-enqueued route re-lands the same decision as a
	 * no-op and keeps the original ask's time. An ask with no route, a turn
	 * that never settled, or a turn already decided records nothing.
	 */
	private recordRouteDecision(intent: HandoffIntent) {
		if (intent.origin !== "workflow" || intent.routeFromIdentity === undefined) return;
		const previousHandoffId =
			this.state.handoff.latestHandoff(intent.routeFromIdentity)?.handoffId ?? "";
		if (previousHandoffId === "") return;
		this.state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: intent.routeFromIdentity,
			handoffId: previousHandoffId,
			decision: intent.automatic === true ? "auto-handed-off" : "handed-off",
			decidedAt: new Date(this.state.now()).toISOString(),
		});
	}

	/**
	 * Settle and drop the parked claim of a removed Work queue item.
	 *
	 * A pickup or a force-dispatch claims its seat before the herdr work can
	 * run, and `runClaimedHandoff` parks the claim while the herdr seat is held
	 * by a handoff or a queued Close cleanup. The row and that parked claim are
	 * one waiting start, so the operator's cancel ends both: the claim settles
	 * as failed and the intent leaves the drain, or the start the operator
	 * removed would run the moment the seat freed. Only a claim made for a row
	 * answers to the row - a manual start that claimed on its own is no one's
	 * queue item.
	 */
	private cancelParkedPickup(ticketIdentity: string): void {
		for (let index = this.handoffQueue.length - 1; index >= 0; index -= 1) {
			const parked = this.handoffQueue[index];
			if (
				parked === undefined ||
				parked.workQueuePickup !== true ||
				parked.ticket.identity !== ticketIdentity
			)
				continue;
			this.handoffQueue.splice(index, 1);
			this.settleFailedStart(parked.claim.attemptId, "the waiting start was cancelled");
			this.settleIntentOnStarted(ticketIdentity, {
				ok: false,
				reason: "the waiting start was cancelled",
			});
			this.reports.starting(ticketIdentity, false);
			this.reports.refresh();
			// The report still answers once, so no caller is left waiting; the
			// pickup's own answer stays silent because the row is gone (ADR 0034).
			parked.onStarted({ ok: false, reason: "the waiting start was cancelled" });
		}
	}

	/**
	 * The Consultation item's pickup (ADR 0034, issue #90): the module's own
	 * seam, so the Consultation operations stay out of the dispatch module.
	 * The pickup answers at the seat, not at the Agent: a `started` answer
	 * means the claim took the seat in its atomic move to `opening`, and the
	 * opening pipeline runs on behind it.
	 *
	 * `mode` is the path this module ran the start on, handed to the Consultation
	 * side so its own start line can name it (issue #220). `overCap` says this
	 * module measured the seat count over the Parallel limit at the key, so the
	 * Message line names the cap: a force-dispatch under a full cap says the
	 * pickup's own words, the way the handoff's force-dispatch does.
	 */
	private async pickupConsultationItem(
		item: WorkQueueConsultationItem,
		mode: StartMode,
		overCap: boolean,
	): Promise<boolean> {
		const pickup = this.pickupConsultation;
		if (pickup === undefined) return false;
		const outcome = await pickup(item.consultationId, mode);
		if (this.stopped) return false;
		// The claim took the pointer with it for a `started` answer; this
		// removal clears it for the answers that claimed nothing, so no item is
		// left standing for a record that no longer waits. The item leaves the
		// queue on every answer (ADR 0034, issue #90): the record keeps the ask,
		// and the queue holds the pointer only while the record waits.
		this.state.consultationRecord.removeConsultationWorkItem(item.consultationId);
		this.reports.refresh();
		if (outcome.kind === "started") {
			// The record holds its seat in `opening` now, and the opening runs on
			// behind this answer: the Message line names the pickup - or the cap,
			// for a force-dispatch that stood over it - and the record's own
			// progress line takes over from there. The record's start line in the
			// log file is the Consultation operations' own (issue #220).
			this.reports.notice(
				overCap
					? `force-dispatched Consultation ${item.consultationId.slice(0, 8)} over the Parallel limit`
					: `Work queue: opening Consultation ${item.consultationId.slice(0, 8)}`,
			);
			return true;
		}
		if (outcome.kind === "moved") {
			// The record left the queue's wait before the pickup ran - a close or a
			// delete that won the race. The pickup names the record it found, once:
			// the row is gone after this answer, so a repeat is impossible.
			this.reports.warning(
				`Work queue pickup of Consultation ${item.consultationId.slice(0, 8)} was not run: the record is no longer queued`,
			);
			return false;
		}
		// A failed pickup says nothing on its own: the Consultation operations
		// already put the failure and its reason on the Message line with the
		// `failed` record they left behind.
		return false;
	}

	/**
	 * The claim one queue item crosses before its start (ADR 0034): the race
	 * check, the state gate, the claim's hard checks, and the Starting window,
	 * in the order the pickup runs them. It reports no refusal: the answer
	 * carries the reason, and the caller owns the line, because the pickup
	 * keeps its failing item in the queue while the force-dispatch leaves it.
	 * `cancelled` says the item already left through the restart-or-route race
	 * check, with that check's own line.
	 */
	private claimQueueItem(item: WorkQueueHandoffItem, mode: StartMode): QueueItemClaimResult {
		// A restart or a route whose ticket already wears a handoff newer than
		// the item's enqueue: the seat the operator asked for was taken by a
		// start the operator did not ask for - the automatic restart, or the
		// automatic route - so the item is cancelled instead of a second
		// handoff starting on a ticket that has a live turn (ADR 0034). The
		// observation's automatic restart and automatic route skip a ticket the
		// queue waits for, so this meets the race that slipped past that skip.
		// It runs before the state gate below: a ticket the race already routed
		// is in the very state that gate refuses, and the answer there is the
		// cancellation, not a "the ticket is now ..." failure.
		if (item.origin === "restart" || item.origin === "workflow") {
			const inFlight = this.state.ticketWorkCycle
				.ticketsByState(["handed-off", "running"])
				.find((candidate) => candidate.ticketIdentity === item.ticketIdentity);
			if (inFlight !== undefined && Date.parse(inFlight.startedAt) > Date.parse(item.enqueuedAt)) {
				this.removeQueueRow(item.ticketIdentity);
				this.reports.refresh();
				this.reports.notice(
					item.origin === "restart"
						? `${this.ticketName(item.ticketIdentity)} restarted while its restart waited in the Work queue; the queue item is removed`
						: `${this.ticketName(item.ticketIdentity)} routed while its route waited in the Work queue; the queue item is removed`,
				);
				this.settleIntentOnStarted(item.ticketIdentity, {
					ok: false,
					reason: "the queue item was removed",
				});
				return { ok: "cancelled" };
			}
		}
		const currentState = this.state.ticketWorkCycle.ticketState(item.ticketIdentity);
		// The state gate reads the position the item names (ADR 0072): the
		// position stands open or awaiting, the way the continuation's position
		// check reads it. The claim does not ask the source ticket's state
		// whether a route stands: the source ends its cycle at the ask and rests
		// open behind the wait, and the race check above stands on its own.
		if (currentState === undefined || !handoffAllowsState(item.origin, currentState)) {
			return {
				ok: false,
				reason:
					currentState === undefined
						? "the ticket no longer exists"
						: `the ticket is now ${currentState}`,
			};
		}
		// The covered gate (ADR 0042): a queued start whose open ticket gained
		// an open fixing pull request while it waited is cancelled, and the
		// ticket keeps the state it wears while it waited: the list rule
		// withholds the ticket's task, and the start would hand the work to a
		// second agent. The ticket is read from the projection before the list
		// rule, because the rule withholds exactly the ticket this gate
		// refuses.
		if (item.origin === "open") {
			const projection = this.state.ticketWorkCycle.projectedTickets(
				this.config().workflowStates,
				this.config().defaultTaskType,
			);
			const waiting = projection.find((candidate) => candidate.identity === item.ticketIdentity);
			if (waiting !== undefined && isCoveredByFixingPullRequest(projection, waiting)) {
				this.removeQueueRow(item.ticketIdentity);
				this.reports.refresh();
				this.reports.notice(
					`the queued start of ${this.ticketName(item.ticketIdentity)} is removed: an open fixing pull request covers the ticket`,
				);
				this.settleIntentOnStarted(item.ticketIdentity, {
					ok: false,
					reason: "the queue item was removed",
				});
				return { ok: "cancelled" };
			}
		}
		// The seat reading the start line states, taken before the claim: the
		// count the Parallel limit gate stood on, not a count this start's own
		// claim raised (issue #209).
		const seats = this.seatReading();
		const claim = this.state.handoff.claimHandoff(item.ticketIdentity, item.choice, item.origin);
		if (!claim.ok) {
			this.refuseClaim("handoff", item.ticketIdentity, claim.reason);
			return { ok: false, reason: claim.reason };
		}
		this.forgetClaimRefusal("handoff", item.ticketIdentity);
		// A claim is a claim: the picked-up start enters the Starting window
		// exactly as the direct start above does, so the two claim paths report
		// the same fact and the row's spinner face does not wait for a seat.
		// The start line names the path that took the seat, the item's origin,
		// and the seat reading (issue #209): the count before this start claimed
		// its seat, beside the limit it was measured against. The pickup starts
		// only into a free seat, so its reading always sits under the limit; a
		// reading that already stands at the limit is the force-dispatch that
		// crossed it (ADR 0092).
		this.log?.info(
			`handoff started: ${this.ticketName(item.ticketIdentity)} ` +
				`(mode ${mode}, origin ${item.origin}, ${queueStagingOf(item.automatic)}, ${seats})`,
		);
		this.reports.starting(item.ticketIdentity, true);
		const ticket = this.state.ticketWorkCycle
			// The ignore is an automatic gate and never a hard start gate (ADR 0060):
			// the only item an ignored Ticket can hold is one the operator asked for by
			// hand, so the Pickup starts it. This read resolves a Ticket by identity, so
			// it takes the whole projection: the operator's List filter and ADR 0042's
			// covered rule say nothing about which Ticket the queue asked for.
			.projectedTickets(this.config().workflowStates, this.config().defaultTaskType)
			.find((candidate) => candidate.identity === item.ticketIdentity);
		if (ticket === undefined) {
			// The claim's hard checks passed but the projection holds no ticket
			// to run: settle the claim and name it; the item's fate is the
			// caller's, like every other refusal above.
			this.settleFailedStart(claim.claim.attemptId, "the ticket is no longer visible");
			this.reports.starting(item.ticketIdentity, false);
			this.reports.refresh();
			return { ok: false, reason: "the ticket is no longer visible" };
		}
		return {
			ok: true,
			ticket,
			claim: claim.claim,
			routeFromIdentity: item.routeFromIdentity,
		};
	}

	/**
	 * Claim and run one queue item. Returns whether the item claimed a seat
	 * this call: every pickup ends in start or drop (ADR 0049), so a refused
	 * claim drops the item with its warning, and a failed start does the same.
	 */
	private pickupItem(item: WorkQueueHandoffItem, mode: StartMode): boolean {
		// A run already in flight for this ticket settles its own item when it
		// ends; the pickup skips it so a concurrent pass cannot re-claim and
		// drop the start the run holds (ADR 0049).
		if (this.state.handoff.handoffInFlight(item.ticketIdentity)) return false;
		const claimed = this.claimQueueItem(item, mode);
		if (claimed.ok === "cancelled") return false;
		if (claimed.ok === false) {
			this.dropPickup(item, claimed.reason);
			return false;
		}
		this.runClaimedHandoff(
			{
				ticket: claimed.ticket,
				choice: item.choice,
				origin: item.origin,
				claim: claimed.claim,
				claimedState: claimed.ticket.state,
				previousMessage: item.previousMessage,
				routeFromIdentity: item.routeFromIdentity,
				// The route's ask: the close ran at the enqueue, and this close
				// is its own answer when the environment herdr holds no more.
				closePreviousEnvironment: item.origin === "workflow" && item.automatic !== true,
				workQueuePickup: true,
				automatic: item.automatic === true,
			},
			(started) => {
				this.settleIntentOnStarted(item.ticketIdentity, started);
				if (started.ok) {
					// Whether the row still stands when the start answers is the
					// operator's cancel seen from the module: a run already inside herdr
					// cannot be recalled, so it finishes, keeps the row gone, and earns no
					// "started from the Work queue" line for a start the operator ended.
					const rowStands = this.state.workQueue.hasWorkItem(item.ticketIdentity);
					if (rowStands) this.removeQueueRow(item.ticketIdentity);
					// The route's decision stands at the ask (ADR 0064); the start
					// answers the ask's refresh and start report only.
					this.reports.refresh();
					if (rowStands) {
						this.reports.notice(
							`${this.ticketName(item.ticketIdentity)} started from the Work queue`,
						);
					}
				} else if (this.state.workQueue.hasWorkItem(item.ticketIdentity)) {
					// The start never went live, so the item drops with the warning
					// and the ticket keeps its state (ADR 0049). A row the operator
					// already removed says its own goodbye on the line, so the
					// cancel needs no second line here (ADR 0034).
					this.dropPickup(item, started.reason);
				}
			},
		);
		return true;
	}

	/**
	 * The pickup's drop (ADR 0049): the item leaves the queue with the warning
	 * that names the operation and the reason, and the ticket keeps the state
	 * it wore while it waited.
	 */
	private dropPickup(item: WorkQueueHandoffItem, reason: string): void {
		this.removeQueueRow(item.ticketIdentity);
		this.settleIntentOnStarted(item.ticketIdentity, { ok: false, reason });
		this.reports.refresh();
		this.reports.warning(
			`queued handoff for ${this.ticketName(item.ticketIdentity)} was not run: ${reason}`,
		);
	}

	/**
	 * The force-dispatch of one Work queue item (issue #89, ADR 0034).
	 *
	 * The item starts now, over a full Parallel limit: the claim re-runs every
	 * hard start check the pickup runs and skips only the cap. A failure ends
	 * as a pickup failure with the one difference the operator asked for: the
	 * item leaves the queue, the Message line warns, and the ticket keeps its
	 * state and its own failure surface. A row that left between the render and
	 * the key runs no dispatch and says nothing: the catalogue gated the
	 * availability, so a key this race meets has no answer to give.
	 */
	forceDispatchWorkQueueItem(itemIdentity: string): void {
		if (this.stopped) return;
		const item = this.state.workQueue
			.items()
			.find((candidate) => workQueueIdentityOf(candidate) === itemIdentity);
		if (item === undefined) return;
		if (item.kind === "consultation") {
			// The Consultation's claim is its seat move, and the cap is the pickup
			// scheduler's check, not the pickup's: the seam re-runs every start
			// check the pickup runs and skips only the cap, and the item leaves
			// the queue on every answer, the way its pickup does.
			const limit = this.config().maxParallelAgents;
			const overCap = overParallelLimit(limit, this.seatCount());
			void this.pickupConsultationItem(item, "force-dispatch", overCap);
			return;
		}
		if (item.kind === "plane-action") {
			// The plane action's item takes no seat (ADR 0068), so the force-
			// dispatch's one ask - start it now - is the pickup's own: the run's
			// gates run, the item leaves the queue on every answer, and the line
			// names the cap when it stood over it at the key.
			const limit = this.config().maxParallelAgents;
			const overCap = overParallelLimit(limit, this.seatCount());
			void this.pickupPlaneActionItem(item, overCap, "force-dispatch");
			return;
		}
		// Measured before the claim, on the shared count: the line states the
		// start over the cap only when the cap was full at the dispatch.
		const limit = this.config().maxParallelAgents;
		const overCap = overParallelLimit(limit, this.seatCount());
		const claimed = this.claimQueueItem(item, "force-dispatch");
		if (claimed.ok === "cancelled") return;
		if (claimed.ok === false) {
			// The claim refused the start: the ticket no longer holds the state
			// its origin requires, its source is gone, or the ledger is unclear.
			// The item leaves the queue with the warning the failed pickup
			// leaves, the pickup's own words for the fact, and the ticket keeps
			// its state.
			this.removeQueueRow(item.ticketIdentity);
			this.settleIntentOnStarted(item.ticketIdentity, { ok: false, reason: claimed.reason });
			this.reports.warning(
				`force-dispatch of ${this.ticketName(item.ticketIdentity)} failed: ${claimed.reason}`,
			);
			return;
		}
		this.runClaimedHandoff(
			{
				ticket: claimed.ticket,
				choice: item.choice,
				origin: item.origin,
				claim: claimed.claim,
				claimedState: claimed.ticket.state,
				previousMessage: item.previousMessage,
				routeFromIdentity: item.routeFromIdentity,
				// The route's ask: the close ran at the enqueue, and this close
				// is its own answer when the environment herdr holds no more.
				closePreviousEnvironment: item.origin === "workflow" && item.automatic !== true,
				workQueuePickup: true,
				automatic: item.automatic === true,
			},
			(started) => {
				this.settleIntentOnStarted(item.ticketIdentity, started);
				if (started.ok) {
					// The ask is answered, either way: the item leaves the queue when
					// the start settles. A row the operator already removed leaves no
					// second line: the run it ended earns no start line of its own.
					const rowStands = this.state.workQueue.hasWorkItem(item.ticketIdentity);
					if (rowStands) this.removeQueueRow(item.ticketIdentity);
					// The route's decision stands at the ask (ADR 0064); the start
					// answers the ask's refresh and start report only.
					this.reports.refresh();
					if (rowStands)
						this.reports.notice(
							overCap
								? `force-dispatched ${this.ticketName(item.ticketIdentity)} over the Parallel limit`
								: `${this.ticketName(item.ticketIdentity)} started from the Work queue`,
						);
				} else if (this.state.workQueue.hasWorkItem(item.ticketIdentity)) {
					// The ask is answered: a failed start leaves the queue, and the
					// warning names the operation and the reason, one line for the
					// failure the handoff's own line already carries.
					this.removeQueueRow(item.ticketIdentity);
					this.reports.warning(
						`force-dispatch of ${this.ticketName(item.ticketIdentity)} failed: ${started.reason}`,
					);
				}
			},
		);
	}

	/** The name the operator reads on a line: the ticket's title while the
	 * ticket is still in the projection, its identity once it is gone. The rule
	 * is the shared one, so the boot's line for a claim this run left unsettled
	 * names the Ticket the way this module named it (issue #295 review). */
	private ticketName(identity: string): string {
		// The projection, not the visible list: a covered ticket is hidden
		// from the list while its queued start is still naming it (ADR 0042).
		return recordTicketName(
			this.state.ticketWorkCycle.ticketProjection(
				this.config().workflowStates,
				this.config().defaultTaskType,
			),
			identity,
		);
	}

	/**
	 * The reason the Work queue's one-item-per-ticket rule gives (ADR 0049), in
	 * the one wording both start channels state it in.
	 *
	 * The reason names the ticket itself, because every caller writes it to the
	 * Message line as the whole line.
	 */
	private queueItemStandsReason(identity: string): string {
		return `${this.ticketName(identity)} ${QUEUE_ITEM_STANDS_FACT}`;
	}

	/**
	 * The refusal the Work queue's one-item-per-ticket rule gives, on both start
	 * channels, with the record line the standing row leaves (issue #223).
	 *
	 * Without the line the run shows an owed start that never ran and says nothing
	 * about the row already standing being why. The line follows the rule the
	 * plane's other standing facts follow - a held Next step states itself once
	 * while the fact stands and again when it moves: the automatic walks re-ask
	 * every cycle, and a five-second poll cannot pin the file with one refusal.
	 */
	private refuseStandingQueueItem(prefix: "handoff" | "merge", identity: string): DispatchResult {
		// The key is the ticket alone, not the channel: the Work queue holds one row
		// per ticket, so the standing row is one fact whichever channel re-asked it,
		// and the line names the channel that reached it first (issue #223 review).
		if (!this.queueItemRefusals.has(identity)) {
			this.queueItemRefusals.add(identity);
			this.log?.warn(this.refusalLine(prefix, identity, QUEUE_ITEM_STANDS_FACT));
		}
		return { ok: false, reason: this.queueItemStandsReason(identity) };
	}

	/**
	 * The refusal a merge run already in flight gives (ADR 0104), with the record
	 * line the standing run leaves (issue #223).
	 *
	 * This is the same fact the issue exists to read: a start the walks asked that
	 * never ran, refused before its enqueue. The Message line has always carried
	 * the reason; the file carries it once for the run that stands, so a re-ask on
	 * every poll cannot pin the file with it.
	 */
	private refuseMergeRunStanding(identity: string): DispatchResult {
		if (!this.mergeRunRefusals.has(identity)) {
			this.mergeRunRefusals.add(identity);
			this.log?.warn(this.refusalLine("merge", identity, MERGE_RUN_STANDS_FACT));
		}
		return {
			ok: false,
			reason: `${this.ticketName(identity)} ${MERGE_RUN_STANDS_FACT}`,
		};
	}

	/**
	 * Forget the standing-row refusal stated for a ticket (issue #223).
	 *
	 * The row it stands for is gone, so a later row for the same ticket is a new
	 * fact and states its refusal again. Every path that ends a waiting row runs
	 * this, and a successful enqueue runs it too: the queue holds one row per
	 * ticket, so an enqueue can only land after the row before it left, whatever
	 * path took that row out.
	 */
	private forgetStandingRowRefusal(identity: string): void {
		this.queueItemRefusals.delete(identity);
	}

	/**
	 * The record line every refusal leaves (issue #223): the prefix, the ticket the
	 * refusal is about, and the fact the refusal gives.
	 *
	 * One shape for every refusal the plane records, so a reader or a tool needs
	 * one rule to read them. The reason a caller puts on the Message line keeps its
	 * own wording; the line names the ticket first, the way the queue's other lines
	 * name it.
	 */
	private refusalLine(prefix: "handoff" | "merge", identity: string, fact: string): string {
		return `${prefix} refused: ${this.ticketName(identity)} (${fact})`;
	}

	/**
	 * The refusal a start claim's hard gates give, with the record line the
	 * standing fact leaves (issue #223).
	 *
	 * The claim refusal has always reached the file. It reached it once per ask, and
	 * the automatic walks re-ask every observation cycle, so a position whose claim
	 * stands refused wrote about 12 identical lines a minute - the same failure the
	 * standing-row refusal is deduped for. The line follows the plane's one rule for
	 * a standing fact: once while it stands, again when it moves.
	 */
	private refuseClaim(prefix: "handoff" | "merge", identity: string, fact: string): void {
		const key = claimRefusalKey(prefix, identity);
		// The ledger read marks the claim this refusal stands on. It runs on the
		// refusal path only, once per cycle per refused position, and the claim gate
		// above already read the same tables.
		const attempts = this.state.handoff.handoffCount(identity);
		const stated = this.claimRefusals.get(key);
		if (stated !== undefined && stated.fact === fact && stated.attempts === attempts) return;
		this.claimRefusals.set(key, { fact, attempts });
		this.log?.warn(this.refusalLine(prefix, identity, fact));
	}

	/**
	 * Forget the claim refusal stated for one ticket on one start channel
	 * (issue #223). The claim went through, so the fact the line stated no longer
	 * stands and a later refusal is a new one.
	 */
	private forgetClaimRefusal(prefix: "handoff" | "merge", identity: string): void {
		this.claimRefusals.delete(claimRefusalKey(prefix, identity));
	}

	/**
	 * The seat reading a start line states (issue #209): the held seats of the
	 * shared Parallel limit count, in the shared field text a Consultation start
	 * line states it in too.
	 */
	private seatReading(): string {
		return parallelSeatReading(this.seatCount(), this.config().maxParallelAgents);
	}

	closeCleanup(
		identity: string,
		handoff: StoredHandoffFacts,
		_end: "closed" | "abandoned",
	): Promise<string | undefined> {
		return this.queueCleanup(async () => {
			const failure = await this.settleCloseCleanup(identity, handoff);
			this.reports.refresh();
			return failure;
		});
	}

	closeWorkCycle(identity: string): Promise<CloseCycleOutcome> {
		if (this.stopped) return Promise.resolve({ ended: false, reason: STOPPED_DISPATCH_REASON });
		// One seat item holds the whole close: the cycle ends and its environment
		// goes, in that order, with no handoff of the same ticket in between them.
		return this.queueCleanup(async () => {
			const handoff = this.state.handoff.latestHandoff(identity);
			if (!this.state.ticketWorkCycle.closeWorkCycle(identity)) {
				// The ticket moved on while the close waited: it rests open, or its
				// turn settled and awaits a decision of its own. One fact, said once.
				const state = this.state.ticketWorkCycle.ticketState(identity) ?? "gone";
				this.reports.refresh();
				return { ended: false, reason: `the ticket is ${state}` };
			}
			this.reports.refresh();
			if (handoff === null) return { ended: true };
			const cleanupFailure = await this.settleCloseCleanup(identity, handoff);
			this.reports.refresh();
			return { ended: true, cleanupFailure };
		});
	}

	/** True when either a handoff or a queued environment change owns the seat. */
	private seatHeld(): boolean {
		return this.inFlight || this.cleanupQueued;
	}

	/**
	 * The knowledge a handoff's name plan carries of its own environments: the
	 * panes and workspaces the ticket's handoffs recorded, and whether the
	 * ticket already knows a leftover. A route handoff spans two tickets - the
	 * position's own, where it starts, and the settled one it continues - so
	 * the knowledge unions both, and a name the settled ticket's leftover agent
	 * still holds is the handoff's own, not a stranger's.
	 */
	private nameKnowledgeFor(identity: string, routeFromIdentity?: string | null): OwnNameKnowledge {
		const identities = new Set<string>([identity]);
		if (routeFromIdentity !== null && routeFromIdentity !== undefined)
			identities.add(routeFromIdentity);
		const paneIds: string[] = [];
		const workspaceIds: string[] = [];
		let leftoverKnown = false;
		for (const known of identities) {
			const handles = this.state.handoff.handoffHandles(known);
			for (const paneId of handles.paneIds) paneIds.push(paneId);
			for (const workspaceId of handles.workspaceIds) workspaceIds.push(workspaceId);
			if (this.state.handoff.leftoverEnvironment(known) !== null) leftoverKnown = true;
		}
		return { ownPaneIds: paneIds, ownWorkspaceIds: workspaceIds, leftoverKnown };
	}

	/**
	 * Make every name collision this start met durable, and keep the two facts
	 * apart (issue #299, ADR 0107).
	 *
	 * A holder the plane recorded for this Ticket is one of its own handoffs, so
	 * the fact is a Leftover environment and its cleanup runs in herdr (ADR
	 * 0012). A holder the plane cannot tie to the Ticket is the Agent name
	 * collision: the plane owns no cleanup for a pane it never made, so the fact
	 * names the pane and workspace and holds the automatic adds until the
	 * operator acts. One start can meet both - its own leftover holds the stable
	 * name and a stranger holds the next candidate - and each lands on its own
	 * fact, never on the other's.
	 *
	 * The collision's reason is the reason the attempt's own row stores, so the
	 * row, the detail, and the record line name one refusal (issue #295, issue
	 * #231).
	 */
	private recordNameCollisions(identity: string, outcome: HandoffOutcome): void {
		for (const collision of [outcome.collision, outcome.ownCollision]) {
			if (collision === undefined) continue;
			if (collision.own) {
				this.recordLeftoverFromCollision(identity, collision);
				continue;
			}
			this.state.handoff.recordNameCollision({
				ticketIdentity: identity,
				stableName: collision.stableName,
				holderPaneId: collision.holder?.paneId ?? null,
				holderWorkspaceId: collision.holder?.workspaceId ?? null,
				// The refusal the attempt stores names the pane and the workspace herdr
				// gave; a collision that rode an outcome which still reached its Agent
				// carries herdr's own reason, because the start stated no refusal.
				reason: outcome.status === "failed" ? outcome.reason : collision.reason,
			});
		}
	}

	private recordLeftoverFromCollision(identity: string, collision: NameCollision): void {
		this.state.handoff.recordLeftoverEnvironment({
			ticketIdentity: identity,
			paneId: collision.holder?.paneId ?? null,
			reason: `the leftover agent still holds the herdr name ${collision.stableName}: ${collision.reason}`,
		});
	}

	private runClaimedHandoff(
		claimed: ClaimedHandoff,
		onStarted?: (started: DispatchResult) => void,
	): void {
		const { ticket, choice, origin, claim, previousMessage } = claimed;
		let reported = false;
		const reportStarted = (started: DispatchResult): void => {
			if (reported) return;
			reported = true;
			if (onStarted !== undefined) safeReport(() => onStarted(started));
		};

		if (this.seatHeld()) {
			this.handoffQueue.push({ ...claimed, onStarted: reportStarted });
			return;
		}

		this.inFlight = true;
		this.reports.working(`handing off "${ticket.title}"...`);
		const onStage = (stage: string) =>
			this.state.handoff.advanceHandoffAttempt(claim.attemptId, stage);
		const names = this.nameKnowledgeFor(ticket.identity, claimed.routeFromIdentity);
		const run = (async () => {
			// The placement (ADR 0045): a non-automatic start whose chosen task
			// type differs from the ticket's suggestion writes the ticket's
			// labels before the agent starts, so the position offers the chosen
			// task. The refusal is the failed start the Setting fit failure
			// uses, so the ticket keeps its position and the Message line
			// carries the reason. A refused placement closes nothing, so the
			// previous environment stands for the operator's next ask.
			if (claimed.automatic !== true) {
				const refusal = await this.runPlacement(claimed);
				if (refusal !== null) return refusal;
			}
			// The decision screen's route: the previous environment closes before
			// the run lists the workspaces, so the handoff builds its own fresh
			// environment instead of reusing the one the settled turn ran in.
			// A refused close keeps the stored workspace standing, and the run
			// reuses it, the way it did before the close asked.
			if (claimed.closePreviousEnvironment === true) {
				const failure = await this.closePreviousHandoffEnvironment(
					claimed.routeFromIdentity ?? ticket.identity,
				);
				if (failure !== undefined)
					this.reports.warning(`the previous handoff's environment did not close: ${failure}`);
			}
			return handOffTicket(ticket, choice, {
				config: this.config(),
				runner: this.runner,
				home: this.home,
				onStage,
				names,
				// The one start (issue #204): an open start carries the ticket's open
				// gate, and a workflow handoff or a restart stands behind the claim its
				// turn already settled. Both state the workspace the previous handoff
				// recorded, and the start decides whether herdr still holds it.
				claim: origin === "open" ? "open" : "continuation",
				// An open start states no workspace: it builds the Environment its choice
				// names. A workflow handoff or a restart states the workspace its
				// previous handoff recorded, and the start decides whether herdr holds it.
				previous:
					origin === "open"
						? undefined
						: {
								workspaceId: ticket.handoff?.workspaceId ?? null,
								environment: ticket.handoff?.environment ?? this.config().defaultEnvironment,
								tabId: ticket.handoff?.tabId ?? null,
							},
				previousMessage,
			});
		})();

		void run
			.then((outcome) =>
				this.finishHandoff(
					ticket.identity,
					claim,
					outcome,
					reportStarted,
					claimed.routeFromIdentity,
				),
			)
			.catch((error) => this.failHandoff(ticket.identity, claim, reportStarted, error));
	}

	/**
	 * The placement the non-automatic start crosses before the agent (ADR 0045).
	 *
	 * The evaluation is the Placement module's answer on the start's ticket:
	 * where the ticket's labels will stand once the chosen task runs. The
	 * no-placement faces - the chosen task is the ticket's current suggestion,
	 * or the default handoff of a parked ticket - take no egress, so a start
	 * that answers them touches the source no more than it did before.
	 *
	 * The write runs through the shared label writer, the fire's own. A
	 * refusal - the infeasible answer, or the failed write - comes back as the
	 * failed start the Setting fit failure uses: the attempt settles failed,
	 * the ticket keeps its position, and the Message line carries the reason.
	 * A write that added or removed labels states them on the Message line: the
	 * external effect is a fact the operator can read. A write the labels
	 * already matched runs no command at all, so a Restart of an interrupted
	 * handoff re-runs the rule and takes egress only when the labels still
	 * differ.
	 */
	private async runPlacement(claimed: ClaimedHandoff): Promise<HandoffOutcome | null> {
		const config = this.config();
		const evaluation = evaluatePlacement({
			states: config.workflowStates,
			fallbackTaskType: config.defaultTaskType,
			memberships: claimed.ticket.memberships,
			chosenTaskType: claimed.choice.taskType,
		});
		if (evaluation.kind === "none") return null;
		if (evaluation.kind === "infeasible") return { status: "failed", reason: evaluation.reason };
		// The write command is the item's own: the issue edit on an issue
		// ticket, the pull request edit on a pull request ticket.
		const command = editCommandFor(evaluation.membership);
		const write = await writeMembershipLabels(
			config.sources,
			this.runner,
			evaluation.membership,
			command,
			evaluation.added,
			evaluation.removed,
		);
		if (write !== null && write.failure !== undefined)
			return { status: "failed", reason: write.failure };
		if (write !== null) {
			const parts = [
				...(write.added.length > 0 ? [`added labels ${write.added.join(", ")}`] : []),
				...(write.removed.length > 0 ? [`removed labels ${write.removed.join(", ")}`] : []),
			];
			if (parts.length > 0)
				this.reports.notice(
					`placement of ${this.ticketName(claimed.ticket.identity)}: ${parts.join("; ")}`,
				);
		}
		return null;
	}

	/**
	 * The close of the previous handoff's environment that a workflow-origin
	 * merge ask asks for, the confirm's ask and the auto top-up's alike (ADR
	 * 0046, ADR 0099). The settled ticket's newest handoff is the environment
	 * the settled turn ran in, and a ticket that recorded no handle answers the
	 * close with nothing to close.
	 *
	 * Best effort all the way down: the answer is herdr's refusal, when
	 * herdr made one, and a close that never ran is its own reason. A null
	 * answer is the close, and the environment already gone: herdr's
	 * `workspace_not_found` and `tab_not_found` both stand for it, the way
	 * the Close cleanup reads them.
	 */
	private async closePreviousHandoffEnvironment(identity: string): Promise<string | undefined> {
		const stored = this.state.handoff.latestHandoff(identity);
		if (stored === null) return undefined;
		try {
			return await closeStoredEnvironment(
				{
					environment: stored.environment,
					tabId: stored.tabId,
					workspaceId: stored.workspaceId,
				},
				this.runner,
			);
		} catch (error) {
			return `the close did not run: ${errorMessage(error)}`;
		}
	}

	/**
	 * Settle a start that began and reached no Agent, and leave its line in the
	 * record (issue #295).
	 *
	 * Every failed settle of this module runs through here, so the record holds
	 * one line per attempt: the settle answers null when the attempt had already
	 * settled, and the line follows that one write. It never rides the observation
	 * cycle - the walks re-ask a Ticket every poll, and the attempt that already
	 * settled says nothing new on the next one - the same rule issue #223 sets for
	 * a standing refusal and issue #231 for the walk's per-candidate facts.
	 *
	 * The reason the line states is the one the attempt's row stores: the settle
	 * answers with its own row, and the line reads that answer, so the file and the
	 * ledger cannot state two endings for one start. The line is a `warn`, the level
	 * every refusal line wears, and it wears a prefix no refusal wears: a pre-start
	 * gate refusal leaves `handoff refused:` and no attempt row at all, while this
	 * line stands only under a start that passed every gate and settled `failed`.
	 */
	private settleFailedStart(attemptId: string, reason: string): void {
		const settled = this.state.handoff.settleHandoff(attemptId, false, reason);
		// The answer is the settle's own: null means the attempt had already
		// settled, and its line stands from that one write. The outcome needs no
		// second look here - this settle wrote `failed`, and the ledger refuses a
		// settled row whose stage names any other stage (issue #295 review).
		if (settled === null) return;
		this.log?.warn(
			handoffStartFailedLine(this.ticketName(settled.ticketIdentity), settled.failureReason),
		);
	}

	private failHandoff(
		identity: string,
		claim: HandoffClaim,
		reportStarted: (started: DispatchResult) => void,
		error: unknown,
	): void {
		if (this.stopped) return;
		const reason = errorMessage(error);
		this.settleFailedStart(claim.attemptId, reason);
		this.reports.starting(identity, false);
		this.reports.refresh();
		this.reports.clearWorking();
		this.reports.error(`handoff failed: ${reason}`);
		reportStarted({ ok: false, reason });
		this.inFlight = false;
		this.drainCleanupQueue();
	}

	private async finishHandoff(
		identity: string,
		claim: HandoffClaim,
		outcome: HandoffOutcome,
		reportStarted: (started: DispatchResult) => void,
		/** The ticket the started handoff routes from; null for a no-route start (ADR 0067). */
		routeFromIdentity: string | null,
	): Promise<void> {
		if (this.stopped) return;
		this.recordNameCollisions(identity, outcome);

		if (outcome.status === "failed") {
			this.settleFailedStart(claim.attemptId, outcome.reason);
		} else {
			this.state.handoff.settleHandoff(claim.attemptId, true, undefined, {
				paneId: outcome.agent.paneId,
				tabId: outcome.agent.tabId,
				workspaceId: outcome.agent.workspaceId,
				agentName: outcome.agent.name,
				routeFromIdentity,
			});
			// The start reached its Agent, so the name that was held is held no more:
			// the operator's own Handoff is the one act that clears the collision, and
			// the automatic adds resume on the same rule with no second act (issue #299,
			// ADR 0107). A start that failed for another reason clears nothing - it never
			// asked for the name, so it answered nothing about it.
			this.state.handoff.clearNameCollision(identity);
		}
		this.reports.starting(identity, false);
		this.reports.refresh();
		await reportHandoffOutcome(outcome, this.reports, this.persistMapping);
		reportStarted(
			outcome.status === "failed" ? { ok: false, reason: outcome.reason } : { ok: true },
		);
		this.inFlight = false;
		this.drainCleanupQueue();
		// A settled run frees the seat: the pickup re-runs so the items the last
		// pass left behind the free-seat slice still get their turn (ADR 0049).
		void this.pickupWorkQueue();
	}

	/** Start the next queued cleanup only when the handoff seat is free. */
	private drainCleanupQueue(): void {
		if (this.inFlight || this.clearing) return;
		const cleanup = this.cleanupQueue.shift();
		if (cleanup === undefined) {
			this.cleanupQueued = false;
			this.drainHandoffQueue();
			return;
		}
		this.clearing = true;
		// The item settles its own caller, and the drain follows on the next
		// microtask: a cleanup that failed reaches the caller's Message line
		// before the next handoff writes its Working line over the slot.
		void cleanup.run().finally(() => {
			this.clearing = false;
			this.drainCleanupQueue();
		});
	}

	/** Queue one environment change and reserve the seat for it immediately. */
	private queueCleanup<Result>(work: () => Promise<Result>): Promise<Result> {
		this.cleanupQueued = true;
		const queued = new Promise<Result>((resolve, reject) => {
			this.cleanupQueue.push({
				// `async` is the load-bearing part: it turns a throw of `work`,
				// synchronous or not, into a rejection of the caller's promise,
				// so `run` itself never rejects and the drain's `finally` always
				// releases the seat. Without it a thrown cleanup would leave
				// `clearing` true, and every later handoff and cleanup would wait
				// on a seat nobody holds.
				run: async () => {
					try {
						resolve(await work());
					} catch (error) {
						reject(error);
					}
				},
			});
		});
		this.drainCleanupQueue();
		return queued;
	}

	/**
	 * Start the claimed handoffs the seat held back, in claim order.
	 *
	 * Every queued handoff re-checks the ticket's durable state before it runs:
	 * the claim passed when the queue formed, and the ticket may have moved on
	 * since. A ticket that moved on settles its claim as failed and the queue
	 * keeps draining, so a later item still starts when the seat frees.
	 */
	private drainHandoffQueue(): void {
		for (;;) {
			if (this.seatHeld()) return;
			const next = this.handoffQueue.shift();
			if (next === undefined) return;
			const currentState = this.state.ticketWorkCycle.ticketState(next.ticket.identity);
			// A workflow route runs from the state its claim made: the route
			// stands on the settled turn the claim waited on, and a ticket that
			// moved on while the queue held - the turn closed, the ticket back
			// to open - no longer waits on it. A claim that made on an open
			// position ticket (the machine's pull request) still runs while it
			// stays open, and stops when any other work takes the ticket.
			const movedWhileQueued =
				next.origin === "workflow" &&
				currentState !== undefined &&
				currentState !== next.claimedState;
			if (
				currentState === undefined ||
				!handoffAllowsState(next.origin, currentState) ||
				movedWhileQueued
			) {
				// One fact, said once: what the ticket is now. A ticket the state no
				// longer holds is the harder case, and the state it moved to is the
				// one the operator and the attempt both record.
				const movedOn =
					currentState === undefined
						? "the ticket no longer exists"
						: `the ticket is now ${currentState}`;
				this.settleFailedStart(next.claim.attemptId, movedOn);
				this.reports.starting(next.ticket.identity, false);
				this.reports.refresh();
				// One line for both exits, read through the one name helper every
				// other drain line reads: the live projection's title, so the
				// warning names the ticket the operator sees, not the snapshot the
				// claim took.
				this.reports.warning(
					`queued handoff for ${this.ticketName(next.ticket.identity)} was not run: ${movedOn}`,
				);
				if (next.workQueuePickup === true) {
					// A pickup the seat parked, and the ticket moved on before its turn:
					// the start-or-drop contract ends in a drop (ADR 0049). The item
					// leaves the queue, and the warning says the reason the drain found.
					this.state.workQueue.removeWorkItem(next.ticket.identity);
					this.forgetStandingRowRefusal(next.ticket.identity);
					next.onStarted({ ok: false, reason: movedOn });
				} else {
					// The route the claim was for never started: its caller decides
					// nothing on the turn it came from.
					next.onStarted({ ok: false, reason: "the queued handoff was not run" });
				}
				continue;
			}
			// The fresh projection when the ticket is still in it, else the claim's
			// snapshot: the handoff runs on the ticket it claimed. This is an identity
			// read, so it takes the whole projection - the operator's List filter and
			// the list rule's two causes say nothing about which Ticket the claim made.
			const snapshot =
				this.state.ticketWorkCycle
					.projectedTickets(this.config().workflowStates, this.config().defaultTaskType)
					.find((candidate) => candidate.identity === next.ticket.identity) ?? next.ticket;
			this.runClaimedHandoff({ ...next, ticket: snapshot }, next.onStarted);
		}
	}

	private async settleCloseCleanup(
		identity: string,
		handoff: StoredHandoffFacts,
		options: CloseCleanupOptions = {},
	): Promise<string | undefined> {
		try {
			const failure = await closeHandoffEnvironment(
				{
					environment: handoff.environment,
					tabId: handoff.tabId,
					workspaceId: handoff.workspaceId,
				},
				this.runner,
				options,
			);
			if (failure === undefined) {
				const reach = closeCleanupReach(handoff);
				this.state.handoff.clearLeftoverEnvironments(
					identity,
					reach.scope === "workspace"
						? { workspaceId: reach.workspaceId }
						: reach.scope === "tab"
							? { tabId: reach.tabId }
							: { handoffId: handoff.handoffId },
				);
				return undefined;
			}
			this.state.handoff.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId: handoff.handoffId,
				reason: failure,
			});
			return failure;
		} catch (error) {
			const reason = `the close cleanup did not run: ${errorMessage(error)}`;
			this.state.handoff.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId: handoff.handoffId,
				reason,
			});
			return reason;
		}
	}
}

interface QueuedCleanup {
	/** Run one environment change and settle its caller. Never rejects. */
	run: () => Promise<void>;
}

/**
 * One claimed handoff and the work it carries: the seat runs it now, or the
 * drain runs it when the seat frees.
 */
interface ClaimedHandoff {
	ticket: Ticket;
	choice: HandoffChoice;
	origin: HandoffOrigin;
	claim: HandoffClaim;
	/** The ticket's state when the claim made, the way the drain re-checks it. */
	claimedState: TicketState;
	previousMessage: string;
	/**
	 * The ticket the route's handoff continues (ADR 0027): null for a start
	 * that is no route, or a route that stays on its own ticket.
	 */
	routeFromIdentity: string | null;
	/**
	 * True for the route a decision screen asked for: the manual workflow
	 * start, direct or from a Work queue item. The run closes the settled
	 * ticket's previous handoff environment before it builds the handoff's
	 * own, so the workspace the settled turn ran in is gone the moment the
	 * operator asked for the handoff, in a fresh environment. The automatic
	 * workflow route and the restart keep the stored workspace and reuse it.
	 */
	closePreviousEnvironment: boolean;
	/**
	 * True for the claim a Work queue pickup or force-dispatch made (ADR 0034):
	 * the durable row and this claim are one waiting start, so removing the row
	 * settles this claim and drops this intent. A direct start claims for
	 * itself, and its parked run is nobody's queue item.
	 */
	workQueuePickup?: boolean;
	/**
	 * True for the starts the factory asked for itself (ADR 0051): the top-up's
	 * continuation route, its restart, and its new open ticket. The run skips
	 * the placement those starts never made. A Work queue item is a manual start
	 * unless it carries `automatic`, so a manual item's pickup and its
	 * force-dispatch both cross the placement, and the top-up's item crosses
	 * neither (ADR 0049).
	 */
	automatic: boolean;
}

interface QueuedHandoff extends ClaimedHandoff {
	onStarted: (started: DispatchResult) => void;
}

/**
 * The claim one queue item crosses before its start (ADR 0034): the item's
 * seat claimed and the ticket the start runs on, or the refusal's reason, or
 * the race check's cancellation, which already left its item and its line.
 */
type QueueItemClaimResult =
	| {
			ok: true;
			ticket: Ticket;
			claim: HandoffClaim;
			/** The route's settled ticket, as the queue row names it; null for a no-route start. */
			routeFromIdentity: string | null;
	  }
	| { ok: false; reason: string }
	| { ok: "cancelled" };

// The start mode this module names on its start lines (issue #209, CONTEXT.md)
// is the shared fact in `domain/start-mode.ts`. A Consultation's start is the
// Consultation operations' fact, not this module's, so no line here names it;
// the dispatch hands the mode to the Consultation side at the pickup seam so
// that module can name it on its own line (issue #220).

/**
 * The ticket an ask makes its own direct ask (issue #209): the identity the
 * operator asked for by hand, and no identity for the ask the factory made
 * itself (the intent's `automatic` mark, ADR 0051).
 */
function directAskOf(
	intent: HandoffIntent | PlaneActionIntent,
	ticketIdentity: string,
): string | undefined {
	return intent.automatic === true ? undefined : ticketIdentity;
}

/**
 * The mode a pickup pass starts one item as (issue #209): the operator's direct
 * ask for the row their own ask enqueued, the Pickup for every other row the
 * same pass takes.
 */
function startModeOf(
	item: { ticketIdentity: string },
	directAskIdentity: string | undefined,
): StartMode {
	return directAskIdentity === item.ticketIdentity ? "direct-ask" : "pickup";
}

/** A queued handoff may start only from the state its origin claims. */
function handoffAllowsState(origin: HandoffOrigin, state: TicketState): boolean {
	switch (origin) {
		case "open":
			return state === "open";
		case "workflow":
			// A transition route may land on the position's own ticket, open or
			// awaiting alike: the machine re-derives the position, so the routed
			// ticket is the surface the facts now sit on (ADR 0027). The source
			// the route continues ended its cycle at the ask and rests open
			// behind the wait, so the claim reads the position's state alone
			// (ADR 0072).
			return state === "open" || state === "awaiting";
		case "restart":
			return inFlightState(state);
	}
}
