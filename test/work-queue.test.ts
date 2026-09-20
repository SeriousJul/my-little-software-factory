/**
 * The Work queue's durable order (ADR 0034, issue #88): the state-level
 * contract the observation pickup and the Main view's Work section run on.
 *
 * The item is the operator's captured ask: the ticket identity, the origin
 * the pickup's claim re-checks, and the choice the pickup re-runs. The queue
 * is the shared order every start route reads, and its order and content
 * survive a restart the moment the write returns.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffChoice } from "../src/handoff.ts";
import {
	type FactoryState,
	openFactoryState,
	type WorkQueueItem,
	workQueueStartOf,
} from "../src/state.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function statePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "factory-work-queue-"));
	paths.push(directory);
	return join(directory, "state.sqlite");
}

const choiceA = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};
const choiceB = {
	agentType: "codex",
	environment: "live-worktree" as const,
	taskType: "review",
	model: "review-model",
	thinking: "low",
	contextWindow: "200000",
};

/**
 * Enqueue where the answer must be an item: a refusal is the test's own
 * failure, and one distinct ticket per item keeps every ask startable.
 */
function enqueue(
	state: FactoryState,
	ticketIdentity: string,
	choice: HandoffChoice,
): WorkQueueItem {
	const item = state.enqueueWorkQueueItem({ ticketIdentity, origin: "open", choice });
	if (item === null) throw new Error(`the store refused the enqueue of ${ticketIdentity}`);
	return item;
}

describe("the Work queue's durable order (issue #88)", () => {
	test("enqueue lands at the end and carries the captured ask", () => {
		const state = openFactoryState(statePath());
		const first = enqueue(state, "github:github.com:I_6", choiceA);
		const second = enqueue(state, "github:github.com:I_7", choiceB);
		const queue = state.workQueue();
		expect(queue).toHaveLength(2);
		expect(queue.map((item) => item.id)).toEqual([first.id, second.id]);
		expect(queue[0]).toEqual(
			expect.objectContaining({
				kind: "handoff",
				ticketIdentity: "github:github.com:I_6",
				origin: "open",
				choice: choiceA,
			}),
		);
		expect(queue[1]).toEqual(
			expect.objectContaining({
				ticketIdentity: "github:github.com:I_7",
				choice: choiceB,
			}),
		);
		expect(first.createdAt).toEqual(expect.stringMatching(/^\d{4}-/));
		state.close();
	});

	test("the enqueue is not a handoff: the ticket keeps its state", () => {
		const state = openFactoryState(statePath());
		state.enqueueWorkQueueItem({
			ticketIdentity: "github:github.com:I_6",
			origin: "open",
			choice: choiceA,
		});
		// No claim, no in-progress record: the pickup's own claim is the
		// first write the ticket sees.
		expect(state.openAttemptTickets()).toEqual([]);
		expect(state.ticketsByState(["handed-off", "running"])).toEqual([]);
		state.close();
	});

	test("one item per ticket: the second add of a waiting ticket is refused", () => {
		// ADR 0034: a waiting ticket stands in the queue once. A second item
		// for it could never start - its claim is refused the moment the first
		// pickup moves the ticket - so the store refuses the add and the first
		// item keeps its place.
		const state = openFactoryState(statePath());
		const first = enqueue(state, "github:github.com:I_6", choiceA);
		expect(
			state.enqueueWorkQueueItem({
				ticketIdentity: "github:github.com:I_6",
				origin: "restart",
				choice: choiceB,
			}),
		).toBeNull();
		expect(state.workQueue().map((item) => item.id)).toEqual([first.id]);
		expect(state.workQueue()[0]).toEqual(
			expect.objectContaining({ origin: "open", choice: choiceA }),
		);
		// The refusal leaves nothing else standing: after the first ask is
		// removed, the same ticket can ask again.
		expect(state.removeWorkQueueItem(first.id)).toBe(true);
		const again = enqueue(state, "github:github.com:I_6", choiceB);
		expect(state.workQueue().map((item) => item.id)).toEqual([again.id]);
		state.close();
	});

	test("move swaps with the neighbour, and the edges say no", () => {
		const state = openFactoryState(statePath());
		const [a, b, c] = (
			[
				["github:github.com:I_6", choiceA],
				["github:github.com:I_7", choiceB],
				["github:github.com:I_8", choiceA],
			] as const
		).map(([identity, choice]) => enqueue(state, identity, choice));
		// a, b, c.
		expect(state.workQueue().map((item) => item.id)).toEqual([a.id, b.id, c.id]);
		expect(state.moveWorkQueueItem(b.id, -1)).toBe(true);
		expect(state.workQueue().map((item) => item.id)).toEqual([b.id, a.id, c.id]);
		expect(state.moveWorkQueueItem(c.id, -1)).toBe(true);
		expect(state.workQueue().map((item) => item.id)).toEqual([b.id, c.id, a.id]);
		// At the edge the move asks for, the item stays put and the call says so.
		expect(state.moveWorkQueueItem(b.id, -1)).toBe(false);
		expect(state.moveWorkQueueItem(a.id, 1)).toBe(false);
		expect(state.workQueue().map((item) => item.id)).toEqual([b.id, c.id, a.id]);
		// A move of a gone item is a no-op that says no.
		expect(state.moveWorkQueueItem("no-such-item", -1)).toBe(false);
		state.close();
	});

	test("remove deletes the item, and removing a gone item says so", () => {
		const state = openFactoryState(statePath());
		const a = enqueue(state, "github:github.com:I_6", choiceA);
		const b = enqueue(state, "github:github.com:I_7", choiceB);
		expect(state.removeWorkQueueItem(a.id)).toBe(true);
		expect(state.workQueue().map((item) => item.id)).toEqual([b.id]);
		// Removing an item that is not there says so: the store's answer is
		// the fact the Main view reports, not a second cancellation.
		expect(state.removeWorkQueueItem(a.id)).toBe(false);
		expect(state.workQueue().find((item) => item.id === b.id)?.choice).toEqual(choiceB);
		state.close();
	});

	test("the order and the content stand across a restart", () => {
		const path = statePath();
		const state = openFactoryState(path);
		const a = enqueue(state, "github:github.com:I_6", choiceA);
		const b = enqueue(state, "github:github.com:I_7", choiceB);
		const c = enqueue(state, "github:github.com:I_8", choiceA);
		expect(state.moveWorkQueueItem(c.id, -1)).toBe(true);
		expect(state.removeWorkQueueItem(b.id)).toBe(true);
		state.close();

		const again = openFactoryState(path);
		const queue = again.workQueue();
		// The a, c, b order minus the removed b: a, then c.
		expect(queue.map((item) => item.id)).toEqual([a.id, c.id]);
		expect(queue[0]).toEqual(
			expect.objectContaining({
				ticketIdentity: "github:github.com:I_6",
				choice: choiceA,
			}),
		);
		expect(queue[1]).toEqual(
			expect.objectContaining({
				ticketIdentity: "github:github.com:I_8",
				choice: choiceA,
			}),
		);
		// The removed item stays gone across the restart.
		expect(queue.some((item) => item.id === b.id)).toBe(false);
		again.close();
	});

	test("a damaged stored row stays damaged, visible, and unstartable", () => {
		const path = statePath();
		const state = openFactoryState(path);
		const item = enqueue(state, "github:github.com:I_6", choiceB);
		state.close();

		// Damage the stored cells outside the store, the way a corrupt row
		// would sit there.
		const db = new Database(path);
		db.exec(`UPDATE work_queue SET choice_json = 'not json' WHERE id = '${item.id}'`);
		db.exec(`UPDATE work_queue SET origin = 'no-such-origin' WHERE id = '${item.id}'`);
		db.close();

		const again = openFactoryState(path);
		const read = again.workQueue().find((entry) => entry.id === item.id);
		// The row keeps its place in the queue with the cells the reader could
		// not name, and the reader invents none of them: no origin, so no
		// wrong hard check, and no environment the operator never chose.
		expect(read?.origin).toBeNull();
		expect(read?.choice).toBeNull();
		expect(read?.ticketIdentity).toBe("github:github.com:I_6");
		// The start it asks for is refused with the reason that names the
		// damage, and the refusal is the first fact the reader lost.
		expect(workQueueStartOf(read ?? ({} as WorkQueueItem))).toEqual({
			ok: false,
			reason: "the stored item's origin is not one the plane knows",
		});
		again.close();
	});

	test("a row that lost its ticket names that damage", () => {
		const path = statePath();
		const state = openFactoryState(path);
		const item = state.enqueueWorkQueueItem({
			ticketIdentity: "github:github.com:I_6",
			origin: "restart",
			choice: choiceA,
		});
		if (item === null) throw new Error("the first enqueue of a fresh ticket cannot be refused");
		state.close();
		const db = new Database(path);
		db.exec(`UPDATE work_queue SET ticket_identity = NULL WHERE id = '${item.id}'`);
		db.close();

		const again = openFactoryState(path);
		const read = again.workQueue().find((entry) => entry.id === item.id);
		expect(read?.ticketIdentity).toBe("");
		expect(read?.origin).toBe("restart");
		expect(workQueueStartOf(read ?? ({} as WorkQueueItem))).toEqual({
			ok: false,
			reason: "the stored item names no ticket",
		});
		again.close();
	});
});
