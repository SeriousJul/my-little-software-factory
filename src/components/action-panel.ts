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
import { type ActionRow, actionRowSpans, ModalSurface, modalFrame } from "./modal-chrome.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

export type { ActionRow };

interface ActionPanelProps {
	title: string;
	/** The read-only message rows shown above the actions, if any. */
	bodyLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	onCancel: () => void;
}

/** The message column stops at 60 cells: a confirmation line is short. */
const CONTENT_WIDTH = 60;
/** The message window caps here; the rest scrolls. */
const MAX_BODY_ROWS = 8;
/** The hint row: this panel owns no Action bar, so it names its keys itself. */
const HINT = "up/down select  j/k message  enter  esc";

/** Wrap the message, retaining explicit blank lines. */
function wrapBody(lines: readonly string[], width: number): string[] {
	return lines.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, width)));
}

export function ActionPanel({ title, bodyLines, actions, onAction, onCancel }: ActionPanelProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const message = bodyLines ?? [];
	// The panel owns no Action bar, so it reserves no bar row. It is still as
	// tall as its content and no taller, and it clips what cannot fit.
	const frame = modalFrame(terminalWidth, terminalHeight, {
		maxWidth: CONTENT_WIDTH + 4,
		bar: false,
		rows: actions.length + 1 + MAX_BODY_ROWS,
		// Every action row plus one line of the message.
		minRows: actions.length + 1,
	});
	const wrapped = wrapBody(message, frame.contentWidth);
	const bodyRows = Math.max(0, frame.contentRows - actions.length - 1);
	const maxBodyScroll = Math.max(0, wrapped.length - bodyRows);
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
	return createElement(ModalSurface, {
		frame,
		title,
		borderColor: COLORS.borderFocused,
		// Every action row plus the hint: without them the panel states a
		// problem with no way to answer it.
		minContentRows: actions.length + 1,
		children: [
			...windowOf(wrapped, scroll, bodyRows).map((line, index) =>
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
