/**
 * The single seam: the rendered terminal frame.
 *
 * The app renders headless at a fixed size through the first-party OpenTUI
 * test renderer. Mock keys drive it, the character frame is captured, and
 * the tests assert on what an operator would see.
 */
import { CliRenderEvents } from "@opentui/core";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { App } from "../src/components/app.ts";
import { SAMPLE_TICKETS } from "../src/data/sample-tickets.ts";

type Setup = Awaited<ReturnType<typeof testRender>>;

const WIDTH = 120;
const HEIGHT = 30;

async function bootApp(width = WIDTH, height = HEIGHT) {
	const setup = await testRender(createElement(App), { width, height });
	await setup.flush();
	return setup;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The renderer's stdin parser holds every key for 20ms to disambiguate
// escape sequences before it dispatches it. The press helpers wait out that
// window and then let the renderer settle before the caller captures.
async function press(setup: Setup, key: string) {
	setup.mockInput.pressKey(key);
	await sleep(60);
	await setup.flush();
}

async function pressArrow(setup: Setup, direction: "up" | "down" | "left" | "right") {
	setup.mockInput.pressArrow(direction);
	await sleep(60);
	await setup.flush();
}

// The panes wrap long text, so substring checks run on frames with the box
// borders stripped and the whitespace collapsed: wrapped lines merge back
// into the source string.
const squash = (text: string) => text.replace(/\s+/g, " ");
const squashFrame = (setup: Setup) => squash(setup.captureCharFrame().replace(/[│┌┐└┘─]/g, " "));
const rowsOf = (setup: Setup) => setup.captureCharFrame().replace(/\n$/, "").split("\n");

beforeAll(() => {
	// React act() warnings are noise here: the keypresses drive real renders.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the control plane", () => {
	test("list pane shows every sample ticket with title, repository, and state badge", async () => {
		const setup = await bootApp();
		try {
			const frame = squashFrame(setup);
			for (const ticket of SAMPLE_TICKETS) {
				expect(frame).toContain(ticket.title);
				expect(frame).toContain(ticket.repository);
			}
			for (const badge of ["[open]", "[handed-off]", "[running]", "[done]"]) {
				expect(frame).toContain(badge);
			}
		} finally {
			setup.renderer.destroy();
		}
	});

	test("detail pane shows the full detail of the selected ticket", async () => {
		const setup = await bootApp();
		try {
			const frame = squashFrame(setup);
			const first = SAMPLE_TICKETS[0];
			// The full title and description live in the detail pane.
			expect(frame).toContain(first.description);
			expect(frame).toContain("Agent: unassigned");
			expect(frame).toContain("GitHub: open");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("j and k move the selection down and up", async () => {
		const setup = await bootApp();
		try {
			await press(setup, "j");
			let frame = squashFrame(setup);
			expect(frame).toContain(SAMPLE_TICKETS[1].description);
			expect(frame).not.toContain(SAMPLE_TICKETS[0].description);

			await press(setup, "k");
			frame = squashFrame(setup);
			expect(frame).toContain(SAMPLE_TICKETS[0].description);
			expect(frame).not.toContain(SAMPLE_TICKETS[1].description);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("the up and down arrows move the selection", async () => {
		const setup = await bootApp();
		try {
			await pressArrow(setup, "down");
			let frame = squashFrame(setup);
			expect(frame).toContain(SAMPLE_TICKETS[1].description);

			await pressArrow(setup, "up");
			frame = squashFrame(setup);
			expect(frame).toContain(SAMPLE_TICKETS[0].description);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("l and h switch pane focus and the selection is preserved", async () => {
		const setup = await bootApp();
		try {
			// Focus starts on the list pane.
			let frame = squashFrame(setup);
			expect(frame).toContain("❯ Tickets");
			expect(frame).toContain("Detail");

			// l moves the focus to the detail pane.
			await press(setup, "l");
			frame = squashFrame(setup);
			expect(frame).toContain("❯ Detail");
			expect(frame).not.toContain("❯ Tickets");

			// The selection still moves while the detail pane is focused.
			await press(setup, "j");
			frame = squashFrame(setup);
			expect(frame).toContain(SAMPLE_TICKETS[1].description);

			// h moves the focus back to the list pane; the selection is preserved.
			await press(setup, "h");
			frame = squashFrame(setup);
			expect(frame).toContain("❯ Tickets");
			expect(frame).toContain(SAMPLE_TICKETS[1].description);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("the left and right arrows switch pane focus", async () => {
		const setup = await bootApp();
		try {
			await pressArrow(setup, "right");
			let frame = squashFrame(setup);
			expect(frame).toContain("❯ Detail");

			await pressArrow(setup, "left");
			frame = squashFrame(setup);
			expect(frame).toContain("❯ Tickets");
		} finally {
			setup.renderer.destroy();
		}
	});

	test("q ends the app", async () => {
		const setup = await bootApp();
		const destroyed = new Promise<boolean>((resolve) => {
			setup.renderer.once(CliRenderEvents.DESTROY, () => resolve(true));
			setTimeout(() => resolve(false), 2000).unref();
		});
		setup.mockInput.pressKey("q");
		expect(await destroyed).toBe(true);
	});

	test("the list pane window slides when the tickets overflow the pane", async () => {
		const setup = await bootApp(WIDTH, 6);
		try {
			// The pane shows two rows at this height: the first two tickets only.
			let frame = squashFrame(setup);
			expect(frame).toContain(SAMPLE_TICKETS[0].title);
			expect(frame).toContain(SAMPLE_TICKETS[1].title);
			expect(frame).not.toContain(SAMPLE_TICKETS[2].title);
			expect(frame).not.toContain(SAMPLE_TICKETS[3].title);

			// Moving the selection to the last ticket slides the window.
			await press(setup, "j");
			await press(setup, "j");
			await press(setup, "j");
			frame = squashFrame(setup);
			expect(frame).toContain(SAMPLE_TICKETS[3].title);
			expect(frame).toContain(SAMPLE_TICKETS[2].title);
			expect(frame).not.toContain(SAMPLE_TICKETS[0].title);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("the layout adapts to the terminal size", async () => {
		for (const [width, height] of [
			[80, 24],
			[160, 40],
		]) {
			const setup = await bootApp(width, height);
			try {
				const rows = rowsOf(setup);
				expect(rows).toHaveLength(height);
				for (const row of rows) {
					expect(row.length).toBe(width);
				}
				// Both panes and the sample data survive the resize.
				const frame = squashFrame(setup);
				expect(frame).toContain("Tickets");
				expect(frame).toContain("Detail");
				for (const badge of ["[open]", "[handed-off]", "[running]", "[done]"]) {
					expect(frame).toContain(badge);
				}
			} finally {
				setup.renderer.destroy();
			}
		}
	});
});
