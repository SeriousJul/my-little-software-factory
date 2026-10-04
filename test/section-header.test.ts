/**
 * The Section header's own cells, measured at the component seam.
 *
 * The Ticket header carries the machine's facts and one view fact beside them,
 * and the row truncates at its end rather than wrapping. Where the frame cannot
 * hold every cell, the order the cells stand in is the rule (ADR 0060): the
 * held count and the bell that rings on it outrank the ignored count, because a
 * held turn is a decision the plane is waiting on and an ignore is a judgment
 * it is not. The bell flashes for one moment in the running app, so this file
 * asks the component for the row it paints, on a held turn and a piled Ticket
 * side by side, at the widths where a cell must go.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { planHeaderRow, SectionHeader } from "../src/components/section-header.ts";
import { widthOf } from "../src/components/text.ts";
import type { AutoHandoffCell, AutoHandoffMode } from "../src/domain/section-facts.ts";
import { overParallelLimit } from "../src/parallel.ts";
import { frameText, rgb, roleColor, rowsOf, spanColorAt } from "./app-harness.ts";

let renderer: { destroy: () => void | Promise<void> } | null = null;
afterEach(async () => {
	await renderer?.destroy();
	renderer = null;
});

/**
 * The Tickets header's row at one width, on one set of facts.
 *
 * The narrow form (below 60 columns) drops the colons, so the caller's width
 * chooses both the truncation and the cell's wording.
 */
async function renderHeader(
	width: number,
	facts: { held: number; heldBell?: boolean; ignored?: number },
	mode: AutoHandoffCell | null = null,
): Promise<{ setup: Parameters<typeof spanColorAt>[0]; row: string }> {
	const setup = await testRender(
		createElement(SectionHeader, {
			section: "tickets",
			active: true,
			terminalWidth: width,
			width,
			expanded: true,
			open: 0,
			running: 0,
			awaiting: facts.held,
			held: facts.held,
			heldBell: facts.heldBell ?? false,
			ignored: facts.ignored ?? 0,
			mode,
			onToggle: () => undefined,
		}),
		{ width, height: 2 },
	);
	await setup.flush();
	renderer = setup.renderer;
	return { setup, row: (rowsOf(frameText(setup.captureCharFrame()))[0] ?? "").trim() };
}

async function headerRow(
	width: number,
	facts: { held: number; heldBell?: boolean; ignored?: number },
	mode: AutoHandoffCell | null = null,
): Promise<string> {
	return (await renderHeader(width, facts, mode)).row;
}

describe("the Section header's cell order", () => {
	test("every cell stands on a row wide enough to hold it", async () => {
		const row = await headerRow(72, { held: 1, heldBell: true, ignored: 3 });
		expect(row).toContain("Tickets");
		expect(row).toContain("held: 1");
		expect(row).toContain("!!!");
		expect(row).toContain("ignored: 3");
	});

	test("the held count and its bell stand where the ignored cell goes", async () => {
		// The same facts on a row that cannot hold both conditional cells: the
		// view fact goes whole, and the machine's decision fact stays with its bell.
		const row = await headerRow(54, { held: 1, heldBell: true, ignored: 3 });
		expect(row).toContain("Tickets");
		expect(row).toContain("held 1");
		expect(row).toContain("!!!");
		expect(row).not.toContain("ignored");
	});

	test("the ignored cell holds its place where no held turn rests", async () => {
		const row = await headerRow(54, { held: 0, ignored: 2 });
		expect(row).toContain("ignored 2");
		expect(row).not.toContain("held");
		expect(row).not.toContain("!!!");
	});
});

/**
 * The Auto-handoff mode's cell, on the facts the screen that owns the mode reads.
 *
 * The Parallel limit gate's answer comes from the shared rule the dispatch
 * gates read, the same way `src/components/app.ts` fills it, so the header's
 * seat color is measured against the gate itself and not against a second
 * statement of it.
 */
const cell = (
	mode: AutoHandoffMode,
	seats: number,
	limit: number,
	dispatchPaused = false,
): AutoHandoffCell => ({
	mode,
	seats,
	limit,
	overLimit: overParallelLimit(limit, seats),
	dispatchPaused,
});

/**
 * The Auto-handoff mode's lamp cell.
 *
 * The mode reads as a shape and a word at the row's right corner: the unlit
 * lamp with `auto`, the lit lamp with `manual`, and the Parallel limit's seat
 * count beside them. The shape carries the fact on its own, so the no-color
 * presentation needs no color for it, and the cell keeps its corner while the
 * counts give up cells before it does.
 */
describe("the Section header's mode lamp", () => {
	test("the unlit lamp, the word auto, and the seat count stand at the corner", async () => {
		const row = await headerRow(72, { held: 0 }, cell("auto", 1, 2));
		expect(row).toContain("Tickets");
		expect(row.endsWith("○ auto 1/2")).toBe(true);
	});

	test("the lit lamp, the word manual, and the seat count stand at the corner", async () => {
		const row = await headerRow(72, { held: 0 }, cell("manual", 1, 2));
		expect(row).toContain("Tickets");
		expect(row.endsWith("● manual 1/2")).toBe(true);
	});

	test("no parallel limit names the bare seat count, the way the mode cell did", async () => {
		const row = await headerRow(72, { held: 0 }, cell("manual", 3, 0));
		expect(row.endsWith("● manual 3")).toBe(true);
	});

	test("the Dispatch pause rides the mode cell (ADR 0016)", async () => {
		const row = await headerRow(72, { held: 0 }, cell("auto", 2, 3, true));
		expect(row.endsWith("○ auto 2/3 paused")).toBe(true);
	});

	test("no mode means no lamp cell, so a section that does not own it paints none", async () => {
		const row = await headerRow(72, { held: 0 });
		expect(row).not.toContain("auto");
		expect(row).not.toContain("manual");
		expect(row).not.toContain("●");
		expect(row).not.toContain("○");
	});

	test("a row wide enough holds every count beside the lamp", async () => {
		const row = await headerRow(84, { held: 1, heldBell: true, ignored: 3 }, cell("manual", 1, 2));
		expect(row).toContain("held: 1");
		expect(row).toContain("!!!");
		expect(row).toContain("ignored: 3");
		expect(row.endsWith("● manual 1/2")).toBe(true);
	});

	test("the counts give up whole cells before the lamp gives up its corner", async () => {
		// The facts that already overflow a 54-column row, now with the cell on
		// it: the mode keeps its corner, and whole count cells drop from the
		// counts' tail - the pile first, then the bell, then the held count -
		// only as far as the bare lamp needs. The cell then takes the seat
		// reading back into the room those cells left.
		const row = await headerRow(54, { held: 1, heldBell: true, ignored: 3 }, cell("manual", 1, 2));
		expect(row).toContain("Tickets");
		expect(row).toContain("awaiting 1");
		expect(row).not.toContain("ignored");
		expect(row).not.toContain("!!!");
		expect(row).not.toContain("held");
		expect(row.endsWith("● manual 1/2")).toBe(true);
	});

	test("the cell grows back at 56 and at 60 columns, where the row has the room", async () => {
		// The same facts on the rows the drop rule measured at 54 columns. The
		// counts give up only as far as the bare lamp needs, and the cell takes
		// back every part the room those cells left can hold: the seat reading
		// first, then the pause word.
		const at56 = await headerRow(56, { held: 1, heldBell: true, ignored: 3 }, cell("manual", 1, 2));
		expect(at56).not.toContain("ignored");
		expect(at56).not.toContain("!!!");
		expect(at56.endsWith("● manual 1/2")).toBe(true);
		// 60 columns is the wide form, and the row needs three count cells gone
		// before it can hold even the bare lamp: 69 columns of counts beside 9
		// columns of lamp. The seat reading then stands again in the room left.
		const at60 = await headerRow(60, { held: 1, heldBell: true, ignored: 3 }, cell("manual", 1, 2));
		expect(at60).toContain("awaiting: 1");
		expect(at60).not.toContain("held:");
		expect(at60).not.toContain("!!!");
		expect(at60).not.toContain("ignored");
		expect(at60.endsWith("● manual 1/2")).toBe(true);
	});

	test("the seat count gives up its cells before a held count does", async () => {
		// The same held header on a row too narrow for the full cell: the seat
		// reading goes, and the held count keeps its number (ADR 0060).
		const row = await headerRow(59, { held: 1 }, cell("manual", 2, 3));
		expect(row).toContain("held 1");
		expect(row).not.toContain("2/3");
		expect(row.endsWith("● manual")).toBe(true);
	});

	test("the seat count gives up before the pause word, and both before a count", async () => {
		// 66 cells: the lamp, its word, and the pause word fit beside the whole
		// count line, and the seat reading does not.
		const kept = await headerRow(66, { held: 1 }, cell("auto", 2, 3, true));
		expect(kept).toContain("held: 1");
		expect(kept.endsWith("○ auto paused")).toBe(true);
		// 62 cells: the pause word gives up its cells too, and the held count
		// stays whole.
		const tight = await headerRow(62, { held: 1 }, cell("auto", 2, 3, true));
		expect(tight).toContain("held: 1");
		expect(tight.endsWith("○ auto")).toBe(true);
	});

	test("the lamp and its word wear the mode's own color", async () => {
		// The mode the factory runs in on its own wears the warning color, and
		// the mode that waits for the operator wears the running state's color.
		const auto = await renderHeader(84, { held: 0 }, cell("auto", 1, 2));
		expect(spanColorAt(auto.setup, 0, "○ auto")).toEqual(rgb(roleColor("yellow")));
		const manual = await renderHeader(84, { held: 0 }, cell("manual", 1, 2));
		expect(spanColorAt(manual.setup, 0, "● manual")).toEqual(rgb(roleColor("green")));
		// The counts keep the header's own ink, so the corner is the colored
		// part of the row.
		expect(spanColorAt(manual.setup, 0, "Tickets")).toEqual(rgb(roleColor("text")));
		// The pause word rides the header's ink, not the mode's.
		const paused = await renderHeader(84, { held: 0 }, cell("auto", 1, 2, true));
		expect(spanColorAt(paused.setup, 0, "paused")).toEqual(rgb(roleColor("text")));
	});

	test("the seat reading wears the room color under the cap and the cap color at it", async () => {
		const room = await renderHeader(84, { held: 0 }, cell("manual", 1, 2));
		expect(spanColorAt(room.setup, 0, "1/2")).toEqual(rgb(roleColor("green")));
		// At the cap and over it the reading wears the error color: the
		// force-dispatched start and the held turn's seat both stand against the
		// cap (ADR 0034).
		const at = await renderHeader(84, { held: 0 }, cell("manual", 2, 2));
		expect(spanColorAt(at.setup, 0, "2/2")).toEqual(rgb(roleColor("red")));
		const over = await renderHeader(84, { held: 0 }, cell("auto", 3, 2));
		expect(spanColorAt(over.setup, 0, "3/2")).toEqual(rgb(roleColor("red")));
		// No limit states no cap, so the bare count never wears it.
		const bare = await renderHeader(84, { held: 0 }, cell("auto", 3, 0));
		expect(bare.row.endsWith("○ auto 3")).toBe(true);
		expect(spanColorAt(bare.setup, 0, " 3")).toEqual(rgb(roleColor("green")));
	});

	test("the seat color reads the gate's answer the cell carries, not its numbers", async () => {
		// The paint layer holds no Parallel limit gate of its own: it picks the
		// role from the boolean the screen fills from `overParallelLimit`, the one
		// rule the dispatch gates read. So the header's cap color follows that
		// rule, and a cell that states the gate's answer wears the color that
		// answer names whatever its seats and limit say.
		const stated = await renderHeader(
			84,
			{ held: 0 },
			{
				mode: "manual",
				seats: 1,
				limit: 2,
				overLimit: true,
				dispatchPaused: false,
			},
		);
		expect(spanColorAt(stated.setup, 0, "1/2")).toEqual(rgb(roleColor("red")));
		const under = await renderHeader(
			84,
			{ held: 0 },
			{
				mode: "manual",
				seats: 9,
				limit: 10,
				overLimit: false,
				dispatchPaused: false,
			},
		);
		expect(spanColorAt(under.setup, 0, "9/10")).toEqual(rgb(roleColor("green")));
	});

	test("a header never lays its row out past the terminal it renders in", async () => {
		// The width prop is the caller's claim about its own box, and the terminal
		// is the outer bound. A header that claims 60 columns inside a 40-column
		// terminal plans at 40: the counts give way whole, and the lamp keeps its
		// corner instead of being the first thing the box clips.
		const setup = await testRender(
			createElement(SectionHeader, {
				section: "tickets",
				active: true,
				terminalWidth: 40,
				width: 60,
				expanded: true,
				open: 2,
				running: 1,
				awaiting: 1,
				held: 1,
				heldBell: true,
				ignored: 3,
				mode: cell("manual", 1, 2),
				onToggle: () => undefined,
			}),
			{ width: 40, height: 2 },
		);
		await setup.flush();
		renderer = setup.renderer;
		// The raw character frame, not `frameText`: this test reads the columns the
		// row actually paints, and `frameText` collapses the runs between cells.
		const row = (rowsOf(setup.captureCharFrame())[0] ?? "").trimEnd();
		expect(row).toBe("▾ Tickets  open 2  running 1    ● manual");
		expect(row).not.toContain("awaiting");
		expect(row).not.toContain("held");
		expect(row).not.toContain("ignored");
		expect(widthOf(row)).toBe(40);
	});

	test("a row too short for its name and the bare lamp paints no mode cell", async () => {
		// Below the plane's 40-column floor the ladder runs out of count cells to
		// give up. The row then holds no corner cell at all rather than a lamp it
		// could only cut, and the plan names exactly what the frame shows.
		const row = await headerRow(12, { held: 1 }, cell("manual", 2, 3));
		expect(row).toBe("▾ Tickets");
		expect(row).not.toContain("manual");
		expect(row).not.toContain("●");
	});
});

/**
 * The ladder the row lays itself out at, measured without a renderer.
 *
 * `planHeaderRow` is arithmetic over the row's cells, so the order the cells
 * give way in reads here as the widths and the cells themselves. The rendered
 * cases above read the same ladder through the component.
 */
describe("the Section header's row plan", () => {
	// The Ticket header's cells on one set of facts, in each of the two forms.
	const wide = [
		"▾ Tickets",
		"open: 0",
		"running: 0",
		"awaiting: 1",
		"held: 1",
		"!!!",
		"ignored: 3",
	];
	const narrow = ["▾ Tickets", "open 0", "running 0", "awaiting 1", "held 1", "!!!", "ignored 3"];
	// The same header with no bell and no pile: the pause ladder's row.
	const wideHeld = ["▾ Tickets", "open: 0", "running: 0", "awaiting: 1", "held: 1"];
	const cellText = (plan: ReturnType<typeof planHeaderRow>): string =>
		`${plan.lamp}${plan.seats}${plan.pause}`;

	test("a row wide enough keeps every cell and every part of the mode cell", () => {
		const plan = planHeaderRow(84, wide, cell("manual", 1, 2));
		expect(plan.cells).toEqual(wide);
		expect(cellText(plan)).toBe(" ● manual 1/2");
	});

	test("the counts give way whole from their tail, and only as far as the bare lamp needs", () => {
		// 72 columns against 69 columns of counts and a 13-column cell: the pile
		// goes, and nothing else has to.
		expect(planHeaderRow(72, wide, cell("manual", 1, 2)).cells).toEqual(wide.slice(0, 6));
		// 66 columns: the pile is still gone and the seat reading has given way,
		// so the bell keeps its place.
		expect(planHeaderRow(66, wide, cell("manual", 1, 2)).cells).toEqual(wide.slice(0, 6));
		// 62 columns: the held count goes, and the lamp keeps all 9 of its columns.
		expect(planHeaderRow(62, wide, cell("manual", 1, 2)).cells).toEqual(wide.slice(0, 5));
		// 59 columns, narrow form: the pile and the bell go and the held count stands.
		expect(planHeaderRow(59, narrow, cell("manual", 1, 2)).cells).toEqual(narrow.slice(0, 5));
	});

	test("the mode cell grows back into the room the dropped cells left", () => {
		// 60 columns: three count cells have to go before the row can hold even
		// the bare lamp, and the room they leave holds the seat reading again.
		const at60 = planHeaderRow(60, wide, cell("manual", 1, 2));
		expect(at60.cells).toEqual(wide.slice(0, 4));
		expect(cellText(at60)).toBe(" ● manual 1/2");
		// 56 and 54 columns, narrow form: the row keeps 40 columns of counts and
		// wears the whole cell beside them.
		for (const width of [56, 54]) {
			const plan = planHeaderRow(width, narrow, cell("manual", 1, 2));
			expect(plan.cells).toEqual(narrow.slice(0, 4));
			expect(cellText(plan)).toBe(" ● manual 1/2");
		}
		// 40 columns, the plane's own floor: the seat reading gives way, the lamp
		// and its word do not.
		expect(cellText(planHeaderRow(40, narrow, cell("manual", 1, 2)))).toBe(" ● manual");
	});

	test("the seat reading gives way before the pause word", () => {
		// 66 columns of 52 columns of counts: the lamp and the pause word stand,
		// the seat reading does not.
		expect(cellText(planHeaderRow(66, wideHeld, cell("auto", 2, 3, true)))).toBe(" ○ auto paused");
		// 62 columns: the pause word goes with it, and no count cell does.
		const tight = planHeaderRow(62, wideHeld, cell("auto", 2, 3, true));
		expect(tight.cells).toEqual(wideHeld);
		expect(cellText(tight)).toBe(" ○ auto");
		// 54 columns, narrow form: the held count goes whole, and the pause word
		// the seat reading gave up stands again.
		const narrowPlan = planHeaderRow(54, narrow, cell("auto", 2, 3, true));
		expect(narrowPlan.cells).toEqual(narrow.slice(0, 4));
		expect(cellText(narrowPlan)).toBe(" ○ auto paused");
	});

	test("the name and the lamp stand whole, and no count cell is cut", () => {
		// Below the plane's 40-column floor the ladder keeps on dropping whole
		// cells: at 20 columns the row holds the name and the bare lamp and no
		// count at all, and it cuts none of them in half.
		const tiny = planHeaderRow(20, narrow, cell("manual", 1, 2));
		expect(tiny.cells).toEqual(["▾ Tickets"]);
		expect(cellText(tiny)).toBe(" ● manual");
	});

	test("a header that carries no mode cell lays its counts out as whole cells too", () => {
		// 54 columns against 64 columns of counts: the pile cell goes whole and
		// the row keeps the held count and its bell.
		const plan = planHeaderRow(54, narrow, null);
		expect(plan.cells).toEqual(narrow.slice(0, 6));
		expect(cellText(plan)).toBe("");
	});

	test("the plan states the room the counts paint into", () => {
		// The component paints from this number instead of measuring the mode cell
		// a second time. 84 columns beside a 13-column cell leaves 71.
		expect(planHeaderRow(84, wide, cell("manual", 1, 2)).countsRoom).toBe(71);
		// 62 columns: the held count has gone and the cell can only wear its bare
		// form, so the counts keep 53 of the row.
		const at62 = planHeaderRow(62, wide, cell("manual", 1, 2));
		expect(at62.cells).toEqual(wide.slice(0, 5));
		expect(cellText(at62)).toBe(" ● manual");
		expect(at62.countsRoom).toBe(53);
		// A row that carries no mode cell gives the counts its whole width.
		expect(planHeaderRow(54, narrow, null).countsRoom).toBe(54);
	});

	test("a row too short for its name and the bare lamp plans no mode cell", () => {
		// Below the plane's 40-column floor the ladder runs out of count cells to
		// give up, and the plan then names no lamp at all: at 12 columns the
		// 9-column name and the 9-column lamp cannot stand whole beside each other.
		const plan = planHeaderRow(12, narrow, cell("manual", 1, 2));
		expect(plan.cells).toEqual(["▾ Tickets"]);
		expect(cellText(plan)).toBe("");
		expect(plan.countsRoom).toBe(12);
		// At the floor the lamp stands whole, and the plan says so.
		expect(planHeaderRow(40, narrow, cell("manual", 1, 2)).lamp).toBe(" ● manual");
	});
});
