/**
 * The shared choice and action rows a form surface offers beside its fields.
 *
 * A selector states its label, its current value, and a written word for the
 * state that leaves it with nothing to choose. An action states its label and,
 * when it cannot run, the reason. Neither row carries its meaning on color
 * alone, and both use the same marker column the fields use, so a form reads as
 * one screen rather than as a set of widgets.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";

import { type ActionRow, actionRowSpans, MARKER_WIDTH } from "../modal-chrome.ts";
import { padToWidth, truncateTailToWidth, truncateToWidth } from "../text.ts";
import { type ControlInk, controlInk, markerText } from "./presentation.ts";

/** One row of a form that holds no text: its label and its current value. */
export interface ChoiceRowProps {
	label: string;
	/** The value the choice stands on now. */
	value: string;
	focused: boolean;
	/** The cells the value column holds, after the marker and the label. */
	width: number;
	/** The cells the shared label column holds. */
	labelWidth: number;
	/** The written word that states why the row holds no value. */
	placeholder?: string;
	/** Why this choice cannot be used, in the caller's words. */
	error?: string | null;
	/** Whether the value stands for something the target cannot take. */
	warning?: boolean;
	/** Show the end of a value wider than the column, where lists differ. */
	clipTail?: boolean;
	/** The written guide line under the row. */
	hint?: string | null;
}

/** The selector row: a label, a value, and the state word beside them. */
export function ChoiceRow(props: ChoiceRowProps): ReactElement {
	const ink = controlInk();
	const empty = props.value === "";
	const color =
		props.warning === true
			? ink.warning
			: empty
				? ink.detail
				: props.focused
					? ink.focusedText
					: ink.text;
	const valueWidth = Math.max(1, props.width);
	const shown = empty ? (props.placeholder ?? "") : props.value;
	return createElement(
		"box",
		{ key: props.label, style: { flexDirection: "row", height: 1 } },
		createElement(
			"text",
			{ fg: props.focused ? (ink.focusedText.fg ?? undefined) : (ink.detail.fg ?? undefined) },
			markerText(props.focused),
		),
		createElement(
			"text",
			{ fg: props.focused ? (ink.focusedText.fg ?? undefined) : (ink.detail.fg ?? undefined) },
			padToWidth(truncateToWidth(`${props.label} `, props.labelWidth), props.labelWidth),
		),
		createElement(
			"text",
			{ width: valueWidth, fg: color.fg ?? undefined },
			props.clipTail === true && !empty
				? truncateTailToWidth(shown, valueWidth)
				: truncateToWidth(shown, valueWidth),
		),
	);
}

/**
 * One visible action of a form.
 *
 * The row is the action: the operator reaches it with Tab and runs it with
 * Enter, so no essential submission depends on a modified key the terminal may
 * not be able to tell apart. `refusal` states why the action cannot run, and
 * the row carries it as text.
 */
export function ActionItem(props: {
	row: ActionRow;
	focused: boolean;
	width: number;
	refusal?: string | null;
}): ReactElement {
	const ink = controlInk();
	return createElement(
		"box",
		{ key: props.row.key, style: { flexDirection: "column" } },
		createElement(
			"text",
			{ style: { width: "100%", height: 1 } },
			...actionRowSpans(props.row, props.focused, props.width),
		),
		props.refusal === null || props.refusal === undefined
			? null
			: createElement(
					"text",
					{ style: { width: "100%", height: 1 }, fg: ink.error.fg ?? undefined },
					truncateToWidth(`Unavailable: ${props.row.label}: ${props.refusal}`, props.width),
				),
	);
}
