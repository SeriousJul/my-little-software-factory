/**
 * The confirmation panel: a read-only message and the rows the operator can
 * confirm on it.
 *
 * It serves the surfaces that ask before they act: the Consultation close,
 * delete, and live-checkout conflict, and the Ticket close the control plane
 * confirms key `w` behind (ADR 0031). The plane's turn decisions render
 * through the decision modal and the missing modal, which share this
 * module's chrome and dispatch.
 *
 * The panel dispatches through the catalogue like every other surface: up and
 * down move the action rows, j/k scroll the message, enter confirms the
 * selected action, esc cancels. While it is open, the keys of the app below
 * are disabled.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";

import { useControlDispatch } from "./control-dispatch.ts";
import { type ControlContext, contextFor } from "./controls.ts";
import { windowOf } from "./geometry.ts";
import type { MessageFact } from "./messages.ts";
import { type ActionRow, ModalSurface, modalFrame } from "./modal-chrome.ts";
import { ActionItem } from "./shared/choices.ts";
import { useDecisionRegion } from "./shared/region.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

interface ActionPanelProps {
	title: string;
	/** The read-only message rows shown above the actions, if any. */
	bodyLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	onCancel: () => void;
	/** The Message fact the panel's own Message line shows. */
	message: MessageFact | null;
	/** The base facts preserved while this confirmation owns input. */
	context?: ControlContext;
	inputActive?: boolean;
	onHelp?: () => void;
	onMessage?: () => void;
	onUnavailable?: (reason: string) => void;
	onEmergencyExit?: () => void;
}

/** The message column stops at 60 cells: a confirmation line is short. */
const CONTENT_WIDTH = 60;

/** The message window caps here; the rest scrolls. */
const MAX_BODY_ROWS = 8;

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
	context,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	onEmergencyExit = () => undefined,
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
	// The panel's rows are the region's: the shared selection, its wrap, and
	// its window, with every row shown, the way the decision's region does.
	const selection = useDecisionRegion(actions, actions.length);
	const actionContext = contextFor("action-panel", {
		...(context ?? {
			listCanMove: false,
			detailCanScroll: false,
			sourceCount: 0,
			refreshingSourceCount: 0,
			handoffActive: false,
			messageTruncated: false,
			consultationTypesConfigured: false,
		}),
		actionRowCount: actions.length,
	});
	useControlDispatch({
		mode: "action-panel",
		context: actionContext,
		active: inputActive,
		onUnavailable,
		onEmergencyExit,
		handlers: {
			help: () => onHelp?.(),
			message: () => onMessage?.(),
			"cancel-action": onCancel,
			"confirm-action": () => selection.confirm((row) => onAction(row.key)),
			"select-action": ({ key }) => selection.move(key.name === "up" ? -1 : 1),
			"scroll-message": ({ key }) =>
				setBodyScroll((current) =>
					key.name === "j" ? Math.min(current + 1, maxBodyScroll) : Math.max(0, current - 1),
				),
		},
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
		// Every action row plus one line of body: without them the panel states a
		// problem with no way to answer it.
		body: {
			above: [],
			below: [
				...bodyShown.map((line, index) =>
					createElement(
						"text",
						{ key: `body-${index}`, fg: paint("subtext0") },
						truncateToWidth(line, frame.contentWidth),
					),
				),
				...selection.window.map((row) =>
					createElement(ActionItem, {
						key: row.key,
						row,
						focused: actions[selection.at] === row,
						width: frame.contentWidth,
					}),
				),
			],
			minRows: actions.length + 1,
		},
		message,
		bar: { mode: "action-panel", context: actionContext },
	});
}
