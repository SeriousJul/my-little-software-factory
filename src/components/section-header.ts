import type { MouseEvent } from "@opentui/core";
import { createElement } from "@opentui/react";
import type { AutoHandoffCell } from "../domain/section-facts.ts";
import { LAMP_GLYPHS } from "./shared/presentation.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { autoHandoffColor, paint, seatColor } from "./theme.ts";

export type MainSection = "tickets" | "consultations" | "work";

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
	/** The Work queue's depth for the Work section's header (ADR 0034). */
	waiting?: number;
	/**
	 * The queue pause for the Work section's header (ADR 0052): the brake on
	 * the queue's drain, factory state that shows where the pane owns it.
	 */
	paused?: boolean;
	/** The held count: shown only when it is above zero (user story 15). */
	held?: number;
	/**
	 * The Auto-handoff mode's cell the row wears at its right corner: the lamp,
	 * the word, the seat count, and the Dispatch pause. The screen that owns the
	 * mode passes it; a row that carries no mode passes nothing.
	 */
	mode?: AutoHandoffCell | null;
	/**
	 * The ignored count (ADR 0060): the pile, every row the flag stands on. Shown
	 * only when it is above zero, the way the held count is, and it carries no bell
	 * and no click - the header's click already toggles the section, and the held
	 * bell carries a fact the ignore cannot hold. It is the row's last cell: where
	 * a narrow frame cuts, the held count and its bell stand.
	 */
	ignored?: number;
	/**
	 * The muted count (ADR 0070): the ledger of the source acts, every row any of
	 * whose sources' mute stands. Shown only when it is above zero, the way the
	 * ignored count is, and it stands beside it: one count per flag, held
	 * first, then the ticket's pile, then the source's ledger.
	 */
	muted?: number;
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
	 * A click on the header toggles the section (user story 9). Expanding
	 * lands the cursor on the section's list; collapsing keeps its selection
	 * and detail, the same action `x` takes for the cursor.
	 */
	onToggle: (section: MainSection) => void;
}

/**
 * The parts one header row keeps at one width, as answered by `planHeaderRow`.
 *
 * `cells` holds the row's cells in the order they stand, the section name
 * first. `lamp`, `seats`, and `pause` are the mode cell's parts it kept: an
 * empty string is a part the row had no room for.
 */
export interface HeaderRowPlan {
	/** The row's cells, every one of them whole. The section name always stands. */
	readonly cells: readonly string[];
	/** The lamp and its word. "" when the row carries no mode cell. */
	readonly lamp: string;
	/** The Parallel limit seat reading. "" when the row gave it up. */
	readonly seats: string;
	/** The Dispatch pause word. "" when the row gave it up. */
	readonly pause: string;
}

/** One form the mode cell can wear: the text it paints and the parts that text carries. */
interface ModeForm {
	readonly cell: string;
	readonly seats: string;
	readonly pause: string;
}

/**
 * Lay one header row out as whole cells (ADR 0060).
 *
 * The mode cell holds the row's right corner, and it holds it in two steps.
 * First the count cells give up whole cells from their tail - the held count
 * and its bell before the pile and the ledger, in ADR 0060's order - and only
 * as far as the row needs to hold the bare lamp and its word beside them. The
 * section name at the row's start never gives way. Then the cell takes back
 * every part the room those cells left can hold: the seat reading first, then
 * the Dispatch pause word. The lamp and its word never give way, so the row
 * never loses the mode the factory runs in.
 *
 * The row cuts no cell in half at any width the plane supports: the plane's
 * 40-column floor leaves room for the name and the bare lamp beside each
 * other, and every count cell the ladder kept fits beside them.
 */
export function planHeaderRow(
	width: number,
	cells: readonly string[],
	mode: AutoHandoffCell | null,
): HeaderRowPlan {
	const lamp =
		mode === null ? "" : ` ${mode.mode === "auto" ? LAMP_GLYPHS.off : LAMP_GLYPHS.on} ${mode.mode}`;
	const seats =
		mode === null ? "" : mode.limit === 0 ? ` ${mode.seats}` : ` ${mode.seats}/${mode.limit}`;
	const pause = mode === null || !mode.dispatchPaused ? "" : " paused";
	// The forms the cell can wear, widest first. A part the cell does not carry
	// repeats the form below it, so only the choices the row can make are kept.
	const forms: ModeForm[] = [];
	for (const form of [
		{ cell: `${lamp}${seats}${pause}`, seats, pause },
		{ cell: `${lamp}${pause}`, seats: "", pause },
		{ cell: lamp, seats: "", pause: "" },
	]) {
		if (!forms.some((kept) => kept.cell === form.cell)) forms.push(form);
	}
	const bare = forms.at(-1) ?? { cell: "", seats: "", pause: "" };
	const lineWidthOf = (rowCells: readonly string[]): number => widthOf(rowCells.join("  "));
	// The counts give way first, whole, from their tail, and only as far as the
	// bare lamp needs.
	let kept = cells;
	while (kept.length > 1 && lineWidthOf(kept) + widthOf(bare.cell) > width) {
		kept = kept.slice(0, -1);
	}
	// The cell then re-grows into the room those cells left: the widest form the
	// row can hold beside them.
	const form =
		forms.find((candidate) => lineWidthOf(kept) + widthOf(candidate.cell) <= width) ?? bare;
	return { cells: kept, lamp, seats: form.seats, pause: form.pause };
}

/**
 * Draw one row for one Main view section's header.
 *
 * The row carries the section name, the count facts the section reports, the
 * marker that says the section is expanded, and - where the screen that owns
 * the Auto-handoff mode passes it - the mode's lamp cell at the row's right
 * corner. The Tickets section reports
 * steady counts - open, running, awaiting - plus the held count with its bell
 * and the conditional ignored count of the pile (ADR 0060), and the
 * Consultations section reports the Consultation facts with
 * their bell and the new-output fact (user stories 11 through 16). The row
 * lays itself out as whole cells, never as one string it cuts in half; see
 * `planHeaderRow` for the ladder the cells give way in. The row never wraps,
 * and it never hides the section name at its start.
 * A click on a header toggles the section, the same action `x` takes for the
 * cursor: expanding lands the cursor on the section's list, and collapsing
 * keeps its selection and detail (user stories 6, 9, and 20).
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
	waiting = 0,
	paused = false,
	held = 0,
	mode = null,
	ignored = 0,
	muted = 0,
	bell = false,
	heldBell = false,
	newOutput = false,
	onToggle,
}: SectionHeaderProps) {
	// The terminal's width chooses the form; the row's own width chooses which
	// cells it can hold.
	const wide = terminalWidth >= 60;
	// The row's cells, in the order they stand. The held count shows only when
	// it is above zero (a steady zero holds no cell), the ignored count and the
	// muted ledger for the same reason, and the conditional cells stand in the
	// machine's own order: the held count and the bell that rings on it come
	// before the pile and the ledger, so a short row drops the operator's view
	// fact first and never a decision the operator owes (ADR 0060).
	const cells: string[] =
		section === "tickets"
			? wide
				? [`open: ${open}`, `running: ${running}`, `awaiting: ${awaiting}`]
				: [`open ${open}`, `running ${running}`, `awaiting ${awaiting}`]
			: section === "work"
				? [wide ? `waiting: ${waiting}` : `waiting ${waiting}`]
				: wide
					? [`awaiting response: ${awaitingResponse}`, `recovery: ${recovery}`]
					: [`awaiting ${awaitingResponse}`, `recovery ${recovery}`];
	if (section === "tickets") {
		if (held > 0) cells.push(wide ? `held: ${held}` : `held ${held}`);
		if (heldBell) cells.push("!!!");
		if (ignored > 0) cells.push(wide ? `ignored: ${ignored}` : `ignored ${ignored}`);
		if (muted > 0) cells.push(wide ? `muted: ${muted}` : `muted ${muted}`);
	} else if (section === "consultations") {
		if (bell) cells.push("!!!");
		if (newOutput) cells.push("new output");
	}
	// The Work queue's pause (ADR 0052) rides its depth cell: the brake on the
	// queue's drain reads beside the depth it brakes.
	if (section === "work" && paused) cells.push("paused");
	const name = section === "tickets" ? "Tickets" : section === "work" ? "Work" : "Consultations";
	const lead = `${expanded ? "▾" : "▸"} ${name}`;
	// The ladder the row lays itself out at, measured on the row's own width.
	const plan = planHeaderRow(width, [lead, ...cells], mode);
	const countsText = plan.cells.join("  ");
	const modeCell = `${plan.lamp}${plan.seats}${plan.pause}`;
	const countsCells = Math.max(0, width - widthOf(modeCell));
	// An expanded section wears bold: the emphasis the old palette carried in a
	// brighter text color. Each part of the row paints its own role, so the
	// mode cell reads in color while the counts keep the header's own ink.
	const face = expanded ? "b" : "span";
	const headerInk = expanded ? paint("text") : paint("subtext0");
	const parts = [
		createElement(
			face,
			{ key: "counts", fg: headerInk },
			padToWidth(truncateToWidth(countsText, countsCells), countsCells),
		),
	];
	if (mode !== null) {
		parts.push(createElement(face, { key: "lamp", fg: autoHandoffColor(mode.mode) }, plan.lamp));
		if (plan.seats !== "") {
			parts.push(
				createElement(face, { key: "seats", fg: seatColor(mode.seats, mode.limit) }, plan.seats),
			);
		}
		if (plan.pause !== "") {
			parts.push(createElement(face, { key: "pause", fg: headerInk }, plan.pause));
		}
	}
	const handleMouse = (event: MouseEvent) => {
		if (!active) return;
		if (event.type === "down" && event.button === 0) onToggle(section);
	};
	return createElement(
		"box",
		{
			onMouse: handleMouse,
			style: { width: "100%", height: 1, flexGrow: 0, flexShrink: 0 },
		},
		createElement("text", { style: { width: "100%", height: 1 }, fg: headerInk }, ...parts),
	);
}
