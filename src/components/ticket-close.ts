/**
 * The Ticket Close dialog: the facts key `w` states (ADR 0031).
 *
 * The dialog is the shared confirmation panel, and its body is the whole
 * warning before the operator confirms: who is alive, and what survives the
 * Close cleanup. Both come from the Ticket's own record, so a worktree
 * checkout and a live-worktree tab read differently, and the git branch that
 * stays in every case says so once.
 *
 * The words live here, away from the shell, because the gallery must show the
 * same dialog a review reads: an example that restated the body in its own
 * words could drift from the screen the operator meets, which is the failure
 * the shared control standard names.
 */
import type { Ticket, TicketMarker } from "../domain/ticket.ts";
import type { ActionRow } from "./modal-chrome.ts";

/** What the Close confirmation shows: its title, its body, and its rows. */
export interface TicketCloseDialog {
	title: string;
	bodyLines: string[];
	actions: ActionRow[];
}

/**
 * Who is alive.
 *
 * The state carries the work, and the observation's marker carries what herdr
 * last saw in the pane that Handoff started: a blocked Agent waits for input,
 * and a missing one is gone from herdr's list - the case the Close is the way
 * out of. The line states the fact the poll has, not the fact the state alone
 * implies, and it falls back to the state while no observation has read yet.
 */
function aliveLine(ticket: Ticket, marker: TicketMarker | null): string {
	if (marker === "missing") return "Herdr no longer lists the Agent's pane.";
	if (marker === "blocked") return "The Agent works, and waits for input.";
	if (ticket.state === "awaiting") return "The turn has settled, and no Agent works.";
	if (ticket.state === "running") return "The Agent is working.";
	if (ticket.state === "handed-off") return "The Agent has started, and its work is not seen yet.";
	return "No Agent works on this Ticket.";
}

/**
 * What the Close cleanup takes, and what it leaves, for one Environment.
 *
 * The lines are the pair the panel holds for its Environment: the removal
 * herdr runs, and the fact that stands when herdr refuses it. A live-worktree
 * handoff loses one tab and keeps the workspace beside it; a worktree handoff
 * loses the checkout with its workspace, and a dirty checkout cannot be
 * removed at all (ADR 0031).
 */
function survivesLines(ticket: Ticket): string[] {
	const environment = ticket.handoff?.environment ?? "worktree";
	if (environment === "live-worktree")
		return [
			"Close closes the Agent's herdr tab, and keeps the checkout and the workspace.",
			"The git branch stays, and the Ticket returns to open in its next cycle.",
		];
	return [
		"Close removes the worktree checkout; a dirty checkout stays as a leftover.",
		"The git branch stays, and the Ticket returns to open in its next cycle.",
	];
}

/**
 * What Cancel leaves, in the words the row states.
 *
 * The row states the same fact the body's first line states: a Ticket whose
 * pane herdr no longer lists keeps a lost pane, not a running Agent, so one
 * Cancel detail cannot serve every in-flight Ticket (ADR 0031).
 */
function cancelDetail(ticket: Ticket, marker: TicketMarker | null): string {
	if (ticket.state !== "handed-off" && ticket.state !== "running") return "keep the turn undecided";
	if (marker === "missing") return "keep the cycle, and its missing pane";
	return "keep the Agent and its work running";
}

/**
 * The Close confirmation's facts for one Ticket.
 *
 * The caller owns what the confirmed row runs: an `awaiting` Ticket records the
 * `closed` decision, and an in-flight one ends its cycle with no completion
 * trace, because its turn never settled (ADR 0031). The last line states that
 * difference, so the operator reads what the record will hold before they
 * answer the dialog.
 *
 * `marker` is the observation's fact about the Ticket's Agent pane, or null
 * while no observation has read it; the first line names who is alive from it.
 */
export function ticketCloseDialog(
	ticket: Ticket,
	marker: TicketMarker | null = null,
): TicketCloseDialog {
	const inFlight = ticket.state === "handed-off" || ticket.state === "running";
	return {
		title: `Close: ${ticket.title}`,
		bodyLines: [
			aliveLine(ticket, marker),
			...survivesLines(ticket),
			inFlight
				? "No completion record is written: the turn never settled."
				: "The closed decision lands on the settled turn.",
		],
		actions: [
			{
				key: "close",
				label: "Close",
				detail: "end the work cycle; the ticket returns to open",
			},
			{
				key: "cancel",
				label: "Cancel",
				detail: cancelDetail(ticket, marker),
			},
		],
	};
}
