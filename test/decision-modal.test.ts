/**
 * The decision modal's body: the turn log's rows with their scrollbar.
 *
 * The scrollbar is a fixed column in the body's last cell. It must sit in
 * the same cell on every row, whether the row is full, short, or blank:
 * a thumb that floats behind short text reads as an artifact.
 */
import { describe, expect, test } from "bun:test";

import type { Ticket } from "../src/domain/ticket.ts";
import {
	type AppSetup,
	awaitFrame,
	cellColors,
	press,
	pressArrow,
	rgb,
	roleColor,
	rowsOf,
	sleep,
	withApp,
} from "./app-harness.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

const WIDTH = 120;
// The box at this height: nine box rows hold the context row, the pane's
// border and its three body rows, and the region's two rows, so the body
// scrolls and the pane keeps its border without its padding.
const HEIGHT = 15;
// The box spans the terminal minus one margin cell on every side, so its
// right border is the terminal's second-to-last column. The pane sits in the
// box's content, and its right border is two columns in from there; the
// scrollbar's column is the body's last cell, just inside the pane.
const RIGHT_BORDER = WIDTH - 2;
const PANE_RIGHT_BORDER = WIDTH - 4;
const SCROLL_COL = WIDTH - 5;
/** A terminal wide enough for the pop-in overflow to reach the last column. */
const WIDE = 145;
const WIDE_HEIGHT = 40;

/**
 * A long turn log: paragraphs long enough to wrap at every width the scan
 * runs, so the body carries full rows in a wide terminal.
 */
const LONG_BLOCKS = [
	"First I read the ticket and the linked discussion. I noted the failure mode and the affected code paths, then drafted the review. The draft covered the launcher, the visible list, and the drop rule.\n\n" +
		"Then I ran the full check. The launcher drops visible Ticket repositories that have no explanation. That is the core bug: the list filters them out without a reason, so the operator cannot tell why a repository disappeared. I wrote the finding up with a score and a verification list, and posted it as the review comment.\n\n" +
		"I traced the drop to the launcher's visibility filter. The filter keeps only repositories that carry an explicit ticket source, and it applies the rule before the detail pane asks for the repository's state. A repository whose source is removed, stale, or absent is dropped at that point, and no other part of the pipeline records the reason.",
	"Posted the review comment on #19.\n- Score: 58 / 100\n- Removed ready-for-review.\n- Verified: typecheck, lint, and 352 tests pass.",
];

/**
 * One awaiting ticket whose settled turn carries a short log: two text
 * blocks, so the body has a blank row between them. The log holds six
 * rows; the body window holds two, so the log scrolls.
 */
const awaitingSample = SAMPLE_TICKETS.find((ticket) => ticket.state === "awaiting");
if (awaitingSample === undefined || awaitingSample.lastCompletion === null) {
	throw new Error("sample tickets lost their awaiting ticket");
}
const awaitingTicket: Ticket = {
	...awaitingSample,
	lastCompletion: {
		...awaitingSample.lastCompletion,
		turnLog: [
			{
				kind: "text",
				text: "I traced the drop to the launcher filter.\n\nThe fix keeps the repository visible and shows the reason.",
			},
			{ kind: "text", text: "Posted the review comment on #19.\nAll 142 tests pass." },
		],
	},
};

/** The short-log ticket's settled turn, non-null: the sample guard above. */
const shortLogCompletion = awaitingTicket.lastCompletion;
if (shortLogCompletion === null) {
	throw new Error("sample tickets lost their awaiting completion");
}

/** The awaiting ticket with the long log, for the wide-terminal checks. */
const longLogTicket: Ticket = {
	...awaitingTicket,
	lastCompletion: {
		...shortLogCompletion,
		turnLog: LONG_BLOCKS.map((text) => ({ kind: "text" as const, text })),
	},
};

/** A body row with no text of its own: the row a blank log line renders as. */
function isBlankBodyRow(row: string): boolean {
	return row[3] === "│" && row[PANE_RIGHT_BORDER] === "│" && row.slice(4, SCROLL_COL).trim() === "";
}

/** The body's rows of a decision modal frame: inside the Turn log pane's border. */
function bodyRowsOf(frame: string): string[] {
	const rows = rowsOf(frame);
	const paneTop = rows.findIndex((row) => row.includes("Turn log"));
	// The pane's border, its three body rows, and its bottom border.
	return paneTop < 0 ? [] : rows.slice(paneTop + 1, paneTop + 4);
}

/** Every body row pins its scrollbar in the last column of the body. */
function expectPinnedScrollbar(frame: string): void {
	const body = bodyRowsOf(frame);
	expect(body.length, `the modal rendered no body rows in:\n${frame}`).toBeGreaterThan(0);
	for (const row of body) {
		expect(row[RIGHT_BORDER], `row lost its box border: ${row}`).toBe("│");
		expect(row[3], `row lost its pane's left border: ${row}`).toBe("│");
		expect(row[PANE_RIGHT_BORDER], `row lost its pane's right border: ${row}`).toBe("│");
		expect(["█", "│"], `the scrollbar is not in the body's last column: ${row}`).toContain(
			row[SCROLL_COL],
		);
		expect(
			row.slice(SCROLL_COL + 1, PANE_RIGHT_BORDER),
			`stray cells after the scrollbar: ${row}`,
		).toBe(" ".repeat(PANE_RIGHT_BORDER - SCROLL_COL - 1));
		expect(row.slice(4, SCROLL_COL).includes("█"), `a thumb floats mid-row: ${row}`).toBe(false);
	}
}

/**
 * Open the modal on the awaiting ticket and wait for the pop-in to finish.
 *
 * The pop-in fades the box in over 120 ms, so the last frames carry a
 * blended foreground. The wait ends when the thumb is fully bright, which
 * only happens at the final size.
 */
async function openModal(setup: AppSetup): Promise<string> {
	setup.mockInput.pressEnter();
	await awaitFrame(setup, (f) => f.includes("Decision:"), "the decision modal");
	const bright = rgb(roleColor("text"));
	return awaitFrame(
		setup,
		(frame) => {
			const rows = rowsOf(frame);
			const thumbRow = bodyRowsOf(frame).find((row) => row[SCROLL_COL] === "█");
			if (thumbRow === undefined) return false;
			const at = rows.indexOf(thumbRow);
			return cellColors(setup, SCROLL_COL, at).fg.every((v, i) => v === bright[i]);
		},
		"the pop-in to finish",
	);
}

/**
 * The pop-in grows the box over 120 ms. While it grows, every frame must
 * stay inside the terminal's edge: a line wider than the frame being drawn
 * overflows the modal, and a terminal that wraps at its last column turns
 * the overflow into a smudge of merged and shifted characters.
 */
describe("the decision modal's pop-in", () => {
	test("no content ever reaches the terminal's edge while the box grows", async () => {
		await withApp(
			async (setup) => {
				setup.mockInput.pressEnter();
				// Capture the whole pop-in, frame by frame, as it happens.
				const deadline = Date.now() + 300;
				let frames = 0;
				while (Date.now() < deadline) {
					const frame = setup.captureCharFrame();
					if (frame.includes("Decision:")) {
						const rows = rowsOf(frame);
						for (const [i, row] of rows.entries()) {
							// Above the bar, the last column holds the overlay's
							// background alone: no glyph may land there.
							if (i === rows.length - 1) continue;
							expect(row[WIDE - 1], `a glyph reached the last column on row ${i}:\n${row}`).toBe(
								" ",
							);
						}
						// The last row is the shared Action bar, not empty margin.
						expect(rows[rows.length - 1]).toContain("Help");
						frames += 1;
					}
					await sleep(5);
				}
				expect(
					frames,
					"the modal never rendered during the burst; the pop-in window was missed",
				).toBeGreaterThan(0);
				// The modal still settles cleanly at its final size.
				const settled = await awaitFrame(
					setup,
					(f) => rowsOf(f).some((row) => row[WIDE - 2] === "┐"),
					"the pop-in to finish",
				);
				// It opens at the bottom, where the conclusion sits.
				expect(rowsOf(settled).some((row) => row.includes("352"))).toBe(true);
			},
			WIDE,
			WIDE_HEIGHT,
			{ initialTickets: [longLogTicket] },
		);
	});
});

describe("the decision modal's scrollbar", () => {
	test("pins the thumb and track to the body's last column", async () => {
		await withApp(
			async (setup) => {
				const settled = await openModal(setup);
				const body = bodyRowsOf(settled);
				// The log is six rows, and the pane keeps the three the box has
				// left after the context row, the pane's border, and the region's
				// two rows take theirs. It opens at the bottom, where the agent's
				// conclusion is.
				expect(body).toHaveLength(3);
				expect(body[body.length - 1]).toContain("All 142 tests pass.");
				expectPinnedScrollbar(settled);
				// The thumb rests on the newest rows; the track fills the rest.
				expect(body[body.length - 1][SCROLL_COL]).toBe("█");
				const rows = rowsOf(settled);
				expect(cellColors(setup, SCROLL_COL, rows.indexOf(body[body.length - 1])).fg).toEqual(
					rgb(roleColor("text")),
				);
				const trackAt = body.findIndex((row) => row[SCROLL_COL] === "│");
				expect(cellColors(setup, SCROLL_COL, rows.indexOf(body[trackAt])).fg).toEqual(
					rgb(roleColor("subtext0")),
				);
			},
			WIDTH,
			HEIGHT,
			{ initialTickets: [awaitingTicket] },
		);
	});

	test("a blank row between text blocks keeps the track pinned", async () => {
		await withApp(
			async (setup) => {
				await openModal(setup);
				// One row up brings the blank row between the two text
				// blocks into the window.
				setup.mockInput.pressKey("k");
				const frame = await awaitFrame(
					setup,
					(f) => rowsOf(f).some(isBlankBodyRow),
					"the blank row in the log",
				);
				// It must be an empty row with its track in the last column,
				// not a lone mark next to the left border.
				expectPinnedScrollbar(frame);
			},
			WIDTH,
			HEIGHT,
			{ initialTickets: [awaitingTicket] },
		);
	});
});

/**
 * The nested border at the plane's declared minimum: the smallest terminal
 * the base app draws is the smallest terminal the modal can open on, so the
 * pane's border inside the box's border is the boundary the payment order
 * must hold. At 40 by 19 the box holds the context row, the pane with its
 * full chrome and its floor, and the region's two rows, and the keys still
 * dispatch in both regions.
 */
describe("the decision modal's nested border at the declared minimum", () => {
	const MIN_WIDTH = 40;
	const MIN_HEIGHT = 19;

	/** Open the modal at the minimum and wait for the pop-in to settle. */
	async function openAtMinimum(setup: AppSetup): Promise<string> {
		setup.mockInput.pressEnter();
		await awaitFrame(
			setup,
			(f) => rowsOf(f).some((row) => row.includes("Select action")),
			"the decision modal at the minimum",
		);
		// The pop-in grows the box to its final place over 120 ms; the frame
		// above may still hold it a row short of the edge.
		await sleep(250);
		return setup.captureCharFrame();
	}

	test("the pane keeps its full chrome inside the box, and the region keeps its rows", async () => {
		await withApp(
			async (setup) => {
				const frame = await openAtMinimum(setup);
				const rows = rowsOf(frame);
				// The box's border is the terminal's edge one cell in, on
				// every side that has a side: the box sits on the Message line.
				expect(rows[1].slice(0, 2)).toBe(" ┌");
				expect(rows[1][MIN_WIDTH - 2]).toBe("┐");
				expect(rows[MIN_HEIGHT - 3].slice(0, 2)).toBe(" └");
				expect(rows[MIN_HEIGHT - 3][MIN_WIDTH - 2]).toBe("┘");
				// The pane's border stands inside the box's padding, with its
				// own title, and the log's floor is inside it.
				const paneTop = rows.findIndex((row) => row.includes("Turn log"));
				expect(paneTop).toBeGreaterThan(1);
				expect(rows[paneTop].slice(0, 4)).toBe(" │ ┌");
				expect(rows[paneTop + 1].slice(0, 4)).toBe(" │ │");
				// The region's rows stand below the pane's bottom border, and
				// the selection is on Close, the first row.
				const paneBottom = rows.findIndex((row) => row.slice(2, 4).trim() === "└");
				expect(rows[paneBottom + 1]).toContain("❯ Close");
				expect(rows[paneBottom + 2]).toContain("Goto");
				// The bar names the region's controls at the minimum; the body
				// scroll's hint is trimmed at this width, the way the bar trims.
				const bar = rows[MIN_HEIGHT - 1];
				expect(bar).toContain("Select action");
			},
			MIN_WIDTH,
			MIN_HEIGHT,
			{ initialTickets: [awaitingTicket] },
		);
	});

	test("the keys dispatch in both regions at the minimum", async () => {
		await withApp(
			async (setup) => {
				await openAtMinimum(setup);
				// Down moves the region's selection to the Goto row.
				const moved = await pressArrow(setup, "down", "the selection on the Goto row", (f) =>
					rowsOf(f).some((row) => row.includes("❯ Goto")),
				);
				expect(moved).not.toContain("❯ Close");
				// k scrolls the body one row up, inside the nested pane: the
				// log's second line comes into view where it was not.
				expect(setup.captureCharFrame()).not.toContain("The fix keeps the repository");
				await press(setup, "k", "the body to scroll", (f) =>
					f.includes("The fix keeps the repository"),
				);
			},
			MIN_WIDTH,
			MIN_HEIGHT,
			{ initialTickets: [awaitingTicket] },
		);
	});
});
