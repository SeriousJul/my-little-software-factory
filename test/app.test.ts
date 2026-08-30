/**
 * The single seam: the rendered terminal frame.
 *
 * The app renders headless through the first-party OpenTUI test renderer.
 * Mock keys drive it, the character frame is captured, and the tests assert
 * on what an operator would see. The sample-data contract is observed the
 * same way: no test reads the sample data directly and passes.
 *
 * Three harness rules keep the suite honest:
 *
 * - Waits end on the effect being asserted, or on a hard deadline. Keys
 *   dispatch through the stdin parser's 20ms escape-sequence timer, which
 *   the renderer's event-driven waits do not cover, so the press helpers
 *   poll the frame until the effect appears and fail loudly at the
 *   deadline. No correctness wait is a fixed sleep.
 * - Stability waits never trust a pre-dispatch frame. In this harness a
 *   frame change lands 14-16 ms after the press, so `settle` waits out a
 *   30 ms dispatch grace first and then requires two consecutive
 *   identical polls. A no-op key cannot read as stable before it was
 *   dispatched.
 * - console.error is captured, not suppressed. The React act() warning is
 *   the known noise of this setup: the test renderer drives real renders
 *   outside act. Anything else is a defect and fails the test.
 *
 * The renderer is a system resource of the test. `withApp` boots it, runs
 * the test body, and destroys it in a finally, so no test body owns its
 * own cleanup.
 */
import { CliRenderEvents } from "@opentui/core";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { App, type AppKey } from "../src/components/app.ts";
import { SAMPLE_TICKETS } from "../src/data/sample-tickets.ts";
import { TICKET_STATES, type Ticket } from "../src/domain/ticket.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

const WIDTH = 120;
const HEIGHT = 30;
const FRAME_POLL_MS = 10;
const FRAME_DEADLINE_MS = 2000;
/** The dispatch grace `settle` waits out before trusting stability. */
const SETTLE_GRACE_MS = 30;
/** The state badge the list pane renders for each ticket state. */
const STATE_BADGES = TICKET_STATES.map((state) => `[${state}]`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The panes wrap long text, so substring checks run on the frame with the
// box borders stripped and the whitespace collapsed: wrapped lines merge
// back into the source string at their word-boundary breaks.
const frameText = (frame: string) => frame.replace(/[│┌┐└┘─]/g, " ").replace(/\s+/g, " ");
const rowsOf = (frame: string) => frame.replace(/\n$/, "").split("\n");
/** The terminal row of the selected ticket in the list pane. */
const markerRowOf = (frame: string) => rowsOf(frame).findIndex((row) => row.startsWith("│ ❯"));
/**
 * A stable leading substring of a ticket's description, for frame checks.
 *
 * It ends at a word boundary, so it survives the merge of wrapped lines:
 * the wrap points are word boundaries too. The full description is fragile
 * to a word wider than the pane: the hard wrap cuts the word mid-word, the
 * merge turns the cut into a space, and the check would fail with a
 * confusing last-frame dump at the press helper's deadline.
 */
const descriptionLeadOf = (ticket: Ticket): string =>
	ticket.description.split(" ").slice(0, 4).join(" ");
const showsTicket = (frame: string, ticket: Ticket) =>
	frameText(frame).includes(descriptionLeadOf(ticket));
const agentRowOf = (frame: string) =>
	rowsOf(frame).findIndex((row) => row.includes("Agent: unassigned"));
/** Assert every ticket state badge is on screen, read off the frame. */
function expectStateBadges(frame: string): void {
	for (const badge of STATE_BADGES) {
		expect(frame).toContain(badge);
	}
}
/** Frame predicate: the detail pane holds the focus. */
const detailFocused = (frame: string) => frame.includes("❯ Detail") && !frame.includes("❯ Tickets");
/** Frame predicate: the list pane holds the focus. */
const listFocused = (frame: string) => frame.includes("❯ Tickets") && !frame.includes("❯ Detail");

let errorCalls: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	errorCalls = [];
	errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errorCalls.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	const unexpected = errorCalls.filter((call) => !/was not wrapped in act/.test(call));
	expect(unexpected, `unexpected console.error output:\n${unexpected.join("\n---\n")}`).toEqual([]);
	errorSpy.mockRestore();
});

async function bootApp(width = WIDTH, height = HEIGHT) {
	const setup = await testRender(createElement(App), { width, height });
	await setup.flush();
	return setup;
}

/**
 * Boot the app at a fixed size, run `body`, and always destroy the
 * renderer, no matter how the body ends.
 */
async function withApp(
	body: (setup: Setup) => Promise<void>,
	width = WIDTH,
	height = HEIGHT,
): Promise<void> {
	const setup = await bootApp(width, height);
	try {
		await body(setup);
	} finally {
		setup.renderer.destroy();
	}
}

/**
 * Wait for the rendered frame to satisfy `predicate`, and return it.
 *
 * The wait ends when the effect appears, or the deadline fails the test
 * with the last frame. A stale frame can never pass an assertion.
 */
async function awaitFrame(
	setup: Setup,
	predicate: (frame: string) => boolean,
	what: string,
): Promise<string> {
	const deadline = Date.now() + FRAME_DEADLINE_MS;
	let frame = setup.captureCharFrame();
	for (;;) {
		if (predicate(frame)) {
			return frame;
		}
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${what}\nlast frame:\n${frame}`);
		}
		await sleep(FRAME_POLL_MS);
		frame = setup.captureCharFrame();
	}
}

/** Press a key the shell handles, and wait for the effect it should produce. */
async function press(
	setup: Setup,
	key: AppKey,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressKey(key);
	return awaitFrame(setup, predicate, what);
}

/** Press an arrow key and wait for the effect it should produce. */
async function pressArrow(
	setup: Setup,
	direction: "up" | "down" | "left" | "right",
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressArrow(direction);
	return awaitFrame(setup, predicate, what);
}

/** Press `l` and wait for the detail pane to take focus. */
async function focusDetail(setup: Setup): Promise<string> {
	return press(setup, "l", "the detail pane to take focus", detailFocused);
}

/**
 * Wait for the frame to stop changing, and return it.
 *
 * For keys that should change nothing, stability is the assertion.
 */
async function settle(setup: Setup, maxMs = 300): Promise<string> {
	await sleep(SETTLE_GRACE_MS);
	const deadline = Date.now() + maxMs;
	let last = setup.captureCharFrame();
	let stablePolls = 0;
	for (;;) {
		await sleep(FRAME_POLL_MS);
		const current = setup.captureCharFrame();
		if (current === last) {
			stablePolls += 1;
			if (stablePolls >= 2) {
				return current;
			}
		} else {
			stablePolls = 0;
			last = current;
		}
		if (Date.now() >= deadline) {
			return current;
		}
	}
}

describe("the control plane", () => {
	test("list pane shows every sample ticket with title, repository, and state badge", async () => {
		await withApp(async (setup) => {
			const frame = frameText(setup.captureCharFrame());
			for (const ticket of SAMPLE_TICKETS) {
				expect(frame).toContain(ticket.title);
				expect(frame).toContain(ticket.repository);
			}
			expectStateBadges(frame);
		});
	});

	test("detail pane shows the full detail of the selected ticket", async () => {
		await withApp(async (setup) => {
			const frame = frameText(setup.captureCharFrame());
			const first = SAMPLE_TICKETS[0];
			// The full title and description live in the detail pane.
			expect(frame).toContain(first.description);
			expect(frame).toContain("Agent: unassigned");
			expect(frame).toContain("GitHub: open");
		});
	});

	test("the sample-data contract is observable in the rendered frame", async () => {
		await withApp(async (setup) => {
			// Every ticket state is on screen at once.
			let frame = frameText(setup.captureCharFrame());
			expectStateBadges(frame);

			// The sample set spans more than one repository, read off the
			// frame, not the data.
			const repos = new Set([...frame.matchAll(/\b[a-z]+\/[a-z-]+\b/g)].map((m) => m[0]));
			expect(repos.size).toBeGreaterThanOrEqual(2);

			// A ticket can carry the GitHub closed status. Navigate to the
			// done ticket and read the source fact in the detail pane.
			for (let i = 1; i <= 3; i += 1) {
				await press(setup, "j", `the selection to move to ticket ${i + 1}`, (f) =>
					showsTicket(f, SAMPLE_TICKETS[i]),
				);
			}
			frame = frameText(setup.captureCharFrame());
			expect(frame).toContain("GitHub: closed");
			// The closed ticket is done: ticket state and GitHub status
			// stay distinct facts.
			expect(frame).toContain("[done]");
		});
	});

	test("j and k move the selection down and up", async () => {
		await withApp(async (setup) => {
			await press(
				setup,
				"j",
				"the selection to move to the second ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[1]) && !showsTicket(f, SAMPLE_TICKETS[0]),
			);
			await press(
				setup,
				"k",
				"the selection to move back to the first ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[0]) && !showsTicket(f, SAMPLE_TICKETS[1]),
			);
		});
	});

	test("the up and down arrows move the selection", async () => {
		await withApp(async (setup) => {
			await pressArrow(setup, "down", "the selection to move to the second ticket", (f) =>
				showsTicket(f, SAMPLE_TICKETS[1]),
			);
			await pressArrow(
				setup,
				"up",
				"the selection to move back to the first ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[0]) && !showsTicket(f, SAMPLE_TICKETS[1]),
			);
		});
	});

	test("l and h switch pane focus and the vertical keys stay with the focus", async () => {
		await withApp(async (setup) => {
			// Focus starts on the list pane.
			let frame = setup.captureCharFrame();
			expect(frame).toContain("❯ Tickets");
			expect(frame).not.toContain("❯ Detail");

			// l moves the focus to the detail pane.
			frame = await focusDetail(setup);

			// j with the detail focused scrolls the detail, it does not
			// move the selection. At this size the detail does not
			// overflow, so the frame does not change and the marker stays
			// on the first ticket.
			const before = setup.captureCharFrame();
			setup.mockInput.pressKey("j");
			const after = await settle(setup);
			expect(after).toBe(before);
			expect(markerRowOf(after)).toBe(2);

			// h moves the focus back to the list pane; the selection is
			// preserved.
			frame = await press(setup, "h", "the list pane to take focus", listFocused);
			expect(markerRowOf(frame)).toBe(2);
			expect(showsTicket(frame, SAMPLE_TICKETS[0])).toBe(true);
		});
	});

	test("the left and right arrows switch pane focus and the selection is preserved", async () => {
		await withApp(async (setup) => {
			// Move the selection to the second ticket while the list is
			// focused.
			await press(
				setup,
				"j",
				"the selection to move to the second ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[1]) && markerRowOf(f) === 3,
			);

			// The right arrow focuses the detail pane. The selection is
			// preserved: the marker stays on the second row and the detail
			// still shows the second ticket.
			const right = await pressArrow(
				setup,
				"right",
				"the detail pane to take focus",
				detailFocused,
			);
			expect(markerRowOf(right)).toBe(3);
			expect(showsTicket(right, SAMPLE_TICKETS[1])).toBe(true);

			// The left arrow focuses the list pane. The selection is
			// preserved.
			const left = await pressArrow(setup, "left", "the list pane to take focus", listFocused);
			expect(markerRowOf(left)).toBe(3);
			expect(showsTicket(left, SAMPLE_TICKETS[1])).toBe(true);
		});
	});

	test("j and k scroll the detail pane when it is focused", async () => {
		await withApp(
			async (setup) => {
				// Focus the detail pane; the list keeps its selection.
				await focusDetail(setup);
				const agentRow = agentRowOf(setup.captureCharFrame());
				expect(agentRow).toBeGreaterThan(0);
				expect(markerRowOf(setup.captureCharFrame())).toBe(2);

				// j scrolls the detail down one row. The title scrolls out.
				const scrolled = await press(
					setup,
					"j",
					"the detail to scroll down one row",
					(f) => agentRowOf(f) === agentRow - 1 && !f.includes("Retry policy for webhooks"),
				);
				// The selection did not move.
				expect(markerRowOf(scrolled)).toBe(2);

				// k scrolls back to the top. The title is back.
				const back = await press(
					setup,
					"k",
					"the detail to scroll back to the top",
					(f) => agentRowOf(f) === agentRow && f.includes("Retry policy for webhooks"),
				);
				expect(markerRowOf(back)).toBe(2);
			},
			60,
			8,
		);
	});

	test("the detail scroll stays within its bounds", async () => {
		await withApp(
			async (setup) => {
				await focusDetail(setup);

				// At the top edge, k cannot scroll up.
				const before = setup.captureCharFrame();
				setup.mockInput.pressKey("k");
				const afterTop = await settle(setup);
				expect(afterTop).toBe(before);

				// Press j past the bottom edge, one key at a time. The detail
				// settles on its last page: the final description line is
				// visible and the title is out of view.
				for (let i = 0; i < 12; i += 1) {
					setup.mockInput.pressKey("j");
					await sleep(25);
				}
				const atBottom = await awaitFrame(
					setup,
					(f) =>
						frameText(f).includes("their retries.") && !f.includes("Retry policy for webhooks"),
					"the detail to reach its bottom",
				);

				// One more j at the bottom edge changes nothing.
				setup.mockInput.pressKey("j");
				const afterBottom = await settle(setup);
				expect(afterBottom).toBe(atBottom);

				// The selection never moved.
				expect(markerRowOf(atBottom)).toBe(2);
			},
			60,
			8,
		);
	});

	test("q ends the app", async () => {
		// The app destroys the renderer itself, so this test does not
		// wrap the body in withApp.
		const setup = await bootApp();
		const destroyed = new Promise<boolean>((resolve) => {
			setup.renderer.once(CliRenderEvents.DESTROY, () => resolve(true));
			setTimeout(() => resolve(false), 2000).unref();
		});
		setup.mockInput.pressKey("q");
		expect(await destroyed).toBe(true);
	});

	test("the list pane window slides when the tickets overflow the pane", async () => {
		await withApp(
			async (setup) => {
				// The pane shows two rows at this height: the first two tickets
				// only.
				const frame = frameText(setup.captureCharFrame());
				expect(frame).toContain(SAMPLE_TICKETS[0].title);
				expect(frame).toContain(SAMPLE_TICKETS[1].title);
				expect(frame).not.toContain(SAMPLE_TICKETS[2].title);
				expect(frame).not.toContain(SAMPLE_TICKETS[3].title);

				// Moving the selection slides the window.
				await press(
					setup,
					"j",
					"the selection to move to the second ticket",
					(f) => markerRowOf(f) === 3,
				);
				await press(
					setup,
					"j",
					"the window to keep the third ticket in view",
					(f) =>
						frameText(f).includes(SAMPLE_TICKETS[2].title) &&
						!frameText(f).includes(SAMPLE_TICKETS[0].title),
				);
				await press(
					setup,
					"j",
					"the window to slide to the last tickets",
					(f) =>
						frameText(f).includes(SAMPLE_TICKETS[3].title) &&
						!frameText(f).includes(SAMPLE_TICKETS[1].title),
				);
			},
			WIDTH,
			6,
		);
	});

	test("resizing the terminal keeps the panes on the grid and the selection", async () => {
		await withApp(async (setup) => {
			// Move the selection so the resize has something to preserve.
			await press(
				setup,
				"j",
				"the selection to move to the second ticket",
				(f) => showsTicket(f, SAMPLE_TICKETS[1]) && markerRowOf(f) === 3,
			);

			// Shrink the terminal mid-session.
			setup.resize(60, 12);
			const small = await awaitFrame(
				setup,
				(f) =>
					rowsOf(f).length === 12 &&
					rowsOf(f).every((row) => row.length === 60) &&
					f.includes("Tickets") &&
					f.includes("Detail"),
				"the frame to take the new size",
			);
			// Both panes and the selection survive the resize.
			expect(small).toContain("Tickets");
			expect(small).toContain("Detail");
			expect(markerRowOf(small)).toBe(3);

			// Grow it back.
			setup.resize(120, 30);
			const large = await awaitFrame(
				setup,
				(f) =>
					rowsOf(f).length === 30 &&
					rowsOf(f).every((row) => row.length === 120) &&
					f.includes("Tickets") &&
					f.includes("Detail"),
				"the frame to take the original size",
			);
			expect(large).toContain("Tickets");
			expect(large).toContain("Detail");
			expect(markerRowOf(large)).toBe(3);
			expect(showsTicket(large, SAMPLE_TICKETS[1])).toBe(true);
		});
	});

	test("the layout adapts to the terminal size", async () => {
		for (const [width, height] of [
			[80, 24],
			[160, 40],
		]) {
			await withApp(
				async (setup) => {
					const rows = rowsOf(setup.captureCharFrame());
					expect(rows).toHaveLength(height);
					for (const row of rows) {
						expect(row.length).toBe(width);
					}
					// Both panes and every sample state survive at this size.
					const frame = frameText(setup.captureCharFrame());
					expect(frame).toContain("Tickets");
					expect(frame).toContain("Detail");
					expectStateBadges(frame);
				},
				width,
				height,
			);
		}
	});

	test("odd terminal widths keep the row width and the pane padding intact", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(25);
				for (const row of rows) {
					expect(row.length).toBe(75);
				}
				// The split puts the list box on columns 0-36 and the detail
				// box on 37-74. At an odd width a "50%" list would take 38
				// columns, and the shared geometry would then lay text one
				// cell off the rendered box.
				for (const row of rows.slice(1, -1)) {
					expect(row[0]).toBe("│");
					expect(row[36]).toBe("│");
					expect(row[37]).toBe("│");
					expect(row[74]).toBe("│");
					// One cell of padding between every border and the text:
					// no text cell sits adjacent to a border.
					expect(row[1]).toBe(" ");
					expect(row[35]).toBe(" ");
					expect(row[38]).toBe(" ");
					expect(row[73]).toBe(" ");
				}
				// The detail pane carries its content at this size.
				expect(frameText(setup.captureCharFrame())).toContain("GitHub: open");
			},
			75,
			25,
		);
	});

	test("list rows keep the title and drop the repository when the row cannot hold both", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(12);
				// Every terminal row is exactly as wide as the terminal:
				// nothing wrapped or overflowed.
				for (const row of rows) {
					expect(row.length).toBe(60);
				}
				// At this width the row budget after the marker and the badge
				// cannot hold both the repository and a readable title. The
				// title keeps its space, and the repository drops from the list
				// row instead of pushing the title out.
				const row = rows.find((r) => r.includes("[handed-off]"));
				expect(row).toBeDefined();
				// The list pane's content cells, borders and padding stripped:
				// marker, badge, gap, and the title cut to the eleven cells
				// the row still has.
				const listHalf = (row ?? "").slice(2, 28);
				expect(listHalf).toBe("  [handed-off] Fix pan dri");
				expect(listHalf).not.toContain("acme/");
				// The repository stays reachable in the detail pane of the
				// selected ticket.
				expect(frameText(setup.captureCharFrame())).toContain("acme/billing");
			},
			60,
			12,
		);
	});

	test("narrow terminals drop fields instead of corrupting rows", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(12);
				// Every terminal row is exactly as wide as the terminal:
				// nothing wrapped or overflowed.
				for (const row of rows) {
					expect(row.length).toBe(40);
				}
				// The list row for the handed-off ticket keeps its fields in
				// order. The repository, which no longer fits, is dropped from
				// the list rows instead of interleaved into them.
				const row = rows.find((r) => r.includes("[handed-off]"));
				expect(row).toBeDefined();
				// The list pane's content cells, borders and padding stripped:
				// marker, badge, gap, and the title cut to the two cells left.
				const listHalf = (row ?? "").slice(2, 18);
				expect(listHalf).toBe("  [handed-off] F");
				// The repository is dropped from the row, not interleaved into it.
				expect(listHalf).not.toContain("acme/");
			},
			40,
			12,
		);
	});

	test("tiny terminals stay intact", async () => {
		await withApp(
			async (setup) => {
				const rows = rowsOf(setup.captureCharFrame());
				expect(rows).toHaveLength(8);
				for (const row of rows) {
					expect(row.length).toBe(8);
				}
			},
			8,
			8,
		);
	});
});
