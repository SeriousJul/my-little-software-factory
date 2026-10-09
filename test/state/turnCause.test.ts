/**
 * The turn end cause and the Dispatch pause, read through the Ticket work
 * cycle aggregate that owns both (issue #202, re-homed from the flat state
 * suite): the cause a settled turn stores, the reads that fail open, and the
 * pause only a failed cause holds.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { holdsDecision } from "../../src/domain/ticket.ts";
import { openFactoryState } from "../../src/state.ts";
import { choice, cleanup, fetched, sourceA, statePath, success, textLog } from "./harness.ts";

afterEach(cleanup);

describe("the turn end cause and the Dispatch pause", () => {
	const t5 = "github:github.com:I_5";
	const t6 = "github:github.com:I_6";
	type State = ReturnType<typeof openFactoryState>;

	function twoTicketState(): State {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched(t5), fetched(t6)]));
		return state;
	}

	/** Hand a Ticket out and settle its turn, returning the attempt id. */
	function settleCause(
		state: State,
		identity: string,
		fields: {
			cause: "completed" | "failed" | "aborted" | "truncated" | "unknown";
			at: string;
			detail?: string;
		},
	): string {
		const { cause, at, detail = "" } = fields;
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "settled",
			turnLog: textLog("settled"),
			completedAt: at,
			cause,
			detail,
		});
		return claim.claim.attemptId;
	}

	test("a settled turn stores its cause and detail", () => {
		const state = twoTicketState();
		settleCause(state, t5, {
			cause: "failed",
			at: "2026-08-31T11:00:00Z",
			detail: "the context is too large",
		});
		const completion = state.ticketWorkCycle.lastCompletion(t5);
		expect(completion?.cause).toBe("failed");
		expect(completion?.detail).toBe("the context is too large");
		state.close();
	});

	test("a settled turn without a cause reads back as unknown, which fails open", () => {
		const state = twoTicketState();
		const claim = state.handoff.claimHandoff(t5, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: t5,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "settled",
			turnLog: textLog("settled"),
			completedAt: "2026-08-31T11:00:00Z",
		});
		const completion = state.ticketWorkCycle.lastCompletion(t5);
		expect(completion?.cause).toBe("unknown");
		expect(completion?.detail).toBe("");
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});

	test("a re-settle of the same pending turn overwrites its cause and detail", () => {
		const state = twoTicketState();
		const attempt = settleCause(state, t5, {
			cause: "failed",
			at: "2026-08-31T11:00:00Z",
			detail: "first failure",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: t5,
			handoffId: attempt,
			taskType: "implement",
			agentType: "pi",
			message: "recovered",
			turnLog: textLog("recovered"),
			completedAt: "2026-08-31T11:02:00Z",
			cause: "completed",
			detail: "",
		});
		const completion = state.ticketWorkCycle.lastCompletion(t5);
		expect(completion?.cause).toBe("completed");
		expect(completion?.message).toBe("recovered");
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});

	test("a legacy trace whose cause cell is NULL reads back as unknown", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched(t5)]));
		const claim = state.handoff.claimHandoff(t5, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: t5,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "settled",
			turnLog: textLog("settled"),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "failed",
		});
		state.close();
		// A pre-v9 trace: the cell the v9 step added is NULL, not a cause.
		const db = new Database(path);
		db.prepare("UPDATE completion_traces SET cause = NULL, detail = NULL").run();
		db.close();
		const reopened = openFactoryState(path);
		expect(reopened.ticketWorkCycle.lastCompletion(t5)?.cause).toBe("unknown");
		expect(reopened.ticketWorkCycle.lastCompletion(t5)?.detail).toBe("");
		expect(reopened.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		reopened.close();
	});

	test("a held failed trace pauses dispatch", () => {
		const state = twoTicketState();
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		settleCause(state, t5, { cause: "failed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		state.close();
	});

	test("a completed settle after the held failed ends the pause", () => {
		const state = twoTicketState();
		settleCause(state, t5, { cause: "failed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		settleCause(state, t6, { cause: "completed", at: "2026-08-31T11:05:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});

	test("a held failed settle after a completed one keeps the pause", () => {
		const state = twoTicketState();
		settleCause(state, t5, { cause: "completed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		settleCause(state, t6, { cause: "failed", at: "2026-08-31T11:05:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		state.close();
	});

	test("a decision on the held failed trace ends the pause", () => {
		const state = twoTicketState();
		const attempt = settleCause(state, t5, { cause: "failed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: t5,
				handoffId: attempt,
				decision: "closed",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});

	test("a failed turn whose Agent works again is no Held turn, and no longer pauses", () => {
		const state = twoTicketState();
		const attempt = settleCause(state, t5, { cause: "failed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		// The Agent reports working again: the turn reopens (ADR 0016), the row
		// leaves `awaiting` for `running`, and its `held` badge and its decision
		// surface leave with the state. The trace stays pending until the Agent
		// settles again, and no surface can land a decision on it.
		expect(state.ticketWorkCycle.reopenTurn(t5, attempt)).toBe(true);
		expect(state.ticketWorkCycle.ticketState(t5)).toBe("running");
		// The pause reads the newest Held turn, so with no Held turn standing it
		// stands down: the factory keeps dispatching while that Agent works.
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});

	test("the reopened turn's next failed settle pauses again", () => {
		const state = twoTicketState();
		const attempt = settleCause(state, t5, { cause: "failed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.reopenTurn(t5, attempt)).toBe(true);
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		// The same turn settles failed again: it rests held in `awaiting`, and the
		// pause stands on it exactly as it did on the first settle.
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: t5,
			handoffId: attempt,
			taskType: "implement",
			agentType: "pi",
			message: "failed again",
			turnLog: textLog("failed again"),
			completedAt: "2026-08-31T11:05:00Z",
			cause: "failed",
			detail: "Connection error.",
		});
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		state.close();
	});

	test("the operator's close of a failed turn's cycle does not keep the pause", () => {
		const state = twoTicketState();
		const attempt = settleCause(state, t5, { cause: "failed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.reopenTurn(t5, attempt)).toBe(true);
		// The operator closes the in-flight cycle (ADR 0031). The pending trace
		// stays undecided - the close ends the cycle, it lands no decision - and
		// the Ticket rests `open` in the next cycle, where no surface offers that
		// trace a decision. A pause that kept reading it would have no release.
		expect(state.ticketWorkCycle.closeWorkCycle(t5)).toBe(true);
		expect(state.ticketWorkCycle.ticketState(t5)).toBe("open");
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});

	test("a failed turn the Ticket's next turn supersedes no longer pauses", () => {
		const state = twoTicketState();
		const first = settleCause(state, t5, { cause: "failed", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		// The Agent reports working again: the turn reopens, the row leaves
		// `awaiting` for `running`, and the pause stands down (issue #338).
		expect(state.ticketWorkCycle.reopenTurn(t5, first)).toBe(true);
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		// The missing Agent's restart starts a second turn in the same cycle, and
		// its settle reads no session record: the cause fails open to `unknown`.
		const restart = state.handoff.claimHandoff(t5, choice, "restart");
		if (!restart.ok) throw new Error(restart.reason);
		state.handoff.settleHandoff(restart.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: t5,
			handoffId: restart.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "the restarted turn",
			turnLog: textLog("the restarted turn"),
			completedAt: "2026-08-31T11:05:00Z",
			cause: "unknown",
			detail: "",
		});
		// The row wears no `held` badge: the Ticket's newest turn ended `unknown`,
		// which fails open. The older undecided `failed` trace is no longer the
		// decision the operator owes, so it answers no Held turn: the pause and the
		// badge agree, and the factory keeps dispatching (ADR 0016, issue #351).
		const listed = state.ticketWorkCycle.ticketListViews([], "implement", "active").rows;
		expect(listed.filter(holdsDecision)).toHaveLength(0);
		expect(state.ticketWorkCycle.lastCompletion(t5)?.cause).toBe("unknown");
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});

	test("only a failed cause pauses: aborted and truncated hold but do not pause", () => {
		const state = twoTicketState();
		settleCause(state, t5, { cause: "aborted", at: "2026-08-31T11:00:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		settleCause(state, t6, { cause: "truncated", at: "2026-08-31T11:01:00Z" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});
});
