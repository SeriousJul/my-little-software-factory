/**
 * The ticket list pane: one row per ticket, windowed to the pane height.
 *
 * Each row carries the ticket's marker, state badge, task type badge,
 * title, and repository, laid out on an exact budget of cells so a row
 * never overflows the pane. A blocked or missing agent shows its failure
 * in place of the state badge; a ticket at the handoff limit, or one whose
 * closed cycle still has an environment alive in herdr, wears its markers
 * as trailing text. Trailing markers are all or nothing: a row too narrow
 * to hold them beside a readable title drops every one of them, and the
 * detail pane keeps carrying the facts. The task type badge sits between the state badge and
 * the title at its natural width: complete or absent, never truncated.
 * When the terminal is narrow, the repository drops out before the title
 * does, so a row never wraps and the title stays readable. The window
 * slides so the selected ticket stays visible when the tickets overflow
 * the pane.
 */
import type { BoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { type ReactElement, useRef } from "react";

import type { Ticket } from "../domain/ticket.ts";
import { usePaneGeometry, windowOf } from "./geometry.ts";
import { paneMouse } from "./pane-mouse.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import {
	BADGE_WIDTH,
	COLORS,
	failureBadge,
	MARKER_COLORS,
	STATE_COLORS,
	stateBadge,
	taskTypeBadge,
	taskTypeColor,
	ticketTaskType,
} from "./theme.ts";

const REPO_GAP = 1;
/** The marker a ticket at the handoff limit wears at the row's end. */
const LIMIT_TEXT = "handoff limit";
/** The marker a ticket with an environment still alive in herdr wears. */
const LEFTOVER_TEXT = "leftover";
const MARKER_GAP = 1;
/** Two cells: "❯ " when the row is selected, two spaces otherwise. */
const SELECTION_WIDTH = 2;
/** The row cells a dropped field still owes the title: one gap and one text cell. */
const TITLE_MINIMUM = 2;

interface TicketListProps {
	tickets: readonly Ticket[];
	selectedIndex: number;
	focused: boolean;
	reservedRows: number;
	emptyMessage?: string;
	/** The failure badge of a ticket from the last observation, or null. */
	markerOf: (ticket: Ticket) => "blocked" | "missing" | null;
	/** Whether the ticket has used up its handoffs: the limit marker. */
	limitReached: (ticket: Ticket) => boolean;
	/** False while an overlay owns input above the panes. */
	active: boolean;
	onFocus: () => void;
	onSelect: (index: number) => void;
	onMove: (delta: number) => void;
}

export function TicketList({
	tickets,
	selectedIndex,
	focused,
	reservedRows,
	emptyMessage,
	markerOf,
	limitReached,
	active,
	onFocus,
	onSelect,
	onMove,
}: TicketListProps) {
	const geometry = usePaneGeometry("list", reservedRows);
	const rootRef = useRef<BoxRenderable | null>(null);

	// The window starts where the selection sits on the window's last row.
	// `windowOf` clamps that start, so the window slides only when the
	// selection would run off the bottom of the pane.
	const start = Math.max(
		0,
		Math.min(
			selectedIndex - geometry.visibleRows + 1,
			Math.max(0, tickets.length - geometry.visibleRows),
		),
	);
	const visible = windowOf(tickets, start, geometry.visibleRows);
	const handleMouse = paneMouse({
		active: () => active,
		onFocus,
		onWheel: (direction) => onMove(direction === "up" ? -1 : 1),
		onPress: (event) => {
			// One border and one padding row precede the list's first row.
			// Use the actual OpenTUI box origin so hit testing stays correct
			// after a terminal resize or a Message line changes pane height.
			const root = (event.currentTarget as BoxRenderable | null) ?? rootRef.current;
			const row = event.y - (root?.y ?? event.y) - 2;
			const index = start + row;
			if (row >= 0 && row < visible.length && index >= 0 && index < tickets.length) onSelect(index);
		},
	});

	return createElement(
		"box",
		{
			ref: rootRef,
			title: focused ? "❯ Tickets" : "  Tickets",
			border: true,
			borderColor: focused ? COLORS.borderFocused : COLORS.border,
			padding: 1,
			onMouse: handleMouse,
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
							limitReached(ticket),
						),
					),
				)),
	);
}

/**
 * Build one row as spans on an exact cell budget.
 *
 * The selection marker and the state badge take their fixed widths, the
 * task type badge takes its natural width, the repository keeps its
 * natural width with one gap column, the title takes whatever is left, and
 * the row's trailing markers (the handoff limit, a leftover environment)
 * ride at its end. A field is dropped, never wrapped: the repository drops
 * first, the task type badge drops before the repository when its complete
 * text plus the title minimum would not fit, and the title always keeps its
 * gap plus one text cell.
 */
function rowSpans(
	ticket: Ticket,
	selected: boolean,
	usableCols: number,
	marker: "blocked" | "missing" | null,
	atLimit: boolean,
): ReactElement[] {
	const spans: ReactElement[] = [];
	let budget = usableCols;
	const trailing: { text: string; fg: string }[] = [];
	if (atLimit) trailing.push({ text: LIMIT_TEXT, fg: COLORS.statusWarning });
	if (ticket.leftover !== null) trailing.push({ text: LEFTOVER_TEXT, fg: COLORS.statusWarning });

	if (budget >= SELECTION_WIDTH) {
		spans.push(
			createElement(
				"span",
				{ fg: selected ? COLORS.textBright : COLORS.dim },
				selected ? "❯ " : "  ",
			),
		);
		budget -= SELECTION_WIDTH;
	}

	// The failure badge replaces the state badge: the agent blocked or the
	// pane gone stand out in the badge's own place.
	if (budget >= BADGE_WIDTH) {
		if (marker === null)
			spans.push(
				createElement("span", { fg: STATE_COLORS[ticket.state] }, stateBadge(ticket.state)),
			);
		else spans.push(createElement("span", { fg: MARKER_COLORS[marker] }, failureBadge(marker)));
		budget -= BADGE_WIDTH;
	}

	// The task type badge sits between the state badge and the title. It is
	// complete or absent: a partial badge could read as another task type,
	// so the row must hold the whole badge, its gap, and the title minimum,
	// or the badge drops and the title keeps the cells.
	const presentation = ticketTaskType(ticket);
	const badgeWidth = widthOf(taskTypeBadge(presentation.value));
	if (budget >= badgeWidth + TITLE_MINIMUM) {
		spans.push(
			createElement("span", { fg: taskTypeColor(presentation) }, taskTypeBadge(presentation.value)),
		);
		budget -= badgeWidth;
	}

	const titleFg = selected ? COLORS.textBright : COLORS.text;
	const repoWidth = widthOf(ticket.repository);

	// The trailing markers keep their gaps and their text at the row's end,
	// and the title keeps its gap and one text cell for itself.
	const markersCost = trailing.reduce((sum, marker) => sum + MARKER_GAP + widthOf(marker.text), 0);
	if (trailing.length > 0 && budget >= markersCost + TITLE_MINIMUM) {
		const afterMarkers = budget - markersCost;
		const repoFits = afterMarkers >= REPO_GAP + repoWidth + TITLE_MINIMUM;
		let titleField = Math.max(0, afterMarkers - (repoFits ? REPO_GAP + repoWidth : 0));
		if (titleField >= 1) {
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
		for (const marker of trailing) {
			spans.push(
				createElement("span", { fg: marker.fg }, `${" ".repeat(MARKER_GAP)}${marker.text}`),
			);
		}
		return spans;
	}

	// No trailing marker on this row: the title takes whatever the repository
	// leaves, and the repository drops when it would leave the title less
	// than a gap column and one text cell, so the title drops last.
	const repoFits = budget >= REPO_GAP + repoWidth + TITLE_MINIMUM;
	let titleField = Math.max(0, budget - (repoFits ? REPO_GAP + repoWidth : 0));
	if (titleField >= 1) {
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
