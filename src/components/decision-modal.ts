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
 * The box is two regions (ADR 0039): a bordered, titled Body pane holds the
 * Turn log by itself, and the Decision region - the held cause row and the
 * decision rows - is pinned to the box's floor. The region is bounded and
 * scrolls: it shows as many rows as the box has room for once the log has
 * paid its floor, and its range rides the Action bar behind the selection's
 * hint. An empty turn log states its reason as one row inside the pane, and
 * the pane keeps its chrome.
 *
 * The shape: near-fullscreen, one cell of margin on every side, so the log
 * gets the whole terminal. It pops in over the app: a short fade with the
 * box growing to its final size. Its chrome is the shared modal chrome, so
 * the Action bar keeps its own row at every size, and no in-box hint row
 * stands between the rows the operator confirms and the bar.
 *
 * The keys dispatch through the shared control catalogue hook in the
 * decision-modal interaction mode: up and down move the region's rows, j/k
 * scroll the body one row with the page and jump keys as aliases, e edits
 * the settings of a selected handoff row before it starts, enter confirms
 * the selected action, and esc cancels. While it is open, the keys of the
 * app below are disabled.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";

import { isHeldCause, type TurnEndCause, type TurnLogEntry } from "../turn-log.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import { type ControlContext, contextFor } from "./controls.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import { type MdColors, type MdLine, renderMarkdown } from "./markdown.ts";
import type { MessageFact } from "./messages.ts";
import {
	type ActionRow,
	bodyRowSpans,
	decisionTitle,
	type ModalBody,
	ModalSurface,
	modalFrame,
	scrollbarRows,
	TURN_LOG_PANE,
	useModalPopScale,
} from "./modal-chrome.ts";
import { ActionItem } from "./shared/choices.ts";
import { turnEndCauseLine } from "./shared/presentation.ts";
import { useDecisionRegion } from "./shared/region.ts";
import { truncateToWidth } from "./text.ts";
import { paint } from "./theme.ts";

interface DecisionModalProps {
	/** The ticket's title, for the border. */
	title: string;
	/** One context row under the border: repository, task type, agent, time. */
	contextLine: string;
	/** The settled turn's log, in order. */
	entries: readonly TurnLogEntry[];
	/** The turn's end cause; a held cause shows its warning above the rows. */
	cause?: TurnEndCause | null;
	/** The agent's or provider's text for the cause; empty when none. */
	detail?: string;
	/**
	 * The label facts the settled turn's transition wrote, one line per
	 * surface (ADR 0027), above the rows that decide on them.
	 */
	factLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	/** The `e` key on a row flagged editable: change its Handoff's settings. */
	onEditAction?: (key: string) => void;
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
/** The one row under the border that names the context. */
const CONTEXT_ROWS = 1;
/** The pane's border cells, top and bottom. */
const PANE_BORDERS = 2;
/** The pane's vertical padding cells, one per side: its full chrome with the border. */
const PANE_PADDING = 2;
/** The rows the Turn log keeps before the pane yields its chrome. */
export const DECISION_LOG_FLOOR = 3;
/** The rows the Turn log keeps after the pane has yielded its chrome. */
export const DECISION_LOG_MIN = 1;
/** The one row an empty Turn log states inside the pane. */
export const EMPTY_TURN_LOG_NOTE = "No turn log is recorded for this turn";

/**
 * Fit the regions of the box the decision and the Live view share: the
 * pane's chrome, the body's rows, and the region's visible rows.
 *
 * The body pays its floor of three rows behind the pane's full chrome, and
 * the region - bounded, scrolling - takes the rows the floor leaves it,
 * capped at the rows it holds. A box with no room for the floor yields the
 * pane's padding to the body before the body yields its floor to the region:
 * a box without room for the floor holds the region, the border, and a
 * one-row body. An action row is the only way out, so the region keeps at
 * least its one row before the surface stands down to the size message. The
 * caller passes the box's content rows, the region's rows, the held
 * cause, and the extra region rows above the actions - the transition's
 * fact lines (ADR 0027); `null` is the stand-down.
 */
export function decisionBodyLayout(
	contentRows: number,
	actionRows: number,
	heldCause: boolean,
	extraRegionRows = 0,
): { paneRows: number; panePadding: 0 | 1; regionVisible: number } | null {
	const held = (heldCause ? 1 : 0) + extraRegionRows;
	// The region's one row is its only way out; a region with no rows asks
	// for none, the way the streaming sub-mode's body does.
	const regionMinimum = Math.min(1, actionRows);
	// 1. The body pays its floor behind the pane's full chrome; the region
	//    takes the rows the floor leaves it.
	let regionVisible = Math.min(
		actionRows,
		Math.max(
			0,
			contentRows - CONTEXT_ROWS - held - PANE_BORDERS - PANE_PADDING - DECISION_LOG_FLOOR,
		),
	);
	if (regionVisible >= regionMinimum)
		return {
			paneRows: contentRows - CONTEXT_ROWS - held - PANE_BORDERS - PANE_PADDING - regionVisible,
			panePadding: 1,
			regionVisible,
		};
	// 2. The pane's chrome yields to the body: the border alone, the floor
	//    kept, the region the rest.
	regionVisible = Math.min(
		actionRows,
		Math.max(0, contentRows - CONTEXT_ROWS - held - PANE_BORDERS - DECISION_LOG_FLOOR),
	);
	if (regionVisible >= regionMinimum)
		return {
			paneRows: contentRows - CONTEXT_ROWS - held - PANE_BORDERS - regionVisible,
			panePadding: 0,
			regionVisible,
		};
	// 3. Only then does the body yield rows: the region, the border, and a
	//    one-row body.
	regionVisible = Math.min(
		actionRows,
		Math.max(0, contentRows - CONTEXT_ROWS - held - PANE_BORDERS - DECISION_LOG_MIN),
	);
	if (regionVisible >= regionMinimum)
		return { paneRows: DECISION_LOG_MIN, panePadding: 0, regionVisible };
	return null;
}

/**
 * The turn log's rows at a width: text blocks render with the markdown
 * rules, tool calls are one dim note, "▸ name: target". A blank row stands
 * between two text blocks; a tool note sits close to the text that asked
 * for it. Failed calls wear the warning color.
 */
export function turnLogBody(entries: readonly TurnLogEntry[], width: number): MdLine[] {
	// The log's voices are asked of the theme when the log is drawn, the way
	// every other surface paints at render time: a resolution that changes
	// after this module loads is the resolution the rows paint.
	const colors: MdColors = { text: paint("text"), dim: paint("subtext0") };
	const out: MdLine[] = [];
	let previousWasText = false;
	for (const entry of entries) {
		if (entry.kind === "text") {
			if (previousWasText) out.push([]);
			const lines = renderMarkdown(entry.text, width, colors);
			if (lines.length === 0) out.push([]);
			else out.push(...lines);
			previousWasText = true;
		} else {
			const note = entry.target === "" ? entry.name : `${entry.name}: ${entry.target}`;
			out.push([
				{
					text: truncateToWidth(`▸ ${note}`, width),
					fg: entry.failed ? paint("yellow") : paint("subtext0"),
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
	cause = null,
	detail = "",
	factLines = [],
	actions,
	onAction,
	onEditAction,
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
	// The pop-in: a short fade with the box growing to its final size, the
	// one the shared chrome owns for every surface it boxes.
	const { pop, scale } = useModalPopScale();
	// The modal is a near-fullscreen surface: it takes the room the terminal
	// offers above its Action bar, and the body scrolls inside it. The shared
	// chrome keeps the box above the bar's row, so its border can never draw
	// through the bar at a short size.
	const frame = modalFrame(terminalWidth, terminalHeight, { margin: MARGIN, scale });
	// A held turn shows its cause in the region, above the rows it refuses
	// (ADR 0016): one row the log yields to, so the operator reads why the
	// turn is held before the rows that decide it.
	const held = cause !== null && isHeldCause(cause);
	// The pane's chrome yields before the log yields rows: padding first,
	// border second, and only then does the surface stand down to the size
	// message. The scrollbar is decided at the final size, so the thumb does
	// not flicker in and out while the pop-in grows the box.
	// The transition's fact lines stand above the action rows, like the
	// held-cause row: the rows decide on the facts, so the log yields to
	// them (ADR 0027).
	const factRows = factLines.length;
	const finalLayout = decisionBodyLayout(
		modalFrame(terminalWidth, terminalHeight, { margin: MARGIN }).contentRows,
		actions.length,
		held,
		factRows,
	);
	const layout = decisionBodyLayout(frame.contentRows, actions.length, held, factRows);
	// An empty turn log states its reason as one row inside the pane, and
	// the pane keeps its chrome.
	const emptyLog = entries.length === 0;
	// The pane's body width at this render: the box's content minus the
	// pane's border and padding, and one column for the inline thumb when
	// the body scrolls. A scrollbar can add wrap rows, so determine overflow
	// once at the full pane width, then wrap at the narrower text width.
	// The pane's padding is the one its layout decided, on every side.
	const panePadding = layout?.panePadding ?? 0;
	const paneInnerWidth = Math.max(1, frame.contentWidth - PANE_BORDERS - 2 * panePadding);
	const fullWidthBody = useMemo(
		() =>
			emptyLog
				? [[{ text: EMPTY_TURN_LOG_NOTE, fg: paint("subtext0") }]]
				: turnLogBody(entries, paneInnerWidth),
		[entries, emptyLog, paneInnerWidth],
	);
	const hasScrollbar = finalLayout !== null && fullWidthBody.length > finalLayout.paneRows;
	const bodyWidth = Math.max(1, paneInnerWidth - (hasScrollbar ? 1 : 0));
	// Wrap at the width the box has right now, so a line is never wider
	// than the frame being drawn while the pop-in grows the box.
	const renderedBody = useMemo(
		() =>
			emptyLog
				? [[{ text: EMPTY_TURN_LOG_NOTE, fg: paint("subtext0") }]]
				: turnLogBody(entries, bodyWidth),
		[entries, emptyLog, bodyWidth],
	);
	const bodyRows = layout === null ? 0 : Math.min(renderedBody.length, layout.paneRows);
	const maxBodyScroll = maxScrollOf(renderedBody.length, bodyRows);
	// A settled turn ends with its conclusion: open at the bottom, with the
	// newest line in view. `null` pins the view to the bottom until the
	// operator scrolls: the bottom's index moves while the box grows in.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);
	// The region's selection, its wrap, its auto-scroll, its visible window,
	// and its range text are the shared region's, beside the field, the
	// selector row, and the form (ADR 0039 and ADR 0040).
	const region = useDecisionRegion(actions, layout?.regionVisible ?? 0);
	// The fact the gate and the bar share: the row under the cursor carries
	// settings to edit, and this surface can open the panel for them. Close
	// and Goto decide about the turn that ended, so their rows leave the
	// control dimmed and say why when it is pressed.
	const editableActionSelected =
		onEditAction !== undefined && actions[region.at]?.editable === true;
	const modalContext = {
		...context,
		editableActionSelected,
		bodyScrollable: !emptyLog && maxBodyScroll > 0,
		bodyEmpty: emptyLog,
		actionRowCount: actions.length,
	};

	// Scroll the body by one step of the named key: a page moves one viewport
	// minus the shared row, and the jump keys take either edge. A null view
	// is the bottom, so the first step reads the bottom's index.
	const scrollBody = (name: string) => {
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
		context: contextFor("decision-modal", modalContext),
		active: inputActive,
		onUnavailable,
		onEmergencyExit,
		handlers: {
			help: () => onHelp?.(),
			message: () => onMessage?.(),
			"cancel-action": onCancel,
			"confirm-action": () => region.confirm((row) => onAction(row.key)),
			"edit-action": () => {
				const row = actions[region.at];
				if (row !== undefined && editableActionSelected) onEditAction?.(row.key);
			},
			"select-action": ({ key }) => region.move(key.name === "up" ? -1 : 1),
			"scroll-body": ({ key }) => scrollBody(key.name),
		},
	});

	const scroll = bodyScroll === null ? maxBodyScroll : Math.min(bodyScroll, maxBodyScroll);
	const visibleBody = windowOf(renderedBody, scroll, bodyRows);
	const thumbRows = hasScrollbar ? scrollbarRows(renderedBody.length, bodyRows, scroll) : null;

	const modalBody: ModalBody = {
		above: [
			createElement(
				"text",
				{ key: "context", fg: paint("subtext0") },
				truncateToWidth(contextLine, frame.contentWidth),
			),
		],
		pane:
			layout === null
				? undefined
				: {
						title: TURN_LOG_PANE,
						rows: visibleBody.map((line, index) =>
							createElement(
								"text",
								{ key: `body-${index}` },
								...bodyRowSpans(line, bodyWidth, thumbRows?.has(index)),
							),
						),
						// The pane's padding is the one its layout decided, and the
						// height is the one the layout reserved it.
						vpad: panePadding,
						height: layout.paneRows + PANE_BORDERS + 2 * panePadding,
					},
		below: [
			...(held
				? [
						createElement(
							"text",
							{ key: "held", fg: paint("yellow") },
							truncateToWidth(turnEndCauseLine(cause, detail), frame.contentWidth),
						),
					]
				: []),
			...factLines.map((line, index) =>
				createElement(
					"text",
					{ key: `fact-${index}`, fg: paint("blue") },
					truncateToWidth(line, frame.contentWidth),
				),
			),
			...region.window.map((row) =>
				createElement(ActionItem, {
					key: row.key,
					row,
					// The window's rows are objects of `actions`: the selected
					// row is the one the region's selection stands on.
					focused: actions[region.at] === row,
					width: frame.contentWidth,
				}),
			),
		],
		minRows:
			CONTEXT_ROWS +
			(held ? 1 : 0) +
			factRows +
			PANE_BORDERS +
			DECISION_LOG_MIN +
			Math.min(1, actions.length),
	};

	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title: decisionTitle(title),
		opacity: pop,
		body: modalBody,
		message,
		bar: {
			mode: "decision-modal",
			context: contextFor("decision-modal", modalContext),
			rangeIndicator: region.rangeText,
		},
	});
}
