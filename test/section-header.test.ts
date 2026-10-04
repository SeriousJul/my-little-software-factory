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

import { type AutoHandoffMode, SectionHeader } from "../src/components/section-header.ts";
import { frameText, rowsOf } from "./app-harness.ts";

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
async function headerRow(
	width: number,
	facts: { held: number; heldBell?: boolean; ignored?: number },
	mode: AutoHandoffMode | null = null,
): Promise<string> {
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
	return (rowsOf(frameText(setup.captureCharFrame()))[0] ?? "").trim();
}

describe("the Section header's cell order", () => {
	test("every cell stands on a row wide enough to hold it", async () => {
		const row = await headerRow(72, { held: 1, heldBell: true, ignored: 3 });
		expect(row).toContain("Tickets");
		expect(row).toContain("held: 1");
		expect(row).toContain("!!!");
		expect(row).toContain("ignored: 3");
	});

	test("the held count and its bell stand where the ignored cell is cut", async () => {
		// The same facts on a row that cannot hold both conditional cells: the
		// view fact goes, and the machine's decision fact stays with its bell.
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
 * The Auto-handoff mode's lamp cell.
 *
 * The mode reads as a shape and a word at the row's right corner: the unlit
 * lamp with `auto`, the lit lamp with `manual`. The shape carries the fact on
 * its own, so the no-color presentation needs no color for it, and the cell
 * keeps its corner while the counts give up cells before it does.
 */
describe("the Section header's mode lamp", () => {
	test("the unlit lamp and the word auto stand at the row's right corner", async () => {
		const row = await headerRow(72, { held: 0 }, "auto");
		expect(row).toContain("Tickets");
		expect(row.endsWith("○ auto")).toBe(true);
	});

	test("the lit lamp and the word manual stand at the row's right corner", async () => {
		const row = await headerRow(72, { held: 0 }, "manual");
		expect(row).toContain("Tickets");
		expect(row.endsWith("● manual")).toBe(true);
	});

	test("no mode means no lamp cell, so a section that does not own it paints none", async () => {
		const row = await headerRow(72, { held: 0 });
		expect(row).not.toContain("auto");
		expect(row).not.toContain("manual");
		expect(row).not.toContain("●");
		expect(row).not.toContain("○");
	});

	test("a row wide enough holds every count beside the lamp", async () => {
		const row = await headerRow(80, { held: 1, heldBell: true, ignored: 3 }, "manual");
		expect(row).toContain("held: 1");
		expect(row).toContain("!!!");
		expect(row).toContain("ignored: 3");
		expect(row.endsWith("● manual")).toBe(true);
	});

	test("the counts give up their cells before the lamp gives up its corner", async () => {
		// The facts that already overflow a 54-column row, now with the lamp on
		// it: the mode keeps its corner, and the counts are what truncates.
		const row = await headerRow(54, { held: 1, heldBell: true, ignored: 3 }, "manual");
		expect(row).toContain("Tickets");
		expect(row).toContain("awaiting 1");
		expect(row).not.toContain("ignored");
		expect(row.endsWith("● manual")).toBe(true);
	});
});
