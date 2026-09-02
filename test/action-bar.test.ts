/**
 * The permanent contextual Action bar and the control catalogue's dispatch
 * contract.
 *
 * Every hint the bar shows carries a color that states availability, and
 * pressing an unavailable key explains why on the Message line. Packing
 * removes complete low-priority hints first, and keeps Help to the end.
 * Every displayed alias runs the control it names: the dispatch tests press
 * the real keys the bar shows, including the F keys and Ctrl+C in every
 * interaction mode.
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
import type { Ticket } from "../src/domain/ticket.ts";
import type { AppSetup } from "./app-harness.ts";
import {
	actionBarRowOf,
	awaitFrame,
	detailFocused,
	HEIGHT,
	listFocused,
	markerRowOf,
	messageRowOf,
	openPanel,
	press,
	pressArrow,
	pressCtrlC,
	pressF1,
	pressF2,
	rgb,
	rowsOf,
	settle,
	spanColorAt,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { DelayedRunner } from "./delayed-runner.ts";
import {
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import {
	callsReached,
	cleanupStateFixtures,
	freshState,
	issuesConfig,
	issueTicket,
	RATE_LIMITED,
	success,
} from "./state-fixture.ts";

let home = "";
let configPath = "";

beforeEach(() => {
	home = join(tmpdir(), `factory-bar-${Math.random().toString(36).slice(2)}`);
	configPath = join(home, "factory", "config.toml");
	mkdirSync(join(home, "src", "billing"), { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	cleanupStateFixtures();
});

const checkout = () => join(home, "src", "billing");

/** Stub the git answers for a healthy convention checkout. */
function stubCheckout(runner: FakeRunner): void {
	const path = checkout();
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
}

/** Stub a successful live-worktree handoff at the convention checkout. */
function stubLiveHandoff(runner: FakeRunner): void {
	const path = checkout();
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", path, "--no-focus"], {
		stdout: workspaceCreateJson("ws-1"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", path, "--no-focus"], {
		stdout: tabCreateJson("pane-1"),
	});
}

describe("the contextual Action bar", () => {
	test("shows the base hints with Help right-aligned, and colors availability", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				const frame = await settle(setup);
				const bar = actionBarRowOf(frame);
				for (const hint of [
					"↑↓/jk Move",
					"→/l Detail",
					"Enter Hand off",
					"e Override",
					"r Refresh",
				]) {
					expect(bar).toContain(hint);
				}
				// Help stays discoverable at the right end of the row.
				expect(bar.endsWith("? Help")).toBe(true);
				const barRow = rowsOf(frame).length - 1;
				// Available: the key wears the focus color, the label the text color.
				expect(spanColorAt(setup, barRow, "→/l ")).toEqual(rgb(COLORS.borderFocused));
				expect(spanColorAt(setup, barRow, "Detail")).toEqual(rgb(COLORS.text));
				// Unavailable: the whole hint is dim.
				expect(spanColorAt(setup, barRow, "r Refresh")).toEqual(rgb(COLORS.dim));
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("the detail pane swaps navigation for Scroll and Tickets", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "l", "the detail to take focus", detailFocused);
				const bar = actionBarRowOf(await settle(setup));
				expect(bar).toContain("↑↓/jk Scroll");
				expect(bar).toContain("←/h Tickets");
				expect(bar).toContain("Enter Hand off");
				expect(bar).toContain("e Override");
				expect(bar).toContain("r Refresh");
				expect(bar.endsWith("? Help")).toBe(true);
				// The list's navigation is gone: the bar names this mode's keys.
				expect(bar).not.toContain("Move");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("the override bars show F1 Help, and the text row shows Type and Backspace", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openPanel(setup);
				const listBar = actionBarRowOf(await settle(setup));
				expect(listBar).toContain("↑↓/jk Move");
				expect(listBar).toContain("←→/hl Change");
				expect(listBar).toContain("Enter Hand off");
				expect(listBar).toContain("Esc Cancel");
				expect(listBar).toContain("F1 Help");
				expect(listBar).not.toContain("? Help");

				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the model row", (f) => f.includes("❯ Model"));
				const textBar = actionBarRowOf(await settle(setup));
				expect(textBar).toContain("↑↓ Move");
				expect(textBar).toContain("Type Edit");
				expect(textBar).toContain("Backspace Delete");
				expect(textBar).toContain("Enter Hand off");
				expect(textBar).toContain("Esc Cancel");
				expect(textBar).toContain("F1 Help");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("the override panel reports refused controls", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await openPanel(setup);
				pressF2(setup);
				await settle(setup);
				await press(setup, "escape", "the panel to close", (f) => !f.includes("┌─Override"));
				expect(messageRowOf(await settle(setup))).toContain(
					"Warning: the current Message fits on the Message line",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("the decision panel uses the shared Action bar and reports refused controls", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				// The awaiting Ticket's Enter action opens a decision. It is not a
				// dimmed Hand off control with an unrelated effect.
				await press(setup, "j", "the handed-off ticket", (f) => markerRowOf(f) === 3);
				await press(setup, "j", "the running ticket", (f) => markerRowOf(f) === 4);
				await press(setup, "j", "the awaiting ticket", (f) => markerRowOf(f) === 5);
				const awaitingBar = actionBarRowOf(await settle(setup));
				expect(awaitingBar).toContain("Enter Decide");
				expect(awaitingBar).not.toContain("Hand off");

				await press(setup, "return", "the decision panel", (f) => f.includes("Decision:"));
				const panelFrame = await settle(setup);
				const panelBar = actionBarRowOf(panelFrame);
				for (const hint of [
					"↑↓ Select action",
					"j/k Scroll log",
					"Enter Confirm action",
					"Esc Cancel",
					"F1/? Help",
				]) {
					expect(panelBar).toContain(hint);
				}
				expect(panelFrame).not.toContain("up/down select");

				// F2 is present in the catalogue but unavailable while the Message
				// fits. The panel reports its catalogue reason like the base shell.
				pressF2(setup);
				await settle(setup);
				await press(
					setup,
					"escape",
					"the decision panel to close",
					(f) => !f.includes("Decision:"),
				);
				expect(messageRowOf(await settle(setup))).toContain(
					"Warning: the current Message fits on the Message line",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("narrow widths remove complete low-priority hints, and Help is the last kept", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				// Every step of the packing ladder, with the hints that must
				// survive it. The removal order is the catalogue priority:
				// Refresh, Override, Hand off, Detail, Move, and Help last.
				const ladder: Array<[number, string[]]> = [
					[
						120,
						["↑↓/jk Move", "→/l Detail", "Enter Hand off", "e Override", "r Refresh", "? Help"],
					],
					[65, ["↑↓/jk Move", "→/l Detail", "Enter Hand off", "e Override", "? Help"]],
					[55, ["↑↓/jk Move", "→/l Detail", "Enter Hand off", "? Help"]],
					[45, ["↑↓/jk Move", "→/l Detail", "? Help"]],
					[40, ["↑↓/jk Move", "→/l Detail", "? Help"]],
				];
				for (const [width, kept] of ladder) {
					setup.resize(width, HEIGHT);
					const rows = rowsOf(await settle(setup));
					for (const row of rows) expect(widthOf(row)).toBe(width);
					const bar = rows.at(-1) ?? "";
					for (const hint of kept) expect(bar).toContain(hint);
					expect(bar.trimEnd().endsWith("? Help")).toBe(true);
					for (const gone of ["Detail", "Hand off", "Override", "Refresh"]) {
						if (!kept.some((hint) => hint.includes(gone))) expect(bar).not.toContain(gone);
					}
				}
				// Below the minimum size the compact frame keeps Help, left-aligned.
				for (const width of [39, 30, 10]) {
					setup.resize(width, HEIGHT);
					const rows = rowsOf(await settle(setup));
					for (const row of rows) expect(widthOf(row)).toBe(width);
					expect(rows.at(-1)?.trimEnd()).toBe("? Help");
				}
				// Below the full hint's width, only the key cell of Help remains.
				setup.resize(4, HEIGHT);
				const tinyRows = rowsOf(await settle(setup));
				for (const row of tinyRows) expect(widthOf(row)).toBe(4);
				expect((tinyRows.at(-1) ?? "").trimEnd()).toBe("?");
			},
			120,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("wide Unicode never breaks a row width", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: `error: 无法连接 herdr 守护进程，请检查会话状态。${"重".repeat(80)}\n`,
		});
		const cjk: Ticket = { ...SAMPLE_TICKETS[0], title: "仓库重试策略 🔥 webhook" };
		await withApp(
			async (setup) => {
				await press(setup, "return", "the failure reason to appear", (f) => f.includes("无法连接"));
				// The wide reason wraps the Message line, and the title the panes:
				// every row still ends exactly at the terminal edge.
				for (const row of rowsOf(setup.captureCharFrame())) expect(widthOf(row)).toBe(WIDTH);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: [cjk], home, configPath },
		);
	});

	test("every displayed base alias runs its stated control", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = {
			config: DEFAULT_CONFIG,
			runner,
			initialTickets: SAMPLE_TICKETS,
			home,
			configPath,
		};
		await withApp(
			async (setup) => {
				// Move: j, k, and both arrows.
				await press(setup, "j", "the selection to move on", (f) => markerRowOf(f) === 3);
				await press(setup, "k", "the selection to move back", (f) => markerRowOf(f) === 2);
				await pressArrow(setup, "down", "the selection to move down", (f) => markerRowOf(f) === 3);
				await pressArrow(setup, "up", "the selection to move up", (f) => markerRowOf(f) === 2);
				// Detail: l and right focus it, h and left leave it.
				await press(setup, "l", "the detail to take focus", detailFocused);
				await press(setup, "h", "the list to take focus", listFocused);
				await pressArrow(setup, "right", "the detail to take focus", detailFocused);
				await pressArrow(setup, "left", "the list to take focus", listFocused);
				// Override: e opens the panel, Esc closes it.
				await openPanel(setup);
				expect(await settle(setup)).toContain("❯ Agent");
				await press(setup, "escape", "the panel to close", (f) => !f.includes("❯ Agent"));
				// Help: ? opens the guide, F1 closes it.
				await press(setup, "?", "the key guide to open", (f) => f.includes("Key guide"));
				pressF1(setup);
				await awaitFrame(setup, (f) => !f.includes("Key guide"), "the guide to close");
				// Hand off: Enter starts the handoff, and it settles.
				await press(setup, "return", "the handoff to settle", (f) =>
					(rowsOf(f)[markerRowOf(f)] ?? "").includes("[handed-off]"),
				);
				expect(runner.commands()).toHaveLength(7);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the control-plane aliases a and r run their controls", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					// a toggles auto-handoff on the mode line.
					await press(setup, "a", "auto on", (f) => f.includes("auto: on 0/2"));
					await press(setup, "a", "auto off", (f) => f.includes("auto: off 0/2"));
					// r refreshes the configured source, and the progress clears.
					setup.mockInput.pressKey("r");
					await callsReached(source, 2);
					await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("Working: refreshing"),
						"the refresh progress",
					);
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => messageRowOf(f).trim() === "", "the refresh to clear");
				},
				WIDTH,
				HEIGHT,
				{ config: issuesConfig, state, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("q quits from both base panes, and refuses while a Handoff is active", async () => {
		const props = {
			config: DEFAULT_CONFIG,
			runner: new FakeRunner(),
			initialTickets: SAMPLE_TICKETS,
			home,
			configPath,
		};
		const destroyed = (setup: AppSetup) =>
			awaitFrame(setup, (f) => f.trim() === "", "the renderer to destroy");

		// Ticket list.
		await withApp(
			async (setup) => {
				await settle(setup);
				setup.mockInput.pressKey("q");
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			props,
		);

		// Ticket detail.
		await withApp(
			async (setup) => {
				await press(setup, "l", "the detail to focus", detailFocused);
				setup.mockInput.pressKey("q");
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			props,
		);

		// During an active Handoff: q explains itself instead of quitting.
		const inner = new FakeRunner();
		stubCheckout(inner);
		inner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: "error: the daemon is down\n",
		});
		const runner = new DelayedRunner(inner, 1500);
		await withApp(
			async (setup) => {
				await press(setup, "return", "the handoff working", (f) =>
					messageRowOf(f).startsWith("Working: handing off"),
				);
				await press(setup, "q", "the quit refusal", (f) =>
					messageRowOf(f).includes("normal Quit is unavailable during a Handoff"),
				);
				// The app is still up behind the refusal.
				expect(actionBarRowOf(setup.captureCharFrame())).toContain("? Help");
				// The handoff settles: its outcome replaces the refusal.
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).startsWith("Error: "),
					"the handoff error",
					8000,
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS, home, configPath },
		);

		// On the override list row: q is inert - no panel, no quit.
		await withApp(
			async (setup) => {
				await openPanel(setup);
				setup.mockInput.pressKey("q");
				const frame = await settle(setup);
				expect(frame).toContain("┌─Override");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	}, 20000);

	test("Ctrl+C destroys the renderer from every interaction mode", async () => {
		const props = {
			config: DEFAULT_CONFIG,
			runner: new FakeRunner(),
			initialTickets: SAMPLE_TICKETS,
			home,
			configPath,
		};
		const destroyed = (setup: AppSetup) =>
			awaitFrame(setup, (f) => f.trim() === "", "the renderer to destroy");

		// Ticket list.
		await withApp(
			async (setup) => {
				await settle(setup);
				pressCtrlC(setup);
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			props,
		);
		// Ticket detail.
		await withApp(
			async (setup) => {
				await press(setup, "l", "the detail to focus", detailFocused);
				pressCtrlC(setup);
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			props,
		);
		// Override list row.
		await withApp(
			async (setup) => {
				await openPanel(setup);
				pressCtrlC(setup);
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			props,
		);
		// Override text row.
		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the model row", (f) => f.includes("❯ Model"));
				pressCtrlC(setup);
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			props,
		);
		// Key guide.
		await withApp(
			async (setup) => {
				await press(setup, "?", "the guide to open", (f) => f.includes("Key guide"));
				pressCtrlC(setup);
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			props,
		);
		// Message view, over a truncated failure.
		const failing = new FakeRunner();
		stubCheckout(failing);
		failing.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: `error: the daemon refused the request: ${"x".repeat(150)}\n`,
		});
		await withApp(
			async (setup) => {
				await press(setup, "return", "the error to appear", (f) =>
					messageRowOf(f).includes("Error:"),
				);
				await press(setup, "m", "the message view to open", (f) => f.includes("Message view"));
				pressCtrlC(setup);
				await destroyed(setup);
			},
			WIDTH,
			HEIGHT,
			{ ...props, runner: failing },
		);
	});

	test("unavailable controls are dimmed, and pressing one explains why", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				const frame = await settle(setup);
				const barRow = rowsOf(frame).length - 1;
				// One ticket: Move cannot move.
				expect(spanColorAt(setup, barRow, "↑↓/jk Move")).toEqual(rgb(COLORS.dim));
				await press(setup, "j", "the move refusal", (f) =>
					messageRowOf(f).includes("the Ticket list has nowhere to move"),
				);
				// No sources: Refresh cannot run.
				expect(spanColorAt(setup, barRow, "r Refresh")).toEqual(rgb(COLORS.dim));
				const refused = await press(setup, "r", "the refresh refusal", (f) =>
					messageRowOf(f).includes("no Ticket sources exist"),
				);
				expect(messageRowOf(refused)).toContain("Warning: no Ticket sources exist");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: [SAMPLE_TICKETS[0]] },
		);
	});

	test("an empty list dims Hand off and explains that no Ticket is selected", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				const frame = await settle(setup);
				const barRow = rowsOf(frame).length - 1;
				expect(spanColorAt(setup, barRow, "Enter Hand off")).toEqual(rgb(COLORS.dim));
				await press(setup, "return", "the refusal", (f) =>
					messageRowOf(f).includes("no Ticket is selected"),
				);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: [] },
		);
	});

	test("a non-open ticket dims Hand off and Override with the reason", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				await press(setup, "j", "the handed-off ticket", (f) => markerRowOf(f) === 3);
				const frame = await settle(setup);
				const barRow = rowsOf(frame).length - 1;
				expect(spanColorAt(setup, barRow, "Enter Hand off")).toEqual(rgb(COLORS.dim));
				expect(spanColorAt(setup, barRow, "e Override")).toEqual(rgb(COLORS.dim));
				await press(setup, "return", "the handoff refusal", (f) =>
					messageRowOf(f).includes("only an open Ticket can be handed off"),
				);
				// The panel is refused the same way: the Action bar keeps its
				// dimmed Override hint, so the refusal reads from the panel row.
				setup.mockInput.pressKey("e");
				const refused = await settle(setup);
				expect(refused).not.toContain("❯ Agent");
				expect(messageRowOf(refused)).toContain("only an open Ticket can be handed off");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});

	test("a stale source dims Hand off with the actionable reason", async () => {
		const state = freshState();
		const source = new FakeSource("issues", "github-issues", success([issueTicket()]));
		try {
			await withApp(
				async (setup) => {
					source.settle(success([issueTicket()]));
					await awaitFrame(setup, (f) => f.includes("Add a webhook retry policy"), "the ticket");
					// A failed refresh makes the stored source stale: the ticket
					// stays visible, but it is no longer actionable.
					setup.mockInput.pressKey("r");
					await callsReached(source, 2);
					source.settle(RATE_LIMITED);
					const frame = await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("issues: stale - GitHub rate limit exceeded"),
						"the stale health warning",
					);
					const barRow = rowsOf(frame).length - 1;
					expect(spanColorAt(setup, barRow, "Enter Hand off")).toEqual(rgb(COLORS.dim));
					await press(setup, "return", "the refusal", (f) =>
						messageRowOf(f).includes(
							"Ticket is not actionable because source data is stale, removed, or absent",
						),
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

	test("an in-flight handoff dims its controls and explains the refusal", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const slow = new DelayedRunner(runner, 2000);
		const props = {
			config: DEFAULT_CONFIG,
			runner: slow,
			initialTickets: SAMPLE_TICKETS,
			home,
			configPath,
		};
		await withApp(
			async (setup) => {
				await press(setup, "return", "the handoff to start", (f) =>
					messageRowOf(f).includes("handing off"),
				);
				const frame = await settle(setup);
				const barRow = rowsOf(frame).length - 1;
				expect(spanColorAt(setup, barRow, "Enter Hand off")).toEqual(rgb(COLORS.dim));
				expect(spanColorAt(setup, barRow, "e Override")).toEqual(rgb(COLORS.dim));
				await press(setup, "return", "the handoff refusal", (f) =>
					messageRowOf(f).includes("a Handoff is active"),
				);
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).trim() === "",
					"the handoff to settle",
					8000,
				);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	}, 15000);

	test("the bar does not change on a boundary move", async () => {
		const runner = new FakeRunner();
		await withApp(
			async (setup) => {
				const before = actionBarRowOf(await settle(setup));
				// k at the top of the list is a boundary no-op.
				setup.mockInput.pressKey("k");
				const after = await settle(setup);
				expect(actionBarRowOf(after)).toBe(before);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner, initialTickets: SAMPLE_TICKETS },
		);
	});
});
