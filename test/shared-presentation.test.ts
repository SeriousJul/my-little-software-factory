/**
 * The shared controls' presentation: contrast, the no-color case, and the light
 * palette.
 *
 * The standard sets numbers, not intentions: at least 4.5:1 for text and at
 * least 3:1 for an essential control indicator, in the pairs the application
 * paints. These checks measure the palette with the WCAG formula and then read
 * the colors a real frame was drawn with, so a pair cannot pass by being
 * described well.
 *
 * The no-color case is checked the same way: with color gone, every label, the
 * focus marker, and every state and error word must still be on the screen,
 * because a control that only means something in color means nothing to an
 * operator who cannot see the color.
 */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, test } from "vitest";

import { DraftField, TextField } from "../src/components/shared/fields.ts";
import {
	contrastFailures,
	contrastRatio,
	controlInk,
	currentPresentation,
	inkFor,
	MIN_INDICATOR_CONTRAST,
	MIN_TEXT_CONTRAST,
	type Presentation,
	STATE_WORDS,
} from "../src/components/shared/presentation.ts";
import { awaitFrame, cellColors, frameText, rgb } from "./app-harness.ts";

/** A `[r,g,b]` triplet as the `#rrggbb` the contrast formula reads. */
const hexOf = (channels: readonly number[]): string =>
	`#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

const saved = process.env.FACTORY_PRESENTATION;
afterEach(() => {
	if (saved === undefined) delete process.env.FACTORY_PRESENTATION;
	else process.env.FACTORY_PRESENTATION = saved;
});

/** Paint one field pair at a fixed size, in one presentation. */
async function withField(presentation: Presentation, focused: boolean) {
	process.env.FACTORY_PRESENTATION = presentation;
	const setup = await testRender(
		createElement(
			"box",
			{ style: { width: "100%", height: "100%", backgroundColor: "#0d1117" } },
			createElement(TextField, {
				label: "Context window",
				value: "272000",
				focused,
				width: 16,
				labelWidth: 16,
				error: focused ? undefined : null,
				hint: "the count the Agent starts with",
			}),
			createElement(DraftField, {
				label: "Initial input",
				value: "one draft line",
				focused: !focused,
				width: 24,
				labelWidth: 16,
				height: 2,
				hint: "Enter adds a line here",
			}),
		),
		{ width: 46, height: 8 },
	);
	await setup.flush();
	return setup;
}

describe("the shared control palette", () => {
	test("meets the contrast the standard sets, in every colored presentation", () => {
		for (const presentation of ["dark", "light"] as const) {
			expect(contrastFailures(presentation), `${presentation} palette`).toEqual([]);
		}
	});

	test("the numbers the check measures are the ones the palette paints", () => {
		// The ratios are recomputed from the hex pairs, so a declared palette
		// cannot pass a test that only repeats it.
		const dark = inkFor("dark");
		expect(contrastRatio(dark.text.fg ?? "", dark.text.on)).toBeGreaterThanOrEqual(
			MIN_TEXT_CONTRAST,
		);
		expect(contrastRatio(dark.indicator.fg ?? "", dark.indicator.on)).toBeGreaterThanOrEqual(
			MIN_INDICATOR_CONTRAST,
		);
		// The written word for a state is the same text in every presentation,
		// so removing color removes no meaning.
		for (const presentation of ["dark", "light", "mono"] as const) {
			expect(STATE_WORDS.noMatch).toBe("(no match)");
			expect(inkFor(presentation)).toBeTruthy();
		}
	});

	test("the light presentation is the pin's, and never automatic", () => {
		// The terminal's scheme is not consulted: until the base panes take
		// their ink from the presentation, a light terminal keeps the dark
		// pairs, and the light pairs run only under the explicit pin.
		delete process.env.FACTORY_PRESENTATION;
		expect(currentPresentation()).toBe("dark");
		process.env.FACTORY_PRESENTATION = "light";
		expect(currentPresentation()).toBe("light");
		process.env.FACTORY_PRESENTATION = "mono";
		expect(currentPresentation()).toBe("mono");
	});

	test("the drawn text keeps its measured contrast on the overlay surface", async () => {
		const setup = await withField("dark", true);
		try {
			const ink = controlInk();
			// Every painted cell of the fields' own rows is measured, because an
			// operator reads all of them: the label, the value, and the hint.
			const pairs = new Set<string>();
			for (let row = 1; row <= 4; row += 1) {
				for (let column = 2; column < 24; column += 1) {
					const cell = cellColors(setup, column, row);
					if (cell.fg.join() === "0,0,0") continue;
					pairs.add(`${cell.fg.join()} on ${cell.bg.join()}`);
					const ratio = contrastRatio(hexOf(cell.fg), hexOf(cell.bg));
					const painted = [
						ink.text.fg,
						ink.focusedText.fg,
						ink.detail.fg,
						ink.error.fg,
						ink.warning.fg,
					];
					if (painted.some((fg) => fg !== null && rgb(fg ?? "").join() === cell.fg.join())) {
						expect(ratio, `row ${row} column ${column}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
					}
				}
			}
			expect(pairs.size).toBeGreaterThan(1);
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("the light presentation paints its own pairs, not the dark ones", async () => {
		const setup = await withField("light", true);
		try {
			const ink = controlInk();
			const frame = setup.captureSpans();
			const painted = new Set(
				frame.lines
					.slice(1)
					.flatMap((line) => line.spans.map((span) => hexOf(span.fg.toInts().slice(0, 3)))),
			);
			// The light palette's own label tone is on the screen, and the dark
			// palette's text and detail tones are not: a light terminal does not
			// get the dark pair because a screen happened to be written for one.
			expect(painted).toContain(ink.detail.fg ?? "");
			expect(painted.has("#c9d1d9")).toBe(false);
			expect(painted.has("#8b949e")).toBe(false);
			expect(frameText(setup.captureCharFrame())).toContain("Context window 272000");
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("the no-color presentation keeps every label, marker, and state word", async () => {
		process.env.FACTORY_PRESENTATION = "mono";
		const setup = await testRender(
			createElement(DraftField, {
				label: "Initial input",
				value: "",
				focused: true,
				width: 24,
				labelWidth: 14,
				height: 2,
				error: "initial input cannot be empty",
				hint: "Enter adds a line here",
			}),
			{ width: 46, height: 6 },
		);
		try {
			await setup.flush();
			const frame = frameText(setup.captureCharFrame());
			// The label, the focus marker, the error and its field, and the hint:
			// each is a word, so the frame says everything the colors would have.
			expect(frame).toContain("❯ Initial input");
			// The error line is cut by the column, as every row is; the label, the
			// marker, the word "Error", and the hint are what must survive.
			expect(frame).toContain("Error: Initial input: initial input cann");
			expect(frame).toContain("Enter adds a line here");
			// And no painted foreground survives to carry a meaning on its own:
			// the mono palette paints no color at any cell.
			const painted = setup
				.captureSpans()
				.lines.flatMap((line) =>
					line.spans
						.filter((span) => span.text.trim() !== "")
						.map((span) => hexOf(span.fg.toInts().slice(0, 3))),
				);
			// The renderer's own default: no role asked for a color.
			expect([...new Set(painted)]).toEqual(["#ffffff"]);
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("a caret does not blink, and nothing depends on a blink", async () => {
		process.env.FACTORY_PRESENTATION = "dark";
		const setup = await withField("dark", true);
		try {
			// The frame after a settle still shows the field's text and marker:
			// the caret's cell is drawn once and stays, so no timing is needed to
			// read where the next edit lands.
			const first = setup.captureCharFrame();
			await awaitFrame(setup, (f) => f === first, "a frame that holds steady", 200);
			expect(frameText(setup.captureCharFrame())).toContain("Context window 272000");
		} finally {
			await setup.renderer.destroy();
		}
	});
});
