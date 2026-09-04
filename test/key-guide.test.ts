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
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { widthOf } from "../src/components/text.ts";
import { COLORS } from "../src/components/theme.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { Setup } from "./app-harness.ts";
import {
	actionBarRowOf,
	awaitFrame,
	closeOverlay,
	detailFocused,
	detailPaneText,
	focusDetail,
	focusList,
	HEIGHT,
	markerRowOf,
	messageRowOf,
	openGuide,
	openMessageView,
	openPanel,
	openSurface,
	press,
	rgb,
	rowsOf,
	settle,
	spanColorAt,
	WIDTH,
	withApp,
} from "./app-harness.ts";
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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

	test("lists the sections in order, with every control once and all valid aliases", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				const rows = rowsOf(await settle(setup));
				const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));

				// The first three section headers hold in the opening window; the
				// Other header is one row below it, so its place is checked after
				// the walk to the bottom.
				const sections = ["Current interaction mode", "Global controls", "Control plane controls"];
				const sectionRows = sections.map((s) => indexOf(s));
				expect(sectionRows.every((row) => row >= 0)).toBe(true);
				expect([...sectionRows].sort((a, b) => a - b)).toEqual(sectionRows);

				// The guide pads the key and label columns, so compare the row
				// content with the borders stripped and whitespace collapsed.
				const between = (top: number, bottom: number) => rows.slice(top + 1, bottom).map(contentOf);

				// The current section holds exactly this mode's controls, in
				// catalogue order, with every alias valid in the list mode and
				// this mode's reasons on the unavailable ones.
				expect(between(indexOf("Current interaction mode"), indexOf("Global controls"))).toEqual([
					"↑↓/jk Move",
					"→/l Detail",
					"Enter Hand off",
					"Enter Decide - the selected Ticket has no completion to decide",
					"v Consultations",
					// The reason is the longest in the guide: the label column
					// is sized to its content, and what still does not fit
					// flows onto its own continuation row rather than being
					// cut.
					"c Launch consultation - no Consultation types configured; add",
					"[consultation-types.<name>] to the config file",
					"e Override",
					"r Refresh - no Ticket sources exist",
					// The reason wraps at this width, one word over the column.
					"w clear leftover - no leftover environment is recorded for ticket",
					"github:github.com:I_1",
					"F1/? Help",
					"m/F2 Message - the current Message fits on the Message line",
				]);
				expect(between(indexOf("Global controls"), indexOf("Control plane controls"))).toEqual([
					"q Quit",
					"Ctrl+C Emergency exit - may require Handoff recovery on the next start",
				]);
				// The Other header sits one row below the window, so the plane
				// section ends at the box's last row: its one control, then the
				// box's padding row.
				const windowEnd = rows.findIndex((row) => row.includes("└"));
				expect(between(indexOf("Control plane controls"), windowEnd)).toEqual([
					"a Toggle auto-handoff",
					"",
				]);

				// The alias order is the catalogue order: F1 before ?, m
				// before F2. The bar's single-alias hints stay in that order
				// too, so the guide never reorders what the bar shows.
				expect(setup.captureCharFrame()).toContain("F1/?");
				expect(setup.captureCharFrame()).toContain("m/F2");

				// Walk to the bottom and read the whole Other section: the
				// remaining controls of the catalogue, each exactly once, in
				// order. Together with the sections above, every control is
				// listed exactly once.
				const ladder = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map(
					(i) => `${i}-${i + 18}/36`,
				);
				for (const range of ladder) await scrollGuide(setup, "j", range);
				const scrolled = rowsOf(await settle(setup));
				const otherStart = scrolled.findIndex((row) =>
					norm(row).includes("Other interaction modes"),
				);
				const otherEnd = scrolled.findIndex((row) => row.includes("└"));
				expect(otherStart).toBeGreaterThan(0);
				expect(otherEnd).toBeGreaterThan(otherStart);
				expect(
					scrolled
						.slice(otherStart + 1, otherEnd)
						.map(contentOf)
						.filter((content) => content !== ""),
				).toEqual([
					"↑↓/jk Scroll",
					"←/h Tickets",
					"←→/hl Change",
					"Type Edit",
					"Backspace Delete",
					"⌫ Clear",
					"Esc Cancel",
					"↑↓ Select action",
					"j/k Scroll log",
					"j/k Scroll message",
					"Enter Confirm action",
					"Esc Cancel",
					"↑↓/jk Scroll",
					"Esc/F1/? Close",
					"↑↓/jk Scroll",
					"Esc/F2 Close",
				]);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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
					for (const reason of reasons) {
						// Walk the whole list: a reason can sit below the fold.
						let frame = await settle(setup);
						let found = false;
						for (let step = 0; step < 40 && !found; step += 1) {
							// Compare the cells, not the lines: a narrow guide
							// breaks a long word across rows, and every cell of
							// the reason must still be there.
							const joined = rowsOf(frame)
								.map((row) => contentOf(row).replace(/\s+/g, ""))
								.join("");
							found = joined.includes(reason.replace(/\s+/g, ""));
							if (found) break;
							setup.mockInput.pressKey("j");
							frame = await settle(setup);
						}
						expect(found, `the reason "${reason}" is cut at ${width} columns`).toBe(true);
					}
					// No row of the guide is wider than the terminal.
					for (const row of rowsOf(await settle(setup))) expect(widthOf(row)).toBe(width);
					await closeOverlay(setup, "Key guide", "the guide closed");
				},
				width,
				height,
				{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
			);
		});
	}

	test("catalogs both meanings of Enter, and runs only one", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				const rowOf = (rows: string[], needle: string) =>
					rows.find((row) => norm(row).includes(needle)) ?? "";

				// The selected Ticket is open, so Enter hands it off. The bar
				// names that meaning alone: a hint whose key runs the other one
				// would point at the wrong control. The guide still lists Decide
				// and says why this Ticket cannot use it (user stories 12, 16).
				await openGuide(setup, "?");
				let rows = rowsOf(await settle(setup));
				expect(rowOf(rows, "Enter Decide")).toContain(
					"the selected Ticket has no completion to decide",
				);
				expect(
					spanColorAt(
						setup,
						rows.findIndex((r) => norm(r).includes("Enter Decide")),
						"Decide",
					),
				).toEqual(rgb(COLORS.dim));
				await closeOverlay(setup, "Key guide", "the guide to close");
				let bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Hand off");
				expect(bar).not.toContain("Decide");

				// The awaiting Ticket is settled, so Enter decides it. The guide
				// keeps Hand off in its current section with the settled fact, so
				// the operator reading the catalog is never asked to guess what
				// Enter does there.
				await press(setup, "j", "the handed-off ticket", (f) => markerRowOf(f) === 3);
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the awaiting ticket", (f) => markerRowOf(f) === 5);
				await openGuide(setup, "?");
				rows = rowsOf(await settle(setup));
				expect(rowOf(rows, "Enter Hand off")).toContain("only an open Ticket can be handed off");
				expect(rowOf(rows, "Enter Decide")).toContain("opens the decision on a settled Ticket");
				const decideRow = rows.findIndex((r) => norm(r).includes("Enter Decide"));
				expect(spanColorAt(setup, decideRow, "Decide")).toEqual(rgb(COLORS.text));
				await closeOverlay(setup, "Key guide", "the guide to close");
				bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Decide");
				expect(bar).not.toContain("Hand off");

				// The running Ticket answers for neither meaning, and the guide
				// says so twice rather than dropping a row: both keys carry
				// their own reason, and the bar states the one Enter runs.
				await press(setup, "k", "the running ticket", (f) => markerRowOf(f) === 4);
				await openGuide(setup, "?");
				rows = rowsOf(await settle(setup));
				expect(rowOf(rows, "Enter Hand off")).toContain("only an open Ticket can be handed off");
				expect(rowOf(rows, "Enter Decide")).toContain(
					"the selected Ticket has no completion to decide",
				);
				await closeOverlay(setup, "Key guide", "the guide to close");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("puts decision-modal controls in the current interaction mode", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "j", "the handed-off ticket", (f) => markerRowOf(f) === 3);
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the awaiting ticket", (f) => markerRowOf(f) === 5);
				await openSurface(setup, "return", "the decision panel", (f) => f.includes("Decision:"));
				await openGuide(setup, "?", "Key guide - Decision modal");
				const rows = rowsOf(await settle(setup));
				const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));
				const between = (top: number, bottom: number) => rows.slice(top + 1, bottom).map(contentOf);

				expect(between(indexOf("Current interaction mode"), indexOf("Global controls"))).toEqual([
					"F1/? Help",
					"F2 Message - the current Message fits on the Message line",
					"↑↓ Select action",
					"j/k Scroll log",
					"Enter Confirm action",
					"Esc Cancel",
				]);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("marks this mode's unavailability on the current rows only, with the recovery note on Emergency exit", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				const rows = rowsOf(await settle(setup));
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
					"j/k Scroll log",
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("paints availability on the guide rows", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				await settle(setup);
				const rows = rowsOf(setup.captureCharFrame());
				const rowOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));

				// Available: the key wears the focus color, the label the text
				// color.
				const moveRow = rowOf("Move");
				expect(spanColorAt(setup, moveRow, "↑↓/jk")).toEqual(rgb(COLORS.borderFocused));
				expect(spanColorAt(setup, moveRow, "Move")).toEqual(rgb(COLORS.text));
				// Unavailable: the key and the label are dim, the reason dim.
				const refreshRow = rowOf("r Refresh");
				expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(COLORS.dim));
				expect(spanColorAt(setup, refreshRow, "Refresh")).toEqual(rgb(COLORS.dim));
				expect(spanColorAt(setup, refreshRow, "no Ticket sources exist")).toEqual(rgb(COLORS.dim));
				// Emergency exit is available: the recovery note does not dim
				// the key.
				const exitRow = rowOf("Ctrl+C");
				expect(spanColorAt(setup, exitRow, "Ctrl+C")).toEqual(rgb(COLORS.borderFocused));
				expect(spanColorAt(setup, exitRow, "Emergency exit")).toEqual(rgb(COLORS.text));
				// Group headers wear the bright text color.
				const groupRow = rowOf("Global controls");
				expect(spanColorAt(setup, groupRow, "Global controls")).toEqual(rgb(COLORS.textBright));
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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
					expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(COLORS.dim));

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
					expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(COLORS.borderFocused));
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
				expect(actionBarRowOf(await settle(setup))).toContain("1-19/36");

				await scrollGuide(setup, "j", "2-20/36");
				await scrollGuide(setup, "j", "3-21/36");
				await scrollGuide(setup, "k", "2-20/36");
				await scrollGuide(setup, "k", "1-19/36");
				// Top boundary: k holds the range.
				setup.mockInput.pressKey("k");
				expect(await settle(setup, 500)).toContain("1-19/36");
				// Walk to the bottom, one step per frame.
				const ladder = [
					"2-20/36",
					"3-21/36",
					"4-22/36",
					"5-23/36",
					"6-24/36",
					"7-25/36",
					"8-26/36",
					"9-27/36",
					"10-28/36",
					"11-29/36",
					"12-30/36",
					"13-31/36",
					"14-32/36",
					"15-33/36",
					"16-34/36",
					"17-35/36",
					"18-36/36",
				];
				for (const range of ladder) await scrollGuide(setup, "j", range);
				// Bottom boundary: j holds the range.
				setup.mockInput.pressKey("j");
				expect(await settle(setup, 500)).toContain("18-36/36");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("restores the exact base state on close", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				// The selection.
				await press(setup, "j", "the selection to move on", (f) => markerRowOf(f) === 3);
				const selectedBefore = rowsOf(setup.captureCharFrame())[
					markerRowOf(setup.captureCharFrame())
				];
				await openGuide(setup, "?");
				await closeOverlay(setup, "Key guide", "the guide to close");
				let frame = await settle(setup);
				expect(rowsOf(frame)[markerRowOf(frame)]).toBe(selectedBefore);

				// The detail focus and scroll, on a short terminal where the
				// detail pane overflows.
				await focusDetail(setup);
				setup.resize(WIDTH, 12);
				const detailTop = detailPaneText(await settle(setup));
				await press(setup, "j", "the detail to scroll", (f) => detailPaneText(f) !== detailTop);
				const detailBefore = detailPaneText(setup.captureCharFrame());
				expect(detailBefore).not.toBe(detailTop);
				await openGuide(setup, "?");
				await closeOverlay(setup, "Key guide", "the guide to close");
				frame = await settle(setup);
				expect(detailFocused(frame)).toBe(true);
				expect(detailPaneText(frame)).toBe(detailBefore);
				setup.resize(WIDTH, HEIGHT);
				await settle(setup);

				// The override panel's row and typed text. The detail kept the
				// focus through the guide, so the list takes it back first. The
				// selection sits on the handed-off ticket, which refuses an
				// override: back to the open one.
				await focusList(setup);
				await press(setup, "k", "the open ticket", (f) => markerRowOf(f) === 2);
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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
					(f) => actionBarRowOf(f).includes("2-20/36"),
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
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
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS, home, configPath },
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
				expect(bar).toContain("1-19/36");
				expect(bar).toContain("Esc/F1/? Close");
				expect(bar).not.toContain("Help");
				expect(bar).not.toContain("Message");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("shrinks with the terminal and keeps its scroll", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openGuide(setup, "?");
				expect(actionBarRowOf(await settle(setup))).toContain("1-19/36");

				// A short, wide terminal: four visible rows, the full title
				// still fitting, and more total rows because the reason column is
				// narrower and flows onto more lines. The surface gives its last
				// two rows to its Message line and Action bar.
				setup.resize(60, 12);
				let frame = await settle(setup);
				expect(frame).toContain("Key guide - Ticket list");
				expect(actionBarRowOf(frame)).toContain("1-4/48");

				await scrollGuide(setup, "j", "2-5/48");
				// Back to size: the scroll the terminal gave back is kept.
				setup.resize(WIDTH, HEIGHT);
				frame = await settle(setup);
				expect(actionBarRowOf(frame)).toContain("2-20/36");

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
				expect(actionBarRowOf(frame)).toContain("2-20/36");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});
});
