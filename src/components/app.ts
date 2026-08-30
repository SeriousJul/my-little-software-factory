/**
 * The app shell: boots the layout, owns the selection, and owns the pane
 * focus.
 *
 * Keys: j/k and the up/down arrows move the selection. h/l and the
 * left/right arrows switch pane focus. q quits. Switching focus never moves
 * the selection.
 */
import { createElement, useKeyboard, useRenderer } from "@opentui/react";
import { useState } from "react";

import { SAMPLE_TICKETS } from "../data/sample-tickets.ts";
import { TicketDetail } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";

type Pane = "list" | "detail";

export function App() {
	const renderer = useRenderer();
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [focusedPane, setFocusedPane] = useState<Pane>("list");

	useKeyboard((key) => {
		if (key.name === "q") {
			renderer.destroy();
			return;
		}
		if (key.name === "j" || key.name === "down") {
			setSelectedIndex((i) => Math.min(i + 1, SAMPLE_TICKETS.length - 1));
			return;
		}
		if (key.name === "k" || key.name === "up") {
			setSelectedIndex((i) => Math.max(i - 1, 0));
			return;
		}
		if (key.name === "h" || key.name === "left") {
			setFocusedPane("list");
			return;
		}
		if (key.name === "l" || key.name === "right") {
			setFocusedPane("detail");
		}
	});

	const selected = SAMPLE_TICKETS[selectedIndex];

	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "row" } },
		createElement(TicketList, {
			tickets: SAMPLE_TICKETS,
			selectedIndex,
			focused: focusedPane === "list",
		}),
		createElement(TicketDetail, { ticket: selected, focused: focusedPane === "detail" }),
	);
}
