/**
 * The consultationRecord aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { workQueueIdentityOf } from "../../src/state/work-queue.ts";
import { openFactoryState } from "../../src/state.ts";
import { cleanup, enqueue, queuedConsultation, repository, statePath, uid } from "./harness.ts";

afterEach(cleanup);

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
