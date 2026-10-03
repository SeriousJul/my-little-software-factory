/**
 * The workQueue aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { workQueueIdentityOf } from "../../src/state/work-queue.ts";
import { openFactoryState } from "../../src/state.ts";
import {
	choice,
	cleanup,
	enqueue,
	labeled,
	queuedConsultation,
	repository,
	sourceA,
	statePath,
	success,
	uid,
} from "./harness.ts";

afterEach(cleanup);

describe("the workQueue aggregate", () => {
	test("no gate, count, or queue order reads the matched State's name", () => {
		// The field exists for the list's grouping alone. Two machines that
		// differ only in the names they give the same match order the list and
		// the queue identically, and hold the same counts.
		const named = (name: string) => [
			{ name, match: { sourceKind: "github-issue" as const, labelsAny: ["ready-for-agent"] } },
		];
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(
			sourceA,
			success([
				labeled(["ready-for-agent"]),
				{
					...labeled(["ready-for-agent"], "github:github.com:I_9"),
					externalUpdatedAt: "2026-08-30T10:00:00Z",
				},
			]),
		);
		const first = state.ticketWorkCycle.ticketListViews(named("one-name"), "implement").rows;
		// The queue holds the first ticket's waiting start, so its order is the
		// operator's, and a name change cannot move it.
		const claimed = state.workQueue.enqueueWork({
			ticketIdentity: first[0].identity,
			origin: "open",
			choice,
			previousMessage: "",
		});
		if (!claimed.ok) throw new Error(claimed.reason);
		const queueBefore = state.workQueue.items().map((item) => workQueueIdentityOf(item));
		const second = state.ticketWorkCycle.ticketListViews(named("other-name"), "implement").rows;
		expect(second.map((ticket) => ticket.identity)).toEqual(first.map((ticket) => ticket.identity));
		expect(second.map((ticket) => ticket.actionable)).toEqual(
			first.map((ticket) => ticket.actionable),
		);
		expect(state.workQueue.items().map((item) => workQueueIdentityOf(item))).toEqual(queueBefore);
		expect(state.consultationRecord.consultationCounts()).toEqual(
			state.consultationRecord.consultationCounts(),
		);
		state.close();
	});
	test("items enter in enqueue order, and the queue reports its depth and identities", () => {
		const state = openFactoryState(":memory:");
		// The depth is the projection's row count, the same number the Work
		// section's header carries: a second count read off the table could
		// disagree with the rows an operator sees when a damaged row drops out.
		expect(state.workQueue.items()).toHaveLength(0);
		expect(state.workQueue.hasWorkItem("t1")).toBe(false);
		enqueue(state, "t1");
		enqueue(state, "t2");
		expect(state.workQueue.items()).toHaveLength(2);
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["t1", "t2"]);
		expect(state.workQueue.items().map((item) => item.position)).toEqual([0, 1]);
		expect(state.workQueue.hasWorkItem("t2")).toBe(true);
	});
	test("a second enqueue for a waiting ticket is refused, and the first keeps its place", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		const refused = state.workQueue.enqueueWork({
			ticketIdentity: "t1",
			origin: "restart",
			choice,
			previousMessage: "again",
		});
		expect(refused).toEqual({
			ok: false,
			reason: "ticket t1 already has a waiting queue item",
		});
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["t1"]);
	});
	test("a route row names the settled ticket it continues, and a same-ticket route names none", () => {
		const state = openFactoryState(":memory:");
		// The route crosses to the position's own ticket: the row holds both
		// identities, where the handoff starts and whose turn it decides.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "pr-2",
				routeFromIdentity: "issue-1",
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		// A route that stays on its own ticket names no second ticket.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "issue-3",
				routeFromIdentity: "issue-3",
				origin: "workflow",
				choice,
				previousMessage: "the same-ticket route",
			}),
		).toEqual({ ok: true });
		// A start that is no route names none.
		enqueue(state, "issue-4");
		expect(state.workQueue.items()).toEqual([
			expect.objectContaining({ ticketIdentity: "pr-2", routeFromIdentity: "issue-1" }),
			expect.objectContaining({ ticketIdentity: "issue-3", routeFromIdentity: null }),
			expect.objectContaining({ ticketIdentity: "issue-4", routeFromIdentity: null }),
		]);
	});
	test("+ and - move one place, and an item at an edge moves nowhere", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		enqueue(state, "t2");
		enqueue(state, "t3");
		// The front item cannot move up, the back item cannot move down.
		expect(state.workQueue.moveWorkItem("t1", "up")).toBe(false);
		expect(state.workQueue.moveWorkItem("t3", "down")).toBe(false);
		// `-` takes the front item behind the middle one; the swap is atomic
		// on the queue's primary key, so no step of it shares a position.
		expect(state.workQueue.moveWorkItem("t1", "down")).toBe(true);
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["t2", "t1", "t3"]);
		expect(state.workQueue.moveWorkItem("t1", "up")).toBe(true);
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["t1", "t2", "t3"]);
		// An unknown identity moves nowhere.
		expect(state.workQueue.moveWorkItem("t9", "up")).toBe(false);
	});
	test("the queue and its order survive the state file being closed and reopened", () => {
		// The durability claim of #88 is a file-backed fact: an in-memory
		// database cannot show it, so this walk closes the state and opens the
		// same file again the way the next control-plane run does.
		const path = statePath();
		const state = openFactoryState(path);
		for (const identity of ["t1", "t2", "t3"]) enqueue(state, identity);
		// The operator puts the last ask at the front before the plane closes.
		expect(state.workQueue.moveWorkItem("t3", "up")).toBe(true);
		expect(state.workQueue.moveWorkItem("t3", "up")).toBe(true);
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["t3", "t1", "t2"]);
		state.close();

		const reopened = openFactoryState(path);
		const items = reopened.workQueue.items();
		expect(items.map(workQueueIdentityOf)).toEqual(["t3", "t1", "t2"]);
		expect(items.map((item) => item.position)).toEqual([0, 1, 2]);
		// Every fact the waiting start carried comes back: the origin the pickup
		// re-checks, the choice the operator captured, and the message it routes.
		expect(items[0]).toEqual(
			expect.objectContaining({
				ticketIdentity: "t3",
				origin: "open",
				choice,
				previousMessage: "",
			}),
		);
		expect(reopened.workQueue.items()).toHaveLength(3);
		expect(reopened.workQueue.hasWorkItem("t1")).toBe(true);
		// The reopened queue still moves and still answers a cancel.
		expect(reopened.workQueue.moveWorkItem("t3", "down")).toBe(true);
		expect(reopened.workQueue.items().map(workQueueIdentityOf)).toEqual(["t1", "t3", "t2"]);
		reopened.close();
	});
	test("removing an item keeps the rest in order, and the ticket is free to wait again", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		enqueue(state, "t2");
		expect(state.workQueue.removeWorkItem("t1")).toBe(true);
		expect(state.workQueue.removeWorkItem("t1")).toBe(false);
		// The places repack: the surviving item holds the front of the
		// queue, so the queue never shows a place it does not use.
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["t2"]);
		expect(state.workQueue.items().map((item) => item.position)).toEqual([0]);
		// The cancelled start may enqueue again for its ticket.
		enqueue(state, "t1");
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual(["t2", "t1"]);
	});
	test("a queued Consultation is born with its queue item, and an opening one without", () => {
		const state = openFactoryState(":memory:");
		const queued = queuedConsultation(state, uid("q"));
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
			createdAt: "2026-09-19T23:01:00.000Z",
		});
		expect(queued.state).toBe("queued");
		expect(opening.state).toBe("opening");
		// The record and the pointer commit together: the one item the queue
		// holds is the one the queued record owns.
		expect(state.workQueue.items()).toHaveLength(1);
		expect(state.workQueue.items()[0]).toEqual(
			expect.objectContaining({ kind: "consultation", consultationId: queued.id }),
		);
	});
	test("the handoff and Consultation items share one order, and the reorder crosses kinds", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "github:github.com:I_6");
		const consultation = queuedConsultation(state, uid("q"));
		// The handoff item was enqueued first, so it leads: the Consultation
		// item lands behind it in the same order.
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([
			"github:github.com:I_6",
			consultation.id,
		]);
		// The reorder crosses kinds: the Consultation item moves ahead of the
		// handoff item, and the swap is the shared order's one rule.
		expect(state.workQueue.moveWorkItem(consultation.id, "up")).toBe(true);
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([
			consultation.id,
			"github:github.com:I_6",
		]);
		expect(state.workQueue.moveWorkItem(consultation.id, "down")).toBe(true);
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([
			"github:github.com:I_6",
			consultation.id,
		]);
	});
	test("the queue pause is durable factory state (ADR 0052)", () => {
		const path = statePath();
		const state = openFactoryState(path);
		expect(state.workQueue.queuePaused()).toBe(false);
		state.workQueue.setQueuePaused(true);
		expect(state.workQueue.queuePaused()).toBe(true);
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.workQueue.queuePaused()).toBe(true);
		// The pause is the file's own fact: the toggle writes it back off, and
		// a third open reads the off.
		reopened.workQueue.setQueuePaused(false);
		expect(reopened.workQueue.queuePaused()).toBe(false);
		reopened.close();
		const third = openFactoryState(path);
		expect(third.workQueue.queuePaused()).toBe(false);
		third.close();
	});
});
