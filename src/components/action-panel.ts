/**
 * The action modal: a read-only message, and the rows the operator can
 * confirm on it.
 *
 * The control plane opens it in two places. On an awaiting ticket it is
 * the decision: close (first, selected by default), a Goto, and one
 * handoff row per workflow target the ticket's task type allows. On an
 * in-flight ticket whose pane herdr no longer lists it is the missing
 * panel: restart or abandon.
 *
 * The keys: up and down move the action rows, j/k scroll the message,
 * enter confirms the selected action, esc cancels. While it is open, the
 * keys of the app below are disabled.
 */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { availabilityFor, type ControlContext, contextFor, controlForKey } from "./controls.ts";
import { windowOf } from "./geometry.ts";
import { padToWidth, truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

/** One confirmable action, with its label and an optional detail. */
export interface ActionRow {
	key: string;
	label: string;
	detail?: string;
}

interface ActionPanelProps {
	title: string;
	/** The read-only message rows shown above the actions, if any. */
	bodyLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	onCancel: () => void;
	onHelp?: () => void;
	onMessage?: () => void;
	/** The base control facts, preserved when this panel owns input. */
	context: ControlContext;
	/** False while a Key guide or Message view is above this panel. */
	inputActive?: boolean;
	onEmergencyExit: () => void;
}

/** The modal chrome: one border and one padding cell on each side. */
const CHROME = 4;
/** The marker column: "❯ " when the row is selected, two spaces otherwise. */
const MARKER_WIDTH = 2;
/** The label column: the widest action label plus its gap. */
const LABEL_WIDTH = 12;
/** The body and the detail column share this width. */
const CONTENT_WIDTH = 60;
/** The message window caps here; the rest scrolls. */
const MAX_BODY_ROWS = 8;
const HINT = "up/down select  j/k message  enter  esc";

export function ActionPanel({
	title,
	bodyLines,
	actions,
	onAction,
	onCancel,
	onHelp,
	onMessage,
	context,
	inputActive = true,
	onEmergencyExit,
}: ActionPanelProps) {
	const { width: terminalWidth } = useTerminalDimensions();
	// The body wraps to the content width; the wide terminals cap it there
	// and the narrow ones keep what they hold.
	const bodyCols = Math.max(1, Math.min(CONTENT_WIDTH, terminalWidth - CHROME));
	const wrapped = (bodyLines ?? []).flatMap((line) =>
		line === "" ? [""] : wrapToWidth(line, bodyCols),
	);
	const bodyRows = Math.min(wrapped.length, MAX_BODY_ROWS);
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
		if (!inputActive || key.meta) return;
		const control = controlForKey("action-panel", key);
		if (
			control === undefined ||
			!availabilityFor(control, contextFor("action-panel", context)).available
		)
			return;
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
			case "scroll-action-message":
				if (key.name === "j")
					setBodyScroll((current) => Math.min(current + 1, Math.max(0, wrapped.length - bodyRows)));
				else setBodyScroll((current) => Math.max(0, current - 1));
				return;
			default:
				return;
		}
	});

	const scroll = Math.min(bodyScroll, Math.max(0, wrapped.length - bodyRows));
	const visibleBody = windowOf(wrapped, scroll, bodyRows);

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
					{ key: `body-${index}`, fg: COLORS.dim },
					truncateToWidth(line, bodyCols),
				),
			),
			...actions.map((row, index) =>
				createElement("text", { key: row.key }, ...actionSpans(row, index === selected)),
			),
			createElement("text", { fg: COLORS.dim }, truncateToWidth(HINT, bodyCols)),
		),
	);
}

/** One action row as spans: the marker, the label, the dim detail. */
function actionSpans(row: ActionRow, selected: boolean): ReactElement[] {
	const detail = row.detail ?? "";
	const detailWidth = Math.max(0, CONTENT_WIDTH - MARKER_WIDTH - LABEL_WIDTH);
	return [
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.dim },
			selected ? "❯ " : "  ",
		),
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.text },
			padToWidth(`${row.label} `, LABEL_WIDTH),
		),
		createElement(
			"span",
			{ fg: COLORS.dim },
			detailWidth > 0 ? truncateToWidth(detail, detailWidth) : "",
		),
	];
}
