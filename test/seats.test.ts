/**
 * The one seat count the Parallel limit reads (ADR 0034): the ticket
 * seats, the unresolved claims, and the Consultation seats beside them,
 * all from one function. The gates, the cap gate, and the mode line read
 * this count, so the tests pin the count itself: the Consultation side in
 * particular, beside the ticket side it holds up.
 */
import { describe, expect, test } from "bun:test";
import { parallelSeatCount } from "../src/seats.ts";

const now = () => Date.parse("2026-08-31T10:00:00Z");
const started = "2026-08-31T09:59:00Z";

const liveTicket = {
	ticketIdentity: "github:github.com:I_5",
	paneId: "pane-1",
	startedAt: started,
};

describe("the Consultation side of the seat count", () => {
	test("the ticket's example: one live ticket and one working Consultation hold 2/2", () => {
		expect(
			parallelSeatCount({
				tickets: [liveTicket],
				openAttempts: [],
				consultationSeats: 1,
				agents: [{ paneId: "pane-1" }],
				now,
				startupGraceMs: 30_000,
			}),
		).toBe(2);
	});

	test("a Consultation holds its seat beside the unresolved claims", () => {
		// One ticket whose agent the poll lists and one ticket whose claim
		// is still open: the Consultation beside them fills the third seat.
		expect(
			parallelSeatCount({
				tickets: [liveTicket],
				openAttempts: ["github:github.com:I_6"],
				consultationSeats: 1,
				agents: [{ paneId: "pane-1" }],
				now,
				startupGraceMs: 30_000,
			}),
		).toBe(3);
	});

	test("a Consultation alone holds the seat before the first ticket", () => {
		expect(
			parallelSeatCount({
				tickets: [],
				openAttempts: [],
				consultationSeats: 1,
				agents: null,
				now,
				startupGraceMs: 30_000,
			}),
		).toBe(1);
	});

	test("each working Consultation holds its own seat beside the ticket seats", () => {
		// Two Consultations in working beside the listed ticket agent: the
		// Consultation side is a count of its own, added whole to the tickets'.
		expect(
			parallelSeatCount({
				tickets: [liveTicket],
				openAttempts: [],
				consultationSeats: 2,
				agents: [{ paneId: "pane-1" }],
				now,
				startupGraceMs: 30_000,
			}),
		).toBe(3);
	});

	test("a missing Consultation count holds at none, not below", () => {
		expect(
			parallelSeatCount({
				tickets: [],
				openAttempts: [],
				consultationSeats: -1,
				agents: null,
				now,
				startupGraceMs: 30_000,
			}),
		).toBe(0);
	});
});
