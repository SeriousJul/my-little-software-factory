import type { MouseEvent } from "@opentui/core";
import { createElement } from "@opentui/react";
import type { AutoHandoffCell } from "../domain/section-facts.ts";
import { parallelSeatText } from "../parallel.ts";
import { LAMP_GLYPHS } from "./shared/presentation.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { autoHandoffColor, paint, queuePauseColor, seatColor } from "./theme.ts";

export type MainSection = "tickets" | "consultations" | "work";

interface SectionHeaderProps {
	section: MainSection;
	/** False while a modal owns the surface above the Main view. */
	active: boolean;
	/**
	 * The terminal width. It chooses the wide or narrow count form (wide
	 * starts at 60 columns), per the Main view's header layout, and it bounds
	 * the row's own width: a header never lays its row out past the terminal it
	 * renders in.
	 */
	terminalWidth: number;
	/**
	 * The cells the header row actually holds. The row plans against the
	 * smaller of this and the terminal width, so a caller that overstates its
	 * box cannot push the row's last cell past the edge of the box.
	 */
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
	/** The held count: shown only when it is above zero (user story 15). */
	held?: number;
	/**
	 * The Auto-handoff mode's cell the row wears at its right corner: the lamp,
	 * the word, the seat count, and the Dispatch pause. The screen that owns the
	 * mode passes it; a row that carries no mode passes nothing.
	 */
	mode?: AutoHandoffCell | null;
	/**
	 * The Queue pause's fact the row's corner lamp reads (issue #319, ADR 0111):
	 * the operator's brake on the Work queue's drain, factory state that stands
	 * beside the Auto-handoff cell's lamp, one space of room between the two
	 * cells. The row carries the lamp where it carries the mode cell - the
	 * Ticket header's corner - because that is the corner of the plane, and the
	 * Work header keeps its depth cell alone. It is not the Dispatch pause the
	 * mode cell carries (ADR 0016).
	 */
	queuePaused?: boolean;
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
 * empty string is a part the row had no room for. `countsRoom` is what the
 * counts may paint into. Together they are the row as the component paints it:
 * every part the plan names stands whole, and a part the row cannot hold whole
 * is named as nothing.
 */
export interface HeaderRowPlan {
	/** The row's cells, every one of them whole. The section name always stands. */
	readonly cells: readonly string[];
	/**
	 * The Queue pause's lamp and its word (issue #319, ADR 0111). "" when the
	 * row carries no corner - no mode cell, or a row too short to hold the
	 * corner beside its own name.
	 */
	readonly queue: string;
	/**
	 * The Auto-handoff lamp and its word. "" when the row carries no corner, and
	 * "" when it is too short to hold the bare lamp beside its own name.
	 */
	readonly lamp: string;
	/** The Parallel limit seat reading. "" when the row gave it up. */
	readonly seats: string;
	/** The Dispatch pause word. "" when the row gave it up. */
	readonly pause: string;
	/** The columns the count cells paint into: what the corner leaves. */
	readonly countsRoom: number;
}

/** One form the corner can wear: the text it paints and the parts that text carries. */
interface ModeForm {
	readonly cell: string;
	readonly queue: string;
	readonly lamp: string;
	readonly seats: string;
	readonly pause: string;
}

/**
 * Lay one header row out as whole cells (ADR 0060, ADR 0111).
 *
 * The corner holds the row's right corner, and it holds it in two steps. First
 * the count cells give up whole cells from their tail - the held count and its
 * bell before the pile and the ledger, in ADR 0060's order - and only as far as
 * the row needs to hold the bare corner beside them: the Queue pause's lamp
 * and word, one space of room, and the Auto-handoff lamp and word, both whole.
 * The section name at the row's start never gives way. Then the corner takes
 * back every part the room those cells left can hold: the seat reading first,
 * then the Dispatch pause word. Both lamps and their words never give way, so
 * the row never loses the mode the factory runs in nor the brake the operator
 * stands on, and the give order is the count cells, then the seat reading, then
 * the Dispatch pause word (issue #319).
 *
 * The row cuts no cell in half at any width the plane supports: the plane's
 * 40-column floor leaves room for the name and both lamps beside each other,
 * and every count cell the ladder kept fits beside them. Below that floor the
 * ladder runs out of count cells to give up, and the row then holds no corner
 * at all rather than a lamp it can only cut in half.
 */
export function planHeaderRow(
	width: number,
	cells: readonly string[],
	mode: AutoHandoffCell | null,
	/** The Queue pause's fact. The brake stands down by default (issue #319). */
	queuePaused: boolean = false,
): HeaderRowPlan {
	// The Queue pause's lamp (issue #319, ADR 0111): the lit lamp and the word
	// `running` while the brake is down, the unlit lamp and the word `paused`
	// while it stands. The Auto-handoff lamp follows it one space of room on,
	// so the two cells stand beside each other without touching.
	const queue =
		mode === null
			? ""
			: ` ${queuePaused ? LAMP_GLYPHS.off : LAMP_GLYPHS.on} ${queuePaused ? "paused" : "running"} `;
	const lamp =
		mode === null ? "" : `${mode.mode === "auto" ? LAMP_GLYPHS.off : LAMP_GLYPHS.on} ${mode.mode}`;
	const seats = mode === null ? "" : ` ${parallelSeatText(mode.seats, mode.limit)}`;
	const pause = mode === null || !mode.dispatchPaused ? "" : " held";
	// The forms the corner can wear, widest first. A part the corner does not
	// carry repeats the form below it, so only the choices the row can make are
	// kept. The Queue pause's lamp stands in every form the corner wears.
	const forms: ModeForm[] = [];
	for (const form of [
		{ cell: `${queue}${lamp}${seats}${pause}`, queue, lamp, seats, pause },
		{ cell: `${queue}${lamp}${pause}`, queue, lamp, seats: "", pause },
		{ cell: `${queue}${lamp}`, queue, lamp, seats: "", pause: "" },
	]) {
		if (!forms.some((kept) => kept.cell === form.cell)) forms.push(form);
	}
	const bare = forms.at(-1) ?? { cell: "", queue: "", lamp: "", seats: "", pause: "" };
	const lineWidthOf = (rowCells: readonly string[]): number => widthOf(rowCells.join("  "));
	// The counts give way first, whole, from their tail, and only as far as the
	// bare corner needs.
	let kept = cells;
	while (kept.length > 1 && lineWidthOf(kept) + widthOf(bare.cell) > width) {
		kept = kept.slice(0, -1);
	}
	// A row too short to hold its name and the bare corner whole beside each
	// other holds no corner at all. Naming the lamps anyway would state a part
	// the row can only cut, and the plan answers what the row paints.
	if (mode === null || lineWidthOf(kept) + widthOf(bare.cell) > width) {
		return {
			cells: kept,
			queue: "",
			lamp: "",
			seats: "",
			pause: "",
			countsRoom: Math.max(0, width),
		};
	}
	// The corner then re-grows into the room those cells left: the widest form
	// the row can hold beside them.
	const form =
		forms.find((candidate) => lineWidthOf(kept) + widthOf(candidate.cell) <= width) ?? bare;
	return {
		cells: kept,
		queue: form.queue,
		lamp: form.lamp,
		seats: form.seats,
		pause: form.pause,
		countsRoom: Math.max(0, width - widthOf(form.cell)),
	};
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
	queuePaused = false,
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
	const name = section === "tickets" ? "Tickets" : section === "work" ? "Work" : "Consultations";
	const lead = `${expanded ? "▾" : "▸"} ${name}`;
	// The ladder the row lays itself out at, measured on the row's own width and
	// never past the terminal the header renders in.
	const plan = planHeaderRow(Math.min(width, terminalWidth), [lead, ...cells], mode, queuePaused);
	const countsText = plan.cells.join("  ");
	// An expanded section wears bold: the emphasis the old palette carried in a
	// brighter text color. Each part of the row paints its own role, so the
	// mode cell reads in color while the counts keep the header's own ink.
	const face = expanded ? "b" : "span";
	const headerInk = expanded ? paint("text") : paint("subtext0");
	const parts = [
		createElement(
			face,
			{ key: "counts", fg: headerInk },
			padToWidth(truncateToWidth(countsText, plan.countsRoom), plan.countsRoom),
		),
	];
	// The row paints exactly the parts the plan named, so a part the row had no
	// room for is absent from the frame, not cut inside it.
	if (mode !== null && plan.lamp !== "") {
		// The Queue pause's lamp reads the fact from the standing read it shares
		// with the key that sets it (issue #319, ADR 0111): the lit lamp in the
		// running state's color while the brake is down, the unlit lamp in the
		// error color while it stands, and the written word either way.
		parts.push(createElement(face, { key: "queue", fg: queuePauseColor(queuePaused) }, plan.queue));
		parts.push(createElement(face, { key: "lamp", fg: autoHandoffColor(mode.mode) }, plan.lamp));
		if (plan.seats !== "") {
			parts.push(createElement(face, { key: "seats", fg: seatColor(mode.overLimit) }, plan.seats));
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
