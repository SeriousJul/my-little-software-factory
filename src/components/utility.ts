/** The mutually exclusive Key guide and Message view utility overlays. */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { ActionBar } from "./action-bar.ts";
import {
	availabilityFor,
	type ControlContext,
	contextFor,
	guideControls,
	guideKeyLabel,
	modeTitle,
} from "./controls.ts";
import { formatMessage, type MessageFact } from "./messages.ts";
import { padToWidth, truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { COLORS, prefixForSeverity } from "./theme.ts";

interface UtilityFrameProps {
	context: ControlContext;
	onClose: () => void;
	onHelp: () => void;
	onMessage?: () => void;
}

export function KeyGuide({ context, onClose, onMessage }: UtilityFrameProps) {
	const { width, height } = useTerminalDimensions();
	const [scroll, setScroll] = useState(0);
	const mode = context.mode;
	const entries = useMemo(() => guideControls(mode), [mode]);
	const modalWidth = Math.max(1, Math.min(100, Math.max(1, width - 2)));
	const modalHeight = Math.max(1, Math.min(24, Math.max(1, height - 2)));
	const contentWidth = Math.max(1, modalWidth - 4);
	const fullTitle = `Key guide - ${modeTitle(mode)}`;
	const modalTitle = widthOf(fullTitle) <= contentWidth ? fullTitle : "Key guide";
	const rows = useMemo(
		() => guideRows(entries, context, contentWidth),
		[entries, context, contentWidth],
	);
	const visibleRows = Math.max(1, modalHeight - 5);
	const maxScroll = Math.max(0, rows.length - visibleRows);
	const currentScroll = Math.min(scroll, maxScroll);
	const visible = rows.slice(currentScroll, currentScroll + visibleRows);
	useEffect(() => {
		setScroll((current) => Math.min(current, maxScroll));
	}, [maxScroll]);

	useKeyboard((key) => {
		if (key.ctrl || key.meta) return;
		switch (key.name) {
			case "escape":
			case "f1":
			case "?":
				onClose();
				return;
			case "f2":
				if (context.messageTruncated) onMessage?.();
				return;
			case "up":
			case "k":
				setScroll((current) => Math.max(0, current - 1));
				return;
			case "down":
			case "j":
				setScroll((current) => Math.min(maxScroll, current + 1));
				return;
			default:
				return;
		}
	});

	const utilityContext = contextFor("key-guide", context);
	const range = `${rows.length === 0 ? 0 : currentScroll + 1}-${Math.min(rows.length, currentScroll + visible.length)}/${rows.length}`;
	return createElement(
		"box",
		{ style: utilitySurface() },
		createElement(
			"box",
			{
				border: true,
				borderColor: COLORS.borderFocused,
				title: modalTitle,
				padding: 1,
				style: {
					width: modalWidth,
					height: modalHeight,
					flexDirection: "column",
					overflow: "hidden",
				},
			},
			createElement("text", { fg: COLORS.dim }, truncateToWidth(modeTitle(mode), contentWidth)),
			...visible.map((row, index) =>
				guideRowElement(row, contentWidth, `${currentScroll}-${index}`),
			),
		),
		createElement(ActionBar, {
			mode: "key-guide",
			context: utilityContext,
			rangeIndicator: range,
			overlay: true,
		}),
	);
}

export function MessageView({
	fact,
	context,
	onClose,
	onHelp,
}: UtilityFrameProps & { fact: MessageFact }) {
	const { width, height } = useTerminalDimensions();
	const [scroll, setScroll] = useState(0);
	const modalWidth = Math.max(1, Math.min(100, Math.max(1, width - 2)));
	const modalHeight = Math.max(1, Math.min(24, Math.max(1, height - 2)));
	const contentWidth = Math.max(1, modalWidth - 4);
	const fullTitle = `Message view - ${prefixForSeverity(fact.severity)}`;
	const modalTitle = widthOf(fullTitle) <= contentWidth ? fullTitle : "Message view";
	const wrapped = useMemo(
		() =>
			formatMessage(fact)
				.split("\n")
				.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, contentWidth))),
		[fact, contentWidth],
	);
	const visibleRows = Math.max(1, modalHeight - 5);
	const maxScroll = Math.max(0, wrapped.length - visibleRows);
	const currentScroll = Math.min(scroll, maxScroll);
	const visible = wrapped.slice(currentScroll, currentScroll + visibleRows);
	useEffect(() => {
		setScroll((current) => Math.min(current, maxScroll));
	}, [maxScroll]);

	useKeyboard((key) => {
		if (key.ctrl || key.meta) return;
		switch (key.name) {
			case "escape":
			case "f2":
				onClose();
				return;
			case "f1":
			case "?":
				onHelp();
				return;
			case "up":
			case "k":
				setScroll((current) => Math.max(0, current - 1));
				return;
			case "down":
			case "j":
				setScroll((current) => Math.min(maxScroll, current + 1));
				return;
			default:
				return;
		}
	});

	return createElement(
		"box",
		{ style: utilitySurface() },
		createElement(
			"box",
			{
				border: true,
				borderColor: fact.severity === "error" ? COLORS.statusError : COLORS.borderFocused,
				title: modalTitle,
				padding: 1,
				style: {
					width: modalWidth,
					height: modalHeight,
					flexDirection: "column",
					overflow: "hidden",
				},
			},
			createElement(
				"text",
				{ fg: COLORS.dim },
				truncateToWidth(prefixForSeverity(fact.severity), contentWidth),
			),
			...visible.map((line, index) =>
				createElement(
					"text",
					{ key: `${currentScroll}-${index}`, fg: colorForSeverity(fact.severity) },
					padToWidth(truncateToWidth(line, contentWidth), contentWidth),
				),
			),
		),
		createElement(ActionBar, {
			mode: "message-view",
			context: contextFor("message-view", context),
			rangeIndicator: `${wrapped.length === 0 ? 0 : currentScroll + 1}-${Math.min(wrapped.length, currentScroll + visible.length)}/${wrapped.length}`,
			overlay: true,
		}),
	);
}

interface GuideRow {
	group?: string;
	keys?: string;
	label?: string;
	reason?: string;
	controlId?: string;
}

function guideRows(
	entries: ReturnType<typeof guideControls>,
	context: ControlContext,
	width: number,
): GuideRow[] {
	const rows: GuideRow[] = [];
	let group = "";
	for (const entry of entries) {
		if (entry.group !== group) {
			group = entry.group;
			rows.push({ group });
		}
		const isCurrent = entry.control.modes.includes(context.mode);
		const availability = isCurrent ? availabilityFor(entry.control, context) : { available: true };
		let reason = availability.available ? undefined : availability.reason;
		if (entry.control.id === "emergency-exit")
			reason = "may require Handoff recovery on the next start";
		rows.push({
			keys: guideKeyLabel(context.mode, entry.control),
			label: entry.control.label,
			reason,
			controlId: entry.control.id,
		});
	}
	return alignGuideRows(rows, width);
}

function alignGuideRows(rows: GuideRow[], width: number): GuideRow[] {
	const widestKeys = Math.min(18, Math.max(1, ...rows.map((row) => widthOf(row.keys ?? ""))));
	// Keep two cells for the column gap and give labels the remaining room,
	// while preserving aligned columns on a narrow guide.
	const keyWidth = Math.min(widestKeys, Math.max(1, Math.floor(Math.max(1, width - 2) / 3)));
	const labelWidth = Math.min(28, Math.max(0, width - keyWidth - 2));
	return rows.map((row) => {
		if (row.group !== undefined) return row;
		const reason = row.reason === undefined ? "" : ` - ${row.reason}`;
		const text = `${padToWidth(row.keys ?? "", keyWidth)}  ${padToWidth(row.label ?? "", labelWidth)}${reason}`;
		if (widthOf(text) <= width)
			return {
				...row,
				keys: padToWidth(row.keys ?? "", keyWidth),
				label: padToWidth(row.label ?? "", labelWidth),
			};
		const room = Math.max(1, width - keyWidth - labelWidth - 4);
		return {
			...row,
			keys: padToWidth(truncateToWidth(row.keys ?? "", keyWidth), keyWidth),
			label: padToWidth(truncateToWidth(row.label ?? "", labelWidth), labelWidth),
			reason: truncateToWidth(reason, room),
		};
	});
}

function guideRowElement(row: GuideRow, width: number, key: string): ReactElement {
	if (row.group !== undefined)
		return createElement("text", { key, fg: COLORS.textBright }, truncateToWidth(row.group, width));
	const reason = row.reason === undefined ? "" : ` - ${row.reason}`;
	const unavailable = row.reason !== undefined && row.controlId !== "emergency-exit";
	return createElement(
		"text",
		{ key },
		createElement("span", { fg: unavailable ? COLORS.dim : COLORS.borderFocused }, row.keys ?? ""),
		createElement("span", { fg: unavailable ? COLORS.dim : COLORS.text }, `  ${row.label ?? ""}`),
		createElement(
			"span",
			{ fg: COLORS.dim },
			truncateToWidth(
				reason,
				Math.max(0, width - widthOf(row.keys ?? "") - widthOf(`  ${row.label ?? ""}`)),
			),
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
