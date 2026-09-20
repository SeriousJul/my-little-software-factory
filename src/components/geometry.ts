/**
 * Shared pane geometry.
 *
 * Every pane is a bordered box with one cell of inner padding, so its text
 * area is four cells smaller than the box in each dimension. The list pane
 * takes half the terminal width; the detail pane takes the rest. The list
 * box takes its box width from this math as an exact cell count, so one
 * computation owns the split and the rendered boxes can never drift from
 * the geometry the panes lay their text on.
 */
import { useTerminalDimensions } from "@opentui/react";

export interface PaneGeometry {
	/** The width of the pane's box in cells. */
	paneCols: number;
	/** The width of the pane's text area in cells. */
	usableCols: number;
	/** The height of the pane's text area in cells. */
	visibleRows: number;
}

/**
 * The geometry of one pane of the split.
 *
 * "list" takes the left half of the terminal, "detail" takes the half the
 * list does not take. One function serves both panes, so the two stay in
 * step when the layout changes.
 *
 * `reservedRows` are terminal rows the panes do not take: the app shell
 * reserves the permanent Message line and Action bar, plus its mode line
 * when observation state is active. The window math must agree with the
 * boxes, so the reservation travels to the panes as a prop.
 */
export function usePaneGeometry(kind: "list" | "detail", reservedRows = 0): PaneGeometry {
	const { width, height } = useTerminalDimensions();
	const paneCols = kind === "list" ? Math.floor(width / 2) : width - Math.floor(width / 2);
	return {
		paneCols,
		usableCols: Math.max(1, paneCols - 4),
		visibleRows: Math.max(1, height - reservedRows - 4),
	};
}

/**
 * How far a window of `visibleRows` lines can slide through `lineCount`
 * lines.
 *
 * The app shell uses this to clamp the detail scroll state, and
 * `windowOf` uses it to clamp a window start. One definition keeps the
 * two panes in step.
 */
export function maxScrollOf(lineCount: number, visibleRows: number): number {
	return Math.max(0, lineCount - visibleRows);
}

/**
 * A clamped window over a line list: `visibleRows` items starting at
 * `start`, clamped so the window never runs past either edge.
 *
 * Both panes slide a window over their lines through this one shape. The
 * list pane derives its start from the selection, the detail pane takes
 * the scroll it is handed.
 */
export function windowOf<T>(items: readonly T[], start: number, visibleRows: number): T[] {
	const offset = Math.max(0, Math.min(start, maxScrollOf(items.length, visibleRows)));
	return items.slice(offset, offset + visibleRows);
}

/** One Main view Section the left column can show, by its own id. */
export type MainSectionId = "ticket" | "consultation" | "work";

/** What the layout knows about one Section before it hands out rows. */
export interface SectionPlanInput {
	section: MainSectionId;
	/** True while the operator holds the section expanded (`x` or a click). */
	open: boolean;
	/** The rows the section's list holds: 0 for a list with nothing in it. */
	depth: number;
}

export interface SectionBoxLayoutInput {
	/** The rows the expanded sections share: the body less every header row. */
	totalRows: number;
	/** The rows a section reserves for its box: its minimum, chrome included. */
	minimumRows: number;
	/** The rows a section keeps before it gives way: one content row and chrome. */
	floorRows: number;
	/** The section the cursor rests on; it claims its rows first. */
	cursor: MainSectionId;
	/** Every section, in display order top to bottom. */
	sections: readonly SectionPlanInput[];
}

/**
 * The index of the claim that gives way when the body cannot pay them all.
 *
 * A section that holds no rows is the weakest claim on screen, and among
 * equals the lowest one gives way first - the same order the row plan already
 * reads, so an empty list never buys its floor rows out of a list the operator
 * is working in.
 */
function giveWayIndex(
	claims: readonly { depth: number; rows: number }[],
	floorRows: number,
): number {
	for (let index = claims.length - 1; index >= 0; index -= 1) {
		if (claims[index].depth === 0) return index;
	}
	for (let index = claims.length - 1; index >= 0; index -= 1) {
		if (claims[index].rows > floorRows) return index;
	}
	return claims.length - 1;
}

/** What the layout answers for one section: whether its box shows, and its rows. */
export interface SectionBox {
	open: boolean;
	rows: number;
}

/**
 * Hand the body's rows to the expanded Sections (ADR 0019, ADR 0034).
 *
 * The section the cursor rests on claims its minimum box first and takes what
 * the others leave: the list the operator works in gets the room. Every other
 * expanded section claims its minimum while it holds rows, and its floor - one
 * content row - while it holds none, so an empty list never buys its rows out
 * of the list that is being worked.
 *
 * When the body cannot pay those claims, one claim gives way at a time, and
 * the weakest pays first: a section that holds no rows collapses before one
 * that holds rows, and among equals the lowest on screen surrenders its
 * minimum down to its floor before it collapses. A section that cannot hold
 * its floor collapses rather than vanishes - its header keeps its row and its
 * counts, and the operator's own expansion stands, so a taller terminal
 * brings the box back by itself. The cursor's section never gives way.
 */
export function planSectionBoxes(input: SectionBoxLayoutInput): Record<MainSectionId, SectionBox> {
	const { totalRows, minimumRows, floorRows, cursor, sections } = input;
	const boxes = {} as Record<MainSectionId, SectionBox>;
	for (const entry of sections) boxes[entry.section] = { open: false, rows: 0 };
	const expanded = sections.filter((entry) => entry.open);
	if (expanded.length === 0) return boxes;
	// The cursor's section leads the claims; a cursor on a collapsed section
	// hands the lead to the first expanded one, the row the flow starts on.
	const leader = expanded.some((entry) => entry.section === cursor) ? cursor : expanded[0].section;
	const claims = expanded
		.filter((entry) => entry.section !== leader)
		.map((entry) => ({
			section: entry.section,
			depth: entry.depth,
			rows: entry.depth === 0 ? floorRows : minimumRows,
		}));
	const claimed = (): number => minimumRows + claims.reduce((sum, claim) => sum + claim.rows, 0);
	while (claims.length > 0 && claimed() > totalRows) {
		// The weakest claim on screen gives way: an empty list before a list
		// with rows, and among equals the lowest one.
		const givesWay = giveWayIndex(claims, floorRows);
		const claim = claims[givesWay];
		if (claim.rows > floorRows) {
			claim.rows = floorRows;
			continue;
		}
		// It already pays only its floor: the section collapses, and its
		// header keeps the section's place on screen.
		claims.splice(givesWay, 1);
	}
	let left = totalRows;
	for (const claim of claims) {
		const rows = Math.max(0, Math.min(left, claim.rows));
		boxes[claim.section] = { open: rows > 0, rows };
		left -= rows;
	}
	boxes[leader] = { open: left > 0, rows: Math.max(0, left) };
	return boxes;
}

/** Where the cursor rests within one Section's rows, as the flow sees them. */
export interface SectionFlowEntry {
	section: MainSectionId;
	/** True while the section's box is on screen, as the layout planned it. */
	open: boolean;
	/** True while the operator holds the section expanded (`x` or a click). */
	held: boolean;
	/** The rows its list holds; an empty list still holds its message row. */
	depth: number;
	/** The cursor's row within it. */
	index: number;
}

/** The row a cursor step lands on: a section and its index within it. */
export interface SectionFlowStep {
	section: MainSectionId;
	index: number;
}

/**
 * Step the unified cursor by one row through the visible flow (ADR 0019).
 *
 * The flow is the concatenation of the on-screen sections' rows, in display
 * order, so one table drives the cursor and the layout. Inside the cursor's
 * own section the step moves the row. At the edge - or on a section that is
 * not on screen, where the cursor rests on the boundary it collapsed to - the
 * step crosses to the nearest section in that direction the operator holds
 * open, skipping a section they collapsed, and takes that section's first row
 * going down or its last going up. A section the terminal could not pay for
 * still answers the cross: the cursor's own claim then brings its box back and
 * moves another section's rows, so no frame strands a section the operator
 * opened. An empty section holds one row too, so the cross reaches it and
 * reads its message. Null answers the step that would leave the flow.
 */
export function stepSectionFlow(
	flow: readonly SectionFlowEntry[],
	cursor: MainSectionId,
	delta: number,
): SectionFlowStep | null {
	const position = flow.findIndex((entry) => entry.section === cursor);
	if (position < 0) return null;
	const here = flow[position];
	const rows = here.open ? Math.max(1, here.depth) : 0;
	const inner = here.index + delta;
	if (here.open && inner >= 0 && inner < rows) return { section: here.section, index: inner };
	for (let step = position + delta; step >= 0 && step < flow.length; step += delta) {
		const entry = flow[step];
		if (!entry.open && !entry.held) continue;
		return {
			section: entry.section,
			index: delta > 0 ? 0 : Math.max(0, entry.depth - 1),
		};
	}
	return null;
}
