/**
 * The Response draft module: the rules one operator draft is judged by.
 *
 * The input limit, the emptiness rule, the size reason, the literal-text rule,
 * and the bounded text rule have one owner here. The launcher's initial input,
 * the Response field's own size word, the Send action's refusal, and the state
 * module's recovery read all ask this module, and none of them keeps a copy of
 * a rule (issue #203).
 *
 * The shared field's paste path is not one of those callers. It removes terminal
 * sequences with `stripAnsiSequences` from `@opentui/core`, and ADR 0014 keeps
 * that path inside the shared control library. The plane's literal-text rule and
 * that library rule are two rules with two owners; ADR 0096 records that this
 * split did not close it.
 */

import { utf8ByteLength, utf8Prefix } from "../text-bounds.ts";

/** The UTF-8 bound every operator draft is measured against. */
export const CONSULTATION_INPUT_LIMIT = 64 * 1024;

/** Validate input without changing it, so an oversized draft stays editable. */
export function validateConsultationInput(
	value: string,
	limit = CONSULTATION_INPUT_LIMIT,
): string | undefined {
	if (value.trim() === "") return "initial input cannot be empty";
	const bytes = utf8ByteLength(value);
	if (bytes > limit) return `initial input is ${bytes} UTF-8 bytes; the limit is ${limit}`;
	return undefined;
}

/**
 * The reason a Response is too large to send, in the plane's words.
 *
 * The size reason and the emptiness reason are read in two different places:
 * the size reason stands on the field, where the oversized text is, and the
 * other reasons stand on the Send action. Exporting the rule rather than its
 * sentence is what lets the field ask "is this a size reason?" without a view
 * recognizing a string.
 */
export function responseOversize(
	value: string,
	limit = CONSULTATION_INPUT_LIMIT,
): string | undefined {
	const bytes = utf8ByteLength(value);
	return bytes > limit ? `response is ${bytes} UTF-8 bytes; the limit is ${limit}` : undefined;
}

/** The bounded prompt argument used by normal Consultation responses. */
export function validateResponseInput(
	value: string,
	limit = CONSULTATION_INPUT_LIMIT,
): string | undefined {
	if (value.trim() === "") return "response cannot be empty";
	return responseOversize(value, limit);
}

/** Printable text may include pasted newlines and tabs, but no terminal controls. */
export function isLiteralText(value: string): boolean {
	return [...value].every(
		(character) => character === "\n" || character === "\t" || !/\p{Cc}/u.test(character),
	);
}

/**
 * One Consultation turn as the recovery read states it: the operator's own
 * input, and the Agent's settled output when one was captured.
 */
export interface ReplacementTurn {
	input: string;
	output?: string;
}

/**
 * Build recovery context with original input and newest turns first.
 *
 * This module owns the join, the marker, and the bound: the text a Replacement
 * Consultation carries is the text these tests assert on, because the state
 * module's read of the record and its turns calls this rule and holds no copy
 * of it (issue #203). The opening turn needs no section of its own - the
 * original input already states it - so the turns start after it.
 */
export function boundedReplacementInput(
	originalInput: string,
	turns: readonly ReplacementTurn[],
	limit = CONSULTATION_INPUT_LIMIT,
): string {
	const sections = [`Original input:\n${originalInput}`];
	for (let index = turns.length - 1; index >= 1; index -= 1) {
		const turn = turns[index];
		sections.push(
			`Operator response:\n${turn.input}${turn.output === undefined ? "" : `\nAgent output:\n${turn.output}`}`,
		);
	}
	const full = sections.join("\n\n");
	if (utf8ByteLength(full) <= limit) return full;
	const marker = "\n[recovery context omitted]\n";
	if (limit <= utf8ByteLength(marker)) return utf8Prefix(marker, limit);
	return `${utf8Prefix(full, limit - utf8ByteLength(marker))}${marker}`;
}
