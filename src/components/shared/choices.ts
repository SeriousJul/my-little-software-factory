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
import { Fragment, type ReactElement, useRef, useState } from "react";

import type { ActionRow } from "../modal-chrome.ts";
import { padToWidth, truncateTailToWidth, truncateToWidth } from "../text.ts";
import { controlInk, MARKER_WIDTH, markerText } from "./presentation.ts";

/** One row of a form that holds no text: its label and its current value. */
export interface ChoiceHandle<T> {
	/** The current value, or undefined when the choice has no options. */
	value(): T | undefined;
	/** Move by a wrapped step and return the value now selected. */
	cycle(delta: number): T | undefined;
}

/**
 * The wrapped choice behavior shared by every selector row.
 *
 * The caller supplies the current options and owns what a selected value does;
 * this module owns the index, wrapping, and the empty-value rule.
 */
export function useChoice<T>(options: readonly T[], initial: T | undefined): ChoiceHandle<T> {
	const initialIndex = Math.max(0, initial === undefined ? 0 : options.indexOf(initial));
	const [index, setIndex] = useState(initialIndex);
	const indexRef = useRef(index);
	const currentIndex = () =>
		options.length === 0 ? -1 : Math.min(Math.max(0, indexRef.current), options.length - 1);
	return {
		value: () => {
			const at = currentIndex();
			return at < 0 ? undefined : options[at];
		},
		cycle: (delta: number) => {
			if (options.length === 0) return undefined;
			const at = currentIndex();
			const next = (at + delta + options.length) % options.length;
			indexRef.current = next;
			setIndex(next);
			return options[next];
		},
	};
}

/** Return the wrapped choice after the current value, including an unset value. */
export function cycleChoice<T>(
	options: readonly T[],
	current: T | undefined,
	delta: number,
): T | undefined {
	if (options.length === 0) return undefined;
	const index = current === undefined ? -1 : options.indexOf(current);
	const next =
		index < 0
			? delta > 0
				? 0
				: options.length - 1
			: (index + delta + options.length) % options.length;
	return options[next];
}

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
	/** Whether a value is pending verification and must stay dim. */
	muted?: boolean;
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
			: props.muted === true || empty
				? ink.detail
				: props.focused
					? ink.focusedText
					: ink.text;
	const valueWidth = Math.max(1, props.width);
	const shown = empty ? (props.placeholder ?? "") : props.value;
	const noteWidth = 2 + props.labelWidth + valueWidth;
	return createElement(
		Fragment,
		{},
		createElement(
			"box",
			{ key: "row", style: { flexDirection: "row", height: 1 } },
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
		),
		props.error === null || props.error === undefined
			? null
			: createElement(
					"text",
					{ key: "error", style: { width: "100%", height: 1 }, fg: ink.error.fg ?? undefined },
					truncateToWidth(`Error: ${props.label}: ${props.error}`, noteWidth),
				),
		props.hint === null || props.hint === undefined
			? null
			: createElement(
					"text",
					{ key: "hint", style: { width: "100%", height: 1 }, fg: ink.detail.fg ?? undefined },
					truncateToWidth(props.hint, noteWidth),
				),
	);
}

/** The largest label column used by the shared action rows. */
const ACTION_LABEL_WIDTH = 20;

/** Render one action row with the active shared presentation. */
export function actionRowSpans(
	row: ActionRow,
	selected: boolean,
	contentWidth: number,
): ReactElement[] {
	const ink = controlInk();
	const markerWidth = Math.min(MARKER_WIDTH, contentWidth);
	const labelWidth = Math.min(ACTION_LABEL_WIDTH, Math.max(0, contentWidth - markerWidth));
	const detailWidth = Math.max(0, contentWidth - markerWidth - labelWidth);
	return [
		createElement(
			"span",
			{ key: "marker", fg: (selected ? ink.focusedText : ink.detail).fg ?? undefined },
			truncateToWidth(selected ? "❯ " : "  ", markerWidth),
		),
		createElement(
			"span",
			{ key: "label", fg: (selected ? ink.focusedText : ink.text).fg ?? undefined },
			truncateToWidth(padToWidth(`${row.label} `, labelWidth), labelWidth),
		),
		createElement(
			"span",
			{ key: "detail", fg: ink.detail.fg ?? undefined },
			detailWidth > 0 ? truncateToWidth(row.detail ?? "", detailWidth) : "",
		),
	];
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
