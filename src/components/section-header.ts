import type { MouseEvent } from "@opentui/core";
import { createElement } from "@opentui/react";

import { padToWidth, truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

export type MainSection = "tickets" | "consultations";

interface SectionHeaderProps {
	section: MainSection;
	/** False while a modal owns the surface above the Main view. */
	active: boolean;
	/**
	 * The terminal width. It chooses the wide or narrow count form (wide
	 * starts at 60 columns), per the Main view's header layout.
	 */
	terminalWidth: number;
	/** The cells the header row actually holds. The text truncates to them. */
	width: number;
	/** Whether the section's list box is expanded (user story 3). */
	expanded: boolean;
	/** The steady Ticket counts for the Tickets section's header. */
	open?: number;
	running?: number;
	awaiting?: number;
	/** The Consultation counts for the Consultations section's header. */
	awaitingResponse?: number;
	recovery?: number;
	/** The held count: shown only when it is above zero (user story 15). */
	held?: number;
	/**
	 * The Consultation attention bell, set by the observation coordinator: a
	 * Consultation moved to awaiting response while this app ran, or a
	 * recovery became possible.
	 */
	bell?: boolean;
	/**
	 * The held-turn bell (ADR 0016): the held count rose while this app ran.
	 * It rings with the terminal bell and flashes this header.
	 */
	heldBell?: boolean;
	/**
	 * The observation coordinator's new-output flag: the selected Consultation's
	 * pane produced output while the operator did not follow it, so the
	 * header, not just the bell, carries the fact.
	 */
	newOutput?: boolean;
	/**
	 * A click on a collapsed header expands the section and lands the cursor
	 * on its list. A click on an expanded header does nothing.
	 */
	onExpand: (section: MainSection) => void;
}

/**
 * Draw one row for one Main view section's header.
 *
 * The row carries the section name, the count facts the section reports, and
 * the marker that says the section is expanded. The Tickets section reports
 * steady counts - open, running, awaiting - plus the held count with its
 * bell, and the Consultations section reports the Consultation facts with
 * their bell and the new-output fact (user stories 11 through 16). The row
 * truncates at the end rather than wrapping: the Main view's rows are fixed,
 * and a truncation must never hide the section name at the row's start. A
 * click on a collapsed header expands the section, the same action `x` takes
 * for the cursor (user stories 6 and 20).
 */
export function SectionHeader({
	section,
	active,
	terminalWidth,
	width,
	expanded,
	open = 0,
	running = 0,
	awaiting = 0,
	awaitingResponse = 0,
	recovery = 0,
	held = 0,
	bell = false,
	heldBell = false,
	newOutput = false,
	onExpand,
}: SectionHeaderProps) {
	// The terminal's width chooses the form; the row's own width only sets
	// where a too-long count truncates, so the section name stays readable.
	const wide = terminalWidth >= 60;
	const counts =
		section === "tickets"
			? wide
				? `open: ${open}  running: ${running}  awaiting: ${awaiting}`
				: `open ${open}  running ${running}  awaiting ${awaiting}`
			: wide
				? `awaiting response: ${awaitingResponse}  recovery: ${recovery}`
				: `awaiting ${awaitingResponse}  recovery ${recovery}`;
	// The section name leads so a truncation never hides it, the held count
	// shows only when it is above zero (a steady zero holds no row), and the
	// bells sit by the facts they ring on.
	const facts =
		section === "tickets"
			? `  ${counts}${held > 0 ? `  ${wide ? `held: ${held}` : `held ${held}`}` : ""}${
					heldBell ? "  !!!" : ""
				}`
			: `  ${counts}${bell ? "  !!!" : ""}${newOutput ? "  new output" : ""}`;
	const text = `${expanded ? "▾" : "▸"} ${section === "tickets" ? "Tickets" : "Consultations"}${facts}`;
	const handleMouse = (event: MouseEvent) => {
		if (expanded || !active) return;
		if (event.type === "down" && event.button === 0) onExpand(section);
	};
	return createElement(
		"box",
		{
			onMouse: handleMouse,
			style: { width: "100%", height: 1, flexGrow: 0, flexShrink: 0 },
		},
		createElement(
			"text",
			{ style: { width: "100%", height: 1 }, fg: expanded ? COLORS.textBright : COLORS.dim },
			padToWidth(truncateToWidth(text, width), width),
		),
	);
}
