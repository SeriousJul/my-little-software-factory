/**
 * Shared palette and badge helpers for the panes.
 * One place for the colors so the list and the detail stay in step.
 */
import type { TicketState } from "../domain/ticket.ts";

export const COLORS = {
	border: "#30363d",
	borderFocused: "#58a6ff",
	text: "#c9d1d9",
	textBright: "#e6edf3",
	dim: "#8b949e",
	/** The terminal background the override panel's overlay fills with. */
	background: "#0d1117",
	statusError: "#f85149",
	statusWarning: "#d29922",
} as const;

export const STATE_COLORS: Record<TicketState, string> = {
	open: "#58a6ff",
	"handed-off": "#d29922",
	running: "#3fb950",
	done: "#bc8cff",
};

/** The widest badge, "[handed-off]". State badges are padded to this width. */
export const BADGE_WIDTH = 12;

/** Render a ticket state as a colored, fixed-width badge like `[open]`. */
export function stateBadge(state: TicketState): string {
	return `[${state}]`.padEnd(BADGE_WIDTH);
}
