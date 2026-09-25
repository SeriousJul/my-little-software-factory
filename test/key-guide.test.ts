/**
 * The in-app Key guide: a utility overlay that opens on demand from every
 * interaction mode, lists the catalogue's controls with the aliases valid
 * in the mode it was opened from, marks this mode's unavailability, updates
 * live while open, and restores the base state exactly on close.
 *
 * The guide and the Message view are mutually exclusive: only one utility
 * overlay is visible at a time, and each hands the keys to the other.
 *
 * The frame tests boot the real app through the shared harness; no mock
 * sees a key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { widthOf } from "../src/components/text.ts";
import type { FactoryConfig } from "../src/config.ts";
import { baseChoice } from "../src/handoff.ts";
import type { Setup } from "./app-harness.ts";
import {
	actionBarRowOf,
	awaitFrame,
	closeOverlay,
	detailFocused,
	focusDetail,
	focusList,
	HEIGHT,
	markerRowOf,
	messageRowOf,
	mouseClick,
	openGuide,
	openMessageView,
	openPanel,
	openSurface,
	press,
	rgb,
	roleColor,
	rowsOf,
	settle,
	spanColorAt,
	stillFrame,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { agentListJson, FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import {
	cleanupStateFixtures,
	freshState,
	issuesConfig,
	issueTicket,
	success,
} from "./state-fixture.ts";

let home = "";
let configPath = "";

beforeEach(() => {
	home = join(tmpdir(), `factory-guide-${Math.random().toString(36).slice(2)}`);
	configPath = join(home, "factory", "config.toml");
	mkdirSync(join(home, "src", "billing"), { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	cleanupStateFixtures();
});

/** Stub the git answers for a healthy convention checkout. */
function stubCheckout(runner: FakeRunner): void {
	const path = join(home, "src", "billing");
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
}

/** Press a guide scroll key and wait for the new range in the guide's bar. */
async function scrollGuide(setup: Setup, key: "j" | "k", range: string): Promise<string> {
	setup.mockInput.pressKey(key);
	return awaitFrame(setup, (f) => actionBarRowOf(f).includes(range), `the guide range ${range}`);
}

/** The value the panel's selected Model row shows, or "" when it is not on screen. */
const modelValueOf = (frame: string): string => {
	const row = rowsOf(frame).find((r) => r.includes("❯ Model"));
	if (row === undefined) return "";
	// Stop at the modal's right border: the row pads to the terminal width.
	return (row.split("❯ Model")[1] ?? "").split("│")[0].trim();
};

/** Collapse the guide's padded key and label columns into single spaces. */
const norm = (row: string): string => row.replace(/\s+/g, " ").trim();

/** A row's content with the modal's box borders stripped, or "" for a blank row. */
const contentOf = (row: string): string =>
	row
		.replace(/[│┌┐└┘─]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** The guide's own range indicator, or undefined when the bar holds no range. */
const guideRangeOf = (frame: string): { top: number; total: number } | undefined => {
	const match = actionBarRowOf(frame).match(/(\d+)-(\d+)\/(\d+)/);
	return match === null ? undefined : { top: Number(match[1]), total: Number(match[3]) };
};

/**
 * Walk the open guide from its top to its bottom and return every content row
 * in first-seen order. A row the window never shows in full is still visited,
 * so a search over the result covers the whole catalogue, not the first fold.
 */
async function allGuideRows(setup: Setup): Promise<string[]> {
	let frame = await settle(setup);
	for (let step = 0; step < 300; step += 1) {
		const range = guideRangeOf(frame);
		if (range === undefined || range.top <= 1) break;
		setup.mockInput.pressKey("k");
		frame = await settle(setup);
	}
	const seen: string[] = [];
	for (let step = 0; step < 400; step += 1) {
		const rows = rowsOf(frame);
		const top = rows.findIndex((row) => row.includes("┌"));
		const bottom = rows.findLastIndex((row) => row.includes("└"));
		for (const row of rows.slice(top + 1, bottom)) {
			const content = contentOf(row);
			if (content !== "" && !seen.includes(content)) seen.push(content);
		}
		// One step down; at the bottom the range holds, so the walk ends.
		const before = guideRangeOf(frame);
		setup.mockInput.pressKey("j");
		frame = await settle(setup);
		const after = guideRangeOf(frame);
		if (before === undefined || after === undefined || after.top <= before.top) break;
	}
	return seen;
}

describe("the in-app Key guide", () => {
	test("does not open by itself; ? and F1 open and close it from the Ticket list", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				expect(await settle(setup)).not.toContain("Key guide");

				await openGuide(setup, "?");
				expect(setup.captureCharFrame()).toContain("Key guide - Ticket list");
				await closeOverlay(setup, "Key guide", "the guide to close");

				await openGuide(setup, "F1");
				await closeOverlay(setup, "Key guide", "the guide to close", "F1");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("names the mode it was opened from, in every mode", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				// Ticket list.
				await openGuide(setup, "?", "Key guide - Ticket list");
				await closeOverlay(setup, "Key guide", "the guide to close");
				// Ticket detail.
				await focusDetail(setup);
				await openGuide(setup, "?", "Key guide - Ticket detail");
				await closeOverlay(setup, "Key guide", "the guide to close");
				// Override list row.
				await focusList(setup);
				await openPanel(setup);
				await openGuide(setup, "?", "Key guide - Override list row");
				await closeOverlay(setup, "Key guide", "the guide to close");
				// Override text row.
				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the model row", (f) => f.includes("❯ Model"));
				await openGuide(setup, "F1", "Key guide - Override text row");
				await closeOverlay(setup, "Key guide", "the guide to close", "F1");
				// The bar keeps the e Override hint forever, so the panel's box
				// title is the close signal.
				await closeOverlay(setup, "┌─Override", "the panel to close");
				// Decision modal: select the awaiting ticket. The list truncates
				// titles, so the checks use short stable prefixes.
				await press(setup, "j", "the handed-off ticket", (f) =>
					rowsOf(f)[markerRowOf(f)].includes("Fix pan drift"),
				);
				await press(setup, "j", "the running ticket", (f) =>
					rowsOf(f)[markerRowOf(f)].includes("Migrate scheduler"),
				);
				await press(setup, "j", "the awaiting ticket", (f) =>
					rowsOf(f)[markerRowOf(f)].includes("Drop the legacy"),
				);
				await openSurface(setup, "return", "the decision panel", (f) => f.includes("Decision:"));
				await openGuide(setup, "?", "Key guide - Decision modal");
				await closeOverlay(setup, "Key guide", "the guide to close");
				// The panel survived the guide.
				expect(setup.captureCharFrame()).toContain("Decision:");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);

		// Missing modal: an in-flight Ticket whose pane herdr no longer
		// lists. The guide names the missing mode and holds its own
		// controls in the current section, not the decision modal's.
		{
			const state = freshState();
			try {
				const missingRunner = new FakeRunner();
				missingRunner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
				const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
				const sourceDef = { name: "issues", kind: "github-issues" };
				state.initializeSources([sourceDef]);
				state.applyFetch(sourceDef, success([issueTicket()]));
				const claim = state.claimHandoff(
					"github:github.com:I_5",
					{
						agentType: "pi",
						environment: "live-worktree",
						taskType: "implement",
						model: "",
						thinking: "",
						contextWindow: "",
					},
					"open",
				);
				if (!claim.ok) throw new Error(claim.reason);
				state.settleHandoff(claim.claim.attemptId, true, undefined, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
				});

				await withApp(
					async (setup) => {
						source.settle(success([issueTicket()]));
						await awaitFrame(
							setup,
							(f) => rowsOf(f)[markerRowOf(f)].includes("missing"),
							"the missing badge",
						);
						await openSurface(setup, "return", "the missing modal", (f) => f.includes("Missing:"));
						const rows = rowsOf(await openGuide(setup, "?", "Key guide - Missing modal"));
						const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));
						const between = (top: number, bottom: number) =>
							rows.slice(top + 1, bottom).map(contentOf);
						expect(
							between(indexOf("Current interaction mode"), indexOf("Global controls")),
						).toEqual([
							"F1/? Help",
							"F2 Message - the current Message fits on the Message line",
							"↑↓ Select action",
							"j/k Scroll message",
							"Enter Confirm action",
							"Esc Cancel",
						]);
						await closeOverlay(setup, "Key guide", "the guide to close");
						// The panel survived the guide.
						expect(setup.captureCharFrame()).toContain("Missing:");
					},
					WIDTH,
					HEIGHT,
					{
						config: issuesConfig,
						state,
						sources: [source],
						runner: missingRunner,
						pollIntervalMs: 60_000,
					},
				);
			} finally {
				state.close();
			}
		}
	});

	// The Work queue's list and detail modes are cataloged like every other
	// base mode. This walks the guide from both queue modes: each names its own
	// controls (the reorder pair, the cancel, the list return, the queue's own
	// scroll reason), and no other section's controls reach its current-mode
	// section. That is the Key-guide half of the Work queue row in the
	// verification record: the catalogue dispatch and the guide's per-section
	// key names, measured (ADR 0034).
	test("names the Work queue modes, and keeps each section's keys in its own guide", async () => {
		const state = freshState();
		try {
			// One waiting start: the guide reads the queue cursor through it.
			const enqueued = state.enqueueWork({
				ticketIdentity: "github:github.com:I_5",
				origin: "open",
				choice: baseChoice("pi", "live-worktree", "implement"),
				previousMessage: "",
			});
			if (!enqueued.ok) throw new Error(enqueued.reason);
			const runner = new FakeRunner();
			const tickets = [issueTicket()];
			const source = new FakeSource("issues", "github-issues", success(tickets));
			// These frames read the waiting item, never a running start. A zero
			// Parallel limit keeps the cap gate off, and the long poll interval holds
			// the observation cycle back: at an unlimited cap `pickupWorkQueue` runs
			// the whole queue, so a cycle that fired mid-test would empty the queue
			// under the guide.
			const zeroSeatConfig: FactoryConfig = {
				...issuesConfig,
				maxParallelAgents: 0,
				agentPollIntervalSeconds: 60,
			};
			await withApp(
				async (setup) => {
					source.settle(success(tickets));
					// The Work header stands with its count; it starts expanded (ADR 0049).
					// Wait for the source's title to reach the queue row as well: the
					// row holds the raw ticket identity until the first source poll.
					const header = await awaitFrame(
						setup,
						(f) =>
							f.includes("▾ Work") &&
							f.includes("waiting: 1") &&
							f.includes("Add a webhook retry policy"),
						"the Work header",
					);
					expect(header).toContain("▾ Work");
					// The section is already expanded; the click lands the cursor on
					// the item row. The Ticket section shows the same title with the
					// same badge, so the queue row is the first match below the Work
					// header, not the first match in the frame.
					const headerRows = rowsOf(header);
					const workHeaderRow = headerRows.findIndex((row) => row.startsWith("▾ Work"));
					const workRow =
						headerRows
							.slice(workHeaderRow + 1)
							.findIndex(
								(row) => row.includes("[open]") && row.includes("Add a webhook retry policy"),
							) +
						workHeaderRow +
						1;
					await mouseClick(setup, 2, workRow);
					const list = await awaitFrame(
						setup,
						(f) => f.includes("▾ Work") && f.includes("Add a webhook retry policy 1"),
						"the Work queue item row",
					);
					expect(list).toMatch(/\[open\]\s+Add a webhook retry policy/);

					// The list-mode guide holds the queue's keys and none of the
					// Ticket section's: the reorder pair and the cancel stand in the
					// current mode, and no Hand off or Decide row reaches it.
					const listGuide = rowsOf(await openGuide(setup, "?", "Key guide - Work queue list"));
					const listIndexOf = (needle: string) =>
						listGuide.findIndex((row) => norm(row).includes(needle));
					const listBetween = (top: number, bottom: number) =>
						listGuide.slice(top + 1, bottom).map(contentOf);
					const listCurrent = listBetween(
						listIndexOf("Current interaction mode"),
						listIndexOf("Global controls"),
					);
					expect(listCurrent).toContain("+ Promote - the item is first in the queue");
					expect(listCurrent).toContain("- Demote - the item is last in the queue");
					expect(listCurrent.some((row) => row.startsWith("p Pause queue"))).toBe(true);
					expect(listCurrent).toContain("Delete Remove");
					// Enter is the queue's force-dispatch (issue #89), with its note
					// saying what the start does and where the failure ends. The note
					// may flow onto its continuation row at this width, so the check
					// reads the joined rows.
					expect(listCurrent.some((row) => row.startsWith("Enter Force-dispatch"))).toBe(true);
					expect(listCurrent.join(" ")).toContain(
						"starts the item over a full Parallel limit; a failure leaves the queue",
					);
					expect(listCurrent.some((row) => row.includes("Hand off"))).toBe(false);
					expect(listCurrent.some((row) => row.includes("Decide"))).toBe(false);
					// The Consultation section's `d Delete` and `f History` run on
					// the shared base modes, so they reach a queue mode as a key the
					// queue can never dispatch. Each section's guide names only the
					// keys it owns (issue #85, ADR 0034): the queue's own keys stand,
					// and the other section's two rows stay out.
					expect(listCurrent.some((row) => row.startsWith("d Delete"))).toBe(false);
					expect(listCurrent.some((row) => row.startsWith("f History"))).toBe(false);
					await closeOverlay(setup, "Key guide", "the guide to close");

					// The detail-mode guide: the queue's scroll carries its own
					// reason, the pane return is named for the queue, and the
					// list-mode keys (reorder, cancel) leave this mode's section.
					setup.mockInput.pressKey("l");
					const detailGuide = rowsOf(await openGuide(setup, "?", "Key guide - Work queue detail"));
					const detailIndexOf = (needle: string) =>
						detailGuide.findIndex((row) => norm(row).includes(needle));
					const detailCurrent = detailGuide
						.slice(detailIndexOf("Current interaction mode") + 1, detailIndexOf("Global controls"))
						.map(contentOf);
					expect(detailCurrent).toContain(
						"↑↓/jk Scroll - the Work queue detail has nowhere to scroll",
					);
					expect(detailCurrent).toContain("←/h List");
					expect(detailCurrent.some((row) => row.includes("Queue up"))).toBe(false);
					expect(detailCurrent.some((row) => row.includes("Remove"))).toBe(false);
					expect(detailCurrent.some((row) => row.includes("Force-dispatch"))).toBe(false);
					// The detail pane holds no queue key of its own for `d` or `f`,
					// so the Consultation section's two refuse there and appear in
					// this guide nowhere: the row that would name the key the mode
					// cannot dispatch is the leak issue #85 closed for the Ticket
					// section, closed here for the queue.
					expect(detailCurrent.some((row) => row.startsWith("d Delete"))).toBe(false);
					expect(detailCurrent.some((row) => row.startsWith("f History"))).toBe(false);
					await closeOverlay(setup, "Key guide", "the guide to close");
				},
				WIDTH,
				34,
				{ config: zeroSeatConfig, state, sources: [source], runner },
			);
		} finally {
			state.close();
		}
	});

	test("lists the sections in order, with every control once and all valid aliases", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				const rows = rowsOf(await settle(setup));
				const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));

				// The current-mode header leads the opening window. The catalog has
				// grown past one window since the grouping controls joined the
				// Ticket modes (issue #159), so the section headers below it and
				// every row of the current section are checked from the walk to the
				// bottom, which is what the operator reads to see them all.
				expect(indexOf("Current interaction mode")).toBeGreaterThanOrEqual(0);

				// The guide pads the key and label columns, so every row read
				// below strips the borders and collapses the padding.
				// The alias order is the catalogue order: F1 before ?, m
				// before F2. The bar's single-alias hints stay in that order
				// too, so the guide never reorders what the bar shows.
				expect(setup.captureCharFrame()).toContain("F1/?");
				expect(setup.captureCharFrame()).toContain("m/F2");

				// Walk to the bottom and read the catalog's tail. One scroll step
				// reveals one row, so every row the walk shows, taken in the order
				// it first appears, is the catalog in its own order.
				const shown: string[] = [];
				const note = (frame: string): void => {
					const rows = rowsOf(frame);
					const top = rows.findIndex((row) => row.includes("┌"));
					const bottom = rows.findLastIndex((row) => row.includes("└"));
					for (const row of rows.slice(top + 1, bottom)) {
						const content = contentOf(row);
						if (content !== "" && !shown.includes(content)) shown.push(content);
					}
				};
				note(await settle(setup));
				const ladder = Array.from({ length: 38 }, (_, step) => step + 2).map(
					(row) => `${row}-${row + 18}/57`,
				);
				for (const range of ladder) note(await scrollGuide(setup, "j", range));
				// The Control plane section names the merged Main view's controls -
				// the section switches, the Consultation operations, the Recovery -
				// and the Other section is the catalog's tail: every control of
				// another mode, once each, in catalogue order, the field editing
				// rows among them, and the Agent terminal and the guide stating
				// only the keys they accept.
				const currentStart = shown.indexOf("Current interaction mode");
				expect(currentStart).toBeGreaterThanOrEqual(0);
				// The current section holds exactly this mode's controls, in
				// catalogue order, with every alias valid in the list mode and
				// this mode's reasons on the unavailable ones. The Grouping axis
				// and the Group fold join it (issue #159): the axis names its
				// whole cycle in the note, and the fold states the reason a cursor
				// on a Ticket row gives it.
				const globalStart = shown.indexOf("Global controls");
				expect(shown.slice(currentStart + 1, globalStart)).toEqual([
					"↑↓/jk Move",
					"→/l Detail",
					"Enter Queue item - the selected row has no waiting queue item",
					"Enter Hand off",
					"Enter Live view - only an in-flight Ticket has a Live view",
					"Enter Decide - the selected Ticket has no completion to decide",
					"g Goto - the Agent's pane is not alive in the last poll",
					// Close sits beside Goto: the key that ends the work cycle,
					// refused here with the open Ticket's own reason (ADR 0031).
					"w Close - the selected Ticket is open: no work is in flight to close",
					// The axis row wraps: its note names the whole cycle, and the
					// label column is sized to the longest reason.
					"Tab Group - cycles the grouping axis: none, repository, source, task,",
					"state, position",
					"x Fold - no Group header is under the cursor",
					"x Section - collapses the section the cursor is in, or expands it back",
					// The reason is the longest in the guide: the label column
					// is sized to its content, and what still does not fit
					// flows onto its own continuation row rather than being
					// cut.
					"c Launch - no Consultation types configured; add",
					"[consultation-types.<name>] to the config file",
					"e Override",
					"r Refresh - no Ticket sources exist",
					"F1/? Help",
					"m/F2 Message - the current Message fits on the Message line",
				]);
				expect(globalStart).toBeGreaterThan(0);
				const planeStart = shown.indexOf("Control plane controls");
				expect(planeStart).toBeGreaterThan(globalStart);
				// The Global section is exactly two rows.
				expect(shown.slice(globalStart + 1, planeStart)).toEqual([
					"q Quit",
					"Ctrl+C Emergency exit - may require Handoff recovery on the next start",
				]);
				const otherStart = shown.indexOf("Other interaction modes");
				expect(otherStart).toBeGreaterThan(planeStart);
				// Delete and History stay cataloged in the Consultation section
				// alone: the Ticket guide omits them, and their keys refuse in
				// this section instead. Recovery leads the Enter rows: a live record
				// resolves past it to Respond and Interact, and a broken or stuck
				// one reads it as the meaning Enter takes here (ADR 0038).
				expect(shown.slice(planeStart + 1, otherStart)).toEqual([
					"w Close",
					"Enter Recovery - opens the recovery surface a broken or stuck Consultation needs",
					"Enter Respond",
					"Enter Interact",
					// Goto is cataloged behind Interact: navigation between the
					// Consultation and the Agent's pane, ADR 0025.
					"g Goto",
					"r Recover",
					"a Toggle auto-handoff",
				]);
				expect(shown.slice(otherStart + 1)).toEqual([
					"↑↓/jk Scroll",
					"←/h Tickets",
					"←/h List",
					"←→/hl Change",
					"Type Edit",
					"Backspace Delete",
					"⌫ Clear",
					"F12 Exit interaction",
					"Esc Cancel",
					"Tab Field",
					"←→ Change",
					"Enter Confirm",
					"F3 Copy selection",
					"Del Clear",
					"Esc Close",
					"↑↓ Select action",
					"j/k Scroll body",
					"j/k Scroll message",
					"e Edit handoff",
					"Enter Confirm action",
					// The Live view's streaming sub-mode confirms the Goto: pure
					// focus, cataloged beside the decision's own actions (ADR 0040).
					"Enter Goto",
					"Esc/F1/? Close",
					"Esc/F2 Close",
				]);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	// The reason column is where a guide with long text can lose it: the two
	// text columns are sized to their content, and whatever the width cannot
	// hold flows onto continuation rows instead of being cut.
	for (const [width, height] of [
		[200, 40],
		[120, 30],
		[80, 30],
		[44, 24],
	] as const) {
		test(`keeps every reason in full at ${width} columns`, async () => {
			const runner = new FakeRunner();
			await withApp(
				async (setup) => {
					setup.resize(width, height);
					await openGuide(setup, "?");
					const reasons = [
						// The longest reason in the catalogue.
						"no Consultation types configured; add [consultation-types.<name>] to the config file",
						// The note the guide carries for the emergency exit.
						"may require Handoff recovery on the next start",
					];
					// The guide's own range indicator, so the walk runs to the
					// real bottom instead of a fixed step count.
					const rangeOf = (
						frame: string,
					): { top: number; end: number; total: number } | undefined => {
						const match = actionBarRowOf(frame).match(/(\d+)-(\d+)\/(\d+)/);
						return match === null
							? undefined
							: { top: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
					};
					// One step down, waited on the range advance itself. The guide
					// scrolls one row per key, so the bar's new range is the step's
					// effect, and the wait ends the moment it stands. A full settle
					// after every step overran the test's budget at the narrowest
					// size, where the flowed reasons run the guide past a hundred
					// rows (issue #104).
					const stepDown = async (from: { top: number; total: number }): Promise<string> => {
						setup.mockInput.pressKey("j");
						return await awaitFrame(
							setup,
							(f) => {
								const range = rangeOf(f);
								return (
									range !== undefined && range.top === from.top + 1 && range.total === from.total
								);
							},
							`the guide range to advance to ${from.top + 1}`,
						);
					};
					// Walk the whole list once from the top, the place the guide
					// opens at: a reason can sit below the fold, so every window
					// the walk shows is read. The cells of each window, not its
					// lines, are compared: a narrow guide breaks a long word
					// across rows, and every cell of a reason must still be there.
					let frame = await settle(setup);
					const windows: string[] = [];
					for (;;) {
						windows.push(
							rowsOf(frame)
								.map((row) => contentOf(row).replace(/\s+/g, ""))
								.join(""),
						);
						const range = rangeOf(frame);
						if (range === undefined)
							throw new Error(`the guide's bar holds no range at ${width} columns`);
						// One step down; the bottom window holds the last rows,
						// so the range holds on the next step and the walk ends
						// instead of spinning on the last row.
						if (range.top > range.total - (range.end - range.top + 1)) break;
						frame = await stepDown(range);
					}
					// The windows meet at their rows, so a reason that stands in
					// no single window can never read as whole: the "|" keeps the
					// windows apart in the joined text.
					const collected = windows.join("|");
					for (const reason of reasons) {
						expect(collected, `the reason "${reason}" is cut at ${width} columns`).toContain(
							reason.replace(/\s+/g, ""),
						);
					}
					// No row of the guide is wider than the terminal.
					for (const row of rowsOf(await settle(setup))) expect(widthOf(row)).toBe(width);
					await closeOverlay(setup, "Key guide", "the guide closed");
				},
				width,
				height,
				{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
			);
		});
	}

	test("catalogs the three meanings of Enter, and runs only one", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				const rowOf = (rows: string[], needle: string) =>
					rows.find((row) => norm(row).includes(needle)) ?? "";

				// The selected Ticket is open, so Enter hands it off. The bar
				// names that meaning alone: a hint whose key runs the other one
				// would point at the wrong control. The guide still lists Live view
				// and Decide and says why this Ticket cannot use them (user
				// stories 12, 16).
				await openGuide(setup, "?");
				let rows = rowsOf(await settle(setup));
				expect(rowOf(rows, "Enter Live view")).toContain(
					"only an in-flight Ticket has a Live view",
				);
				expect(rowOf(rows, "Enter Decide")).toContain(
					"the selected Ticket has no completion to decide",
				);
				expect(
					spanColorAt(
						setup,
						rows.findIndex((r) => norm(r).includes("Enter Decide")),
						"Decide",
					),
				).toEqual(rgb(roleColor("subtext0")));
				await closeOverlay(setup, "Key guide", "the guide to close");
				let bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Hand off");
				expect(bar).not.toContain("Live view");
				expect(bar).not.toContain("Decide");

				// The awaiting Ticket is settled, so Enter decides it. The guide
				// keeps Hand off in its current section with the settled fact, so
				// the operator reading the catalog is never asked to guess what
				// Enter does there.
				await press(setup, "j", "the handed-off ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 5);
				await press(setup, "j", "the awaiting ticket", (f) => markerRowOf(f) === 6);
				await openGuide(setup, "?");
				rows = rowsOf(await settle(setup));
				expect(rowOf(rows, "Enter Hand off")).toContain("only an open Ticket can be handed off");
				expect(rowOf(rows, "Enter Live view")).toContain(
					"only an in-flight Ticket has a Live view",
				);
				expect(rowOf(rows, "Enter Decide")).toContain("opens the decision on a settled Ticket");
				const decideRow = rows.findIndex((r) => norm(r).includes("Enter Decide"));
				expect(spanColorAt(setup, decideRow, "Decide")).toEqual(rgb(roleColor("text")));
				await closeOverlay(setup, "Key guide", "the guide to close");
				bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Decide");
				expect(bar).not.toContain("Hand off");
				expect(bar).not.toContain("Live view");

				// The running Ticket answers for one meaning, and the guide says
				// the rest rather than dropping a row: every key carries its own
				// reason or note, and the bar states the one Enter runs.
				await press(setup, "k", "the running ticket", (f) => markerRowOf(f) === 5);
				await openGuide(setup, "?");
				rows = rowsOf(await settle(setup));
				expect(rowOf(rows, "Enter Hand off")).toContain("only an open Ticket can be handed off");
				expect(rowOf(rows, "Enter Live view")).toContain(
					"opens the Live view on an in-flight Ticket",
				);
				expect(
					spanColorAt(
						setup,
						rows.findIndex((r) => norm(r).includes("Enter Live view")),
						"Live view",
					),
				).toEqual(rgb(roleColor("text")));
				expect(rowOf(rows, "Enter Decide")).toContain(
					"the selected Ticket has no completion to decide",
				);
				await closeOverlay(setup, "Key guide", "the guide to close");
				bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Live view");
				expect(bar).not.toContain("Hand off");
				expect(bar).not.toContain("Decide");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("puts decision-modal controls in the current interaction mode", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "j", "the handed-off ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 5);
				await press(setup, "j", "the awaiting ticket", (f) => markerRowOf(f) === 6);
				await openSurface(setup, "return", "the decision panel", (f) => f.includes("Decision:"));
				await openGuide(setup, "?", "Key guide - Decision modal");
				const rows = rowsOf(await settle(setup));
				const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));
				const between = (top: number, bottom: number) => rows.slice(top + 1, bottom).map(contentOf);

				expect(between(indexOf("Current interaction mode"), indexOf("Global controls"))).toEqual([
					"F1/? Help",
					"F2 Message - the current Message fits on the Message line",
					"↑↓ Select action",
					"j/k Scroll body",
					"e Edit handoff - the selected action has no settings to edit",
					"Enter Confirm action",
					"Esc Cancel",
				]);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("marks this mode's unavailability on the current rows only, with the recovery note on Emergency exit", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				// The Emergency row and the Other-mode rows sit below the first
				// fold, so the checks walk the whole catalogue.
				const rows = await allGuideRows(setup);
				const rowOf = (needle: string) => rows.find((row) => norm(row).includes(needle)) ?? "";

				// No sources exist, and the Message fits: both current
				// controls carry their reason, in the catalogue's words.
				expect(rowOf("r Refresh")).toContain("no Ticket sources exist");
				expect(rowOf("m/F2 Message")).toContain("the current Message fits on the Message line");

				// The recovery note rides the always-available Emergency exit.
				expect(rowOf("Ctrl+C Emergency exit")).toContain(
					"may require Handoff recovery on the next start",
				);

				// Other-mode rows never carry a reason: the guide describes
				// the state of this mode, not a hypothetical one.
				for (const other of [
					"←/h Tickets",
					"←→/hl Change",
					"Type Edit",
					"Backspace Delete",
					"Esc Cancel",
					"↑↓ Select action",
					"j/k Scroll body",
					"j/k Scroll message",
					"Esc/F1/? Close",
					"Esc/F2 Close",
				]) {
					const row = rowOf(other);
					expect(row).not.toContain(" - ");
				}
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("paints availability on the guide rows", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				await settle(setup);
				let rows = rowsOf(setup.captureCharFrame());
				const rowOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));

				// Available: the key wears the focus color, the label the text
				// color.
				const moveRow = rowOf("Move");
				expect(spanColorAt(setup, moveRow, "↑↓/jk")).toEqual(rgb(roleColor("accent")));
				expect(spanColorAt(setup, moveRow, "Move")).toEqual(rgb(roleColor("text")));
				// Unavailable: the key and the label are dim, the reason dim.
				const refreshRow = rowOf("r Refresh");
				expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(roleColor("subtext0")));
				expect(spanColorAt(setup, refreshRow, "Refresh")).toEqual(rgb(roleColor("subtext0")));
				expect(spanColorAt(setup, refreshRow, "no Ticket sources exist")).toEqual(
					rgb(roleColor("subtext0")),
				);

				// The Global section sits below the first fold: step the guide
				// down until its rows can be color-checked.
				for (let step = 0; step < 10; step += 1) {
					setup.mockInput.pressKey("j");
					if ((await settle(setup)).includes("Emergency exit")) break;
				}
				rows = rowsOf(setup.captureCharFrame());
				// Emergency exit is available: the recovery note does not dim
				// the key.
				const exitRow = rowOf("Ctrl+C");
				expect(spanColorAt(setup, exitRow, "Ctrl+C")).toEqual(rgb(roleColor("accent")));
				expect(spanColorAt(setup, exitRow, "Emergency exit")).toEqual(rgb(roleColor("text")));
				// Group headers wear the bright text color.
				const groupRow = rowOf("Global controls");
				expect(spanColorAt(setup, groupRow, "Global controls")).toEqual(rgb(roleColor("text")));
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("updates availability live while open", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					// While the first fetch runs, every source is refreshing:
					// the current Refresh row carries the reason, dim.
					await awaitFrame(setup, (f) => f.includes("loading tickets..."), "loading");
					await openGuide(setup, "?");
					await settle(setup);
					let rows = rowsOf(setup.captureCharFrame());
					let refreshRow = rows.findIndex((row) => norm(row).includes("r Refresh"));
					expect(rows[refreshRow]).toContain("every Ticket source is already refreshing");
					expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(roleColor("subtext0")));

					// The fetch settles while the guide is open: the reason
					// leaves and the key takes the focus color, live.
					source.settle(success([issueTicket()]));
					await awaitFrame(
						setup,
						(f) =>
							!rowsOf(f)
								.map(norm)
								.find((row) => row.includes("r Refresh"))
								?.includes("already refreshing"),
						"the refresh row to clear",
					);
					rows = rowsOf(setup.captureCharFrame());
					refreshRow = rows.findIndex((row) => norm(row).includes("r Refresh"));
					expect(rows[refreshRow]).not.toContain(" - ");
					expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(roleColor("accent")));
					// The current section follows the state too: the fetched open
					// Ticket is selected, so Hand off loses its reason as well.
					expect(rows.find((row) => norm(row).includes("Enter Hand off"))).not.toContain(
						"no Ticket is selected",
					);
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("scrolls with a range and no-ops at the boundaries", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				expect(actionBarRowOf(await settle(setup))).toContain("1-19/57");

				await scrollGuide(setup, "j", "2-20/57");
				await scrollGuide(setup, "j", "3-21/57");
				await scrollGuide(setup, "k", "2-20/57");
				await scrollGuide(setup, "k", "1-19/57");
				// Top boundary: k holds the range.
				setup.mockInput.pressKey("k");
				expect(await settle(setup, 500)).toContain("1-19/57");
				// Walk to the bottom, one step per frame.
				const ladder = Array.from({ length: 38 }, (_, step) => step + 2).map(
					(row) => `${row}-${row + 18}/57`,
				);
				for (const range of ladder) await scrollGuide(setup, "j", range);
				// Bottom boundary: j holds the range.
				setup.mockInput.pressKey("j");
				expect(await settle(setup, 500)).toContain("39-57/57");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("restores the exact base state on close", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				// The selection.
				await press(setup, "j", "the selection to move on", (f) => markerRowOf(f) === 4);
				const selectedBefore = rowsOf(setup.captureCharFrame())[
					markerRowOf(setup.captureCharFrame())
				];
				await openGuide(setup, "?");
				await closeOverlay(setup, "Key guide", "the guide to close");
				let frame = await settle(setup);
				expect(stillFrame(rowsOf(frame)[markerRowOf(frame)])).toBe(stillFrame(selectedBefore));

				// The detail focus and scroll, at the new three-section floor
				// (ADR 0049 raised it to 27) on a narrow terminal where the detail
				// pane overflows: the narrow width wraps the description past the
				// pane's rows. The list keeps the focus through the resize, and the
				// probe reads the pane's raw column, so a scroll that only swaps a
				// blank padding row still shows.
				await focusDetail(setup);
				setup.resize(60, 27);
				await settle(setup);
				setup.mockInput.pressKey("l");
				await settle(setup);
				const detailCol = (f: string): string =>
					rowsOf(f)
						.map((row) => row.slice(32, 58))
						.join("\n");
				const detailTop = detailCol(setup.captureCharFrame());
				await press(
					setup,
					"j",
					"the detail to scroll",
					(f) => stillFrame(detailCol(f)) !== stillFrame(detailTop),
				);
				const detailBefore = detailCol(setup.captureCharFrame());
				expect(stillFrame(detailBefore)).not.toBe(stillFrame(detailTop));
				await openGuide(setup, "?");
				await closeOverlay(setup, "Key guide", "the guide to close");
				frame = await settle(setup);
				expect(detailFocused(frame)).toBe(true);
				expect(stillFrame(detailCol(frame))).toBe(stillFrame(detailBefore));
				setup.resize(WIDTH, HEIGHT);
				await settle(setup);

				// The override panel's row and typed text. The detail kept the
				// focus through the guide, so the list takes it back first. The
				// selection sits on the handed-off ticket, which refuses an
				// override: back to the open one.
				await focusList(setup);
				await press(setup, "k", "the open ticket", (f) => markerRowOf(f) === 3);
				await openPanel(setup);
				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the model row", (f) => f.includes("❯ Model"));
				await press(setup, "a", "the text to type", (f) => modelValueOf(f) === "a");
				await press(setup, "b", "the text to type", (f) => modelValueOf(f) === "ab");
				await openGuide(setup, "F1", "Key guide - Override text row");
				await press(setup, "?", "the guide to close", (f) => !f.includes("Key guide"));
				frame = await settle(setup);
				expect(modelValueOf(frame)).toBe("ab");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("closes on Esc, F1, and ?", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				await closeOverlay(setup, "Key guide", "the guide to close", "F1");

				await openGuide(setup, "?");
				await press(setup, "?", "the guide to close", (f) => !f.includes("Key guide"));
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("ignores the base keys while open", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				const before = await settle(setup);
				const markerBefore = markerRowOf(before);

				await openGuide(setup, "?");
				// j scrolls the guide, not the list.
				setup.mockInput.pressKey("j");
				await awaitFrame(
					setup,
					(f) => actionBarRowOf(f).includes("2-20/57"),
					"the guide to scroll",
				);
				// e opens no panel, r warns no refresh, q quits nothing,
				// Enter starts no handoff. The guide stays the owner of the
				// keys through all of it.
				setup.mockInput.pressKey("e");
				setup.mockInput.pressKey("r");
				setup.mockInput.pressKey("q");
				setup.mockInput.pressEnter();
				await settle(setup);
				expect(setup.captureCharFrame()).toContain("Key guide");

				// The base is exactly where it was. While the guide is open the
				// base is behind the overlay, so the checks run on close.
				await closeOverlay(setup, "Key guide", "the guide to close");
				const frame = await settle(setup);
				expect(frame).not.toContain("❯ Agent");
				expect(markerRowOf(frame)).toBe(markerBefore);
				expect(messageRowOf(frame).trim()).toBe("");
				expect(actionBarRowOf(frame)).toBe(actionBarRowOf(before));
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("types ? and q into the override text row, and F1 opens the guide there", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the model row", (f) => f.includes("❯ Model"));
				// ? is a printable character here: it types, it does not help.
				await press(setup, "?", "the question mark to type", (f) => modelValueOf(f) === "?");
				// q is printable here too: it types, it does not quit.
				await press(setup, "q", "the letter to type", (f) => modelValueOf(f) === "?q");
				expect(setup.captureCharFrame()).not.toContain("Key guide");
				// F1 is the help alias in the text row.
				await openGuide(setup, "F1", "Key guide - Override text row");
				// ? closes the guide from any mode. The typed characters stay.
				await press(setup, "?", "the guide to close", (f) => !f.includes("Key guide"));
				const frame = await settle(setup);
				expect(modelValueOf(frame)).toBe("?q");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("excludes the Message view while one is open: F2 goes, F1 returns", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: `error: the daemon refused the request after the outage. ${"x".repeat(240)}\n`,
		});
		await withApp(
			async (setup) => {
				// A truncated error: the bar offers m Message.
				await press(setup, "return", "the failure to land", (f) =>
					messageRowOf(f).startsWith("Error: error: the daemon refused"),
				);
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("m Message");

				// The guide over the error: the Message row loses its reason,
				// and F2 hands the keys to the Message view.
				await openGuide(setup, "?");
				const guideFrame = await settle(setup);
				expect(guideFrame).not.toContain("the current Message fits on the Message line");
				expect(actionBarRowOf(guideFrame)).toContain("F2 Message");
				const viewFrame = await openMessageView(setup, "F2", "Message view - Error");
				expect(viewFrame).not.toContain("Key guide");
				expect(viewFrame).toContain("the daemon refused the request");

				// F1 hands the keys back to the guide, over the same mode.
				const backFrame = await openGuide(setup, "F1", "Key guide - Ticket list");
				expect(backFrame).not.toContain("Message view");

				// Closing both leaves the error on the Message line.
				await closeOverlay(setup, "Key guide", "the guide to close");
				const closed = await settle(setup);
				expect(messageRowOf(closed)).toContain("the daemon refused the request");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS, home, configPath },
		);
	});

	test("shows only reachable hints in its Action bar", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				// The message fits: the bar names Scroll and Close only. F1
				// and ? close the guide here, so a Help hint would lie.
				await openGuide(setup, "?");
				const bar = actionBarRowOf(await settle(setup));
				expect(bar).toContain("↑↓/jk Scroll");
				expect(bar).toContain("1-19/57");
				expect(bar).toContain("Esc/F1/? Close");
				expect(bar).not.toContain("Help");
				expect(bar).not.toContain("Message");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("shrinks with the terminal and keeps its scroll", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				expect(actionBarRowOf(await settle(setup))).toContain("1-19/57");

				// A short, wide terminal: four visible rows, the full title
				// still fitting, and more total rows because the reason column is
				// narrower and flows onto more lines. The surface gives its last
				// two rows to its Message line and Action bar.
				setup.resize(60, 12);
				let frame = await settle(setup);
				expect(frame).toContain("Key guide - Ticket list");
				// The selector's note, the Close reason, the Grouping axis note,
				// and the Recovery note wrap on this narrow terminal, so the guide
				// runs longer than at the full width.
				expect(actionBarRowOf(frame)).toContain("1-4/82");

				await scrollGuide(setup, "j", "2-5/82");
				// Back to size: the scroll the terminal gave back is kept.
				setup.resize(WIDTH, HEIGHT);
				frame = await settle(setup);
				expect(actionBarRowOf(frame)).toContain("2-20/57");

				// Below the useful size the terminal takes its compact frame:
				// the modal caps at the terminal, the title falls back to the
				// bare word, and the bar keeps only the Help key.
				setup.resize(25, 10);
				frame = await settle(setup);
				expect(frame).toContain("┌─Key guide─");
				expect(frame).not.toContain("Key guide - Ticket list");
				for (const row of rowsOf(frame)) expect(widthOf(row)).toBe(25);
				// The utility bar packs the hints that fit; Close is the last
				// standing one at this width.
				expect(actionBarRowOf(frame).trim()).toBe("Esc/F1/? Close");

				// And the way back out.
				setup.resize(WIDTH, HEIGHT);
				frame = await settle(setup);
				expect(frame).toContain("Key guide - Ticket list");
				expect(actionBarRowOf(frame)).toContain("2-20/57");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});
});
