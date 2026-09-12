/**
 * The turn log and the turn end cause, read from the agent's session record.
 *
 * ADR 0008: the log comes from the agent's session record, not the
 * terminal. Herdr reports the session file in `agent list`; a per-agent-type
 * reader parses it. The terminal capture remains the fallback: when herdr
 * reports no session, or the record is missing, unreadable, or of a kind
 * without a reader, the capture becomes a plain-text log and the cause is
 * `unknown`.
 *
 * ADR 0015 widens the seam: the same read that returns the log also returns
 * the turn end cause and its detail, from the same record. The cause is the
 * agent's fact of why the turn ended, mapped into a closed five-value
 * vocabulary; the detail carries the agent's or the provider's own text.
 *
 * The entries are the durable content of a Completion trace and the body of
 * the decision modal. They carry no styling: the modal renders them.
 */
import { readFileSync } from "node:fs";

/** One line of the turn log: agent text, or a note of a tool call. */
export type TurnLogEntry =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; target: string; failed: boolean };

/** A tool call note, the kind the session reader tracks per call id. */
type ToolEntry = Extract<TurnLogEntry, { kind: "tool" }>;

/**
 * The turn end cause: why the agent's settled turn ended.
 *
 * A closed five-value vocabulary. A vendor-specific class is mapped into it
 * and preserved in the detail, never added to it. `unknown` is the fail-open
 * case: no reader for the kind, a missing or unreadable record, or a record
 * that predates the handoff. `unknown` is not evidence of failure.
 */
export const TURN_END_CAUSES = ["completed", "failed", "aborted", "truncated", "unknown"] as const;
export type TurnEndCause = (typeof TURN_END_CAUSES)[number];

/**
 * Whether a turn end cause holds its turn: it is a non-completed, non-unknown
 * cause. A held turn is the one no automatic decision runs on. `unknown`
 * fails open and is not held.
 */
export function isHeldCause(cause: TurnEndCause | null | undefined): boolean {
	return cause === "failed" || cause === "aborted" || cause === "truncated";
}

/** The cap on the stored cause detail: one cell cannot hold a kilobyte of payload. */
export const TURN_END_DETAIL_CAP = 2000;

/**
 * One settled turn, as the session reader read it: the log, the cause, and
 * the cause's detail. One read, one parse, one value: the cause cannot
 * disagree with the log beside it.
 */
export interface TurnEnd {
	/** The agent's messages of the turn, in order. */
	log: TurnLogEntry[];
	/** Why the turn ended, in the closed vocabulary. */
	cause: TurnEndCause;
	/** The agent's or the provider's own text, capped. Empty when there is none. */
	detail: string;
}

/** Cap a cause detail to the stored cap. */
function capDetail(detail: string): string {
	return detail.length > TURN_END_DETAIL_CAP ? detail.slice(0, TURN_END_DETAIL_CAP) : detail;
}

/** A record guard for the session file's JSON lines. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a timestamp the record may carry: an ISO string or epoch
 * milliseconds. Returns null when absent or unparseable, so the staleness
 * guard can fail open instead of guessing.
 */
function parseTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : ms;
	}
	return null;
}

/**
 * The staleness guard, shared by every per-kind reader: when the record's
 * last turn-end is older than the handoff's started time, the record is from
 * the run before, so the cause is `unknown` and never `completed`. A stale
 * session path cannot close a turn on evidence from the run before it.
 * Unparseable timestamps fail open: the guard cannot prove staleness.
 */
function applyStalenessGuard(
	cause: TurnEndCause,
	lastTurnEndTs: number | null,
	startedAt: string | null,
): TurnEndCause {
	if (startedAt === null || lastTurnEndTs === null) return cause;
	const startedMs = parseTimestamp(startedAt);
	if (startedMs === null) return cause;
	if (lastTurnEndTs < startedMs) return "unknown";
	return cause;
}

/**
 * Parse a pi session file (JSONL) into a turn log.
 *
 * The session stores every event of the run in order: the operator's
 * prompts (skipped: they are not the agent's words), the agent's text, its
 * tool calls, the tool results, and thinking blocks (skipped: they are the
 * agent's inner notes, not the work). A malformed line or a file without
 * messages yields null, so the caller falls back to the terminal capture.
 */
export function turnLogFromPiSession(jsonl: string): TurnLogEntry[] | null {
	return turnEndFromPiSession(jsonl, null)?.log ?? null;
}

/**
 * Parse a pi session record into the log, the turn end cause, and its
 * detail.
 *
 * The cause comes from the last assistant message's stop reason: `stop` is
 * `completed`; `error` is `failed` with the message's error text as the
 * detail; `aborted` is `aborted`; a last assistant message that is a tool
 * call (`toolUse`) is `aborted`, because the turn never produced its final
 * words; `length` is `truncated`. Anything else is `unknown`. A malformed
 * line or a record without messages yields null.
 */
export function turnEndFromPiSession(jsonl: string, startedAt: string | null): TurnEnd | null {
	const entries: TurnLogEntry[] = [];
	const toolById = new Map<string, ToolEntry>();
	let sawMessage = false;
	let lastStop: string | undefined;
	let lastError: string | undefined;
	let lastTs: number | null = null;
	for (const line of jsonl.split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			return null;
		}
		if (!isRecord(record) || record.type !== "message") continue;
		const message = isRecord(record.message) ? record.message : undefined;
		if (message === undefined || typeof message.role !== "string") continue;
		sawMessage = true;
		if (message.role === "assistant") {
			lastStop = typeof message.stopReason === "string" ? message.stopReason : undefined;
			lastError = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			lastTs = parseTimestamp(record.timestamp ?? message.timestamp) ?? lastTs;
			const content = Array.isArray(message.content) ? message.content : [];
			for (const part of content) {
				if (!isRecord(part)) continue;
				if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
					entries.push({ kind: "text", text: part.text });
				} else if (part.type === "toolCall" && typeof part.name === "string") {
					const entry: ToolEntry = {
						kind: "tool",
						name: part.name,
						target: toolTarget(part.name, isRecord(part.arguments) ? part.arguments : {}),
						failed: false,
					};
					entries.push(entry);
					if (typeof part.id === "string") toolById.set(part.id, entry);
				}
				// thinking parts are the agent's inner notes: not part of the work.
			}
		} else if (message.role === "toolResult") {
			// The result follows the call: mark the matching note failed when
			// the runtime reports an error.
			const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (message.isError === true) {
				const entry = toolById.get(callId);
				if (entry !== undefined) entry.failed = true;
			}
		}
	}
	if (!sawMessage) return null;
	let cause: TurnEndCause;
	let detail = "";
	switch (lastStop) {
		case "stop":
			cause = "completed";
			break;
		case "error":
			cause = "failed";
			detail = lastError ?? "";
			break;
		case "aborted":
		case "toolUse":
			cause = "aborted";
			break;
		case "length":
			cause = "truncated";
			break;
		default:
			cause = "unknown";
	}
	return {
		log: entries,
		cause: applyStalenessGuard(cause, lastTs, startedAt),
		detail: capDetail(detail),
	};
}

/**
 * The codex reason of a `turn_aborted` event, mapped into the vocabulary.
 *
 * The context-window reason is `truncated`; the interrupt and timeout
 * reasons are `aborted`; the limit, quota, rate, overload, server,
 * connection, authorization, and bad-request reasons are `failed`. An
 * unrecognized reason is `failed`: an abort the factory does not name as a
 * local event is read as the wall, not as a finish.
 */
export function codexAbortCause(reason: string | undefined): TurnEndCause {
	if (reason === undefined || reason.trim() === "") return "unknown";
	const r = reason.toLowerCase();
	if (r.includes("context")) return "truncated";
	if (r.includes("interrupt") || r.includes("timeout") || r.includes("timed_out") || r === "abort")
		return "aborted";
	return "failed";
}

/**
 * Parse a codex session record (JSONL rollout) into the log, the turn end
 * cause, and its detail.
 *
 * The record is a stream of events. The agent's `agent_message` events are
 * the log. The turn end is the last of the turn-end events: `task_complete`
 * is `completed` unless it carries an error (the provider rejected the
 * request), in which case it is `failed` with the error's message as the
 * detail; `stream_error` is `failed`; `turn_aborted` maps by its own reason.
 * A record without a turn-end event yields null.
 */
export function turnEndFromCodexSession(jsonl: string, startedAt: string | null): TurnEnd | null {
	const entries: TurnLogEntry[] = [];
	let sawTurnEnd = false;
	let cause: TurnEndCause = "unknown";
	let detail = "";
	let lastTs: number | null = null;
	for (const line of jsonl.split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			return null;
		}
		if (!isRecord(record)) continue;
		const payload = isRecord(record.payload) ? record.payload : undefined;
		if (payload === undefined || typeof payload.type !== "string") continue;
		if (payload.type === "agent_message") {
			if (typeof payload.message === "string" && payload.message.trim() !== "") {
				entries.push({ kind: "text", text: payload.message });
			}
			continue;
		}
		const ts = parseTimestamp(record.timestamp ?? payload.completed_at) ?? null;
		if (payload.type === "task_complete") {
			sawTurnEnd = true;
			lastTs = ts ?? lastTs;
			const error = isRecord(payload.error) ? payload.error : undefined;
			if (error !== undefined) {
				cause = "failed";
				detail = typeof error.message === "string" ? error.message : "";
			} else {
				cause = "completed";
				detail = "";
			}
		} else if (payload.type === "stream_error") {
			sawTurnEnd = true;
			lastTs = ts ?? lastTs;
			cause = "failed";
			const error = isRecord(payload.error) ? payload.error : undefined;
			detail =
				error !== undefined && typeof error.message === "string"
					? error.message
					: typeof payload.message === "string"
						? payload.message
						: "";
		} else if (payload.type === "turn_aborted") {
			sawTurnEnd = true;
			lastTs = ts ?? lastTs;
			cause = codexAbortCause(typeof payload.reason === "string" ? payload.reason : undefined);
			detail = "";
		}
	}
	if (!sawTurnEnd) return null;
	return {
		log: entries,
		cause: applyStalenessGuard(cause, lastTs, startedAt),
		detail: capDetail(detail),
	};
}

/**
 * The text of a claude API error message: the synthetic message's own words,
 * which read the provider's reason to the operator.
 */
function claudeErrorText(record: Record<string, unknown>): string {
	const message = isRecord(record.message) ? record.message : undefined;
	if (message !== undefined && Array.isArray(message.content)) {
		for (const part of message.content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	if (typeof record.error === "string") return record.error;
	return "";
}

/**
 * Parse a claude session record (JSONL) into the log, the turn end cause,
 * and its detail.
 *
 * The record stores the conversation in order. The agent's text in the
 * assistant messages is the log. An API error message (`isApiErrorMessage`)
 * is `failed`, with the message's own text as the detail. A real message
 * stopped on its output token limit (`max_tokens`) is `truncated`; an end of
 * turn or stop sequence is `completed`. A `tool_use` stop is mid-turn, not a
 * turn end. A record without a turn end yields null.
 */
export function turnEndFromClaudeSession(jsonl: string, startedAt: string | null): TurnEnd | null {
	const entries: TurnLogEntry[] = [];
	let sawTurnEnd = false;
	let cause: TurnEndCause = "unknown";
	let detail = "";
	let lastTs: number | null = null;
	for (const line of jsonl.split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			return null;
		}
		if (!isRecord(record) || record.type !== "assistant") continue;
		const message = isRecord(record.message) ? record.message : undefined;
		if (message === undefined) continue;
		const content = Array.isArray(message.content) ? message.content : [];
		for (const part of content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string")
				entries.push({ kind: "text", text: part.text });
		}
		const ts = parseTimestamp(record.timestamp) ?? null;
		if (record.isApiErrorMessage === true) {
			sawTurnEnd = true;
			lastTs = ts ?? lastTs;
			cause = "failed";
			detail = claudeErrorText(record);
			continue;
		}
		const stopReason = typeof message.stop_reason === "string" ? message.stop_reason : undefined;
		if (stopReason === "end_turn" || stopReason === "stop_sequence") {
			sawTurnEnd = true;
			lastTs = ts ?? lastTs;
			cause = "completed";
			detail = "";
		} else if (stopReason === "max_tokens") {
			sawTurnEnd = true;
			lastTs = ts ?? lastTs;
			cause = "truncated";
			detail = "";
		}
		// `tool_use` is mid-turn: the agent called a tool and the turn goes on.
	}
	if (!sawTurnEnd) return null;
	return {
		log: entries,
		cause: applyStalenessGuard(cause, lastTs, startedAt),
		detail: capDetail(detail),
	};
}

/**
 * The widened seam: read the settled turn's log, cause, and detail from the
 * agent's session record in one read.
 *
 * The kind is the agent type's kind from the config. A kind without a
 * reader, a missing or unreadable file, or a malformed record yields null,
 * and the caller falls back to the terminal capture with an `unknown`
 * cause. The started time of the handoff feeds the staleness guard.
 */
export function readSessionTurnEnd(
	kind: string,
	sessionPath: string,
	startedAt: string | null,
): TurnEnd | null {
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf8");
	} catch {
		return null;
	}
	switch (kind) {
		case "pi":
			return turnEndFromPiSession(raw, startedAt);
		case "codex":
			return turnEndFromCodexSession(raw, startedAt);
		case "claude":
			return turnEndFromClaudeSession(raw, startedAt);
		default:
			return null;
	}
}

/**
 * The target of a tool call, the part of its arguments that names what it
 * acts on: the command of a shell call, the path of a file call, the tool of
 * an MCP call. The first non-blank string argument stands in for the rest,
 * so a call the factory does not name still shows its own words.
 */
export function toolTarget(name: string, args: Record<string, unknown>): string {
	if (
		(name === "bash" || name === "exec" || name === "shell") &&
		(typeof args.command === "string" || typeof args.cmd === "string")
	) {
		return String(args.command ?? args.cmd);
	}
	if (
		(name === "read" || name === "write" || name === "edit" || name === "apply_patch") &&
		(typeof args.path === "string" || typeof args.file_path === "string")
	) {
		return String(args.path ?? args.file_path);
	}
	if (name === "mcp" && typeof args.tool === "string") {
		return args.tool;
	}
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return "";
}

/** The agent's final text of a turn log, for the trace's last message. */
export function lastMessageFromLog(entries: readonly TurnLogEntry[]): string {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry !== undefined && entry.kind === "text") return entry.text;
	}
	return "";
}

/**
 * The fallback log: a terminal capture, one plain entry per line.
 *
 * The capture holds rendered UI, not structured messages, so its lines are
 * text entries without tool notes. The modal renders them as-is.
 */
export function turnLogFromCapture(capture: string): TurnLogEntry[] {
	return capture.split("\n").map((line) => ({ kind: "text", text: line }));
}
