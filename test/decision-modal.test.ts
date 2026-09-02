/**
 * The decision modal's body: the turn log's rows with their scrollbar.
 *
 * The scrollbar is a fixed column in the body's last cell. It must sit in
 * the same cell on every row, whether the row is full, short, or blank:
 * a thumb that floats behind short text reads as an artifact.
 */
import { describe, expect, test } from "vitest";

import { COLORS } from "../src/components/theme.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import {
	type AppSetup,
	awaitFrame,
	cellColors,
	rgb,
	rowsOf,
	sleep,
	withApp,
} from "./app-harness.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

const WIDTH = 120;
const HEIGHT = 12;
// The box spans the terminal minus one margin cell on every side, so its
// right border is the terminal's second-to-last column and the scrollbar's
// column is the body's last cell, just inside the padding.
const RIGHT_BORDER = WIDTH - 2;
const SCROLL_COL = WIDTH - 4;
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
	return (
		row.startsWith(" │") &&
		row[RIGHT_BORDER] === "│" &&
		row[SCROLL_COL] === "│" &&
		row.slice(2, SCROLL_COL).trim() === ""
	);
}

/** The body's rows of a decision modal frame: between the context row and the actions. */
function bodyRowsOf(frame: string): string[] {
	const rows = rowsOf(frame);
	const borderAt = rows.findIndex((row) => row.startsWith(" ┌─Decision:"));
	const closeAt = rows.findIndex((row) => row.includes("❯ Close"));
	if (borderAt < 0 || closeAt < borderAt + 4) return [];
	// borderAt + 1 is the box's top padding row, + 2 the context row.
	return rows.slice(borderAt + 3, closeAt);
}

/** Every body row pins its scrollbar in the last column of the body. */
function expectPinnedScrollbar(frame: string): void {
	const body = bodyRowsOf(frame);
	expect(body.length, `the modal rendered no body rows in:\n${frame}`).toBeGreaterThan(0);
	for (const row of body) {
		expect(row[RIGHT_BORDER], `row lost its right border: ${row}`).toBe("│");
		expect(["█", "│"], `the scrollbar is not in the body's last column: ${row}`).toContain(
			row[SCROLL_COL],
		);
		expect(row.slice(SCROLL_COL + 1, RIGHT_BORDER), `stray cells after the scrollbar: ${row}`).toBe(
			" ".repeat(RIGHT_BORDER - SCROLL_COL - 1),
		);
		expect(row.slice(2, SCROLL_COL).includes("█"), `a thumb floats mid-row: ${row}`).toBe(false);
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
	const bright = rgb(COLORS.textBright);
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
				// The modal has no hint row: the log is six rows and the
				// window holds three. It opens at the bottom, where the
				// agent's conclusion is.
				expect(body).toHaveLength(3);
				expect(body[body.length - 1]).toContain("All 142 tests pass.");
				expectPinnedScrollbar(settled);
				// The thumb rests on the newest rows; the track fills the rest.
				expect(body[body.length - 1][SCROLL_COL]).toBe("█");
				const rows = rowsOf(settled);
				expect(cellColors(setup, SCROLL_COL, rows.indexOf(body[body.length - 1])).fg).toEqual(
					rgb(COLORS.textBright),
				);
				const trackAt = body.findIndex((row) => row[SCROLL_COL] === "│");
				expect(cellColors(setup, SCROLL_COL, rows.indexOf(body[trackAt])).fg).toEqual(
					rgb(COLORS.dim),
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
