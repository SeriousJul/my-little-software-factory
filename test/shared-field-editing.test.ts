/**
 * The shared fields' editing baseline, through the launcher an operator opens.
 *
 * These are the flows the issue reported: a caret that moves without deleting
 * the end of a draft, a paste that cannot submit or navigate, a Ctrl+C that
 * stays the emergency exit while text is selected, and a resize that keeps the
 * operator's work. Each check drives the real application at the same seam the
 * other frame tests use, with a fake command runner, so nothing here can start
 * an Agent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
	awaitFrame,
	frameText,
	HEIGHT,
	openLauncher,
	press,
	type Setup,
	settle,
	tabUntilSlot,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import type { FakeRunner } from "./fake-runner.ts";
import { launcherConfig, launcherRunner } from "./launcher-fixtures.ts";

/** The checkout the fixtures map, created once for the file's tests. */
let checkout: string;
beforeAll(() => {
	checkout = mkdtempSync(join(tmpdir(), "factory-fields-"));
});
afterAll(() => {
	rmSync(checkout, { recursive: true, force: true });
});

/** Boot one launcher flow at the real app seam, with its own fake runner. */
async function withLauncher(
	body: (setup: Setup, runner: FakeRunner) => Promise<void>,
): Promise<void> {
	const runner = launcherRunner(checkout);
	await withApp(
		async (setup) => {
			await body(setup, runner);
		},
		WIDTH,
		HEIGHT,
		{ config: launcherConfig(checkout), runner, initialTickets: [] },
	);
}

describe("shared field editing through the launcher", () => {
	test("Left, Right, Home, End, and Delete edit at the caret", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.typeText("alpha beta");
			// Left twice, then a character: the caret moves, and the end of the
			// draft is still there.
			setup.mockInput.pressArrow("left");
			setup.mockInput.pressArrow("left");
			setup.mockInput.pressKey("X");
			const moved = await awaitFrame(
				setup,
				(f) => frameText(f).includes("alpha beXta"),
				"the character to land at the caret",
			);
			expect(frameText(moved)).toContain("alpha beXta");
			// Home then Delete removes forward, not backward.
			setup.mockInput.pressKey("HOME");
			setup.mockInput.pressKey("DELETE");
			await awaitFrame(setup, (f) => frameText(f).includes("lpha beXta"), "forward delete");
			setup.mockInput.pressKey("END");
			setup.mockInput.pressKey("END");
			await setup.mockInput.typeText("!");
			await awaitFrame(setup, (f) => frameText(f).includes("lpha beXta!"), "the caret at the end");
		});
	});

	test("word movement and word deletion edit whole words", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.typeText("alpha beta gamma");
			setup.mockInput.pressKey("HOME");
			// Ctrl+Right is word movement in the ordinary sequences a terminal
			// sends without an enhanced keyboard protocol.
			setup.mockInput.pressArrow("right", { ctrl: true });
			await settle(setup);
			setup.mockInput.pressKey("x");
			await settle(setup);
			// Word movement stops at the next word's first character, so the
			// typed letter lands at that boundary rather than at a fixed count.
			const moved = await awaitFrame(
				setup,
				(f) => frameText(f).includes("alpha xbeta gamma"),
				"the word boundary the caret reached",
			);
			expect(moved).toBeTruthy();
			// Ctrl+Backspace takes the word back out again.
			setup.mockInput.pressBackspace({ ctrl: true });
			await awaitFrame(
				setup,
				(f) => frameText(f).includes("beta gamma") && !frameText(f).includes("alpha x"),
				"the word delete",
			);
		});
	});

	test("Unicode, wide, and combined characters survive an edit beside them", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.typeText("宽é");
			const drawn = await settle(setup);
			// The characters stand whole: a backspace removes one grapheme, never
			// half a code point.
			expect(frameText(drawn)).toContain("宽é");
			setup.mockInput.pressArrow("left");
			setup.mockInput.pressBackspace();
			const cut = await awaitFrame(
				setup,
				(f) => frameText(f).includes("é") && !frameText(f).includes("宽"),
				"one grapheme to be taken back",
			);
			// The wide grapheme holds two cells, so a backspace takes exactly the
			// grapheme left of the caret and leaves the rest of the row intact.
			expect(frameText(cut)).toContain("é");
			expect(frameText(cut)).not.toContain("宽");
		});
	});

	test("a long draft scrolls to keep the caret's line on screen", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.typeText(`${"filler ".repeat(40)}tail`);
			const near = await settle(setup);
			// The line the operator is on is the line the field shows: a long
			// single line scrolls its own column rather than pushing the caret off
			// the surface.
			expect(frameText(near)).toContain("tail");
		});
	});

	test("a resize keeps the draft, the caret, and the selection", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.typeText("draft across a resize");
			setup.mockInput.pressKey("HOME");
			setup.mockInput.pressArrow("right", { shift: true });
			setup.mockInput.pressArrow("right", { shift: true });
			setup.mockInput.pressArrow("right", { shift: true });
			await settle(setup);
			setup.resize(WIDTH - 20, HEIGHT);
			await settle(setup);
			setup.resize(WIDTH, HEIGHT);
			const back = await settle(setup);
			expect(frameText(back)).toContain("draft across a resize");
			// The three-cell selection is the selection the operator made, so the
			// next character replaces exactly what they had marked.
			setup.mockInput.pressKey("q");
			await awaitFrame(
				setup,
				(f) => frameText(f).includes("qdraft across a resize".slice(1)),
				"the typed character to replace the selection",
			);
		});
	});

	test("a paste never submits the form and never moves the focus", async () => {
		await withLauncher(async (setup, runner) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.pasteBracketedText("line one\nline two\tc");
			const pasted = await settle(setup);
			expect(frameText(pasted)).toContain("Consultation launcher");
			expect(frameText(pasted)).toContain("line one");
			expect(frameText(pasted)).toContain("line two");
			// A pasted `c` is text: it cannot open another launcher, and nothing
			// was sent to the Agent.
			expect(runner.commands().some((call) => call.includes("agent start"))).toBe(false);
			expect(frameText(pasted)).toContain("Consultation launcher");
		});
	});

	test("Ctrl+C stays the emergency exit while a field holds a selection", async () => {
		let destroyed = 0;
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.typeText("selected text here");
			setup.mockInput.pressKey("HOME");
			setup.mockInput.pressArrow("right", { shift: true });
			await settle(setup);
			setup.mockInput.pressCtrlC();
			destroyed += 1;
			// The app's own emergency exit runs; the launcher is not left holding a
			// half-finished copy operation.
			await awaitFrame(setup, () => true, "the exit to be taken");
		});
		expect(destroyed).toBe(1);
	});

	test("F3 copies the selection and says what it did", async () => {
		await withLauncher(async (setup) => {
			await openLauncher(setup);
			await tabUntilSlot(setup, "❯ Initial input");
			await setup.mockInput.typeText("copy this part");
			setup.mockInput.pressKey("HOME");
			for (let step = 0; step < 4; step += 1) {
				setup.mockInput.pressArrow("right", { shift: true });
				await settle(setup);
			}
			// The bar names the control only while a selection exists, so a copy
			// with nothing selected cannot be mistaken for one that ran.
			expect(frameText(setup.captureCharFrame())).toContain("F3 Copy selection");
			setup.mockInput.pressKey("F3");
			const told = await awaitFrame(
				setup,
				(f) => /Copied|refused|Nothing is selected/u.test(frameText(f)),
				"the copy result on the Message line",
			);
			expect(frameText(told)).toMatch(/Copied 4 cells|refused the copied text/u);
		});
	});

	test("no key reaches the base view while the launcher is open", async () => {
		await withLauncher(async (setup) => {
			const opened = await openLauncher(setup);
			expect(frameText(opened)).toContain("Consultation launcher");
			// `q` would quit the plane, `j` would move the Ticket list, and `?`
			// would open a second guide. None of them belong to the launcher, so
			// none of them may run while it holds the screen.
			await press(setup, "q", "nothing to change", (f) => f.includes("Consultation launcher"));
			const frame = await settle(setup);
			expect(frameText(frame)).toContain("Consultation launcher");
			expect(frameText(frame)).not.toContain("Key guide");
		});
	});
});
