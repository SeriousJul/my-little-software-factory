/**
 * The turn log: the agent's messages of one settled turn, in order.
 *
 * ADR 0008: the log comes from the agent's session record, not the
 * terminal. Herdr reports the session file in `agent list`; a per-agent-type
 * reader parses it into entries. The terminal capture remains the fallback:
 * when herdr reports no session, or the record is missing, unreadable, or of
 * a kind without a reader, the capture becomes a plain-text log.
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

/** A record guard for the session file's JSON lines. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
	const entries: TurnLogEntry[] = [];
	const toolById = new Map<string, ToolEntry>();
	let sawMessage = false;
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
	return sawMessage ? entries : null;
}

/**
 * The short target of a tool call, for its note line.
 *
 * The known tools give their primary argument: a shell tool the command, a
 * file tool the path. The mcp gateway gives the target tool name. Anything
 * else gives its first string argument, in the argument's own key order.
 * The modal truncates to the line width; the log keeps the full value.
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

/**
 * Read the settled turn's log from the agent's session record.
 *
 * The kind is the agent type's kind from the config. The pi reader is the
 * only reader so far; a kind without a reader yields null, and the caller
 * falls back to the terminal capture. A missing or unreadable file yields
 * null the same way.
 */
export function readSessionTurnLog(kind: string, sessionPath: string): TurnLogEntry[] | null {
	if (kind !== "pi") return null;
	let raw: string;
	try {
		raw = readFileSync(sessionPath, "utf8");
	} catch {
		return null;
	}
	return turnLogFromPiSession(raw);
}
