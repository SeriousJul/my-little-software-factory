/**
 * The Dispatch pause invariant walk (issue #351 review).
 *
 * The walk drives the real aggregates with seeded random sequences of the write
 * path - Handoff claims and settles, settles with every cause, completion
 * decisions, reopens, cycle closes, source reads, ignores, and source mutes -
 * and asks the pause after every operation. Two checks stand at every step.
 *
 * 1. The pause never stands while the active Ticket list holds no row that can
 *    answer it. That is the symptom issue #351 reports: a warning that holds
 *    every automatic start on a fact no surface shows and no key answers.
 * 2. The pause agrees with the walk's own ledger of the traces it wrote - each
 *    Ticket's state and work cycle, and each trace's cause, decision, cycle,
 *    and place in its Ticket's newest-first order. The ledger states the
 *    expected pause from those facts and the walk compares both directions, so
 *    the oracle is not a production read.
 *
 * What the walk guards, then, is the pause's read of the facts: the three
 * guards ADR 0016 names - the Ticket resting `awaiting`, the trace standing in
 * the cycle the Ticket is on, and the trace being that Ticket's newest settled
 * turn - and the one-way `completed` release ADR 0016 keeps. Check 1 alone
 * guards none of them: it reads the row's `held` badge through
 * `holdsDecision()`, the same predicate the badge wears, so the pause and the
 * badge could drift together and check 1 would see nothing. Measured on this
 * walk, each guard removed from `heldFailureTrace()` turns check 2 red inside
 * the first sequence: the newest-turn guard at step 62, that guard read
 * globally instead of per Ticket at step 67, the `awaiting` guard at step 78,
 * and the current-cycle guard at step 52.
 *
 * What the walk does not guard is the meaning of the words. The named single
 * cases stand in `test/state/turnCause.test.ts`, which owns the cross-ticket
 * read as one readable scenario - "a superseded failed turn on one Ticket
 * leaves another's held failure standing" - and the operator's decision that
 * releases it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	type CompletionTraceOrder,
	dispatchPauseHolds,
	holdsDecision,
	type Ticket,
} from "../../src/domain/ticket.ts";
import { openFactoryState } from "../../src/state.ts";
import { choice, cleanup, fetched, sourceA, statePath, success, textLog } from "./harness.ts";

afterEach(cleanup);

/** The seed is fixed, so the counts this walk reports stand across runs. */
const SEED = 351;
const SEQUENCES = 300;
const OPERATIONS = 80;

/**
 * Coverage the walk asserts as a lower bound, never as an exact count. An exact
 * count ties the suite to every detail of the write path - a new claim refusal,
 * a changed settle rule, a new cause, a changed operation bag - and leaves a
 * maintainer to re-derive a magic constant to continue. The guarantee wanted is
 * that the walk still reaches the pause it guards, and a bound gives it.
 *
 * Measured at this head over the 24,000 steps: 4379 steps leave the pause
 * standing; 1074 leave a held `failed` turn standing in the ledger while a
 * newer `completed` trace on another Ticket releases the pause, the one-way
 * direction ADR 0016 keeps; and 47 leave the current-cycle guard deciding the
 * pause, the case a trace a cycle close leaves behind reaches only when a later
 * turn settles with an older stamp.
 */
const MIN_STEPS_WITH_THE_PAUSE_STANDING = 3500;
const MIN_STEPS_RELEASED_BY_ANOTHER_TICKET = 700;
const MIN_STEPS_THE_CLOSED_CYCLE_GUARD_DECIDES = 20;

const TICKETS = ["I_1", "I_2", "I_3", "I_4", "I_5", "I_6"].map((key) => `github:github.com:${key}`);

const CAUSES = ["completed", "failed", "failed", "aborted", "truncated", "unknown"] as const;

const ORIGINS = ["open", "workflow", "restart"] as const;

const DECISIONS = ["closed", "auto-closed", "abandoned", "handed-off"] as const;

/** The operation bag the walk draws from: the write path, weighted. */
const OPERATIONS_BAG = [
	"start",
	"start",
	"start",
	"start",
	"settle",
	"settle",
	"settle",
	"settle",
	"settle",
	"decide",
	"decide",
	"decide",
	"reopen",
	"reopen",
	"close",
	"close",
	"fetch",
	"fetch",
	"ignore",
	"mute",
] as const;

type Operation = (typeof OPERATIONS_BAG)[number];

/** Draw one entry of a bag with the walk's own draw in [0, 1). */
function pick<T>(bag: readonly T[], draw: number): T {
	return bag[Math.floor(draw * bag.length)] as T;
}

/** `mulberry32`: a small deterministic generator, so one seed is one walk. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = state;
		mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
		mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

/** The order the trace table sorts by: the completion time, then the row. */
function traceOrderIsLater(left: CompletionTraceOrder, right: CompletionTraceOrder): boolean {
	return (
		left.completedAt > right.completedAt ||
		(left.completedAt === right.completedAt && left.rowId > right.rowId)
	);
}

/** One settled turn the walk wrote, as the walk remembers it. */
interface TraceFact extends CompletionTraceOrder {
	/** The Handoff attempt whose settle wrote it. */
	attempt: string;
	cause: string;
	decided: boolean;
	/** The work cycle the trace was written on, which a later cycle leaves behind. */
	cycle: number;
}

/** What the walk knows about one Ticket, from its own operations. */
interface TicketLedger {
	state: "open" | "handed-off" | "running" | "awaiting";
	cycle: number;
	/** The turn this Ticket has claimed and started but not settled. */
	pending: string | null;
	/** The cycle that turn was claimed on: its trace stands there, not on the cycle the Ticket reaches since. */
	pendingCycle: number;
	/** The newest settled undecided turn, the one a decision or a reopen answers. */
	owed: string | null;
	traces: TraceFact[];
}

describe("the Dispatch pause invariant walk", () => {
	test("the pause never stands with no row to answer it, and it agrees with the walk's own ledger", () => {
		let pauseSteps = 0;
		let releasedAwaySteps = 0;
		let closedCycleSteps = 0;
		for (let sequence = 0; sequence < SEQUENCES; sequence++) {
			const walk = new Walk(sequence);
			for (let step = 0; step < OPERATIONS; step++) walk.step(step);
			pauseSteps += walk.pauseSteps;
			releasedAwaySteps += walk.releasedAwaySteps;
			closedCycleSteps += walk.closedCycleSteps;
			walk.close();
		}
		expect(pauseSteps).toBeGreaterThanOrEqual(MIN_STEPS_WITH_THE_PAUSE_STANDING);
		expect(releasedAwaySteps).toBeGreaterThanOrEqual(MIN_STEPS_RELEASED_BY_ANOTHER_TICKET);
		expect(closedCycleSteps).toBeGreaterThanOrEqual(MIN_STEPS_THE_CLOSED_CYCLE_GUARD_DECIDES);
	});
});

/** One seeded sequence of operations over one real state file. */
class Walk {
	pauseSteps = 0;
	releasedAwaySteps = 0;
	closedCycleSteps = 0;

	private readonly next: () => number;
	/** The walk's own timeline: the state clock and the trace times move as one. */
	private traceTime = Date.parse("2026-08-31T10:00:00Z");
	private fetchTime = Date.parse("2026-08-31T10:00:30Z");
	private readonly state = openFactoryState(statePath(), () => this.traceTime);
	/** The walk's own ledger of every Ticket and every trace it wrote. */
	private readonly ledger = new Map<string, TicketLedger>();
	/** Counts up with every trace insert: the order the trace table's rowid takes. */
	private traceRow = 0;
	/** Every operation the walk ran, so a broken sequence reads back. */
	private readonly script: string[] = [];

	constructor(seed: number) {
		this.next = random(SEED + seed * 7919);
		this.state.sourceFact.initializeSources([sourceA]);
		this.state.sourceFact.applyFetch(sourceA, success(TICKETS.map(fetched)));
		for (const identity of TICKETS)
			this.ledger.set(identity, {
				state: "open",
				cycle: 1,
				pending: null,
				pendingCycle: 1,
				owed: null,
				traces: [],
			});
	}

	close(): void {
		this.state.close();
	}

	step(step: number): void {
		const identity = pick(TICKETS, this.next());
		const operation = pick(OPERATIONS_BAG, this.next());
		if (operation === "start") this.start(identity);
		else if (operation === "settle") this.settle(identity);
		else if (operation === "decide") this.decide(identity);
		else if (operation === "reopen") this.reopen(identity);
		else if (operation === "close") this.closeCycle(identity);
		else if (operation === "fetch") this.fetch();
		else if (operation === "ignore") this.ignore(identity);
		else this.mute();
		this.check(operation, identity, step);
	}

	private start(identity: string): void {
		const ticket = this.ledger.get(identity) as TicketLedger;
		if (ticket.pending !== null) return;
		const origin = pick(ORIGINS, this.next());
		const claim = this.state.handoff.claimHandoff(identity, choice, origin);
		if (!claim.ok) {
			this.note("start", identity, `refused: ${claim.reason}`);
			return;
		}
		const attempt = claim.claim.attemptId;
		this.state.handoff.settleHandoff(attempt, true, undefined, {
			paneId: `pane-${attempt.slice(0, 8)}`,
			tabId: `tab-${attempt.slice(0, 8)}`,
			workspaceId: `ws-${attempt.slice(0, 8)}`,
		});
		// The start moves an open or a resting Ticket to `handed-off`; the restart
		// of an in-flight Ticket leaves its state where it stands. The turn's trace
		// will stand on the cycle the claim found, whatever the Ticket moves to.
		if (ticket.state === "open" || ticket.state === "awaiting") ticket.state = "handed-off";
		ticket.pending = attempt;
		ticket.pendingCycle = ticket.cycle;
		this.note("start", identity, origin);
	}

	private settle(identity: string): void {
		const ticket = this.ledger.get(identity) as TicketLedger;
		const attempt = ticket.pending;
		if (attempt === null) return;
		const cause = pick(CAUSES, this.next());
		// The trace's time mostly moves forward, and now and then a settle lands
		// with an older stamp than the turn before it: which trace is a Ticket's
		// newest is the order the reads share, not the clock.
		this.traceTime += Math.floor(this.next() * 7) * 60_000 - (this.next() < 0.25 ? 900_000 : 0);
		const completedAt = new Date(this.traceTime).toISOString();
		this.state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: attempt,
			taskType: "implement",
			agentType: "pi",
			message: `the ${cause} turn`,
			turnLog: textLog(`the ${cause} turn`),
			completedAt,
			cause,
			detail: "",
		});
		ticket.pending = null;
		// The settle rests only an in-flight or a resting Ticket: the trace a cycle
		// close leaves behind settles on a Ticket already open, and leaves it open.
		if (ticket.state === "handed-off" || ticket.state === "running" || ticket.state === "awaiting")
			ticket.state = "awaiting";
		ticket.owed = attempt;
		const reopened = ticket.traces.find((trace) => trace.attempt === attempt && !trace.decided);
		if (reopened !== undefined) {
			// A reopened turn settles again: the same trace is refreshed, its cause
			// and its time overwritten and its cycle and row the same.
			reopened.cause = cause;
			reopened.completedAt = completedAt;
		} else {
			this.traceRow += 1;
			ticket.traces.push({
				attempt,
				completedAt,
				rowId: this.traceRow,
				cause,
				decided: false,
				cycle: ticket.pendingCycle,
			});
		}
		this.note("settle", identity, cause);
	}

	private decide(identity: string): void {
		const ticket = this.ledger.get(identity) as TicketLedger;
		const attempt = ticket.owed;
		if (attempt === null) return;
		const decision = pick(DECISIONS, this.next());
		this.traceTime += 60_000;
		const applied = this.state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: attempt,
			decision,
			decidedAt: new Date(this.traceTime).toISOString(),
		});
		if (applied) {
			const trace = ticket.traces.find((each) => each.attempt === attempt && !each.decided);
			if (trace !== undefined) trace.decided = true;
			ticket.owed = null;
			// The close, the abandon, and the route each end the cycle; the route
			// ends it only from the resting state.
			if (
				decision === "closed" ||
				decision === "auto-closed" ||
				decision === "abandoned" ||
				(decision === "handed-off" && ticket.state === "awaiting")
			) {
				ticket.state = "open";
				ticket.cycle += 1;
			}
		}
		this.note("decide", identity, `${decision} ${applied}`);
	}

	private reopen(identity: string): void {
		const ticket = this.ledger.get(identity) as TicketLedger;
		const attempt = ticket.owed;
		if (attempt === null) return;
		const reopened = this.state.ticketWorkCycle.reopenTurn(identity, attempt);
		if (reopened) {
			ticket.state = "running";
			ticket.pending = attempt;
			// The reopened turn settles again on the trace it already wrote, so the
			// cycle that trace stands on does not move.
			ticket.pendingCycle =
				ticket.traces.find((each) => each.attempt === attempt)?.cycle ?? ticket.cycle;
		}
		this.note("reopen", identity, String(reopened));
	}

	private closeCycle(identity: string): void {
		const ticket = this.ledger.get(identity) as TicketLedger;
		const closed = this.state.ticketWorkCycle.closeWorkCycle(identity);
		if (closed) {
			ticket.state = "open";
			ticket.cycle += 1;
		}
		this.note("close", identity, String(closed));
	}

	private fetch(): void {
		this.fetchTime += 5 * 60_000;
		const kept = TICKETS.filter(() => this.next() < 0.8);
		this.state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: new Date(this.fetchTime).toISOString(),
			tickets: kept.map((identity) =>
				this.next() < 0.3 ? { ...fetched(identity), labels: [] } : fetched(identity),
			),
		});
		this.note("fetch", "-", `${kept.length} of ${TICKETS.length}`);
	}

	private ignore(identity: string): void {
		const ignored = this.next() < 0.5;
		const result = this.state.ticketWorkCycle.setTicketIgnored(identity, ignored);
		this.note("ignore", identity, `${ignored} ${result.ok ? "ok" : result.reason}`);
	}

	private mute(): void {
		const muted = this.next() < 0.5;
		const result = this.state.sourceFact.setSourceMuted(sourceA.name, muted);
		this.note("mute", "-", `${muted} ${result.ok ? "ok" : result.reason}`);
	}

	/**
	 * The newest settled turn of one Ticket, in the order the trace table sorts
	 * by. The walk never deletes a trace, so its own insert count stands in for
	 * the table's rowid.
	 */
	private newestTrace(ticket: TicketLedger): TraceFact | null {
		let newest: TraceFact | null = null;
		for (const trace of ticket.traces)
			if (newest === null || traceOrderIsLater(trace, newest)) newest = trace;
		return newest;
	}

	/**
	 * The Held turn the pause would stand on, stated from the ledger: an
	 * undecided `failed` trace that is its Ticket's newest settled turn, on a
	 * Ticket resting `awaiting` on the cycle the trace belongs to (ADR 0016).
	 * `standDownClosedCycle` drops that last guard, which is how the walk counts
	 * the steps where the guard decides the pause.
	 */
	private ledgerHeldFailure(standDownClosedCycle = false): CompletionTraceOrder | null {
		let found: CompletionTraceOrder | null = null;
		for (const ticket of this.ledger.values()) {
			if (ticket.state !== "awaiting") continue;
			const newest = this.newestTrace(ticket);
			if (newest === null || newest.decided || newest.cause !== "failed") continue;
			if (!standDownClosedCycle && newest.cycle !== ticket.cycle) continue;
			if (found === null || traceOrderIsLater(newest, found)) found = newest;
		}
		return found;
	}

	/** The newest `completed` trace of every Ticket, stated from the ledger. */
	private ledgerNewestCompleted(): CompletionTraceOrder | null {
		let found: CompletionTraceOrder | null = null;
		for (const ticket of this.ledger.values())
			for (const trace of ticket.traces)
				if (trace.cause === "completed" && (found === null || traceOrderIsLater(trace, found)))
					found = trace;
		return found;
	}

	/** The invariant: a standing pause always has a row in front of it to answer. */
	private check(operation: Operation, identity: string, step: number): void {
		const heldFailure = this.ledgerHeldFailure();
		const expected = dispatchPauseHolds(heldFailure, this.ledgerNewestCompleted());
		const standing = this.state.ticketWorkCycle.dispatchPauseActive();
		// The one-way direction ADR 0016 keeps: a held failure stands on one
		// Ticket while a newer `completed` settle on another releases the pause.
		if (heldFailure !== null && !standing) this.releasedAwaySteps += 1;
		const withoutCycleGuard = dispatchPauseHolds(
			this.ledgerHeldFailure(true),
			this.ledgerNewestCompleted(),
		);
		if (withoutCycleGuard !== expected) this.closedCycleSteps += 1;
		if (standing !== expected) {
			throw new Error(
				`the pause disagreed with the walk's ledger: step ${step}, after ${operation} on ${identity}; the ledger held a failure at ${heldFailure?.completedAt ?? "none"} row ${heldFailure?.rowId ?? "-"} and expected the pause ${expected}\n${this.script.join("\n")}`,
			);
		}
		if (!standing) return;
		this.pauseSteps += 1;
		const held = this.state.ticketWorkCycle
			.ticketListViews([], "implement", "active")
			.rows.filter(holdsDecision);
		// The row the pause stands on is one of these: its Ticket rests
		// `awaiting`, its newest settled turn is an undecided `failed` trace, and
		// the active list shows it. A pause that stands with no such row is the
		// warning issue #351 reports - it holds every automatic start on a fact no
		// surface shows and no key answers.
		const answered = held.some((row: Ticket) => {
			const last = row.lastCompletion;
			return last !== null && last.cause === "failed" && last.decision === null;
		});
		if (held.length === 0 || !answered) {
			throw new Error(
				`the pause stood with no held row to answer it: step ${step}, after ${operation} on ${identity}\n${this.script.join("\n")}`,
			);
		}
	}

	private note(operation: string, identity: string, detail: string): void {
		this.script.push(`${operation} ${identity} ${detail}`);
	}
}
