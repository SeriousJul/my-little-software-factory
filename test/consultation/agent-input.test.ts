/**
 * The Agent input module, read through its interface (issue #203).
 *
 * The key translation is a pure read over one key event. The input queue is
 * tested against the fake command runner, the suite's stand-in for the external
 * `herdr` call, so no test reaches a real pane.
 */
import { describe, expect, test } from "bun:test";
import { ConsultationInputQueue, translateAgentKey } from "../../src/consultation/agent-input.ts";
import type { CommandRunner } from "../../src/runner.ts";
import { FakeRunner } from "../fake-runner.ts";

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
	test("batches consecutive literal text into one send-text", async () => {
		const runner = new FakeRunner();
		const queue = new ConsultationInputQueue(runner);
		await Promise.all([
			queue.enqueue("pane-1", { kind: "text", text: "hel" }),
			queue.enqueue("pane-1", { kind: "text", text: "lo" }),
		]);
		await queue.flush();
		expect(runner.commands()).toEqual(["herdr pane send-text pane-1 hello"]);
	});

	test("flushes literal text before a semantic key", async () => {
		const runner = new FakeRunner();
		const queue = new ConsultationInputQueue(runner);
		queue.enqueue("pane-1", { kind: "text", text: "hello" });
		await queue.enqueue("pane-1", { kind: "key", key: "enter" });
		await queue.flush();
		expect(runner.commands()).toEqual([
			"herdr pane send-text pane-1 hello",
			"herdr pane send-keys pane-1 enter",
		]);
	});

	test("keeps UTF-8 batches within the byte bound without splitting characters", async () => {
		const runner = new FakeRunner();
		const queue = new ConsultationInputQueue(runner, 8);
		const text = "aé😀😀"; // 3 + 4 + 4 = 11 bytes
		queue.enqueue("pane-1", { kind: "text", text });
		await queue.flush();
		const parts = runner.commands().map((command) => command.split(" ").slice(4).join(" "));
		expect(parts.join("")).toBe(text);
		for (const part of parts) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(8);
	});

	test("runs commands in enqueue order, never concurrently", async () => {
		const events: string[] = [];
		let active = 0;
		let peak = 0;
		const runner: CommandRunner = {
			run: async (_command, args) => {
				active += 1;
				peak = Math.max(peak, active);
				events.push(args.join(" "));
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return { code: 0, stdout: "", stderr: "" };
			},
			listModels: async () => ({ ok: false, reason: "no model list here" }),
		};
		const queue = new ConsultationInputQueue(runner);
		queue.enqueue("pane-1", { kind: "text", text: "one" });
		await queue.enqueue("pane-1", { kind: "key", key: "enter" });
		await queue.enqueue("pane-1", { kind: "key", key: "up" });
		await queue.flush();
		expect(events).toEqual([
			"pane send-text pane-1 one",
			"pane send-keys pane-1 enter",
			"pane send-keys pane-1 up",
		]);
		expect(peak).toBe(1);
	});

	test("flush waits until every queued command settles", async () => {
		let settled = 0;
		const runner: CommandRunner = {
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
				settled += 1;
				return { code: 0, stdout: "", stderr: "" };
			},
			listModels: async () => ({ ok: false, reason: "no model list here" }),
		};
		const queue = new ConsultationInputQueue(runner);
		await Promise.all([
			queue.enqueue("pane-1", { kind: "text", text: "a" }),
			queue.enqueue("pane-1", { kind: "key", key: "enter" }),
		]);
		await queue.flush();
		expect(settled).toBe(2);
	});
});
