/**
 * The Message line: its facts, the pure selector that ranks them, and the
 * one row it draws.
 *
 * The row is shared by the base frame and by every surface that owns the
 * bottom of the screen, so a Message says the same thing everywhere: one
 * row, one severity prefix, one color, and the same display-width-aware
 * cut at the terminal edge.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";
import { padToWidth, truncateToWidth } from "./text.ts";
import { COLORS, prefixForSeverity } from "./theme.ts";

export type MessageSeverity = "working" | "warning" | "error";

export interface MessageFact {
	severity: MessageSeverity;
	text: string;
}

/**
 * The facts behind the Message line, held apart so each one can return on
 * its own.
 *
 * `working` is progress an operation is making right now, and only that
 * operation clears it. `operation` is the outcome of the last operation the
 * operator started, including the reason a control refused to start one.
 * `notice` answers a control the app will decide without the operator, so it
 * never outranks a fact an operation wrote. `sourceHealth` is a standing
 * condition of the Ticket sources rather than the result of a request.
 */
export interface MessageFacts {
	working?: string;
	operation?: { severity: "warning" | "error"; text: string };
	notice?: string;
	sourceHealth?: string;
}

/**
 * The one visible Message, in the order the operator is to be told.
 *
 * A failure outranks everything. Active progress outranks an outcome, so a
 * Warning written during a refresh waits behind its Working line and appears
 * when the refresh settles. A notice answers the control just pressed, so it
 * outranks the standing source health and yields to every fact an operation
 * wrote.
 */
export function selectMessage(facts: MessageFacts): MessageFact | null {
	if (facts.operation?.severity === "error")
		return { severity: "error", text: facts.operation.text };
	if (facts.working !== undefined) return { severity: "working", text: facts.working };
	if (facts.operation?.severity === "warning")
		return { severity: "warning", text: facts.operation.text };
	// A notice states that the app will decide without the operator, which is
	// the same fact a refusal states, so it wears the same prefix.
	if (facts.notice !== undefined) return { severity: "warning", text: facts.notice };
	if (facts.sourceHealth !== undefined) return { severity: "warning", text: facts.sourceHealth };
	return null;
}

export function formatMessage(fact: MessageFact): string {
	return `${prefixForSeverity(fact.severity)} ${fact.text}`;
}

/** The color of one Message fact: its severity, never the color alone. */
export function messageColor(fact: MessageFact | null): string {
	if (fact === null) return COLORS.text;
	return fact.severity === "error"
		? COLORS.statusError
		: fact.severity === "warning"
			? COLORS.statusWarning
			: COLORS.statusWorking;
}

/**
 * The Message line's own row: one row of the terminal's full width.
 *
 * It states its height, so a surface that lays it out above its Action bar
 * cannot have its rows pushed into the bar's row.
 */
export function messageRowElement(fact: MessageFact | null, width: number): ReactElement {
	return createElement(
		"text",
		{ style: { width: "100%", height: 1, fg: messageColor(fact) } },
		padToWidth(truncateToWidth(fact === null ? "" : formatMessage(fact), width), width),
	);
}
