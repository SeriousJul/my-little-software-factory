/**
 * The shared Parallel limit seat count (issue #87, ADR 0034): the one source
 * the automatic start gates and the mode cell read. A seat is held by an
 * in-flight ticket whose agent the poll listed or that is still inside its
 * startup grace, by every in-progress handoff, and by every Consultation in
 * opening or working.
 *
 * The rule takes its facts as data (issue #202), so the test states the facts
 * and never opens a state file.
 */
import { describe, expect, test } from "bun:test";
import type { HerdrAgent } from "../src/herdr.ts";
import {
	overParallelLimit,
	type ParallelSeatConsultationFact,
	type ParallelSeatFacts,
	type ParallelSeatTicketFact,
	parallelSeatCount,
} from "../src/parallel.ts";

const NOW = Date.parse("2026-08-31T11:00:00Z");
const GRACE = 30_000;
/** When the ticket's agent started: ten seconds before the pinned clock. */
const STARTED_AT = "2026-08-31T10:59:50Z";

/** The facts of one in-flight ticket, on the pinned clock. */
function ticketFact(
	identity: string,
	paneId: string | null,
	agentName: string,
): ParallelSeatTicketFact {
	return { ticketIdentity: identity, paneId, startedAt: STARTED_AT, agentName };
}

/** The seat facts: the empty defaults, plus whatever the test names. */
function facts(over: Partial<ParallelSeatFacts> = {}): ParallelSeatFacts {
	return {
		tickets: [],
		handoffAttemptTickets: [],
		consultations: [],
		agents: [],
		now: NOW,
		startupGraceMs: GRACE,
		...over,
	};
}

/** One Consultation's fact, as the rule reads it. */
function consultationFact(
	state: ParallelSeatConsultationFact["state"],
): ParallelSeatConsultationFact {
	return { state };
}

/** The agent list's entry for one pane, under the given name. */
function listed(paneId: string, name: string): HerdrAgent {
	return {
		paneId,
		tabId: "tab-1",
		workspaceId: "ws-1",
		name,
		agent: "pi",
		status: "working",
		sessionId: "",
	};
}

const OWN_NAME = "persist-source-facts";

describe("parallelSeatCount", () => {
	test("holds a seat for an in-flight ticket whose agent the poll listed", () => {
		const own = ticketFact("github:github.com:I_5", "pane-5", OWN_NAME);
		expect(parallelSeatCount(facts({ tickets: [own], agents: [listed("pane-5", OWN_NAME)] }))).toBe(
			1,
		);
		// The same poll without the pane: the started agent is inside its
		// startup grace, so it still holds the seat.
		expect(parallelSeatCount(facts({ tickets: [own], agents: [] }))).toBe(1);
		// A started agent with no stored pane holds its in-progress seat
		// the same way.
		expect(
			parallelSeatCount(facts({ tickets: [ticketFact("github:github.com:I_5", null, OWN_NAME)] })),
		).toBe(1);
	});

	test("releases the seat of a missing agent past the startup grace", () => {
		const own = ticketFact("github:github.com:I_5", "pane-5", OWN_NAME);
		// The poll lists an agent in another pane, so the ticket's own agent is
		// missing: past the grace, a started agent with no live pane holds no
		// seat.
		expect(
			parallelSeatCount(
				facts({ tickets: [own], agents: [listed("pane-other", OWN_NAME)], now: NOW + GRACE + 1 }),
			),
		).toBe(0);
	});

	test("releases the seat of a ticket whose pane holds a foreign agent", () => {
		const own = ticketFact("github:github.com:I_5", "pane-5", OWN_NAME);
		// Herdr handed the closed pane's id out again: another agent works
		// in the ticket's pane. The ticket's own agent is gone, so past the
		// startup grace the ticket holds no seat for it, the way a missing
		// agent holds none.
		const foreign = listed("pane-5", "some-other-agent");
		// Inside the startup grace the ticket still boots, so it keeps the
		// seat.
		expect(parallelSeatCount(facts({ tickets: [own], agents: [foreign] }))).toBe(1);
		expect(
			parallelSeatCount(facts({ tickets: [own], agents: [foreign], now: NOW + GRACE + 1 })),
		).toBe(0);
		// The ticket's own agent in the pane holds the seat.
		expect(
			parallelSeatCount(
				facts({ tickets: [own], agents: [listed("pane-5", OWN_NAME)], now: NOW + GRACE + 1 }),
			),
		).toBe(1);
	});

	test("counts an in-progress handoff once, even for a counted ticket", () => {
		expect(parallelSeatCount(facts({ handoffAttemptTickets: ["github:github.com:I_6"] }))).toBe(1);
		// A claimed handoff whose ticket also holds a listed seat is one
		// seat, not two.
		const own = ticketFact("github:github.com:I_5", "pane-5", OWN_NAME);
		const ownAgent = [listed("pane-5", OWN_NAME)];
		expect(
			parallelSeatCount(
				facts({
					tickets: [own],
					handoffAttemptTickets: ["github:github.com:I_5"],
					agents: ownAgent,
				}),
			),
		).toBe(1);
		// A second ticket's claim adds its own seat.
		expect(
			parallelSeatCount(
				facts({
					tickets: [own],
					handoffAttemptTickets: ["github:github.com:I_6"],
					agents: ownAgent,
				}),
			),
		).toBe(2);
	});

	test("holds a seat for opening and working Consultations, and for no other state", () => {
		expect(
			parallelSeatCount(
				facts({ consultations: [consultationFact("opening"), consultationFact("working")] }),
			),
		).toBe(2);
		for (const other of ["awaiting-response", "missing", "failed", "closing", "closed"] as const) {
			expect(parallelSeatCount(facts({ consultations: [consultationFact(other)] }))).toBe(0);
		}
	});

	test("combines the ticket and Consultation seats into one count", () => {
		// The mode cell's own example: one live ticket and one working
		// Consultation read 2 against a cap of 2.
		expect(
			parallelSeatCount(
				facts({
					tickets: [ticketFact("github:github.com:I_5", "pane-5", OWN_NAME)],
					consultations: [consultationFact("working")],
					agents: [listed("pane-5", OWN_NAME)],
				}),
			),
		).toBe(2);
	});

	test("before the first successful poll only booting, in-progress, and Consultation seats count", () => {
		const own = ticketFact("github:github.com:I_5", "pane-5", OWN_NAME);
		const working = [consultationFact("working")];
		// No agent list yet: the ticket holds its booting seat and the
		// Consultation holds its state seat.
		expect(parallelSeatCount(facts({ tickets: [own], consultations: working, agents: null }))).toBe(
			2,
		);
		// Past the grace with no live pane: the ticket drops its seat, and
		// the Consultation's seat alone remains.
		expect(
			parallelSeatCount(
				facts({ tickets: [own], consultations: working, agents: null, now: NOW + GRACE + 1 }),
			),
		).toBe(1);
	});

	test("the cap gate reads the limit and the count, and a lifted limit never reads over", () => {
		// The four force-dispatch sites and the mode cell's start-now ask this one
		// rule instead of each restating `limit > 0 && count >= limit` (issue #202).
		expect(overParallelLimit(0, 0)).toBe(false);
		expect(overParallelLimit(0, 40)).toBe(false);
		expect(overParallelLimit(2, 0)).toBe(false);
		expect(overParallelLimit(2, 1)).toBe(false);
		// At the limit the seat a start wants is not free.
		expect(overParallelLimit(2, 2)).toBe(true);
		expect(overParallelLimit(2, 3)).toBe(true);
		// The two compose the way the pickup and the force-dispatch compose them:
		// one ticket seat under a limit of one is a start that has to wait.
		expect(
			overParallelLimit(
				1,
				parallelSeatCount(
					facts({
						tickets: [ticketFact("github:github.com:I_5", "pane-5", OWN_NAME)],
						agents: [listed("pane-5", OWN_NAME)],
					}),
				),
			),
		).toBe(true);
	});
});
