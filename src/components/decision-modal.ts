/**
 * The decision modal: the turn log of a settled turn, and the actions the
 * operator can take on it.
 *
 * The control plane opens it on an awaiting ticket. It is the modal the
 * awaiting ticket exists for: the operator reads what the agent did and
 * decides the next step. The body is the turn log the trace carries, the
 * agent's messages in order: text blocks with light markdown dressing, and
 * one dim note per tool call. It opens at the bottom, where the agent's
 * conclusion is.
 *
 * The shape: near-fullscreen, one cell of margin on every side, so the log
 * gets the whole terminal. It pops in over the app: a short fade with the
 * box growing to its final size.
 *
 * The keys dispatch through the shared control catalogue in the
 * decision-modal interaction mode: up and down move the action rows, j/k
 * scroll the log one row with the page and jump keys as aliases, enter
 * confirms the selected action, and esc cancels. The shared Action bar
 * names the controls, and the in-app Key guide catalogs them. While it is
 * open, the keys of the app below are disabled.
 */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { TurnLogEntry } from "../turn-log.ts";
import { ActionBar } from "./action-bar.ts";
import { availabilityFor, type ControlContext, contextFor, controlForKey } from "./controls.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import { type MdLine, renderMarkdown } from "./markdown.ts";
import type { ActionRow } from "./missing-modal.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

interface DecisionModalProps {
	/** The ticket's title, for the border. */
	title: string;
	/** One context row under the border: repository, task type, agent, time. */
	contextLine: string;
	/** The settled turn's log, in order. */
	entries: readonly TurnLogEntry[];
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

/** The modal leaves one cell of margin on every side. */
const MARGIN = 1;
/** The modal chrome: one border and one padding cell on each side. */
const CHROME = 4;
/** The marker column: "❯ " when the row is selected, two spaces otherwise. */
const MARKER_WIDTH = 2;
/** The label column: enough for the usual "Handoff: <type>" action. */
const LABEL_WIDTH = 20;
/** The pop-in: a short fade with the box growing to its final size. */
const POP_MS = 120;
const POP_TICK_MS = 16;
/** The box's size at the pop-in's start, of its final size. */
const POP_START = 0.94;

/** The log's three voices, in the shared palette. */
const LOG_COLORS = {
	text: COLORS.text,
	bright: COLORS.textBright,
	dim: COLORS.dim,
};

/**
 * The modal's final box size: the terminal minus one cell of margin on
 * every side.
 */
export function decisionBoxSize(
	terminalWidth: number,
	terminalHeight: number,
): { width: number; height: number } {
	return {
		width: Math.max(1, terminalWidth - MARGIN * 2),
		height: Math.max(1, terminalHeight - MARGIN * 2),
	};
}

/**
 * Fit the log window within a modal of a given box size.
 *
 * The context row and the action rows are always kept. The shared Action
 * bar sits in the modal's bottom margin row, so it never takes a row from
 * the log.
 *
 * The layout derives from the box, not the terminal, so the pop-in stays
 * honest: while the box is still growing, lines wrap at its current width
 * and the body window has its current row count. A line that is wider than
 * the frame being drawn is what a terminal shows as a smudge.
 */
export function decisionLayout(
	boxWidth: number,
	boxHeight: number,
	actionRows: number,
): { contentWidth: number; bodyRows: number } {
	const contentWidth = Math.max(1, boxWidth - CHROME);
	const innerRows = Math.max(0, boxHeight - CHROME);
	const bodyRows = Math.max(0, innerRows - actionRows - 1);
	return { contentWidth, bodyRows };
}

/**
 * The turn log's rows at a width: text blocks render with the markdown
 * rules, tool calls are one dim note, "▸ name: target". A blank row stands
 * between two text blocks; a tool note sits close to the text that asked
 * for it. Failed calls wear the warning color.
 */
function buildBody(entries: readonly TurnLogEntry[], width: number): MdLine[] {
	const out: MdLine[] = [];
	let previousWasText = false;
	for (const entry of entries) {
		if (entry.kind === "text") {
			if (previousWasText) out.push([]);
			const lines = renderMarkdown(entry.text, width, LOG_COLORS);
			if (lines.length === 0) out.push([]);
			else out.push(...lines);
			previousWasText = true;
		} else {
			const note = entry.target === "" ? entry.name : `${entry.name}: ${entry.target}`;
			out.push([
				{
					text: truncateToWidth(`▸ ${note}`, width),
					fg: entry.failed ? COLORS.statusWarning : COLORS.dim,
				},
			]);
			previousWasText = false;
		}
	}
	return out;
}

export function DecisionModal({
	title,
	contextLine,
	entries,
	actions,
	onAction,
	onCancel,
	context,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	onEmergencyExit,
}: DecisionModalProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	// The box size the pop-in grows into, decided at the terminal's size. The
	// content layout follows the box while it grows; the hint and the
	// scrollbar are decided at the final size, so neither flickers in and
	// out during the pop.
	const finalBox = decisionBoxSize(terminalWidth, terminalHeight);
	const finalLayout = useMemo(
		() => decisionLayout(finalBox.width, finalBox.height, actions.length),
		[finalBox.width, finalBox.height, actions.length],
	);
	// The pop-in: a short fade with the box growing to its final size. A
	// self-driven progress keeps it deterministic in the test renderer,
	// where the animation engine never ticks.
	const [pop, setPop] = useState(0);
	useEffect(() => {
		const startedAt = performance.now();
		const id = setInterval(() => {
			const t = Math.min(1, (performance.now() - startedAt) / POP_MS);
			setPop(1 - (1 - t) ** 3);
			if (t >= 1) clearInterval(id);
		}, POP_TICK_MS);
		return () => clearInterval(id);
	}, []);
	const popFactor = POP_START + (1 - POP_START) * pop;
	const boxWidth = Math.max(1, Math.round(finalBox.width * popFactor));
	const boxHeight = Math.max(1, Math.round(finalBox.height * popFactor));
	const geometry = decisionLayout(boxWidth, boxHeight, actions.length);
	// Reserve a column for the scrollbar only when the log needs one. A
	// scrollbar can add wrap rows, so determine overflow once at the final
	// width, then make the final window from the narrower text width.
	const fullWidthBody = useMemo(
		() => buildBody(entries, finalLayout.contentWidth),
		[entries, finalLayout.contentWidth],
	);
	const hasScrollbar = fullWidthBody.length > finalLayout.bodyRows;
	const bodyWidth = Math.max(1, geometry.contentWidth - (hasScrollbar ? 1 : 0));
	// Wrap at the width the box has right now, so a line is never wider
	// than the frame being drawn while the pop-in grows the box.
	const body = useMemo(() => buildBody(entries, bodyWidth), [entries, bodyWidth]);
	const bodyRows = Math.min(body.length, geometry.bodyRows);
	const maxBodyScroll = maxScrollOf(body.length, bodyRows);
	// A settled turn ends with its conclusion: open at the bottom, with the
	// newest line in view. `null` pins the view to the bottom until the
	// operator scrolls: the bottom's index moves while the box grows in.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);
	const [selected, setSelected] = useState(0);
	const selectedRef = useRef(0);

	const move = (delta: number) => {
		if (actions.length === 0) return;
		const at = Math.min(selectedRef.current, actions.length - 1);
		selectedRef.current = (at + delta + actions.length) % actions.length;
		setSelected(selectedRef.current);
	};

	const actionContext = contextFor("decision-modal", context);

	useKeyboard((key) => {
		if (!inputActive || key.meta) return;
		const control = controlForKey("decision-modal", key, actionContext);
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
			case "confirm-action": {
				const action = actions[Math.min(selectedRef.current, actions.length - 1)];
				if (action !== undefined) onAction(action.key);
				return;
			}
			case "select-action":
				move(key.name === "up" ? -1 : 1);
				return;
			case "scroll-turn-log":
				if (key.name === "pageup")
					setBodyScroll((current) =>
						Math.max(0, (current ?? maxBodyScroll) - Math.max(1, bodyRows)),
					);
				else if (key.name === "pagedown")
					setBodyScroll((current) =>
						Math.min(maxBodyScroll, (current ?? maxBodyScroll) + Math.max(1, bodyRows)),
					);
				else if (key.name === "home") setBodyScroll(0);
				else if (key.name === "end") setBodyScroll(maxBodyScroll);
				else if (key.name === "j")
					setBodyScroll((current) => Math.min((current ?? maxBodyScroll) + 1, maxBodyScroll));
				else setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - 1));
				return;
			default:
				return;
		}
	});

	const scroll = bodyScroll === null ? maxBodyScroll : Math.min(bodyScroll, maxBodyScroll);
	const visibleBody = windowOf(body, scroll, bodyRows);
	const thumbRows = hasScrollbar ? scrollbarRows(body.length, bodyRows, scroll) : null;

	return createElement(
		"box",
		{
			// A full-screen overlay above the app, with the modal centered in
			// it. Near-fullscreen itself: one cell of margin on every side.
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
				title: truncateToWidth(`Decision: ${title}`, geometry.contentWidth),
				padding: 1,
				style: {
					flexDirection: "column",
					width: boxWidth,
					height: boxHeight,
					opacity: pop,
				},
			},
			createElement(
				"text",
				{ fg: COLORS.dim },
				truncateToWidth(contextLine, geometry.contentWidth),
			),
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
			mode: "decision-modal",
			context: actionContext,
			overlay: true,
		}),
	);
}

/** The proportional scrollbar rows for the log window. */
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

/** One log row as spans, with a dim track and bright thumb when it scrolls. */
function bodySpans(line: MdLine, width: number, thumb: boolean | undefined): ReactElement[] {
	const spans: ReactElement[] =
		line.length === 0
			? [createElement("span", { fg: COLORS.dim }, "")]
			: line.map((span) =>
					createElement("span", { fg: span.fg }, truncateToWidth(span.text, width)),
				);
	if (thumb !== undefined) {
		// Pin the scrollbar to the body's last column. Without the pad, the
		// thumb and track float behind short lines: a block in the middle of
		// the row reads as an artifact.
		let used = 0;
		for (const span of line) used += widthOf(span.text);
		const pad = Math.max(0, width - used);
		if (pad > 0) spans.push(createElement("span", {}, " ".repeat(pad)));
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
