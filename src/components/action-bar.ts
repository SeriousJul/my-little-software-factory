/**
 * The permanent, single-row contextual Action bar.
 *
 * One row of complete key hints, packed from the control catalogue: the
 * control module owns the content and this module owns the layout. A hint is
 * a unit, so a narrow terminal drops whole hints by priority rather than
 * breaking one in half.
 *
 * One hint is the anchor, and the catalogue marks it: the control the operator
 * cannot do without. That is Help on a bar that can open the Key guide, the
 * only way to find out what the other keys were, and the surface's own Close
 * on a utility overlay, where it outranks Help because it ends the screen the
 * operator is already on. The anchor keeps its cells at the row's end, so it
 * costs the other hints width instead of competing with them, and a frame too
 * narrow for its whole hint states one of its whole keys instead of a slice.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";

import {
	actionBarControls,
	availabilityFor,
	type ControlContext,
	type ControlDefinition,
	compactKeyLabels,
	type InteractionMode,
	keyLabelFor,
} from "./controls.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

interface ActionBarProps {
	mode: InteractionMode;
	context: ControlContext;
	/**
	 * The cells the row may fill, handed down by the surface that measured it.
	 *
	 * The bar never asks the renderer for its size: every `useTerminalDimensions`
	 * call adds a real `resize` listener, and a surface stacked above the base
	 * frame would otherwise add three of its own on top of the frame's. Ten is
	 * Node's default maximum for one emitter, so a nested stack would cross it
	 * on an ordinary operator path and write a `MaxListenersExceededWarning`
	 * into the terminal the operator is reading.
	 */
	width: number;
	/** Utility bars may show a range between Scroll and Close. */
	rangeIndicator?: string;
	/** A compact row that states the anchor alone, for terminals below the useful size. */
	compactAnchor?: boolean;
}

interface PackedControl {
	control: ControlDefinition;
	keyLabel: string;
	availability: ReturnType<typeof availabilityFor>;
}

/** The row as it is laid out: the hints, their measured width, and the anchor. */
interface PackedBar {
	left: PackedControl[];
	/** The cells the left hints and the range indicator take, gaps included. */
	leftWidth: number;
	anchor: PackedControl | undefined;
	range: string | undefined;
	/** True for the compact frame's row, where the anchor is the only hint. */
	anchorOnly: boolean;
}

const GAP = 2;

/**
 * Pack complete hints. A hint is removed as a unit, starting with the lowest
 * priority. The original order of every remaining hint is unchanged.
 *
 * The anchor is never packed away: it keeps its own cells at the right end of
 * the row, so it costs the other hints width rather than competing with them.
 */
function packActionBar(
	controls: readonly ControlDefinition[],
	context: ControlContext,
	width: number,
	options: { rangeIndicator?: string; anchorOnly?: boolean } = {},
): PackedBar {
	const entries = controls.map((control) => ({
		control,
		keyLabel: keyLabelFor(context.mode, control),
		availability: availabilityFor(control, context),
	}));
	// Where a bar carries two anchors, the one that outranks the rest holds the
	// cells: a utility overlay's Close beats its Help, because it ends the
	// screen the operator is already on.
	let anchor: PackedControl | undefined;
	for (const entry of entries) {
		if (entry.control.barAnchor !== true) continue;
		if (anchor === undefined || entry.control.priority > anchor.control.priority) anchor = entry;
	}
	// The compact row states the anchor alone: on a frame this broken nothing
	// else is a control the operator can act on.
	const candidates = options.anchorOnly === true ? [] : entries.filter((entry) => entry !== anchor);
	let range = options.rangeIndicator;
	const widthOfHint = (entry: PackedControl): number =>
		widthOf(`${entry.keyLabel} ${entry.control.label}`);
	const anchorWidth = anchor === undefined ? 0 : widthOfHint(anchor);
	const availableWidth = Math.max(0, width - (anchor === undefined ? 0 : anchorWidth + GAP));
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
	return { left: selected, leftWidth, anchor, range, anchorOnly: options.anchorOnly === true };
}

/**
 * The one key form a frame this narrow can state for the anchor.
 *
 * The anchor is the last discoverable control, so it is the last thing cut:
 * never part of a multi-cell binding, because a cut `F1` reads as `F`. Where
 * `?` is one of its keys it is the one-cell form, and where even that does not
 * fit the row states nothing and leaves its width to the frame.
 */
function fitAnchorHint(anchor: PackedControl, mode: InteractionMode, width: number): string {
	const full = `${anchor.keyLabel} ${anchor.control.label}`;
	if (widthOf(full) <= width) return full;
	for (const key of compactKeyLabels(mode, anchor.control)) if (widthOf(key) <= width) return key;
	return "";
}

export function ActionBar({ mode, context, width, rangeIndicator, compactAnchor }: ActionBarProps) {
	const controls = actionBarControls(mode, context);
	const packed = packActionBar(controls, context, width, {
		rangeIndicator,
		anchorOnly: compactAnchor,
	});
	const anchor = packed.anchor;
	const anchorText = anchor === undefined ? "" : `${anchor.keyLabel} ${anchor.control.label}`;
	// A frame that cannot hold the anchor's whole hint states as little of it
	// as still names a key, and states nothing else: this is the row a compact
	// frame shows, and the row no packing may leave the anchor off.
	if (anchor !== undefined && widthOf(anchorText) > width)
		return createElement(
			"text",
			{ style: { width: "100%", height: 1 } },
			padToWidth(truncateToWidth(fitAnchorHint(anchor, mode, width), width), width),
		);
	// The compact row left-aligns its one hint; a full bar keeps the anchor in
	// its own cells at the right end of the row.
	const leftWidth = packed.leftWidth;
	const anchorStart =
		anchor === undefined || packed.anchorOnly
			? leftWidth
			: Math.max(leftWidth + (leftWidth > 0 ? GAP : 0), width - widthOf(anchorText));
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
	if (anchor !== undefined) {
		const gap = Math.max(0, anchorStart - leftWidth);
		if (gap > 0) children.push(createElement("span", { key: "anchor-gap" }, " ".repeat(gap)));
		children.push(...hintSpans(anchor, "anchor"));
	}
	const used = anchorStart + (anchor === undefined ? 0 : widthOf(anchorText));
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
