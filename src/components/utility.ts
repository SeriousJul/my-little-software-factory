/** The mutually exclusive Key guide and Message view utility overlays. */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { ActionBar } from "./action-bar.ts";
import {
	availabilityFor,
	type ControlContext,
	contextFor,
	controlForKey,
	guideControls,
	guideKeyLabel,
	type InteractionMode,
	modeTitle,
} from "./controls.ts";
import type { MessageFact } from "./messages.ts";
import { padToWidth, truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { COLORS, prefixForSeverity } from "./theme.ts";

/** The shared modal geometry: one border and one padding cell per side. */
function utilityGeometry(width: number, height: number) {
	const modalWidth = Math.max(1, Math.min(100, Math.max(1, width - 2)));
	const modalHeight = Math.max(1, Math.min(24, Math.max(1, height - 2)));
	return { modalWidth, modalHeight, contentWidth: Math.max(1, modalWidth - 4) };
}

/** The shared scroll clamp: content changes never leave the cursor past the end. */
function useClampedScroll(maxScroll: number) {
	const [scroll, setScroll] = useState(0);
	useEffect(() => {
		setScroll((current) => Math.min(current, maxScroll));
	}, [maxScroll]);
	return {
		scroll: Math.min(scroll, maxScroll),
		scrollBy: (delta: number) =>
			setScroll((current) => Math.max(0, Math.min(maxScroll, current + delta))),
	};
}

interface UtilityKeyHandlers {
	close: () => void;
	help: () => void;
	message: () => void;
	scroll: (delta: number) => void;
	emergencyExit: () => void;
}

/**
 * The shared key dispatch of a utility overlay: the control catalogue owns
 * the bindings, the availability check, and the emergency exit.
 */
function useUtilityKeys(
	mode: InteractionMode,
	context: ControlContext,
	handlers: UtilityKeyHandlers,
): void {
	useKeyboard((key) => {
		if (key.meta) return;
		const utilityContext = contextFor(mode, context);
		const control = controlForKey(mode, key, utilityContext);
		if (control === undefined || !availabilityFor(control, utilityContext).available) return;
		switch (control.id) {
			case "emergency-exit":
				handlers.emergencyExit();
				return;
			case "guide-close":
			case "message-close":
				handlers.close();
				return;
			case "help":
				handlers.help();
				return;
			case "message":
				handlers.message();
				return;
			case "guide-scroll":
			case "message-scroll":
				handlers.scroll(key.name === "up" || key.name === "k" ? -1 : 1);
				return;
			default:
				return;
		}
	});
}

/** The shared modal surface and frame, with the utility Action bar below it. */
function utilityFrame(
	geometry: ReturnType<typeof utilityGeometry>,
	title: string,
	borderColor: string,
	body: ReactElement[],
	role: {
		mode: InteractionMode;
		context: ControlContext;
		rangeIndicator: string;
	},
): ReactElement {
	return createElement(
		"box",
		{ style: utilitySurface() },
		createElement(
			"box",
			{
				border: true,
				borderColor,
				title,
				padding: 1,
				style: {
					width: geometry.modalWidth,
					height: geometry.modalHeight,
					flexDirection: "column",
					overflow: "hidden",
				},
			},
			...body,
		),
		createElement(ActionBar, {
			mode: role.mode,
			context: role.context,
			rangeIndicator: role.rangeIndicator,
			overlay: true,
		}),
	);
}

interface KeyGuideProps {
	context: ControlContext;
	onClose: () => void;
	onHelp: () => void;
	onMessage?: () => void;
	onEmergencyExit: () => void;
}

export function KeyGuide({ context, onClose, onMessage, onEmergencyExit }: KeyGuideProps) {
	const { width, height } = useTerminalDimensions();
	const mode = context.mode;
	const entries = useMemo(() => guideControls(mode, context), [mode, context]);
	const geometry = utilityGeometry(width, height);
	const { modalHeight, contentWidth } = geometry;
	const fullTitle = `Key guide - ${modeTitle(mode)}`;
	const modalTitle = widthOf(fullTitle) <= contentWidth ? fullTitle : "Key guide";
	const rows = useMemo(
		() => guideRows(entries, context, contentWidth),
		[entries, context, contentWidth],
	);
	// Five chrome rows: both borders, both paddings, and the mode name.
	const visibleRows = Math.max(1, modalHeight - 5);
	const { scroll, scrollBy } = useClampedScroll(Math.max(0, rows.length - visibleRows));
	const visible = rows.slice(scroll, scroll + visibleRows);

	useUtilityKeys("key-guide", context, {
		close: onClose,
		help: onClose,
		message: () => onMessage?.(),
		scroll: scrollBy,
		emergencyExit: onEmergencyExit,
	});

	const utilityContext = contextFor("key-guide", context);
	const range = rangeIndicator(scroll, visible.length, rows.length);
	return utilityFrame(
		geometry,
		modalTitle,
		COLORS.borderFocused,
		[
			createElement("text", { fg: COLORS.dim }, truncateToWidth(modeTitle(mode), contentWidth)),
			...visible.map((row, index) => guideRowElement(row, contentWidth, `${scroll}-${index}`)),
		],
		{ mode: "key-guide", context: utilityContext, rangeIndicator: range },
	);
}

interface MessageViewProps extends KeyGuideProps {
	fact: MessageFact;
}

export function MessageView({ fact, context, onClose, onHelp, onEmergencyExit }: MessageViewProps) {
	const { width, height } = useTerminalDimensions();
	const geometry = utilityGeometry(width, height);
	const { modalHeight, contentWidth } = geometry;
	const fullTitle = `Message view - ${prefixForSeverity(fact.severity).slice(0, -1)}`;
	const modalTitle = widthOf(fullTitle) <= contentWidth ? fullTitle : "Message view";
	const wrapped = useMemo(
		() =>
			fact.text
				.split("\n")
				.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, contentWidth))),
		[fact, contentWidth],
	);
	// Four chrome rows: both borders and both paddings.
	const visibleRows = Math.max(1, modalHeight - 4);
	const { scroll, scrollBy } = useClampedScroll(Math.max(0, wrapped.length - visibleRows));
	const visible = wrapped.slice(scroll, scroll + visibleRows);

	useUtilityKeys("message-view", context, {
		close: onClose,
		help: onHelp,
		message: onHelp,
		scroll: scrollBy,
		emergencyExit: onEmergencyExit,
	});

	const range = rangeIndicator(scroll, visible.length, wrapped.length);
	return utilityFrame(
		geometry,
		modalTitle,
		fact.severity === "error" ? COLORS.statusError : COLORS.borderFocused,
		visible.map((line, index) =>
			createElement(
				"text",
				{ key: `${scroll}-${index}`, fg: colorForSeverity(fact.severity) },
				padToWidth(truncateToWidth(line, contentWidth), contentWidth),
			),
		),
		{ mode: "message-view", context: contextFor("message-view", context), rangeIndicator: range },
	);
}

/** The compact visible-range indicator: first-last/total of the rows. */
function rangeIndicator(scroll: number, visibleCount: number, total: number): string {
	return `${total === 0 ? 0 : scroll + 1}-${Math.min(total, scroll + visibleCount)}/${total}`;
}

type GuideLine =
	| { kind: "group"; group: string }
	| { kind: "control"; keys: string; label: string; reason?: string; controlId: string };

function guideRows(
	entries: ReturnType<typeof guideControls>,
	context: ControlContext,
	width: number,
): GuideLine[] {
	const rows: GuideLine[] = [];
	let group = "";
	for (const entry of entries) {
		if (entry.group !== group) {
			group = entry.group;
			rows.push({ kind: "group", group });
		}
		const isCurrent = entry.control.modes.includes(context.mode);
		const availability = isCurrent ? availabilityFor(entry.control, context) : { available: true };
		let reason = availability.available ? undefined : availability.reason;
		if (entry.control.id === "emergency-exit")
			reason = "may require Handoff recovery on the next start";
		rows.push({
			kind: "control",
			keys: guideKeyLabel(context.mode, entry.control),
			label: entry.control.label,
			reason,
			controlId: entry.control.id,
		});
	}
	return alignGuideRows(rows, width);
}

function alignGuideRows(rows: GuideLine[], width: number): GuideLine[] {
	const widestKeys = Math.min(
		18,
		Math.max(
			1,
			...rows
				.filter((row): row is Extract<GuideLine, { kind: "control" }> => row.kind === "control")
				.map((row) => widthOf(row.keys)),
		),
	);
	// Keep two cells for the column gap and give labels the remaining room,
	// while preserving aligned columns on a narrow guide.
	const keyWidth = Math.min(widestKeys, Math.max(1, Math.floor(Math.max(1, width - 2) / 3)));
	const labelWidth = Math.min(28, Math.max(0, width - keyWidth - 2));
	return rows.map((row) => {
		if (row.kind === "group") return row;
		const reason = row.reason === undefined ? "" : ` - ${row.reason}`;
		const text = `${padToWidth(row.keys, keyWidth)}  ${padToWidth(row.label, labelWidth)}${reason}`;
		if (widthOf(text) <= width)
			return {
				...row,
				keys: padToWidth(row.keys, keyWidth),
				label: padToWidth(row.label, labelWidth),
			};
		// Truncate the raw reason: the row element adds the " - " prefix at
		// render time, so a prefixed string here would render a double dash.
		const room = Math.max(1, width - keyWidth - labelWidth - 4);
		return {
			...row,
			keys: padToWidth(truncateToWidth(row.keys, keyWidth), keyWidth),
			label: padToWidth(truncateToWidth(row.label, labelWidth), labelWidth),
			reason: row.reason === undefined ? undefined : truncateToWidth(row.reason, room),
		};
	});
}

function guideRowElement(row: GuideLine, width: number, key: string): ReactElement {
	if (row.kind === "group")
		return createElement("text", { key, fg: COLORS.textBright }, truncateToWidth(row.group, width));
	const reason = row.reason === undefined ? "" : ` - ${row.reason}`;
	const unavailable = row.reason !== undefined && row.controlId !== "emergency-exit";
	return createElement(
		"text",
		{ key },
		createElement("span", { fg: unavailable ? COLORS.dim : COLORS.borderFocused }, row.keys),
		createElement("span", { fg: unavailable ? COLORS.dim : COLORS.text }, `  ${row.label}`),
		createElement(
			"span",
			{ fg: COLORS.dim },
			truncateToWidth(reason, Math.max(0, width - widthOf(row.keys) - widthOf(`  ${row.label}`))),
		),
	);
}

function utilitySurface(): Record<string, unknown> {
	return {
		position: "absolute",
		top: 0,
		left: 0,
		width: "100%",
		height: "100%",
		zIndex: 20,
		backgroundColor: COLORS.overlay,
		alignItems: "center",
		justifyContent: "center",
	};
}

function colorForSeverity(severity: MessageFact["severity"]): string {
	return severity === "error"
		? COLORS.statusError
		: severity === "warning"
			? COLORS.statusWarning
			: COLORS.statusWorking;
}
