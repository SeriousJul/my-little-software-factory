/**
 * The handoff through the real UI: Enter starts it, `e` opens the override
 * panel, failures settle the ticket, and the in-flight state refuses a
 * second handoff. A non-open ticket gets the hint instead, a filesystem
 * failure on the clone path shows the reason and keeps the app alive, a
 * failed mapping write-back warns, and the panel sizes itself to a narrow
 * terminal instead of corrupting rows.
 *
 * These tests boot the app through the same harness as the frame tests,
 * but with a fake command runner and a temporary home, so the full
 * key -> handoff -> status pipeline runs without touching a real herdr
 * session or the real home directory.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { panelValueCells } from "../src/components/override-panel.ts";
import { COLORS } from "../src/components/theme.ts";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { renderPrompt } from "../src/handoff.ts";
import type { CommandResult, CommandRunner, ModelListResult } from "../src/runner.ts";
import {
	awaitFrame,
	detailPaneText,
	frameText,
	HEIGHT,
	listHalfOf,
	markerRowOf,
	openPanel,
	press,
	pressArrow,
	rgb,
	rowsOf,
	type Setup,
	settle,
	showsTicket,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import {
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
	worktreeCreateJson,
} from "./fake-runner.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

let home = "";
let configPath = "";

beforeEach(() => {
	home = join(tmpdir(), `factory-frame-${Math.random().toString(36).slice(2)}`);
	configPath = join(home, "factory", "config.toml");
	mkdirSync(join(home, "src", "billing"), { recursive: true });
	writeFileSync(join(home, "src", "billing", "marker"), "repo");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const checkout = () => join(home, "src", "billing");

/** The first sample ticket, the one Enter acts on by default. */
const first = SAMPLE_TICKETS[0];
const firstAgent = "retry-policy-for-webhooks";
const firstPrompt = renderPrompt(DEFAULT_CONFIG.taskTypes.implement.template, first);

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

/** Stub a successful worktree handoff at the convention checkout. */
function stubWorktreeHandoff(runner: FakeRunner): void {
	const path = checkout();
	runner.set(
		"git",
		["-C", path, "branch", "--list", `factory/${first.externalKey.slice(1)}-${firstAgent}`],
		{
			stdout: "",
		},
	);
	runner.set("git", ["-C", path, "rev-parse", "HEAD"], { stdout: "deadbeef\n" });
	runner.set(
		"herdr",
		[
			"worktree",
			"create",
			"--cwd",
			path,
			"--branch",
			`factory/${first.externalKey.slice(1)}-${firstAgent}`,
			"--base",
			"deadbeef",
			"--no-focus",
		],
		{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
	);
}

/** A runner that delays its first call, so the in-flight state is visible. */
class DelayedRunner implements CommandRunner {
	private done = false;
	private inner: FakeRunner;
	private delayMs: number;

	constructor(inner: FakeRunner, delayMs: number) {
		this.inner = inner;
		this.delayMs = delayMs;
	}

	run(command: string, args: string[]): Promise<CommandResult> {
		if (this.done) {
			return this.inner.run(command, args);
		}
		this.done = true;
		return new Promise((resolve) =>
			setTimeout(() => resolve(this.inner.run(command, args)), this.delayMs),
		);
	}

	listModels(kind: string): Promise<ModelListResult> {
		return this.inner.listModels(kind);
	}
}

/**
 * Walk the panel selection from its first row down to the Model row.
 *
 * The rows come in order, so three moves reach it whatever the agent maps.
 */
async function moveToModelRow(setup: Setup): Promise<string> {
	await press(setup, "j", "the selection to move to the environment", (f) =>
		f.includes("❯ Environment"),
	);
	await press(setup, "j", "the selection to move to the task type", (f) =>
		f.includes("❯ Task type"),
	);
	return press(setup, "j", "the selection to move to the model", (f) => f.includes("❯ Model"));
}

/** Walk the panel selection down to the Thinking row, below the Model row. */
async function moveToThinkingRow(setup: Setup): Promise<string> {
	await moveToModelRow(setup);
	return pressArrow(setup, "down", "the selection to move to the thinking row", (f) =>
		f.includes("❯ Thinking"),
	);
}

/** One panel size, with the value column its geometry gives. */
interface PanelSize {
	width: number;
	height: number;
	/** The cells a row's value gets at this size, read off the panel itself. */
	valueCells: number;
}

/**
 * The sizes a list row is pinned at.
 *
 * 120x30 is the terminal the panel is designed for, where a value gets the
 * whole 30-cell column it wants. 46x20 is the narrow panel that still holds
 * its guide row: the value column shrinks to 28 cells, so a real model name
 * reaches the clip boundary and the guide that carries the loading marker is
 * still on screen. Below that the guide drops out of the panel, so a hint is
 * pinned at its own tiny size instead.
 *
 * The value column comes from `panelValueCells`, so a geometry change moves the
 * assertions with it instead of leaving a hand-copied width behind.
 */
const PANEL_SIZES: readonly PanelSize[] = [
	{ width: WIDTH, height: HEIGHT, valueCells: panelValueCells(WIDTH, HEIGHT) },
	{ width: 46, height: 20, valueCells: panelValueCells(46, 20) },
];

/** The panel row that shows one label, for a check that runs on one row alone. */
function rowLineOf(frame: string, label: string): string {
	const line = rowsOf(frame).find((row) => row.includes(label));
	if (line === undefined) throw new Error(`no rendered row holds ${label}`);
	return line;
}

/**
 * Wait until the renderer paints `text` in exactly `color`.
 *
 * A row's colour is what carries its state, and the char frame cannot show it,
 * so a wait on it reads the styled spans instead of the frame text.
 */
async function awaitPaintedIn(
	setup: Setup,
	text: string,
	color: [number, number, number],
	what: string,
): Promise<string> {
	return awaitFrame(setup, () => paintedIn(setup, text, color), what);
}

/** True when the renderer painted `text` in one color alone, and that color is `color`. */
function paintedIn(setup: Setup, text: string, color: [number, number, number]): boolean {
	const colors = spanColors(setup, text);
	return colors.length === 1 && colors[0].join(",") === color.join(",");
}

/** Press Backspace, and wait for the effect it should produce. */
async function pressBackspace(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressBackspace();
	return awaitFrame(setup, predicate, what);
}

/** Press forward Delete, and wait for the effect it should produce. */
async function pressDelete(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressKey("DELETE");
	return awaitFrame(setup, predicate, what);
}

/**
 * Walk from the task type row to the Model row just below it.
 *
 * A task type switch is what the test drives, and the Model row is the value it
 * must not re-derive, so the two rows are walked between by name.
 */
async function moveToModelRowFromTaskType(setup: Setup): Promise<string> {
	return pressArrow(setup, "down", "the selection to move to the model", (f) =>
		f.includes("❯ Model"),
	);
}

/** Walk from the Model row up to the task type row above it. */
async function moveToTaskTypeFromModelRow(setup: Setup): Promise<string> {
	return pressArrow(setup, "up", "the selection to move to the task type", (f) =>
		f.includes("❯ Task type"),
	);
}

/**
 * The selected ticket's list row.
 *
 * The sample data already carries a handed-off ticket, so frame checks on
 * the state badge must read the selected row, not scan the whole frame.
 */
const selectedRow = (frame: string) => rowsOf(frame)[markerRowOf(frame)];
const selectedIs = (frame: string, badge: string) => {
	const index = markerRowOf(frame);
	return index >= 0 && selectedRow(frame).includes(badge);
};

/** Press Enter and wait for the selected ticket to settle as handed off. */
async function pressEnter(setup: Setup, what: string, text: string): Promise<string> {
	setup.mockInput.pressEnter();
	return awaitFrame(setup, (frame) => frame.includes(text), what);
}

/**
 * The panel row whose text holds `label`, or an empty string when no row does.
 *
 * The panel is the only thing on screen that carries these labels, so a line
 * search is enough to read one row.
 */
const rowWith = (frame: string, label: string): string =>
	rowsOf(frame).find((r) => r.includes(label)) ?? "";

/** Press one arrow, and wait for the named panel row to hold the marker. */
async function selectRow(setup: Setup, direction: "up" | "down", label: string): Promise<string> {
	return pressArrow(setup, direction, `the ${label} row to be selected`, (f) =>
		f.includes(`\u276f ${label}`.replace("\u276f", "❯")),
	);
}

/**
 * Walk the panel's arrows down to the Context row, and return a settled frame.
 *
 * A free-text row owns j and k, so the walk uses the arrows, which always move.
 */
async function selectContextRow(setup: Setup): Promise<string> {
	await selectRow(setup, "down", "Environment");
	await selectRow(setup, "down", "Task type");
	await selectRow(setup, "down", "Model");
	await selectRow(setup, "down", "Thinking");
	await selectRow(setup, "down", "Context");
	return settle(setup);
}

/** The digits the Context row holds, or an empty string when it holds none. */
const contextDigitsOf = (frame: string): string =>
	rowWith(frame, "Context").match(/Context\s+([0-9]+)/u)?.[1] ?? "";

/** Type into the row the panel holds focused. */
async function typeText(setup: Setup, text: string): Promise<void> {
	await setup.mockInput.typeText(text);
}

/** A profile that names a context window, on an agent that maps one. */
const contextProfileConfig: FactoryConfig = {
	...DEFAULT_CONFIG,
	agents: {
		...DEFAULT_CONFIG.agents,
		codex: {
			...DEFAULT_CONFIG.agents.codex,
			model: "-m {value}",
			thinking: "-r {value}",
			contextWindow: "-c model_context_window={value}",
		},
	},
	taskTypes: {
		...DEFAULT_CONFIG.taskTypes,
		implement: {
			...DEFAULT_CONFIG.taskTypes.implement,
			agent: "codex",
			model: "gpt-5.6-codex",
			contextWindow: "272000",
		},
	},
};

async function pressEnterToHandoff(setup: Setup): Promise<string> {
	setup.mockInput.pressEnter();
	return awaitFrame(
		setup,
		(frame) => selectedIs(frame, "[handed-off]"),
		"the selected ticket to settle",
	);
}

describe("the Enter handoff", () => {
	test("hands the selected ticket off with the defaults, settles it, and records the command sequence", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const frame = await pressEnterToHandoff(setup);

				// The selected ticket settled in the list...
				expect(selectedRow(frame)).toContain("[handed-off]");
				// ...and the detail pane carries the handoff facts.
				const detail = detailPaneText(frame);
				expect(detail).toContain("Agent: pi");
				expect(detail).toContain("Environment: live-worktree");
				// The detail line says the value is the handoff's, not a
				// suggestion.
				expect(detail).toContain("Handoff task type: implement");
				// A clean handoff clears the status line: no message and the
				// panes take back the last row.
				expect(frame).not.toContain("handing off");
				expect(rowsOf(frame)[HEIGHT - 1].startsWith("└")).toBe(true);

				expect(runner.commands()).toEqual([
					`git -C ${checkout()} rev-parse --git-dir`,
					`git -C ${checkout()} remote get-url origin`,
					"herdr workspace list",
					`herdr workspace create --cwd ${checkout()} --no-focus`,
					`herdr tab create --workspace ws-1 --cwd ${checkout()} --no-focus`,
					`herdr agent start ${firstAgent} --kind pi --pane pane-1`,
					`herdr agent prompt ${firstAgent} ${firstPrompt}`,
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a failed herdr step leaves the ticket open and shows the reason", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr: "error: herdr is not running\n",
		});
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const frame = await pressEnter(
					setup,
					"the failure reason to appear",
					"error: herdr is not running",
				);

				// The reason sits on the status line, the last row of the terminal.
				expect(rowsOf(frame)[HEIGHT - 1]).toContain("error: herdr is not running");
				// The selected ticket never left the open state, and a failed
				// attempt is not a handoff: the row still wears the suggestion,
				// and the detail says so.
				const row = listHalfOf(selectedRow(frame));
				expect(row).toContain("[open]");
				expect(row).toContain("[implement]");
				expect(detailPaneText(frame)).toContain("Suggested task type: implement");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("an unreadable workspace list fails with a reason and creates no workspace", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: "not a workspace list\n" });
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const frame = await pressEnter(
					setup,
					"the failure reason to appear",
					"readable workspace list",
				);

				// The reason sits on the status line, the ticket stays open...
				expect(rowsOf(frame)[HEIGHT - 1]).toContain("readable workspace list");
				expect(selectedRow(frame)).toContain("[open]");
				// ...and no second workspace is created for the checkout:
				// unreadable is not "no workspace".
				expect(runner.commands()).not.toContain(expect.stringContaining("workspace create"));
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a handoff attempt on a non-open ticket shows the hint and issues no command", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				// The second sample ticket is already handed off.
				await press(setup, "j", "the selection to move to the second ticket", (f) =>
					showsTicket(f, SAMPLE_TICKETS[1]),
				);
				setup.mockInput.pressEnter();
				const frame = await awaitFrame(
					setup,
					(f) => rowsOf(f)[HEIGHT - 1].includes("only open tickets can be handed off"),
					"the non-open hint",
				);

				// The hint sits on the status line, the ticket stays where it is.
				expect(selectedRow(frame)).toContain("[handed-off]");
				// No command ever ran.
				expect(runner.calls).toHaveLength(0);

				// The panel is refused the same way: e shows the hint, no panel.
				setup.mockInput.pressKey("e");
				const refused = await settle(setup);
				expect(refused).not.toContain("Override");
				expect(rowsOf(refused)[HEIGHT - 1]).toContain("only open tickets can be handed off");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a filesystem error on the clone path shows the reason and keeps the app alive", async () => {
		const runner = new FakeRunner();
		// A file where ~/src should be: mkdir cannot create the clone parent.
		rmSync(join(home, "src"), { recursive: true, force: true });
		writeFileSync(join(home, "src"), "a file");
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				setup.mockInput.pressEnter();
				const frame = await awaitFrame(
					setup,
					(f) => rowsOf(f)[HEIGHT - 1].includes("cannot create"),
					"the clone failure reason",
				);

				// The reason sits on the status line, the ticket stays open,
				// and no command ran: the failure is before git clone.
				expect(selectedRow(frame)).toContain("[open]");
				expect(runner.calls).toHaveLength(0);

				// Repair the filesystem: the clone can succeed now.
				rmSync(join(home, "src"), { recursive: true, force: true });
				mkdirSync(join(home, "src"));
				stubLiveHandoff(runner);
				runner.set(
					"git",
					["clone", "https://github.com/acme/billing.git", join(home, "src", "billing")],
					{
						code: 0,
					},
				);

				// The in-flight guard cleared and the app is alive: a retry on
				// the same ticket runs the handoff to completion.
				setup.mockInput.pressEnter();
				const settled = await awaitFrame(
					setup,
					(f) => selectedIs(f, "[handed-off]"),
					"the retry to settle",
				);
				// The retry re-resolved the repository: the clone ran this time.
				expect(runner.commands()).toContain(
					`git clone https://github.com/acme/billing.git ${join(home, "src", "billing")}`,
				);
				// A clean handoff clears the status line: the failure reason
				// is gone.
				expect(settled).not.toContain("cannot create");

				// Keys still move the selection.
				const moved = await press(
					setup,
					"j",
					"the selection to move on",
					(f) => markerRowOf(f) === 3,
				);
				expect(selectedRow(moved)).toContain("Fix pan drift");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});
});

describe("the in-flight guard", () => {
	test("a second Enter while a handoff is in flight starts nothing", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const slow = new DelayedRunner(runner, 400);
		const props = { config: DEFAULT_CONFIG, runner: slow, home, configPath };

		await withApp(
			async (setup) => {
				await pressEnter(setup, "the in-flight status", "handing off");
				// The handoff is in flight. Try to start another one.
				setup.mockInput.pressEnter();

				const frame = await pressEnterToHandoff(setup);

				// Exactly one handoff ran, not two.
				expect(runner.commands()).toHaveLength(7);
				// The status cleared after the handoff settled.
				expect(frame).not.toContain("handing off");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("two Enters in one tick start one handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const slow = new DelayedRunner(runner, 400);
		const props = { config: DEFAULT_CONFIG, runner: slow, home, configPath };

		await withApp(
			async (setup) => {
				// Both Enters are queued before a render: the key parser
				// delivers them in one tick, where a state-based guard would
				// still read the stale value and let both through.
				setup.mockInput.pressEnter();
				setup.mockInput.pressEnter();

				await pressEnterToHandoff(setup);

				// Exactly one handoff ran, not two.
				expect(runner.commands()).toHaveLength(7);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("j and k keep moving the selection while a handoff is in flight", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const slow = new DelayedRunner(runner, 400);
		const props = { config: DEFAULT_CONFIG, runner: slow, home, configPath };

		await withApp(
			async (setup) => {
				await pressEnter(setup, "the in-flight status", "handing off");
				// The keys keep working while the handoff is in flight: the
				// selection moves on...
				await press(
					setup,
					"j",
					"the selection to move while in flight",
					(f) => markerRowOf(f) === 3,
				);
				// ...and moves back.
				await press(
					setup,
					"k",
					"the selection to move back while in flight",
					(f) => markerRowOf(f) === 2,
				);
				// The first handoff still settles, on the ticket it started on.
				await awaitFrame(setup, (f) => selectedIs(f, "[handed-off]"), "the handoff to settle");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});
});

describe("the override panel", () => {
	test("`e` opens the panel, right changes options, enter confirms the handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubWorktreeHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				// The panel covers the app: the ticket list is not visible.
				expect(opened).not.toContain("[open]");

				// The rows show the current choices, starting from the config defaults.
				expect(opened).toContain("Agent");
				expect(opened).toContain("Environment");
				expect(opened).toContain("Task type");
				expect(opened).toContain("pi");
				expect(opened).toContain("live-worktree");
				expect(opened).toContain("implement");
				// pi maps a thinking list and no default is set: the row shows
				// the unset hint, not a blank.
				expect(opened).toContain("(unset)");

				// Agent: pi -> codex.
				await pressArrow(setup, "right", "the agent to become codex", (f) => f.includes("codex"));

				// Environment: live-worktree -> worktree.
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await pressArrow(
					setup,
					"right",
					"the environment to become worktree",
					(f) => !f.includes("live-worktree"),
				);

				// Confirm.
				const settled = await pressEnterToHandoff(setup);
				const detail = detailPaneText(settled);
				expect(detail).toContain("Agent: codex");
				expect(detail).toContain("Environment: worktree");

				// The worktree sequence ran, based on the read HEAD, not a default.
				expect(runner.commands()).toContain(
					`git -C ${checkout()} branch --list factory/${first.externalKey.slice(1)}-${firstAgent}`,
				);
				expect(runner.commands()).toContain(`git -C ${checkout()} rev-parse HEAD`);
				expect(runner.commands()).toContain(
					`herdr worktree create --cwd ${checkout()} --branch factory/${first.externalKey.slice(1)}-${firstAgent} --base deadbeef --no-focus`,
				);
				expect(runner.commands()).toContain(
					`herdr agent start ${firstAgent} --kind codex --pane pane-wt`,
				);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("an override that differs from the suggestion rides on the handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		// The delay holds the pipeline before agent start, so the in-flight
		// handoff is visible while it is not yet recorded.
		const props = {
			config: DEFAULT_CONFIG,
			runner: new DelayedRunner(runner, 800),
			home,
			configPath,
		};

		await withApp(
			async (setup) => {
				// The open ticket wears its suggestion, and the detail says so.
				expect(listHalfOf(selectedRow(setup.captureCharFrame()))).toContain("[implement]");
				expect(detailPaneText(setup.captureCharFrame())).toContain(
					"Suggested task type: implement",
				);

				// Override the task type to fix.
				await openPanel(setup);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await pressArrow(setup, "right", "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);

				// Confirm. The handoff is in flight, but the agent has not
				// started: the override stays provisional, and the list keeps
				// showing the suggestion.
				setup.mockInput.pressEnter();
				const inFlight = await awaitFrame(
					setup,
					(frame) => frame.includes("handing off"),
					"the in-flight handoff",
				);
				const row = listHalfOf(selectedRow(inFlight));
				expect(row).toContain("[open]");
				expect(row).toContain("[implement]");
				expect(detailPaneText(inFlight)).toContain("Suggested task type: implement");

				// Once the handoff settles, the row and the detail wear the
				// overridden task type, not the suggestion.
				const settled = await awaitFrame(
					setup,
					(frame) => selectedIs(frame, "[handed-off]"),
					"the handoff to settle",
				);
				const settledRow = listHalfOf(selectedRow(settled));
				expect(settledRow).toContain("[fix]");
				expect(settledRow).not.toContain("[implement]");
				expect(detailPaneText(settled)).toContain("Handoff task type: fix");

				// The override drove the prompt too.
				const fixPrompt = renderPrompt(DEFAULT_CONFIG.taskTypes.fix.template, first);
				expect(runner.commands()).toContain(`herdr agent prompt ${firstAgent} ${fixPrompt}`);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a failure after agent start keeps the actual task type on the row", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const fixPrompt = renderPrompt(DEFAULT_CONFIG.taskTypes.fix.template, first);
		runner.set("herdr", ["agent", "prompt", firstAgent, fixPrompt], {
			code: 1,
			stderr: "error: the agent is not accepting prompts\n",
		});
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				// Override the task type to fix, then hand off.
				await openPanel(setup);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await pressArrow(setup, "right", "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);
				const frame = await pressEnterToHandoff(setup);

				// The agent started, so the handoff is recorded even though
				// the prompt did not get through: the row and the detail keep
				// the actual overridden task type.
				const row = listHalfOf(selectedRow(frame));
				expect(row).toContain("[handed-off]");
				expect(row).toContain("[fix]");
				expect(detailPaneText(frame)).toContain("Handoff task type: fix");
				// The prompt failure still shows its reason.
				expect(frame).toContain("the prompt failed");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("an unset thinking row cycles to the first option on the first right", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				// Move to the Thinking row (Agent, Environment, Task type, Model, Thinking).
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Model"));
				// The Model row is free text: j would type into it, so the arrow
				// moves the selection past it.
				const frame = await pressArrow(
					setup,
					"down",
					"the row selection to move to the thinking row",
					(f) => f.includes("❯ Thinking"),
				);
				// The arrow moved the selection; nothing was typed into the row.
				expect(frameText(frame)).toContain("Model (empty)");
				// The first right lands on the first option, not the second.
				const cycled = await pressArrow(
					setup,
					"right",
					"the thinking to become the first option",
					(f) => !f.includes("(unset)"),
				);
				expect(cycled).not.toContain("(unset)");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a task profile prefills the detail and panel, then starts its agent with all settings", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			defaultModel: "global-model",
			agents: {
				...DEFAULT_CONFIG.agents,
				codex: { ...DEFAULT_CONFIG.agents.codex, contextWindow: "-c {value}" },
			},
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: {
					...DEFAULT_CONFIG.taskTypes.implement,
					agent: "codex",
					model: "task-model",
					thinking: "high",
					contextWindow: "272000",
				},
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				const before = detailPaneText(setup.captureCharFrame());
				expect(before).toContain("Agent: codex");
				expect(before).toContain("Model: task-model");
				expect(before).toContain("Thinking: high");
				// The fourth profile setting reads the same way, in the same
				// place: the detail shows what Enter will start with.
				expect(before).toContain("Context: 272000");

				const opened = await openPanel(setup);
				expect(frameText(opened)).toContain("Agent codex");
				expect(frameText(opened)).toContain("Model task-model");
				expect(frameText(opened)).toContain("Thinking high");
				expect(frameText(opened)).toContain("Context 272000");
				await pressEnterToHandoff(setup);

				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"codex",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"task-model",
					"-c",
					"model_reasoning_effort=high",
					"-c",
					"272000",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("an open ticket of a second work cycle shows what Enter starts, not its last cycle", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		// The cycle that closed ran on an agent that maps every setting; the
		// profile the ticket now resolves takes another agent and names none of
		// them, so the record and the next handoff disagree on all four.
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			agents: {
				...DEFAULT_CONFIG.agents,
				codex: {
					...DEFAULT_CONFIG.agents.codex,
					model: "-m {value}",
					thinking: "-r {value}",
					contextWindow: "-c model_context_window={value}",
				},
			},
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: { ...DEFAULT_CONFIG.taskTypes.implement, agent: "pi" },
			},
		};
		// A close ends a work cycle and returns the ticket to open, but its
		// last Handoff's record stays. That record is history; the profile is
		// what the next Enter starts with.
		const secondCycle: Ticket = {
			...SAMPLE_TICKETS[0],
			handoff: {
				agentType: "codex",
				environment: "worktree",
				taskType: "implement",
				model: "old-cycle-model",
				thinking: "high",
				contextWindow: "65536",
				attemptId: "attempt-old-cycle",
				paneId: "pane-old-cycle",
				tabId: "tab-old-cycle",
				workspaceId: "ws-old-cycle",
			},
			handoffCount: 1,
		};
		const props = { config, runner, home, configPath, initialTickets: [secondCycle] };

		await withApp(
			async (setup) => {
				const detail = detailPaneText(setup.captureCharFrame());
				// Each row reads the choice Enter starts: the profiled agent with
				// every setting left to it, in the environment the choice resolves
				// to rather than the one the closed cycle used.
				expect(detail).toContain("Agent: pi");
				expect(detail).toContain("Model: left to agent");
				expect(detail).toContain("Thinking: left to agent");
				expect(detail).toContain("Context: left to agent");
				expect(detail).toContain("Environment: live-worktree");
				// The closed cycle's record shows in none of them.
				expect(detail).not.toContain("old-cycle-model");
				expect(detail).not.toContain("Thinking: high");
				expect(detail).not.toContain("65536");
				expect(detail).not.toContain("Environment: worktree ");

				await pressEnterToHandoff(setup);
				// The handoff that ran is the one the rows showed: the profiled
				// agent, and no setting argument at all.
				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a model rejected by the profiled agent fails and leaves the ticket open", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		runner.set(
			"herdr",
			[
				"agent",
				"start",
				firstAgent,
				"--kind",
				"codex",
				"--pane",
				"pane-1",
				"--",
				"--model",
				"rejected-model",
			],
			{ code: 1, stderr: "error: codex rejected model rejected-model\n" },
		);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: {
					...DEFAULT_CONFIG.taskTypes.implement,
					agent: "codex",
					model: "rejected-model",
				},
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				setup.mockInput.pressEnter();
				const frame = await awaitFrame(
					setup,
					(candidate) => candidate.includes("codex rejected model rejected-model"),
					"the model rejection",
				);
				expect(selectedRow(frame)).toContain("[open]");
				expect(detailPaneText(frame)).toContain("Agent: codex");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("clearing a profiled Model row leaves it to the agent", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: { ...DEFAULT_CONFIG.taskTypes.implement, model: "task-model" },
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the Environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the Task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the Model row", (f) => f.includes("❯ Model"));
				setup.mockInput.pressKey("HOME");
				for (const _ of "task-model") setup.mockInput.pressKey("DELETE");
				const cleared = await awaitFrame(
					setup,
					(frame) => frameText(frame).includes("Model (empty)"),
					"the cleared Model value",
				);
				expect(frameText(cleared)).toContain("Model (empty)");
				await pressEnterToHandoff(setup);

				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).not.toContain("--model");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("clearing a profiled Thinking list row leaves it to the agent", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: { ...DEFAULT_CONFIG.taskTypes.implement, thinking: "low" },
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the Environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the Task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the Model row", (f) => f.includes("❯ Model"));
				await pressArrow(setup, "down", "the Thinking row", (f) => f.includes("❯ Thinking"));
				setup.mockInput.pressKey("DELETE");
				const cleared = await awaitFrame(
					setup,
					(frame) => frameText(frame).includes("Thinking (unset)"),
					"the cleared Thinking value",
				);
				expect(frameText(cleared)).toContain("Thinking (unset)");
				await pressEnterToHandoff(setup);

				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).not.toContain("--thinking");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a model no agent argument can carry fails the handoff and keeps the ticket open", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		// The profile sends its handoffs to an agent that maps no setting, and
		// the default model still resolves onto it.
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			defaultModel: "factory-model",
			agents: { ...DEFAULT_CONFIG.agents, cursor: { kind: "cursor" } },
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: { ...DEFAULT_CONFIG.taskTypes.implement, agent: "cursor" },
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				setup.mockInput.pressEnter();
				const frame = await awaitFrame(
					setup,
					(candidate) => candidate.includes("defines no model setting"),
					"the mismatch reason",
				);
				expect(selectedRow(frame)).toContain("[open]");
				// The handoff failed before its first external step: no workspace,
				// no agent, so the ticket is ready for a retry once the config is
				// fixed.
				expect(runner.calls).toHaveLength(0);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the panel keeps an unmappable model in reach, and clearing it starts the handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			defaultModel: "factory-model",
			agents: { ...DEFAULT_CONFIG.agents, cursor: { kind: "cursor" } },
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: { ...DEFAULT_CONFIG.taskTypes.implement, agent: "cursor" },
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				// The row is not hidden: the value needs a row to be cleared in.
				expect(frameText(opened)).toContain("Model factory-model");
				expect(spanColors(setup, "factory-model")).toEqual([rgb(COLORS.statusWarning)]);
				await press(setup, "j", "the Environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the Task type row", (f) => f.includes("❯ Task type"));
				const selected = await press(setup, "j", "the Model row", (f) => f.includes("❯ Model"));
				// The row's input takes focus on its own render pass: let it land
				// before the edit keys go in.
				await settle(setup);
				// The selected row's guide names the fix instead of the cycle keys.
				expect(frameText(selected)).toContain("no such Agent setting: Backspace clears");
				expect(frameText(selected)).not.toContain("move ↑↓ tab/⇧tab edit");

				setup.mockInput.pressKey("HOME");
				for (const _ of "factory-model") setup.mockInput.pressKey("DELETE");
				// With its value gone the row has nothing left to clear, so it
				// drops back behind the agent's capability.
				const cleared = await awaitFrame(
					setup,
					(frame) => !frameText(frame).includes("Model"),
					"the model row to drop once its value is cleared",
				);
				expect(frameText(cleared)).not.toContain("factory-model");
				await pressEnterToHandoff(setup);

				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"cursor",
					"--pane",
					"pane-1",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a task type thinking default shows in the panel and rides on the start", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				merge: {
					template: "Merge pull request {external-key}.",
					thinking: "low",
					autoClose: false,
				},
			},
		};
		const mergeTicket: Ticket = { ...first, suggestedTaskType: "merge" };
		const props = { config, runner, home, configPath, initialTickets: [mergeTicket] };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				// The thinking row shows the task type default, not the unset hint.
				expect(frameText(opened)).toContain("Thinking low");
				expect(opened).not.toContain("(unset)");

				const settled = await pressEnterToHandoff(setup);
				expect(selectedRow(settled)).toContain("[handed-off]");
				// The default rides on the agent start, where the agent type
				// maps it to its own flag.
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--thinking",
					"low",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("switching the task type re-derives an untouched thinking row", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				merge: {
					template: "Merge pull request {external-key}.",
					thinking: "low",
					autoClose: false,
				},
			},
		};
		const mergeTicket: Ticket = { ...first, suggestedTaskType: "merge" };
		const props = { config, runner, home, configPath, initialTickets: [mergeTicket] };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				// The thinking row shows the suggested task type's default.
				expect(frameText(opened)).toContain("Thinking low");
				// Move to the Task type row (Agent, Environment, Task type) and
				// cycle away from merge. The untouched thinking row re-derives
				// from the new task type, so the row keeps showing what the
				// handoff will run on.
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Task type"));
				const toImplement = await pressArrow(
					setup,
					"right",
					"the task type to wrap to implement",
					(f) => frameText(f).includes("Task type implement"),
				);
				// implement sets no default: the row is left to the agent.
				expect(frameText(toImplement)).toContain("Thinking (unset)");
				// Cycling back restores the default.
				await pressArrow(setup, "right", "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);
				await pressArrow(setup, "right", "the task type to become review", (f) =>
					frameText(f).includes("Task type review"),
				);
				await pressArrow(setup, "right", "the task type to become rework", (f) =>
					frameText(f).includes("Task type rework"),
				);
				const back = await pressArrow(setup, "right", "the task type to become merge", (f) =>
					frameText(f).includes("Task type merge"),
				);
				expect(frameText(back)).toContain("Thinking low");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a touched thinking row survives a task type switch", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				merge: {
					template: "Merge pull request {external-key}.",
					thinking: "low",
					autoClose: false,
				},
			},
		};
		const mergeTicket: Ticket = { ...first, suggestedTaskType: "merge" };
		const props = { config, runner, home, configPath, initialTickets: [mergeTicket] };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				expect(frameText(opened)).toContain("Thinking low");
				// Move to the Thinking row: j walks the list rows, and the arrow
				// passes the free-text Model row.
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Model"));
				await pressArrow(setup, "down", "the row selection to move to the thinking row", (f) =>
					f.includes("❯ Thinking"),
				);
				// Touch the row: cycle the level past its default.
				await pressArrow(setup, "right", "the thinking to become medium", (f) =>
					frameText(f).includes("Thinking medium"),
				);
				// Move back to the Task type row and switch away from merge.
				await pressArrow(setup, "up", "the row selection to move on", (f) => f.includes("❯ Model"));
				await pressArrow(setup, "up", "the row selection to move on", (f) =>
					f.includes("❯ Task type"),
				);
				const switched = await pressArrow(
					setup,
					"right",
					"the task type to wrap to implement",
					(f) => frameText(f).includes("Task type implement"),
				);
				// The explicit choice rides on, not the new task type's default.
				expect(frameText(switched)).toContain("Thinking medium");

				const settled = await pressEnterToHandoff(setup);
				expect(selectedRow(settled)).toContain("[handed-off]");
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toContain("--thinking");
				expect(start?.args).toContain("medium");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the settings rows hide for an agent that does not map them", async () => {
		const runner = new FakeRunner();
		// A fourth agent that maps no setting at all.
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			agents: { ...DEFAULT_CONFIG.agents, cursor: { kind: "cursor" } },
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				// pi maps both settings: both rows are offered.
				await pressArrow(setup, "right", "the agent to become codex", (f) =>
					frameText(f).includes("Agent codex"),
				);
				await pressArrow(setup, "right", "the agent to become claude", (f) =>
					frameText(f).includes("Agent claude"),
				);
				const frame = await pressArrow(setup, "right", "the agent to become cursor", (f) =>
					frameText(f).includes("Agent cursor"),
				);
				// cursor maps no setting: its rows are not offered.
				expect(frame).not.toContain("Model");
				expect(frame).not.toContain("Thinking");
				// The core rows stay.
				expect(frame).toContain("Agent");
				expect(frame).toContain("Environment");
				expect(frame).toContain("Task type");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the task type row cycles through the task types and wraps", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await pressArrow(setup, "right", "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);
				await pressArrow(setup, "right", "the task type to become review", (f) =>
					frameText(f).includes("Task type review"),
				);
				await pressArrow(setup, "right", "the task type to become rework", (f) =>
					frameText(f).includes("Task type rework"),
				);
				// Rework is a shipped task type. The next value wraps to the first.
				const wrapped = await pressArrow(setup, "right", "the task type to wrap back", (f) =>
					frameText(f).includes("Task type implement"),
				);
				expect(frameText(wrapped)).toContain("Task type implement");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the container environment is never offered", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				// Move to the Environment row and cycle through every offered value.
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				// "worktree" alone is a substring of "live-worktree", so the
				// predicates read the row, not the whole frame.
				await pressArrow(setup, "right", "the environment to become worktree", (f) =>
					f.includes("Environment worktree"),
				);
				// Wraps back to live-worktree: only two values exist.
				const wrapped = await pressArrow(setup, "right", "the environment to wrap back", (f) =>
					f.includes("Environment live-worktree"),
				);
				expect(wrapped).not.toContain("container");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("escape cancels the panel without a handoff", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await pressArrow(setup, "right", "the agent to change", (f) => f.includes("codex"));
				setup.mockInput.pressEscape();
				const closed = await awaitFrame(
					setup,
					(f) => !f.includes("Override"),
					"the override panel to close",
				);

				expect(closed).toContain("[open]");
				expect(closed).not.toContain("Override");
				// No command ever ran.
				expect(runner.calls).toHaveLength(0);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("switching the task type re-derives an untouched Context row", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		// A second profile on the same agent, naming another count: the row
		// follows the task type instead of hiding behind an agent.
		const config: FactoryConfig = {
			...contextProfileConfig,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: {
					...DEFAULT_CONFIG.taskTypes.implement,
					agent: "codex",
					model: "gpt-5.6-codex",
					contextWindow: "272000",
				},
				fix: {
					...DEFAULT_CONFIG.taskTypes.fix,
					agent: "codex",
					model: "gpt-5.6-codex",
					contextWindow: "65536",
				},
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				expect(frameText(opened)).toContain("Context 272000");
				// Cycle the Task type row: the untouched Context row takes the
				// new profile's count, so the panel keeps showing what the
				// handoff will run on.
				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				const next = await pressArrow(
					setup,
					"right",
					"the task type to change",
					(f) => !frameText(f).includes("Task type implement"),
				);
				expect(frameText(next)).toContain("Context 65536");

				// A count the operator typed is a one-shot override: it survives
				// the switch back to the profile that names another one.
				await selectRow(setup, "down", "Model");
				await selectRow(setup, "down", "Thinking");
				await selectRow(setup, "down", "Context");
				await settle(setup);
				setup.mockInput.pressKey("END");
				await typeText(setup, "8");
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("Context 655368"),
					"the count the operator typed",
				);
				await selectRow(setup, "up", "Thinking");
				await selectRow(setup, "up", "Model");
				await selectRow(setup, "up", "Task type");
				const back = await pressArrow(setup, "left", "the task type to come back", (f) =>
					frameText(f).includes("Task type implement"),
				);
				expect(frameText(back)).toContain("Context 655368");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the Context row carries the profile's count and takes digits only", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: contextProfileConfig, runner, home, configPath };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				// The profile names the room and its agent maps it, so the row is
				// there and holds the profile's count from the first frame.
				expect(frameText(opened)).toContain("Context 272000");

				// A free-text row owns j and k, so the walk to the last row uses
				// the arrows, which always move.
				const selected = await selectContextRow(setup);
				// The selected row's guide names the characters the row takes.
				expect(frameText(selected)).toContain("0-9");

				// A count is whole digits: a letter typed at the end of the row
				// never reaches the value the agent starts with, and the digits
				// beside it do.
				setup.mockInput.pressKey("END");
				await typeText(setup, "5x");
				const typed = await awaitFrame(
					setup,
					(f) => rowWith(f, "Context").includes("2720005"),
					"the count to take the digit and drop the letter",
				);
				expect(rowWith(typed, "Context")).toContain("2720005");
				expect(typed).not.toContain("5x");

				// A refused character also has to leave the caret where the
				// operator left it: the row is edited from its front here, so a
				// caret that jumped to the end would land every later keystroke
				// after the digits instead of between them.
				setup.mockInput.pressKey("HOME");
				for (const key of ["1", "2", " ", "3"]) {
					setup.mockInput.pressKey(key);
				}
				const inserted = await awaitFrame(
					setup,
					(f) => rowWith(f, "Context").includes("1232720005"),
					"the typed digits to build the count at the caret",
				);
				expect(rowWith(inserted, "Context")).toContain("1232720005");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"codex",
					"--pane",
					"pane-1",
					"--",
					"-m",
					"gpt-5.6-codex",
					"-c",
					"model_context_window=1232720005",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the Context row folds a typed count to one spelling, the way the config does", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: contextProfileConfig, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await selectContextRow(setup);
				// The profile's own count goes first, so the digits below are the
				// only ones the row can hold: a frame that still carried them could
				// never pass this test by accident.
				setup.mockInput.pressKey("HOME");
				for (const _ of "272000") setup.mockInput.pressKey("DELETE");
				await awaitFrame(
					setup,
					(f) => rowWith(f, "Context").includes("(empty)"),
					"the Context row to empty",
				);
				// A count is its value, not its spelling: the row folds the leading
				// zeros the way the config parser folds `007`, so the row shows the
				// one spelling the agent gets.
				await typeText(setup, "007");
				const folded = await awaitFrame(
					setup,
					(f) => contextDigitsOf(f) === "7",
					"the row to hold one spelling of the count",
				);
				expect(frameText(folded)).toContain("Context 7");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toContain("model_context_window=7");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a Context row that holds no count says so, and the handoff refuses it", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: contextProfileConfig, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await selectContextRow(setup);
				// The caret sits at the row's end, where the last key landed, so the
				// deletes have to start at its other end. The empty row below is
				// what proves HOME moved the caret there.
				setup.mockInput.pressKey("HOME");
				for (const _ of "272000") setup.mockInput.pressKey("DELETE");
				await awaitFrame(
					setup,
					(f) => rowWith(f, "Context").includes("(empty)"),
					"the Context row to empty",
				);

				// Digits alone are not yet a count: zero asks an agent for no
				// context at all, so the row wears the warning color and its guide
				// says what the row takes beyond digits, the same rule a config file
				// is held to.
				await typeText(setup, "0");
				const zero = await awaitFrame(
					setup,
					(f) => frameText(f).includes("not a token count"),
					"the row to refuse the zero",
				);
				expect(frameText(zero)).toContain("not a token count: type digits above 0");
				expect(frameText(zero)).toContain("Context 0");

				setup.mockInput.pressEnter();
				const failed = await awaitFrame(
					setup,
					(f) => f.includes("is not a positive whole number of tokens"),
					"the count reason",
				);
				expect(selectedRow(failed)).toContain("[open]");
				expect(runner.calls).toHaveLength(0);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a Context row survives an Agent that cannot map it until it is cleared", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		// pi maps no context window, so the count the profile names has no argv
		// to ride on: the handoff would fail on it.
		const config: FactoryConfig = {
			...contextProfileConfig,
			taskTypes: {
				...contextProfileConfig.taskTypes,
				implement: {
					...contextProfileConfig.taskTypes.implement,
					agent: "pi",
					model: "",
				},
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				const opened = await openPanel(setup);
				// The row is there because the value needs a row to be cleared in,
				// and it warns because the chosen agent cannot carry the count.
				expect(frameText(opened)).toContain("Context 272000");
				expect(spanColors(setup, "272000")).toEqual([rgb(COLORS.statusWarning)]);

				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				await selectRow(setup, "down", "Model");
				await selectRow(setup, "down", "Thinking");
				const selected = await selectRow(setup, "down", "Context");
				await settle(setup);
				expect(frameText(selected)).toContain("no such Agent setting: Backspace clears");

				// Up onto the Agent row, then right onto the agent that maps the
				// count: the draft keeps its value, and the row goes plain.
				await selectRow(setup, "up", "Thinking");
				await selectRow(setup, "up", "Model");
				await selectRow(setup, "up", "Task type");
				await selectRow(setup, "up", "Environment");
				await selectRow(setup, "up", "Agent");
				await pressArrow(setup, "right", "the agent to map the count", (f) =>
					rowWith(f, "Agent").includes("codex"),
				);
				await awaitFrame(
					setup,
					(f) => rowWith(f, "Agent").includes("codex") && frameText(f).includes("Context 272000"),
					"the Context row to return with an agent that maps it",
				);
				expect(spanColors(setup, "272000")).not.toEqual([rgb(COLORS.statusWarning)]);

				// Back onto the agent that cannot map it, then clear the row: the
				// handoff starts and leaves the room to the agent.
				await pressArrow(setup, "left", "the agent to map nothing", (f) =>
					rowWith(f, "Agent").includes("pi"),
				);
				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				await selectRow(setup, "down", "Model");
				await selectRow(setup, "down", "Thinking");
				await selectRow(setup, "down", "Context");
				await settle(setup);
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("Context 272000"),
					"the Context row to come back",
				);
				expect(spanColors(setup, "272000")).toEqual([rgb(COLORS.statusWarning)]);
				setup.mockInput.pressKey("HOME");
				for (const _ of "272000") setup.mockInput.pressKey("DELETE");
				const cleared = await awaitFrame(
					setup,
					(f) => !frameText(f).includes("Context"),
					"the Context row to drop once it is cleared",
				);
				expect(frameText(cleared)).not.toContain("272000");
				await pressEnterToHandoff(setup);
				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a Thinking level the chosen Agent does not offer warns on its row, and fails the handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		// "minimal" is legal for pi, the profile's own agent, so the panel opens
		// on it. zed maps a thinking template but offers only two other levels:
		// cycling the Agent row onto it leaves a value with an argv to ride on
		// and no Agent that takes it.
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			agents: {
				...DEFAULT_CONFIG.agents,
				zed: { kind: "zed", thinking: "-t {value}", thinkingValues: ["off", "low"] },
			},
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				implement: { ...DEFAULT_CONFIG.taskTypes.implement, agent: "pi", thinking: "minimal" },
			},
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				// zed is the last agent the Agent row offers, and the Thinking row
				// sits under the three rows every panel carries.
				const cycleToZed = async (): Promise<void> => {
					for (const target of ["codex", "claude", "zed"]) {
						await pressArrow(setup, "right", `the agent to move to ${target}`, (f) =>
							rowWith(f, "Agent").includes(target),
						);
					}
				};
				const selectThinking = async (): Promise<string> => {
					await selectRow(setup, "down", "Environment");
					await selectRow(setup, "down", "Task type");
					return await selectRow(setup, "down", "Thinking");
				};

				const opened = await openPanel(setup);
				expect(frameText(opened)).toContain("Thinking minimal");
				expect(spanColors(setup, "minimal")).toEqual([rgb(COLORS.text)]);

				await cycleToZed();
				// The row keeps the level and shows it in the warning color. It
				// never reads `(unset)` for a value the handoff will still send.
				const warned = await awaitFrame(
					setup,
					(f) => rowWith(f, "Thinking").includes("minimal"),
					"the Thinking row to keep the level",
				);
				expect(frameText(warned)).not.toContain("Thinking (unset)");
				expect(spanColors(setup, "minimal")).toEqual([rgb(COLORS.statusWarning)]);

				// Its guide names the fix, not the cycle keys.
				const selected = await selectThinking();
				await settle(setup);
				expect(frameText(selected)).toContain("no such level: cycle ←→/hl or Backspace");

				// Confirming a value the Agent does not offer fails the handoff
				// with a readable reason: what the row showed is what the agent
				// would have been started with, and nothing starts at all.
				setup.mockInput.pressEnter();
				const failed = await awaitFrame(
					setup,
					(f) => f.includes('offers no thinking level "minimal"'),
					"the mismatch reason",
				);
				expect(selectedRow(failed)).toContain("[open]");
				expect(runner.calls).toHaveLength(0);

				// The row is reachable, so the value is not stranded: clearing it
				// hands the level back to the agent, and the handoff starts with no
				// thinking argument at all.
				const reopened = await openPanel(setup);
				expect(frameText(reopened)).toContain("Thinking minimal");
				await cycleToZed();
				await selectThinking();
				await settle(setup);
				setup.mockInput.pressKey("BACKSPACE");
				const cleared = await awaitFrame(
					setup,
					(f) => rowWith(f, "Thinking").includes("(unset)"),
					"the Thinking row to hand the level to the agent",
				);
				expect(frameText(cleared)).not.toContain("Thinking minimal");
				await pressEnterToHandoff(setup);
				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"zed",
					"--pane",
					"pane-1",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the free-text model row accepts typed text and confirms the handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				// Move to the Model row (Agent, Environment, Task type, then Model).
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				await setup.mockInput.typeText("gpt-5.6");
				await pressEnterToHandoff(setup);

				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"gpt-5.6",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the selected text field has a focused background and bright text", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the row selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				const frame = await press(setup, "j", "the row selection to reach the model", (f) =>
					f.includes("❯ Model"),
				);
				expect(frameText(frame)).toContain("Model (empty)");

				await setup.mockInput.typeText("gpt");
				await awaitFrame(setup, (f) => frameText(f).includes("Model gpt"), "the model text");
				const captured = setup.captureSpans();
				const modelLine = captured.lines.find((line) =>
					line.spans.some((span) => span.text.includes("gpt")),
				);
				const valueSpan = modelLine?.spans.find((span) => span.text.includes("gpt"));
				expect(valueSpan?.fg.toInts().slice(0, 3)).toEqual(rgb(COLORS.textBright));
				expect(valueSpan?.bg.toInts().slice(0, 3)).toEqual(rgb(COLORS.focusedBackground));
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a non-ASCII model name types into the free-text row and rides on the start", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				// "é" is outside the ASCII range: it must not be dropped.
				await setup.mockInput.typeText("gpt-é");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model gpt-é"),
					"the non-ASCII model to show in the row",
				);
				expect(frameText(frame)).toContain("Model gpt-é");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"gpt-é",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a move and a cycle in the same tick act on the moved row", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				// Both keys are queued before a render: the key parser delivers
				// them in one tick, where a render-closure row would still
				// point at the Agent row.
				setup.mockInput.pressKey("j");
				setup.mockInput.pressArrow("right");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Environment worktree"),
					"the cycle to land on the moved row",
				);
				// The cycle acted on the Environment row, not the Agent row.
				expect(frameText(frame)).toContain("Environment worktree");
				expect(frameText(frame)).not.toContain("Agent codex");
				expect(frame).toContain("❯ Environment");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("Tab and Shift+Tab move from list and text rows", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);

				// Both directions work on a list row.
				setup.mockInput.pressTab();
				await awaitFrame(setup, (f) => f.includes("❯ Environment"), "Tab to move down");
				setup.mockInput.pressTab({ shift: true });
				await awaitFrame(setup, (f) => f.includes("❯ Agent"), "Shift+Tab to move up");

				// Both directions also work when the selected row is a text input.
				await press(setup, "j", "the row selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the row selection to reach the model", (f) =>
					f.includes("❯ Model"),
				);
				setup.mockInput.pressTab({ shift: true });
				await awaitFrame(setup, (f) => f.includes("❯ Task type"), "Shift+Tab from a text row");
				await press(setup, "j", "the row selection to return to the model", (f) =>
					f.includes("❯ Model"),
				);
				setup.mockInput.pressTab();
				await awaitFrame(setup, (f) => f.includes("❯ Thinking"), "Tab from a text row");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a sibling clone hands off, warns, and writes the mapping back to the config file", async () => {
		const runner = new FakeRunner();
		// The convention path holds a different repository.
		const path = checkout();
		runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/portal.git\n",
		});
		const sibling = join(home, "src", "billing_1");
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", sibling, "--no-focus"], {
			stdout: workspaceCreateJson("ws-1"),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", sibling, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const frame = await pressEnterToHandoff(setup);

				// The warning sits on the status line.
				expect(rowsOf(frame)[HEIGHT - 1]).toContain("cloned acme/billing to a sibling");
				// The mapping was written back to the config file.
				const written = readFileSync(configPath, "utf8");
				expect(written).toContain(`[repos]`);
				expect(written).toContain(`"github.com/acme/billing" = "${sibling}"`);
				// The handoff ran at the sibling, not the conflicting path.
				expect(runner.commands()).toContain(`herdr workspace create --cwd ${sibling} --no-focus`);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("e while a handoff is in flight is refused on the status line", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const slow = new DelayedRunner(runner, 400);
		const props = { config: DEFAULT_CONFIG, runner: slow, home, configPath };

		await withApp(
			async (setup) => {
				await pressEnter(setup, "the in-flight status", "handing off");

				// The panel is refused while the handoff is in flight, and the
				// refusal shows on the status line.
				setup.mockInput.pressKey("e");
				const refused = await awaitFrame(
					setup,
					(f) => rowsOf(f)[HEIGHT - 1].includes("handoff in flight"),
					"the refusal on the status line",
				);
				expect(refused).not.toContain("Override");

				// The first handoff still settles.
				await awaitFrame(setup, (f) => selectedIs(f, "[handed-off]"), "the handoff to settle");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a failed mapping write-back warns on the status line", async () => {
		const runner = new FakeRunner();
		// The convention path holds a different repository: a sibling clone.
		const path = checkout();
		runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/portal.git\n",
		});
		const sibling = join(home, "src", "billing_1");
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", sibling, "--no-focus"], {
			stdout: workspaceCreateJson("ws-1"),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", sibling, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});
		// The config file cannot be written: a directory sits at its path.
		mkdirSync(configPath, { recursive: true });
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const frame = await pressEnter(
					setup,
					"the write-back warning to appear",
					"could not persist",
				);

				// The handoff itself succeeded: the ticket is handed off... and
				// the warning sits on the status line.
				expect(selectedRow(frame)).toContain("[handed-off]");
				expect(rowsOf(frame)[HEIGHT - 1]).toContain("could not persist");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("j, k, h, and l type into the selected free-text row", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);

				// "claude" carries an l: the movement keys type, they do not
				// move the selection off the row.
				await setup.mockInput.typeText("claude");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model claude"),
					"the model to carry the typed text",
				);
				expect(frame).toContain("❯ Model");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"claude",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the free-text row moves the caret and inserts at it", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				// A left arrow moves the caret one cell in, so the next typed
				// character lands before the last one, not after it.
				await setup.mockInput.typeText("abcd");
				await setup.mockInput.pressArrow("left");
				await setup.mockInput.typeText("X");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model abcXd"),
					"the insert at the moved caret",
				);
				expect(frameText(frame)).toContain("Model abcXd");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"abcXd",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the free-text row jumps to the ends with Home and End", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				await setup.mockInput.typeText("abcd");
				// Home puts the caret at the start, so the next character lands
				// before the rest. End puts it back at the tail.
				await setup.mockInput.pressKey("HOME");
				await setup.mockInput.typeText("Y");
				await setup.mockInput.pressKey("END");
				await setup.mockInput.typeText("Z");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model YabcdZ"),
					"the Home and End inserts",
				);
				expect(frameText(frame)).toContain("Model YabcdZ");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"YabcdZ",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the free-text row deletes with backspace and forward delete", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				await setup.mockInput.typeText("abcd");
				// Backspace removes the character before the caret.
				await setup.mockInput.pressBackspace();
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model abc "),
					"the backspace to shorten the value",
				);
				// Home, then forward delete, removes the first character.
				await setup.mockInput.pressKey("HOME");
				await setup.mockInput.pressKey("DELETE");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model bc "),
					"the forward delete to remove the first character",
				);
				expect(frameText(frame)).toContain("Model bc ");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"bc",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the free-text row deletes a caret selection", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				await setup.mockInput.typeText("hello");
				// Shift+left twice selects the last two characters, then
				// backspace removes the whole selection at once.
				await setup.mockInput.pressArrow("left", { shift: true });
				await setup.mockInput.pressArrow("left", { shift: true });
				await setup.mockInput.pressBackspace();
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model hel "),
					"the selection to delete the two characters",
				);
				expect(frameText(frame)).toContain("Model hel ");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"hel",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("the free-text row undoes with Ctrl+Z and redoes with Ctrl+Y", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				const isShort = (f: string) =>
					frameText(f).includes("Model hell ") && !frameText(f).includes("Model hello");

				await setup.mockInput.typeText("hello");
				// Backspace drops the final o; Ctrl+Z restores it.
				await setup.mockInput.pressBackspace();
				await awaitFrame(setup, isShort, "the backspace to shorten the value");
				await setup.mockInput.pressKey("z", { ctrl: true });
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model hello"),
					"the undo to restore the value",
				);
				// A second undo takes the value back, and Ctrl+Y puts it forward.
				await setup.mockInput.pressKey("z", { ctrl: true });
				await awaitFrame(setup, isShort, "the second undo to shorten the value");
				await setup.mockInput.pressKey("y", { ctrl: true });
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model hello"),
					"the redo to restore the value",
				);
				expect(frameText(frame)).toContain("Model hello");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"hello",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("bracketed paste works in the free-text Model row of a kind with no model list", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				// codex is an agent kind that reports no Model list, so its Model row
				// stays the standard free-text field (ADR 0010).
				await pressArrow(setup, "right", "the agent to become codex", (f) =>
					frameText(f).includes("Agent codex"),
				);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				const model = await pressArrow(
					setup,
					"down",
					"the row selection to move to the model",
					(f) => f.includes("❯ Model"),
				);
				expect(frameText(model)).toContain("Model (empty)");
				// Only the agent the panel opened on was queried: switching to a
				// kind with no list runs no query of its own.
				expect(runner.modelListCalls).toEqual(["pi"]);

				await setup.mockInput.pasteBracketedText("gpt-5.1\u001b[31m-codex\r\n");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model gpt-5.1-codex"),
					"the sanitized Model paste",
				);
				expect(frameText(frame)).toContain("Model gpt-5.1-codex");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toContain("gpt-5.1-codex");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a bracketed paste is sanitized of ANSI escapes and line breaks", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				// The paste carries an ANSI color and a line break. The field
				// keeps only the plain text: the color and the break are gone.
				await setup.mockInput.pasteBracketedText("\x1b[31mhello\r\nworld\x1b[0m");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model helloworld"),
					"the sanitized paste to land in the row",
				);
				expect(frameText(frame)).toContain("Model helloworld");
				expect(frameText(frame)).not.toContain("\x1b");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					"helloworld",
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("pasting at the start, middle, end, and over a selection edits in place", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				await setup.mockInput.typeText("ab");
				await setup.mockInput.pressKey("HOME");
				await setup.mockInput.pasteBracketedText("S");
				await awaitFrame(setup, (f) => frameText(f).includes("Model Sab"), "the start paste");

				await setup.mockInput.pressKey("END");
				await setup.mockInput.pasteBracketedText("E");
				await awaitFrame(setup, (f) => frameText(f).includes("Model SabE"), "the end paste");

				await setup.mockInput.pressKey("HOME");
				await setup.mockInput.pressArrow("right");
				await setup.mockInput.pasteBracketedText("M");
				await awaitFrame(setup, (f) => frameText(f).includes("Model SMabE"), "the middle paste");

				await setup.mockInput.pressKey("HOME");
				await setup.mockInput.pressArrow("right", { shift: true });
				await setup.mockInput.pasteBracketedText("X");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model XabE"),
					"the paste over a selection",
				);
				expect(frameText(frame)).toContain("Model XabE");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a long free-text value scrolls in its column and hands off whole", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };
		const longValue = "abcdefghijklmnopqrstuv9876543210";

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				// The value is wider than the column. The row keeps one line and
				// scrolls the caret into view, showing the tail of the value.
				await setup.mockInput.typeText(longValue);
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("9876543210"),
					"the value to scroll its tail into view",
				);
				// The head has scrolled out: only the tail is on screen.
				expect(frameText(frame)).not.toContain("abcdefghijklm");
				// The row still fits one terminal line: no wrap, no corruption.
				expect(rowsOf(frame)).toHaveLength(HEIGHT);

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toEqual([
					"agent",
					"start",
					firstAgent,
					"--kind",
					"pi",
					"--pane",
					"pane-1",
					"--",
					"--model",
					longValue,
				]);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("word deletion removes a word in either direction", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				await setup.mockInput.typeText("hello world");
				await setup.mockInput.pressBackspace({ ctrl: true });
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model hello "),
					"the backward word deletion",
				);
				await setup.mockInput.pressKey("HOME");
				await setup.mockInput.pressKey("DELETE", { ctrl: true });
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model (empty)"),
					"the forward word deletion",
				);
				expect(frameText(frame)).toContain("Model (empty)");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("question mark and m type into a selected free-text row", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));
				await setup.mockInput.typeText("?m");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model ?m"),
					"the typed punctuation",
				);
				expect(frameText(frame)).toContain("Model ?m");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("typing and confirming in one tick hands off the complete value", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));

				await setup.mockInput.typeText("gpt");
				setup.mockInput.pressEnter();
				await awaitFrame(setup, (f) => selectedIs(f, "[handed-off]"), "the handoff to settle");
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toContain("gpt");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a text draft survives an agent change and terminal resize", async () => {
		const runner = new FakeRunner();
		const config = {
			...DEFAULT_CONFIG,
			agents: { ...DEFAULT_CONFIG.agents, cursor: { kind: "cursor" } },
		};
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));
				await setup.mockInput.typeText("draft");
				await awaitFrame(setup, (f) => frameText(f).includes("Model draft"), "the draft text");

				// The cursor agent maps no model, but the draft keeps its row in
				// the warning color: a value with no row is a value the operator
				// cannot clear, and the handoff would fail on it out of sight.
				await pressArrow(setup, "up", "the task type row", (f) => f.includes("❯ Task type"));
				await pressArrow(setup, "up", "the environment row", (f) => f.includes("❯ Environment"));
				await pressArrow(setup, "up", "the agent row", (f) => f.includes("❯ Agent"));
				await pressArrow(setup, "right", "the agent to become codex", (f) =>
					frameText(f).includes("Agent codex"),
				);
				await pressArrow(setup, "right", "the agent to become claude", (f) =>
					frameText(f).includes("Agent claude"),
				);
				const unmapped = await pressArrow(setup, "right", "the agent to become cursor", (f) =>
					frameText(f).includes("Agent cursor"),
				);
				expect(frameText(unmapped)).toContain("Model draft");
				expect(spanColors(setup, "draft")).toEqual([rgb(COLORS.statusWarning)]);

				await pressArrow(setup, "right", "the agent to return to pi", (f) =>
					frameText(f).includes("Agent pi"),
				);
				await press(setup, "j", "the row selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the row selection to reach the restored model", (f) =>
					frameText(f).includes("Model draft"),
				);

				setup.resize(24, 8);
				await awaitFrame(setup, (f) => frameText(f).includes("Model"), "the resized panel");
				setup.resize(WIDTH, HEIGHT);
				const restored = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model draft"),
					"the draft after resizing back",
				);
				expect(frameText(restored)).toContain("Model draft");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a short terminal scrolls the rows to keep the selected one on screen", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				// An eight-row terminal holds four of the five panel rows, so the
				// last row is off screen while the first is selected...
				const open = await openPanel(setup);
				expect(frameText(open)).not.toContain("Thinking");

				// ...and pressing down to the last row scrolls the viewport to it.
				await press(setup, "j", "the selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the selection to reach the model", (f) => f.includes("❯ Model"));
				const frame = await pressArrow(
					setup,
					"down",
					"the viewport to reach the thinking row",
					(f) => f.includes("❯ Thinking"),
				);
				// The selected row is on screen, and the first row has scrolled off.
				expect(frameText(frame)).toContain("❯ Thinking");
				expect(frameText(frame)).not.toContain("Agent");
			},
			24,
			8,
			props,
		);
	});

	test("the control guide follows the selected row", async () => {
		const runner = new FakeRunner();
		// The canned list makes the Model row a list row, so its guide reads as a
		// choice row rather than as a text field.
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const listFrame = await openPanel(setup);
				// A list row describes movement and cycling, not text editing.
				expect(frameText(listFrame)).toContain("move ↑↓/jk tab/⇧tab cycle ←→/hl ↵ esc");
				expect(frameText(listFrame)).not.toContain("edit hjkl/←→ paste");

				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				const modelFrame = await press(setup, "j", "the guide to reach the model", (f) =>
					f.includes("❯ Model"),
				);
				// The Model list row describes typing, editing, and cycling.
				expect(frameText(modelFrame)).toContain("↑↓ move type jumps ←→ cycle ⌫ clear ↵/esc");
				expect(frameText(modelFrame)).not.toContain("edit hjkl/←→ paste");

				// Leaving the Model list row takes the arrow, not `j`: on that row
				// `j` is a letter.
				const thinkingFrame = await pressArrow(setup, "down", "the guide to reach Thinking", (f) =>
					f.includes("❯ Thinking"),
				);
				expect(frameText(thinkingFrame)).toContain("↑↓/jk move ←→/hl cycle ⌫ clear ↵/esc");
				expect(frameText(thinkingFrame)).not.toContain("type jumps");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a narrow terminal sizes the panel instead of corrupting rows", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const frame = await openPanel(setup);

				const rows = rowsOf(frame);
				expect(rows).toHaveLength(12);
				for (const row of rows) {
					// No row wraps: every row is exactly one terminal line.
					expect(row.length).toBe(30);
				}

				// Every row keeps its columns: the labels stay intact... and the
				// values truncate to the value column instead of wrapping...
				for (const label of ["Agent", "Environment", "Task type", "Model", "Thinking"]) {
					expect(frameText(frame)).toContain(label);
				}
				expect(frameText(frame)).toContain("Environment live-worktre");
				// ...and the hint row drops when it does not fit.
				expect(frame).not.toContain("j/k move");
			},
			30,
			12,
			props,
		);

		await withApp(
			async (setup) => {
				const frame = await openPanel(setup);

				const rows = rowsOf(frame);
				expect(rows).toHaveLength(8);
				for (const row of rows) {
					expect(row.length).toBe(24);
				}

				// The height cannot show every row initially: Thinking is below
				// the viewport, and the rows above it keep their columns.
				expect(frameText(frame)).toContain("Model");
				expect(frameText(frame)).not.toContain("Thinking");
			},
			24,
			8,
			props,
		);

		await withApp(
			async (setup) => {
				const frame = await openPanel(setup);
				const rows = rowsOf(frame);
				expect(rows).toHaveLength(12);
				for (const row of rows) {
					expect(row.length).toBe(17);
				}
				// Even below the old 18-cell threshold, the selected Agent row
				// retains one visible value cell.
				expect(frameText(frame)).toContain("❯ Agent p");
			},
			17,
			12,
			props,
		);
	});

	/**
	 * The Model list row scenarios, pinned at every panel size (ADR 0010).
	 *
	 * The narrow panel is where a list row has to give cells up, so the clipped
	 * forms, the tail clip, and the guide that carries the loading marker are
	 * pinned there as well as at the default size.
	 */
	function modelListRowScenarios(size: PanelSize): void {
		test(`the Model row cycles the list the selected agent reported (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			// The panel keeps the order the agent reported: pi sorts the list itself.
			runner.setModelList("pi", [
				"anthropic/claude-sonnet-4-5",
				"openai/gpt-5.1",
				"openai/gpt-5.1-codex",
			]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					expect(runner.modelListCalls).toEqual(["pi"]);
					await moveToModelRow(setup);
					// The task type names no model, so the row starts unset.
					expect(frameText(setup.captureCharFrame())).toContain("Model (unset)");

					await pressArrow(setup, "right", "the first model to be offered", (f) =>
						frameText(f).includes("Model anthropic/claude-sonnet-4-5"),
					);
					const second = await pressArrow(
						setup,
						"right",
						"the next model to be offered",
						(f) =>
							frameText(f).includes("Model openai/gpt-5.1 ") ||
							frameText(f).endsWith("openai/gpt-5.1"),
					);
					expect(frameText(second)).toContain("openai/gpt-5.1");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toEqual([
						"agent",
						"start",
						firstAgent,
						"--kind",
						"pi",
						"--pane",
						"pane-1",
						"--",
						"--model",
						"openai/gpt-5.1",
					]);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`typing on the Model row jumps the value to the first model that holds the text (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", [
				"anthropic/claude-haiku-4-5",
				"anthropic/claude-sonnet-4-5",
				"openai/gpt-5.1-codex",
			]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					await moveToModelRow(setup);

					// Case does not matter: the operator typed the family in capitals.
					await setup.mockInput.typeText("SONNET");
					const jumped = await awaitFrame(
						setup,
						(f) => frameText(f).includes("Model anthropic/claude-sonnet-4-5"),
						"the value to jump to the model holding the typed text",
					);
					// The typed text is never displayed: the jumping value is the feedback.
					expect(frameText(jumped)).not.toContain("SONNET");
					// The selection stays on the row: typing never moves it.
					expect(jumped).toContain("❯ Model");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("anthropic/claude-sonnet-4-5");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a letter that matches no model leaves the value, and the arrows then take a match (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", [
				"anthropic/claude-sonnet-4-5",
				"openai/gpt-5.1",
				"openai/gpt-5.1-codex",
			]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					await moveToModelRow(setup);
					await setup.mockInput.typeText("gpt-5.1");
					const jumped = await awaitFrame(
						setup,
						(f) =>
							frameText(f).includes("Model openai/gpt-5.1 ") ||
							frameText(f).endsWith("openai/gpt-5.1"),
						"the value to jump to the first match",
					);
					expect(frameText(jumped)).toContain("openai/gpt-5.1");

					// A letter no model holds extends the run and changes nothing: the
					// value stays on the last match rather than jumping away.
					await setup.mockInput.typeText("q");
					const held = await settle(setup);
					expect(frameText(held)).toContain("openai/gpt-5.1");

					// The arrows select from there, and end the type-ahead run.
					const next = await pressArrow(setup, "right", "the next model to be offered", (f) =>
						frameText(f).includes("openai/gpt-5.1-codex"),
					);
					expect(frameText(next)).toContain("openai/gpt-5.1-codex");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("openai/gpt-5.1-codex");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`backspace clears the Model row and leaves the model to the agent (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					await moveToModelRow(setup);
					await setup.mockInput.typeText("gpt");
					await awaitFrame(
						setup,
						(f) => frameText(f).includes("openai/gpt-5.1"),
						"the jumped model",
					);

					const cleared = await pressArrow(setup, "left", "the row to fall back one model", (f) =>
						frameText(f).includes("Model anthropic/claude-sonnet-4-5"),
					);
					expect(frameText(cleared)).toContain("anthropic/claude-sonnet-4-5");
					const unset = await pressBackspace(setup, "the Model row to clear", (f) =>
						frameText(f).includes("Model (unset)"),
					);
					expect(frameText(unset)).toContain("Model (unset)");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					// A row the operator cleared names no model: the agent starts on its own.
					expect(start?.args).not.toContain("--model");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`the Model row holds a loading marker while the control plane fetches the list (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			runner.holdModelLists();
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					const opened = await openPanel(setup);
					expect(frameText(opened)).toContain("Model (loading...)");

					await moveToModelRow(setup);
					// The row takes no typing while the list is missing: the letters
					// cannot be mistaken for a model the operator meant to choose.
					await setup.mockInput.typeText("sonnet");
					const held = await settle(setup);
					expect(frameText(held)).toContain("Model (loading...)");
					expect(frameText(held)).not.toContain("sonnet");

					// Only movement keys leave the row.
					const thinking = await pressArrow(
						setup,
						"down",
						"the selection to move to Thinking",
						(f) => f.includes("❯ Thinking"),
					);
					expect(frameText(thinking)).toContain("❯ Thinking");

					// The query answers: the row becomes the list it reported.
					runner.releaseModelLists();
					const ready = await pressArrow(setup, "up", "the Model row to hold the list", (f) =>
						f.includes("❯ Model"),
					);
					expect(frameText(ready)).toContain("Model (unset)");
					await pressArrow(setup, "right", "the fetched model to show", (f) =>
						frameText(f).includes("Model anthropic/claude-sonnet-4-5"),
					);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`the Model row says so when the agent reports no models (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", []);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					const opened = await openPanel(setup);
					expect(frameText(opened)).toContain("Model (no models available)");

					await moveToModelRow(setup);
					// Nothing to cycle and nothing to type: the row takes the letters
					// as a run that can never match, so the value stays unset.
					await setup.mockInput.typeText("gpt");
					await pressBackspace(setup, "the row to stay cleared", (f) =>
						frameText(f).includes("Model (no models available)"),
					);
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).not.toContain("--model");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a Model the selected agent cannot run shows in the warning color (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					implement: { ...DEFAULT_CONFIG.taskTypes.implement, model: "gpt-4o" },
				},
			};
			const props = { config, runner, home, configPath };

			await withApp(
				async (setup) => {
					const opened = await openPanel(setup);
					// The task type names a model the agent's own list does not hold:
					// the handoff would fail on it, so the row warns before it can.
					expect(frameText(opened)).toContain("Model gpt-4o");
					expect(spanColors(setup, "gpt-4o")).toEqual([rgb(COLORS.statusWarning)]);
					// The thinking level the task type names is supported, so it stays plain.
					expect(frameText(opened)).toContain("Thinking (unset)");

					// Cycling to a model the agent does hold clears the warning.
					await moveToModelRow(setup);
					await pressArrow(setup, "right", "the row to take a model the agent offers", (f) =>
						frameText(f).includes("Model anthropic/claude-sonnet-4-5"),
					);
					expect(spanColors(setup, "gpt-4o")).toEqual([]);
					// The selected row reads in the bright color, never the warning one.
					expect(spanColors(setup, "anthropic/claude-sonnet-4-5")).toEqual([
						rgb(COLORS.textBright),
					]);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a Model the config prefilled is not judged while its list loads (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
			runner.holdModelLists();
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					implement: { ...DEFAULT_CONFIG.taskTypes.implement, model: "openai/gpt-4o" },
				},
			};
			const props = { config, runner, home, configPath };

			await withApp(
				async (setup) => {
					const opened = await openPanel(setup);
					expect(runner.modelListCalls).toEqual(["pi"]);
					// The row holds the config's own value. It is not judged: the list it
					// would be judged against has not arrived, so a model the config
					// resolved correctly must not read as a handoff that would fail.
					expect(frameText(opened)).toContain("Model openai/gpt-4o");
					expect(paintedIn(setup, "openai/gpt-4o", rgb(COLORS.dim))).toBe(true);

					await moveToModelRow(setup);
					// The guide names the wait, because the row holds a value where an
					// empty one shows the loading marker.
					expect(frameText(setup.captureCharFrame())).toContain("move (loading...)");
					// The row takes no input while it waits.
					await setup.mockInput.typeText("sonnet");
					const held = await settle(setup);
					expect(frameText(held)).toContain("Model openai/gpt-4o");
					expect(frameText(held)).not.toContain("sonnet");

					// The list arrives: the row can judge its value, and says the agent
					// offers it.
					runner.releaseModelLists();
					await awaitPaintedIn(
						setup,
						"openai/gpt-4o",
						rgb(COLORS.textBright),
						"the fetched list to confirm the value",
					);
					expect(frameText(setup.captureCharFrame())).toContain(
						"↑↓ move type jumps ←→ cycle ⌫ clear ↵/esc",
					);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a Thinking level the selected agent does not declare shows in the warning color (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				defaultAgent: "claude",
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					implement: { ...DEFAULT_CONFIG.taskTypes.implement, thinking: "xhigh" },
				},
			};
			const props = { config, runner, home, configPath };

			await withApp(
				async (setup) => {
					const opened = await openPanel(setup);
					expect(frameText(opened)).toContain("Thinking xhigh");
					expect(paintedIn(setup, "xhigh", rgb(COLORS.text))).toBe(true);

					// The agent row is the one selected on open: cycling it left reaches
					// codex, which declares no level above high.
					await pressArrow(setup, "left", "the agent to become codex", (f) =>
						frameText(f).includes("Agent codex"),
					);
					// The level the task type named is one the new agent cannot run, so the
					// handoff would fail on it: the row says so before the operator can.
					expect(frameText(setup.captureCharFrame())).toContain("Thinking xhigh");
					expect(spanColors(setup, "xhigh")).toEqual([rgb(COLORS.statusWarning)]);

					// The row still takes input: the operator can put a level the new agent
					// declares on it, and the warning goes with the old value.
					await moveToThinkingRow(setup);
					await pressArrow(setup, "right", "a level the agent declares", (f) =>
						frameText(f).includes("Thinking minimal"),
					);
					expect(spanColors(setup, "xhigh")).toEqual([]);
					expect(spanColors(setup, "minimal")).toEqual([rgb(COLORS.textBright)]);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`switching the agent keeps an untouched Model and queries the new agent's list (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					implement: { ...DEFAULT_CONFIG.taskTypes.implement, model: "gpt-4o" },
				},
			};
			const props = { config, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					// Each setting resolves on its own chain: the agent row is the only
					// thing cycling it changes, so the task type's model rides on.
					await pressArrow(setup, "right", "the agent to become codex", (f) =>
						frameText(f).includes("Agent codex"),
					);
					expect(frameText(setup.captureCharFrame())).toContain("Model gpt-4o");
					// codex reports no list, so no query runs for it.
					expect(runner.modelListCalls).toEqual(["pi"]);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`switching the task type re-derives an untouched Model row (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					merge: {
						template: "Merge pull request {external-key}.",
						model: "openai/gpt-5.1",
						autoClose: false,
					},
				},
			};
			const mergeTicket: Ticket = { ...first, suggestedTaskType: "merge" };
			const props = { config, runner, home, configPath, initialTickets: [mergeTicket] };

			await withApp(
				async (setup) => {
					const opened = await openPanel(setup);
					expect(frameText(opened)).toContain("Model openai/gpt-5.1");

					await press(setup, "j", "the selection to move to the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await press(setup, "j", "the selection to move to the task type", (f) =>
						f.includes("❯ Task type"),
					);
					// implement names no model: the untouched row re-derives to unset.
					const toImplement = await pressArrow(
						setup,
						"right",
						"the task type to become implement",
						(f) => frameText(f).includes("Task type implement"),
					);
					expect(frameText(toImplement)).toContain("Model (unset)");

					// Cycling back restores the merge profile's model.
					const back = await pressArrow(setup, "right", "the task type to cycle", (f) =>
						frameText(f).includes("Task type fix"),
					);
					expect(frameText(back)).toContain("Model (unset)");
					await pressArrow(setup, "right", "the task type to become review", (f) =>
						frameText(f).includes("Task type review"),
					);
					await pressArrow(setup, "right", "the task type to become rework", (f) =>
						frameText(f).includes("Task type rework"),
					);
					const toMerge = await pressArrow(setup, "right", "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					expect(frameText(toMerge)).toContain("Model openai/gpt-5.1");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("openai/gpt-5.1");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a Model wider than its column shows its end and rides on whole (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			// A real agent list carries one long provider in front of many models:
			// the head of the value says nothing the neighbour's head does not.
			const long =
				"llama-server=http://127.0.0.1:8080/AtomicChat/DeepSeek-V4-Flash-0731-GGUF:IQ1_M_XL";
			runner.setModelList("pi", [long, `${long.slice(0, long.length - 1)}2`]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					await moveToModelRow(setup);
					const shown = await pressArrow(setup, "right", "the long model to show its tail", (f) =>
						frameText(f).includes(`…${long.slice(-(size.valueCells - 1))}`),
					);
					// The value column holds size.valueCells cells: the cut marker plus
					// the rest of the end, and nothing of the shared provider
					// prefix.
					expect(frameText(shown)).not.toContain("llama-server");
					expect(frameText(shown)).not.toContain("AtomicChat");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					// The clip is display only: the handoff names the whole value.
					expect(start?.args).toContain(long);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a failed model list query falls the Model row back to free text (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelListFailure("pi", "network unreachable");
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					const onModel = await moveToModelRow(setup);
					// The fallback keeps the whole input: the caret and the editing keys.
					expect(frameText(onModel)).toContain("Model (empty)");
					// The guide names the cause, so a kind that reports no list and a
					// query that failed do not read the same.
					expect(frameText(onModel)).toContain("↑↓ move edit hjkl/←→ paste ↵/esc (failed)");

					await setup.mockInput.typeText("gpt-4o");
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("gpt-4o");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a Model row the agent's kind cannot list names that cause (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			const config: FactoryConfig = { ...DEFAULT_CONFIG, defaultAgent: "codex" };
			const props = { config, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					const onModel = await moveToModelRow(setup);
					// The row is free text for the same reason the query failure makes it
					// free text, and the guide says which of the two it is.
					expect(frameText(onModel)).toContain("Model (empty)");
					expect(frameText(onModel)).toContain("↑↓ move edit hjkl/←→ paste ↵/esc (none)");
					expect(frameText(onModel)).not.toContain("(failed)");
					// No query ran for a kind that has no list command.
					expect(runner.modelListCalls).toEqual([]);
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a letter that matches nothing restarts the run, so the row keeps answering (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			// The list is shaped so a dead run and a live one cannot be confused:
			// "codex" is reachable only as its own run, never as the tail of "gpt".
			runner.setModelList("pi", [
				"anthropic/claude-sonnet-4-5",
				"openai/gpt-5.1",
				"openai/gpt-5.1-codex",
			]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					await moveToModelRow(setup);
					await setup.mockInput.typeText("gpt");
					await awaitFrame(
						setup,
						(f) => frameText(f).includes("openai/gpt-5.1 "),
						"the first match",
					);

					// "x" ends the run: "gptx" is in no model. The row does not go quiet
					// on the operator there: the failing letter starts a new run, and the
					// only model holding an x jumps into the value.
					const restarted = await setup.mockInput
						.typeText("x")
						.then(() =>
							awaitFrame(
								setup,
								(f) => frameText(f).includes("gpt-5.1-codex"),
								"the run to restart",
							),
						);
					expect(frameText(restarted)).toContain("openai/gpt-5.1-codex");

					// The new run keeps growing from that letter: "5" cannot follow "x",
					// so "5" alone picks the first model that holds it.
					await setup.mockInput.typeText("5");
					const again = await awaitFrame(
						setup,
						(f) => frameText(f).includes("anthropic/claude-sonnet-4-5"),
						"the second restart of the run",
					);
					expect(frameText(again)).toContain("anthropic/claude-sonnet-4-5");

					// A letter no model holds at all is the last case: the value stays
					// where it is, and the row is still answering. "z" starts a run nothing
					// can extend, and the "x" after it starts the next run on a real model.
					await setup.mockInput.typeText("z");
					const held = await awaitFrame(
						setup,
						(f) => frameText(f).includes("anthropic/claude-sonnet-4-5"),
						"the value to hold on a letter nothing holds",
					);
					expect(frameText(held)).toContain("anthropic/claude-sonnet-4-5");
					await setup.mockInput.typeText("x");
					const afterDead = await awaitFrame(
						setup,
						(f) => frameText(f).includes("openai/gpt-5.1-codex"),
						"the row to answer after a letter nothing holds",
					);
					expect(frameText(afterDead)).toContain("openai/gpt-5.1-codex");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					// The value the run left is the value the handoff carries.
					expect(start?.args).toContain("openai/gpt-5.1-codex");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`leaving the Model row ends its type-ahead run (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			// Only the second model holds "z", and only the first holds "q" ahead of it.
			runner.setModelList("pi", ["anthropic/qwen-first", "openai/zq-second"]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					await moveToModelRow(setup);
					await setup.mockInput.typeText("z");
					await awaitFrame(setup, (f) => frameText(f).includes("openai/zq-second"), "the z match");

					// Leave the row and come back: the run the operator built is over.
					await pressArrow(setup, "down", "the selection to reach Thinking", (f) =>
						f.includes("❯ Thinking"),
					);
					await pressArrow(setup, "up", "the selection to return to Model", (f) =>
						f.includes("❯ Model"),
					);

					// "q" alone finds the first model that holds it. Had the run carried
					// over, "zq" would have held the row on the model it was already on.
					const back = await setup.mockInput
						.typeText("q")
						.then(() =>
							awaitFrame(
								setup,
								(f) => frameText(f).includes("anthropic/qwen-first"),
								"a fresh run",
							),
						);
					expect(frameText(back)).toContain("anthropic/qwen-first");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`Delete clears a Model row, like Backspace (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
			const props = { config: DEFAULT_CONFIG, runner, home, configPath };

			await withApp(
				async (setup) => {
					await openPanel(setup);
					await moveToModelRow(setup);
					await setup.mockInput.typeText("gpt");
					await awaitFrame(
						setup,
						(f) => frameText(f).includes("openai/gpt-5.1"),
						"the jumped model",
					);

					// A list row has no caret, so forward delete is the same decision as
					// backspace: leave the setting to the agent.
					const cleared = await pressDelete(setup, "the Model row to clear", (f) =>
						frameText(f).includes("Model (unset)"),
					);
					expect(frameText(cleared)).toContain("Model (unset)");

					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).not.toContain("--model");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a Model the operator typed survives a task type switch (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					merge: {
						template: "Merge pull request {external-key}.",
						model: "openai/gpt-5.1",
						autoClose: false,
					},
				},
			};
			const mergeTicket: Ticket = { ...first, suggestedTaskType: "merge" };
			const props = { config, runner, home, configPath, initialTickets: [mergeTicket] };

			await withApp(
				async (setup) => {
					// Story 15 for the Model row: a typed value counts as the operator's
					// own, because typing is how a list row is chosen.
					await openPanel(setup);
					await moveToModelRow(setup);
					await setup.mockInput.typeText("clau");
					await awaitFrame(
						setup,
						(f) => frameText(f).includes("anthropic/claude-sonnet-4-5"),
						"the typed model",
					);

					await moveToTaskTypeFromModelRow(setup);
					// implement names gpt-5.1-2 and merge names gpt-5.1: a row the
					// operator typed into keeps claude at both stops.
					const switched = await pressArrow(
						setup,
						"right",
						"the task type to become implement",
						(f) => frameText(f).includes("Task type implement"),
					);
					expect(frameText(switched)).toContain("Model anthropic/claude-sonnet-4-5");
					await pressArrow(setup, "left", "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					const backOnModel = await moveToModelRowFromTaskType(setup);
					expect(frameText(backOnModel)).toContain("Model anthropic/claude-sonnet-4-5");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`a Model the operator cleared survives a task type switch (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
			// A list that arrives late shows why an untouched row alone is not enough:
			// the clear is the operator's decision either way.
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					merge: {
						template: "Merge pull request {external-key}.",
						model: "openai/gpt-5.1",
						autoClose: false,
					},
				},
			};
			const mergeTicket: Ticket = { ...first, suggestedTaskType: "merge" };
			const props = { config, runner, home, configPath, initialTickets: [mergeTicket] };

			await withApp(
				async (setup) => {
					// Story 15 for the Model row, with clearing as the only touch: the
					// operator who cleared the profile's model to hand off with the
					// agent's own default must not watch it come back.
					const opened = await openPanel(setup);
					expect(frameText(opened)).toContain("Model openai/gpt-5.1");
					await moveToModelRow(setup);
					await pressBackspace(setup, "the Model row to clear", (f) =>
						frameText(f).includes("Model (unset)"),
					);

					await moveToTaskTypeFromModelRow(setup);
					await pressArrow(setup, "right", "the task type to become implement", (f) =>
						frameText(f).includes("Task type implement"),
					);
					await pressArrow(setup, "right", "the task type to become fix", (f) =>
						frameText(f).includes("Task type fix"),
					);
					await pressArrow(setup, "right", "the task type to become review", (f) =>
						frameText(f).includes("Task type review"),
					);
					await pressArrow(setup, "right", "the task type to become rework", (f) =>
						frameText(f).includes("Task type rework"),
					);
					const toMerge = await pressArrow(setup, "right", "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					// merge names a model, and the row the operator cleared stays cleared.
					expect(frameText(toMerge)).toContain("Model (unset)");
					expect(frameText(toMerge)).not.toContain("Model openai/gpt-5.1");
				},
				size.width,
				size.height,
				props,
			);
		});

		test(`switching the task type re-derives an untouched Agent row (${size.width}x${size.height})`, async () => {
			const runner = new FakeRunner();
			stubCheckout(runner);
			stubLiveHandoff(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			const config: FactoryConfig = {
				...DEFAULT_CONFIG,
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					merge: {
						template: "Merge pull request {external-key}.",
						agent: "claude",
						autoClose: false,
					},
				},
			};
			const mergeTicket: Ticket = { ...first, suggestedTaskType: "merge" };
			const props = { config, runner, home, configPath, initialTickets: [mergeTicket] };

			await withApp(
				async (setup) => {
					// The merge profile names claude, so the agent row starts there: the
					// profile leg of the chain, not `default-agent`.
					const opened = await openPanel(setup);
					expect(frameText(opened)).toContain("Agent claude");
					// claude reports no list, so no query ran for the agent the row opened on.
					expect(runner.modelListCalls).toEqual([]);

					await press(setup, "j", "the selection to reach the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await press(setup, "j", "the selection to reach the task type", (f) =>
						f.includes("❯ Task type"),
					);
					// implement names no agent, so the untouched row follows its profile
					// through the default agent instead of holding claude.
					const toImplement = await pressArrow(
						setup,
						"right",
						"the task type to become implement",
						(f) => frameText(f).includes("Task type implement"),
					);
					expect(frameText(toImplement)).toContain("Agent pi");

					// The operator touches the agent row, and a later switch leaves it be.
					await press(setup, "k", "the selection to reach the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await press(setup, "k", "the selection to reach the agent row", (f) =>
						f.includes("❯ Agent"),
					);
					await pressArrow(setup, "right", "the agent to become codex", (f) =>
						frameText(f).includes("Agent codex"),
					);
					await press(setup, "j", "the selection to reach the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await press(setup, "j", "the selection to reach the task type", (f) =>
						f.includes("❯ Task type"),
					);
					const back = await pressArrow(setup, "right", "the task type to become fix", (f) =>
						frameText(f).includes("Task type fix"),
					);
					expect(frameText(back)).toContain("Agent codex");
					await pressArrow(setup, "right", "the task type to become review", (f) =>
						frameText(f).includes("Task type review"),
					);
					await pressArrow(setup, "right", "the task type to become rework", (f) =>
						frameText(f).includes("Task type rework"),
					);
					const toMerge = await pressArrow(setup, "right", "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					// merge names claude, and the row the operator set keeps codex.
					expect(frameText(toMerge)).toContain("Agent codex");
				},
				size.width,
				size.height,
				props,
			);
		});
	}

	for (const size of PANEL_SIZES) modelListRowScenarios(size);

	test("a hint that does not fit keeps its front, never a cut marker", async () => {
		// 24 columns leaves a row's value six cells, so every hint is cut. A cut
		// hint keeps its front: the cut marker says "the end of a longer name",
		// and a hint is not a name.
		const none = new FakeRunner();
		stubCheckout(none);
		stubLiveHandoff(none);
		none.setModelList("pi", []);
		const held = new FakeRunner();
		stubCheckout(held);
		stubLiveHandoff(held);
		held.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		held.holdModelLists();

		await withApp(
			async (setup) => {
				await openPanel(setup);
				const shown = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model (no mo"),
					"the empty-list hint to show",
				);
				expect(rowLineOf(shown, "Model")).not.toContain("\u2026");
			},
			24,
			8,
			{ config: DEFAULT_CONFIG, runner: none, home, configPath },
		);

		await withApp(
			async (setup) => {
				await openPanel(setup);
				const shown = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model (loadi"),
					"the loading hint to show",
				);
				expect(rowLineOf(shown, "Model")).not.toContain("\u2026");
			},
			24,
			8,
			{ config: DEFAULT_CONFIG, runner: held, home, configPath },
		);
	});

	test("the Thinking row offers the selected agent's levels, and backspace clears it", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = { ...DEFAULT_CONFIG, defaultAgent: "claude" };
		const props = { config, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await moveToThinkingRow(setup);
				expect(frameText(setup.captureCharFrame())).toContain("Thinking (unset)");

				// claude declares low through max, in that order: its row starts on
				// low and never offers minimal or off.
				await pressArrow(setup, "right", "the first level the agent supports", (f) =>
					frameText(f).includes("Thinking low"),
				);
				await press(setup, "l", "the next level", (f) => frameText(f).includes("Thinking medium"));
				await press(setup, "l", "the next level", (f) => frameText(f).includes("Thinking high"));
				await press(setup, "l", "the next level", (f) => frameText(f).includes("Thinking xhigh"));
				const last = await press(setup, "l", "the last level the agent supports", (f) =>
					frameText(f).includes("Thinking max"),
				);
				expect(frameText(last)).toContain("Thinking max");
				expect(frameText(last)).not.toContain("Thinking minimal");
				await press(setup, "l", "the level to wrap to the first", (f) =>
					frameText(f).includes("Thinking low"),
				);

				const cleared = await pressBackspace(setup, "the Thinking row to clear", (f) =>
					frameText(f).includes("Thinking (unset)"),
				);
				expect(frameText(cleared)).toContain("Thinking (unset)");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).not.toContain("--effort");
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});

	test("a failed worktree handoff removes its residue and keeps the ticket open", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubWorktreeHandoff(runner);
		runner.set("herdr", ["agent", "start", firstAgent, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr: "agent name is already used\n",
		});
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				// The value column shows the new kind; "live-worktree" still
				// carries "worktree", so the full row is the predicate.
				await press(setup, "right", "the environment to cycle to worktree", (f) =>
					frameText(f).includes("Environment worktree"),
				);
				const frame = await pressEnter(
					setup,
					"the failure reason to appear",
					"agent name is already used",
				);

				// The reason sits on the status line, the ticket stays open.
				expect(rowsOf(frame)[HEIGHT - 1]).toContain("agent name is already used");
				expect(selectedRow(frame)).toContain("[open]");

				// The residue is removed: the worktree and the branch, so a
				// retry can run.
				const commands = runner.commands();
				expect(commands).toContain("herdr worktree remove --workspace ws-wt");
				expect(commands).toContain(
					`git -C ${checkout()} branch -D factory/${first.externalKey.slice(1)}-${firstAgent}`,
				);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});
});
