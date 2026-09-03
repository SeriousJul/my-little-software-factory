/**
 * The Live view: the in-flight ticket's own screen. Enter on a handed-off or
 * running ticket opens it near-fullscreen, streaming the agent's terminal
 * output in plain text on the one-second cadence. The one row is the Goto;
 * the bottom pin follows new output until the operator scrolls. When the
 * turn settles and the factory waits for the operator, the same box carries
 * the Decision modal's body and rows; when the agent leaves herdr it
 * carries the Missing modal; a routed handoff keeps the screen and streams
 * the new pane.
 *
 * The list-level tests run the real app on the sample projection, with a
 * fake command runner standing in for herdr. The factory-level tests seed a
 * real SQLite state through the state API and run the observation loop on a
 * pinned poll interval, so the settles, the markers, and the transforms
 * happen the way they happen in production.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { AppProps } from "../src/components/app.ts";
import { COLORS } from "../src/components/theme.ts";
import type { FactoryConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	type AppSetup,
	awaitFrame,
	frameText,
	HEIGHT,
	press,
	pressArrow,
	pressEnterQuiet,
	rgb,
	rowsOf,
	settle,
	sleep,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { agentListJson, FakeRunner, tabCreateJson, workspaceListJson } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

/** The pane read the Live view's stream runs, for a pane and its tail. */
const READ = (pane: string) =>
	[
		"agent",
		"read",
		pane,
		"--lines",
		"200",
		"--source",
		"recent-unwrapped",
		"--format",
		"text",
	] as const;

/** The exact command string a pane read records in the runner. */
const READ_COMMAND = (pane: string) =>
	`herdr agent read ${pane} --lines 200 --source recent-unwrapped --format text`;

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const source = { name: "issues", kind: "github-issues" };
const identity = "github:github.com:I_5";
const repoIdentity = "github.com/acme/factory";

function fetched(index = 5, title = "Persist source facts"): FetchedTicket {
	return {
		identity: `github:github.com:I_${index}`,
		sourceKind: "github-issue",
		externalKey: `#${index}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${index}`,
		title,
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: `https://${repoIdentity}.git`,
		},
		attributes: {},
	};
}

const success: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [fetched()],
};

/** Stub the git answers for the checkout the config maps to. */
function stubCheckout(app: SeededApp): void {
	const path = Object.values(app.config.repos)[0];
	app.runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	app.runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: `https://${repoIdentity}.git\n`,
	});
}

interface SeededApp {
	state: FactoryState;
	config: FactoryConfig;
	runner: FakeRunner;
	configPath: string;
	src: FakeSource;
}

/**
 * A state with the ticket in flight: claimed, settled to the stored herdr
 * handles, and resting in handed-off.
 */
function seedInFlight(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-live-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.initializeSources([source]);
	state.applyFetch(source, success);
	const claim = state.claimHandoff(
		identity,
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
	return state;
}

/** A seeded in-flight state plus the app props that match it. */
function seededApp(extra: Partial<FactoryConfig> = {}): SeededApp {
	const state = seedInFlight();
	const path = mkdtempSync(join(tmpdir(), "factory-live-checkout-"));
	paths.push(path);
	const home = mkdtempSync(join(tmpdir(), "factory-live-home-"));
	paths.push(home);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
	const config = {
		...DEFAULT_CONFIG,
		repos: { [repoIdentity]: path },
		workflows: [{ from: "implement", to: ["review"] }],
		...extra,
	};
	const runner = new FakeRunner();
	const src = new FakeSource("issues", "github-issues", success);
	return { state, config, runner, configPath, src };
}

/** The app props for a seeded app, polling fast enough for the tests. */
function propsOf(app: SeededApp): AppProps {
	return {
		config: app.config,
		state: app.state,
		runner: app.runner,
		configPath: app.configPath,
		sources: [app.src],
		pollIntervalMs: 20,
	};
}

/** Enter through the real key path, then wait for its effect. */
async function pressReturn(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEnter();
	return await awaitFrame(setup, predicate, what);
}

/** The ticket's list row, by its title. */
function ticketRow(frame: string, title = "Persist source facts"): string {
	const rows = rowsOf(frame);
	const row = rows.find((line) => line.includes(title));
	if (row === undefined) throw new Error(`no ticket row for ${title} in frame:\n${frame}`);
	return row;
}

describe("the Live view on the ticket list", () => {
	test("enter on an in-flight ticket opens the Live view above the list", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", [...READ("pane-implement")], {
			stdout: "the layout math is off by one\n",
		});

		await withApp(
			async (setup) => {
				// The second sample ticket is already handed off.
				await press(setup, "j", "the selection to move to the second ticket", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				// The pop-in settles before the geometry is measured.
				await sleep(250);
				// Near-fullscreen: the box's border sits one cell in from the
				// terminal's edges, top and bottom.
				const frame = setup.captureCharFrame();
				const rows = rowsOf(frame);
				expect(rows[1].slice(0, 2)).toBe(" ┌");
				expect(rows[HEIGHT - 2].slice(0, 2)).toBe(" └");
				// The context line names the repository, the task, the agent.
				expect(frame).toContain("acme/portal · implement · codex");
				// The one row is the Goto, and the hint says so.
				expect(frame).toContain("Goto");
				expect(frame).toContain("enter goto");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner },
		);
	});

	test("the stream shows the agent's output as plain text", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", [...READ("pane-implement")], {
			stdout: "line one of the agent work\nline two of the agent work\n",
		});

		await withApp(
			async (setup) => {
				await press(setup, "j", "the selection to move", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("line one of the agent work"),
					"the stream",
				);
				expect(frame).toContain("line two of the agent work");
				// The pop-in settles before the color is measured.
				await sleep(250);
				// Plain text in the palette's prose voice: no ANSI, no styling.
				expect(spanColors(setup, "line one of the agent work")).toContainEqual(rgb(COLORS.text));
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner },
		);
	});

	test("the stream refreshes on the one-second cadence", async () => {
		const runner = new FakeRunner();
		runner.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[
				{ stdout: "first tick\n" },
				{ stdout: "first tick\nsecond tick\n" },
				{ stdout: "first tick\nsecond tick\n" },
			],
		);

		await withApp(
			async (setup) => {
				await press(setup, "j", "the selection to move", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				await awaitFrame(setup, (f) => f.includes("first tick"), "the first read");
				// The next read lands on the cadence: the new line arrives
				// without any key press.
				await awaitFrame(setup, (f) => f.includes("second tick"), "the refresh");
				expect(
					runner.commands().filter((c) => c === READ_COMMAND("pane-implement")).length,
				).toBeGreaterThanOrEqual(2);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner },
		);
	});

	test("new output pins the stream to the bottom", async () => {
		const many = (count: number) =>
			Array.from({ length: count }, (_, i) => `tick ${String(i + 1).padStart(2, "0")}`).join("\n");
		const runner = new FakeRunner();
		runner.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[{ stdout: `${many(30)}\n` }, { stdout: `${many(35)}\n` }, { stdout: `${many(35)}\n` }],
		);

		await withApp(
			async (setup) => {
				await press(setup, "j", "the selection to move", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const first = await awaitFrame(
					setup,
					(f) => f.includes("tick 30"),
					"the first read at the bottom",
				);
				// The body is shorter than the output: the bottom is in view,
				// the top has scrolled past.
				expect(first).not.toContain("tick 01");
				// The next read appends: the pin follows the newest line, and
				// what the pin pushed out stays out.
				await awaitFrame(setup, (f) => f.includes("tick 35"), "the next read");
				expect(frameText(setup.captureCharFrame())).not.toContain("tick 10");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner },
		);
	});

	test("a manual scroll releases the bottom pin", async () => {
		const many = (count: number) =>
			Array.from({ length: count }, (_, i) => `tick ${String(i + 1).padStart(2, "0")}`).join("\n");
		const runner = new FakeRunner();
		runner.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[{ stdout: `${many(30)}\n` }, { stdout: `${many(35)}\n` }, { stdout: `${many(35)}\n` }],
		);

		await withApp(
			async (setup) => {
				await press(setup, "j", "the selection to move", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const first = await awaitFrame(
					setup,
					(f) => f.includes("tick 30"),
					"the first read at the bottom",
				);
				expect(first).not.toContain("tick 01");
				// Two rows up: the operator is reading, not following. The
				// window is a row short of the full tail, so the last line
				// leaves the view only on the second press.
				await press(setup, "k", "the first scroll row", (f) => f.includes("tick 10"));
				await press(setup, "k", "the scroll up two rows", (f) => !f.includes("tick 30"));
				// The next read arrives while the operator reads: the window
				// holds where the operator put it.
				await sleep(1300);
				expect(
					runner.commands().filter((c) => c === READ_COMMAND("pane-implement")).length,
				).toBeGreaterThanOrEqual(2);
				expect(frameText(setup.captureCharFrame())).not.toContain("tick 35");
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner },
		);
	});

	test("a failed read keeps the last lines under the stale note", async () => {
		const runner = new FakeRunner();
		runner.setSequence(
			"herdr",
			[...READ("pane-implement")],
			[
				{ stdout: "last good lines\n" },
				{ code: 1, stderr: "the pane is gone" },
				{ code: 1, stderr: "the pane is gone" },
			],
		);

		await withApp(
			async (setup) => {
				await press(setup, "j", "the selection to move", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				await awaitFrame(setup, (f) => f.includes("last good lines"), "the first read");
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Stale Agent output: the last lines stand"),
					"the stale note",
				);
				// The last lines stand under the note, and the note is dim.
				expect(frame).toContain("last good lines");
				expect(spanColors(setup, "Stale Agent output")).toContainEqual(rgb(COLORS.dim));
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner },
		);
	});

	test("esc closes the Live view without side effects", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", [...READ("pane-implement")], { stdout: "the agent works\n" });

		await withApp(
			async (setup) => {
				await press(setup, "j", "the selection to move", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				const frame = await pressEscape(setup, "the view to close", (f) => !f.includes("Live:"));
				// The ticket stays where it is, and nothing ran but the reads.
				expect(frame).toContain("[handed-off]");
				expect(runner.commands().join("\n")).not.toContain("agent focus");
				expect(runner.commands().every((c) => c === READ_COMMAND("pane-implement"))).toBe(true);
			},
			WIDTH,
			HEIGHT,
			{ config: DEFAULT_CONFIG, runner },
		);
	});

	test("a ticket without a recorded pane shows the note and reads nothing", async () => {
		const runner = new FakeRunner();

		await withApp(
			async (setup) => {
				// Two rows down: the running ticket, with no handoff stored.
				await press(setup, "j", "the selection to move", (f) =>
					f.includes("Fix pan drift in split panes"),
				);
				await press(setup, "j", "the selection to the running ticket", (f) =>
					f.includes("Migrate scheduler to clock"),
				);
				const frame = await pressEnterQuiet(setup, "the Live view", (f) =>
					f.includes("Live: Migrate scheduler to clock"),
				);
				expect(frame).toContain("no agent pane is recorded for this ticket");
				// No pane to read: the runner was never asked for one.
				expect(runner.calls).toHaveLength(0);
			},
			WIDTH,
			HEIGHT,
			{
				config: DEFAULT_CONFIG,
				runner,
				initialTickets: [...SAMPLE_TICKETS.slice(0, 2), { ...SAMPLE_TICKETS[2], handoff: null }],
			},
		);
	});
});

/** Escape through the real key path, then wait for its effect. */
async function pressEscape(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEscape();
	return await awaitFrame(setup, predicate, what);
}

describe("the Live view against a running factory", () => {
	test("goto from the Live view focuses the pane and records no decision", async () => {
		const app = seededApp();
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
				},
			]),
		});
		app.runner.set("herdr", [...READ("pane-1")], { stdout: "working on the layout\n" });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				// Enter confirms the Goto: the focus runs, the view closes.
				const frame = await pressReturn(setup, "the focus", (f) =>
					f.includes("focused the agent of ticket"),
				);
				expect(app.runner.commands()).toContain("herdr agent focus pane-1");
				// The focus is pure: no completion trace exists, and the
				// ticket is still in flight under its badge.
				expect(app.state.lastCompletion(identity)).toBeNull();
				expect(app.state.ticketsByState(["awaiting"])).toHaveLength(0);
				expect(frame).not.toContain("Live:");
				expect(ticketRow(await settle(setup))).toMatch(/\[(handed-off|running)\]/);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("the view turns into the Decision modal when the turn settles", async () => {
		const app = seededApp();
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
				},
			]),
		});
		app.runner.set("herdr", [...READ("pane-1")], {
			stdout: "The fix is in the layout math.\n",
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("The fix is in the layout math."), "the stream");
				// The agent reports done: the observation settles the turn,
				// and the same box turns into the decision.
				app.runner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "done",
						},
					]),
				});
				// The border keeps the Live title in both sub-modes: the
				// decision's rows are the handover.
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Live: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				// The settled turn's log, captured from the pane, and the
				// decision's rows in their order.
				expect(frame).toContain("The fix is in the layout math.");
				expect(frame).toContain("Close");
				expect(frame).toContain("Goto");
				// Close is selected by default; confirming it ends the cycle.
				await pressReturn(setup, "the close", (f) => f.includes("[open]"));
				expect(ticketRow(await settle(setup))).toContain("[open]");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a settled turn the factory decides for itself keeps streaming", async () => {
		const app = seededApp({
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: { ...DEFAULT_CONFIG.taskTypes.implement, autoClose: true },
			},
		});
		const checkoutPath = Object.values(app.config.repos)[0];
		// The checkout is not a repository: the automatic route cannot
		// start, so the factory keeps deciding and the ticket stays in
		// awaiting.
		app.runner.set("git", ["-C", checkoutPath, "rev-parse", "--git-dir"], {
			code: 1,
			stderr: "not a repository",
		});
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
				},
			]),
		});
		app.runner.set("herdr", [...READ("pane-1")], { stdout: "the agent is finishing up\n" });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				// The agent reports done. The turn settles, the factory takes
				// the decision for itself (its route cannot start), and the
				// screen never hands over to the decision rows.
				app.runner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "done",
						},
					]),
				});
				// The settle lands in the state; the screen shows it, the
				// status line under the overlay does not.
				const deadline = Date.now() + 2000;
				while (app.state.ticketState(identity) !== "awaiting" && Date.now() < deadline) {
					await sleep(20);
				}
				expect(app.state.ticketState(identity)).toBe("awaiting");
				const frame = setup.captureCharFrame();
				// The factory's own decision never hands the screen over:
				// the stream stands where the operator left it, the one row
				// stays the Goto, and no handoff row appears.
				expect(frame).toContain("Live: Persist source facts");
				expect(frame).toContain("the agent is finishing up");
				expect(frame).toContain("Goto");
				expect(frame).not.toContain("Handoff: review");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("the view turns into the Missing modal when the agent leaves herdr", async () => {
		const app = seededApp();
		const list = (status: string) =>
			agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status,
				},
			]);
		app.runner.set("herdr", ["agent", "list"], { stdout: list("working") });
		app.runner.set("herdr", [...READ("pane-1")], { stdout: "the agent works\n" });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the agent works"), "the stream");
				// The agent leaves herdr: the box carries the missing modal.
				app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Missing: Persist source facts"),
					"the missing modal",
				);
				expect(frame).toContain("Restart");
				expect(frame).toContain("Abandon");
				// The agent is back in the list: the stream returns in the
				// same screen.
				app.runner.set("herdr", ["agent", "list"], { stdout: list("working") });
				await awaitFrame(
					setup,
					(f) => f.includes("Live: Persist source facts") && !f.includes("Missing:"),
					"the stream to return",
				);
				expect(app.state.ticketState(identity)).toBe("running");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a routed handoff from the decision sub-mode keeps the screen and streams the new pane", async () => {
		const app = seededApp();
		stubCheckout(app);
		const checkoutPath = Object.values(app.config.repos)[0];
		// The settled agent's pane and the new agent's pane, both live, so
		// the stream can move to the new pane the moment the handoff settles.
		const list = (status1: string, status9: string) =>
			agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: status1,
				},
				{
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: status9,
				},
			]);
		app.runner.set("herdr", ["agent", "list"], { stdout: list("working", "working") });
		// The stored workspace still holds: the route reuses it in a new tab.
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});
		app.runner.set("herdr", [...READ("pane-1")], {
			stdout: "the implementer is finishing\n",
		});
		app.runner.set("herdr", [...READ("pane-9")], { stdout: "the reviewer is on it\n" });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("Persist source facts"), "the ticket row");
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				await awaitFrame(setup, (f) => f.includes("the implementer is finishing"), "the stream");
				// The agent reports done: the same box turns into the decision.
				app.runner.set("herdr", ["agent", "list"], { stdout: list("done", "working") });
				await awaitFrame(
					setup,
					(f) => f.includes("Live: Persist source facts") && f.includes("Handoff: review"),
					"the decision",
				);
				// Close is the default; the workflow handoff is the last row.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				// The routed handoff starts in the new tab; the screen stays
				// open and its stream moves to the new pane.
				await pressReturn(setup, "the routed handoff", (f) => f.includes("the reviewer is on it"));
				expect(frameText(setup.captureCharFrame())).toContain("Live: Persist source facts");
				// The new agent is live: the observation loop may already have
				// marked the in-flight ticket running.
				expect(["handed-off", "running"]).toContain(app.state.ticketState(identity));
				expect(app.state.lastCompletion(identity)?.decision).toBe("handed-off");
				// The stream follows the handoff: the new pane's read, and no
				// focus, which is the Goto's alone.
				expect(app.runner.commands()).toContain(READ_COMMAND("pane-9"));
				expect(app.runner.commands().join("\n")).not.toContain("agent focus");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});
