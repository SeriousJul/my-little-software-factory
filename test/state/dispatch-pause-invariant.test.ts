/**
 * The Dispatch pause invariant walk (issue #351 review): the pause never stands
 * while the active Ticket list holds no row that can answer it.
 *
 * The single-case suites state one way a held `failed` trace stops standing
 * each. This walk drives the real aggregates with seeded random sequences of
 * the write path - Handoff claims and settles, settles with every cause,
 * completion decisions, reopens, cycle closes, source reads, ignores, and
 * source mutes - and asks the pause and the list after every operation.
 *
 * The guard the pause reads is per Ticket inside a read that spans every
 * Ticket, and the `held` badge is a per-Ticket read of its own, so the
 * cross-ticket sequences are what a later edit breaks first. The walk is the
 * regression guard for that: with the guard removed it goes red at step 33 of
 * its first sequence - a `failed` settle, then a second turn in the same cycle
 * that settles `truncated` - and it stays green on the read the plane ships.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { holdsDecision, type Ticket } from "../../src/domain/ticket.ts";
import { openFactoryState } from "../../src/state.ts";
import { choice, cleanup, fetched, sourceA, statePath, success, textLog } from "./harness.ts";

afterEach(cleanup);

/** The seed is fixed, so the counts this walk reports stand across runs. */
const SEED = 351;
const SEQUENCES = 300;
const OPERATIONS = 80;
/**
 * How many of the 24,000 steps this seed leaves with the pause standing. A walk
 * that never arms the pause it guards tests nothing, so the count is asserted:
 * an operation mix that stops exercising the pause is a walk that stopped
 * testing, and this line says so.
 */
const STEPS_WITH_THE_PAUSE_STANDING = 5038;

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

describe("the Dispatch pause invariant walk", () => {
	test("the pause never stands while the active Ticket list holds no row that answers it", () => {
		let pauseSteps = 0;
		for (let sequence = 0; sequence < SEQUENCES; sequence++) {
			const walk = new Walk(sequence);
			for (let step = 0; step < OPERATIONS; step++) walk.step(step);
			pauseSteps += walk.pauseSteps;
			walk.close();
		}
		expect(pauseSteps).toBe(STEPS_WITH_THE_PAUSE_STANDING);
	});
});

/** One seeded sequence of operations over one real state file. */
class Walk {
	pauseSteps = 0;

	private readonly next: () => number;
	/** The walk's own timeline: the state clock and the trace times move as one. */
	private traceTime = Date.parse("2026-08-31T10:00:00Z");
	private fetchTime = Date.parse("2026-08-31T10:00:30Z");
	private readonly state = openFactoryState(statePath(), () => this.traceTime);
	/** The turn this Ticket has claimed and started but not settled. */
	private readonly pending = new Map<string, string>();
	/** The newest undecided settled trace of this Ticket. */
	private readonly owed = new Map<string, string>();
	/** Every operation the walk ran, so a broken sequence reads back. */
	private readonly script: string[] = [];

	constructor(seed: number) {
		this.next = random(SEED + seed * 7919);
		this.state.sourceFact.initializeSources([sourceA]);
		this.state.sourceFact.applyFetch(sourceA, success(TICKETS.map(fetched)));
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
		if (this.pending.has(identity)) return;
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
		this.pending.set(identity, attempt);
		this.note("start", identity, origin);
	}

	private settle(identity: string): void {
		const attempt = this.pending.get(identity);
		if (attempt === undefined) return;
		const cause = pick(CAUSES, this.next());
		// The trace's time mostly moves forward, and now and then a settle lands
		// with an older stamp than the turn before it: which trace is a Ticket's
		// newest is the order the reads share, not the clock.
		this.traceTime += Math.floor(this.next() * 7) * 60_000 - (this.next() < 0.2 ? 180_000 : 0);
		this.state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: attempt,
			taskType: "implement",
			agentType: "pi",
			message: `the ${cause} turn`,
			turnLog: textLog(`the ${cause} turn`),
			completedAt: new Date(this.traceTime).toISOString(),
			cause,
			detail: "",
		});
		this.pending.delete(identity);
		this.owed.set(identity, attempt);
		this.note("settle", identity, cause);
	}

	private decide(identity: string): void {
		const attempt = this.owed.get(identity);
		if (attempt === undefined) return;
		const decision = pick(DECISIONS, this.next());
		this.traceTime += 60_000;
		const applied = this.state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: attempt,
			decision,
			decidedAt: new Date(this.traceTime).toISOString(),
		});
		if (applied) this.owed.delete(identity);
		this.note("decide", identity, `${decision} ${applied}`);
	}

	private reopen(identity: string): void {
		const attempt = this.owed.get(identity);
		if (attempt === undefined) return;
		const reopened = this.state.ticketWorkCycle.reopenTurn(identity, attempt);
		if (reopened) this.pending.set(identity, attempt);
		this.note("reopen", identity, String(reopened));
	}

	private closeCycle(identity: string): void {
		this.note("close", identity, String(this.state.ticketWorkCycle.closeWorkCycle(identity)));
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

	/** The invariant: a standing pause always has a row in front of it to answer. */
	private check(operation: Operation, identity: string, step: number): void {
		if (!this.state.ticketWorkCycle.dispatchPauseActive()) return;
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
