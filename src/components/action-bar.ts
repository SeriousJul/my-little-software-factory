/**
 * The permanent, single-row contextual Action bar.
 *
 * One row of complete key hints, packed from the control catalogue: the
 * control module owns the content and this module owns the layout. A hint is
 * a unit, so a narrow terminal drops whole hints by priority rather than
 * breaking one in half. Help keeps its row to the end because it is the only
 * way to find out what the other keys were.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";

import {
	actionBarControls,
	availabilityFor,
	type ControlContext,
	type ControlDefinition,
	type InteractionMode,
	keyLabelFor,
} from "./controls.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

interface ActionBarProps {
	mode: InteractionMode;
	context: ControlContext;
	/** Utility bars may show a range between Scroll and Close. */
	rangeIndicator?: string;
	/** A compact Help-only row for terminals below the useful size. */
	compactHelp?: boolean;
}

interface PackedControl {
	control: ControlDefinition;
	keyLabel: string;
	availability: ReturnType<typeof availabilityFor>;
}

/** The row as it is laid out: the hints, their measured width, and Help. */
interface PackedBar {
	left: PackedControl[];
	/** The cells the left hints and the range indicator take, gaps included. */
	leftWidth: number;
	help: PackedControl | undefined;
	range: string | undefined;
	/** True for the compact frame's row, where Help is the only hint. */
	helpOnly: boolean;
}

const GAP = 2;

/**
 * Pack complete hints. A hint is removed as a unit, starting with the lowest
 * priority. The original order of every remaining hint is unchanged.
 *
 * Help is never packed away: it keeps its own cells at the right end of the
 * row, so it costs the other hints width rather than competing with them.
 */
function packActionBar(
	controls: readonly ControlDefinition[],
	context: ControlContext,
	width: number,
	options: { rangeIndicator?: string; helpOnly?: boolean } = {},
): PackedBar {
	const entries = controls
		.filter((control) => control.actionBar)
		.map((control) => ({
			control,
			keyLabel: keyLabelFor(context.mode, control),
			availability: availabilityFor(control, context),
		}));
	const help = entries.find((entry) => entry.control.id === "help");
	// The compact row states Help alone: on a frame this broken nothing else
	// is a control the operator can act on.
	const candidates = options.helpOnly === true ? [] : entries.filter((entry) => entry !== help);
	let range = options.rangeIndicator;
	const helpWidth = help === undefined ? 0 : widthOf(`${help.keyLabel} ${help.control.label}`);
	const availableWidth = Math.max(0, width - (help === undefined ? 0 : helpWidth + GAP));
	const widthOfHint = (entry: PackedControl): number =>
		widthOf(`${entry.keyLabel} ${entry.control.label}`);
	const fits = (items: readonly PackedControl[], includeRange: boolean): boolean => {
		const itemWidth = items.reduce((total, entry) => total + widthOfHint(entry), 0);
		const gaps = Math.max(0, items.length - 1) * GAP + (includeRange ? GAP : 0);
		const indicatorWidth = includeRange && range !== undefined ? widthOf(range) : 0;
		return itemWidth + gaps + indicatorWidth <= availableWidth;
	};
	const selected = [...candidates];
	while (range !== undefined && !fits(selected, true)) range = undefined;
	while (!fits(selected, false) && selected.length > 0) {
		let removeAt = 0;
		for (let i = 1; i < selected.length; i += 1) {
			if (selected[i].control.priority < selected[removeAt].control.priority) removeAt = i;
		}
		selected.splice(removeAt, 1);
	}
	const leftWidth =
		selected.reduce((total, entry) => total + widthOfHint(entry), 0) +
		Math.max(0, selected.length - 1) * GAP +
		(range === undefined ? 0 : GAP + widthOf(range));
	return { left: selected, leftWidth, help, range, helpOnly: options.helpOnly === true };
}

/**
 * The one hint of Help a frame this narrow can state.
 *
 * Help is the last discoverable control, so it is the last thing cut: never
 * part of a multi-cell binding, because a cut `F1` reads as `F`. Where `?` is
 * a valid Help alias it is the one-cell form, and where even that does not
 * fit the row states nothing and leaves its width to the frame.
 */
function fitHelpHint(help: PackedControl, width: number): string {
	const full = `${help.keyLabel} ${help.control.label}`;
	if (widthOf(full) <= width) return full;
	const key = help.keyLabel.includes("?") ? "?" : help.keyLabel;
	return widthOf(key) <= width ? key : "";
}

export function ActionBar({ mode, context, rangeIndicator, compactHelp }: ActionBarProps) {
	const { width } = useTerminalDimensions();
	const controls = actionBarControls(mode, context);
	const packed = packActionBar(controls, context, width, {
		rangeIndicator,
		helpOnly: compactHelp,
	});
	const help = packed.help;
	const helpText = help === undefined ? "" : `${help.keyLabel} ${help.control.label}`;
	// A frame that cannot hold Help's whole hint states as little of it as
	// still fits, and states nothing else: this is the row a compact frame
	// shows, and the row no packing may leave Help off.
	if (help !== undefined && widthOf(helpText) > width)
		return createElement(
			"text",
			{ style: { width: "100%", height: 1 } },
			padToWidth(truncateToWidth(fitHelpHint(help, width), width), width),
		);
	// The compact row left-aligns its one hint; a full bar keeps Help in its
	// own cells at the right end of the row.
	const leftWidth = packed.leftWidth;
	const helpStart =
		help === undefined || packed.helpOnly
			? leftWidth
			: Math.max(leftWidth + (leftWidth > 0 ? GAP : 0), width - widthOf(helpText));
	const children: ReactElement[] = [];
	let rangePlaced = false;
	for (let i = 0; i < packed.left.length; i += 1) {
		if (i > 0) children.push(createElement("span", { key: `gap-${i}` }, " ".repeat(GAP)));
		children.push(...hintSpans(packed.left[i], `hint-${i}`));
		if (
			packed.range !== undefined &&
			["guide-scroll", "message-scroll"].includes(packed.left[i].control.id)
		) {
			children.push(createElement("span", { key: "range-gap" }, " ".repeat(GAP)));
			children.push(createElement("span", { key: "range", fg: COLORS.dim }, packed.range));
			rangePlaced = true;
		}
	}
	if (packed.range !== undefined && !rangePlaced) {
		if (packed.left.length > 0)
			children.push(createElement("span", { key: "range-gap" }, " ".repeat(GAP)));
		children.push(createElement("span", { key: "range", fg: COLORS.dim }, packed.range));
	}
	if (help !== undefined) {
		const gap = Math.max(0, helpStart - leftWidth);
		if (gap > 0) children.push(createElement("span", { key: "help-gap" }, " ".repeat(gap)));
		children.push(...hintSpans(help, "help"));
	}
	const used = helpStart + (help === undefined ? 0 : widthOf(helpText));
	if (used < width) children.push(createElement("span", { key: "tail" }, " ".repeat(width - used)));
	return createElement("text", { style: { width: "100%", height: 1 } }, ...children);
}

function hintSpans(entry: PackedControl, key: string): ReactElement[] {
	const unavailable = !entry.availability.available;
	return [
		createElement(
			"span",
			{ key: `${key}-key`, fg: unavailable ? COLORS.dim : COLORS.borderFocused },
			`${entry.keyLabel} `,
		),
		createElement(
			"span",
			{ key: `${key}-label`, fg: unavailable ? COLORS.dim : COLORS.text },
			entry.control.label,
		),
	];
}
