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
import { useState } from "react";
import { useControlDispatch } from "./control-dispatch.ts";
import { type ControlContext, contextFor } from "./controls.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
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
import { wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

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
	/** The Message fact this modal's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
}

/** The message column stops at 80 cells: a line that wide is hard to read. */
const CONTENT_WIDTH = 80;
/** The message window is large enough for an agent's useful conclusion. */
const MAX_BODY_ROWS = 16;

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
	message,
	onEmergencyExit,
}: MissingModalProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const body = bodyLines ?? [];
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
		rows: actions.length + Math.min(MAX_BODY_ROWS, fullWidthBody.length),
		// Every action row plus one line of the message: the message is the
		// part that scrolls.
		minRows: actions.length + 1,
	});
	const bodyRows = Math.max(0, frame.contentRows - actions.length);
	const hasScrollbar = fullWidthBody.length > bodyRows;
	const bodyWidth = Math.max(1, frame.contentWidth - (hasScrollbar ? 1 : 0));
	const wrapped = hasScrollbar ? wrapBody(body, bodyWidth) : fullWidthBody;
	const maxBodyScroll = maxScrollOf(wrapped.length, bodyRows);
	// A completed turn ends with its conclusion, so open the panel at the
	// newest message row. The current position stays stable while the
	// operator uses j and k.
	const [bodyScroll, setBodyScroll] = useState(maxBodyScroll);
	const selection = useActionSelection(actions);
	const scroll = Math.min(bodyScroll, maxBodyScroll);

	useControlDispatch({
		mode: "missing-modal",
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
			"scroll-message": ({ key }) => {
				if (key.name === "j") setBodyScroll((current) => Math.min(current + 1, maxBodyScroll));
				else setBodyScroll((current) => Math.max(0, current - 1));
			},
		},
	});

	const thumbRows = hasScrollbar ? scrollbarRows(wrapped.length, bodyRows, scroll) : null;
	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title,
		borderColor: COLORS.borderFocused,
		// Every action row: without one of them the modal has no way out, so
		// it holds itself back at that size.
		minContentRows: actions.length,
		message,
		bar: { mode: "missing-modal", context: contextFor("missing-modal", context) },
		children: [
			...windowOf(wrapped, scroll, bodyRows).map((line, index) =>
				createElement(
					"text",
					{ key: `body-${index}` },
					...bodyRowSpans([{ text: line, fg: COLORS.dim }], bodyWidth, thumbRows?.has(index)),
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
