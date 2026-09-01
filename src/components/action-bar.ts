/** The permanent, single-row contextual Action bar. */
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
	/** Draw over the current surface instead of taking normal layout space. */
	overlay?: boolean;
	/** A compact Help-only row for terminals below the useful size. */
	compactHelp?: boolean;
}

interface PackedControl {
	control: ControlDefinition;
	keyLabel: string;
	availability: ReturnType<typeof availabilityFor>;
}

interface PackedBar {
	left: PackedControl[];
	help: PackedControl | undefined;
	range: string | undefined;
}

const GAP = 2;

/**
 * Pack complete hints. A hint is removed as a unit, starting with the lowest
 * priority. The original order of every remaining hint is unchanged.
 */
export function packActionBar(
	controls: readonly ControlDefinition[],
	context: ControlContext,
	width: number,
	rangeIndicator?: string,
): PackedBar {
	const entries = controls
		.filter((control) => control.actionBar)
		.map((control) => ({
			control,
			keyLabel: keyLabelFor(context.mode, control),
			availability: availabilityFor(control, context),
		}));
	const help = entries.find((entry) => entry.control.id === "help");
	const candidates = entries.filter((entry) => entry !== help);
	let range = rangeIndicator;
	const helpText = help === undefined ? "" : `${help.keyLabel} ${help.control.label}`;
	const helpWidth = widthOf(helpText);
	const availableWidth = Math.max(0, width - (help === undefined ? 0 : helpWidth + GAP));
	const fits = (items: readonly PackedControl[], includeRange: boolean): boolean => {
		const itemWidth = items.reduce(
			(total, entry) => total + widthOf(`${entry.keyLabel} ${entry.control.label}`),
			0,
		);
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
	// At a very narrow width keep the key of Help even when its full hint does
	// not fit. This is the last discoverable control on a broken-size frame.
	if (help !== undefined && helpWidth > width) {
		// Never show part of a multi-cell binding. A partial `F1` as `F` is
		// ambiguous. Where `?` is a valid Help alias, it is the one-cell form.
		const keyLabel = help.keyLabel.includes("?")
			? "?"
			: width >= widthOf(help.keyLabel)
				? help.keyLabel
				: "";
		return { left: selected, help: keyLabel === "" ? undefined : { ...help, keyLabel }, range };
	}
	return { left: selected, help, range };
}

export function ActionBar({ mode, context, rangeIndicator, overlay, compactHelp }: ActionBarProps) {
	const { width } = useTerminalDimensions();
	const controls = actionBarControls(mode, context);
	const packed = compactHelp
		? compactHelpBar(mode, controls)
		: packActionBar(controls, context, width, rangeIndicator);
	const help = packed.help;
	if (compactHelp) {
		const compactKey = help?.keyLabel ?? "?";
		const compactText = `${compactKey} Help`;
		const text =
			widthOf(compactText) <= width
				? compactText
				: widthOf(compactKey) <= width
					? compactKey
					: compactKey.includes("?")
						? "?"
						: "";
		return createElement(
			"text",
			{
				style: overlay
					? { position: "absolute", left: 0, bottom: 0, width: "100%", height: 1, zIndex: 30 }
					: { width: "100%", height: 1 },
			},
			actionBarText(text, width),
		);
	}
	const leftWidth =
		packed.left.reduce(
			(total, entry) => total + widthOf(`${entry.keyLabel} ${entry.control.label}`),
			0,
		) +
		Math.max(0, packed.left.length - 1) * GAP +
		(packed.range === undefined ? 0 : GAP + widthOf(packed.range));
	const helpText = help === undefined ? "" : `${help.keyLabel} ${help.control.label}`;
	const helpStart =
		help === undefined
			? leftWidth
			: Math.max(leftWidth + (leftWidth > 0 ? GAP : 0), width - widthOf(helpText));
	const children: ReactElement[] = [];
	let rangePlaced = false;
	for (let i = 0; i < packed.left.length; i += 1) {
		if (i > 0) children.push(createElement("span", { key: `gap-${i}` }, " ".repeat(GAP)));
		children.push(...hintSpans(packed.left[i], `hint-${i}`));
		if (
			packed.range !== undefined &&
			["scroll-detail", "guide-scroll", "message-scroll"].includes(packed.left[i].control.id)
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
	const usedBeforeHelp = helpStart;
	if (help !== undefined) {
		const gap = Math.max(0, helpStart - leftWidth);
		if (gap > 0) children.push(createElement("span", { key: "help-gap" }, " ".repeat(gap)));
		children.push(...hintSpans(help, "help"));
	}
	const used = usedBeforeHelp + (help === undefined ? 0 : widthOf(helpText));
	if (used < width) children.push(createElement("span", { key: "tail" }, " ".repeat(width - used)));
	return createElement(
		"text",
		{
			style: overlay
				? { position: "absolute", left: 0, bottom: 0, width: "100%", height: 1, zIndex: 30 }
				: { width: "100%", height: 1 },
		},
		...children,
	);
}

function compactHelpBar(mode: InteractionMode, controls: readonly ControlDefinition[]): PackedBar {
	const control = controls.find((candidate) => candidate.id === "help");
	return {
		left: [],
		help:
			control === undefined
				? undefined
				: { control, keyLabel: keyLabelFor(mode, control), availability: availableResult() },
		range: undefined,
	};
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

function availableResult(): { available: true } {
	return { available: true };
}

/** Make a row that is exactly the terminal width when callers need plain text. */
export function actionBarText(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, width), width);
}
