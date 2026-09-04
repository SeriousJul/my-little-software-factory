/**
 * The Consultation confirm panel: a read-only message and the rows the
 * operator can confirm on it.
 *
 * It serves the Consultation surfaces that predate the control catalogue:
 * closing, deleting, and the live-checkout conflict. The control plane's own
 * decisions render through the decision modal and the missing modal, which
 * share this module's chrome but dispatch their keys through the catalogue.
 *
 * The keys stay the panel's own until the Consultations port lands: up and
 * down move the action rows, j/k scroll the message, enter confirms the
 * selected action, esc cancels. While it is open, the keys of the app below
 * are disabled.
 */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRef, useState } from "react";

import { windowOf } from "./geometry.ts";
import type { MessageFact } from "./messages.ts";
import { type ActionRow, actionRowSpans, ModalSurface, modalFrame } from "./modal-chrome.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

interface ActionPanelProps {
	title: string;
	/** The read-only message rows shown above the actions, if any. */
	bodyLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	onCancel: () => void;
	/** The Message fact the panel's own Message line shows. */
	message: MessageFact | null;
}

/** The message column stops at 60 cells: a confirmation line is short. */
const CONTENT_WIDTH = 60;
/** The modal chrome: one border and one padding cell on each side. */
const CHROME = 4;

/**
 * The columns the panel gives its message.
 *
 * The caller that builds the body lines clips to this width, so a line the
 * panel would have to wrap or drop is cut where the panel really renders it
 * instead of at a width the panel only has on a wide terminal.
 */
export const panelBodyCols = (terminalWidth: number): number =>
	Math.max(1, Math.min(CONTENT_WIDTH, terminalWidth - CHROME));

/** The message window caps here; the rest scrolls. */
const MAX_BODY_ROWS = 8;
/** The hint row: this panel owns no Action bar, so it names its keys itself. */
const HINT = "up/down select  j/k message  enter  esc";

/** Wrap the message, retaining explicit blank lines. */
function wrapBody(lines: readonly string[], width: number): string[] {
	return lines.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, width)));
}

export function ActionPanel({
	title,
	bodyLines,
	actions,
	onAction,
	onCancel,
	message,
}: ActionPanelProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const body = bodyLines ?? [];
	// The panel is as tall as its content and no taller, and it clips what
	// cannot fit. The shared chrome still owns its last two rows.
	const frame = modalFrame(terminalWidth, terminalHeight, {
		maxWidth: CONTENT_WIDTH + 4,
		rows: actions.length + 1 + MAX_BODY_ROWS,
		// Every action row plus one line of the message.
		minRows: actions.length + 1,
		// The panel body is the whole terminal width between the borders, so
		// a fact row cut at the width it renders never wraps inside the box.
		margin: 0,
	});
	const wrapped = wrapBody(body, frame.contentWidth);
	// The body takes the content rows the actions and the hint leave. When it
	// is longer, the window's last row becomes the marker that says how many
	// rows it does not show: rows that only vanish read as a message that
	// ended, and the operator never learns to scroll.
	const bodyRows = Math.max(0, frame.contentRows - actions.length - 1);
	const marksOverflow = wrapped.length > bodyRows;
	const shownBodyRows = marksOverflow
		? Math.max(1, Math.min(wrapped.length, bodyRows) - 1)
		: Math.min(wrapped.length, bodyRows);
	const maxBodyScroll = Math.max(0, wrapped.length - shownBodyRows);
	const [bodyScroll, setBodyScroll] = useState(0);
	const [selected, setSelected] = useState(0);
	const selectedRef = useRef(0);

	const move = (delta: number) => {
		if (actions.length === 0) return;
		const at = Math.min(selectedRef.current, actions.length - 1);
		selectedRef.current = (at + delta + actions.length) % actions.length;
		setSelected(selectedRef.current);
	};

	useKeyboard((key) => {
		if (key.ctrl || key.meta) return;
		switch (key.name) {
			case "escape":
				onCancel();
				break;
			case "return":
				onAction(actions[Math.min(selectedRef.current, actions.length - 1)].key);
				break;
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
		}
	});

	const scroll = Math.min(bodyScroll, maxBodyScroll);
	const shownBody = windowOf(wrapped, scroll, shownBodyRows);
	const hiddenRows = Math.max(0, wrapped.length - (scroll + shownBody.length));
	const bodyShown =
		marksOverflow && hiddenRows > 0 ? [...shownBody, `+${hiddenRows} more (j/k)`] : shownBody;

	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title,
		borderColor: COLORS.borderFocused,
		// Every action row plus the hint: without them the panel states a
		// problem with no way to answer it.
		minContentRows: actions.length + 1,
		message,
		children: [
			...bodyShown.map((line, index) =>
				createElement(
					"text",
					{ key: `body-${index}`, fg: COLORS.dim },
					truncateToWidth(line, frame.contentWidth),
				),
			),
			...actions.map((row, index) =>
				createElement(
					"text",
					{ key: row.key },
					...actionRowSpans(row, index === selected, frame.contentWidth),
				),
			),
			createElement(
				"text",
				{ key: "hint", fg: COLORS.dim },
				truncateToWidth(HINT, frame.contentWidth),
			),
		],
	});
}
