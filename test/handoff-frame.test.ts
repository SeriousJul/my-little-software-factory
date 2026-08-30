/**
 * The handoff through the real UI: Enter starts it, `e` opens the override
 * panel, failures settle the ticket, and the in-flight state refuses a
 * second handoff.
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

import { DEFAULT_CONFIG } from "../src/config.ts";
import { SAMPLE_TICKETS } from "../src/data/sample-tickets.ts";
import { renderPrompt } from "../src/handoff.ts";
import type { CommandResult, CommandRunner } from "../src/runner.ts";
import {
	awaitFrame,
	detailPaneText,
	HEIGHT,
	markerRowOf,
	press,
	pressArrow,
	rowsOf,
	type Setup,
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
	runner.set("git", ["-C", path, "branch", "--list", `factory/${first.id}-${firstAgent}`], {
		stdout: "",
	});
	runner.set("git", ["-C", path, "rev-parse", "HEAD"], { stdout: "deadbeef\n" });
	runner.set(
		"herdr",
		[
			"worktree",
			"create",
			"--cwd",
			path,
			"--branch",
			`factory/${first.id}-${firstAgent}`,
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
				expect(detail).toContain("Task type: implement");
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
				// The selected ticket never left the open state.
				expect(selectedRow(frame)).toContain("[open]");
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
});

describe("the override panel", () => {
	test("`e` opens the panel, right changes options, enter confirms the handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubWorktreeHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const opened = await press(setup, "e", "the override panel to open", (f) =>
					f.includes("Override"),
				);
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
					`git -C ${checkout()} branch --list factory/${first.id}-${firstAgent}`,
				);
				expect(runner.commands()).toContain(`git -C ${checkout()} rev-parse HEAD`);
				expect(runner.commands()).toContain(
					`herdr worktree create --cwd ${checkout()} --branch factory/${first.id}-${firstAgent} --base deadbeef --no-focus`,
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

	test("an unset thinking row cycles to the first option on the first right", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await press(setup, "e", "the override panel to open", (f) => f.includes("(unset)"));
				// Move to the Thinking row (Agent, Environment, Task type, Model, Thinking).
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the row selection to move on", (f) => f.includes("❯ Model"));
				await press(setup, "j", "the row selection to move to the thinking row", (f) =>
					f.includes("❯ Thinking"),
				);
				// The first right lands on the first option, not the second.
				const frame = await pressArrow(
					setup,
					"right",
					"the thinking to become the first option",
					(f) => !f.includes("(unset)"),
				);
				expect(frame).not.toContain("(unset)");
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
				await press(setup, "e", "the override panel to open", (f) => f.includes("Override"));
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
				await press(setup, "e", "the override panel to open", (f) => f.includes("Override"));
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

	test("the free-text model row accepts typed text and confirms the handoff", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await press(setup, "e", "the override panel to open", (f) => f.includes("Override"));
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
				expect(written).toContain(`"acme/billing" = "${sibling}"`);
				// The handoff ran at the sibling, not the conflicting path.
				expect(runner.commands()).toContain(`herdr workspace create --cwd ${sibling} --no-focus`);
			},
			WIDTH,
			HEIGHT,
			props,
		);
	});
});
