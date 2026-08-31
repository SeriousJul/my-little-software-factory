/**
 * The ticket detail pane: the full detail of the selected ticket.
 *
 * It carries repository, ticket state, the GitHub closed status as a source
 * fact, and the facts of the ticket's last handoff: the agent type, the
 * environment kind, and the task type used. A ticket that has not been
 * handed off shows the Agent line as unassigned and no handoff lines.
 *
 * The pane windows its lines to the pane height and slides them by
 * `scroll`. The lines are built by `detailLines`, a pure function: the app
 * shell needs the line count to know how far the detail can scroll, and
 * scrolling is a keybinding, not a pane concern.
 */
import { createElement } from "@opentui/react";

import type { Ticket } from "../domain/ticket.ts";
import { windowOf } from "./geometry.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS, STATE_COLORS, stateBadge } from "./theme.ts";

/** One line of ticket detail, at most `usableCols` cells wide. */
export interface DetailLine {
	text: string;
	fg: string;
}

/**
 * Flatten a ticket's detail into lines.
 *
 * The title and the description wrap to the pane width, so long content is
 * reachable through scrolling instead of clipped away.
 */
export function detailLines(ticket: Ticket, usableCols: number): DetailLine[] {
	const lines: DetailLine[] = [];
	const pushWrapped = (text: string, fg: string) => {
		for (const line of wrapToWidth(text, usableCols)) {
			lines.push({ text: line, fg });
		}
	};

	pushWrapped(ticket.title, COLORS.textBright);
	pushWrapped(ticket.repository, COLORS.text);
	lines.push({ text: stateBadge(ticket.state), fg: STATE_COLORS[ticket.state] });
	pushWrapped(`Agent: ${ticket.handoff?.agentType ?? "unassigned"}`, COLORS.text);
	if (ticket.handoff !== null) {
		pushWrapped(`Environment: ${ticket.handoff.environment}`, COLORS.text);
		pushWrapped(`Task type: ${ticket.handoff.taskType}`, COLORS.text);
	}
	pushWrapped(`GitHub: ${ticket.githubClosed ? "closed" : "open"}`, COLORS.text);
	lines.push({ text: " ", fg: COLORS.dim });
	pushWrapped(ticket.description, COLORS.dim);

	// The last guard: no line may exceed the pane, whatever it holds.
	return lines.map((line) => ({ text: truncateToWidth(line.text, usableCols), fg: line.fg }));
}

interface TicketDetailProps {
	lines: readonly DetailLine[];
	visibleRows: number;
	scroll: number;
	focused: boolean;
}

export function TicketDetail({ lines, visibleRows, scroll, focused }: TicketDetailProps) {
	const visible = windowOf(lines, scroll, visibleRows);

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
		...visible.map((line, i) => createElement("text", { key: i, fg: line.fg }, line.text)),
	);
}
