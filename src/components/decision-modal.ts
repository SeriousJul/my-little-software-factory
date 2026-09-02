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
 * box growing to its final size. Its chrome is the shared modal chrome, so
 * the Action bar keeps its own row at every size.
 *
 * The keys dispatch through the shared control catalogue hook in the
 * decision-modal interaction mode: up and down move the action rows, j/k
 * scroll the log one row with the page and jump keys as aliases, enter
 * confirms the selected action, and esc cancels. While it is open, the keys
 * of the app below are disabled.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";

import type { TurnLogEntry } from "../turn-log.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import { type ControlContext, contextFor } from "./controls.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import { type MdLine, renderMarkdown } from "./markdown.ts";
import type { MessageFact } from "./messages.ts";
import {
	type ActionRow,
	actionRowSpans,
	bodyRowSpans,
	ModalSurface,
	modalFrame,
	scrollbarRows,
	useActionSelection,
} from "./modal-chrome.ts";
import { truncateToWidth } from "./text.ts";
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
	/** The Message fact this modal's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
}

/** The modal leaves one cell of margin on every side. */
const MARGIN = 1;
/** The pop-in: a short fade with the box growing to its final size. */
const POP_MS = 120;
const POP_TICK_MS = 16;
/** The box's size at the pop-in's start, of its final size. */
const POP_START = 0.94;
/** The one row under the border that names the context. */
const CONTEXT_ROWS = 1;

/**
 * Fit the log window within a box that holds `contentRows` rows.
 *
 * The context row and every action row are always kept: an action row is
 * the only way out of the modal, so the log yields to them. The shared
 * Action bar owns the surface's last row, so it never takes a row here.
 */
function logRows(contentRows: number, actionRows: number): number {
	return Math.max(0, contentRows - actionRows - CONTEXT_ROWS);
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

/** The log's three voices, in the shared palette. */
const LOG_COLORS = {
	text: COLORS.text,
	bright: COLORS.textBright,
	dim: COLORS.dim,
};

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
	message,
	onEmergencyExit,
}: DecisionModalProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	// The size the pop-in grows into, decided at the terminal's size. The
	// scrollbar is decided there too, so neither the scrollbar nor the log
	// window flickers in and out while the box grows.
	const finalFrame = modalFrame(terminalWidth, terminalHeight, { margin: MARGIN });
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
	// The modal is a near-fullscreen surface: it takes the room the terminal
	// offers above its Action bar, and the log scrolls inside it. The shared
	// chrome keeps the box above the bar's row, so its border can never draw
	// through the bar at a short size.
	const frame = modalFrame(terminalWidth, terminalHeight, {
		margin: MARGIN,
		scale: popFactor,
	});
	// Reserve a column for the scrollbar only when the log needs one. A
	// scrollbar can add wrap rows, so determine overflow once at the final
	// width, then make the final window from the narrower text width.
	const fullWidthBody = useMemo(
		() => buildBody(entries, finalFrame.contentWidth),
		[entries, finalFrame.contentWidth],
	);
	const hasScrollbar = fullWidthBody.length > logRows(finalFrame.contentRows, actions.length);
	const bodyWidth = Math.max(1, frame.contentWidth - (hasScrollbar ? 1 : 0));
	// Wrap at the width the box has right now, so a line is never wider
	// than the frame being drawn while the pop-in grows the box.
	const body = useMemo(() => buildBody(entries, bodyWidth), [entries, bodyWidth]);
	const bodyRows = Math.min(body.length, logRows(frame.contentRows, actions.length));
	const maxBodyScroll = maxScrollOf(body.length, bodyRows);
	// A settled turn ends with its conclusion: open at the bottom, with the
	// newest line in view. `null` pins the view to the bottom until the
	// operator scrolls: the bottom's index moves while the box grows in.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);
	const selection = useActionSelection(actions);

	// Scroll the log by one step of the named key: a page moves one viewport
	// minus the shared row, and the jump keys take either edge. A null view
	// is the bottom, so the first step reads the bottom's index.
	const scrollLog = (name: string) => {
		if (name === "pageup")
			setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - Math.max(1, bodyRows)));
		else if (name === "pagedown")
			setBodyScroll((current) =>
				Math.min(maxBodyScroll, (current ?? maxBodyScroll) + Math.max(1, bodyRows)),
			);
		else if (name === "home") setBodyScroll(0);
		else if (name === "end") setBodyScroll(maxBodyScroll);
		else if (name === "j")
			setBodyScroll((current) => Math.min((current ?? maxBodyScroll) + 1, maxBodyScroll));
		else setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - 1));
	};

	useControlDispatch({
		mode: "decision-modal",
		context,
		active: inputActive,
		onUnavailable,
		onEmergencyExit,
		handlers: {
			help: () => onHelp?.(),
			message: () => onMessage?.(),
			"cancel-action": onCancel,
			"confirm-action": () => selection.confirm((row) => onAction(row.key)),
			"select-action": ({ key }) => selection.move(key.name === "up" ? -1 : 1),
			"scroll-turn-log": ({ key }) => scrollLog(key.name),
		},
	});

	const scroll = bodyScroll === null ? maxBodyScroll : Math.min(bodyScroll, maxBodyScroll);
	const thumbRows = hasScrollbar ? scrollbarRows(body.length, bodyRows, scroll) : null;
	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title: `Decision: ${title}`,
		borderColor: COLORS.borderFocused,
		// The context row and every action row: without them the modal is
		// not a decision, so it holds itself back at that size.
		minContentRows: actions.length + CONTEXT_ROWS,
		opacity: pop,
		message,
		bar: { mode: "decision-modal", context: contextFor("decision-modal", context) },
		children: [
			createElement(
				"text",
				{ key: "context", fg: COLORS.dim },
				truncateToWidth(contextLine, frame.contentWidth),
			),
			...windowOf(body, scroll, bodyRows).map((line, index) =>
				createElement(
					"text",
					{ key: `body-${index}` },
					...bodyRowSpans(line, bodyWidth, thumbRows?.has(index)),
				),
			),
			...actions.map((row, index) =>
				createElement(
					"text",
					{ key: row.key },
					...actionRowSpans(row, index === selection.at, frame.contentWidth),
				),
			),
		],
	});
}
