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

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { widthOf } from "../src/components/text.ts";
import type { FactoryConfig } from "../src/config.ts";
import { baseChoice } from "../src/handoff.ts";
import type { Setup } from "./app-harness.ts";
import {
	actionBarRowOf,
	detailFocused,
	frameUntil,
	guideKey,
	HEIGHT,
	markerRowOf,
	messageRowOf,
	mouseClick,
	pressControl,
	quitApp,
	rgb,
	roleColor,
	rowsOf,
	settle,
	spanColorAt,
	stillFrame,
	typeText,
	WIDTH,
	waitFor,
	withApp,
} from "./app-harness.ts";
import { fetchSuccess, issueTicket, ticketOf } from "./fact-fixtures.ts";
import { agentListJson, FakeRunner } from "./fake-runner.ts";
import type { FakeSource } from "./fake-source.ts";
import { issuesConfig, issuesSourceConfig, plane, wrappedState } from "./plane.ts";

/** Stub the git answers for a healthy convention checkout under the home. */
function stubCheckout(runner: FakeRunner, home: string): void {
	const path = join(home, "src", "billing");
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
}

/** Press a guide scroll key and wait for the new range in the guide's bar. */
async function scrollGuide(setup: Setup, key: "j" | "k", range: string): Promise<string> {
	return guideKey(setup, "guide-scroll", key, { shows: range });
}

/**
 * Step the guide with its scroll key while the frame stays without the
 * target row: a row past the first fold is a walk, and the rig sends every
 * step as a press of the key the guide owns. The row's key column is padded,
 * so the check reads the row with its spacing collapsed, and a walk that
 * finishes its steps without a match lands where the last step landed.
 */
async function stepGuideUntil(
	setup: Setup,
	via: "j" | "k",
	steps: number,
	target: string | ((row: string) => boolean),
): Promise<string> {
	const isThere = typeof target === "string" ? (row: string) => row.includes(target) : target;
	let frame = await settle(setup);
	for (let step = 0; step < steps; step += 1) {
		frame = await guideKey(setup, "guide-scroll", via, { quiet: true });
		if (rowsOf(frame).some(isThere)) break;
	}
	return frame;
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

/** The windows one guide walk shows, from the top to the real bottom. */
async function guideWindows(
	width: number,
	frame: string,
	rangeOf: (frame: string) => { top: number; end: number; total: number } | undefined,
	stepDown: (from: { top: number; end: number; total: number }) => Promise<string>,
): Promise<string[]> {
	const windows: string[] = [];
	for (;;) {
		windows.push(
			rowsOf(frame)
				.map((row) => contentOf(row).replace(/\s+/g, ""))
				.join(""),
		);
		const range = rangeOf(frame);
		if (range === undefined) throw new Error(`the guide's bar holds no range at ${width} columns`);
		// One step down; the bottom window holds the last rows,
		// so the range holds on the next step and the walk ends
		// instead of spinning on the last row.
		if (range.top > range.total - (range.end - range.top + 1)) break;
		frame = await stepDown(range);
	}
	return windows;
}

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
		frame = await guideKey(setup, "guide-scroll", "k", { quiet: true });
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
		frame = await guideKey(setup, "guide-scroll", "j", { quiet: true });
		const after = guideRangeOf(frame);
		if (before === undefined || after === undefined || after.top <= before.top) break;
	}
	return seen;
}

describe("the in-app Key guide", () => {
	test("does not open by itself; ? and F1 open and close it from the Ticket list", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				expect(await settle(setup)).not.toContain("Key guide");

				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				expect(setup.captureCharFrame()).toContain("Key guide - Ticket list");
				await pressControl(setup, "guide-close", { closes: "Key guide" });

				// The bar's Help hint names ? alone in the base modes, so F1
				// rides the alias the guide names for the control.
				await guideKey(setup, "help", "F1", { opens: "Key guide" });
				expect(setup.captureCharFrame()).toContain("Key guide - Ticket list");
				await pressControl(setup, "guide-close", { via: "F1", closes: "Key guide" });
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("names the mode it was opened from, in every mode", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				// The handoff and the override stand on actionable Tickets, so
				// the boot fetch settles first.
				planeRecord.settleFirstFetch();
				// Ticket list.
				await pressControl(setup, "help", { via: "?", opens: "Key guide - Ticket list" });
				await pressControl(setup, "guide-close", { closes: "Key guide - Ticket list" });
				// Ticket detail.
				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				await pressControl(setup, "help", { via: "?", opens: "Key guide - Ticket detail" });
				await pressControl(setup, "guide-close", { closes: "Key guide - Ticket detail" });
				// Override list row: the override stands on an open ticket, so
				// walk the selection down from the awaiting one that boots.
				await pressControl(setup, "tickets", { via: "h", moved: "tickets" });
				await pressControl(setup, "move-list", { via: "j", moved: "Migrate scheduler" });
				await pressControl(setup, "move-list", { via: "j", moved: "Fix pan drift" });
				await pressControl(setup, "move-list", { via: "j", moved: "Retry policy" });
				await pressControl(setup, "override", { opens: "Override" });
				// The override panel's bar names F1 for Help, ? for no reason:
				// the panel's ? is a printable character for its text row, so the
				// bar keeps the F1 alias.
				await pressControl(setup, "help", { via: "F1", opens: "Key guide - Override list row" });
				await pressControl(setup, "guide-close", { closes: "Key guide - Override list row" });
				// Override text row.
				await pressControl(setup, "move-list", { via: "j", moved: "Environment" });
				await pressControl(setup, "move-list", { via: "j", moved: "Task type" });
				await pressControl(setup, "move-list", { via: "j", moved: "Model" });
				await pressControl(setup, "help", { via: "F1", opens: "Key guide - Override text row" });
				await pressControl(setup, "guide-close", {
					via: "F1",
					closes: "Key guide - Override text row",
				});
				// The bar keeps the e Override hint forever, so the panel's box
				// title is the close signal.
				await pressControl(setup, "cancel", { closes: "Override" });
				// Decision modal: walk back up to the awaiting ticket. The list
				// truncates titles, so the checks use short stable prefixes.
				await pressControl(setup, "move-list", { via: "k", moved: "Fix pan drift" });
				await pressControl(setup, "move-list", { via: "k", moved: "Migrate scheduler" });
				await pressControl(setup, "move-list", { via: "k", moved: "Drop the legacy" });
				await pressControl(setup, "decide-completion", { opens: "Decision:" });
				await pressControl(setup, "help", { via: "?", opens: "Key guide - Decision modal" });
				await pressControl(setup, "guide-close", { closes: "Key guide - Decision modal" });
				// The panel survived the guide.
				expect(setup.captureCharFrame()).toContain("Decision:");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);

		// Missing modal: an in-flight Ticket whose pane herdr no longer
		// lists. The guide names the missing mode and holds its own
		// controls in the current section, not the decision modal's.
		{
			// The recorded pane is a dead Agent, not a booting one: the clock
			// sits past the startup grace, so the row reads missing at once.
			const state = wrappedState("none", () => Date.now() - 60_000);
			try {
				const missingRunner = new FakeRunner();
				missingRunner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
				const sourceDef = { name: "issues", kind: "github-issues" };
				state.sourceFact.initializeSources([sourceDef]);
				state.sourceFact.applyFetch(sourceDef, fetchSuccess([issueTicket()]));
				const claim = state.handoff.claimHandoff(
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
				state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
				});
				const planeRecord = await plane({
					existing: state,
					sources: [{ config: issuesSourceConfig, tickets: [ticketOf(issueTicket())] }],
					config: issuesConfig,
					settledReads: false,
					runner: () => missingRunner,
				});

				await withApp(
					async (setup) => {
						(planeRecord.sources[0] as FakeSource).settle(fetchSuccess([issueTicket()]));
						await frameUntil(setup, "the missing badge", (f) =>
							rowsOf(f)[markerRowOf(f)].includes("missing"),
						);
						await pressControl(setup, "live-view", { opens: "Missing:" });
						const rows = rowsOf(
							await pressControl(setup, "help", { via: "?", opens: "Key guide - Missing modal" }),
						);
						const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));
						const between = (top: number, bottom: number) =>
							rows.slice(top + 1, bottom).map(contentOf);
						expect(
							between(indexOf("Current interaction mode"), indexOf("Global controls")),
						).toEqual([
							"F1/? Help",
							"F2 Message - no message has been recorded yet",
							"↑↓ Select action",
							"j/k Scroll message",
							"Enter Confirm action",
							"Esc Cancel",
						]);
						await pressControl(setup, "guide-close", { closes: "Key guide - Missing modal" });
						// The panel survived the guide.
						expect(setup.captureCharFrame()).toContain("Missing:");
					},
					{
						width: WIDTH,
						height: HEIGHT,
						plane: planeRecord,
						loopPolicy: { kind: "polled", intervalMs: 60_000 },
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
		const state = wrappedState();
		try {
			// One waiting start: the guide reads the queue cursor through it.
			const enqueued = state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_5",
				origin: "open",
				choice: baseChoice("pi", "live-worktree", "implement"),
				previousMessage: "",
			});
			if (!enqueued.ok) throw new Error(enqueued.reason);
			const runner = new FakeRunner();
			const tickets = [issueTicket()];
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
			const planeRecord = await plane({
				existing: state,
				sources: [{ config: issuesSourceConfig, tickets: [] }],
				config: zeroSeatConfig,
				settledReads: false,
				runner: () => runner,
			});
			await withApp(
				async (setup) => {
					(planeRecord.sources[0] as FakeSource).settle(fetchSuccess(tickets));
					// The Work header stands with its count; it starts expanded (ADR 0049).
					// Wait for the source's title to reach the queue row as well: the
					// row holds the raw ticket identity until the first source poll.
					const header = await frameUntil(
						setup,
						"the Work header",
						(f) =>
							f.includes("▾ Work") &&
							f.includes("waiting: 1") &&
							f.includes("Add a webhook retry policy"),
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
								(row) => row.includes("implement") && row.includes("Add a webhook retry policy"),
							) +
						workHeaderRow +
						1;
					await mouseClick(setup, 2, workRow);
					const list = await frameUntil(
						setup,
						"the Work queue item row",
						(f) => f.includes("▾ Work") && f.includes("Add a webhook retry policy 1"),
					);
					expect(list).toMatch(/implement\s+Add a webhook retry policy/);

					// The list-mode guide holds the queue's keys and none of the
					// Ticket section's: the reorder pair and the cancel stand in the
					// current mode, and no Hand off or Decide row reaches it.
					const listGuide = rowsOf(
						await pressControl(setup, "help", { via: "?", opens: "Key guide - Work queue list" }),
					);
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
					// The queue's removal dispatches in the queue mode itself now
					// (ADR 0122): the row names the key, and its note states what
					// the removal does. The note may flow onto its continuation row
					// at this width, so the check reads the joined rows.
					expect(listCurrent.some((row) => row.startsWith("Delete Remove"))).toBe(true);
					expect(listCurrent.join(" ")).toContain(
						"takes the row's waiting item out of the Work queue: the Ticket stays open, and the Consultation record becomes unscheduled",
					);
					// The plane-level keys left the mode's own rows: the brake and
					// the mode stand in the Control plane group, the catalogue's own
					// order, in every mode they dispatch in (issue #319, ADR 0111). The
					// group stands below the opening window here, so the walk reads
					// it.
					const listAll = await allGuideRows(setup);
					const listPlane = listAll.slice(
						listAll.indexOf("Control plane controls") + 1,
						listAll.indexOf("Other interaction modes"),
					);
					expect(listPlane.some((row) => row.startsWith("p Pause queue"))).toBe(true);
					expect(listPlane).toContain("a Toggle auto-handoff");
					expect(listCurrent.some((row) => row.startsWith("p Pause queue"))).toBe(false);
					expect(listCurrent.some((row) => row.startsWith("a Toggle"))).toBe(false);
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
					// The Consultation section's record removal and `f History` run on
					// the shared base modes, so they reach a queue mode as keys the
					// queue can never dispatch. Each section's guide names only the
					// keys it owns (issue #85, ADR 0034): the queue's own keys stand -
					// its own removal among them - and the other section's rows stay
					// out (ADR 0122).
					expect(
						listCurrent.some((row) => row.includes("removes a closed or unscheduled record")),
					).toBe(false);
					expect(listCurrent.some((row) => row.startsWith("f History"))).toBe(false);
					await pressControl(setup, "guide-close", { closes: "Key guide - Work queue list" });

					// The detail-mode guide: the queue's scroll carries its own
					// reason, the pane return is named for the queue, and the
					// list-mode keys (reorder, cancel) leave this mode's section.
					await guideKey(setup, "detail", "l", { quiet: true });
					const detailGuide = rowsOf(
						await pressControl(setup, "help", {
							via: "?",
							opens: "Key guide - Work queue detail",
						}),
					);
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
					// The queue's removal left its list scope (ADR 0122): it is
					// dispatched in every base mode, so the detail pane's guide names
					// it with the item under the cursor.
					expect(detailCurrent.some((row) => row.startsWith("Delete Remove"))).toBe(true);
					expect(detailCurrent.some((row) => row.includes("Force-dispatch"))).toBe(false);
					// The detail pane holds no queue key of its own for `f`, and the
					// Consultation section's record removal reaches the detail pane
					// only as a refusal: the row that would name the key the mode
					// cannot dispatch is the leak issue #85 closed for the Ticket
					// section, closed here for the queue (ADR 0122).
					expect(
						detailCurrent.some((row) => row.includes("removes a closed or unscheduled record")),
					).toBe(false);
					expect(detailCurrent.some((row) => row.startsWith("f History"))).toBe(false);
					await pressControl(setup, "guide-close", { closes: "Key guide - Work queue detail" });
				},
				{
					width: WIDTH,
					height: 34,
					plane: planeRecord,
					loopPolicy: { kind: "production" },
				},
			);
		} finally {
			state.close();
		}
	});

	test("lists the sections in order, with every control once and all valid aliases", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
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
				// too, so the guide never reorders what the bar shows. Both rows
				// sit below the opening window, so the walk below is what reads
				// them; the check stands here as the reason they are looked for.

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
				const ladder = Array.from({ length: 49 }, (_, step) => step + 2).map(
					(row) => `${row}-${row + 18}/68`,
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
				// this mode's reasons on the unavailable ones. The Grouping axis,
				// the Group fold - `Space` since the key split (issue #170) - and
				// the Group's order keys join it (issue #159, ADR 0071): the axis
				// names its whole cycle in the note, and the fold and the moves
				// state the reason a cursor on a Ticket row gives them.
				const globalStart = shown.indexOf("Global controls");
				expect(shown.slice(currentStart + 1, globalStart)).toEqual([
					"↑↓/jk Move",
					"→/l Detail",
					"Enter Queue item - the selected row has no waiting queue item",
					"Enter Hand off - only an open Ticket can be handed off",
					"Enter Live view - only an in-flight Ticket has a Live view",
					"Enter Decide - opens the decision on a settled Ticket",
					"g Goto",
					// The Delete key's Close sits beside Goto: the key that ends the
					// work cycle, available here because the awaiting Ticket's cycle
					// stands settled (ADR 0031, ADR 0122).
					"Delete Close",
					// The ignore and the List filter name the Ticket section's own
					// two keys (ADR 0060); the section's guide holds them and the
					// Consultation section's guide holds nothing of either.
					"i Ignore - the selected Ticket cannot be ignored: it awaits a decision",
					// The init's select list names its own key (ADR 0082): the
					// bootstrap path for a repository with no ticket and no source.
					"o Select repository",
					// The mute joins the Ticket section's own keys (ADR 0070), beside
					// the ignore and ahead of the filter it rides with in the cycle.
					"u Mute - mutes the source the Ticket came in on, and the key un-mutes",
					"f Filter - cycles the Ticket list: active, ignored, muted, all",
					// The axis row wraps: its note names the whole cycle, and the
					// label column is sized to the longest reason.
					"Tab Group - cycles the grouping axis: none, repository, source, task,",
					"state, position",
					"Space Fold - no Group header is under the cursor",
					"+ Move group up - no Group header is under the cursor",
					"- Move group down - no Group header is under the cursor",
					"x Section - collapses the section the cursor is in, or expands it back",
					// The queue's removal answers the Delete key in the Ticket section
					// too (ADR 0122): it takes the row the cursor's Ticket waits with,
					// and here it refuses with the awaiting Ticket's own fact.
					"Delete Remove - the selected Ticket is not open: Delete closes its work cycle",
					// The reason is the longest in the guide: the label column
					// is sized to its content, and what still does not fit
					// flows onto its own continuation row rather than being
					// cut.
					"c Launch - no Consultation types configured; add",
					"[consultation-types.<name>] to the config file",
					// The override refuses on the awaiting Ticket with the path the
					// catalog names: the decision first, the edit behind it. The
					// reason wraps on this width, the way the axis note does.
					"e Override - awaiting ticket: press Enter, then e on a Handoff row to edit",
					"its settings",
					"r Refresh - every Ticket source is already refreshing",
					"F1/? Help",
					"m/F2 Message - no message has been recorded yet",
				]);
				expect(globalStart).toBeGreaterThan(0);
				// The two multi-alias rows the walk collected, in catalogue order.
				expect(shown.some((row) => row.startsWith("F1/? Help"))).toBe(true);
				expect(shown.some((row) => row.startsWith("m/F2 Message"))).toBe(true);
				const planeStart = shown.indexOf("Control plane controls");
				expect(planeStart).toBeGreaterThan(globalStart);
				// The Global section is exactly two rows.
				expect(shown.slice(globalStart + 1, planeStart)).toEqual([
					"q Quit",
					"Ctrl+C Emergency exit - may require Handoff recovery on the next start",
				]);
				const otherStart = shown.indexOf("Other interaction modes");
				expect(otherStart).toBeGreaterThan(planeStart);
				// The Consultation section's Delete acts stay cataloged in the
				// Consultation section alone (ADR 0122): the Ticket guide omits its
				// Close and the record removal, and the Delete key refuses in this
				// section with the section's own words. Recovery leads the Enter
				// rows: a live record resolves past it to Respond and Interact, and
				// a broken or stuck one reads it as the meaning Enter takes here
				// (ADR 0038).
				expect(shown.slice(planeStart + 1, otherStart)).toEqual([
					// The init's select list states its own keys beside the plane's
					// other contextual acts (ADR 0082, ADR 0083).
					"Enter Select",
					"Tab Toggle - marks the row under the cursor for the queue, and unmarks it",
					"Del Clear search",
					"Esc Cancel",
					// The Queue pause's key left the Work queue: it stands in the
					// plane group in every mode it dispatches in, beside the
					// Auto-handoff mode's key (issue #319, ADR 0111).
					"p Pause queue - pauses the queue's drain; the force-dispatch passes it",
					"Enter Recovery - opens the recovery surface a broken or stuck Consultation needs",
					"Enter Respond",
					"Enter Interact",
					// Goto is cataloged behind Interact: navigation between the
					// Consultation and the Agent's pane, ADR 0025. The current section's
					// own Goto stands reason-free on the awaiting Ticket, so the
					// walk's dedup read it once there, the way the "Esc Cancel" note
					// below reads the override's cancel once.
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
					// The override's "Esc Cancel" is the same written row as the
					// select list's cancel, and the walk above read it once in the
					// Control plane section (ADR 0082).
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
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
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
			const planeRecord = await plane({ runner: () => runner });
			await withApp(
				async (setup) => {
					setup.resize(width, height);
					await pressControl(setup, "help", { via: "?", opens: "Key guide" });
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
						await guideKey(setup, "guide-scroll", "j", { quiet: true });
						return frameUntil(setup, `the guide range to advance to ${from.top + 1}`, (f) => {
							const range = rangeOf(f);
							return (
								range !== undefined && range.top === from.top + 1 && range.total === from.total
							);
						});
					};
					// Walk the whole list once from the top, the place the guide
					// opens at: a reason can sit below the fold, so every window
					// the walk shows is read. The cells of each window, not its
					// lines, are compared: a narrow guide breaks a long word
					// across rows, and every cell of a reason must still be there.
					const frame = await settle(setup);
					const windows = await guideWindows(width, frame, rangeOf, stepDown);
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
					await pressControl(setup, "guide-close", { closes: "Key guide" });
				},
				{
					width: width,
					height: height,
					plane: planeRecord,
					loopPolicy: { kind: "held" },
				},
			);
		});
	}

	test("catalogs the three meanings of Enter, and runs only one", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				const rowOf = (rows: string[], needle: string) =>
					rows.find((row) => norm(row).includes(needle)) ?? "";

				// Walk to the open Ticket: the selection boots on the awaiting
				// one, and the first part reads the open Ticket's meanings.
				await pressControl(setup, "move-list", { via: "j", moved: "Migrate scheduler" });
				await pressControl(setup, "move-list", { via: "j", moved: "Fix pan drift" });
				await pressControl(setup, "move-list", { via: "j", moved: "Retry policy" });

				// The selected Ticket is open, so Enter hands it off. The bar
				// names that meaning alone: a hint whose key runs the other one
				// would point at the wrong control. The guide still lists Live view
				// and Decide and says why this Ticket cannot use them (user
				// stories 12, 16).
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
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
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				let bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Hand off");
				expect(bar).not.toContain("Live view");
				expect(bar).not.toContain("Decide");

				// The awaiting Ticket is settled, so Enter decides it. The guide
				// keeps Hand off in its current section with the settled fact, so
				// the operator reading the catalog is never asked to guess what
				// Enter does there.
				await pressControl(setup, "move-list", { via: "k", moved: "Fix pan drift" });
				await pressControl(setup, "move-list", { via: "k", moved: "Migrate scheduler" });
				await pressControl(setup, "move-list", { via: "k", moved: "Drop the legacy" });
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				rows = rowsOf(await settle(setup));
				expect(rowOf(rows, "Enter Hand off")).toContain("only an open Ticket can be handed off");
				expect(rowOf(rows, "Enter Live view")).toContain(
					"only an in-flight Ticket has a Live view",
				);
				expect(rowOf(rows, "Enter Decide")).toContain("opens the decision on a settled Ticket");
				const decideRow = rows.findIndex((r) => norm(r).includes("Enter Decide"));
				expect(spanColorAt(setup, decideRow, "Decide")).toEqual(rgb(roleColor("text")));
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Decide");
				expect(bar).not.toContain("Hand off");
				expect(bar).not.toContain("Live view");

				// The running Ticket answers for one meaning, and the guide says
				// the rest rather than dropping a row: every key carries its own
				// reason or note, and the bar states the one Enter runs.
				await pressControl(setup, "move-list", { via: "j", moved: "Migrate scheduler" });
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
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
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				bar = actionBarRowOf(setup.captureCharFrame());
				expect(bar).toContain("Enter Live view");
				expect(bar).not.toContain("Hand off");
				expect(bar).not.toContain("Decide");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("puts decision-modal controls in the current interaction mode", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				// The selection stands on the awaiting Ticket at boot: the
				// decision opens straight from it.
				await pressControl(setup, "decide-completion", { opens: "Decision:" });
				await pressControl(setup, "help", { via: "?", opens: "Key guide - Decision modal" });
				const rows = rowsOf(await settle(setup));
				const indexOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));
				const between = (top: number, bottom: number) => rows.slice(top + 1, bottom).map(contentOf);

				expect(between(indexOf("Current interaction mode"), indexOf("Global controls"))).toEqual([
					"F1/? Help",
					"F2 Message - no message has been recorded yet",
					"↑↓ Select action",
					"j/k Scroll body",
					"e Edit handoff - the selected action has no settings to edit",
					"Enter Confirm action",
					"Esc Cancel",
				]);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("marks this mode's unavailability on the current rows only, with the recovery note on Emergency exit", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				// The Emergency row and the Other-mode rows sit below the first
				// fold, so the checks walk the whole catalogue.
				const rows = await allGuideRows(setup);
				const rowOf = (needle: string) => rows.find((row) => norm(row).includes(needle)) ?? "";

				// The boot fetch is in flight, so Refresh carries its reason;
				// nothing has been recorded, so the Message row carries its own.
				expect(rowOf("r Refresh")).toContain("every Ticket source is already refreshing");
				expect(rowOf("m/F2 Message")).toContain("no message has been recorded yet");

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
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("paints availability on the guide rows", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				let rows = rowsOf(await settle(setup));
				const rowOf = (needle: string) => rows.findIndex((row) => norm(row).includes(needle));

				// Available: the key wears the focus color, the label the text
				// color.
				const moveRow = rowOf("Move");
				expect(spanColorAt(setup, moveRow, "↑↓/jk")).toEqual(rgb(roleColor("accent")));
				expect(spanColorAt(setup, moveRow, "Move")).toEqual(rgb(roleColor("text")));
				// The mute and the move rows pushed Refresh below the opening
				// window: step the guide down until its row is on screen, then
				// read it.
				rows = rowsOf(
					await stepGuideUntil(setup, "j", 12, (row) => norm(row).includes("r Refresh")),
				);
				// Unavailable: the key and the label are dim, the reason dim.
				const refreshRow = rowOf("r Refresh");
				expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(roleColor("subtext0")));
				expect(spanColorAt(setup, refreshRow, "Refresh")).toEqual(rgb(roleColor("subtext0")));
				expect(spanColorAt(setup, refreshRow, "every Ticket source is already refreshing")).toEqual(
					rgb(roleColor("subtext0")),
				);

				// The Global section sits below the first fold: step the guide
				// down until its rows can be color-checked.
				rows = rowsOf(await stepGuideUntil(setup, "j", 20, "Emergency exit"));
				// Emergency exit is available: the recovery note does not dim
				// the key.
				const exitRow = rowOf("Ctrl+C");
				expect(spanColorAt(setup, exitRow, "Ctrl+C")).toEqual(rgb(roleColor("accent")));
				expect(spanColorAt(setup, exitRow, "Emergency exit")).toEqual(rgb(roleColor("text")));
				// Group headers wear the bright text color.
				const groupRow = rowOf("Global controls");
				expect(spanColorAt(setup, groupRow, "Global controls")).toEqual(rgb(roleColor("text")));
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("updates availability live while open", async () => {
		const state = wrappedState();
		try {
			const planeRecord = await plane({
				existing: state,
				sources: [{ config: issuesSourceConfig, tickets: [] }],
				config: issuesConfig,
				settledReads: false,
			});
			await withApp(
				async (setup) => {
					// While the first fetch runs, every source is refreshing:
					// the current Refresh row carries the reason, dim.
					await waitFor(setup, { shows: "loading tickets..." });
					await pressControl(setup, "help", { via: "?", opens: "Key guide" });
					// The queue's removal row beside the section toggle and the
					// mute and the move rows push Refresh below the opening window
					// (ADR 0122): step the guide down until its row is on screen.
					let rows = rowsOf(
						await stepGuideUntil(setup, "j", 5, (row) => norm(row).includes("r Refresh")),
					);
					let refreshRow = rows.findIndex((row) => norm(row).includes("r Refresh"));
					expect(rows[refreshRow]).toContain("every Ticket source is already refreshing");
					expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(roleColor("subtext0")));

					// The fetch settles while the guide is open: the reason
					// leaves and the key takes the focus color, live.
					(planeRecord.sources[0] as FakeSource).settle(fetchSuccess([issueTicket()]));
					await frameUntil(
						setup,
						"the refresh row to clear",
						(f) =>
							!rowsOf(f)
								.map(norm)
								.find((row) => row.includes("r Refresh"))
								?.includes("already refreshing"),
					);
					rows = rowsOf(await settle(setup));
					refreshRow = rows.findIndex((row) => norm(row).includes("r Refresh"));
					expect(rows[refreshRow]).not.toContain(" - ");
					expect(spanColorAt(setup, refreshRow, "r")).toEqual(rgb(roleColor("accent")));
					// The current section follows the state too: the fetched open
					// Ticket is selected, so Hand off loses its reason as well.
					// The queue's removal row now stands below the section toggle
					// (ADR 0122), so one step back reads Hand off beside the
					// refresh's own row.
					rows = rowsOf(await guideKey(setup, "guide-scroll", "k", { quiet: true }));
					expect(rows.find((row) => norm(row).includes("Enter Hand off"))).not.toContain(
						"no Ticket is selected",
					);
				},
				{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
			);
		} finally {
			state.close();
		}
	});

	test("scrolls with a range and no-ops at the boundaries", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				expect(actionBarRowOf(await settle(setup))).toContain("1-19/68");

				await scrollGuide(setup, "j", "2-20/68");
				await scrollGuide(setup, "j", "3-21/68");
				await scrollGuide(setup, "k", "2-20/68");
				await scrollGuide(setup, "k", "1-19/68");
				// Top boundary: k holds the range.
				await guideKey(setup, "guide-scroll", "k", { quiet: true });
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("1-19/68");
				// Walk to the bottom, one step per frame.
				const ladder = Array.from({ length: 49 }, (_, step) => step + 2).map(
					(row) => `${row}-${row + 18}/68`,
				);
				for (const range of ladder) await scrollGuide(setup, "j", range);
				// Bottom boundary: j holds the range.
				await guideKey(setup, "guide-scroll", "j", { quiet: true });
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("50-68/68");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("restores the exact base state on close", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				// The override stands on an actionable Ticket, so the boot
				// fetch settles first.
				planeRecord.settleFirstFetch();
				// The selection.
				await pressControl(setup, "move-list", { via: "j", moved: "Migrate scheduler" });
				const selectedBefore = rowsOf(setup.captureCharFrame())[
					markerRowOf(setup.captureCharFrame())
				];
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				let frame = await settle(setup);
				expect(stillFrame(rowsOf(frame)[markerRowOf(frame)])).toBe(stillFrame(selectedBefore));

				// The detail focus and scroll, at the new three-section floor
				// (ADR 0049 raised it to 27) on a narrow terminal where the detail
				// pane overflows: the narrow width wraps the description past the
				// pane's rows. The list keeps the focus through the resize, and the
				// probe reads the pane's raw column, so a scroll that only swaps a
				// blank padding row still shows.
				await pressControl(setup, "detail", { via: "l", moved: "detail" });
				setup.resize(60, 27);
				await settle(setup);
				await guideKey(setup, "detail", "l", { quiet: true });
				const detailCol = (f: string): string =>
					rowsOf(f)
						.map((row) => row.slice(32, 58))
						.join("\n");
				const detailTop = detailCol(setup.captureCharFrame());
				await pressControl(setup, "scroll-detail", { via: "j", quiet: true });
				const detailBefore = detailCol(setup.captureCharFrame());
				expect(stillFrame(detailBefore)).not.toBe(stillFrame(detailTop));
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				frame = await settle(setup);
				expect(detailFocused(frame)).toBe(true);
				expect(stillFrame(detailCol(frame))).toBe(stillFrame(detailBefore));
				setup.resize(WIDTH, HEIGHT);
				await settle(setup);

				// The override panel's row and typed text. The detail kept the
				// focus through the guide, so the list takes it back first. The
				// selection sits on the running ticket, which refuses an
				// override: walk to the open one.
				await pressControl(setup, "tickets", { via: "h", moved: "tickets" });
				await pressControl(setup, "move-list", { via: "j", moved: "Fix pan drift" });
				await pressControl(setup, "move-list", { via: "j", moved: "Retry policy" });
				await pressControl(setup, "override", { opens: "Override" });
				await pressControl(setup, "move-list", { via: "j", moved: "Environment" });
				await pressControl(setup, "move-list", { via: "j", moved: "Task type" });
				await pressControl(setup, "move-list", { via: "j", moved: "Model" });
				await typeText(setup, "a");
				expect(modelValueOf(await waitFor(setup, { quiet: true }))).toBe("a");
				await typeText(setup, "b");
				expect(modelValueOf(await waitFor(setup, { quiet: true }))).toBe("ab");
				await pressControl(setup, "help", { via: "F1", opens: "Key guide - Override text row" });
				await pressControl(setup, "guide-close", {
					via: "?",
					closes: "Key guide - Override text row",
				});
				frame = await settle(setup);
				expect(modelValueOf(frame)).toBe("ab");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("closes on Esc, F1, and ?", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				await pressControl(setup, "guide-close", { via: "F1", closes: "Key guide" });

				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				await pressControl(setup, "guide-close", { via: "?", closes: "Key guide" });
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("ignores the base keys while open", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				const before = await settle(setup);
				const markerBefore = markerRowOf(before);

				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				// j scrolls the guide, not the list.
				await guideKey(setup, "guide-scroll", "j", { shows: "2-20/68" });
				// e opens no panel, r warns no refresh, q quits nothing,
				// Enter starts no handoff. The guide stays the owner of the
				// keys through all of it: the rig sends every key as a press of
				// the control it names, through the guide's own catalog rows.
				await guideKey(setup, "override", "e", { quiet: true });
				await guideKey(setup, "refresh", "r", { quiet: true });
				await quitApp(setup, { quiet: true });
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				await settle(setup);
				expect(setup.captureCharFrame()).toContain("Key guide");

				// The base is exactly where it was. While the guide is open the
				// base is behind the overlay, so the checks run on close.
				await pressControl(setup, "guide-close", { closes: "Key guide" });
				const frame = await settle(setup);
				expect(frame).not.toContain("❯ Agent");
				expect(markerRowOf(frame)).toBe(markerBefore);
				expect(messageRowOf(frame).trim()).toBe("");
				expect(actionBarRowOf(frame)).toBe(actionBarRowOf(before));
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("types ? and q into the override text row, and F1 opens the guide there", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				// The override stands on an actionable open ticket: the boot
				// fetch settles, and the selection walks down from the awaiting
				// one that boots.
				planeRecord.settleFirstFetch();
				await pressControl(setup, "move-list", { via: "j", moved: "Migrate scheduler" });
				await pressControl(setup, "move-list", { via: "j", moved: "Fix pan drift" });
				await pressControl(setup, "move-list", { via: "j", moved: "Retry policy" });
				await pressControl(setup, "override", { opens: "Override" });
				await pressControl(setup, "move-list", { via: "j", moved: "Environment" });
				await pressControl(setup, "move-list", { via: "j", moved: "Task type" });
				await pressControl(setup, "move-list", { via: "j", moved: "Model" });
				// ? is a printable character here: it types, it does not help.
				await typeText(setup, "?");
				expect(modelValueOf(await waitFor(setup, { quiet: true }))).toBe("?");
				// q is printable here too: it types, it does not quit.
				await typeText(setup, "q");
				expect(modelValueOf(await waitFor(setup, { quiet: true }))).toBe("?q");
				expect(setup.captureCharFrame()).not.toContain("Key guide");
				// F1 is the help alias in the text row.
				await pressControl(setup, "help", { via: "F1", opens: "Key guide - Override text row" });
				// ? closes the guide from any mode. The typed characters stay.
				await pressControl(setup, "guide-close", {
					via: "?",
					closes: "Key guide - Override text row",
				});
				const frame = await settle(setup);
				expect(modelValueOf(frame)).toBe("?q");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("excludes the Message view while one is open: F2 goes, F1 returns", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({
			runner: () => runner,
			repos: { "github.com/acme/billing": "src/billing" },
			// The standing holds two seats (the starting and the running
			// tickets); the test wants the attempt to run, so a seat stands
			// free.
			config: { maxParallelAgents: 3 },
		});
		stubCheckout(runner, planeRecord.home);
		runner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: `error: the daemon refused the request after the outage. ${"x".repeat(240)}\n`,
		});
		await withApp(
			async (setup) => {
				// The handoff attempt stands on an actionable open ticket, so
				// the boot fetch settles, and the selection walks to an open
				// one from the awaiting ticket that boots.
				planeRecord.settleFirstFetch();
				await pressControl(setup, "move-list", { via: "j", moved: "Migrate scheduler" });
				await pressControl(setup, "move-list", { via: "j", moved: "Fix pan drift" });
				await pressControl(setup, "move-list", { via: "j", moved: "Retry policy" });
				// The attempt rides the queue and fails on the refused daemon:
				// the truncated warning stands on the Message line, and the bar
				// offers m Message.
				await pressControl(setup, "handoff", { shows: "was not run: error: the daemon refused" });
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("m Message");

				// The guide over the error: the Message row loses its reason,
				// and F2 hands the keys to the Message view. The guide's own
				// bar names no Message hint, so F2 rides the guide row the
				// catalogue paints for it.
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				const guideFrame = await settle(setup);
				expect(guideFrame).not.toContain("no message has been recorded yet");
				expect(actionBarRowOf(guideFrame)).toContain("F2 Message");
				const viewFrame = await guideKey(setup, "message", "F2", { opens: "Message view" });
				expect(viewFrame).not.toContain("Key guide");
				expect(viewFrame).toContain("the daemon refused the request");

				// F1 hands the keys back to the guide, over the same mode. The
				// view's bar names no Help hint either, so F1 rides the guide's
				// row again.
				const backFrame = await guideKey(setup, "help", "F1", { opens: "Key guide - Ticket list" });
				expect(backFrame).not.toContain("Message view");

				// Closing both leaves the error on the Message line.
				await pressControl(setup, "guide-close", { closes: "Key guide - Ticket list" });
				const closed = await settle(setup);
				expect(messageRowOf(closed)).toContain("the daemon refused the request");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("shows only reachable hints in its Action bar", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				// The message fits: the bar names Scroll and Close only. F1
				// and ? close the guide here, so a Help hint would lie.
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				const bar = actionBarRowOf(await settle(setup));
				expect(bar).toContain("↑↓/jk Scroll");
				expect(bar).toContain("1-19/68");
				expect(bar).toContain("Esc/F1/? Close");
				expect(bar).not.toContain("Help");
				expect(bar).not.toContain("Message");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});

	test("shrinks with the terminal and keeps its scroll", async () => {
		const runner = new FakeRunner();
		const planeRecord = await plane({ runner: () => runner });
		await withApp(
			async (setup) => {
				await pressControl(setup, "help", { via: "?", opens: "Key guide" });
				expect(actionBarRowOf(await settle(setup))).toContain("1-19/68");

				// A short, wide terminal: four visible rows, the full title
				// still fitting, and more total rows because the reason column is
				// narrower and flows onto more lines. The surface gives its last
				// two rows to its Message line and Action bar.
				setup.resize(60, 12);
				let frame = await settle(setup);
				expect(frame).toContain("Key guide - Ticket list");
				// The selector's note, the Close reason, the queue removal's
				// reason, the Grouping axis note, and the Recovery note wrap on
				// this narrow terminal, so the guide runs longer than at the full
				// width.
				expect(actionBarRowOf(frame)).toContain("1-4/105");

				await scrollGuide(setup, "j", "2-5/105");
				// Back to size: the scroll the terminal gave back is kept.
				setup.resize(WIDTH, HEIGHT);
				frame = await settle(setup);
				expect(actionBarRowOf(frame)).toContain("2-20/68");

				// Below the useful size the terminal takes its compact frame:
				// the modal caps at the terminal, the title falls back to the
				// bare word beside the brake's lamp, and the bar keeps only the
				// Help key.
				setup.resize(25, 10);
				frame = await settle(setup);
				expect(frame).toContain("┌─Key guide ● running─");
				expect(frame).not.toContain("Key guide - Ticket list");
				for (const row of rowsOf(frame)) expect(widthOf(row)).toBe(25);
				// The utility bar packs the hints that fit; Close is the last
				// standing one at this width.
				expect(actionBarRowOf(frame).trim()).toBe("Esc/F1/? Close");

				// And the way back out.
				setup.resize(WIDTH, HEIGHT);
				frame = await settle(setup);
				expect(frame).toContain("Key guide - Ticket list");
				expect(actionBarRowOf(frame)).toContain("2-20/68");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "held" },
			},
		);
	});
});
