/**
 * The shared decode for the state's JSON columns: one place per aggregate reads
 * its own stored value through these primitives.
 */

import type { TransitionOutcome } from "../config.ts";
import type { HandoffChoice } from "../handoff.ts";
import type { TurnEndCause, TurnLogEntry } from "../turn-log.ts";
import { TURN_END_CAUSES, turnLogFromCapture } from "../turn-log.ts";
export function turnLogOf(json: string | null, lastMessage: string): TurnLogEntry[] {
	if (json === null) return turnLogFromCapture(lastMessage);
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return turnLogFromCapture(lastMessage);
	}
	if (!Array.isArray(parsed)) return turnLogFromCapture(lastMessage);
	const entries: TurnLogEntry[] = [];
	for (const value of parsed) {
		if (!isRecord(value)) continue;
		if (value.kind === "text" && typeof value.text === "string") {
			entries.push({ kind: "text", text: value.text });
		} else if (
			value.kind === "tool" &&
			typeof value.name === "string" &&
			typeof value.target === "string" &&
			typeof value.failed === "boolean"
		) {
			entries.push({ kind: "tool", name: value.name, target: value.target, failed: value.failed });
		}
	}
	return entries.length > 0 ? entries : turnLogFromCapture(lastMessage);
}
export function turnEndCauseOf(stored: string | null): TurnEndCause {
	if (stored === null) return "unknown";
	return (TURN_END_CAUSES as readonly string[]).includes(stored)
		? (stored as TurnEndCause)
		: "unknown";
}
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function jsonStringArray(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
	} catch {
		return [];
	}
}
export function jsonStringRecord(value: string): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Object.fromEntries(
					Object.entries(parsed).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
	} catch {
		return {};
	}
}
export function transitionOf(json: string | null): TransitionOutcome | null {
	if (json === null) return null;
	try {
		const parsed: unknown = JSON.parse(json);
		return isRecordOutcome(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
export function isRecordOutcome(value: unknown): value is TransitionOutcome {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const outcome = value as Record<string, unknown>;
	return typeof outcome.fired === "boolean" && typeof outcome.writeFailure === "string";
}
export function jsonChoice(value: string): HandoffChoice | undefined {
	try {
		const parsed = JSON.parse(value) as Partial<HandoffChoice>;
		return typeof parsed.agentType === "string" &&
			(parsed.environment === "live-worktree" ||
				parsed.environment === "worktree" ||
				parsed.environment === "container") &&
			typeof parsed.taskType === "string" &&
			typeof parsed.model === "string" &&
			typeof parsed.thinking === "string"
			? {
					...(parsed as HandoffChoice),
					// A choice stored before the context window existed carries
					// none: an empty value leaves the room to the agent, the same
					// meaning it has everywhere else.
					contextWindow: typeof parsed.contextWindow === "string" ? parsed.contextWindow : "",
				}
			: undefined;
	} catch {
		return undefined;
	}
}
