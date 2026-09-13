/**
 * The shared control gallery, exercised through the same renderer the application
 * tests use.
 *
 * The gallery is not a picture of the controls: it renders the production
 * modules, and these tests drive the gallery's own examples. That is what keeps
 * a contributor's preview and the operator's screen from becoming two different
 * things, which is the failure the shared control standard names.
 */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, test } from "vitest";

import { GALLERY_EXAMPLES, Gallery, galleryColumns } from "../src/components/shared/gallery.ts";
import {
	contrastRatio,
	inkFor,
	MIN_INDICATOR_CONTRAST,
	MIN_TEXT_CONTRAST,
} from "../src/components/shared/presentation.ts";
import { awaitFrame, cellColors, frameText, settle } from "./app-harness.ts";

/** A `[r, g, b]` triplet as the `#rrggbb` the contrast formula reads. */
const hexOf = (channels: readonly number[]): string =>
	`#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

let renderer: { destroy: () => void | Promise<void> } | null = null;
afterEach(async () => {
	await renderer?.destroy();
	renderer = null;
});

/** Open the gallery on one example, at one terminal size. */
async function gallery(
	example: string,
	width = 80,
	height = 20,
	onEmergencyExit: () => void = () => undefined,
) {
	const setup = await testRender(createElement(Gallery, { example, onEmergencyExit }), {
		width,
		height,
	});
	await setup.flush();
	renderer = setup.renderer;
	return setup;
}

/** The state word every example must show, so a reviewer knows what they see. */
const stateLine = (example: string) => GALLERY_EXAMPLES.find((e) => e.id === example)?.state ?? "";

describe("the shared control gallery", () => {
	test("shows every state the standard names", async () => {
		const ids = GALLERY_EXAMPLES.map((example) => example.id);
		expect(ids).toEqual(["fields", "states", "search", "narrow"]);
		const states = GALLERY_EXAMPLES.map((example) => example.state).join(" ");
		for (const needed of [
			"normal",
			"focused",
			"invalid",
			"unavailable",
			"loading",
			"narrow",
			"Type-ahead",
		]) {
			expect(states).toContain(needed);
		}
	});

	test("each example renders its own controls, and Tab moves to the next", async () => {
		const setup = await gallery("fields");
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("fields"));
		expect(frame).toContain("Model openai/gpt-5.1");
		expect(frame).toContain("Context 272000");
		expect(frame).toContain("Initial input");
		setup.mockInput.pressTab();
		const next = await awaitFrame(
			setup,
			(f) => frameText(f).includes("invalid"),
			"the next example's state word",
		);
		expect(frameText(next)).toContain("Error: Context: 0 is not a positive whole number");
		expect(frameText(next)).toContain("(unavailable)");
		expect(frameText(next)).toContain("(loading...)");
		expect(frameText(next)).toContain(
			"Unavailable: Launch Consultation: initial input cannot be empty",
		);
	});

	test("the Type-ahead example shows its search and answers a query", async () => {
		const setup = await gallery("search");
		// The example opens on a value the Agent's list holds, with the search
		// under it empty, because that is the row an operator meets first.
		expect(frameText(setup.captureCharFrame())).toContain("Model openai/gpt-5.1 ");
		await setup.mockInput.typeText("codex");
		const matched = await awaitFrame(
			setup,
			(f) => frameText(f).includes("Model openai/gpt-5.1-codex"),
			"the search to name its match",
		);
		expect(frameText(matched)).toContain("Search codex");
		await setup.mockInput.typeText("q");
		const failed = await awaitFrame(
			setup,
			(f) => frameText(f).includes("no match"),
			"the no-match word",
		);
		// The failed query stays on screen: an operator can see what to correct.
		expect(frameText(failed)).toContain("codexq");
		expect(frameText(failed)).toContain("Model openai/gpt-5.1-codex");
	});

	test("the fields example takes a real edit, and refuses a non-digit paste whole", async () => {
		const setup = await gallery("fields");
		// The Context field is the focused one in this example, so a paste that
		// carries a letter reaches it and nowhere else.
		await setup.mockInput.pasteBracketedText("1e3");
		const refused = await awaitFrame(
			setup,
			(f) => frameText(f).includes("digits only"),
			"the paste refusal",
		);
		expect(frameText(refused)).toContain("Context 272000");
		await setup.mockInput.pressBackspace();
		const edited = await awaitFrame(
			setup,
			(f) => frameText(f).includes("Context 27200"),
			"the field to take an edit",
		);
		expect(frameText(edited)).toContain("Context 27200");
	});

	test("Copy selection works on the Type-ahead search, the other fields' way", async () => {
		const setup = await gallery("search");
		// The search is a Text field: a selection in it offers the same Copy
		// control a selection in any other shared field offers.
		await setup.mockInput.typeText("copy me");
		setup.mockInput.pressKey("HOME");
		for (let step = 0; step < 4; step += 1) {
			setup.mockInput.pressArrow("right", { shift: true });
			await settle(setup);
		}
		expect(frameText(setup.captureCharFrame())).toContain("F3 Copy selection");
		setup.mockInput.pressKey("F3");
		const told = await awaitFrame(
			setup,
			(f) => /Copied|refused|Nothing is selected/u.test(frameText(f)),
			"the copy result on the Message line",
		);
		expect(frameText(told)).toMatch(/Copied 4 cells|refused the copied text/u);
		// A plain arrow collapses the selection, and the control leaves the bar:
		// the bar never names a Copy that would find nothing to copy.
		setup.mockInput.pressArrow("right");
		const collapsed = await awaitFrame(
			setup,
			(f) => !frameText(f).includes("F3 Copy selection"),
			"the Copy control to leave the bar",
		);
		expect(frameText(collapsed)).not.toContain("F3 Copy selection");
	});

	test("F1 opens the Key guide the bar names, and closing returns the same field", async () => {
		const setup = await gallery("fields");
		// Leave an edit and a selection in the focused field first: closing the
		// guide must return exactly this field, not a fresh one.
		await setup.mockInput.typeText("5");
		await settle(setup);
		setup.mockInput.pressKey("F1");
		const guide = await awaitFrame(
			setup,
			(f) => frameText(f).includes("Key guide"),
			"the Key guide",
		);
		const guideText = frameText(guide);
		expect(guideText).toContain("Form field");
		// The guide lists the field's own editing keys, not only the bar's.
		expect(guideText).toContain("Move caret by line");
		expect(guideText).toContain("Copy selection");
		expect(guideText).toContain("Esc/F1/? Close");
		// F1 in the guide closes it: the close control outranks the Help that
		// would only reopen it.
		setup.mockInput.pressKey("F1");
		const back = await awaitFrame(
			setup,
			(f) => !frameText(f).includes("Key guide"),
			"the example under the guide",
		);
		const backText = frameText(back);
		expect(backText).toContain("Context 2720005");
		expect(backText).toContain(stateLine("fields"));
	});

	test("the light presentation carries its own pair on the overlay surface", async () => {
		const saved = process.env.FACTORY_PRESENTATION;
		process.env.FACTORY_PRESENTATION = "light";
		try {
			const setup = await gallery("fields");
			const ink = inkFor("light");
			// The surface behind the box is the light pair's own background:
			// an overlay that kept a dark box would unread its own ink.
			expect(hexOf(cellColors(setup, 1, 0).bg)).toBe(ink.surface.on);
			// Every text the surface paints clears the standard's contrast on
			// the background it actually landed on, not on one it was only
			// described against.
			const required = new Map<string, number>();
			const textRoles = [
				ink.text,
				ink.focusedText,
				ink.detail,
				ink.error,
				ink.warning,
				ink.selectionText,
				ink.surface,
			];
			const indicatorRoles = [ink.indicator, ink.selectionBackground, ink.focusedField];
			for (const role of [...textRoles, ...indicatorRoles]) {
				const fg = role.fg;
				if (fg === null) continue;
				const need = textRoles.includes(role) ? MIN_TEXT_CONTRAST : MIN_INDICATOR_CONTRAST;
				required.set(fg, Math.max(required.get(fg) ?? 0, need));
			}
			let measured = 0;
			const lines = setup.captureSpans().lines;
			for (let y = 0; y < lines.length; y += 1) {
				for (const span of lines[y].spans) {
					if (span.text.trim() === "") continue;
					const fg = hexOf(span.fg.toInts().slice(0, 3));
					const need = required.get(fg);
					if (need === undefined) continue;
					const bg = hexOf(span.bg.toInts().slice(0, 3));
					expect(contrastRatio(fg, bg), `${fg} on ${bg} at row ${y}`).toBeGreaterThanOrEqual(need);
					measured += 1;
				}
			}
			expect(measured).toBeGreaterThan(0);
		} finally {
			if (saved === undefined) delete process.env.FACTORY_PRESENTATION;
			else process.env.FACTORY_PRESENTATION = saved;
		}
	});

	test("Esc leaves the gallery, the way its bar says", async () => {
		let closed = 0;
		const setup = await gallery("fields", 80, 20, () => {
			closed += 1;
		});
		setup.mockInput.pressEscape();
		await settle(setup);
		expect(closed).toBe(1);
	});

	test("the narrow example holds its columns without painting through them", async () => {
		const setup = await gallery("narrow", 28, 16);
		const frame = setup.captureCharFrame();
		const columns = galleryColumns(22);
		expect(columns.valueWidth).toBeGreaterThan(0);
		// Every drawn row stays inside the box: a control that overflowed its
		// column would push a border off the row it belongs to.
		for (const row of frame.split("\n")) {
			if (row.includes("│") && !row.startsWith("┌") && !row.startsWith("└")) {
				expect(row.length).toBeLessThanOrEqual(28);
			}
		}
		expect(frameText(frame)).toContain("Model");
	});
});
