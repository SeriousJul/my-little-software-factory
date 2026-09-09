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
import { awaitFrame, frameText } from "./app-harness.ts";

let renderer: { destroy: () => void | Promise<void> } | null = null;
afterEach(async () => {
	await renderer?.destroy();
	renderer = null;
});

/** Open the gallery on one example, at one terminal size. */
async function gallery(example: string, width = 80, height = 20) {
	const setup = await testRender(
		createElement(Gallery, { example, onEmergencyExit: () => undefined }),
		{ width, height },
	);
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
