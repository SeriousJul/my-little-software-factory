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
 * The keys: up and down move the action rows, j/k scroll the log one row,
 * pgup and pgdn page it, home and end jump to its ends, enter confirms the
 * selected action, esc cancels. While it is open, the keys of the app
 * below are disabled.
 */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { TurnLogEntry } from "../turn-log.ts";
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
const HINT = "up/down select  j/k scroll  pgup/pgdn page  home/end  enter  esc";

/** The log's three voices, in the shared palette. */
const LOG_COLORS = {
	text: COLORS.text,
	bright: COLORS.textBright,
	dim: COLORS.dim,
};

/**
 * Fit the log window within the near-fullscreen modal.
 *
 * The context row and the action rows are always kept. The key hint yields
 * before the log, so the operator can still read at least one log row when
 * the terminal is short.
 */
function decisionGeometry(
	terminalWidth: number,
	terminalHeight: number,
	actionRows: number,
): {
	modalWidth: number;
	modalHeight: number;
	contentWidth: number;
	bodyRows: number;
	showHint: boolean;
} {
	const modalWidth = Math.max(1, terminalWidth - MARGIN * 2);
	const modalHeight = Math.max(1, terminalHeight - MARGIN * 2);
	const contentWidth = Math.max(1, modalWidth - CHROME);
	const innerRows = Math.max(0, modalHeight - CHROME);
	// The hint yields its row before the body drops to zero: a too-small
	// terminal still shows one log line.
	const showHint = contentWidth >= widthOf(HINT) && innerRows >= actionRows + 3;
	const bodyRows = Math.max(0, innerRows - actionRows - 1 - (showHint ? 1 : 0));
	return { modalWidth, modalHeight, contentWidth, bodyRows, showHint };
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
}: DecisionModalProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const geometry = decisionGeometry(terminalWidth, terminalHeight, actions.length);
	// Reserve a column for the scrollbar only when the log needs one. A
	// scrollbar can add wrap rows, so determine overflow once at full width,
	// then make the final window from the narrower text width.
	const fullWidthBody = useMemo(
		() => buildBody(entries, geometry.contentWidth),
		[entries, geometry.contentWidth],
	);
	const hasScrollbar = fullWidthBody.length > geometry.bodyRows;
	const bodyWidth = Math.max(1, geometry.contentWidth - (hasScrollbar ? 1 : 0));
	const body = useMemo(
		() => (hasScrollbar ? buildBody(entries, bodyWidth) : fullWidthBody),
		[hasScrollbar, entries, bodyWidth, fullWidthBody],
	);
	const bodyRows = Math.min(body.length, geometry.bodyRows);
	const maxBodyScroll = maxScrollOf(body.length, bodyRows);
	// A settled turn ends with its conclusion: open at the bottom, with the
	// newest line in view.
	const [bodyScroll, setBodyScroll] = useState(() => maxBodyScroll);
	const [selected, setSelected] = useState(0);
	const selectedRef = useRef(0);

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

	const move = (delta: number) => {
		if (actions.length === 0) return;
		const at = Math.min(selectedRef.current, actions.length - 1);
		selectedRef.current = (at + delta + actions.length) % actions.length;
		setSelected(selectedRef.current);
	};

	useKeyboard((key) => {
		if (key.ctrl || key.meta) {
			return;
		}
		switch (key.name) {
			case "escape":
				onCancel();
				break;
			case "return": {
				const action = actions[Math.min(selectedRef.current, actions.length - 1)];
				if (action !== undefined) onAction(action.key);
				break;
			}
			case "down":
				move(1);
				break;
			case "up":
				move(-1);
				break;
			case "j":
				setBodyScroll((current) => Math.min(current + 1, maxBodyScroll));
				break;
			case "k":
				setBodyScroll((current) => Math.max(0, current - 1));
				break;
			case "pageup":
				setBodyScroll((current) => Math.max(0, current - Math.max(1, bodyRows)));
				break;
			case "pagedown":
				setBodyScroll((current) => Math.min(maxBodyScroll, current + Math.max(1, bodyRows)));
				break;
			case "home":
				setBodyScroll(0);
				break;
			case "end":
				setBodyScroll(maxBodyScroll);
				break;
			default:
				break;
		}
	});

	const scroll = Math.min(bodyScroll, maxBodyScroll);
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
					width: Math.max(1, Math.round(geometry.modalWidth * (POP_START + (1 - POP_START) * pop))),
					height: Math.max(
						1,
						Math.round(geometry.modalHeight * (POP_START + (1 - POP_START) * pop)),
					),
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
			geometry.showHint &&
				createElement("text", { fg: COLORS.dim }, truncateToWidth(HINT, geometry.contentWidth)),
		),
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
		spans.push(
			createElement("span", { fg: thumb ? COLORS.textBright : COLORS.dim }, thumb ? "█" : "│"),
		);
	}
	return spans;
}

/** One action row as spans: the marker, the label, the dim detail. */
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
