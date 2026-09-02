/**
 * The two reserved bottom rows at every terminal size.
 *
 * The base frame promises the Message line and the Action bar in the last two
 * rows, at any size, with any surface open above them (user stories 70 to 73).
 * Below the minimum useful size the panes give way to a size message and a
 * compact Help control, and a surface that cannot draw its own rows holds
 * itself back rather than painting a broken pane.
 *
 * Every test here reads the rendered frame: the row count, the width of every
 * row, and what the last row states. A modal drawing its border through its
 * own Action bar is the failure this file exists to catch.
 */
import { describe, expect, test } from "vitest";
import { widthOf } from "../src/components/text.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	actionBarRowOf,
	HEIGHT,
	markerRowOf,
	press,
	rowsOf,
	type Setup,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { FakeRunner } from "./fake-runner.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

/**
 * The glyphs only a border draws. The bar separates its own controls with
 * spaces, so one of these on its row means a box was drawn through it.
 */
const BORDER_GLYPHS = /[│┌┐└┘├┤]/;

/**
 * The frame contract at one size: exactly `height` rows, every row exactly
 * `width` cells, and the Action bar whole on the last row.
 */
async function expectReservedRows(setup: Setup, width: number, height: number): Promise<string> {
	const frame = await settle(setup);
	const rows = rowsOf(frame);
	expect(rows).toHaveLength(height);
	for (const row of rows) expect(widthOf(row)).toBe(width);
	expect(actionBarRowOf(frame)).not.toMatch(BORDER_GLYPHS);
	return frame;
}

/** Select the awaiting Ticket and open its decision. */
async function openDecision(setup: Setup): Promise<void> {
	await press(setup, "j", "the handed-off ticket", (f) => markerRowOf(f) === 3);
	await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
	await press(setup, "j", "the awaiting ticket", (f) => markerRowOf(f) === 5);
	await press(setup, "return", "the decision modal", (f) => f.includes("Decision:"));
}

/** Close the open surface, so the next case starts from the base frame. */
async function closeSurface(setup: Setup, what: RegExp): Promise<void> {
	await press(setup, "escape", "the surface to close", (f) => !what.test(f));
}

describe("the reserved bottom rows at every size", () => {
	test("the compact frame keeps its Help control at any height", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				// Three rows: the size message, the Message line, and the bar.
				setup.resize(18, 3);
				let frame = await expectReservedRows(setup, 18, 3);
				expect(frame).toContain("Terminal too small");
				expect(actionBarRowOf(frame).trim()).toBe("? Help");

				// Two rows: the Message line gives up before the bar does.
				setup.resize(18, 2);
				frame = await expectReservedRows(setup, 18, 2);
				expect(actionBarRowOf(frame).trim()).toBe("? Help");

				// One row: the bar alone, because Help is the way to find out
				// what happened.
				setup.resize(18, 1);
				frame = await expectReservedRows(setup, 18, 1);
				expect(actionBarRowOf(frame).trim()).toBe("? Help");

				// A short, wide frame still states the size and its minimum,
				// and keeps the Help control on the last row.
				setup.resize(120, 4);
				frame = await expectReservedRows(setup, 120, 4);
				expect(frame).toContain("Terminal too small: minimum 40 columns by 7 rows");
				expect(actionBarRowOf(frame).trim()).toBe("? Help");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	}, 20000);

	test("no open surface paints its Action bar over its own border", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openDecision(setup);

				// A five-row terminal cannot hold the modal's context line and
				// its action rows, so it states the size instead of drawing a
				// clipped pane, and the surface's own keys still work.
				setup.resize(120, 5);
				let frame = await expectReservedRows(setup, 120, 5);
				expect(frame).toContain("Terminal too small");
				expect(frame).toContain("Esc closes it");
				expect(frame).not.toContain("Goto");

				// A frame tall enough for the modal's rows draws it in full,
				// with the bar on its own row below the bottom border.
				setup.resize(120, 12);
				frame = await expectReservedRows(setup, 120, 12);
				expect(frame).toContain("Decision:");
				expect(frame).toContain("❯ Close");
				expect(actionBarRowOf(frame)).toContain("Select action");

				await closeSurface(setup, /Decision:/);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	}, 20000);

	test("the override panel keeps its rows above its own Action bar", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "e", "the override panel", (f) => f.includes("Override"));
				for (const [width, height] of [
					[120, 5],
					[120, 4],
					[18, 3],
					[30, 12],
				] as const) {
					setup.resize(width, height);
					const frame = await expectReservedRows(setup, width, height);
					// The panel scrolls its rows rather than drawing its border
					// through the bar, and states the size only when it cannot
					// hold a row at all.
					expect(frame).toMatch(/Override|Terminal too small/);
				}
				await closeSurface(setup, /Override:/);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	}, 20000);

	test("the Key guide keeps its own rows and its Close control", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "?", "the guide", (f) => f.includes("Key guide"));
				for (const [width, height] of [
					[120, 5],
					[120, 4],
					[18, 3],
				] as const) {
					setup.resize(width, height);
					const frame = await expectReservedRows(setup, width, height);
					// The guide names itself while it can draw a box and states
					// the size when it cannot; either way it stays open and
					// still says how to close it.
					expect(frame).toMatch(/Key guide|Terminal too small/);
					expect(actionBarRowOf(frame)).toContain("Close");
				}
				await closeSurface(setup, /Key guide/);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	}, 20000);
});
