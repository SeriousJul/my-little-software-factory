/**
 * The ticket list pane: one row per ticket, windowed to the pane height.
 *
 * Each row carries the ticket's marker, state badge, title, and repository,
 * laid out on an exact budget of cells so a row never overflows the pane.
 * When the terminal is narrow, the repository drops out before the title
 * does, so a row never wraps and the title stays readable. The window
 * slides so the selected ticket stays visible when the tickets overflow the
 * pane.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";

import type { Ticket } from "../domain/ticket.ts";
import { usePaneGeometry, windowOf } from "./geometry.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import {
	BADGE_WIDTH,
	COLORS,
	MARKER_COLORS,
	MARKER_WIDTH,
	markerText,
	STATE_COLORS,
	stateBadge,
} from "./theme.ts";

const REPO_GAP = 1;

interface TicketListProps {
	tickets: readonly Ticket[];
	selectedIndex: number;
	focused: boolean;
	reservedRows: number;
	emptyMessage?: string;
	/** The failure marker of a ticket from the last observation, or null. */
	markerOf: (ticket: Ticket) => "blocked" | "missing" | null;
}

export function TicketList({
	tickets,
	selectedIndex,
	focused,
	reservedRows,
	emptyMessage,
	markerOf,
}: TicketListProps) {
	const geometry = usePaneGeometry("list", reservedRows);

	// The window starts where the selection sits on the window's last row.
	// `windowOf` clamps that start, so the window slides only when the
	// selection would run off the bottom of the pane.
	const start = selectedIndex - geometry.visibleRows + 1;
	const visible = windowOf(tickets, start, geometry.visibleRows);

	return createElement(
		"box",
		{
			title: focused ? "❯ Tickets" : "  Tickets",
			border: true,
			borderColor: focused ? COLORS.borderFocused : COLORS.border,
			padding: 1,
			style: {
				// An exact cell count from the shared geometry, not "50%":
				// OpenTUI rounds a percentage up on odd terminal widths, and
				// the rounded box would no longer match the geometry the
				// rows and the detail pane lay their text on.
				width: geometry.paneCols,
				flexGrow: 0,
				flexShrink: 0,
				flexDirection: "column",
				overflow: "hidden",
			},
		},
		...(visible.length === 0 && emptyMessage !== undefined
			? [
					createElement(
						"text",
						{ key: "empty", fg: COLORS.dim },
						truncateToWidth(emptyMessage, geometry.usableCols),
					),
				]
			: visible.map((ticket) =>
					createElement(
						"text",
						{ key: ticket.identity },
						...rowSpans(
							ticket,
							ticket.identity === tickets[selectedIndex].identity,
							geometry.usableCols,
							markerOf(ticket),
						),
					),
				)),
	);
}

/**
 * Build one row as spans on an exact cell budget.
 *
 * The marker and the badge take their fixed widths, the repository keeps
 * its natural width at the right edge with one gap column, and the title
 * takes whatever is left. The repository is dropped when it would leave the
 * title less than a gap column and one text cell, so the title drops last:
 * a field is dropped, never wrapped.
 */
function rowSpans(
	ticket: Ticket,
	selected: boolean,
	usableCols: number,
	marker: "blocked" | "missing" | null,
): ReactElement[] {
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

	if (budget >= BADGE_WIDTH) {
		spans.push(createElement("span", { fg: STATE_COLORS[ticket.state] }, stateBadge(ticket.state)));
		budget -= BADGE_WIDTH;
	}

	// The failure marker slot: the agent's pane gone, or the agent blocked.
	// It keeps one cell for the title, so the title still drops last.
	let markerRendered = false;
	if (budget >= MARKER_WIDTH + 1) {
		spans.push(
			createElement(
				"span",
				{ fg: marker === null ? COLORS.dim : MARKER_COLORS[marker] },
				markerText(marker),
			),
		);
		budget -= MARKER_WIDTH;
		markerRendered = true;
	}

	const titleFg = selected ? COLORS.textBright : COLORS.text;
	const repoWidth = widthOf(ticket.repository);
	// The title keeps at least one text cell. When the repository would take
	// that from it, the repository drops instead.
	const repoFits = budget >= REPO_GAP + repoWidth + 1;
	let titleField = Math.max(0, budget - (repoFits ? REPO_GAP + repoWidth : 0));

	// A gap column between the badge and the title. The marker slot's own
	// trailing space is the gap when it renders; a row without the slot
	// spends one cell so the title never glues onto the badge.
	if (!markerRendered && titleField >= 1) {
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
