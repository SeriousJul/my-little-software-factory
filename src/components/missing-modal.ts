/**
 * The missing modal: a read-only message, and the rows the operator can
 * confirm on it.
 *
 * The control plane opens it on an in-flight ticket whose pane herdr no
 * longer lists: restart the agent, or abandon the cycle. The awaiting
 * ticket's decision has its own modal, the decision modal, which carries
 * the turn log.
 *
 * The keys dispatch through the shared control catalogue in the
 * missing-modal interaction mode: up and down move the action rows, j/k
 * scroll the message, enter confirms the selected action, and esc cancels.
 * The shared Action bar names the controls, and the in-app Key guide
 * catalogs them. While it is open, the keys of the app below are disabled.
 */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { ActionBar } from "./action-bar.ts";
import { availabilityFor, type ControlContext, contextFor, controlForKey } from "./controls.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import { padToWidth, truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

/** One confirmable action, with its label and an optional detail. */
export interface ActionRow {
	key: string;
	label: string;
	detail?: string;
}

interface MissingModalProps {
	title: string;
	/** The read-only message rows shown above the actions, if any. */
	bodyLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	onCancel: () => void;
	/** The base control facts, preserved when this modal owns input. */
	context: ControlContext;
	/** False while a Key guide or Message view is above this modal. */
	inputActive?: boolean;
	onHelp?: () => void;
	onMessage?: () => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	onEmergencyExit: () => void;
}

/** The modal chrome: one border and one padding cell on each side. */
const CHROME = 4;
/** The marker column: "❯ " when the row is selected, two spaces otherwise. */
const MARKER_WIDTH = 2;
/** The label column: enough for the usual "Handoff: <type>" action. */
const LABEL_WIDTH = 20;
/** The body and action detail columns share this maximum width. */
const CONTENT_WIDTH = 80;
/** The message window is large enough for an agent's useful conclusion. */
const MAX_BODY_ROWS = 16;

interface PanelGeometry {
	contentWidth: number;
	maxBodyRows: number;
}

/**
 * Fit the panel within the terminal while preserving every action row.
 *
 * Message rows yield first when the terminal is short. The shared Action
 * bar sits outside the modal at the terminal bottom, so it never takes a
 * row from the message.
 */
function panelGeometry(width: number, height: number, actionRows: number): PanelGeometry {
	const contentWidth = Math.max(1, Math.min(CONTENT_WIDTH, width - CHROME));
	const innerRows = Math.max(0, height - CHROME);
	const maxBodyRows = Math.min(MAX_BODY_ROWS, Math.max(0, innerRows - actionRows));
	return { contentWidth, maxBodyRows };
}

/** Wrap the message, retaining explicit blank lines. */
function wrapBody(lines: readonly string[], width: number): string[] {
	return lines.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, width)));
}

export function MissingModal({
	title,
	bodyLines,
	actions,
	onAction,
	onCancel,
	context,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	onEmergencyExit,
}: MissingModalProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const geometry = panelGeometry(terminalWidth, terminalHeight, actions.length);
	// Reserve a column for the scrollbar only when the message needs one. A
	// scrollbar can add wrap rows, so determine overflow once at full width,
	// then make the final window from the narrower text width.
	const fullWidthBody = wrapBody(bodyLines ?? [], geometry.contentWidth);
	const hasScrollbar = fullWidthBody.length > geometry.maxBodyRows;
	const bodyWidth = Math.max(1, geometry.contentWidth - (hasScrollbar ? 1 : 0));
	const wrapped = hasScrollbar ? wrapBody(bodyLines ?? [], bodyWidth) : fullWidthBody;
	const bodyRows = Math.min(wrapped.length, geometry.maxBodyRows);
	const maxBodyScroll = maxScrollOf(wrapped.length, bodyRows);
	// A completed turn ends with its conclusion, so open the panel at the
	// newest message row. The current position stays stable while the
	// operator uses j and k.
	const [bodyScroll, setBodyScroll] = useState(() => maxBodyScroll);
	const [selected, setSelected] = useState(0);
	const selectedRef = useRef(0);

	const move = (delta: number) => {
		if (actions.length === 0) return;
		const at = Math.min(selectedRef.current, actions.length - 1);
		selectedRef.current = (at + delta + actions.length) % actions.length;
		setSelected(selectedRef.current);
	};

	const actionContext = contextFor("missing-modal", context);

	useKeyboard((key) => {
		if (!inputActive || key.meta) return;
		const control = controlForKey("missing-modal", key, actionContext);
		if (control === undefined) return;
		const availability = availabilityFor(control, actionContext);
		if (!availability.available) {
			onUnavailable?.(availability.reason ?? "control is unavailable");
			return;
		}
		switch (control.id) {
			case "emergency-exit":
				onEmergencyExit();
				return;
			case "help":
				onHelp?.();
				return;
			case "message":
				onMessage?.();
				return;
			case "cancel-action":
				onCancel();
				return;
			case "confirm-action":
				onAction(actions[Math.min(selectedRef.current, actions.length - 1)].key);
				return;
			case "select-action":
				move(key.name === "up" ? -1 : 1);
				return;
			case "scroll-message":
				if (key.name === "j") setBodyScroll((current) => Math.min(current + 1, maxBodyScroll));
				else setBodyScroll((current) => Math.max(0, current - 1));
				return;
			default:
				return;
		}
	});

	const scroll = Math.min(bodyScroll, maxBodyScroll);
	const visibleBody = windowOf(wrapped, scroll, bodyRows);
	const thumbRows = hasScrollbar ? scrollbarRows(wrapped.length, bodyRows, scroll) : null;

	return createElement(
		"box",
		{
			// A full-screen overlay above the app, with the modal centered in it.
			style: {
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				zIndex: 10,
				backgroundColor: COLORS.overlay,
				alignItems: "center",
				justifyContent: "center",
			},
		},
		createElement(
			"box",
			{
				border: true,
				borderColor: COLORS.borderFocused,
				title,
				padding: 1,
				style: { flexDirection: "column" },
			},
			...visibleBody.map((line, index) =>
				createElement(
					"text",
					{ key: `body-${index}` },
					...bodySpans(line, bodyWidth, thumbRows?.has(index)),
				),
			),
			...actions.map((row, index) =>
				createElement(
					"text",
					{ key: row.key },
					...actionSpans(row, index === selected, geometry.contentWidth),
				),
			),
		),
		createElement(ActionBar, {
			mode: "missing-modal",
			context: actionContext,
			overlay: true,
		}),
	);
}

/** The proportional scrollbar rows for the message window. */
function scrollbarRows(
	lineCount: number,
	visibleRows: number,
	scroll: number,
): ReadonlySet<number> {
	const thumbHeight = Math.max(1, Math.ceil((visibleRows * visibleRows) / lineCount));
	const travel = Math.max(0, visibleRows - thumbHeight);
	const maxScroll = maxScrollOf(lineCount, visibleRows);
	const start = maxScroll === 0 ? 0 : Math.round((scroll / maxScroll) * travel);
	return new Set(Array.from({ length: thumbHeight }, (_, index) => start + index));
}

/** One message row, with a dim track and bright thumb when it scrolls. */
function bodySpans(line: string, width: number, thumb: boolean | undefined): ReactElement[] {
	const spans: ReactElement[] = [
		createElement("span", { fg: COLORS.dim }, truncateToWidth(line, width)),
	];
	if (thumb !== undefined) {
		spans.push(
			createElement("span", { fg: thumb ? COLORS.textBright : COLORS.dim }, thumb ? "█" : "│"),
		);
	}
	return spans;
}

/** One action row as spans: the marker, the label, and the dim detail. */
function actionSpans(row: ActionRow, selected: boolean, contentWidth: number): ReactElement[] {
	const markerWidth = Math.min(MARKER_WIDTH, contentWidth);
	const labelWidth = Math.min(LABEL_WIDTH, Math.max(0, contentWidth - markerWidth));
	const detailWidth = Math.max(0, contentWidth - markerWidth - labelWidth);
	const detail = row.detail ?? "";
	return [
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.dim },
			truncateToWidth(selected ? "❯ " : "  ", markerWidth),
		),
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.text },
			truncateToWidth(padToWidth(`${row.label} `, labelWidth), labelWidth),
		),
		createElement(
			"span",
			{ fg: COLORS.dim },
			detailWidth > 0 ? truncateToWidth(detail, detailWidth) : "",
		),
	];
}
