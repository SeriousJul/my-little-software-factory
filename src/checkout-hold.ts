/**
 * The Shared checkout hold (ADR 0109, issue #297): one Repository's shared
 * checkout is worked by one start at a time.
 *
 * A worktree Handoff creates its worktree out of the Repository's shared
 * checkout, the merge Plane action is the other start the record measured
 * working it (ADR 0068 takes it outside the seat count), and a worktree
 * Consultation is the third start the record measured meeting the pair
 * (issue #315). The Parallel limit cannot separate them, because the Plane
 * action takes no seat and the Consultation's seat is counted on the same
 * shared count the gate is not, so this module is the second gate: one hold
 * per Repository, taken at a start's claim and let go where that start settles.
 *
 * This module owns the hold's state machine - the holds, the two clocks of the
 * bound, the classification of a start, the Repository key a hold stands on,
 * and the record lines - and it owns nothing else. It never touches a Work
 * queue row: the gate answers whether a start crosses, waits, or leaves, and
 * the caller that owns the row performs the wait's keep and the refusal's drop.
 * Two callers own two rows: the Handoff dispatch (src/handoff-dispatch.ts)
 * performs the acts for the Handoff and the Plane action rows, and the
 * Consultation operations (src/consultation-operations.ts) perform them for the
 * Consultation row through the `ConsultationCheckoutHold` seam the dispatch
 * exposes, taken at the Consultation's claim - its move to `opening` - and
 * let go where the opening settles (issue #315). That is why the row acts live
 * on the callers and not inside the gate.
 *
 * The hold is in-memory: it lives and dies inside one run, and the record is
 * the durable account of it. A second plane install working one checkout is
 * not covered, and ADR 0109 records that limit as open.
 */

import type { FactoryConfig } from "./config.ts";
import { recordConsultationName, recordTicketName } from "./domain/record-name.ts";
import type { RepositoryRef, Ticket } from "./domain/ticket.ts";
import type { Logger } from "./logging.ts";
import { repositoryOperationKey } from "./operation-serializer.ts";
import {
	type PlaneActionCheckoutWord,
	planeActionCheckoutWord,
	planeActionSettingOf,
} from "./plane-action-registry.ts";
import { COMMAND_TIMEOUT_MS } from "./runner.ts";
import type { TicketProjection } from "./state/ticket-work-cycle.ts";
import type { WorkQueueHandoffItem, WorkQueuePlaneActionItem } from "./state/work-queue.ts";
import { newestMembership } from "./task-selection.ts";
import { mergeTargetPullRequest } from "./workflow.ts";

/**
 * The fact a start states while another start works its Repository's shared
 * checkout (issue #297, ADR 0109).
 */
const CHECKOUT_WORK_STANDS_FACT = "the shared checkout is at work";

/**
 * The two ends of the bounded wait, one fact per clock (issue #297 review).
 *
 * The bound runs on two clocks, and the two answer different questions, so a
 * reader of `factory.log` has to be able to tell them apart: the hold's age
 * names one start that stopped answering, and the row's own wait names a
 * Repository that is simply busy, where every holder answered in time and the
 * checkout only kept changing hands. One fact for both would report a busy
 * Repository as a hung run.
 *
 * The two clocks end different things. The row's own wait ends the row, the way
 * every pickup attempt ends in start or drop (ADR 0049). The hold's age ends the
 * hold: a holder that outlives the budget is a start the plane must treat as
 * gone, and a hold that stood forever would make every later start of that
 * Repository wait the whole budget and then leave the queue refused, for the rest
 * of the plane's life (issue #297 review, ADR 0109).
 */
export const CHECKOUT_HOLD_OVER_BUDGET_FACT = "the shared checkout stayed at work past its budget";
export const CHECKOUT_ROW_OVER_BUDGET_FACT =
	"the row waited behind the shared checkout past its budget";

/**
 * How long a checkout may hold a start before the plane refuses it (issue #297,
 * ADR 0109). The bound runs on two clocks, read against this one budget, and
 * each clock answers its own question and ends its own thing:
 *
 * - the hold's own age, from the clock reading its start took the checkout, and
 *   stated with `CHECKOUT_HOLD_OVER_BUDGET_FACT` when it ends the hold. The
 *   checkout work one start does is a short sequence of commands, and a hold that
 *   still stands a whole command budget after the start took it is a start that
 *   stopped answering, and the plane drops it so the Repository keeps working.
 *   The next start then crosses, and the row that waited runs.
 * - the waiting row's own wait, from the clock reading its line was first
 *   stated, and refused with `CHECKOUT_ROW_OVER_BUDGET_FACT`. A Repository whose
 *   checkout keeps changing hands gives every new holder a fresh reading, so the
 *   hold's age alone lets a chain of short starts hold one row past any bound
 *   (issue #297 review, measured on the 16-handoff probe). This clock names a
 *   busy Repository, not a hung run, and its fact says so.
 *
 * The budget is the Command runner's own budget for a single command, read off
 * the runner rather than restated here (issue #297 review): the bound's whole
 * argument is "a start that could not answer one command budget is not
 * answering", and a budget that drifted from the runner's would be an argument
 * about a number the plane never uses. The two are one number by construction,
 * not by a comment that asks for care.
 *
 * The second clock bounds one standing row, not one Ticket: the entry follows
 * its row the way the standing-row refusal's entry does (issue #223), so a row
 * that leaves and a later row for the same Ticket are two facts, and the later
 * row waits on a fresh reading. ADR 0109 records that limit as open.
 *
 * The bound is what keeps the wait from being forever, the way every other wait
 * in the queue is bounded (ADR 0049).
 */
export const CHECKOUT_WORK_BUDGET_MS = COMMAND_TIMEOUT_MS;

/**
 * The channel word the Shared checkout hold names a start by (issue #297
 * review). The Handoff side is the dispatch's own word; the Plane action side
 * comes from the registry's action, so a second Plane action the registry gains
 * waits in its own words and the assumption cannot go stale.
 */
export type CheckoutChannel = "handoff" | "consultation" | PlaneActionCheckoutWord;

/**
 * Which half of the pair works a checkout (issue #297 review). Every settle path
 * knows its own channel - the merge run settles in the plane action's run, a
 * Handoff settles in the Handoff's - and none of them re-reads the registry, so
 * the hold is released by the side that took it and the word it wears stays the
 * record's.
 */
export type CheckoutSide = "handoff" | "plane-action" | "consultation";

/**
 * What one start is to the checkout: the side that releases its hold, and the
 * word the record names it by (issue #297 review). The pair comes from one
 * reading of the item, because the two are one fact - the release path knows the
 * side and the record line needs the word, and two readers of the item could
 * answer the same start differently.
 */
export interface CheckoutStart {
	readonly side: CheckoutSide;
	readonly channel: CheckoutChannel;
}

/**
 * The record line of a start the Shared checkout hold keeps in the Work queue.
 */
export function checkoutWaitLine(channel: CheckoutChannel, name: string, fact: string): string {
	return `${channel} waits: ${name} (${fact})`;
}

/**
 * The Message line the operator's force-dispatch key answers a held row with
 * (issue #297 review): the row stands, and the fact that holds it reaches the
 * operator beside the record.
 */
export function checkoutWaitMessageLine(name: string, fact: string): string {
	return `${name} waits in the Work queue: ${fact}`;
}

/**
 * How the record names the start that holds a Repository's checkout. The wait
 * line, the force-dispatch answer, and the drop line all wear this one phrase, so
 * the holder reads the same wherever the plane names it.
 */
function checkoutHolderPhrase(holderChannel: CheckoutChannel, holderName: string): string {
	return `the ${holderChannel} of ${holderName}`;
}

/**
 * The fact the wait states: the checkout at work, and the start that holds it
 * (issue #297, ADR 0109). The line names the holder so the reader sees the pair
 * that met without guessing which run stands.
 *
 * It says `holds it` and not `runs in it` on purpose (issue #297 review): the
 * merge half of the pair works the Repository's remote and not its checkout, and
 * a record line may not state the premise ADR 0109 measured away.
 */
export function checkoutWaitHolderFact(holderChannel: CheckoutChannel, holderName: string): string {
	return `${CHECKOUT_WORK_STANDS_FACT}: ${checkoutHolderPhrase(holderChannel, holderName)} holds it`;
}

/**
 * The record line of a hold the budget ends (issue #297 review). The holder's own
 * facts still say it stands, and it has stood a whole checkout budget, which is
 * the plane's reading of a start that stopped answering. The line names the
 * holder, because the next start of that Repository then runs beside a run the
 * record never saw end.
 */
export function checkoutHoldDropLine(
	holderChannel: CheckoutChannel,
	holderName: string,
	fact: string,
): string {
	return `checkout hold dropped: ${checkoutHolderPhrase(holderChannel, holderName)} (${fact})`;
}

/**
 * The start of this item that works a shared checkout, or null when the item
 * works none (issue #297, ADR 0109): a worktree Handoff creates its worktree out
 * of the Repository's shared checkout, and the Plane action is the start the
 * record shows meeting that create (ADR 0068 takes it outside the seat count,
 * so nothing else separates the two). A live-worktree Handoff works a checkout
 * the operator chose and already owns, so it takes no hold. A Consultation row
 * is classified here neither, because the row the gate walks names the Ticket
 * of its Ticket and not the Consultation the row stands for, and the
 * Consultation operations cross the gate on the row's own facts through
 * `crossConsultation` instead (issue #315, ADR 0109).
 *
 * The Plane action side takes its word from the registry's action, not from the
 * caller (issue #297 review): the hold's channel, the `<word> waits:` prefix,
 * the holder fact, and the refusal's wording are that word's, so a second Plane
 * action the registry gains waits behind the same holds and states them in its
 * own words. A task type the registry holds no action for names no channel, and
 * its run's own gate refuses it.
 *
 * A Consultation row is not classified here: the Consultation operations own
 * its environment read, and they cross the gate through `crossConsultation`
 * with their own classification at the start's claim (issue #315).
 */
export function checkoutStartOf(
	item: WorkQueueHandoffItem | WorkQueuePlaneActionItem,
	config: FactoryConfig,
): CheckoutStart | null {
	if (item.kind === "plane-action") {
		const setting = planeActionSettingOf(config.taskTypes, item.taskType);
		return setting === null
			? null
			: { side: "plane-action", channel: planeActionCheckoutWord(setting.name) };
	}
	return item.choice.environment === "worktree" ? { side: "handoff", channel: "handoff" } : null;
}

/**
 * The Repository checkout one start works (issue #297 review): the pull
 * request's Repository for a merge, the Repository the Handoff's Ticket stands
 * in for a worktree start. A start works one checkout, so the gate and the hold
 * name that one Repository and nothing else: a Ticket listed in two
 * Repositories holds the checkout its start works, not the pair of them. A
 * Ticket the projection no longer holds, and a merge with no pull request to
 * aim at, name no checkout: their start crosses the gate, takes no hold, and
 * the run's own gates refuse it.
 */
function checkoutKeyOf(
	item: WorkQueueHandoffItem | WorkQueuePlaneActionItem,
	projection: TicketProjection,
): string | null {
	const ticket = projection.rowFor(item.ticketIdentity);
	if (ticket === undefined) return null;
	const repository =
		item.kind === "plane-action" ? mergeTargetRepository(projection, ticket) : ticket.repositoryRef;
	if (repository === undefined) return null;
	const key = repositoryOperationKey(repository.identity);
	return key === "" ? null : key;
}

/**
 * The Repository the merge run works: the position's own pull request when the
 * position is one, and its fixing pull request when the position is the ticket
 * the pull request fixes - the resolution the run aims with, through
 * `mergeTargetPullRequest`, so the hold names the Repository the merge's
 * commands work through and the two cannot drift apart.
 */
function mergeTargetRepository(
	projection: TicketProjection,
	ticket: Ticket,
): RepositoryRef | undefined {
	const pullRequest = mergeTargetPullRequest(projection.rows, ticket);
	if (pullRequest === null) return undefined;
	const membership = newestMembership(pullRequest.memberships);
	return membership === undefined ? undefined : membership.repository;
}

/**
 * The start that works a Repository's shared checkout, and the Ticket whose run
 * holds it (issue #297, ADR 0109).
 *
 * A worktree Handoff creates its worktree out of the Repository's shared
 * checkout. The merge Plane action is the other start of the pair the record
 * measured: its run works the Repository through the source, and it reaches
 * the Repository with no Parallel limit seat between it and a worktree create
 * (ADR 0068), so the hold separates the two starts the development run saw
 * meeting. ADR 0109 states what each start works, the measured fact that the
 * merge's own commands are `gh` commands, and the cost the merge's half of the
 * rule costs the Handoff side.
 *
 * This hold is the checkout's own rule - one holder per Repository - and it
 * stands beside the seat, never counted against it.
 */
interface CheckoutHold {
	/** The side of the pair that took the hold, and the side it releases on. */
	side: CheckoutSide;
	/** The word the wait line and the holder fact name this start by. */
	channel: CheckoutChannel;
	/**
	 * The row identity whose start holds the checkout: the ticket of a Handoff
	 * or a merge, the Consultation id of a worktree Consultation (issue #315).
	 */
	identity: string;
	/**
	 * The clock reading the start took the checkout: one of the two readings the
	 * budget above measures (issue #297 review).
	 */
	takenAt: number;
}

/**
 * The Work queue's answer to the shared checkout gate: the start crosses, the
 * start waits with its row, or the start leaves the queue with the refusal.
 * The two refusals are told apart because they answer the operator's
 * force-dispatch key differently: a row the gate dropped never reports itself
 * as waiting in the Work queue (issue #297 review).
 *
 * The answer carries the Repository key the gate resolved on the crossing
 * branch only, because that is the one branch with a use for it: the claim's
 * take uses the key the gate computed and the pass reads no projection for it a
 * second time (issue #297 review). A waiting row and a refused row name no key,
 * and the gate says so in its own type instead of carrying a key no reader
 * reads.
 */
export type CheckoutGate =
	| { ok: true; checkoutKey: string | null }
	| { ok: false; outcome: "waiting"; fact: string }
	| { ok: false; outcome: "refused"; fact: string; start: CheckoutStart };

/**
 * What the ledger is told about the plane, and nothing else (issue #297 review).
 * The ledger decides the hold from these facts alone, so a second caller - the
 * Consultation's worktree start of issue #315 - brings its own answers and the
 * hold's two clocks are testable without the dispatch's rig.
 */
export interface CheckoutHoldFacts {
	/** The clock both budgets of the bound measure. */
	now(): number;
	/** The config the Plane action side reads its registry word from. */
	config(): FactoryConfig;
	/** Whether the start that took a hold still stands: the merge run's mark,
	 * the Handoff attempt, the Consultation record's `opening` state. */
	holderStands(side: CheckoutSide, identity: string): boolean;
	/** Whether the Work queue still holds this row: the ticket's row, or the
	 * Consultation's (issue #315). */
	rowStands(identity: string): boolean;
	/**
	 * The Repository identity a Consultation's record works, for the key of its
	 * hold (issue #315): the record is the caller's fact, the way the
	 * projection is the caller's read.
	 */
	consultationRepository(consultationId: string): string | undefined;
	/**
	 * The Consultation type name a record line names a Consultation start by,
	 * beside the identity prefix (issue #315).
	 */
	consultationTypeName(consultationId: string): string | undefined;
	/** Where the wait line, and the line of a hold the budget ends, are written. */
	readonly log?: Logger;
}

/**
 * The holds and the waits of one plane run (issue #297, ADR 0109).
 *
 * The holds map is one holder per Repository, keyed by the shared Repository
 * key, so `acme/factory` and `github.com/acme/factory` are one checkout and not
 * two. It is bounded by the Repositories the plane works at once.
 *
 * The waits map holds the Work queue rows the record has named a checkout wait
 * for - a ticket's row, or a Consultation's row (issue #315) - each with the
 * clock reading its wait began and the holder its line named. The rule is the
 * one issue #231 sets for a standing fact: once while it stands, again when the
 * fact changes, never once per poll. The entry stands while the row stands, the
 * way the standing-row refusal's entry does, and the pickup pass sweeps the
 * entries whose row is gone. The clock reading is kept across a hand-off: the
 * row's own wait is one of the two bounds, and a checkout that keeps changing
 * hands must not reset it (issue #297 review).
 */
export class CheckoutHoldLedger {
	/** The Repository checkouts this run works, one holder per Repository. */
	private readonly holds = new Map<string, CheckoutHold>();
	/** The rows the record has named a checkout wait for. */
	private readonly waits = new Map<string, { since: number; holder: string }>();

	private readonly facts: CheckoutHoldFacts;

	constructor(facts: CheckoutHoldFacts) {
		this.facts = facts;
	}

	/**
	 * The shared checkout gate one start crosses before its claim (issue #297,
	 * ADR 0109).
	 *
	 * A start that finds its Repository's checkout at work leaves its row in the
	 * Work queue: the wait is the row's, the row wears the `queued` badge it
	 * already wore, and the record names the wait once while it stands. A row that
	 * waits past its own bound is refused with the reason, the way every pickup
	 * attempt ends in start or drop (ADR 0049) - the queue never holds a row
	 * forever. This ledger answers the refusal and does not perform it: the row
	 * belongs to the caller, and a Consultation row belongs to another module
	 * (issue #315). The other clock of the bound, the hold's age, is read where
	 * the holder is and ends the hold, so the file tells a run that stopped
	 * answering from a Repository that is simply busy (issue #297 review).
	 *
	 * The gate is not the Parallel limit and does not read it: the Plane action
	 * takes no seat, and the wait belongs to the checkout (ADR 0068 unchanged).
	 *
	 * The projection is the caller's read, asked only when the row reaches the
	 * gate, and handed down by the pass that walks the rows (issue #297 review):
	 * the gate runs no query of its own, and a row that works no checkout reads
	 * nothing.
	 */
	cross(
		item: WorkQueueHandoffItem | WorkQueuePlaneActionItem,
		checkoutProjection: () => TicketProjection,
	): CheckoutGate {
		const start = checkoutStartOf(item, this.facts.config());
		if (start === null) return { ok: true, checkoutKey: null };
		const projection = checkoutProjection();
		const key = checkoutKeyOf(item, projection);
		return this.gateFor(start, item.ticketIdentity, key, projection);
	}

	/**
	 * The shared checkout gate one worktree Consultation crosses before its
	 * claim (issue #315, ADR 0109): the same holds, the same two clocks, the
	 * same record lines as the gate above, read against the Consultation's own
	 * facts instead of a Work queue item's.
	 *
	 * The classification is the caller's, not the gate's: the Consultation
	 * operations re-read the type's settings on their own seam, and they cross
	 * only the start that works a worktree, the way the gate above answers null
	 * for a live-worktree Handoff. The key is the record's Repository through the
	 * facts, so a consultation whose record the state no longer holds crosses
	 * with no key and takes no hold, the way a ticket the projection dropped does
	 * in the gate above. The projection is the caller's read and is lazy: a
	 * consultation whose checkout is free reads nothing but the record's
	 * Repository.
	 */
	crossConsultation(
		consultationId: string,
		checkoutProjection: () => TicketProjection,
	): CheckoutGate {
		const repository = this.facts.consultationRepository(consultationId);
		if (repository === undefined) return { ok: true, checkoutKey: null };
		const key = repositoryOperationKey(repository);
		if (key === "") return { ok: true, checkoutKey: null };
		const projection = checkoutProjection();
		return this.gateFor(
			{ side: "consultation", channel: "consultation" },
			consultationId,
			key,
			projection,
		);
	}

	/**
	 * The gate's answer for one classified start at one Repository key (issue
	 * #315): the crossing, the wait, and the refusal the two clocks of the bound
	 * give. Both gates above share it, so the Handoff row and the Consultation
	 * row of one Repository answer one rule.
	 */
	private gateFor(
		start: CheckoutStart,
		identity: string,
		key: string | null,
		projection: TicketProjection,
	): CheckoutGate {
		if (key === null) return { ok: true, checkoutKey: null };
		const holder = this.holderOf(key, projection);
		if (holder === null) {
			this.waits.delete(identity);
			return { ok: true, checkoutKey: key };
		}
		const stated = this.waits.get(identity);
		// One clock refuses at the gate: the row's own wait. A checkout that keeps
		// changing hands gives every new holder a fresh reading, so a row that has
		// waited a whole budget leaves the queue whatever the chain of holders did
		// behind it. The other clock, the hold's age, is read where the holder is, and
		// it ends the hold and not the row (issue #297 review, ADR 0109).
		if (stated !== undefined && this.facts.now() - stated.since >= CHECKOUT_WORK_BUDGET_MS) {
			this.waits.delete(identity);
			// The refusal names the channel the wait line named, and the caller needs
			// that word to drop the row, so the gate hands back the one classification
			// it made instead of asking its caller to make it again.
			return {
				ok: false,
				outcome: "refused",
				fact: CHECKOUT_ROW_OVER_BUDGET_FACT,
				start,
			};
		}
		if (stated === undefined || stated.holder !== holder.identity) {
			// A new wait, or the same row waiting behind a different start: the
			// fact changed, so it states itself again (issue #231). The wait's own
			// age carries over from the first line, because the row's wait is one
			// fact and not one per holder. The entry stands while the row stands:
			// a start that reaches the gate with no row in the queue - the
			// Consultation the operator started directly, beside no queue row
			// (issue #315) - waits on no entry and leaves no line, because the wait
			// is the row's and the queue holds no row for it.
			if (this.facts.rowStands(identity)) {
				this.waits.set(identity, {
					since: stated?.since ?? this.facts.now(),
					holder: holder.identity,
				});
				this.facts.log?.info(
					checkoutWaitLine(
						start.channel,
						this.nameOf(start.side, identity, projection),
						this.waitFact(holder, projection),
					),
				);
			}
		}
		return { ok: false, outcome: "waiting", fact: this.waitFact(holder, projection) };
	}

	/**
	 * Take the checkout hold for a claimed start (issue #297). It runs after
	 * the claim and before the start's first command, in the same synchronous
	 * step as the gate above, so no second walk can read a free checkout while
	 * this start is on its way in. The clock reading it records is the point
	 * the budget measures from. The key is the one the gate above computed for
	 * this same row, so the take runs no projection read of its own (issue #297
	 * review), and the start's classification is the gate's own reading of the
	 * item, so a take cannot name a different kind of start from the gate that
	 * let it through.
	 */
	take(item: WorkQueueHandoffItem | WorkQueuePlaneActionItem, key: string | null): void {
		const start = checkoutStartOf(item, this.facts.config());
		if (key !== null && start !== null) {
			this.holds.set(key, {
				side: start.side,
				channel: start.channel,
				identity: item.ticketIdentity,
				takenAt: this.facts.now(),
			});
		}
		this.forgetWait(item.ticketIdentity);
	}

	/**
	 * Take the checkout hold for one claimed worktree Consultation (issue #315):
	 * the take of the gate above, on the consultation's facts. The key is the one
	 * the gate computed for this same start, so the take runs no read of its own,
	 * and the caller crossed the gate in the claim's own synchronous step, so a
	 * key that is not null names a worktree start, the way the gate's own key does.
	 */
	takeConsultation(consultationId: string, key: string | null): void {
		if (key !== null) {
			this.holds.set(key, {
				side: "consultation",
				channel: "consultation",
				identity: consultationId,
				takenAt: this.facts.now(),
			});
		}
		this.forgetWait(consultationId);
	}

	/**
	 * Let go of the checkout a start worked, if it still holds one (issue #297).
	 * The release runs wherever that start settles, and it is idempotent: a
	 * start that took no hold, and a start whose hold another path already
	 * dropped, change nothing.
	 *
	 * The release matches on the side and the Ticket and not on the key, so a
	 * holder whose hold the budget already ended cannot release the hold a later
	 * start of that Repository took in its place (issue #297 review).
	 */
	release(side: CheckoutSide, identity: string): boolean {
		let released = false;
		for (const [key, hold] of this.holds) {
			if (hold.side === side && hold.identity === identity) {
				this.holds.delete(key);
				released = true;
			}
		}
		this.forgetWait(identity);
		return released;
	}

	/** Whether any row stands in a checkout wait, the fact a release asks before it re-runs a pass. */
	hasWaits(): boolean {
		return this.waits.size > 0;
	}

	/**
	 * Forget the checkout wait stated for one row (issue #297). The entry
	 * stands while the row stands: a row that leaves, and a new row for the
	 * same ticket, are each a new fact, the way the standing-row refusal's
	 * entry follows its row (issue #223).
	 */
	forgetWait(ticketIdentity: string): void {
		this.waits.delete(ticketIdentity);
	}

	/**
	 * Forget the checkout waits whose row no longer stands (issue #297). The
	 * sweep follows the standing-row sweep it stands beside: the entry stands
	 * while the row stands, and the pickup pass runs it whatever the brake and
	 * the seat checks answer below.
	 */
	sweepWaits(): void {
		for (const identity of [...this.waits.keys()]) {
			if (!this.facts.rowStands(identity)) this.waits.delete(identity);
		}
	}

	/**
	 * Drop the holds no start will ask about again (issue #297 review).
	 *
	 * The gate drops a hold when a start reaches its Repository, so a hung
	 * holder of a Repository nothing wants again would keep its hold, and the
	 * plane would never state the fact. The sweep reads the same two facts the
	 * gate reads - the holder's own mark and the hold's age - and states the
	 * same drop line, so the record says a hold ended whether or not a second
	 * start ever came to that checkout. The projection is read only when a hold
	 * actually ends, because the line names the holder.
	 */
	sweepHolds(checkoutProjection: () => TicketProjection): void {
		for (const [key, hold] of [...this.holds]) {
			if (!this.facts.holderStands(hold.side, hold.identity)) {
				this.holds.delete(key);
				continue;
			}
			if (this.facts.now() - hold.takenAt < CHECKOUT_WORK_BUDGET_MS) continue;
			this.holds.delete(key);
			const projection = checkoutProjection();
			this.facts.log?.warn(
				checkoutHoldDropLine(
					hold.channel,
					this.nameOf(hold.side, hold.identity, projection),
					CHECKOUT_HOLD_OVER_BUDGET_FACT,
				),
			);
		}
	}

	/**
	 * The fact the wait states: the checkout at work, and the start that holds
	 * it. The name is read out of the caller's projection, the way the gate's
	 * key is (issue #297 review): a standing wait is stated on every pass, and
	 * a fact builder that read the pile per row would put that read back.
	 */
	private waitFact(holder: CheckoutHold, projection: TicketProjection): string {
		return checkoutWaitHolderFact(
			holder.channel,
			this.nameOf(holder.side, holder.identity, projection),
		);
	}

	/**
	 * The name a record line gives the start that stands on one row identity
	 * (issue #315): the projection's title for a ticket, the record's Consultation
	 * type beside its identity prefix for a Consultation, so the wait line, the
	 * holder fact, and the drop line of one start all wear its start line's name.
	 */
	private nameOf(side: CheckoutSide, identity: string, projection: TicketProjection): string {
		if (side === "consultation")
			return recordConsultationName(this.facts.consultationTypeName(identity), identity);
		return recordTicketName(projection, identity);
	}

	/**
	 * The start that works this checkout now, or null when it is free (issue #297).
	 *
	 * A hold whose holder no longer stands is dropped here: the merge run's
	 * mark and the Handoff attempt are the facts that say a start stands, and a
	 * hold outliving both is a bookkeeping miss, not work. The plane keeps the
	 * Repository working rather than lock it out for the rest of the run.
	 *
	 * A hold whose holder stands past the checkout work's own budget is dropped
	 * here too, and states the holder it ended (issue #297 review). The bound that
	 * only refused the waiting row left the holder standing forever, and one start
	 * that never answered would then refuse every later start of its Repository:
	 * each waited the whole budget and left the queue refused, for as long as the
	 * plane ran. The age that says the holder is gone ends the hold instead, and the
	 * next start crosses.
	 */
	private holderOf(key: string, projection: TicketProjection): CheckoutHold | null {
		const hold = this.holds.get(key);
		if (hold === undefined) return null;
		if (this.facts.holderStands(hold.side, hold.identity)) {
			if (this.facts.now() - hold.takenAt < CHECKOUT_WORK_BUDGET_MS) return hold;
			this.holds.delete(key);
			this.facts.log?.warn(
				checkoutHoldDropLine(
					hold.channel,
					this.nameOf(hold.side, hold.identity, projection),
					CHECKOUT_HOLD_OVER_BUDGET_FACT,
				),
			);
			return null;
		}
		this.holds.delete(key);
		return null;
	}
}

/**
 * The Consultation side's seam into the hold (issue #315, ADR 0109): the acts
 * a Consultation's worktree start performs at the shared checkout, taken at the
 * Consultation's claim - its move to `opening` - and let go where the opening
 * settles.
 *
 * The Consultation operations hold the seam and perform the acts the gate
 * answers for: the wait the row keeps, the refusal that ends the row in a
 * record state, and the release. The Handoff dispatch owns the ledger the seam
 * crosses, so the hold stays one state machine - the ledger's - and the row
 * acts stay on the side that owns the row, the way the dispatch performs them
 * for the Handoff and the Plane action rows.
 */
export interface ConsultationCheckoutHold {
	/**
	 * Cross the shared checkout gate for one worktree Consultation start, at its
	 * claim. The caller crosses only the start that works a worktree, the way
	 * the dispatch crosses only the rows the ledger classifies.
	 */
	cross(consultationId: string): CheckoutGate;
	/**
	 * Take the hold the gate let cross, in the claim's own synchronous step,
	 * with the key the gate computed for this same start.
	 */
	take(consultationId: string, checkoutKey: string | null): void;
	/**
	 * Let go of the checkout where the opening settles. Idempotent, the way the
	 * ledger's release is: an opening that took no hold changes nothing.
	 */
	release(consultationId: string): void;
}
