/**
 * The planeAction aggregate's own tests (issue #202): the start the control
 * plane runs on a Ticket, the count that adds it to the Agent's starts, and the
 * one fact the gate reads - a blocked start the source has not re-verified
 * since.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { TransitionOutcome } from "../../src/config.ts";
import { openFactoryState } from "../../src/state.ts";
import { choice, cleanup, fetched, sourceA, statePath, success } from "./harness.ts";

afterEach(cleanup);

const T5 = "github:github.com:I_5";

/** One Ticket the plane can act on, with its identity. */
function ticketState() {
	const state = openFactoryState(statePath());
	state.sourceFact.initializeSources([sourceA]);
	state.sourceFact.applyFetch(sourceA, success([fetched(T5)]));
	return state;
}

const outcomeOf = (identity: string): TransitionOutcome => ({
	fired: false,
	when: null,
	reason: "",
	ticketFacts: [],
	pullRequestFacts: [],
	autoAdvance: true,
	ticketWrite: null,
	pullRequestWrite: null,
	pullRequestIdentity: null,
	pullRequestKey: null,
	writeFailure: "",
	positionTaskType: "review",
	positionTicketIdentity: identity,
});

describe("the planeAction aggregate", () => {
	test("a recorded start reads back with the facts the plane wrote", () => {
		const state = ticketState();
		const attempt = state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "review",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "the branch does not merge",
			at: "2026-08-31T11:00:00Z",
		});
		const record = state.planeAction.latestPlaneActionAttempt(T5);
		expect(record).toEqual(
			expect.objectContaining({
				id: attempt.id,
				ticketIdentity: T5,
				taskType: "review",
				decision: "auto-merged",
				outcome: "blocked",
				reason: "the branch does not merge",
				at: "2026-08-31T11:00:00Z",
				transition: null,
			}),
		);
		state.close();
	});

	test("the start is durable factory state: a fresh open reads it back", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched(T5)]));
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "review",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: "2026-08-31T11:00:00Z",
		});
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.planeAction.planeActionAttemptCount(T5)).toBe(1);
		expect(reopened.planeAction.latestPlaneActionAttempt(T5)?.outcome).toBe("merged");
		reopened.close();
	});

	test("the newest start is the one the aggregate answers, and every start counts", () => {
		const state = ticketState();
		for (const at of ["2026-08-31T10:00:00Z", "2026-08-31T12:00:00Z", "2026-08-31T11:00:00Z"])
			state.planeAction.recordPlaneActionAttempt({
				ticketIdentity: T5,
				taskType: "review",
				decision: "auto-merged",
				outcome: "blocked",
				reason: "",
				at,
			});
		// The aggregate answers the newest start and the count of starts; the
		// record of every start a Ticket's action ran is not an answer a caller
		// takes (issue #202 review).
		expect(state.planeAction.planeActionAttemptCount(T5)).toBe(3);
		expect(state.planeAction.latestPlaneActionAttempt(T5)?.at).toBe("2026-08-31T12:00:00Z");
		state.close();
	});

	test("the outcome lands once: a second write to the same start moves nothing", () => {
		const state = ticketState();
		const attempt = state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "review",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "",
			at: "2026-08-31T11:00:00Z",
		});
		expect(state.planeAction.recordPlaneActionAttemptOutcome(attempt.id, outcomeOf(T5))).toBe(true);
		expect(state.planeAction.latestPlaneActionAttempt(T5)?.transition).not.toBeNull();
		expect(state.planeAction.recordPlaneActionAttemptOutcome(attempt.id, outcomeOf(T5))).toBe(
			false,
		);
		expect(state.planeAction.recordPlaneActionAttemptOutcome("0".repeat(36), outcomeOf(T5))).toBe(
			false,
		);
		state.close();
	});

	test("the count a Ticket carries adds the plane's starts to the Agent's starts", () => {
		const state = ticketState();
		expect(state.handoff.handoffCount(T5)).toBe(0);
		const claim = state.handoff.claimHandoff(T5, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "review",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: "2026-08-31T11:00:00Z",
		});
		expect(state.planeAction.planeActionAttemptCount(T5)).toBe(1);
		expect(state.handoff.handoffCount(T5)).toBe(2);
		// The projection carries the same number the count answers.
		const [ticket] = state.ticketWorkCycle.projectedTickets([], "implement");
		expect(ticket.handoffCount).toBe(2);
		state.close();
	});

	test("the count each Ticket carries answers every Ticket the file holds", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(
			sourceA,
			success([fetched("github:github.com:I_1"), fetched("github:github.com:I_2")]),
		);
		for (const at of ["2026-08-31T11:00:00Z", "2026-08-31T12:00:00Z"])
			state.planeAction.recordPlaneActionAttempt({
				ticketIdentity: "github:github.com:I_2",
				taskType: "review",
				decision: "auto-merged",
				outcome: "merged",
				reason: "",
				at,
			});
		// The projection reads every Ticket's count in one batch, so a Ticket
		// with no start and a Ticket with two both carry their own number.
		const rows = state.ticketWorkCycle.projectedTickets([], "implement");
		expect(rows.map((row) => [row.identity, row.handoffCount])).toEqual([
			["github:github.com:I_1", 0],
			["github:github.com:I_2", 2],
		]);
		expect(state.handoff.handoffCount("github:github.com:I_1")).toBe(0);
		expect(state.handoff.handoffCount("github:github.com:I_2")).toBe(2);
		state.close();
	});

	test("a blocked start reads as unrefreshed until the source is re-read after it", () => {
		const state = ticketState();
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "review",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "the branch does not merge",
			at: "2026-08-31T11:00:00Z",
		});
		// The last successful read of the Ticket's source (10:01) stands before
		// the blocked start (11:00): the gate holds.
		expect(state.planeAction.planeActionBlockedUnrefreshed(T5)).toBe(true);
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [fetched(T5)],
		});
		expect(state.planeAction.planeActionBlockedUnrefreshed(T5)).toBe(false);
		state.close();
	});

	test("a merged start, and a Ticket with no start, never read as unrefreshed", () => {
		const state = ticketState();
		expect(state.planeAction.planeActionBlockedUnrefreshed(T5)).toBe(false);
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "review",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: "2026-08-31T11:00:00Z",
		});
		expect(state.planeAction.planeActionBlockedUnrefreshed(T5)).toBe(false);
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "review",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "",
			at: "2026-08-31T11:10:00Z",
		});
		// The gate reads the newest start alone: the merged one no longer stands.
		expect(state.planeAction.planeActionBlockedUnrefreshed(T5)).toBe(true);
		state.close();
	});
});
