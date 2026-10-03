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
import type { ConsultationPickupOutcome } from "./consultation-operations.ts";
import type { EnvironmentKind, Ticket, TicketState } from "./domain/ticket.ts";
import { issueReferencesOf } from "./domain/ticket.ts";
import {
	type CloseCleanupOptions,
	closeCleanupReach,
	closeHandoffEnvironment,
	closeStoredEnvironment,
	type HandoffChoice,
	type HandoffOutcome,
	handOffStoredWorkspace,
	handOffTicket,
	type NameCollision,
	type OwnNameKnowledge,
} from "./handoff.ts";
import type { Logger } from "./logging.ts";
import { overParallelLimit } from "./parallel.ts";
import { evaluatePlacement } from "./placement.ts";
import {
	isPlaneActionTaskType,
	planeActionSettingOf,
	runMergePullRequest,
} from "./plane-actions.ts";
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
 * clean one with nothing to say leaves no line at all. The parts keep the order
 * the operator reads: the reason the handoff did not finish, the name it could
 * not take, the mapping write that failed, and the note the repository
 * resolution bent with.
 */
export async function reportHandoffOutcome(
	outcome: HandoffOutcome,
	reports: Pick<HandoffDispatchReports, "clearWorking" | "warning" | "error">,
	persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>,
): Promise<void> {
	const persistWarning =
		outcome.notes?.mappingToWrite === undefined || persistMapping === undefined
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
		...(outcome.status === "ok" && outcome.notes?.worktreeBase !== undefined
			? [outcome.notes.worktreeBase]
			: []),
		// The moved directory is a fact on the operator's disk whether or not
		// the start landed, so this line carries no status gate.
		...(outcome.notes?.leftoverWorktree === undefined ? [] : [outcome.notes.leftoverWorktree]),
	];
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
	 * and the opening the record runs behind the answer. Absent where the app
	 * has no Consultation side, and a loop without the side leaves the item
	 * standing for a later cycle.
	 */
	pickupConsultation?: (consultationId: string) => Promise<ConsultationPickupOutcome>;
	home: string;
	/** Persist a repository mapping discovered during handoff, if one is found. */
	persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;
	/**
	 * The plane's file logger. The dispatch leaves the record's handoff lines:
	 * a start, a queue, and a refusal with its reason.
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

/** The seat, the queues, and the work of one durable state database. */
class HandoffDispatchModule implements HandoffDispatch {
	private readonly state: HandoffDispatchAggregates;
	private readonly runner: CommandRunner;
	private readonly config: () => FactoryConfig;
	private readonly seatCount: () => number;
	private readonly pickupConsultation?: (
		consultationId: string,
	) => Promise<ConsultationPickupOutcome>;
	private readonly home: string;
	private readonly reports: HandoffDispatchReports;
	private readonly persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;
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
			this.log?.warn(
				`handoff refused: ${check.reason} (${this.ticketName(intent.ticketIdentity)})`,
			);
			return Promise.resolve({ ok: false, reason: check.reason });
		}
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
		// behind the answer, the way every other pickup does.
		void this.pickupWorkQueue();
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
			this.log?.warn(`merge refused: ${check.reason} (${this.ticketName(intent.ticketIdentity)})`);
			return Promise.resolve({ ok: false, reason: check.reason });
		}
		if (this.state.workQueue.hasWorkItem(intent.ticketIdentity))
			return Promise.resolve({
				ok: false,
				reason:
					`${this.ticketName(intent.ticketIdentity)} already has a waiting queue item; ` +
					"the first item keeps its place",
			});
		const enqueued = this.state.workQueue.enqueuePlaneActionWork({
			ticketIdentity: intent.ticketIdentity,
			routeFromIdentity: intent.routeFromIdentity ?? null,
			origin: intent.origin,
			taskType: intent.taskType,
			automatic: intent.automatic === true,
		});
		if (!enqueued.ok) return Promise.resolve(enqueued);
		if (intent.onStarted !== undefined)
			this.intentOnStarted.set(intent.ticketIdentity, intent.onStarted);
		// The decision word lands at the ask, the way the route's does (ADR
		// 0064): the settled turn ends its cycle in the same write that lands
		// the decision (ADR 0072), and the open position keeps its open state,
		// the wait standing on the item alone.
		this.recordPlaneActionDecision(intent);
		if (intent.origin === "workflow" && intent.automatic !== true) {
			// The decision screen's ask: the settled turn's environment goes at
			// the ask, the way the route's ask closes it (ADR 0046): the close
			// takes the seat, the way every environment change does, so it runs
			// the moment the seat is free and never under a run. The merge run
			// builds no environment of its own, so the close is the ask's whole
			// act on the environment.
			const closeIdentity = intent.routeFromIdentity ?? intent.ticketIdentity;
			void this.queueCleanup(async () => {
				const failure = await this.closePreviousHandoffEnvironment(closeIdentity);
				if (failure !== undefined)
					this.reports.warning(`the previous handoff's environment did not close: ${failure}`);
				this.reports.refresh();
			});
		}
		this.log?.info(
			`merge queued: ${this.ticketName(intent.ticketIdentity)} (origin ${intent.origin})`,
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
		// behind the answer, the way every other pickup does.
		void this.pickupWorkQueue();
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
	 * and leaves, and the run stands once. The run's gates are the route's -
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
	): Promise<void> {
		// The claim: the row leaves the queue before the run starts, the way
		// the handoff pickup's seat claim takes the start. A row another walk
		// already took leaves, and its run stands.
		if (!this.removeQueueRow(item.ticketIdentity)) return;
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
	 * A refusal is reported once, through the returned reason alone: every
	 * caller of `dispatch` writes an refused result's reason to the Message
	 * line, so a warning reported here on top of it would only overwrite that
	 * first line with a shorter copy of the same fact.
	 */
	private enqueueWork(intent: HandoffIntent): DispatchResult {
		if (this.state.workQueue.hasWorkItem(intent.ticketIdentity))
			return {
				ok: false,
				reason:
					`${this.ticketName(intent.ticketIdentity)} already has a waiting queue item; ` +
					"the first item keeps its place",
			};
		const enqueued = this.state.workQueue.enqueueWork({
			ticketIdentity: intent.ticketIdentity,
			routeFromIdentity: intent.routeFromIdentity ?? null,
			origin: intent.origin,
			choice: intent.choice,
			previousMessage: intent.previousMessage,
			automatic: intent.automatic === true,
		});
		if (!enqueued.ok) return { ok: false, reason: enqueued.reason };
		// The route's decision lands at the ask (ADR 0064): a workflow-origin
		// ask records it on the settled turn's trace the moment it enqueues, so
		// the ask never waits on a run. A refusal before the enqueue - the
		// claim, the one-item-per-ticket rule - records nothing, so a route
		// that never enqueued leaves the turn pending.
		this.recordRouteDecision(intent);
		this.log?.info(
			`handoff queued: ${this.ticketName(intent.ticketIdentity)} (origin ${intent.origin})`,
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
	 */
	async pickupWorkQueue(): Promise<number> {
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
		// against the same ceiling the mode line shows.
		let claimed = 0;
		for (const item of items) {
			if (this.stopped) break;
			if (item.kind === "plane-action") {
				// The shared order is one across kinds, and the plane action's item
				// takes no seat, so the walk runs it when it reaches it, whatever
				// the cap bounds (ADR 0068) - and a cap that breaks the walk at a
				// held seats-bound item holds it, the way it holds every item
				// behind.
				await this.pickupPlaneActionItem(item, false);
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
				// handoff pickup does.
				if (await this.pickupConsultationItem(item, false)) claimed += 1;
				continue;
			}
			if (this.pickupItem(item)) claimed += 1;
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
			this.state.handoff.settleHandoff(
				parked.claim.attemptId,
				false,
				"the waiting start was cancelled",
			);
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
	 * `overCap` says the force-dispatch measured the seat count over the
	 * Parallel limit at the key, so the started line names the cap: a force-
	 * dispatch under a full cap says the pickup's own words, the way the
	 * handoff's force-dispatch does.
	 */
	private async pickupConsultationItem(
		item: WorkQueueConsultationItem,
		overCap: boolean,
	): Promise<boolean> {
		const pickup = this.pickupConsultation;
		if (pickup === undefined) return false;
		const outcome = await pickup(item.consultationId);
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
			// behind this answer: the line names the pickup - or the cap, for a
			// force-dispatch that stood over it - and the record's own progress
			// line takes over from there.
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
	private claimQueueItem(item: WorkQueueHandoffItem): QueueItemClaimResult {
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
		const claim = this.state.handoff.claimHandoff(item.ticketIdentity, item.choice, item.origin);
		if (!claim.ok) {
			this.log?.warn(`handoff refused: ${claim.reason} (${this.ticketName(item.ticketIdentity)})`);
			return { ok: false, reason: claim.reason };
		}
		// A claim is a claim: the picked-up start enters the Starting window
		// exactly as the direct start above does, so the two claim paths report
		// the same fact and the row's spinner face does not wait for a seat.
		this.log?.info(
			`handoff started: ${this.ticketName(item.ticketIdentity)} (origin ${item.origin})`,
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
			this.state.handoff.settleHandoff(
				claim.claim.attemptId,
				false,
				"the ticket is no longer visible",
			);
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
	private pickupItem(item: WorkQueueHandoffItem): boolean {
		// A run already in flight for this ticket settles its own item when it
		// ends; the pickup skips it so a concurrent pass cannot re-claim and
		// drop the start the run holds (ADR 0049).
		if (this.state.handoff.handoffInFlight(item.ticketIdentity)) return false;
		const claimed = this.claimQueueItem(item);
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
			void this.pickupConsultationItem(item, overCap);
			return;
		}
		if (item.kind === "plane-action") {
			// The plane action's item takes no seat (ADR 0068), so the force-
			// dispatch's one ask - start it now - is the pickup's own: the run's
			// gates run, the item leaves the queue on every answer, and the line
			// names the cap when it stood over it at the key.
			const limit = this.config().maxParallelAgents;
			const overCap = overParallelLimit(limit, this.seatCount());
			void this.pickupPlaneActionItem(item, overCap);
			return;
		}
		// Measured before the claim, on the shared count: the line states the
		// start over the cap only when the cap was full at the dispatch.
		const limit = this.config().maxParallelAgents;
		const overCap = overParallelLimit(limit, this.seatCount());
		const claimed = this.claimQueueItem(item);
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
	 * ticket is still in the projection, its identity once it is gone. */
	private ticketName(identity: string): string {
		// The projection, not the visible list: a covered ticket is hidden
		// from the list while its queued start is still naming it (ADR 0042).
		const title = this.state.ticketWorkCycle
			.projectedTickets(this.config().workflowStates, this.config().defaultTaskType)
			.find((candidate) => candidate.identity === identity)?.title;
		return title === undefined ? `ticket ${identity}` : `"${title}"`;
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

	private recordNameCollision(identity: string, collision: NameCollision): void {
		if (!collision.own) return;
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
			return origin === "open"
				? handOffTicket(ticket, choice, {
						config: this.config(),
						runner: this.runner,
						home: this.home,
						onStage,
						names,
					})
				: handOffStoredWorkspace({
						ticket,
						choice,
						config: this.config(),
						runner: this.runner,
						home: this.home,
						workspaceId: ticket.handoff?.workspaceId ?? null,
						environment: ticket.handoff?.environment ?? this.config().defaultEnvironment,
						previousTabId: ticket.handoff?.tabId ?? null,
						previousMessage,
						onStage,
						names,
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
	 * The close of the previous handoff's environment that the decision
	 * screen's route asks for. The settled ticket's newest handoff is the
	 * environment the settled turn ran in, and a ticket that recorded no
	 * handle answers the close with nothing to close.
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

	private failHandoff(
		identity: string,
		claim: HandoffClaim,
		reportStarted: (started: DispatchResult) => void,
		error: unknown,
	): void {
		if (this.stopped) return;
		const reason = errorMessage(error);
		this.state.handoff.settleHandoff(claim.attemptId, false, reason);
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
		if (outcome.collision !== undefined) this.recordNameCollision(identity, outcome.collision);
		if (outcome.ownCollision !== undefined)
			this.recordNameCollision(identity, outcome.ownCollision);

		this.state.handoff.settleHandoff(
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
						routeFromIdentity,
					},
		);
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
				this.state.handoff.settleHandoff(next.claim.attemptId, false, movedOn);
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
			return state === "handed-off" || state === "running";
	}
}
