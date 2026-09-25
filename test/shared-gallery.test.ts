/**
 * The shared control gallery, exercised through the same renderer the application
 * tests use.
 *
 * The gallery is not a picture of the controls: it renders the production
 * modules, and these tests drive the gallery's own examples. That is what keeps
 * a contributor's preview and the operator's screen from becoming two different
 * things, which is the failure the shared control standard names.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import { GALLERY_EXAMPLES, Gallery, galleryColumns } from "../src/components/shared/gallery.ts";
import { controlInk } from "../src/components/shared/presentation.ts";
import { SPINNER_FRAMES } from "../src/components/shared/spinner.ts";
import {
	BUILTIN_THEMES,
	HERDR_THEME_VERSION,
	STANDALONE_THEME,
} from "../src/components/shared/theme.ts";
import {
	awaitFrame,
	cellColors,
	frameText,
	rowSpans,
	rowsOf,
	type Setup,
	settle,
	spanColors,
} from "./app-harness.ts";

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

/** The cell where `text` first starts in the frame, by span, not by guess. */
function findCell(setup: Setup, text: string): { x: number; y: number } {
	const lines = setup.captureSpans().lines;
	for (let y = 0; y < lines.length; y += 1) {
		const spans = lines[y].spans;
		const rowText = spans.map((span) => span.text).join("");
		const at = rowText.indexOf(text);
		if (at === -1) continue;
		let x = 0;
		for (const span of spans) {
			if (at < x + span.width) return { x: at, y };
			x += span.width;
		}
	}
	throw new Error(`no frame row holds ${text}`);
}

describe("the shared control gallery", () => {
	test("shows every state the standard names", async () => {
		const ids = GALLERY_EXAMPLES.map((example) => example.id);
		expect(ids).toEqual([
			"fields",
			"states",
			"search",
			"notes",
			"spinner",
			"queue-order",
			"ticket-ignore",
			"ticket-filter",
			"session-view",
			"agent-view-fallback",
			"captured-history-fallback",
			"decision-region-capped",
			"decision-region-pinned",
			"decision-log-empty",
			"close-dialog-opening",
			"close-dialog-working",
			"close-dialog-awaiting-response",
			"close-panel-closing",
			"ticket-close",
			"ticket-close-live-worktree",
			"recovery-panel-opening",
			"recovery-panel-missing",
			"recovery-panel-failed",
			"goto",
			"ticket-goto",
			"consultation-detail-unscheduled",
			"consultation-unscheduled-actions",
			"consultation-detail-queued",
			"ticket-groups",
			"work-queue",
			"work-force-dispatch",
			"work-queue-item-consultation",
			"work-queue-item-consultation-gone",
			"theme",
			"theme-fallback",
			"theme-light",
			"theme-override",
			"no-color",
			"narrow",
		]);
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

	// Issue #159: the grouped Ticket list is a test surface, so the states a
	// reviewer must see - a grouped list, a collapsed Group with its held count,
	// and the cursor at rest on a Group header - are asserted here rather than
	// in a private sketch.
	test("the grouped Ticket list shows its Groups, its fold, and its header cursor", async () => {
		const setup = await gallery("ticket-groups", 120, 34);
		const text = frameText(setup.captureCharFrame());
		// A Group header stands above each run, and it carries the count of the
		// rows it holds and the held count above zero.
		expect(text).toContain("▾ acme/billing 2 held 1");
		expect(text).toContain("▾ acme/factory 2");
		// A collapsed Group shows nothing but its header, and the fold rides on
		// the glyph: the header still names what the fold hides.
		expect(text).toContain("▸ acme/billing 2 held 1");
		// The cursor rests on a Group header, and the marker column reads the
		// same at either kind of row.
		expect(text).toContain("❯ ▾ implement 3 held 1");
		// The axis names itself in the hint the bar carries, and the Message
		// lines are the words the press leaves on the line.
		expect(text).toContain("Ticket list grouped by repository");
		expect(text).toContain("Ticket list grouping off: the flat list");
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
		// The guide's keyboard handler wires up in the same render that draws
		// it. Let that render settle before the closing key, so the key lands
		// on the guide rather than the field beneath it: on a slow host the
		// gap between the drawn frame and the live handler is wide enough for
		// the key to fall through.
		await setup.flush();
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

	test("the theme example states the theme in force and swatches its roles", async () => {
		const setup = await gallery("theme");
		const raw = setup.captureCharFrame();
		expect(frameText(raw)).toContain("theme: standalone (dark)");
		expect(frameText(raw)).toContain(
			`built-in definitions vendored from herdr ${HERDR_THEME_VERSION}`,
		);
		// The swatch under a role's name is the theme's own color for that
		// role, so the operator sees the theme the plane will paint in.
		const swatchRow = rowsOf(raw).findIndex((row) => row.includes(" subtext0 "));
		expect(swatchRow).toBeGreaterThanOrEqual(0);
		const swatch = rowSpans(setup, swatchRow).find((span) => span.text.includes("subtext0"));
		if (swatch === undefined) throw new Error("the swatch row lost its subtext0 swatch");
		if (swatch.bg === null) throw new Error("the subtext0 swatch painted no background");
		expect(hexOf(swatch.bg)).toBe(STANDALONE_THEME.roles.subtext0);
	});

	test("the theme-fallback example shows the warning the Message line carries", async () => {
		const setup = await gallery("theme-fallback");
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain("Warning:");
		// The line is cut by the box, as every row is: the named theme and the
		// fallback are what must survive.
		expect(frame).toContain(`unknown theme name "frobnicate"`);
	});

	test("the light theme example paints the same controls in a light theme's ink", async () => {
		const setup = await gallery("theme-light");
		const raw = setup.captureCharFrame();
		const frame = frameText(raw);
		expect(frame).toContain("theme: catppuccin-latte (light)");
		expect(frame).toContain("Model");
		expect(frame).toContain("openai/gpt-5.1");
		// The focused field wears the light theme's own pair: its text on its
		// active-row surface, so a light name in herdr's config reads light.
		const value = findCell(setup, "openai/gpt-5.1");
		const cell = cellColors(setup, value.x, value.y);
		expect(cell.fg).toEqual([0x4c, 0x4f, 0x69]);
		expect(cell.bg).toEqual([0xe6, 0xe9, 0xef]);
		// The accent swatch wears the light theme's accent.
		const swatchRow = rowsOf(raw).findIndex((row) => row.includes(" subtext0 "));
		expect(swatchRow).toBeGreaterThanOrEqual(0);
		const swatch = rowSpans(setup, swatchRow).find((span) => span.text.trim() === "accent");
		if (swatch === undefined || swatch.bg === null) {
			throw new Error("the light example lost its accent swatch");
		}
		expect(hexOf(swatch.bg)).toBe("#1e66f5");
		// The heading row wears the example's own pair, not the environment's
		// ink: the light theme's text on its own panel surface.
		const heading = findCell(setup, "theme: catppuccin-latte (light)");
		const headingCell = cellColors(setup, heading.x, heading.y);
		expect(headingCell.fg).toEqual([0x4c, 0x4f, 0x69]);
		expect(headingCell.bg).toEqual([0xef, 0xf1, 0xf5]);
	});

	test("the override example wears the token values the [theme.custom] section holds", async () => {
		const setup = await gallery("theme-override");
		const raw = setup.captureCharFrame();
		const frame = frameText(raw);
		expect(frame).toContain('names "catppuccin"');
		// The heading wears the override's own pair: the overridden text role
		// stands as its ink, and the panel surface resolved to `reset`, so the
		// base theme's value never shows there either.
		const headingRow = rowsOf(raw).findIndex((row) => row.includes('names "catppuccin"'));
		expect(headingRow).toBeGreaterThanOrEqual(0);
		const heading = rowSpans(setup, headingRow).find((span) => span.text.includes("catppuccin"));
		if (heading === undefined || heading.fg === null) {
			throw new Error("the override example lost its heading");
		}
		expect(hexOf(heading.fg)).toBe("#ffffff");
		if (heading.bg !== null)
			expect(hexOf(heading.bg)).not.toBe(BUILTIN_THEMES.catppuccin.roles.panel_bg);
		// The swatch row holds every role name at once; the config line above
		// it names only the overridden tokens.
		const swatchRow = rowsOf(raw).findIndex((row) => row.includes(" subtext0 "));
		expect(swatchRow).toBeGreaterThanOrEqual(0);
		const swatches = rowSpans(setup, swatchRow);
		// The overridden tokens wear the override's own values...
		const accent = swatches.find((span) => span.text.trim() === "accent");
		if (accent === undefined || accent.bg === null) {
			throw new Error("the override example lost its accent swatch");
		}
		expect(hexOf(accent.bg)).toBe("#ffb86c");
		const text = swatches.find((span) => span.text.trim() === "text");
		if (text === undefined || text.bg === null) {
			throw new Error("the override example lost its text swatch");
		}
		expect(hexOf(text.bg)).toBe("#ffffff");
		// ...a token the override drops keeps the base theme, and a token
		// that resolves to `reset` paints no swatch at all.
		const subtext = swatches.find((span) => span.text.trim() === "subtext0");
		if (subtext === undefined || subtext.bg === null) {
			throw new Error("the override example lost its subtext0 swatch");
		}
		expect(hexOf(subtext.bg)).toBe("#a6adc8");
		// A token that resolves to `reset` paints no swatch of its own: the
		// surface behind it stands, and the base theme's value never shows.
		const panel = swatches.find((span) => span.text.trim() === "panel_bg");
		if (panel === undefined) throw new Error("the override example lost its panel_bg swatch");
		if (panel.bg !== null)
			expect(hexOf(panel.bg)).not.toBe(BUILTIN_THEMES.catppuccin.roles.panel_bg);
	});

	test("the no-color example paints the same controls with no color", async () => {
		const setup = await gallery("no-color");
		const frame = frameText(setup.captureCharFrame());
		// The same controls a colored panel holds: a field, a selection row,
		// and an action - with their labels and values.
		expect(frame).toContain("Model");
		expect(frame).toContain("openai/gpt-5.1");
		expect(frame).toContain("❯ Repository");
		expect(frame).toContain("Launch Consultation");
		// The spinner face wears the no-color ink too: its written word keeps
		// standing, and no color of its own shows on the row.
		expect(frame).toContain("starting");
		expect(spanColors(setup, "starting")).toEqual([[255, 255, 255]]);
		// And none of them paints a foreground: the writing alone stands. The
		// renderer's own default is not a paint.
		expect(spanColors(setup, "openai/gpt-5.1")).toEqual([[255, 255, 255]]);
		expect(spanColors(setup, "Launch Consultation")).toEqual([[255, 255, 255]]);
	});

	/**
	 * The Ticket ignore example (ADR 0060): the bar's flip, the header's cell for
	 * the pile, and the three obligations the key refuses.
	 *
	 * Every refusal's words come from the catalogue through the gallery, so a
	 * change to the refusal's sentence fails here rather than drifting between a
	 * literal picture and the live frame. The example opens tall: three bars and
	 * three Message rows stand in it beside the header and the note.
	 */
	test("the Ticket ignore example holds the flip and the three refusals", async () => {
		const setup = await gallery("ticket-ignore", 120, 30);
		const charFrame = setup.captureCharFrame();
		const text = frameText(charFrame);
		const lines = rowsOf(charFrame);
		expect(text).toContain(stateLine("ticket-ignore"));
		// The bar's flip, in the words the two rows read: the key beside an
		// active row puts the Ticket away, the key beside a piled row takes it
		// back, and both Ticket panes name it.
		expect(text).toContain("i Ignore");
		expect(text).toContain("i Un-ignore");
		// The header's conditional cell for the pile the filter hides.
		expect(text).toContain("ignored: 1");
		// Each obligation states its own clause once, on one Message row, and on
		// the bar that refuses it: no duplicated picture, and the refused key
		// still stands dimmed on its row's bar rather than vanishing from it.
		for (const clause of [
			"it awaits a decision",
			"its held turn awaits a decision",
			"its Agent is missing",
		]) {
			const stated = lines.filter((line) => line.includes(clause));
			expect(stated).toHaveLength(1);
			expect(stated[0]).toContain(`the selected Ticket cannot be ignored: ${clause}`);
		}
		// The active row's own bar names the key, and each of the three refused
		// rows names it on its bar.
		expect(lines.filter((line) => line.includes("i Ignore")).length).toBe(4);
	});

	test("the List filter example holds the cycle's three hints and the queue refusal", async () => {
		const setup = await gallery("ticket-filter", 150, 24);
		const text = frameText(setup.captureCharFrame());
		expect(text).toContain(stateLine("ticket-filter"));
		// The hint names the view the cycle moves to, in all three states. The
		// example opens wide: the filter is the section's lowest rung, so a narrow
		// bar packs it away before it touches the Launch or the Close.
		expect(text).toContain("f Show ignored");
		expect(text).toContain("f Show all");
		expect(text).toContain("f Show active");
		// The Work queue owns neither meaning of the key, and says so.
		expect(text).toContain(
			"this control is available only in the Ticket section and the Consultation section",
		);
	});

	test("the Consultation detail example shows the Session view and its fallbacks", async () => {
		const setup = await gallery("session-view");
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("session-view"));
		expect(frame).toContain("Session view:");
		expect(frame).toContain("❯ review the auth design");
		expect(frame).toContain("▸ bash: npm test");

		setup.mockInput.pressTab();
		const fallback = await awaitFrame(
			setup,
			(f) => frameText(f).includes("Agent view:") && frameText(f).includes("src/auth.ts"),
			"the Agent view fallback",
		);
		expect(frameText(fallback)).toContain("Agent: reading src/auth.ts");
		expect(frameText(fallback)).not.toContain("Session view:");
		setup.mockInput.pressTab();
		const captured = await awaitFrame(
			setup,
			(f) => frameText(f).includes("Captured history:"),
			"the Captured history fallback",
		);
		expect(frameText(captured)).toContain("review the auth design");
	});

	test("the decision modal's regions hold the pane, the cap, and the empty log", async () => {
		// The examples own the same frame as the dialog examples: a box that
		// must hold the pane's chrome, the held cause, and the region's rows.
		const setup = await gallery("decision-region-capped", 80, 20);
		let frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("decision-region-capped"));
		// The Turn log pane keeps its border and its title, and the held cause
		// stands above the rows it qualifies.
		expect(frame).toContain("Turn log");
		expect(frame).toContain("Turn ended failed: the run stopped before it finished its tests");
		// The region is capped to four of its twelve rows: the window shows
		// Close, Goto, and the first two handoffs, and hides the rest.
		expect(frame).toContain("Close");
		expect(frame).toContain("Goto");
		expect(frame).toContain("Handoff: task-01");
		expect(frame).toContain("Handoff: task-02");
		expect(frame).not.toContain("task-03");
		// The selection stands on the window's last row.
		const rows = rowsOf(setup.captureCharFrame());
		expect(rows.some((row) => row.includes("❯ Handoff: task-02"))).toBe(true);

		setup.mockInput.pressTab();
		frame = frameText(
			await awaitFrame(
				setup,
				(f) => frameText(f).includes(stateLine("decision-region-pinned")),
				"the pinned example",
			),
		);
		// The short log fills none of the pane's window, and the region shows
		// every row it holds, uncapped.
		expect(frame).toContain("Turn log");
		expect(frame).toContain("The fix keeps the repository visible.");
		expect(frame).toContain("Handoff: task-04");
		expect(frame).not.toContain("task-05");
		expect(frame).toContain("❯ Close");

		setup.mockInput.pressTab();
		frame = frameText(
			await awaitFrame(
				setup,
				(f) => frameText(f).includes(stateLine("decision-log-empty")),
				"the empty log example",
			),
		);
		// The empty log states its reason inside the pane, and the pane keeps
		// its chrome.
		expect(frame).toContain("Turn log");
		expect(frame).toContain("No turn log is recorded for this turn");
		expect(frame).toContain("❯ Close");
	});

	test("the close dialog examples hold every state a live Agent can be in", async () => {
		// The dialog examples own a taller frame than the shared one, so the
		// example opens at the plane's minimum height, where the dialog box
		// must still hold its title, body, and every action row.
		const setup = await gallery("close-dialog-opening", 80, 19);
		let frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("close-dialog-opening"));
		expect(frame).toContain("Close Consultation c1c1c1c1?");
		expect(frame).toContain("The Agent is still opening");
		expect(frame).toContain("Close stops the Agent. The worktree and branch stay.");
		expect(frame).toContain("stop the Agent; the work stays");
		expect(frame).toContain("Cancel");

		setup.mockInput.pressTab();
		const working = await awaitFrame(
			setup,
			(f) => frameText(f).includes(stateLine("close-dialog-working")),
			"the working state",
		);
		frame = frameText(working);
		expect(frame).toContain("The Agent is working");
		expect(frame).toContain("Close stops the Agent. The worktree and branch stay.");

		setup.mockInput.pressTab();
		const awaiting = await awaitFrame(
			setup,
			(f) => frameText(f).includes(stateLine("close-dialog-awaiting-response")),
			"the awaiting-response state",
		);
		frame = frameText(awaiting);
		expect(frame).toContain("The Agent has answered and is waiting for your reply");
		expect(frame).toContain("Close stops the Agent. The worktree and branch stay.");

		setup.mockInput.pressTab();
		const closing = await awaitFrame(
			setup,
			(f) => frameText(f).includes(stateLine("close-panel-closing")),
			"the closing recovery panel",
		);
		frame = frameText(closing);
		expect(frame).toContain("Close Consultation c1c1c1c1");
		expect(frame).toContain("Cleanup is already in progress");
		expect(frame).toContain("Retry");
		expect(frame).toContain("Force-close");
		expect(frame).not.toContain("The Agent is working");
	});

	test("the recovery panel examples hold every state that needs recovery", async () => {
		// The same production panel the Consultation's Enter opens, drawn at
		// the plane's minimum height where the box must hold its rows.
		const setup = await gallery("recovery-panel-opening", 80, 19);
		let frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("recovery-panel-opening"));
		expect(frame).toContain("Recover Consultation c1c1c1c1");
		expect(frame).toContain("The Agent never finished opening.");
		expect(frame).toContain("Recover");
		expect(frame).toContain("retry the interrupted opening");
		expect(frame).toContain("Close");
		// An interrupted opening still holds an Agent, so its close confirms.
		expect(frame).toContain("stop the Agent; the close confirms");
		expect(frame).not.toContain("Replace");

		setup.mockInput.pressTab();
		const missing = await awaitFrame(
			setup,
			(f) => frameText(f).includes(stateLine("recovery-panel-missing")),
			"the missing recovery panel",
		);
		frame = frameText(missing);
		expect(frame).toContain("The Agent is gone from its pane.");
		expect(frame).toContain("the Agent pane is gone");
		expect(frame).toContain("Replace");
		expect(frame).toContain("launch a linked Consultation here");
		expect(frame).toContain("close the record; nothing to stop");

		setup.mockInput.pressTab();
		const failed = await awaitFrame(
			setup,
			(f) => frameText(f).includes(stateLine("recovery-panel-failed")),
			"the failed recovery panel",
		);
		frame = frameText(failed);
		expect(frame).toContain("The launch failed before the Agent ran.");
		expect(frame).toContain("herdr refused the launch");
		expect(frame).toContain("Replace");
		expect(frame).toContain("Close");
	});

	test("the spinner example wears the animated face beside its written word", async () => {
		const setup = await gallery("spinner");
		const raw = setup.captureCharFrame();
		const frame = frameText(raw);
		expect(frame).toContain(stateLine("spinner"));
		// The face the ticket's Starting window wears: its written word, beside
		// a glyph of its own frames. The mount paints the face on one frame of
		// its own, so the check takes the glyph from the frame, not from a guess
		// at where the tick has landed.
		const row = rowsOf(raw).find((line) => line.includes("starting"));
		if (row === undefined) throw new Error("the spinner face never painted");
		const glyph = SPINNER_FRAMES.find((candidate) => row.includes(`${candidate} starting`));
		if (glyph === undefined) throw new Error(`the face wears no frame of its own:\n${row}`);
		// The face paints from the Theme in force in the tone a state word wears,
		// and the note beside it names the frames the face steps through.
		expect(spanColors(setup, "starting")).toEqual([
			[
				Number.parseInt(STANDALONE_THEME.roles.subtext0.slice(1, 3), 16),
				Number.parseInt(STANDALONE_THEME.roles.subtext0.slice(3, 5), 16),
				Number.parseInt(STANDALONE_THEME.roles.subtext0.slice(5, 7), 16),
			],
		]);
		expect(frame).toContain(SPINNER_FRAMES.join(" "));
	});

	test("the Goto example shows the hint available and unavailable, with its reason", async () => {
		const setup = await gallery("goto");
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("goto"));
		expect(frame).toContain("g Goto");
	});

	test("the Force-dispatch example holds the bar's states and the failure line", async () => {
		// The queue's bar carries more hints than a narrow frame pays for, so
		// the example opens at a width that keeps the Enter hint on the row.
		const setup = await gallery("work-force-dispatch", 120, 24);
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("work-force-dispatch"));
		// The available bar states the hint the Work section's bar states: Enter
		// on a queue row force-dispatches the item under the cursor.
		expect(frame).toContain("Enter Force-dispatch");
		// The two refusals the catalogue carries, on the bars that refuse them.
		expect(frame).toContain("a Handoff is active");
		expect(frame).toContain("no queue item is under the cursor");
		// The failure path: the warning a failed force-dispatch leaves on the
		// Message line, the item leaving the queue behind it.
		expect(frame).toContain("Warning:");
		expect(frame).toContain(`force-dispatch of "Add a webhook retry policy" failed`);
		// The Consultation item's line (issue #90): the item's own force-
		// dispatch names the cap it ran over, standing while a Handoff runs.
		expect(frame).toContain("force-dispatched Consultation c1c1c1c1 over the Parallel limit");
	});

	test("the Ticket Goto example holds the available and refused states", async () => {
		const setup = await gallery("ticket-goto");
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("ticket-goto"));
		// The available row states the hint on the in-flight Ticket's bar.
		expect(frame).toContain("g Goto");
	});
	// The Ticket Close confirmation (ADR 0031): the dialog states who is alive
	// and what the Close cleanup ends, and the two Environments read
	// differently, so the reviewer sees both from the gallery.
	test("the Ticket Close example shows the working Agent and the worktree removal", async () => {
		const setup = await gallery("ticket-close", 100, 30);
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("ticket-close"));
		expect(frame).toContain("Close: Fix the layout math");
		expect(frame).toContain("The Agent is working.");
		expect(frame).toContain(
			"Close removes the worktree checkout; a dirty checkout stays as a leftover.",
		);
		expect(frame).toContain(
			"The git branch stays, and the Ticket returns to open in its next cycle.",
		);
		expect(frame).toContain("No completion record is written: the turn never settled.");
		// The rows the operator answers with, and the panel's own bar. The row's
		// detail is cut at the panel's own width, the way every action row cuts.
		expect(frame).toContain("Close end the work cycle; the ticket returns");
		expect(frame).toContain("Cancel keep the Agent and its work running");
		expect(frame).toContain("Esc Cancel");
		// Nothing of the body scrolled away: the whole warning shows at once.
		expect(frame).not.toContain("more (j/k)");
	});

	test("the Ticket Close live-worktree example shows the settled turn and the tab", async () => {
		const setup = await gallery("ticket-close-live-worktree", 100, 30);
		const frame = frameText(setup.captureCharFrame());
		expect(frame).toContain(stateLine("ticket-close-live-worktree"));
		expect(frame).toContain("The turn has settled, and no Agent works.");
		expect(frame).toContain(
			"Close closes the Agent's herdr tab, and keeps the checkout and the workspace.",
		);
		// The worktree's removal note is not this Environment's fact.
		expect(frame).not.toContain("removes the worktree checkout");
		expect(frame).toContain("The closed decision lands on the settled turn.");
		expect(frame).toContain("Cancel keep the turn undecided");
		expect(frame).not.toContain("more (j/k)");
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

	test("the notes example writes a reason at the box width, and waits in the dim tone", async () => {
		// The box is wide enough for the whole sentence: the row is cut by the
		// box the surface names, not by the value column the value happens to
		// need, which is the state the override panel holds.
		const setup = await gallery("notes", 120, 20);
		const text = frameText(setup.captureCharFrame());
		expect(text).toContain(stateLine("notes"));
		expect(text).toContain(
			`Error: Model: agent "codex" (cli) has no model "openai/gpt-5.1-codex": check the model id and its provider auth`,
		);
		const ink = controlInk();
		// The warning row wears the warning tone on its own value.
		const value = findCell(setup, "openai/gpt-5.1-codex");
		expect(hexOf(cellColors(setup, value.x, value.y).fg)).toBe(ink.warning.fg ?? "");
		// The waiting row keeps its value in the tone of a setting it cannot
		// confirm yet, not in the tone of a value it stands on.
		const waiting = findCell(setup, "anthropic/claude-sonnet-4-5");
		expect(hexOf(cellColors(setup, waiting.x, waiting.y).fg)).toBe(ink.detail.fg ?? "");
	});

	test("the queue order example shows the pause header word, the queue keys, and the pause lines", async () => {
		const setup = await gallery("queue-order", 120, 24);
		const raw = setup.captureCharFrame();
		const text = frameText(raw);
		expect(text).toContain(stateLine("queue-order"));
		// The Work header in its two states: the depth count, and the depth
		// count with the pause word beside it. The raw frame keeps the word's
		// spacing.
		expect(raw).toContain("waiting: 1");
		expect(raw).toContain("waiting: 1  paused");
		// The queue's own keys on the bar: the order-move keys and the pause,
		// the pause reading its own state.
		expect(text).toContain(
			"+ promotes the selected item, - demotes it, and the top item is next in line for a seat",
		);
		// The Message lines the pause and the resume leave, in the words the
		// plane says them: the toggle's own notice, one short line each.
		expect(text).toContain("Work queue paused");
		expect(text).toContain("Work queue resumed");
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
