/**
 * Consumer-level tests for the domain.
 *
 * These assert what a consumer of the module can observe: the ticket state
 * machine's transitions. The sample data contract is not tested here. It is
 * observed through the rendered terminal frame in the app tests, the same
 * way an operator would see it.
 */
import { describe, expect, test } from "bun:test";
import type { Ticket, TicketState } from "../src/domain/ticket.ts";
import {
	attentionBand,
	automaticStartBlocked,
	type CompletionTraceOrder,
	canTransition,
	dispatchPauseHolds,
	flagWithholdsRow,
	type HoldTurnFact,
	handoffLimitReached,
	sameTypeHoldHolds,
	TICKET_STATES,
	type TicketIgnoreFacts,
	ticketListRank,
} from "../src/domain/ticket.ts";

/** The list rank's one input besides the state: the external update. */
function ticket(state: TicketState, externalUpdatedAt = "2026-01-01T00:00:00Z"): Ticket {
	return {
		identity: `github:github.com:I_${state}`,
		title: `the ${state} ticket`,
		repository: "acme/billing",
		repositoryRef: {
			identity: "github.com/acme/billing",
			displayName: "acme/billing",
			cloneUrl: "",
		},
		state,
		handoff: null,
		workCycle: 1,
		handoffCount: 0,
		failedStartStreak: 0,
		lastCompletion: null,
		description: "",
		sourceKind: "github-issue",
		externalKey: `#${state}`,
		sourceState: "open",
		url: "",
		labels: [],
		externalUpdatedAt,
		memberships: [],
		suggestedTaskType: "implement",
		actionable: state === "open",
		listActionable: state === "open",
		handoffRecoveryRequired: false,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
		nameCollision: null,
		matchedStateName: null,
	};
}

describe("the ticket state machine", () => {
	test("the state line is open, handed-off, running, awaiting", () => {
		expect(TICKET_STATES).toEqual(["open", "handed-off", "running", "awaiting"]);
	});

	test("the route ask ends the source's cycle at the ask (ADR 0072)", () => {
		// The ask moves the source to open with the cycle incremented, and the
		// wait stands on the Work queue's item, not on a ticket state.
		expect(canTransition("awaiting", "open")).toBe(true);
		// The route's start is the ticket's next cycle, so it starts from open
		// the way any handoff does.
		expect(canTransition("open", "handed-off")).toBe(true);
		// The ask never waits on a run: it does not hold the source in a wait
		// state.
		expect(canTransition("open", "awaiting")).toBe(false);
	});

	test("a work cycle walks open to handed-off to running to awaiting", () => {
		expect(canTransition("open", "handed-off")).toBe(true);
		expect(canTransition("handed-off", "running")).toBe(true);
		expect(canTransition("running", "awaiting")).toBe(true);
	});

	test("a settle may land directly from handed-off", () => {
		expect(canTransition("handed-off", "awaiting")).toBe(true);
	});

	test("close ends the work cycle back at open", () => {
		expect(canTransition("awaiting", "open")).toBe(true);
	});

	test("key w closes a cycle whose turn never settled (ADR 0031)", () => {
		expect(canTransition("handed-off", "open")).toBe(true);
		expect(canTransition("running", "open")).toBe(true);
	});

	test("a workflow handoff or restart continues the cycle from awaiting", () => {
		expect(canTransition("awaiting", "handed-off")).toBe(true);
	});

	test("the poll can move an awaiting ticket back to running", () => {
		// The agent works again on its still-pending turn: the poll reopens it
		// (ADR 0033 left the move to the poll, since Goto is navigation).
		expect(canTransition("awaiting", "running")).toBe(true);
	});

	test("transitions never move backward in the cycle", () => {
		expect(canTransition("open", "running")).toBe(false);
		expect(canTransition("open", "awaiting")).toBe(false);
		expect(canTransition("running", "handed-off")).toBe(false);
	});

	test("a state is not its own transition", () => {
		for (const state of TICKET_STATES) expect(canTransition(state, state)).toBe(false);
	});

	test("the attention band holds the in-flight band and the open band (ADR 0072)", () => {
		// The awaiting band holds only the turns that still owe a decision. A
		// routed ticket rests open behind the wait (ADR 0072), so it stands in
		// the open band with the rows it belongs to, not in the in-flight band.
		expect(attentionBand(ticket("awaiting"))).toBeLessThan(attentionBand(ticket("running")));
		expect(attentionBand(ticket("running"))).toBeLessThan(attentionBand(ticket("handed-off")));
		expect(attentionBand(ticket("handed-off"))).toBeLessThan(attentionBand(ticket("open")));
	});

	test("the open bands sort on the row's standing, not on the run's read (issue #345)", () => {
		// The boot leaves every source `loading`, and a config write-back leaves it
		// again: the machine's gate holds such a row, and the list's pile keeps it.
		// The band reads the row's own standing, so a read that has not answered
		// moves nothing, and only a read that failed does.
		const outstanding = { ...ticket("open"), actionable: false, listActionable: true };
		const failedRead = { ...ticket("open"), actionable: false, listActionable: false };
		expect(attentionBand(outstanding)).toBe(attentionBand(ticket("open")));
		expect(attentionBand(ticket("open"))).toBeLessThan(attentionBand(failedRead));
	});

	test("the list rank reads a routed ticket into the open band (ADR 0072)", () => {
		// The wait is the item's, not a ticket state, so the routed ticket ranks
		// among the open rows it belongs to, by the open band's external key
		// order, the way any open row does.
		expect(ticketListRank({ ...ticket("open"), externalKey: "#5" })).toBeLessThan(
			ticketListRank({ ...ticket("open"), externalKey: "#10" }),
		);
	});
});

describe("the automatic start gate (ADR 0060, widened by ADR 0070)", () => {
	/**
	 * The gate's own facts (issue #301). The observation loop hands the predicate a
	 * projected row and the work-cycle aggregate and the App hand it a Ticket, and
	 * none of them names the type, because the row carries the shape. The four
	 * facts the gate reads are stated here instead.
	 */
	function ignoreFacts(over: Partial<TicketIgnoreFacts> = {}): TicketIgnoreFacts {
		return { ignored: false, ignoredAt: null, muted: false, mutedAt: null, ...over };
	}

	test("the gate reads the four facts, and only the standing flags hold (issue #301)", () => {
		const facts: TicketIgnoreFacts = ignoreFacts();
		expect(Object.keys(facts).sort()).toEqual(["ignored", "ignoredAt", "muted", "mutedAt"]);
		expect(automaticStartBlocked(facts)).toBe(false);
		expect(automaticStartBlocked(ignoreFacts({ ignored: true }))).toBe(true);
		expect(automaticStartBlocked(ignoreFacts({ muted: true }))).toBe(true);
		// The moment a flag was set never holds on its own: the flag does.
		expect(automaticStartBlocked(ignoreFacts({ ignoredAt: "2026-01-02T00:00:00Z" }))).toBe(false);
		expect(automaticStartBlocked(ignoreFacts({ mutedAt: "2026-01-02T00:00:00Z" }))).toBe(false);
		// The row gate widens the same four facts with the row's own state.
		expect(flagWithholdsRow({ ...ignoreFacts({ ignored: true }), state: "open" })).toBe(true);
		expect(flagWithholdsRow({ ...ignoreFacts({ muted: true }), state: "open" })).toBe(true);
		expect(flagWithholdsRow({ ...ignoreFacts({ ignored: true }), state: "running" })).toBe(false);
	});

	test("the Ticket's own flag or a muted source blocks the machine's start", () => {
		// The Top-up walks ask this one predicate instead of restating the rule
		// at their own sites (issue #202), so the gate is tested on its facts.
		expect(automaticStartBlocked(ticket("open"))).toBe(false);
		expect(automaticStartBlocked({ ...ticket("open"), ignored: true })).toBe(true);
		expect(automaticStartBlocked({ ...ticket("open"), muted: true })).toBe(true);
		expect(automaticStartBlocked({ ...ticket("open"), ignored: true, muted: true })).toBe(true);
	});

	test("the gate reads the facts and never the row's face", () => {
		// A judged-out Ticket whose row the list reveals for its live work is
		// still no automatic start.
		for (const state of ["open", "handed-off", "running", "awaiting"] as const) {
			expect(automaticStartBlocked({ ...ticket(state), ignored: true })).toBe(true);
		}
	});

	test("a flag withholds a resting row and never a live one", () => {
		// The row leaves the list only where the Ticket rests; a Ticket with
		// work in flight or a decision owed keeps the row its controls hang from.
		expect(flagWithholdsRow({ ...ticket("open"), ignored: true })).toBe(true);
		expect(flagWithholdsRow({ ...ticket("open"), muted: true })).toBe(true);
		for (const state of ["handed-off", "running", "awaiting"] as const) {
			expect(flagWithholdsRow({ ...ticket(state), ignored: true })).toBe(false);
			expect(flagWithholdsRow({ ...ticket(state), muted: true })).toBe(false);
		}
		// An unflagged row stands whatever its state.
		for (const state of ["open", "handed-off", "running", "awaiting"] as const) {
			expect(flagWithholdsRow(ticket(state))).toBe(false);
		}
	});
});

describe("the Dispatch pause (ADR 0016)", () => {
	/** One completion trace, placed by its completion time and its row. */
	function trace(completedAt: string, rowId: number): CompletionTraceOrder {
		return { completedAt, rowId };
	}

	test("no held failure means no pause", () => {
		expect(dispatchPauseHolds(null, null)).toBe(false);
		expect(dispatchPauseHolds(null, trace("2026-01-03T00:00:00Z", 9))).toBe(false);
	});

	test("a held failure with nothing completed since it holds the pause", () => {
		expect(dispatchPauseHolds(trace("2026-01-03T00:00:00Z", 9), null)).toBe(true);
		expect(
			dispatchPauseHolds(trace("2026-01-04T00:00:00Z", 9), trace("2026-01-03T00:00:00Z", 8)),
		).toBe(true);
	});

	test("a completed turn newer than the held failure ends the pause", () => {
		expect(
			dispatchPauseHolds(trace("2026-01-03T00:00:00Z", 8), trace("2026-01-04T00:00:00Z", 9)),
		).toBe(false);
	});

	test("newer means the completion time and then the row", () => {
		// Two traces settled in the same instant: the later row is the newer
		// trace, so it is the one that can end the pause.
		expect(
			dispatchPauseHolds(trace("2026-01-03T00:00:00Z", 8), trace("2026-01-03T00:00:00Z", 9)),
		).toBe(false);
		expect(
			dispatchPauseHolds(trace("2026-01-03T00:00:00Z", 9), trace("2026-01-03T00:00:00Z", 8)),
		).toBe(true);
	});
});

describe("the Same-type hold (ADR 0026)", () => {
	/** One cycle end: the cause that ended it and the task type its turn ran. */
	function holdTurn(cause: string | null, taskType: string): HoldTurnFact {
		return { cause, taskType };
	}

	test("a completed cycle end of the suggested task type holds the repeat", () => {
		expect(sameTypeHoldHolds(holdTurn("completed", "implement"), "implement")).toBe(true);
	});

	test("a new signal ends the hold", () => {
		// The suggested task type changed, the cycle did not end completed, or
		// the ticket has no closed cycle yet.
		expect(sameTypeHoldHolds(holdTurn("completed", "implement"), "review")).toBe(false);
		expect(sameTypeHoldHolds(holdTurn("completed", "implement"), null)).toBe(false);
		expect(sameTypeHoldHolds(holdTurn("failed", "implement"), "implement")).toBe(false);
		expect(sameTypeHoldHolds(holdTurn("aborted", "implement"), "implement")).toBe(false);
		expect(sameTypeHoldHolds(holdTurn(null, "implement"), "implement")).toBe(false);
		expect(sameTypeHoldHolds(null, "implement")).toBe(false);
	});
});

describe("the Handoff limit (ADR 0005)", () => {
	test("a count under the cap leaves the gate open", () => {
		expect(handoffLimitReached(0, 10)).toBe(false);
		expect(handoffLimitReached(9, 10)).toBe(false);
	});

	test("the count that reaches the cap closes the gate", () => {
		// The cap counts started handoffs, so the ticket that has started exactly
		// the cap's worth gets no further automatic add.
		expect(handoffLimitReached(10, 10)).toBe(true);
		expect(handoffLimitReached(11, 10)).toBe(true);
	});

	test("the cap is the fact the config resolved, not a number the rule holds", () => {
		// The same count answers differently at different caps: the rule reads the
		// cap it is handed, so a config of one closes at one.
		expect(handoffLimitReached(1, 1)).toBe(true);
		expect(handoffLimitReached(1, 2)).toBe(false);
	});
});
