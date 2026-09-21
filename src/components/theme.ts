/**
 * The paint layer of the control plane.
 *
 * One place for the colors the panes paint, so the list and the detail stay
 * in step: the base panes ask it for a role's color, and it answers from the
 * Theme in force. Inside herdr the theme is inherited from herdr's config;
 * outside herdr the standalone theme stands (ADR 0024).
 *
 * The emphasis the old palette carried in a brighter text color now rides on
 * bold: a title or a selected row paints the text role and sets bold, so the
 * terminal's own definition of emphasis decides how it reads. A role that
 * resolved to `reset`, and the no-color presentation, paint no color at all,
 * so the terminal's own default shows through where the theme says so.
 */

import type { Ticket, TicketMarker, TicketState } from "../domain/ticket.ts";
import { currentThemeResolution } from "../theme-source.ts";
import { noColorPresentation } from "./shared/presentation.ts";
import type { ThemeRole } from "./shared/theme.ts";

/**
 * The color one role paints in the theme in force.
 *
 * `reset` paints nothing, and so does the no-color presentation: the
 * terminal's own default shows through where the theme or the terminal says
 * so.
 */
export function paint(role: ThemeRole): string | undefined {
	if (noColorPresentation()) return undefined;
	const value = currentThemeResolution().theme.roles[role];
	return value === "reset" ? undefined : value;
}

/**
 * The kinds of news the Message line states.
 *
 * The severity is the written prefix and the color's role, and the prefix is
 * the fact: a line that reports what a control did must not wear the word for a
 * problem, and a line that reports a problem must not wear a neutral word.
 */
export type MessageSeverity = "working" | "warning" | "error" | "info";

export function prefixForSeverity(severity: MessageSeverity): string {
	if (severity === "working") return "Working:";
	if (severity === "warning") return "Warning:";
	if (severity === "error") return "Error:";
	return "Info:";
}

/** The theme role each ticket state badge paints in. */
const STATE_ROLES: Record<TicketState, ThemeRole> = {
	open: "blue",
	"handed-off": "yellow",
	running: "green",
	awaiting: "mauve",
};

/** The color a ticket state badge paints in. */
export function stateColor(state: TicketState): string | undefined {
	return paint(STATE_ROLES[state]);
}

/** The widest badge, "[handed-off]". State badges are padded to this width. */
export const BADGE_WIDTH = 12;

/** The written word the Starting window's spinner face wears (ADR 0030). */
export const STARTING_WORD = "starting";

/**
 * Whether the ticket's Starting window (ADR 0030) is open against these facts.
 *
 * The window is the claim this run made, reported by the hand-off dispatch on
 * claim and on settle, or the `handed-off` state the claim settled into.
 * The claim outranks the recovery fact: a claim in flight of this run writes
 * its own unresolved attempt, so the projection reads its work as a recovery
 * while it runs, and the face wears that window. The fact still rules out a
 * crash remnant - the ticket whose claim belongs to a run that is gone, and
 * the set this run holds does not carry. A failure marker outranks the window
 * the way it outranks the state badge, so it is checked by the caller before
 * this.
 */
export function inStartingWindow(ticket: Ticket, claimInFlight: boolean): boolean {
	return claimInFlight || (!ticket.handoffRecoveryRequired && ticket.state === "handed-off");
}

/** Render a ticket state as a colored, fixed-width badge like `[open]`. */
export function stateBadge(state: TicketState): string {
	return `[${state}]`.padEnd(BADGE_WIDTH);
}

/**
 * The badge the Queue wait (CONTEXT.md) wears in the state badge's slot:
 * the ticket's manual start waits in the Work queue, and the ticket keeps
 * its open state, so the badge paints the open role.
 */
export function queuedBadge(): string {
	return `[queued]`.padEnd(BADGE_WIDTH);
}

/** The theme role each failure badge paints in. */
const MARKER_ROLES: Record<TicketMarker, ThemeRole> = {
	blocked: "yellow",
	missing: "red",
};

/** The color a failure badge paints in. */
export function markerColor(marker: TicketMarker): string | undefined {
	return paint(MARKER_ROLES[marker]);
}

/**
 * The failure badge: `blocked` or `missing` in place of the state badge,
 * padded to the badge width so the row columns stay aligned.
 */
export function failureBadge(marker: TicketMarker): string {
	return marker.padEnd(BADGE_WIDTH);
}

/**
 * The held badge: a held turn in place of the state badge, padded to the
 * badge width so the row columns stay aligned (ADR 0016). It wears the
 * warning color of the other markers, so a turn that needs the operator
 * looks like a turn that needs the operator.
 */
export function heldBadge(): string {
	return "held".padEnd(BADGE_WIDTH);
}

/** The badge a parking state's ticket wears in place of a suggested task type. */
export const PARKED_TASK_TYPE = "parked";

/**
 * The task type a ticket presents in its list row and its detail pane.
 *
 * One shared choice between the two existing domain facts: an `open`
 * ticket presents its Suggested task type, the task of the first matching
 * Workflow state or the configured default. Every non-open ticket presents
 * the Task type its recorded handoff started with, so refreshed source facts
 * never change the meaning of active or settled work. A non-open ticket
 * without a recorded handoff presents `unknown`: the value is missing, not a
 * task type. An open ticket on a parking state presents `parked`: the machine
 * offers no task, and the plane starts nothing on it (ADR 0027).
 */
export interface TaskTypePresentation {
	/** The value the list badge and the detail pane show. */
	value: string;
	/** True when no recorded handoff task type exists. */
	unknown: boolean;
}

export function ticketTaskType(ticket: Ticket): TaskTypePresentation {
	if (ticket.state === "open") {
		return { value: ticket.suggestedTaskType ?? PARKED_TASK_TYPE, unknown: false };
	}
	const recorded = ticket.handoff?.taskType;
	if (recorded === undefined || recorded === "") {
		return { value: "unknown", unknown: true };
	}
	return { value: recorded, unknown: false };
}

/**
 * The bracketed badge of a task type, at its natural width.
 *
 * The brackets keep the badge distinct from titles and repository names;
 * the text, not a per-type color, carries the meaning.
 */
export function taskTypeBadge(value: string): string {
	return `[${value}]`;
}

/**
 * The one foreground of every configured task type badge and of its
 * detail line: the text role, or the warning color when the presented
 * value is the missing `unknown`.
 */
export function taskTypeColor(presentation: TaskTypePresentation): string | undefined {
	return paint(presentation.unknown ? "yellow" : "text");
}
