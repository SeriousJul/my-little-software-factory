/**
 * The ticket detail pane: the full detail of the selected ticket.
 *
 * It carries the data a future handoff will need: repository, ticket state,
 * and the assigned agent, plus the GitHub closed status as a source fact.
 *
 * The pane builds its own line list and windows it to the pane height, the
 * same way the list pane windows its tickets. The description wraps to the
 * pane width. No child is ever rendered outside the pane, so the frame stays
 * clean at any terminal size.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";

import type { Ticket } from "../domain/ticket.ts";
import { COLORS, STATE_COLORS, stateBadge } from "./theme.ts";

interface TicketDetailProps {
	ticket: Ticket;
	focused: boolean;
}

export function TicketDetail({ ticket, focused }: TicketDetailProps) {
	const { width, height } = useTerminalDimensions();

	// The pane takes the half the list does not. The border and the padding
	// each eat two columns and two rows.
	const paneCols = Math.floor(width / 2);
	const usableCols = Math.max(1, paneCols - 4);
	const visibleRows = Math.max(1, height - 4);

	const lines = detailLines(ticket, usableCols).slice(0, visibleRows);

	return createElement(
		"box",
		{
			title: focused ? "❯ Detail" : "  Detail",
			border: true,
			borderColor: focused ? COLORS.borderFocused : COLORS.border,
			padding: 1,
			style: {
				flexGrow: 1,
				flexShrink: 1,
				flexDirection: "column",
				overflow: "hidden",
			},
		},
		...lines,
	);
}

function detailLines(ticket: Ticket, usableCols: number): ReactElement[] {
	const lines: ReactElement[] = [
		createElement("text", { fg: COLORS.textBright }, clip(ticket.title, usableCols)),
		createElement("text", { fg: COLORS.text }, clip(ticket.repository, usableCols)),
		createElement(
			"text",
			null,
			createElement("span", { fg: STATE_COLORS[ticket.state] }, stateBadge(ticket.state)),
		),
		createElement(
			"text",
			{ fg: COLORS.text },
			clip(`Agent: ${ticket.agent ?? "unassigned"}`, usableCols),
		),
		createElement(
			"text",
			{ fg: COLORS.text },
			clip(`GitHub: ${ticket.githubClosed ? "closed" : "open"}`, usableCols),
		),
		createElement("text", null, " "),
	];
	for (const line of wrapText(ticket.description, usableCols)) {
		lines.push(createElement("text", { fg: COLORS.dim }, line));
	}
	return lines;
}

/** Wrap words to a fixed width; a single wider word is cut hard. */
function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(" ")) {
		if (word.length === 0) {
			continue;
		}
		let piece = word;
		while (piece.length > width) {
			if (current.length > 0) {
				lines.push(current);
				current = "";
			}
			lines.push(piece.slice(0, width));
			piece = piece.slice(width);
		}
		if (current.length === 0) {
			current = piece;
		} else if (current.length + 1 + piece.length <= width) {
			current = `${current} ${piece}`;
		} else {
			lines.push(current);
			current = piece;
		}
	}
	if (current.length > 0) {
		lines.push(current);
	}
	return lines;
}

/** Cut a single line to a fixed width. */
function clip(text: string, width: number): string {
	if (text.length <= width) {
		return text;
	}
	return `${text.slice(0, width - 3)}...`;
}
