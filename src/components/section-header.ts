import type { MouseEvent } from "@opentui/core";
import { createElement } from "@opentui/react";
import { LAMP_GLYPHS } from "./shared/presentation.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { autoHandoffColor, paint, seatColor } from "./theme.ts";

export type MainSection = "tickets" | "consultations" | "work";

/**
 * The Auto-handoff mode a header's lamp cell names.
 *
 * The lamp reads the operator's share of the work, not the machine's: an auto
 * run leaves the lamp unlit, and a manual run lights it.
 */
export type AutoHandoffMode = "auto" | "manual";

/**
 * The Auto-handoff mode's cell at a header's right corner.
 *
 * The cell names the mode with a lamp and a word, the Parallel limit's seat
 * count beside it (ADR 0034), and the Dispatch pause when it holds the
 * automatic works (ADR 0016). The screen that owns the factory state passes
 * the facts; the header owns how they read.
 */
export interface AutoHandoffCell {
	/** Auto-handoff mode: `auto` leaves the lamp unlit, `manual` lights it.
	 */
	mode: AutoHandoffMode;
	/** The seats the Parallel limit counts as taken. */
	seats: number;
	/** The Parallel limit. 0 states no limit, so the cell names no fraction. */
	limit: number;
	/** The Dispatch pause (ADR 0016): it rides the cell in auto mode only. */
	dispatchPaused: boolean;
}

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
 * truncates at the end rather than wrapping: the Main view's rows are fixed,
 * and a truncation must never hide the section name at the row's start. The
 * mode lamp and its word hold their corner, the seat count gives up its cells
 * before any count does, and the counts truncate last.
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
	const countsTextOf = (rowCells: string[]): string =>
		rowCells.length === 0 ? lead : `${lead}  ${rowCells.join("  ")}`;
	// The mode cell is the row's right corner, and it holds that corner in two
	// steps. First the cell shrinks from its own right end - the seat reading
	// goes, then the Dispatch pause word - so the whole count line keeps every
	// cell. Only when even the bare lamp leaves no room do the counts drop whole
	// cells from their tail, in ADR 0060's order. A row never cuts a cell in
	// half, and it never loses the mode the factory runs in.
	const modeCore =
		mode === null ? "" : ` ${mode.mode === "auto" ? LAMP_GLYPHS.off : LAMP_GLYPHS.on} ${mode.mode}`;
	const modeSeats =
		mode === null ? "" : ` ${mode.limit === 0 ? `${mode.seats}` : `${mode.seats}/${mode.limit}`}`;
	const modePause = mode === null || !mode.dispatchPaused ? "" : " paused";
	// Each form of the cell carries the parts it kept, so the render colors
	// each surviving part with its own ink.
	const fullMode =
		mode === null
			? { cell: "", seats: "", pause: "" }
			: { cell: `${modeCore}${modeSeats}${modePause}`, seats: modeSeats, pause: modePause };
	const pausedMode =
		mode === null ? fullMode : { cell: `${modeCore}${modePause}`, seats: "", pause: modePause };
	const bareMode = mode === null ? fullMode : { cell: modeCore, seats: "", pause: "" };
	const modeVariants = [fullMode, pausedMode, bareMode];
	let modeVariant = bareMode;
	let keptSeats = "";
	let keptPause = "";
	let keptCells = cells;
	const wholeCounts = widthOf(countsTextOf(cells));
	const shrunk = modeVariants.find(
		(variant) => wholeCounts + widthOf(variant.cell) <= width || variant.cell === modeCore,
	);
	if (shrunk !== undefined && wholeCounts + widthOf(shrunk.cell) <= width) {
		// The whole count line fits beside this form of the cell.
		modeVariant = shrunk;
		keptSeats = shrunk.seats;
		keptPause = shrunk.pause;
	} else {
		// The corner needs the room: drop whole cells from the counts' tail.
		modeVariant = bareMode;
		let candidate = cells;
		while (
			candidate.length > 1 &&
			widthOf(countsTextOf(candidate)) + widthOf(bareMode.cell) > width
		) {
			candidate = candidate.slice(0, -1);
		}
		keptCells = candidate;
	}
	const countsCells = Math.max(0, width - widthOf(modeVariant.cell));
	// An expanded section wears bold: the emphasis the old palette carried in a
	// brighter text color. Each part of the row paints its own role, so the
	// mode cell reads in color while the counts keep the header's own ink.
	const face = expanded ? "b" : "span";
	const headerInk = expanded ? paint("text") : paint("subtext0");
	const parts = [
		createElement(
			face,
			{ key: "counts", fg: headerInk },
			padToWidth(truncateToWidth(countsTextOf(keptCells), countsCells), countsCells),
		),
	];
	if (mode !== null) {
		parts.push(
			createElement(
				face,
				{ key: "lamp", fg: autoHandoffColor(mode.mode) },
				truncateToWidth(modeCore, Math.max(0, width - countsCells)),
			),
		);
		if (keptSeats !== "") {
			parts.push(
				createElement(
					face,
					{ key: "seats", fg: seatColor(mode.seats, mode.limit) },
					truncateToWidth(keptSeats, Math.max(0, width - countsCells - widthOf(modeCore))),
				),
			);
		}
		if (keptPause !== "") {
			parts.push(
				createElement(
					face,
					{ key: "pause", fg: headerInk },
					truncateToWidth(
						keptPause,
						Math.max(0, width - countsCells - widthOf(modeCore) - widthOf(keptSeats)),
					),
				),
			);
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
