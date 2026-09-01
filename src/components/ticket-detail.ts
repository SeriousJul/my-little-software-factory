/** The full source and factory detail for the selected ticket. */
import { createElement } from "@opentui/react";

import type { Ticket } from "../domain/ticket.ts";
import { windowOf } from "./geometry.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS, STATE_COLORS, stateBadge, taskTypeColor, ticketTaskType } from "./theme.ts";

export interface DetailLine {
	text: string;
	fg: string;
}

export function detailLines(
	ticket: Ticket | undefined,
	usableCols: number,
	handoffLimit: number,
): DetailLine[] {
	if (ticket === undefined) return [{ text: "no ticket selected", fg: COLORS.dim }];
	const lines: DetailLine[] = [];
	const pushWrapped = (text: string, fg: string) => {
		for (const line of wrapToWidth(text, usableCols)) lines.push({ text: line, fg });
	};
	pushWrapped(ticket.title, COLORS.textBright);
	pushWrapped(ticket.repository, COLORS.text);
	lines.push({ text: stateBadge(ticket.state), fg: STATE_COLORS[ticket.state] });
	pushWrapped(`Agent: ${ticket.handoff?.agentType ?? "unassigned"}`, COLORS.text);
	if (ticket.handoff !== null) {
		pushWrapped(`Environment: ${ticket.handoff.environment}`, COLORS.text);
	}
	// One explicit task type line for every ticket: the open ticket's
	// suggestion, or the recorded handoff's task type. The label says which
	// fact it is, so routing never reads as history.
	const presentation = ticketTaskType(ticket);
	pushWrapped(
		`${ticket.state === "open" ? "Suggested" : "Handoff"} task type: ${presentation.value}`,
		taskTypeColor(presentation),
	);
	pushWrapped(`Handoffs: ${ticket.handoffCount}/${handoffLimit}`, COLORS.text);
	if (ticket.lastCompletion !== null) {
		const completion = ticket.lastCompletion;
		// The date is the first minute of the stored completion time; the
		// decision is `pending` until one is made on the turn.
		const date = completion.completedAt.slice(0, 16).replace("T", " ");
		const decision = completion.decision ?? "pending";
		pushWrapped(
			`Last completion: ${date} ${completion.taskType} by ${completion.agentName} (${completion.agentType}) ${decision}`,
			COLORS.text,
		);
		for (const line of completion.message.split("\n")) {
			for (const wrapped of wrapToWidth(line, usableCols))
				lines.push({ text: wrapped, fg: COLORS.dim });
		}
	}
	pushWrapped(`Source kind: ${ticket.sourceKind}`, COLORS.text);
	pushWrapped(`External key: ${ticket.externalKey}`, COLORS.text);
	pushWrapped(`Source state: ${ticket.sourceState}`, COLORS.text);
	pushWrapped(`Source URL: ${ticket.url}`, COLORS.text);
	pushWrapped(`Labels: ${ticket.labels.join(", ") || "none"}`, COLORS.text);
	for (const membership of ticket.memberships) {
		pushWrapped(
			`Source ${membership.sourceName}: ${membership.health}`,
			membership.health === "stale" ? COLORS.statusWarning : COLORS.dim,
		);
	}
	if (ticket.handoffRecoveryRequired)
		pushWrapped("Handoff: recovery required", COLORS.statusWarning);
	lines.push({ text: " ", fg: COLORS.dim });
	pushWrapped(ticket.description, COLORS.dim);
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
			style: { flexGrow: 1, flexShrink: 1, flexDirection: "column", overflow: "hidden" },
		},
		...visible.map((line, index) => createElement("text", { key: index, fg: line.fg }, line.text)),
	);
}
