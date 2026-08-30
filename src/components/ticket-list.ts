/**
 * The ticket list pane: one row per ticket, windowed to the pane height.
 *
 * Each row carries the ticket's marker, state badge, title, and repository,
 * laid out on an exact cell budget so a row never overflows the pane. When
 * the terminal is narrow, the repository drops out instead of wrapping the
 * row. The window slides so the selected ticket stays visible when the
 * tickets overflow the pane.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";

import type { Ticket } from "../domain/ticket.ts";
import { useListGeometry } from "./geometry.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { BADGE_WIDTH, COLORS, STATE_COLORS, stateBadge } from "./theme.ts";

const MARKER_WIDTH = 2;
const REPO_GAP = 1;

interface TicketListProps {
	tickets: readonly Ticket[];
	selectedIndex: number;
	focused: boolean;
}

export function TicketList({ tickets, selectedIndex, focused }: TicketListProps) {
	const geometry = useListGeometry();

	// Slide the window so the selected ticket stays visible.
	let first = 0;
	if (selectedIndex >= first + geometry.visibleRows) {
		first = selectedIndex - geometry.visibleRows + 1;
	}
	if (first > tickets.length - geometry.visibleRows) {
		first = Math.max(0, tickets.length - geometry.visibleRows);
	}
	const visible = tickets.slice(first, first + geometry.visibleRows);

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
			createElement(
				"text",
				{ key: ticket.id },
				...rowSpans(ticket, first + i === selectedIndex, geometry.usableCols),
			),
		),
	);
}

/**
 * Build one row as spans on an exact cell budget.
 *
 * The marker and the badge take their fixed widths, the repository keeps
 * its natural width at the right edge with one gap column, and the title
 * takes whatever is left. When the budget cannot hold the repository, the
 * title takes its space instead: a field is dropped, never wrapped.
 */
function rowSpans(ticket: Ticket, selected: boolean, usableCols: number): ReactElement[] {
	const spans: ReactElement[] = [];
	let budget = usableCols;

	if (budget >= MARKER_WIDTH) {
		spans.push(
			createElement(
				"span",
				{ fg: selected ? COLORS.textBright : COLORS.dim },
				selected ? "❯ " : "  ",
			),
		);
		budget -= MARKER_WIDTH;
	}

	let hasBadge = false;
	if (budget >= BADGE_WIDTH) {
		spans.push(createElement("span", { fg: STATE_COLORS[ticket.state] }, stateBadge(ticket.state)));
		budget -= BADGE_WIDTH;
		hasBadge = true;
	}

	const titleFg = selected ? COLORS.textBright : COLORS.text;
	const repoWidth = widthOf(ticket.repository);
	const repoFits = budget >= REPO_GAP + repoWidth;
	let titleField = Math.max(0, budget - (repoFits ? REPO_GAP + repoWidth : 0));

	// A gap column between the badge and the title, so the title never
	// glues onto the badge when the badge takes its full width.
	if (hasBadge && titleField >= 1) {
		spans.push(createElement("span", { fg: titleFg }, " "));
		titleField -= 1;
	}

	if (titleField > 0) {
		spans.push(
			createElement(
				"span",
				{ fg: titleFg },
				padToWidth(truncateToWidth(ticket.title, titleField), titleField),
			),
		);
	}

	if (repoFits) {
		spans.push(
			createElement("span", { fg: COLORS.dim }, `${" ".repeat(REPO_GAP)}${ticket.repository}`),
		);
	}

	return spans;
}
