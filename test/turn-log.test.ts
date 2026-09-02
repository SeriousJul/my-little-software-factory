/**
 * The turn log: the pi session reader, the tool target rules, the last
 * message, and the capture fallback.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	lastMessageFromLog,
	readSessionTurnLog,
	toolTarget,
	turnLogFromCapture,
	turnLogFromPiSession,
} from "../src/turn-log.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** One JSONL line of a pi session file. */
function line(record: unknown): string {
	return JSON.stringify(record);
}

/** A pi session of one settled turn: prose, a tool call, its result, prose. */
function sessionJsonl(): string {
	return [
		line({ type: "session", id: "s1", cwd: "/tmp/repo" }),
		line({
			type: "message",
			id: "m1",
			message: { role: "user", content: [{ type: "text", text: "the operator's prompt" }] },
		}),
		line({
			type: "message",
			id: "m2",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "inner notes, not the work" },
					{ type: "text", text: "I will look at the code first." },
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "rg -n auth_shim src", timeout: 30 },
					},
				],
			},
		}),
		line({
			type: "message",
			id: "m3",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "the tool output, not the work" }],
			},
		}),
		line({
			type: "message",
			id: "m4",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-2",
						name: "bash",
						arguments: { command: "npm test" },
					},
				],
			},
		}),
		line({
			type: "message",
			id: "m5",
			message: {
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "bash",
				content: [{ type: "text", text: "1 failing" }],
				isError: true,
			},
		}),
		line({
			type: "message",
			id: "m6",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "## Result\n\nAll 142 tests pass." }],
			},
		}),
		line({ type: "model_change", model: "claude-opus-4-8" }),
	].join("\n");
}

describe("turnLogFromPiSession", () => {
	test("keeps the agent's text and its tool calls, in order, and drops the rest", () => {
		expect(turnLogFromPiSession(sessionJsonl())).toEqual([
			{ kind: "text", text: "I will look at the code first." },
			{ kind: "tool", name: "bash", target: "rg -n auth_shim src", failed: false },
			{ kind: "tool", name: "bash", target: "npm test", failed: true },
			{ kind: "text", text: "## Result\n\nAll 142 tests pass." },
		]);
	});

	test("a malformed line yields null, so the caller falls back", () => {
		expect(turnLogFromPiSession(`${sessionJsonl()}\nnot json`)).toBeNull();
	});

	test("a file without messages yields null", () => {
		expect(turnLogFromPiSession(line({ type: "session", id: "s1" }))).toBeNull();
	});

	test("an empty file yields null", () => {
		expect(turnLogFromPiSession("")).toBeNull();
	});

	test("skips a JSON line that is not a record", () => {
		const log = turnLogFromPiSession(
			[
				JSON.stringify(["not", "a", "record"]),
				line({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "kept" }] },
				}),
			].join("\n"),
		);
		expect(log).toEqual([{ kind: "text", text: "kept" }]);
	});

	test("skips a record whose type is not message", () => {
		const log = turnLogFromPiSession(
			[
				line({
					type: "session",
					message: { role: "assistant", content: [{ type: "text", text: "skip" }] },
				}),
				line({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "kept" }] },
				}),
			].join("\n"),
		);
		expect(log).toEqual([{ kind: "text", text: "kept" }]);
	});

	test("skips a message without a readable role", () => {
		const log = turnLogFromPiSession(
			[
				line({ type: "message", message: { content: [{ type: "text", text: "skip" }] } }),
				line({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "kept" }] },
				}),
			].join("\n"),
		);
		expect(log).toEqual([{ kind: "text", text: "kept" }]);
		expect(
			turnLogFromPiSession(
				line({ type: "message", message: { content: [{ type: "text", text: "skip" }] } }),
			),
		).toBeNull();
	});

	test("an assistant message with non-list content contributes no entries", () => {
		expect(
			turnLogFromPiSession(
				line({ type: "message", message: { role: "assistant", content: "text" } }),
			),
		).toEqual([]);
	});

	test("drops empty and whitespace-only assistant text parts", () => {
		expect(
			turnLogFromPiSession(
				line({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "" },
							{ type: "text", text: " \t\n " },
							{ type: "text", text: "agent words" },
						],
					},
				}),
			),
		).toEqual([{ kind: "text", text: "agent words" }]);
	});

	test("drops a tool call without a readable name", () => {
		expect(
			turnLogFromPiSession(
				line({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "bad-call", arguments: { command: "skip" } },
							{ type: "toolCall", id: "good-call", name: "bash", arguments: { command: "keep" } },
						],
					},
				}),
			),
		).toEqual([{ kind: "tool", name: "bash", target: "keep", failed: false }]);
	});

	test("a file with only non-message records yields null", () => {
		expect(
			turnLogFromPiSession(`${line({ type: "session" })}\n${line({ type: "model_change" })}`),
		).toBeNull();
	});

	test("an error result marks only its matching tool note failed", () => {
		const log = turnLogFromPiSession(
			[
				line({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
					},
				}),
				line({
					type: "message",
					message: { role: "toolResult", toolCallId: "call-1", isError: true },
				}),
			].join("\n"),
		);
		expect(log).toEqual([{ kind: "tool", name: "bash", target: "", failed: true }]);
	});

	test("an orphan error result does not change the log", () => {
		const log = turnLogFromPiSession(
			[
				line({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
					},
				}),
				line({
					type: "message",
					message: { role: "toolResult", toolCallId: "other", isError: true },
				}),
			].join("\n"),
		);
		expect(log).toEqual([{ kind: "tool", name: "bash", target: "", failed: false }]);
	});

	test("skips blank and malformed nested values without changing readable entries", () => {
		const log = turnLogFromPiSession(
			[
				"   ",
				"null",
				line({ type: "message", message: null }),
				line({
					type: "message",
					message: {
						role: "assistant",
						content: [
							null,
							{ type: "thinking", text: "inner text" },
							{ type: "text", text: 42 },
							{ type: "other", name: "not a tool" },
							{ type: "text", text: "kept" },
						],
					},
				}),
			].join("\n"),
		);
		expect(log).toEqual([{ kind: "text", text: "kept" }]);
	});

	test("only tool-result messages can mark a prior tool note failed", () => {
		const log = turnLogFromPiSession(
			[
				line({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
					},
				}),
				line({
					type: "message",
					message: { role: "user", toolCallId: "call-1", isError: true },
				}),
			].join("\n"),
		);
		expect(log).toEqual([{ kind: "tool", name: "bash", target: "", failed: false }]);
	});
});

describe("toolTarget", () => {
	test("a shell tool gives its command", () => {
		expect(toolTarget("bash", { command: "git status", timeout: 10 })).toBe("git status");
		expect(toolTarget("exec", { cmd: "make test" })).toBe("make test");
	});

	test("a file tool gives its path", () => {
		expect(toolTarget("read", { path: "src/state.ts" })).toBe("src/state.ts");
		expect(toolTarget("write", { file_path: "src/app.ts" })).toBe("src/app.ts");
		expect(toolTarget("edit", { path: "src/app.ts" })).toBe("src/app.ts");
	});

	test("the mcp gateway gives the target tool name", () => {
		expect(toolTarget("mcp", { tool: "xcodebuild_list_sims", args: {} })).toBe(
			"xcodebuild_list_sims",
		);
	});

	test("anything else gives its first string argument", () => {
		expect(toolTarget("search", { query: "pattern", limit: 5 })).toBe("pattern");
		expect(toolTarget("search", { limit: 5, query: "pattern" })).toBe("pattern");
		expect(toolTarget("search", { limit: 5 })).toBe("");
		expect(toolTarget("search", {})).toBe("");
	});
});

describe("lastMessageFromLog", () => {
	test("the last text entry is the message", () => {
		const entries = turnLogFromPiSession(sessionJsonl());
		expect(lastMessageFromLog(entries ?? [])).toBe("## Result\n\nAll 142 tests pass.");
	});

	test("a log without text yields the empty message", () => {
		expect(
			lastMessageFromLog([{ kind: "tool", name: "bash", target: "npm test", failed: false }]),
		).toBe("");
	});

	test("a one-entry log still returns its first message", () => {
		expect(lastMessageFromLog([{ kind: "text", text: "the only message" }])).toBe(
			"the only message",
		);
	});
});

describe("turnLogFromCapture", () => {
	test("the capture becomes one plain entry per line", () => {
		expect(turnLogFromCapture("line one\nline two\n")).toEqual([
			{ kind: "text", text: "line one" },
			{ kind: "text", text: "line two" },
			{ kind: "text", text: "" },
		]);
	});
});

describe("readSessionTurnLog", () => {
	test("reads a pi session file", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		const file = join(directory, "session.jsonl");
		writeFileSync(file, sessionJsonl(), "utf8");
		expect(readSessionTurnLog("pi", file)).toHaveLength(4);
	});

	test("a kind without a reader yields null", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		const file = join(directory, "session.jsonl");
		writeFileSync(file, sessionJsonl(), "utf8");
		expect(readSessionTurnLog("codex", file)).toBeNull();
		expect(readSessionTurnLog("claude", file)).toBeNull();
	});

	test("a missing file yields null", () => {
		expect(readSessionTurnLog("pi", join(tmpdir(), "no-such-session.jsonl"))).toBeNull();
	});

	test("an unreadable path yields null", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		// A directory is not a readable session file.
		expect(readSessionTurnLog("pi", directory)).toBeNull();
	});
});
