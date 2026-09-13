/**
 * Shared palette and badge helpers for the panes.
 * One place for the colors so the list and the detail stay in step.
 */
import type { Ticket, TicketMarker, TicketState } from "../domain/ticket.ts";

export const COLORS = {
	border: "#30363d",
	borderFocused: "#58a6ff",
	text: "#c9d1d9",
	textBright: "#e6edf3",
	focusedBackground: "#21262d",
	dim: "#8b949e",
	/**
	 * The fixed dark surface of the overlays that carry their own color system.
	 *
	 * The shared overlay (one `ModalSurface`) instead paints the presentation's
	 * own surface role, so the ink it paints is the ink that pair was measured
	 * against; the no-color presentation keeps this fixed dark box. The base
	 * panes and Action bar paint no background and follow the terminal's own.
	 */
	overlay: "#0d1117",
	statusError: "#f85149",
	statusWarning: "#d29922",
	statusWorking: "#58a6ff",
} as const;

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

export const STATE_COLORS: Record<TicketState, string> = {
	open: "#58a6ff",
	"handed-off": "#d29922",
	running: "#3fb950",
	awaiting: "#bc8cff",
};

/** The widest badge, "[handed-off]". State badges are padded to this width. */
export const BADGE_WIDTH = 12;

/** Render a ticket state as a colored, fixed-width badge like `[open]`. */
export function stateBadge(state: TicketState): string {
	return `[${state}]`.padEnd(BADGE_WIDTH);
}

/** The colors of the failure badges a ticket row can hold. */
export const MARKER_COLORS: Record<TicketMarker, string> = {
	blocked: "#d29922",
	missing: "#f85149",
};

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
 * looks like a turn that needs the operator (see `COLORS.statusWarning`).
 */
export function heldBadge(): string {
	return "held".padEnd(BADGE_WIDTH);
}

/**
 * The task type a ticket presents in its list row and its detail pane.
 *
 * One shared choice between the two existing domain facts: an `open`
 * ticket presents its Suggested task type, the first matching task rule or
 * the configured default. Every non-open ticket presents the Task type its
 * recorded handoff started with, so refreshed source facts never change the
 * meaning of active or settled work. A non-open ticket without a recorded
 * handoff presents `unknown`: the value is missing, not a task type.
 */
export interface TaskTypePresentation {
	/** The value the list badge and the detail line show. */
	value: string;
	/** True when no recorded handoff task type exists. */
	unknown: boolean;
}

export function ticketTaskType(ticket: Ticket): TaskTypePresentation {
	if (ticket.state === "open") {
		return { value: ticket.suggestedTaskType, unknown: false };
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
 * detail line: the neutral text color, or the warning color when the
 * presented value is the missing `unknown`.
 */
export function taskTypeColor(presentation: TaskTypePresentation): string {
	return presentation.unknown ? COLORS.statusWarning : COLORS.text;
}
