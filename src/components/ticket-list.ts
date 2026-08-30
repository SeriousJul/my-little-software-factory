/**
 * The ticket list pane: one row per ticket, windowed to the pane height.
 *
 * Each row carries the ticket's marker, state badge, title, and repository.
 * The window slides so the selected ticket stays visible when the tickets
 * overflow the pane.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";

import type { Ticket } from "../domain/ticket.ts";
import { COLORS, STATE_COLORS, stateBadge } from "./theme.ts";

const MARKER_WIDTH = 2;
const REPO_GAP = 1;

interface TicketListProps {
	tickets: readonly Ticket[];
	selectedIndex: number;
	focused: boolean;
}

export function TicketList({ tickets, selectedIndex, focused }: TicketListProps) {
	const { width, height } = useTerminalDimensions();

	// The pane takes half the terminal. The border and the padding each eat
	// two columns and two rows. Every row is exactly one line tall.
	const paneCols = Math.floor(width / 2);
	const usableCols = Math.max(1, paneCols - 4);
	const visibleRows = Math.max(1, height - 4);

	// Slide the window so the selected ticket stays visible.
	let first = 0;
	if (selectedIndex >= first + visibleRows) {
		first = selectedIndex - visibleRows + 1;
	}
	if (first > tickets.length - visibleRows) {
		first = Math.max(0, tickets.length - visibleRows);
	}
	const visible = tickets.slice(first, first + visibleRows);

	return createElement(
		"box",
		{
			title: focused ? "❯ Tickets" : "  Tickets",
			border: true,
			borderColor: focused ? COLORS.borderFocused : COLORS.border,
			padding: 1,
			style: {
				width: "50%",
				flexGrow: 0,
				flexShrink: 0,
				flexDirection: "column",
				overflow: "hidden",
			},
		},
		...visible.map((ticket, i) =>
			createElement("text", null, ...rowSpans(ticket, first + i === selectedIndex, usableCols)),
		),
	);
}

function rowSpans(ticket: Ticket, selected: boolean, usableCols: number) {
	const repoWidth = ticket.repository.length;
	const titleField = Math.max(1, usableCols - MARKER_WIDTH - 12 - REPO_GAP - REPO_GAP - repoWidth);
	const badgeColor = STATE_COLORS[ticket.state];
	const fg = selected ? COLORS.textBright : COLORS.text;

	return [
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.dim },
			selected ? "❯ " : "  ",
		),
		createElement("span", { fg: badgeColor }, stateBadge(ticket.state)),
		createElement("span", { fg }, `${clip(ticket.title, titleField)} `),
		createElement("span", { fg: COLORS.dim }, ticket.repository),
	];
}

/** Pad or ellipsize a title to a fixed field width. */
function clip(text: string, width: number): string {
	if (text.length <= width) {
		return text.padEnd(width);
	}
	return `${text.slice(0, width - 3)}...`;
}
