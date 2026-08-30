/**
 * The app shell: boots the layout and owns the selection, the pane focus,
 * and the detail scroll.
 *
 * The keys the shell handles are named once in `KEYMAP`. The vertical keys
 * act on the focused pane: the list pane moves the selection, the detail
 * pane scrolls its content. The horizontal keys switch pane focus. q
 * quits. Switching focus never moves the selection, and a new selection
 * starts the detail at the top.
 */
import { createElement, useKeyboard, useRenderer } from "@opentui/react";
import { useState } from "react";

import { SAMPLE_TICKETS } from "../data/sample-tickets.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { detailLines, TicketDetail } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";

type Pane = "list" | "detail";

/** A key the shell handles. */
export type AppKey = "j" | "k" | "h" | "l" | "q" | "up" | "down" | "left" | "right";

type KeyAction = "quit" | "focus-list" | "focus-detail" | "down" | "up";

/** The keymap: one entry per key the shell handles. */
const KEYMAP: Partial<Record<AppKey, KeyAction>> = {
	j: "down",
	down: "down",
	k: "up",
	up: "up",
	h: "focus-list",
	left: "focus-list",
	l: "focus-detail",
	right: "focus-detail",
	q: "quit",
};

export function App() {
	const renderer = useRenderer();
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [focusedPane, setFocusedPane] = useState<Pane>("list");
	const [detailScroll, setDetailScroll] = useState(0);

	const detailGeometry = usePaneGeometry("detail");
	const lines = detailLines(SAMPLE_TICKETS[selectedIndex], detailGeometry.usableCols);
	const maxScroll = maxScrollOf(lines.length, detailGeometry.visibleRows);
	const scroll = Math.min(detailScroll, maxScroll);

	// The vertical keys act on the focused pane. With the detail focused,
	// they scroll its content and leave the selection where it is.
	const moveVertical = (delta: number) => {
		if (focusedPane === "detail") {
			setDetailScroll((current) => clamp(current + delta, 0, maxScroll));
		} else {
			setSelectedIndex((i) => clamp(i + delta, 0, SAMPLE_TICKETS.length - 1));
			// A new ticket starts at the top of its detail.
			setDetailScroll(0);
		}
	};

	useKeyboard((key) => {
		switch (KEYMAP[key.name as AppKey]) {
			case "quit":
				renderer.destroy();
				break;
			case "focus-list":
				setFocusedPane("list");
				break;
			case "focus-detail":
				setFocusedPane("detail");
				break;
			case "down":
				moveVertical(1);
				break;
			case "up":
				moveVertical(-1);
				break;
			default:
				// Not a key the shell handles.
				break;
		}
	});

	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "row" } },
		createElement(TicketList, {
			tickets: SAMPLE_TICKETS,
			selectedIndex,
			focused: focusedPane === "list",
		}),
		createElement(TicketDetail, {
			lines,
			visibleRows: detailGeometry.visibleRows,
			scroll,
			focused: focusedPane === "detail",
		}),
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
