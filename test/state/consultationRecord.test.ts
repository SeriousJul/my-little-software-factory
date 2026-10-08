/**
 * The consultationRecord aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { workQueueIdentityOf } from "../../src/state/work-queue.ts";
import type { FactoryState } from "../../src/state.ts";
import { openFactoryState } from "../../src/state.ts";
import { cleanup, enqueue, queuedConsultation, repository, statePath, uid } from "./harness.ts";

afterEach(cleanup);

/** The aggregate over a real state file, for the durable-history tests. */
function makeState(): FactoryState {
	return openFactoryState(statePath());
}

/** A file-backed state plus its path, for restart tests. */
function makeStateFile(): { state: FactoryState; path: string } {
	const path = statePath();
	return { state: openFactoryState(path), path };
}

/** A started Consultation with the facts the durable tests read. */
function createConsultation(state: FactoryState, id = "consultation-1") {
	return state.consultationRecord.createConsultation({
		id,
		typeName: "grill-with-docs",
		agentType: "pi",
		environment: "worktree",
		model: "",
		thinking: "",
		contextWindow: "",
		template: "/skill:grill-with-docs {input}",
		initialInput: "Review this repository",
		renderedOpeningPrompt: "/skill:grill-with-docs Review this repository",
		repository,
		agentName: "consultation-11111111",
		createdAt: "2026-09-01T00:00:00.000Z",
	});
}

describe("the consultationRecord aggregate", () => {
	test("beginConsultationStart moves a queued record to opening, and nothing else", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		expect(state.consultationRecord.beginConsultationStart(consultation.id)).toBe(true);
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("opening");
		// The claim took the pointer in the same write: the queue is empty, and
		// the move ran once - a second pickup of the same record is refused, so
		// two loops cannot start one Consultation twice.
		expect(state.workQueue.items()).toHaveLength(0);
		expect(state.consultationRecord.beginConsultationStart(consultation.id)).toBe(false);
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("opening");
		// A record that left the queue's wait before the pickup ran starts
		// nothing.
		const opening = state.consultationRecord.createConsultation({
			id: uid("o"),
			typeName: "grill",
			agentType: "pi",
			environment: "worktree",
			template: "/grill {input}",
			initialInput: "review auth",
			renderedOpeningPrompt: "/grill review auth",
			repository,
			agentName: "consultation-o",
			createdAt: "2026-09-19T23:02:00.000Z",
		});
		expect(state.consultationRecord.beginConsultationStart(opening.id)).toBe(false);
	});
	test("updateConsultationTypeSettings re-reads the type, and the input never changes", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		expect(
			state.consultationRecord.updateConsultationTypeSettings(consultation.id, {
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
			}),
		).toBe(true);
		const updated = state.consultationRecord.consultation(consultation.id);
		expect(updated).toEqual(
			expect.objectContaining({
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
				initialInput: "review auth",
				state: "queued",
			}),
		);
	});
	test("updateConsultationTypeSettings touches a queued record only", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		// The record left the wait before the pickup's write reached it: a
		// close or a claim that won the race keeps its settings untouched.
		expect(state.consultationRecord.beginConsultationStart(consultation.id)).toBe(true);
		const opening = state.consultationRecord.consultation(consultation.id);
		expect(
			state.consultationRecord.updateConsultationTypeSettings(consultation.id, {
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
			}),
		).toBe(false);
		expect(state.consultationRecord.consultation(consultation.id)).toEqual(opening);
	});
	test("every write that ends a record's wait takes its pointer out of the queue", () => {
		const state = openFactoryState(":memory:");
		const claimed = queuedConsultation(state, uid("a"));
		const closed = queuedConsultation(state, uid("b"));
		const deleted = queuedConsultation(state, uid("c"));
		expect(state.workQueue.items()).toHaveLength(3);
		// The pickup's seat: the claim and the pointer's removal are one write,
		// so no cycle that dies between them leaves an item behind.
		expect(state.consultationRecord.beginConsultationStart(claimed.id)).toBe(true);
		// The pointer's removal repacks the places behind it, the way every
		// other removal does: the queue never holds a number it does not use.
		expect(state.workQueue.items().map((item) => item.position)).toEqual([0, 1]);
		// The close: the operator abandoned the ask, so its item goes with it.
		expect(state.consultationRecord.beginConsultationClose(closed.id)).toBe(true);
		state.consultationRecord.finishConsultationClose(closed.id);
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([deleted.id]);
		expect(state.workQueue.items().map((item) => item.position)).toEqual([0]);
		// The delete of a record whose pointer outlived it takes that pointer
		// too: the queue never lists an item that names no record.
		expect(state.consultationRecord.beginConsultationClose(deleted.id)).toBe(true);
		state.consultationRecord.finishConsultationClose(deleted.id);
		expect(state.consultationRecord.deleteConsultation(deleted.id)).toBe(true);
		expect(state.workQueue.items()).toHaveLength(0);
	});
	test("removing the queue item unschedules the record, and the other record's item stands across a restart", () => {
		const path = statePath();
		const state = openFactoryState(path);
		const consultation = queuedConsultation(state, uid("q"));
		expect(state.consultationRecord.removeConsultationWorkItem(consultation.id)).toBe(true);
		// The item goes, and the still-`queued` record moves to `unscheduled`
		// in the same write: the ask stands behind the pointer it loses, listed
		// in the Consultation section with its type, repository, and input.
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("unscheduled");
		expect(state.consultationRecord.removeConsultationWorkItem(consultation.id)).toBe(false);
		const second = queuedConsultation(state, uid("s"));
		state.close();

		const again = openFactoryState(path);
		expect(again.workQueue.items()).toHaveLength(1);
		expect(again.workQueue.items()[0]).toEqual(
			expect.objectContaining({ kind: "consultation", consultationId: second.id }),
		);
		expect(again.consultationRecord.consultation(second.id)?.state).toBe("queued");
		expect(again.consultationRecord.consultation(consultation.id)?.state).toBe("unscheduled");
		again.close();
	});
	test("a removal through the pickup's seam never unschedules a record that left the wait", () => {
		const state = openFactoryState(":memory:");
		const claimed = queuedConsultation(state, uid("a"));
		// The pickup won the race: the record is opening, so the item removal
		// that follows the answer takes the pointer only and leaves the
		// record's state standing.
		expect(state.consultationRecord.beginConsultationStart(claimed.id)).toBe(true);
		expect(state.consultationRecord.removeConsultationWorkItem(claimed.id)).toBe(false);
		expect(state.consultationRecord.consultation(claimed.id)?.state).toBe("opening");
	});
	test("scheduling an unscheduled Consultation puts it back at the queue's tail", () => {
		const state = openFactoryState(":memory:");
		const waiting = queuedConsultation(state, uid("w"));
		// The record leaves the queue first: the item is gone, the record is
		// unscheduled, and a handoff item holds the front of the queue.
		expect(state.consultationRecord.removeConsultationWorkItem(waiting.id)).toBe(true);
		const unscheduled = state.consultationRecord.consultation(waiting.id);
		expect(unscheduled?.state).toBe("unscheduled");
		expect(unscheduled).toBeDefined();
		enqueue(state, "github:github.com:I_s");
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["github:github.com:I_s"]);
		// The schedule returns the record to `queued` with its item at the
		// tail, behind the handoff item, in one write.
		expect(state.consultationRecord.scheduleConsultation(waiting.id)).toEqual({ ok: true });
		expect(state.consultationRecord.consultation(waiting.id)?.state).toBe("queued");
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([
			"github:github.com:I_s",
			waiting.id,
		]);
	});
	test("the schedule reaches an unscheduled record only", () => {
		const state = openFactoryState(":memory:");
		const queued = queuedConsultation(state, uid("q"));
		expect(state.consultationRecord.scheduleConsultation(queued.id)).toEqual({
			ok: false,
			reason: `consultation ${queued.id} already has a waiting queue item`,
		});
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([queued.id]);
		expect(state.consultationRecord.consultation(queued.id)?.state).toBe("queued");
		// A record that was never unscheduled has nothing to schedule either.
		expect(state.consultationRecord.scheduleConsultation("unknown")).toEqual({
			ok: false,
			reason: "the Consultation is not unscheduled",
		});
		expect(state.workQueue.items()).toHaveLength(1);
	});
	test("an unscheduled Consultation takes its seat in the atomic start, without a queue item", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		expect(state.consultationRecord.removeConsultationWorkItem(consultation.id)).toBe(true);
		// The start-now over the cap runs the same claim as the pickup: the
		// move to `opening` reaches the `unscheduled` record, and the second
		// start of the same record is refused.
		expect(state.consultationRecord.beginConsultationStart(consultation.id)).toBe(true);
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("opening");
		expect(state.workQueue.items()).toHaveLength(0);
		expect(state.consultationRecord.beginConsultationStart(consultation.id)).toBe(false);
		// The settings re-read reaches the `unscheduled` record the same way.
		const again = queuedConsultation(state, uid("u"));
		expect(state.consultationRecord.removeConsultationWorkItem(again.id)).toBe(true);
		expect(
			state.consultationRecord.updateConsultationTypeSettings(again.id, {
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
			}),
		).toBe(true);
	});
});

describe("durable Consultation lifecycle", () => {
	test("stores turns, snapshots, old drafts, partial output, and replacement context", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "workspace-1",
			sessionId: "session-1",
		});
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("working");
		expect(
			state.consultationRecord.settleConsultationTurn(consultation.id, 1, "first answer", {
				settledStatus: "idle",
			}),
		).toBe(true);
		state.consultationRecord.setConsultationDraft(consultation.id, "draft response");
		// A response is a durable pending delivery until Herdr accepts it.
		const pending = state.consultationRecord.beginConsultationResponse(
			consultation.id,
			"second question",
			1,
		);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("awaiting-response");
		expect(state.consultationRecord.consultationTurns(consultation.id)).toHaveLength(1);
		state.consultationRecord.setConsultationDraft(consultation.id, "old draft", true);
		const turn = state.consultationRecord.acceptConsultationResponse(consultation.id, pending.id);
		expect(turn).toMatchObject({ input: "second question", sequenceBaseline: 1 });
		// The Consultation is working after accepting its own second turn.
		expect(
			state.consultationRecord.settleConsultationTurn(consultation.id, 2, "second answer", {
				settledStatus: "blocked",
			}),
		).toBe(true);
		const stored = state.consultationRecord.consultation(consultation.id);
		expect(stored).toMatchObject({ state: "awaiting-response", latestSequence: 2, draft: "" });
		expect(state.consultationRecord.consultationSnapshots(consultation.id)).toHaveLength(2);
		expect(state.consultationRecord.consultationTurns(consultation.id)).toHaveLength(2);
		expect(state.consultationRecord.replacementInput(consultation.id)).toContain("Original input:");
		expect(state.consultationRecord.replacementInput(consultation.id)).toContain(
			"Operator response:\nsecond question",
		);
		expect(state.consultationRecord.replacementInput(consultation.id)).not.toContain(
			"Operator response:\nReview this repository",
		);
		state.consultationRecord.captureConsultationPartial(consultation.id, "partial 😀 output");
		expect(
			state.consultationRecord
				.consultationSnapshots(consultation.id)
				.some((snapshot) => snapshot.partial),
		).toBe(true);
		state.close();
	});

	test("keeps at most one pending response and accepts only its id", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.consultationRecord.settleConsultationTurn(consultation.id, 1, "answer");
		const first = state.consultationRecord.beginConsultationResponse(consultation.id, "a", 1);
		expect(first).toBeDefined();
		if (first === undefined) throw new Error("pending delivery missing");
		expect(
			state.consultationRecord.beginConsultationResponse(consultation.id, "b", 1),
		).toBeUndefined();
		expect(
			state.consultationRecord.acceptConsultationResponse(consultation.id, "some-other-id"),
		).toBeUndefined();
		expect(state.consultationRecord.consultation(consultation.id)?.pendingResponse?.id).toBe(
			first.id,
		);
		expect(
			state.consultationRecord.acceptConsultationResponse(consultation.id, first.id),
		).toBeDefined();
		expect(state.consultationRecord.consultation(consultation.id)?.pendingResponse).toBeNull();
		expect(state.consultationRecord.consultationTurns(consultation.id)).toHaveLength(2);
		state.close();
	});

	test("adopts the pending input when the Agent settles the turn externally", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.consultationRecord.settleConsultationTurn(consultation.id, 1, "first answer");
		const pending = state.consultationRecord.beginConsultationResponse(
			consultation.id,
			"second question",
			1,
		);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		expect(state.consultationRecord.recordExternalConsultationTurn(consultation.id, 2)).toBe(true);
		const turns = state.consultationRecord.consultationTurns(consultation.id);
		expect(turns).toHaveLength(2);
		expect(turns[1]).toMatchObject({ input: "second question", sequenceBaseline: 1 });
		expect(state.consultationRecord.consultation(consultation.id)?.pendingResponse).toBeNull();
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("working");
		// The delivery is consumed exactly once: a later accept is a no-op.
		expect(
			state.consultationRecord.acceptConsultationResponse(consultation.id, pending.id),
		).toBeUndefined();
		state.close();
	});

	test("ignores an external turn for a consultation that does not exist", () => {
		const state = makeState();
		expect(state.consultationRecord.recordExternalConsultationTurn("no-such-consultation", 1)).toBe(
			false,
		);
		state.close();
	});

	test("ignores an external turn while the Agent works on a response", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.consultationRecord.settleConsultationTurn(consultation.id, 1, "answer");
		const pending = state.consultationRecord.beginConsultationResponse(
			consultation.id,
			"second question",
			1,
		);
		if (pending === undefined) throw new Error("pending delivery missing");
		state.consultationRecord.acceptConsultationResponse(consultation.id, pending.id);
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("working");
		expect(state.consultationRecord.recordExternalConsultationTurn(consultation.id, 2)).toBe(false);
		state.close();
	});

	test("preserves a draft when a pending delivery is rejected", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.consultationRecord.settleConsultationTurn(consultation.id, 1, "answer");
		state.consultationRecord.setConsultationDraft(consultation.id, "follow up");
		const pending = state.consultationRecord.beginConsultationResponse(
			consultation.id,
			"follow up",
			1,
		);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		// The Consultation still waits for its response; no turn was committed.
		expect(state.consultationRecord.consultation(consultation.id)).toMatchObject({
			state: "awaiting-response",
			draft: "follow up",
		});
		expect(state.consultationRecord.consultationTurns(consultation.id)).toHaveLength(1);
		expect(state.consultationRecord.cancelConsultationResponse(consultation.id, pending.id)).toBe(
			true,
		);
		expect(state.consultationRecord.consultation(consultation.id)).toMatchObject({
			state: "awaiting-response",
			draft: "follow up",
		});
		expect(state.consultationRecord.consultation(consultation.id)?.pendingResponse).toBeNull();
		expect(state.consultationRecord.cancelConsultationResponse(consultation.id, pending.id)).toBe(
			false,
		);
		state.close();
	});

	test("keeps a failed opening immutable and recoverable only while opening", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("opening");
		expect(state.consultationRecord.canRecoverConsultationOpening(consultation.id)).toBe(true);
		state.consultationRecord.failConsultationOpening(consultation.id, "herdr refused the launch");
		expect(state.consultationRecord.consultation(consultation.id)).toMatchObject({
			state: "failed",
			failure: "herdr refused the launch",
		});
		expect(state.consultationRecord.canRecoverConsultationOpening(consultation.id)).toBe(false);
		// A failed record cannot resume work; only close-family moves remain.
		expect(state.consultationRecord.setConsultationState(consultation.id, "opening")).toBe(false);
		expect(state.consultationRecord.setConsultationState(consultation.id, "working")).toBe(false);
		expect(
			state.consultationRecord.setConsultationState(consultation.id, "awaiting-response"),
		).toBe(false);
		expect(state.consultationRecord.setConsultationState(consultation.id, "closing")).toBe(true);
		state.close();
	});

	test("backs up a missing snapshot on a later successful read", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		// The first poll saw the Agent settle before any output was captured.
		expect(
			state.consultationRecord.settleConsultationTurn(consultation.id, 1, null, {
				settledStatus: "idle",
			}),
		).toBe(true);
		expect(state.consultationRecord.consultationNeedsSnapshot(consultation.id)).toBe(true);
		expect(state.consultationRecord.fillConsultationSnapshot(consultation.id, "late output")).toBe(
			true,
		);
		expect(state.consultationRecord.consultationNeedsSnapshot(consultation.id)).toBe(false);
		const snapshots = state.consultationRecord.consultationSnapshots(consultation.id);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].text).toBe("late output");
		// A second backfill has nothing left to fill.
		expect(state.consultationRecord.fillConsultationSnapshot(consultation.id, "again")).toBe(false);
		state.close();
	});

	test("records remaining resources on a forced close", () => {
		const state = makeState();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "workspace-1",
		});
		state.consultationRecord.recordConsultationResource(consultation.id, {
			kind: "pane",
			resourceId: "pane-1",
			owned: true,
			details: "consultation pane",
		});
		state.consultationRecord.recordConsultationResource(consultation.id, {
			kind: "worktree",
			resourceId: "worktree-1",
			owned: true,
			details: "/tmp/worktree-1",
		});
		state.consultationRecord.beginConsultationClose(consultation.id);
		state.consultationRecord.finishConsultationClose(
			consultation.id,
			"forced close; owned resources were not confirmed closed",
			true,
		);
		expect(state.consultationRecord.consultation(consultation.id)?.state).toBe("closed");
		expect(state.consultationRecord.consultationRemainingResources(consultation.id)).toMatchObject([
			{ kind: "pane", resourceId: "pane-1" },
			{ kind: "worktree", resourceId: "worktree-1" },
		]);
		// A normal close leaves no remaining resources.
		const other = createConsultation(state, "consultation-2");
		state.consultationRecord.setConsultationAgent(other.id, { paneId: "pane-2" });
		state.consultationRecord.recordConsultationResource(other.id, {
			kind: "pane",
			resourceId: "pane-2",
			owned: true,
			details: "consultation pane",
		});
		state.consultationRecord.beginConsultationClose(other.id);
		state.consultationRecord.finishConsultationClose(other.id);
		expect(state.consultationRecord.consultation(other.id)?.state).toBe("closed");
		expect(state.consultationRecord.consultationRemainingResources(other.id)).toEqual([]);
		state.close();
	});

	describe("the Consultation turn end cause", () => {
		function working(state: FactoryState, id = "consultation-1") {
			const consultation = createConsultation(state, id);
			state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
			return consultation.id;
		}

		test("a failed turn rests it awaiting the response, named for recovery", () => {
			const state = makeState();
			const id = working(state);
			expect(
				state.consultationRecord.settleConsultationTurn(id, 1, "boom", {
					settledStatus: "idle",
					capturedAt: "2026-09-01T00:01:00Z",
					cause: "failed",
					detail: "the API rejected the request",
				}),
			).toBe(true);
			// The turn is not an answer, but the Agent is alive: the Consultation
			// rests where it can be answered or closed, not the terminal line, and
			// it names the cause so the failure is not silent.
			expect(state.consultationRecord.consultation(id)?.state).toBe("awaiting-response");
			expect(state.consultationRecord.consultation(id)?.warning).toBe(
				"Turn ended failed: the API rejected the request",
			);
			const turn = state.consultationRecord.consultationTurns(id)[0];
			expect(turn.cause).toBe("failed");
			expect(turn.detail).toBe("the API rejected the request");
			state.close();
		});

		test("an aborted turn rests it awaiting the response, named for recovery", () => {
			const state = makeState();
			const id = working(state);
			expect(
				state.consultationRecord.settleConsultationTurn(id, 1, "", {
					settledStatus: "idle",
					capturedAt: "2026-09-01T00:01:00Z",
					cause: "aborted",
				}),
			).toBe(true);
			expect(state.consultationRecord.consultation(id)?.state).toBe("awaiting-response");
			expect(state.consultationRecord.consultation(id)?.warning).toBe("Turn ended aborted");
			expect(state.consultationRecord.consultationTurns(id)[0].cause).toBe("aborted");
			state.close();
		});

		test("a settled turn clears a failed turn's warning", () => {
			const state = makeState();
			const id = working(state);
			state.consultationRecord.settleConsultationTurn(id, 1, "boom", {
				settledStatus: "idle",
				capturedAt: "2026-09-01T00:01:00Z",
				cause: "aborted",
			});
			expect(state.consultationRecord.consultation(id)?.warning).toBe("Turn ended aborted");
			// The Agent answers again: the later turn is quiet, the failure stays on
			// the turn record, and the Consultation stays awaiting.
			const pending = state.consultationRecord.beginConsultationResponse(id, "try again", null);
			if (pending === undefined) throw new Error("no pending response");
			state.consultationRecord.acceptConsultationResponse(id, pending.id);
			state.consultationRecord.settleConsultationTurn(id, 2, "answer", {
				settledStatus: "idle",
				capturedAt: "2026-09-01T00:02:00Z",
			});
			expect(state.consultationRecord.consultation(id)?.state).toBe("awaiting-response");
			expect(state.consultationRecord.consultation(id)?.warning).toBeNull();
			state.close();
		});

		test("a completed, truncated, or unknown turn leaves it awaiting the response", () => {
			for (const cause of ["completed", "truncated", "unknown"] as const) {
				const state = makeState();
				const id = working(state, `consultation-${cause}`);
				expect(
					state.consultationRecord.settleConsultationTurn(id, 1, "answer", {
						settledStatus: "idle",
						capturedAt: "2026-09-01T00:01:00Z",
						cause: cause,
					}),
				).toBe(true);
				expect(state.consultationRecord.consultation(id)?.state).toBe("awaiting-response");
				expect(state.consultationRecord.consultation(id)?.warning).toBeNull();
				expect(state.consultationRecord.consultationTurns(id)[0].cause).toBe(cause);
				state.close();
			}
		});

		test("a settle without a cause defaults to unknown and stays awaiting", () => {
			const state = makeState();
			const id = working(state);
			expect(
				state.consultationRecord.settleConsultationTurn(id, 1, "answer", { settledStatus: "idle" }),
			).toBe(true);
			expect(state.consultationRecord.consultationTurns(id)[0].cause).toBe("unknown");
			expect(state.consultationRecord.consultationTurns(id)[0].detail).toBe("");
			expect(state.consultationRecord.consultation(id)?.state).toBe("awaiting-response");
			state.close();
		});
	});
});

describe("durable Consultation privacy", () => {
	test("stores settled output beyond the snapshot limit as a bounded tail", () => {
		const state = makeState();
		const consultation = createConsultation(state, "consultation-1");
		const id = consultation.id;
		state.consultationRecord.setConsultationAgent(id, { paneId: "pane-11111111" });
		state.consultationRecord.setConsultationState(id, "working");
		state.consultationRecord.settleConsultationTurn(id, 1, "a".repeat(2 * 1024 * 1024), {
			settledStatus: "idle",
		});
		const [snapshot] = state.consultationRecord.consultationSnapshots(id);
		expect(snapshot).toBeDefined();
		expect(snapshot.truncated).toBe(true);
		expect(Buffer.byteLength(snapshot.text, "utf8")).toBeLessThanOrEqual(1024 * 1024);
		expect(snapshot.text).toContain("…captured history truncated…");
		expect(snapshot.text.endsWith("a".repeat(1000))).toBe(true);
	});

	test("keeps the state file and its sidecars owner-only", () => {
		const { state, path } = makeStateFile();
		createConsultation(state);
		const mode = (file: string) => statSync(file).mode & 0o777;
		expect(mode(path)).toBe(0o600);
		expect(mode(dirname(path))).toBe(0o700);
		expect(mode(`${path}-wal`)).toBe(0o600);
		expect(mode(`${path}-shm`)).toBe(0o600);
	});

	test("deletion removes the history, truncates the WAL, and leaves no plaintext", () => {
		const { state, path } = makeStateFile();
		const marker = "UNIQUE-PLAINTEXT-MARKER-4f9c21";
		const id = "consultation-1";
		state.consultationRecord.createConsultation({
			id,
			typeName: "grill-with-docs",
			agentType: "pi",
			environment: "worktree",
			model: "",
			thinking: "",
			contextWindow: "",
			template: "/skill:grill-with-docs {input}",
			initialInput: `Review ${marker}`,
			renderedOpeningPrompt: `/skill:grill-with-docs Review ${marker}`,
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
				path: "/tmp/factory",
			},
			agentName: "consultation-11111111",
			createdAt: "2026-09-01T00:00:00.000Z",
		});
		state.consultationRecord.setConsultationAgent(id, { paneId: "pane-11111111" });
		state.consultationRecord.setConsultationState(id, "working");
		state.consultationRecord.settleConsultationTurn(id, 1, `settled ${marker}`, {
			settledStatus: "idle",
		});
		state.consultationRecord.setConsultationState(id, "closing");
		state.consultationRecord.finishConsultationClose(id);
		expect(state.consultationRecord.consultation(id)).toBeDefined();
		state.consultationRecord.deleteConsultation(id);
		expect(state.consultationRecord.consultation(id)).toBeUndefined();
		// The checkpoint truncates the WAL: nothing of the history stays in it.
		expect(statSync(`${path}-wal`).size).toBe(0);
		// secure_delete zero-fills the released pages: no plaintext in the file.
		expect(readFileSync(path, "latin1")).not.toContain(marker);
		expect(readFileSync(`${path}-shm`, "latin1")).not.toContain(marker);
	});
});

describe("pending responses across restart and migration", () => {
	test("survives a restart and commits exactly one turn on recovery", () => {
		const { state, path } = makeStateFile();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.consultationRecord.settleConsultationTurn(consultation.id, 1, "first answer");
		const pending = state.consultationRecord.beginConsultationResponse(
			consultation.id,
			"unaccepted prompt",
			1,
		);
		expect(pending).toBeDefined();
		if (pending === undefined) throw new Error("pending delivery missing");
		state.close();
		// Reopen after a crash between the durable write and the Herdr call.
		const reopened = openFactoryState(path);
		expect(
			reopened.consultationRecord.consultation(consultation.id)?.pendingResponse,
		).toMatchObject({
			input: "unaccepted prompt",
		});
		// No turn exists for the unaccepted prompt yet.
		expect(reopened.consultationRecord.consultationTurns(consultation.id)).toHaveLength(1);
		expect(
			reopened.consultationRecord.acceptConsultationResponse(consultation.id, pending.id),
		).toBeDefined();
		expect(reopened.consultationRecord.consultationTurns(consultation.id)).toHaveLength(2);
		expect(reopened.consultationRecord.consultation(consultation.id)?.pendingResponse).toBeNull();
		expect(reopened.consultationRecord.consultation(consultation.id)?.state).toBe("working");
		reopened.close();
	});

	test("migrates a v4 database to v5 and keeps the Consultation history", () => {
		const { state, path } = makeStateFile();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.consultationRecord.settleConsultationTurn(consultation.id, 1, "first answer", {
			settledStatus: "idle",
		});
		state.close();
		// Downgrade the record to the v4 shape.
		const db = new Database(path);
		db.exec("DROP TABLE consultation_pending_responses");
		// The v6 and later columns go too: a v4 record has no leftover fact,
		// no trace settings, and no context window anywhere.
		db.exec(
			"ALTER TABLE handoffs DROP COLUMN leftover_reason;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_at;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_cleared_at;" +
				" ALTER TABLE handoffs DROP COLUMN herdr_name;",
		);
		db.prepare("ALTER TABLE completion_traces DROP COLUMN model").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN thinking").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
		db.prepare("ALTER TABLE consultations DROP COLUMN context_window").run();
		// The v9 columns belong to the run after this record: a v4 trace never
		// stored a cause, and neither did its consultation turns.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN cause").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN detail").run();
		// The v10 facts belong to the run after this record: a v4 database
		// never stored a checkout's confirmed conflict set, and its
		// Consultation never held the one-shot override column.
		db.prepare(
			"ALTER TABLE consultations ADD COLUMN live_conflict_override INTEGER NOT NULL DEFAULT 0",
		).run();
		db.exec("DROP TABLE checkout_conflict_confirmations;");
		// The v13 mode, the v14 queue, and the v19 queue pause belong to the run
		// after this record: a v4 file stored no Auto-handoff mode, no Work
		// queue, and no queue pause.
		db.exec("DROP TABLE queue_pause; DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v13 fact belongs to the run after this record: a v4 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
		db.prepare("UPDATE schema_version SET version = 4").run();
		db.close();
		const reopened = openFactoryState(path);
		expect(reopened.consultationRecord.consultation(consultation.id)?.state).toBe(
			"awaiting-response",
		);
		expect(reopened.consultationRecord.consultationTurns(consultation.id)).toHaveLength(1);
		// The pending table is back and usable for the preserved history.
		expect(reopened.consultationRecord.consultation(consultation.id)?.pendingResponse).toBeNull();
		expect(
			reopened.consultationRecord.beginConsultationResponse(consultation.id, "again", 1),
		).toBeDefined();
		reopened.close();
	});

	test("migrates a v9 database to v10: the override column goes, the checkout set comes", () => {
		const { state, path } = makeStateFile();
		const consultation = createConsultation(state);
		state.consultationRecord.setConsultationAgent(consultation.id, { paneId: "pane-1" });
		state.close();
		// Downgrade the record to the v9 shape: restore the one-shot override
		// column the v10 step drops, and drop the checkout's confirmed set.
		const db = new Database(path);
		db.exec(
			"ALTER TABLE consultations ADD COLUMN live_conflict_override INTEGER NOT NULL DEFAULT 0;",
		);
		db.exec("DROP TABLE checkout_conflict_confirmations;");
		// The v13 mode, the v14 queue, and the v19 queue pause belong to the run
		// after this record: a v9 file stored no Auto-handoff mode, no Work
		// queue, and no queue pause.
		db.exec("DROP TABLE queue_pause; DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v13 fact belongs to the run after this record: a v9 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
		db.prepare("UPDATE schema_version SET version = 9").run();
		db.close();

		const reopened = openFactoryState(path);
		// The Consultation record survives the step, and its row reads back
		// without the dropped column.
		expect(reopened.consultationRecord.consultation(consultation.id)?.state).toBe("working");
		const columns = new Database(path).prepare("PRAGMA table_info(consultations)").all() as Array<{
			name: string;
		}>;
		expect(columns.map((column) => column.name)).not.toContain("live_conflict_override");
		// The checkout's confirmed set is fresh and usable.
		expect(reopened.consultationRecord.confirmedCheckoutConflicts("/tmp/factory")).toEqual([]);
		reopened.consultationRecord.recordCheckoutConflictConfirmation("/tmp/factory", ["pane-1"]);
		expect(reopened.consultationRecord.confirmedCheckoutConflicts("/tmp/factory")).toEqual([
			"pane-1",
		]);
		reopened.close();
	});
});
