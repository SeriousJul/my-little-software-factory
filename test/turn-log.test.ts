/**
 * The turn log: the pi session reader, the tool target rules, the last
 * message, and the capture fallback.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	codexAbortCause,
	lastMessageFromLog,
	readSessionTurnEnd,
	TURN_END_DETAIL_CAP,
	toolTarget,
	turnEndFromClaudeSession,
	turnEndFromCodexSession,
	turnEndFromPiSession,
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
				stopReason: "stop",
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

	// A readable entry that is not the command proves the shell branch was taken:
	// the last resort reads the first string argument in key order.
	test("a shell tool gives the command, never another string argument", () => {
		expect(toolTarget("bash", { note: "read it", command: "git status" })).toBe("git status");
		expect(toolTarget("exec", { note: "read it", cmd: "make test" })).toBe("make test");
		expect(toolTarget("shell", { note: "read it", command: "ls" })).toBe("ls");
	});

	test("a shell tool gives an empty command as its own", () => {
		expect(toolTarget("bash", { note: "read it", command: "", cmd: "make" })).toBe("");
	});

	// Only these names read a command. Any other tool falls back to its first
	// string argument, so a decoy string in front proves which branch answered.
	test("only a shell tool name reads the command argument", () => {
		expect(toolTarget("search", { note: "keep it", command: "git status" })).toBe("keep it");
	});

	test("a file tool gives its path", () => {
		expect(toolTarget("read", { path: "src/state.ts" })).toBe("src/state.ts");
		expect(toolTarget("write", { file_path: "src/app.ts" })).toBe("src/app.ts");
		expect(toolTarget("edit", { path: "src/app.ts" })).toBe("src/app.ts");
	});

	test("a file tool gives the path, never another string argument", () => {
		expect(toolTarget("read", { note: "open it", path: "src/state.ts" })).toBe("src/state.ts");
		expect(toolTarget("write", { note: "open it", file_path: "src/app.ts" })).toBe("src/app.ts");
		expect(toolTarget("edit", { note: "open it", path: "src/app.ts" })).toBe("src/app.ts");
		expect(toolTarget("apply_patch", { note: "open it", path: "src/app.ts" })).toBe("src/app.ts");
	});

	test("only a file tool name reads the path argument", () => {
		expect(toolTarget("search", { note: "keep it", path: "src/state.ts" })).toBe("keep it");
		expect(toolTarget("read", { note: "keep it" })).toBe("keep it");
	});

	test("the mcp gateway gives the target tool name", () => {
		expect(toolTarget("mcp", { tool: "xcodebuild_list_sims", args: {} })).toBe(
			"xcodebuild_list_sims",
		);
		expect(toolTarget("mcp", { note: "call it", tool: "xcodebuild_list_sims" })).toBe(
			"xcodebuild_list_sims",
		);
		// Only the gateway reads a tool argument this way.
		expect(toolTarget("search", { note: "keep it", tool: "other" })).toBe("keep it");
		expect(toolTarget("mcp", { note: "keep it" })).toBe("keep it");
	});

	test("anything else gives its first non-blank string argument", () => {
		expect(toolTarget("search", { query: "pattern", limit: 5 })).toBe("pattern");
		expect(toolTarget("search", { limit: 5, query: "pattern" })).toBe("pattern");
		expect(toolTarget("search", { blank: "", padded: "   ", query: "pattern" })).toBe("pattern");
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

/** A pi record whose last assistant message ended with the given stop reason. */
function piStop(stopReason: string, extra: Record<string, unknown> = {}): string {
	return line({
		type: "message",
		timestamp: "2026-01-01T12:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "the final words" }],
			stopReason,
			...extra,
		},
	});
}

describe("turnEndFromPiSession cause", () => {
	test("a stop reason of stop is completed", () => {
		expect(turnEndFromPiSession(piStop("stop"), null)?.cause).toBe("completed");
	});

	test("an error is failed, with the message's error text as the detail", () => {
		const end = turnEndFromPiSession(
			piStop("error", { errorMessage: "400: the context is too large" }),
			null,
		);
		expect(end?.cause).toBe("failed");
		expect(end?.detail).toBe("400: the context is too large");
	});

	test("an abort is aborted", () => {
		expect(turnEndFromPiSession(piStop("aborted"), null)?.cause).toBe("aborted");
	});

	test("a turn that ends on a tool call is aborted: it never gave its final words", () => {
		expect(turnEndFromPiSession(piStop("toolUse"), null)?.cause).toBe("aborted");
	});

	test("a length stop is truncated", () => {
		expect(turnEndFromPiSession(piStop("length"), null)?.cause).toBe("truncated");
	});

	test("an unrecognized stop reason is unknown", () => {
		expect(turnEndFromPiSession(piStop("something-else"), null)?.cause).toBe("unknown");
	});

	test("a record without messages yields null", () => {
		expect(turnEndFromPiSession(line({ type: "session", id: "s1" }), null)).toBeNull();
	});

	test("the log and the cause come from one read: the log still carries the text", () => {
		const end = turnEndFromPiSession(piStop("stop"), null);
		expect(end?.log).toEqual([{ kind: "text", text: "the final words" }]);
		expect(end?.cause).toBe("completed");
	});
});

/** A codex record line. */
function codexLine(record: unknown): string {
	return JSON.stringify(record);
}

/** A codex turn that ends with the named event, preceded by one agent message. */
function codexJsonl(end: Record<string, unknown>): string {
	return [
		codexLine({
			timestamp: "2026-01-01T12:00:00Z",
			type: "event_msg",
			payload: { type: "agent_message", message: "I finished the work." },
		}),
		codexLine(end),
	].join("\n");
}

describe("turnEndFromCodexSession", () => {
	test("a task_complete without an error is completed", () => {
		const end = turnEndFromCodexSession(
			codexJsonl({
				timestamp: "2026-01-01T12:01:00Z",
				type: "event_msg",
				payload: { type: "task_complete" },
			}),
			null,
		);
		expect(end?.cause).toBe("completed");
		expect(end?.log).toEqual([{ kind: "text", text: "I finished the work." }]);
	});

	test("a task_complete that carries an error is failed, with the error's message", () => {
		const end = turnEndFromCodexSession(
			codexJsonl({
				timestamp: "2026-01-01T12:01:00Z",
				type: "event_msg",
				payload: { type: "task_complete", error: { message: "401 Unauthorized" } },
			}),
			null,
		);
		expect(end?.cause).toBe("failed");
		expect(end?.detail).toBe("401 Unauthorized");
	});

	test("a stream_error is failed, with the error text", () => {
		const end = turnEndFromCodexSession(
			codexJsonl({
				timestamp: "2026-01-01T12:01:00Z",
				type: "event_msg",
				payload: { type: "stream_error", error: { message: "the stream broke" } },
			}),
			null,
		);
		expect(end?.cause).toBe("failed");
		expect(end?.detail).toBe("the stream broke");
	});

	test("a context abort is truncated", () => {
		expect(
			turnEndFromCodexSession(
				codexJsonl({
					timestamp: "2026-01-01T12:01:00Z",
					type: "event_msg",
					payload: { type: "turn_aborted", reason: "context_window_exceeded" },
				}),
				null,
			)?.cause,
		).toBe("truncated");
	});

	test("an interrupted abort is aborted", () => {
		expect(
			turnEndFromCodexSession(
				codexJsonl({
					timestamp: "2026-01-01T12:01:00Z",
					type: "event_msg",
					payload: { type: "turn_aborted", reason: "interrupted" },
				}),
				null,
			)?.cause,
		).toBe("aborted");
	});

	test("an abort the factory does not name is failed", () => {
		expect(
			turnEndFromCodexSession(
				codexJsonl({
					timestamp: "2026-01-01T12:01:00Z",
					type: "event_msg",
					payload: { type: "turn_aborted", reason: "usage_limit_exceeded" },
				}),
				null,
			)?.cause,
		).toBe("failed");
	});

	test("a record without a turn-end event yields null", () => {
		expect(
			turnEndFromCodexSession(
				codexLine({
					timestamp: "2026-01-01T12:00:00Z",
					type: "event_msg",
					payload: { type: "agent_message", message: "still working" },
				}),
				null,
			),
		).toBeNull();
	});

	test("a malformed line yields null", () => {
		expect(
			turnEndFromCodexSession(
				`${codexJsonl({ type: "event_msg", payload: { type: "task_complete" } })}\nnot json`,
				null,
			),
		).toBeNull();
	});
});

/** A claude record line. */
function claudeLine(record: unknown): string {
	return JSON.stringify(record);
}

/** A claude turn: one assistant message that ended with the given stop reason. */
function claudeJsonl(stopReason: string, extra: Record<string, unknown> = {}): string {
	return claudeLine({
		type: "assistant",
		timestamp: "2026-01-01T12:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "the final words" }],
			stop_reason: stopReason,
			...extra,
		},
	});
}

describe("turnEndFromClaudeSession", () => {
	test("an end_turn is completed", () => {
		expect(turnEndFromClaudeSession(claudeJsonl("end_turn"), null)?.cause).toBe("completed");
	});

	test("a stop_sequence is completed", () => {
		expect(turnEndFromClaudeSession(claudeJsonl("stop_sequence"), null)?.cause).toBe("completed");
	});

	test("a max_tokens stop is truncated", () => {
		expect(turnEndFromClaudeSession(claudeJsonl("max_tokens"), null)?.cause).toBe("truncated");
	});

	test("a tool_use stop is mid-turn, not a turn end: it yields null alone", () => {
		expect(turnEndFromClaudeSession(claudeJsonl("tool_use"), null)).toBeNull();
	});

	test("an API error message is failed, with the message's own text as the detail", () => {
		const end = turnEndFromClaudeSession(
			claudeLine({
				type: "assistant",
				timestamp: "2026-01-01T12:00:00Z",
				isApiErrorMessage: true,
				error: "rate_limit",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "API Error: rate limited" }],
				},
			}),
			null,
		);
		expect(end?.cause).toBe("failed");
		expect(end?.detail).toBe("API Error: rate limited");
	});

	test("the log carries the assistant's text", () => {
		expect(turnEndFromClaudeSession(claudeJsonl("end_turn"), null)?.log).toEqual([
			{ kind: "text", text: "the final words" },
		]);
	});

	test("a record without a turn end yields null", () => {
		expect(turnEndFromClaudeSession(line({ type: "session" }), null)).toBeNull();
	});
});

describe("codexAbortCause", () => {
	test("a context reason is truncated", () => {
		expect(codexAbortCause("context_window_exceeded")).toBe("truncated");
	});

	test("an interrupt or timeout reason is aborted", () => {
		expect(codexAbortCause("interrupted")).toBe("aborted");
		expect(codexAbortCause("timed_out")).toBe("aborted");
	});

	test("another reason is failed", () => {
		expect(codexAbortCause("usage_limit_exceeded")).toBe("failed");
	});

	test("an empty or missing reason is unknown", () => {
		expect(codexAbortCause("")).toBe("unknown");
		expect(codexAbortCause(undefined)).toBe("unknown");
	});
});

describe("the staleness guard", () => {
	test("a pi turn-end older than the handoff is unknown, never completed", () => {
		expect(turnEndFromPiSession(piStop("stop"), "2026-06-01T00:00:00Z")?.cause).toBe("unknown");
	});

	test("a pi turn-end at or after the handoff keeps its cause", () => {
		expect(turnEndFromPiSession(piStop("stop"), "2026-01-01T12:00:00Z")?.cause).toBe("completed");
	});

	test("a codex turn-end older than the handoff is unknown", () => {
		expect(
			turnEndFromCodexSession(
				codexJsonl({
					timestamp: "2026-01-01T12:01:00Z",
					type: "event_msg",
					payload: { type: "task_complete" },
				}),
				"2026-06-01T00:00:00Z",
			)?.cause,
		).toBe("unknown");
	});

	test("a claude turn-end older than the handoff is unknown", () => {
		expect(turnEndFromClaudeSession(claudeJsonl("end_turn"), "2026-06-01T00:00:00Z")?.cause).toBe(
			"unknown",
		);
	});

	test("an unparseable handoff time fails open: the cause is kept", () => {
		expect(turnEndFromPiSession(piStop("stop"), "not a time")?.cause).toBe("completed");
	});
});

describe("the detail cap", () => {
	test("a pi error detail longer than the cap is cut to it", () => {
		const longError = "x".repeat(TURN_END_DETAIL_CAP + 500);
		const end = turnEndFromPiSession(piStop("error", { errorMessage: longError }), null);
		expect(end?.detail).toHaveLength(TURN_END_DETAIL_CAP);
	});
});

describe("readSessionTurnEnd", () => {
	test("reads a pi session file", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		const file = join(directory, "session.jsonl");
		writeFileSync(file, sessionJsonl(), "utf8");
		const end = readSessionTurnEnd("pi", file, null);
		expect(end?.log).toHaveLength(4);
		expect(end?.cause).toBe("completed");
	});

	test("reads a codex session file", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		const file = join(directory, "rollout.jsonl");
		writeFileSync(
			file,
			codexJsonl({
				timestamp: "2026-01-01T12:01:00Z",
				type: "event_msg",
				payload: { type: "task_complete" },
			}),
			"utf8",
		);
		expect(readSessionTurnEnd("codex", file, null)?.cause).toBe("completed");
	});

	test("reads a claude session file", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		const file = join(directory, "session.jsonl");
		writeFileSync(file, claudeJsonl("end_turn"), "utf8");
		expect(readSessionTurnEnd("claude", file, null)?.cause).toBe("completed");
	});

	test("a kind without a reader yields null", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		const file = join(directory, "session.jsonl");
		writeFileSync(file, sessionJsonl(), "utf8");
		expect(readSessionTurnEnd("gemini", file, null)).toBeNull();
	});

	test("a missing file yields null", () => {
		expect(readSessionTurnEnd("pi", join(tmpdir(), "no-such-session.jsonl"), null)).toBeNull();
	});

	test("an unreadable path yields null", () => {
		const directory = mkdtempSync(join(tmpdir(), "factory-turn-log-"));
		paths.push(directory);
		// A directory is not a readable session file.
		expect(readSessionTurnEnd("pi", directory, null)).toBeNull();
	});
});
