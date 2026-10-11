/**
 * The Agent input module, read through its interface (issue #203).
 *
 * The key translation is a pure read over one key event. The input queue is
 * tested against the Stub herdr world (ADR 0132), so every send the queue
 * issues reaches the pane the world holds and the test reads what the pane
 * received instead of the command that carried it.
 */
import { describe, expect, test } from "bun:test";
import { ConsultationInputQueue, translateAgentKey } from "../../src/consultation/agent-input.ts";
import { DelayedRunner } from "../delayed-runner.ts";
import { type HerdrWorldDescription, stubHerdrWorld } from "../herdr-world.ts";

const CHECKOUT = "/home/jul/src/factory";

/**
 * The standing the queue writes into: one workspace, its tab, and the pane
 * the Agent holds in it. The queue never reads the world; it only sends.
 */
function queueStanding(): HerdrWorldDescription {
	return {
		checkouts: [
			{
				path: CHECKOUT,
				cloneUrl: "https://github.com/acme/factory.git",
				defaultBranch: "main",
			},
		],
		workspaces: [{ id: "ws-1", checkoutPath: CHECKOUT }],
		tabs: [{ id: "tab-1", workspaceId: "ws-1" }],
		panes: [{ id: "pane-1", tabId: "tab-1", workspaceId: "ws-1" }],
	};
}

describe("the Agent input module's key translation", () => {
	test("maps semantic keys and lets AltGr text pass through", () => {
		expect(translateAgentKey({ name: "up" }, "f12")).toEqual({ kind: "key", key: "up" });
		expect(translateAgentKey({ name: "@", meta: true }, "f12")).toEqual({
			kind: "text",
			text: "@",
		});
		expect(translateAgentKey({ name: "f12" }, "f12")).toBeNull();
		expect(translateAgentKey({ name: "q", ctrl: true }, "f12")).toEqual({
			kind: "key",
			key: "ctrl+q",
		});
	});

	test("keeps the exit key the exit key in either spelling", () => {
		// The configured exit control is the way out of Agent interaction mode,
		// so it never becomes text the Agent reads.
		expect(translateAgentKey({ name: "F12" }, "f12")).toBeNull();
		expect(translateAgentKey({ name: "q", ctrl: true }, "ctrl-q")).toBeNull();
		expect(translateAgentKey({ name: "q", ctrl: true }, "ctrl+q")).toBeNull();
	});
});

describe("the Agent input queue", () => {
	test("batches consecutive literal text into one send", async () => {
		const world = stubHerdrWorld(queueStanding());
		const queue = new ConsultationInputQueue(world);
		await Promise.all([
			queue.enqueue("pane-1", { kind: "text", text: "hel" }),
			queue.enqueue("pane-1", { kind: "text", text: "lo" }),
		]);
		await queue.flush();
		expect(world.sentTextFor("pane-1")).toEqual(["hello"]);
		expect(world.sentKeysFor("pane-1")).toEqual([]);
	});

	test("flushes literal text before a semantic key", async () => {
		const world = stubHerdrWorld(queueStanding());
		const queue = new ConsultationInputQueue(world);
		queue.enqueue("pane-1", { kind: "text", text: "hello" });
		await queue.enqueue("pane-1", { kind: "key", key: "enter" });
		await queue.flush();
		// The subject here is the order of the two sends, and the only place
		// that order stands is the world's recording.
		expect(world.commands()).toEqual([
			"herdr pane send-text pane-1 hello",
			"herdr pane send-keys pane-1 enter",
		]);
	});

	test("keeps UTF-8 batches within the byte bound without splitting characters", async () => {
		const world = stubHerdrWorld(queueStanding());
		const queue = new ConsultationInputQueue(world, 8);
		const text = "aé😀😀"; // 3 + 4 + 4 = 11 bytes
		queue.enqueue("pane-1", { kind: "text", text });
		await queue.flush();
		const parts = world.sentTextFor("pane-1");
		expect(parts.join("")).toBe(text);
		for (const part of parts) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(8);
	});

	test("runs commands in enqueue order, never concurrently", async () => {
		// Every send holds open until the release, so a queue that did not
		// serialize would issue all three beside the held first, and the peak
		// would name it.
		const world = stubHerdrWorld(queueStanding());
		const sends: string[][] = [
			["pane", "send-text", "pane-1", "one"],
			["pane", "send-keys", "pane-1", "enter"],
			["pane", "send-keys", "pane-1", "up"],
		];
		for (const args of sends) world.hold("herdr", args);
		const queue = new ConsultationInputQueue(world);
		queue.enqueue("pane-1", { kind: "text", text: "one" });
		queue.enqueue("pane-1", { kind: "key", key: "enter" });
		queue.enqueue("pane-1", { kind: "key", key: "up" });
		const flushed = queue.flush();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// A queue that did not serialize would already show all three beside
		// the held first.
		expect(world.commands()).toEqual(["herdr pane send-text pane-1 one"]);
		expect(world.peakConcurrency()).toBe(1);
		for (const args of sends) world.release("herdr", args);
		await flushed;
		expect(world.commands()).toEqual([
			"herdr pane send-text pane-1 one",
			"herdr pane send-keys pane-1 enter",
			"herdr pane send-keys pane-1 up",
		]);
		expect(world.peakConcurrency()).toBe(1);
	});

	test("flush waits until every queued command settles", async () => {
		const world = stubHerdrWorld(queueStanding());
		const runner = new DelayedRunner(world, 15, Number.POSITIVE_INFINITY);
		const queue = new ConsultationInputQueue(runner);
		await Promise.all([
			queue.enqueue("pane-1", { kind: "text", text: "a" }),
			queue.enqueue("pane-1", { kind: "key", key: "enter" }),
		]);
		await queue.flush();
		// The commands were issued before the flush resolved; what the flush
		// waits for is the answer to each one.
		expect(world.settledCommands()).toEqual(world.commands());
		expect(world.commands().length).toBe(2);
	});
});
