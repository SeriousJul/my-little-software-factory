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

import { SectionHeader } from "../src/components/section-header.ts";
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
