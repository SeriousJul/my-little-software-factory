/**
 * The missing modal: a read-only message, and the rows the operator can
 * confirm on it.
 *
 * The control plane opens it on an in-flight ticket whose pane herdr no
 * longer lists: restart the agent, or abandon the cycle. The awaiting
 * ticket's decision has its own modal, the decision modal, which carries
 * the turn log.
 *
 * The keys dispatch through the shared control catalogue hook in the
 * missing-modal interaction mode: up and down move the action rows, j/k
 * scroll the message, enter confirms the selected action, and esc cancels.
 * The shared Action bar names the controls, and the in-app Key guide
 * catalogs them. While it is open, the keys of the app below are disabled.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import { type ReactElement, useState } from "react";
import type { StandingFacts } from "./controls.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import type { MessageFact } from "./messages.ts";
import {
	type ActionRow,
	bodyRowSpans,
	ModalSurface,
	modalFrame,
	scrollbarRows,
	useActionChromeDispatch,
} from "./modal-chrome.ts";
import { ActionItem } from "./shared/choices.ts";
import { type DecisionRegion, useDecisionRegion } from "./shared/region.ts";
import { wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

interface MissingModalProps {
	title: string;
	/** The read-only message rows shown above the actions, if any. */
	bodyLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	onCancel: () => void;
	/** The base control facts, preserved when this modal owns input. */
	/** The plane's standing facts, read the same way in every mode. */
	standing: StandingFacts;
	/** False while a Key guide or Message view is above this modal. */
	inputActive?: boolean;
	onHelp?: () => void;
	onMessage?: () => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** The Message fact this modal's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this surface (issue #319, ADR 0111): the brake
	 * reaches every surface the plane draws, so the surface dispatches the key
	 * the way it dispatches Help and Message, and the screen that owns the
	 * state runs the toggle. Required, because a surface that resolves the key
	 * and swallows it would be a key the plane takes and never answers.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this surface (issue #319, ADR 0111), the
	 * same reach as the Queue pause's: required for the same reason.
	 */
	onAutoHandoff: () => void;
}

/** The message column stops at 80 cells: a line that wide is hard to read. */
const CONTENT_WIDTH = 80;
/** The message window is large enough for an agent's useful conclusion. */
const MAX_BODY_ROWS = 16;

/** Wrap the message, retaining explicit blank lines. */
function wrapBody(lines: readonly string[], width: number): string[] {
	return lines.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, width)));
}

/** The modal's frame and the message window it holds. */
function missingModalLayout(
	body: readonly string[],
	actionRows: number,
	terminalWidth: number,
	terminalHeight: number,
): {
	frame: ReturnType<typeof modalFrame>;
	bodyRows: number;
	hasScrollbar: boolean;
	bodyWidth: number;
	wrapped: string[];
	maxBodyScroll: number;
} {
	// The text column is set by the terminal width alone, so measure it once
	// and read the message at it. Reserve a column for the scrollbar only when
	// the message needs one: wrapping can add rows, so the overflow question
	// is answered at the full width before the narrower window is built.
	const widthFrame = modalFrame(terminalWidth, terminalHeight, { maxWidth: CONTENT_WIDTH + 4 });
	const fullWidthBody = wrapBody(body, widthFrame.contentWidth);
	// The box is only as tall as its own content: a two-line message with two
	// actions does not claim the whole terminal.
	const frame = modalFrame(terminalWidth, terminalHeight, {
		maxWidth: CONTENT_WIDTH + 4,
		rows: actionRows + Math.min(MAX_BODY_ROWS, fullWidthBody.length),
		// Every action row plus one line of the message: the message is the
		// part that scrolls.
		minRows: actionRows + 1,
	});
	const bodyRows = Math.max(0, frame.contentRows - actionRows);
	const hasScrollbar = fullWidthBody.length > bodyRows;
	const bodyWidth = Math.max(1, frame.contentWidth - (hasScrollbar ? 1 : 0));
	const wrapped = hasScrollbar ? wrapBody(body, bodyWidth) : fullWidthBody;
	const maxBodyScroll = maxScrollOf(wrapped.length, bodyRows);
	return { frame, bodyRows, hasScrollbar, bodyWidth, wrapped, maxBodyScroll };
}

/** The modal's body: the message window, then the action rows. */
function missingModalBodyRows(fields: {
	wrapped: string[];
	scroll: number;
	bodyRows: number;
	bodyWidth: number;
	contentWidth: number;
	thumbRows: ReadonlySet<number> | null;
	selection: DecisionRegion;
	actions: readonly ActionRow[];
}): ReactElement[] {
	return [
		...windowOf(fields.wrapped, fields.scroll, fields.bodyRows).map((line, index) =>
			createElement(
				"text",
				{ key: `body-${index}` },
				...bodyRowSpans(
					[{ text: line, fg: paint("subtext0") }],
					fields.bodyWidth,
					fields.thumbRows?.has(index),
				),
			),
		),
		...fields.selection.window.map((row) =>
			createElement(ActionItem, {
				key: row.key,
				row,
				focused: fields.actions[fields.selection.at] === row,
				width: fields.contentWidth,
			}),
		),
	];
}

export function MissingModal({
	title,
	bodyLines,
	actions,
	onAction,
	onCancel,
	standing,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	message,
	onEmergencyExit,
	onQueuePause,
	onAutoHandoff,
}: MissingModalProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const body = bodyLines ?? [];
	const layout = missingModalLayout(body, actions.length, terminalWidth, terminalHeight);
	// A completed turn ends with its conclusion, so open the panel at the
	// newest message row. The current position stays stable while the
	// operator uses j and k.
	const [bodyScroll, setBodyScroll] = useState(layout.maxBodyScroll);
	// The panel's rows are the region's: the shared selection, its wrap, and
	// its window, with every row shown, the way the decision's region does.
	const selection = useDecisionRegion(actions, actions.length);
	const scroll = Math.min(bodyScroll, layout.maxBodyScroll);

	// The modal owns one fact: the rows its Decision region holds.
	const facts = useActionChromeDispatch({
		mode: "missing-modal",
		standing,
		actionRows: actions.length,
		active: inputActive,
		onUnavailable,
		onEmergencyExit,
		selection,
		confirm: onAction,
		cancel: onCancel,
		help: onHelp,
		message: onMessage,
		scrollMessage: (direction) =>
			setBodyScroll((current) =>
				direction === 1 ? Math.min(current + 1, layout.maxBodyScroll) : Math.max(0, current - 1),
			),
		queuePause: onQueuePause,
		autoHandoff: onAutoHandoff,
	});

	const thumbRows = layout.hasScrollbar
		? scrollbarRows(layout.wrapped.length, layout.bodyRows, scroll)
		: null;
	return createElement(ModalSurface, {
		frame: layout.frame,
		width: terminalWidth,
		title,
		// Every action row: without one of them the modal has no way out, so
		// it holds itself back at that size.
		body: {
			above: [],
			below: missingModalBodyRows({
				wrapped: layout.wrapped,
				scroll,
				bodyRows: layout.bodyRows,
				bodyWidth: layout.bodyWidth,
				contentWidth: layout.frame.contentWidth,
				thumbRows,
				selection,
				actions,
			}),
			minRows: actions.length,
		},
		message,
		bar: { mode: "missing-modal", facts },
		queuePaused: standing.queuePaused,
	});
}
