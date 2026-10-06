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

import type { AutoHandoffMode } from "../domain/section-facts.ts";
import type { TicketMarker, TicketState } from "../domain/ticket.ts";
import type { TaskTypeFact } from "../domain/ticket-facts.ts";
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

/** The theme role each Auto-handoff mode wears in the Ticket header's corner. */
const AUTO_HANDOFF_ROLES: Record<AutoHandoffMode, ThemeRole> = {
	auto: "yellow",
	manual: "green",
};

/**
 * The color the Auto-handoff lamp and its word paint in.
 *
 * The mode the factory runs in on its own wears the warning color, the mode
 * that waits for the operator wears the running state's color. The written
 * word names the mode either way, so the no-color presentation loses nothing.
 */
export function autoHandoffColor(mode: AutoHandoffMode): string | undefined {
	return paint(AUTO_HANDOFF_ROLES[mode]);
}

/** The seat reading's roles: the room the Parallel limit still holds, and the cap reached. */
const SEAT_ROLES = { room: "green", cap: "red" } as const;

/**
 * The Queue pause's lamp's roles (issue #319, ADR 0111): the running state's
 * color while the brake is down, and the error color while the brake stands.
 */
const QUEUE_PAUSE_ROLES = { running: "green", paused: "red" } as const;

/**
 * The color the Queue pause's lamp and its word paint in.
 *
 * The lit lamp while the brake is down wears the running state's role, the
 * same role the manual Auto-handoff lamp wears, and the unlit lamp while the
 * brake stands wears the error role, the same role the `missing` marker wears.
 * The written word names the state either way, so the no-color presentation
 * loses nothing, and the plane's own themes carry the pair at the tested
 * essential-indicator contrast the lamp is part of.
 */
export function queuePauseColor(paused: boolean): string | undefined {
	return paint(QUEUE_PAUSE_ROLES[paused ? "paused" : "running"]);
}

/**
 * The color the mode cell's seat reading paints in.
 *
 * The cell carries the Parallel limit gate's answer, not the gate itself: the
 * cap color stands from the frame the seats reach the limit through the frame
 * they exceed it - the force-dispatched start and the held turn's own seat both
 * stand against the cap (ADR 0034). A limit of 0 states no limit, so the gate
 * answers false and the reading wears the room color.
 */
export function seatColor(overLimit: boolean): string | undefined {
	return paint(overLimit ? SEAT_ROLES.cap : SEAT_ROLES.room);
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
 * The one foreground of every configured task type badge: the text role,
 * or the warning color when the presented value is the missing `unknown`.
 * The detail pane's task type line carries its own mauve face, so the list
 * badge and the detail line read as two surfaces of one fact.
 */
export function taskTypeColor(fact: TaskTypeFact): string | undefined {
	return paint(fact.unknown ? "yellow" : "text");
}
