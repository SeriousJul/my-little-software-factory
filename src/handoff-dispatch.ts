/**
 * The Handoff dispatch module: one seat for handoffs and environment changes.
 *
 * The module owns the durable claim and settle, the handoff queue, Close
 * cleanup, and the name knowledge needed by handoff work.
 * It has no React dependency. The App crosses this interface for operator
 * actions and the observation loop crosses the same interface for automatic
 * work.
 */
import type { FactoryConfig } from "./config.ts";
import type { ConsultationPickupOutcome } from "./consultation-operations.ts";
import type { EnvironmentKind, Ticket, TicketState } from "./domain/ticket.ts";
import {
	type CloseCleanupOptions,
	closeCleanupReach,
	closeHandoffEnvironment,
	type HandoffChoice,
	type HandoffOutcome,
	handOffStoredWorkspace,
	handOffTicket,
	type NameCollision,
	type OwnNameKnowledge,
} from "./handoff.ts";
import type { RepositoryMapping } from "./repo.ts";
import { type CommandRunner, errorMessage } from "./runner.ts";
import type {
	FactoryState,
	HandoffClaim,
	HandoffOrigin,
	WorkQueueConsultationItem,
	WorkQueueHandoffItem,
} from "./state.ts";
import { workQueueIdentityOf } from "./state.ts";

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
	 * An automatic start (ADR 0034): the open dispatch, the workflow route, the
	 * restart. It waits for a seat and never enters the Work queue, so a full
	 * cap refuses it instead of enqueuing, and its own cycle retries it.
	 */
	automatic?: boolean;
	/**
	 * The result of the handoff's own start, reported once when the claimed
	 * handoff settles: `{ ok: true }` when the agent is live, `{ ok: false,
	 * reason }` when it never started. The claim says the dispatch took the
	 * work; only the start says the agent runs, so a route's decision waits for
	 * this. An intent that records nothing on a start omits it.
	 */
	onStarted?: (started: DispatchResult) => void;
}

/**
 * Whether dispatch accepted the intent: it claimed the Handoff and will run
 * it, now or behind the Handoff already in flight, or it entered the Work
 * queue at a full Parallel limit and will run when a seat frees. A refused
 * claim leaves the ticket where it was and says why, and no start follows.
 * Whether the Agent actually started arrives later, on the intent's
 * `onStarted`; a queued item answers it from its pickup.
 */
export type DispatchResult = { ok: true; queued: boolean } | { ok: false; reason: string };

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
	];
	reports.clearWorking();
	if (outcome.status !== "ok") reports.error(lines.join("; "));
	else if (lines.length > 0) reports.warning(lines.join("; "));
}

/** Dependencies of the Handoff dispatch module. */
export interface HandoffDispatchOptions extends HandoffDispatchReports {
	state: FactoryState;
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
	/**
	 * The herdr workspace the control plane itself runs in, or null outside
	 * herdr. A Close cleanup that removes a workspace returns herdr's focus
	 * there, because the operator worked the close from the control plane.
	 */
	controlPlaneWorkspaceId?: string | null;
	/** Persist a repository mapping discovered during handoff, if one is found. */
	persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;
}

/**
 * The small interface shared by operator and observation callers.
 *
 * A dispatch result answers only whether the claim was accepted. The optional
 * intent report answers later whether an agent actually started.
 */
export interface HandoffDispatch {
	/** Every Handoff origin: open, workflow, restart, observation loop. */
	dispatch(intent: HandoffIntent): Promise<DispatchResult>;
	/**
	 * The Work queue's pickup (ADR 0034): the items the free seats take, in
	 * queue order. A pickup is a manual start: every hard check the claim
	 * runs still runs, and a pickup that fails one leaves its item in the
	 * queue with a Message line warning. Returns the items that claimed a
	 * seat this call. The observation cycle calls it, before auto-dispatch.
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
	 * the module holds for it: the pickup warning it reports once per reason, and
	 * the claim a pickup already made and the held herdr seat parked. The queue's
	 * bookkeeping lives behind this seam, so a row, its note, and its parked claim
	 * always leave together: a later re-enqueue of the same ticket can warn again
	 * with the same reason, and a start that had not reached herdr never runs. A
	 * run already inside herdr cannot be recalled, so it finishes and the cancelled
	 * row earns no success line (ADR 0034).
	 *
	 * The answer says whether a row left: false reports that the row had already
	 * gone, which is how a start that answers late reads the operator's cancel.
	 */
	removeQueueItem(ticketIdentity: string): boolean;
	/**
	 * Drop one Consultation's waiting item from the Work queue (ADR 0034,
	 * issue #90), and forget every pickup warning the module already said for
	 * it. The record keeps its `queued` state: the removal is the item's, not
	 * the record's, and the ask stands behind the pointer it loses. The module
	 * holds no claim for a Consultation, so only the row and its note leave:
	 * a later re-enqueue of the same record warns again with the same reason.
	 *
	 * The answer says whether a row left, the way `removeQueueItem` does:
	 * false reports that the row had already gone, which is how a keypress that
	 * met a queue that no longer held the row reads it back.
	 */
	removeConsultationQueueItem(consultationId: string): boolean;
	/**
	 * Record the operator's `handed-off` decision on the turn a routed start came
	 * from (ADR 0034). One implementation holds both paths of the same fact:
	 * `runRouteHandoff` in the Main view for a route that starts in its own seat
	 * at once, and the queue pickup for a route whose start waited for a seat. It
	 * stamps the state's clock, so the two paths cannot disagree about when the
	 * decision landed, and a blank predecessor - a turn that never settled -
	 * records nothing.
	 */
	recordRoutedDecision(ticketIdentity: string, previousHandoffId: string): void;
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
	/** True while a Handoff holds the seat. The catalogue fact and the route edit guard. */
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
	private readonly state: FactoryState;
	private readonly runner: CommandRunner;
	private readonly config: () => FactoryConfig;
	private readonly seatCount: () => number;
	private readonly pickupConsultation?: (
		consultationId: string,
	) => Promise<ConsultationPickupOutcome>;
	private readonly home: string;
	private readonly controlPlaneWorkspaceId: string | null | undefined;
	private readonly reports: HandoffDispatchReports;
	private readonly persistMapping?: (mapping: RepositoryMapping) => Promise<string | undefined>;
	/**
	 * The pickup warnings already said for one queue item, so a pickup that
	 * keeps failing says each reason once on the Message line, not once per
	 * cycle. The set holds the reasons, not just the last one: a check that
	 * comes back after another reason is still the reason the operator has
	 * read, and a repeat of it would only push a newer line off the bar.
	 */
	private readonly warnedPickups = new Map<string, Set<string>>();

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

	constructor(options: HandoffDispatchOptions) {
		this.state = options.state;
		this.runner = options.runner;
		this.config = options.config;
		this.seatCount = options.seatCount;
		this.pickupConsultation = options.pickupConsultation;
		this.home = options.home;
		this.controlPlaneWorkspaceId = options.controlPlaneWorkspaceId;
		this.persistMapping = options.persistMapping;
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

	dispatch(intent: HandoffIntent): Promise<DispatchResult> {
		if (this.stopped)
			return Promise.resolve({ ok: false, reason: "the dispatch has been stopped" });
		const config = this.config();
		const ticket = this.state
			.visibleTickets(config.taskRules, config.defaultTaskType)
			.find((candidate) => candidate.identity === intent.ticketIdentity);
		if (ticket === undefined)
			return Promise.resolve({ ok: false, reason: "the ticket no longer exists" });

		// The Parallel limit gates every start (ADR 0034): a manual start that
		// cannot take a seat enters the Work queue instead of starting, and the
		// ticket keeps the state it wears while it waits. An automatic start
		// never enters the queue: it is refused, and its own cycle retries it.
		const limit = config.maxParallelAgents;
		if (limit > 0 && this.seatCount() >= limit) {
			if (intent.automatic === true)
				return Promise.resolve({ ok: false, reason: "the Parallel limit is full" });
			return Promise.resolve(this.enqueueWork(intent));
		}
		const claim = this.state.claimHandoff(intent.ticketIdentity, intent.choice, intent.origin);
		if (!claim.ok) return Promise.resolve({ ok: false, reason: claim.reason });
		// The claim is in, so the ticket is in the Starting window now: its work
		// may wait behind the seat, but the add does not wait with it.
		this.reports.starting(intent.ticketIdentity, true);
		this.runClaimedHandoff(
			{
				ticket,
				choice: intent.choice,
				origin: intent.origin,
				claim: claim.claim,
				previousMessage: intent.previousMessage,
			},
			intent.onStarted,
		);
		return Promise.resolve({ ok: true, queued: false });
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
		if (this.state.hasWorkItem(intent.ticketIdentity))
			return {
				ok: false,
				reason:
					`${this.ticketName(intent.ticketIdentity)} already has a waiting queue item; ` +
					"the first item keeps its place",
			};
		const enqueued = this.state.enqueueWork({
			ticketIdentity: intent.ticketIdentity,
			origin: intent.origin,
			choice: intent.choice,
			previousMessage: intent.previousMessage,
		});
		if (!enqueued.ok) return { ok: false, reason: enqueued.reason };
		this.reports.refresh();
		this.reports.notice(
			`handoff of ${this.ticketName(intent.ticketIdentity)} is in the Work queue; it starts when a seat frees`,
		);
		return { ok: true, queued: true };
	}

	/**
	 * Start the queue's items for the free seats, in queue order (ADR 0034).
	 *
	 * A pickup is a manual start: the claim runs every hard check - the
	 * ticket still holds the state the origin requires, the source is healthy
	 * and re-read since the last cycle, the attempt ledger is clear - and the
	 * Setting fit runs inside the handoff itself. The automatic gates, the
	 * Dispatch pause and the Same-type hold, do not hold a pickup. A pickup
	 * that fails a check leaves its item in the queue with a Message line
	 * warning, and the ticket keeps its state; a pickup that starts removes
	 * its item and names the start on the Message line.
	 *
	 * An unlimited cap holds a free seat for every waiting start, so it picks
	 * up the whole queue: an operator who lifts the cap while items wait frees
	 * them all in the same cycle.
	 */
	async pickupWorkQueue(): Promise<number> {
		const limit = this.config().maxParallelAgents;
		const items = this.state.workQueue();
		if (items.length === 0) return 0;
		const freeSeats = limit === 0 ? items.length : limit - this.seatCount();
		if (freeSeats <= 0) return 0;
		// One count for the whole call, on purpose: the loop takes at most
		// `freeSeats` items, so it cannot start more than the cap allows even when
		// a claim dedups to a seat the ticket already holds. That dedup is real and
		// deliberate: `parallelSeatCount` counts one seat per ticket, so a picked
		// ticket that already holds its own seat (a restart whose agent the latest
		// poll still lists) claims no new seat, and the free-seat figure counts it
		// against the same ceiling the mode line shows.
		let claimed = 0;
		for (const item of items.slice(0, freeSeats)) {
			if (this.stopped) break;
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
	 * Drop one ticket's waiting start and forget everything the module holds for
	 * it. The Work queue's row, the module's once-per-reason note, and the claim
	 * a pickup parked behind the held herdr seat are one fact seen three ways, so
	 * all three leave together through here: the operator's cancel, the
	 * successful pickup, and the restart-race cancellation all clear the same
	 * way, and a later re-enqueue of the ticket is free to warn again.
	 *
	 * The false answer is a fact too: the row had already left, which is how the
	 * answer of a pickup whose work was already inside herdr knows the operator
	 * cancelled the start it can no longer recall. The App reads the same answer
	 * to choose its own line, so a cancel states a removal only for a row that
	 * stood when the keypress ran.
	 */
	removeQueueItem(ticketIdentity: string): boolean {
		const removed = this.state.removeWorkItem(ticketIdentity);
		this.cancelParkedPickup(ticketIdentity);
		this.warnedPickups.delete(ticketIdentity);
		return removed;
	}

	removeConsultationQueueItem(consultationId: string): boolean {
		const removed = this.state.removeConsultationWorkItem(consultationId);
		this.warnedPickups.delete(consultationId);
		return removed;
	}

	/**
	 * Write the routed start's decision on the turn it routes from. One copy of
	 * the fact serves both paths that route: the Main view's own start and the
	 * queue pickup of a start that waited for a seat.
	 */
	recordRoutedDecision(ticketIdentity: string, previousHandoffId: string): void {
		if (previousHandoffId === "") return;
		this.state.applyCompletionDecision({
			ticketIdentity,
			handoffId: previousHandoffId,
			decision: "handed-off",
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
			this.state.settleHandoff(parked.claim.attemptId, false, "the waiting start was cancelled");
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
		this.state.removeConsultationWorkItem(item.consultationId);
		this.warnedPickups.delete(item.consultationId);
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
			const inFlight = this.state
				.ticketsByState(["handed-off", "running"])
				.find((candidate) => candidate.ticketIdentity === item.ticketIdentity);
			if (inFlight !== undefined && Date.parse(inFlight.startedAt) > Date.parse(item.enqueuedAt)) {
				this.removeQueueItem(item.ticketIdentity);
				this.reports.refresh();
				this.reports.notice(
					item.origin === "restart"
						? `${this.ticketName(item.ticketIdentity)} restarted while its restart waited in the Work queue; the queue item is removed`
						: `${this.ticketName(item.ticketIdentity)} routed while its route waited in the Work queue; the queue item is removed`,
				);
				return { ok: "cancelled" };
			}
		}
		const currentState = this.state.ticketState(item.ticketIdentity);
		if (currentState === undefined || !handoffAllowsState(item.origin, currentState)) {
			return {
				ok: false,
				reason:
					currentState === undefined
						? "the ticket no longer exists"
						: `the ticket is now ${currentState}`,
			};
		}
		const claim = this.state.claimHandoff(item.ticketIdentity, item.choice, item.origin);
		if (!claim.ok) return { ok: false, reason: claim.reason };
		// A claim is a claim: the picked-up start enters the Starting window
		// exactly as the direct start above does, so the two claim paths report
		// the same fact and the row's spinner face does not wait for a seat.
		this.reports.starting(item.ticketIdentity, true);
		const ticket = this.state
			.visibleTickets(this.config().taskRules, this.config().defaultTaskType)
			.find((candidate) => candidate.identity === item.ticketIdentity);
		if (ticket === undefined) {
			// The claim's hard checks passed but the projection holds no ticket
			// to run: settle the claim and name it; the item's fate is the
			// caller's, like every other refusal above.
			this.state.settleHandoff(claim.claim.attemptId, false, "the ticket is no longer visible");
			this.reports.starting(item.ticketIdentity, false);
			this.reports.refresh();
			return { ok: false, reason: "the ticket is no longer visible" };
		}
		this.warnedPickups.delete(item.ticketIdentity);
		return {
			ok: true,
			ticket,
			claim: claim.claim,
			previousHandoffId: ticket.handoff?.attemptId ?? "",
		};
	}

	/**
	 * Claim and run one queue item. Returns whether the item claimed a seat
	 * this call: a refused claim keeps the item in the queue and says why on
	 * the Message line, once per reason.
	 */
	private pickupItem(item: WorkQueueHandoffItem): boolean {
		const claimed = this.claimQueueItem(item);
		if (claimed.ok === "cancelled") return false;
		if (claimed.ok === false) {
			this.reportPickupFailure(item, claimed.reason);
			return false;
		}
		this.runClaimedHandoff(
			{
				ticket: claimed.ticket,
				choice: item.choice,
				origin: item.origin,
				claim: claimed.claim,
				previousMessage: item.previousMessage,
				workQueuePickup: true,
			},
			(started) => {
				if (started.ok) {
					// Whether the row still stands when the start answers is the
					// operator's cancel seen from the module: a run already inside herdr
					// cannot be recalled, so it finishes, keeps the row gone, and earns no
					// "started from the Work queue" line for a start the operator ended.
					const rowStands = this.state.hasWorkItem(item.ticketIdentity);
					if (rowStands) this.removeQueueItem(item.ticketIdentity);
					// The route the item carries is the operator's decision on the turn
					// it routes from: it lands on the settled turn's trace, like the
					// direct route's start, once the pickup's handoff is live. Both paths
					// call `recordRoutedDecision`, so one copy of the fact and one clock
					// serve a route that starts in its seat and a route that waited.
					if (item.origin === "workflow") {
						this.recordRoutedDecision(item.ticketIdentity, claimed.previousHandoffId);
					}
					this.reports.refresh();
					if (rowStands) {
						this.reports.notice(
							`${this.ticketName(item.ticketIdentity)} started from the Work queue`,
						);
					}
				} else if (this.state.hasWorkItem(item.ticketIdentity)) {
					// The item keeps its place: the attempt record holds the failure,
					// the ticket keeps its state, and the next free seat retries. A
					// row the operator already removed says its own goodbye on the
					// line, so the cancel needs no second line here (ADR 0034).
					this.reportPickupFailure(item, started.reason);
				}
			},
		);
		return true;
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
		const item = this.state
			.workQueue()
			.find((candidate) => workQueueIdentityOf(candidate) === itemIdentity);
		if (item === undefined) return;
		if (item.kind === "consultation") {
			// The Consultation's claim is its seat move, and the cap is the pickup
			// scheduler's check, not the pickup's: the seam re-runs every start
			// check the pickup runs and skips only the cap, and the item leaves
			// the queue on every answer, the way its pickup does.
			const limit = this.config().maxParallelAgents;
			const overCap = limit > 0 && this.seatCount() >= limit;
			void this.pickupConsultationItem(item, overCap);
			return;
		}
		// Measured before the claim, on the shared count: the line states the
		// start over the cap only when the cap was full at the dispatch.
		const limit = this.config().maxParallelAgents;
		const overCap = limit > 0 && this.seatCount() >= limit;
		const claimed = this.claimQueueItem(item);
		if (claimed.ok === "cancelled") return;
		if (claimed.ok === false) {
			// The claim refused the start: the ticket no longer holds the state
			// its origin requires, its source is gone, or the ledger is unclear.
			// The item leaves the queue with the warning the failed pickup
			// leaves, the pickup's own words for the fact, and the ticket keeps
			// its state.
			this.removeQueueItem(item.ticketIdentity);
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
				previousMessage: item.previousMessage,
				workQueuePickup: true,
			},
			(started) => {
				if (started.ok) {
					// The ask is answered, either way: the item leaves the queue when
					// the start settles. A row the operator already removed leaves no
					// second line: the run it ended earns no start line of its own.
					const rowStands = this.state.hasWorkItem(item.ticketIdentity);
					if (rowStands) this.removeQueueItem(item.ticketIdentity);
					if (item.origin === "workflow")
						this.recordRoutedDecision(item.ticketIdentity, claimed.previousHandoffId);
					this.reports.refresh();
					if (rowStands)
						this.reports.notice(
							overCap
								? `force-dispatched ${this.ticketName(item.ticketIdentity)} over the Parallel limit`
								: `${this.ticketName(item.ticketIdentity)} started from the Work queue`,
						);
				} else if (this.state.hasWorkItem(item.ticketIdentity)) {
					// The ask is answered: a failed start leaves the queue, and the
					// warning names the operation and the reason, one line for the
					// failure the handoff's own line already carries.
					this.removeQueueItem(item.ticketIdentity);
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
		const title = this.state
			.visibleTickets(this.config().taskRules, this.config().defaultTaskType)
			.find((candidate) => candidate.identity === identity)?.title;
		return title === undefined ? `ticket ${identity}` : `"${title}"`;
	}

	/** The pickup warning, once per reason per item. */
	private reportPickupFailure(item: WorkQueueHandoffItem, reason: string): void {
		const warned = this.warnedReasons(item.ticketIdentity);
		if (warned.has(reason)) return;
		warned.add(reason);
		this.reports.warning(
			`queued handoff for ${this.ticketName(item.ticketIdentity)} was not run: ${reason}`,
		);
	}

	/** The reasons this item's pickup has already said, empty until the first. */
	private warnedReasons(ticketIdentity: string): Set<string> {
		const existing = this.warnedPickups.get(ticketIdentity);
		if (existing !== undefined) return existing;
		const created = new Set<string>();
		this.warnedPickups.set(ticketIdentity, created);
		return created;
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
		if (this.stopped)
			return Promise.resolve({ ended: false, reason: "the dispatch has been stopped" });
		// One seat item holds the whole close: the cycle ends and its environment
		// goes, in that order, with no handoff of the same ticket in between them.
		return this.queueCleanup(async () => {
			const handoff = this.state.latestHandoff(identity);
			if (!this.state.closeWorkCycle(identity)) {
				// The ticket moved on while the close waited: it rests open, or its
				// turn settled and awaits a decision of its own. One fact, said once.
				const state = this.state.ticketState(identity) ?? "gone";
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

	private nameKnowledgeFor(identity: string): OwnNameKnowledge {
		const handles = this.state.handoffHandles(identity);
		return {
			ownPaneIds: handles.paneIds,
			ownWorkspaceIds: handles.workspaceIds,
			leftoverKnown: this.state.leftoverEnvironment(identity) !== null,
		};
	}

	private recordNameCollision(identity: string, collision: NameCollision): void {
		if (!collision.own) return;
		this.state.recordLeftoverEnvironment({
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
		const onStage = (stage: string) => this.state.advanceHandoffAttempt(claim.attemptId, stage);
		const names = this.nameKnowledgeFor(ticket.identity);
		const run =
			origin === "open"
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

		void run
			.then((outcome) => this.finishHandoff(ticket.identity, claim, outcome, reportStarted))
			.catch((error) => this.failHandoff(ticket.identity, claim, reportStarted, error));
	}

	private failHandoff(
		identity: string,
		claim: HandoffClaim,
		reportStarted: (started: DispatchResult) => void,
		error: unknown,
	): void {
		if (this.stopped) return;
		const reason = errorMessage(error);
		this.state.settleHandoff(claim.attemptId, false, reason);
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
	): Promise<void> {
		if (this.stopped) return;
		if (outcome.collision !== undefined) this.recordNameCollision(identity, outcome.collision);
		if (outcome.ownCollision !== undefined)
			this.recordNameCollision(identity, outcome.ownCollision);

		this.state.settleHandoff(
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
		this.reports.starting(identity, false);
		this.reports.refresh();
		await reportHandoffOutcome(outcome, this.reports, this.persistMapping);
		reportStarted(
			outcome.status === "failed"
				? { ok: false, reason: outcome.reason }
				: { ok: true, queued: false },
		);
		this.inFlight = false;
		this.drainCleanupQueue();
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
			const currentState = this.state.ticketState(next.ticket.identity);
			if (currentState === undefined || !handoffAllowsState(next.origin, currentState)) {
				// One fact, said once: what the ticket is now. A ticket the state no
				// longer holds is the harder case, and the state it moved to is the
				// one the operator and the attempt both record.
				const movedOn =
					currentState === undefined
						? "the ticket no longer exists"
						: `the ticket is now ${currentState}`;
				this.state.settleHandoff(next.claim.attemptId, false, movedOn);
				this.reports.starting(next.ticket.identity, false);
				this.reports.refresh();
				if (next.workQueuePickup === true) {
					// The parked pickup owns its own line: the item keeps its place, and
					// the pickup's once-per-reason warning says this fact once with the
					// reason the drain found. A second line here would only overwrite the
					// fuller one with a shorter copy of the same fact.
					next.onStarted({ ok: false, reason: movedOn });
				} else {
					this.reports.warning(`queued handoff for "${next.ticket.title}" was not run: ${movedOn}`);
					// The route the claim was for never started: its caller decides
					// nothing on the turn it came from.
					next.onStarted({ ok: false, reason: "the queued handoff was not run" });
				}
				continue;
			}
			// The fresh projection when the ticket is visible, else the claim's
			// snapshot: the handoff runs on the ticket it claimed.
			const snapshot =
				this.state
					.visibleTickets(this.config().taskRules, this.config().defaultTaskType)
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
				{ ...options, controlPlaneWorkspaceId: this.controlPlaneWorkspaceId },
			);
			if (failure === undefined) {
				const reach = closeCleanupReach(handoff);
				this.state.clearLeftoverEnvironments(
					identity,
					reach.scope === "workspace"
						? { workspaceId: reach.workspaceId }
						: reach.scope === "tab"
							? { tabId: reach.tabId }
							: { handoffId: handoff.handoffId },
				);
				return undefined;
			}
			this.state.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId: handoff.handoffId,
				reason: failure,
			});
			return failure;
		} catch (error) {
			const reason = `the close cleanup did not run: ${errorMessage(error)}`;
			this.state.recordLeftoverEnvironment({
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
	previousMessage: string;
	/**
	 * True for the claim a Work queue pickup or force-dispatch made (ADR 0034):
	 * the durable row and this claim are one waiting start, so removing the row
	 * settles this claim and drops this intent. A direct start claims for
	 * itself, and its parked run is nobody's queue item.
	 */
	workQueuePickup?: boolean;
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
	| { ok: true; ticket: Ticket; claim: HandoffClaim; previousHandoffId: string }
	| { ok: false; reason: string }
	| { ok: "cancelled" };

/** A queued handoff may start only from the state its origin claims. */
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
