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

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { renderPrompt } from "../src/handoff.ts";
import type { CommandResult, CommandRunner } from "../src/runner.ts";
import {
	awaitFrame,
	detailPaneText,
	frameText,
	HEIGHT,
	markerRowOf,
	openPanel,
	press,
	pressArrow,
	rowsOf,
	type Setup,
	settle,
	showsTicket,
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

	test("a task type thinking default shows in the panel and rides on the start", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			taskTypes: {
				...DEFAULT_CONFIG.taskTypes,
				merge: { template: "Merge pull request {external-key}.", thinking: "low" },
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
				merge: { template: "Merge pull request {external-key}.", thinking: "low" },
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
				merge: { template: "Merge pull request {external-key}.", thinking: "low" },
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

	test("the hint row documents the movement, cycle, and typing keys", async () => {
		const runner = new FakeRunner();
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				const frame = await openPanel(setup);
				// Every key group the panel owns is on the hint row: the
				// movement keys, the list cycle keys, and the typed text of
				// the free-text rows. The hint fits the modal untruncated.
				expect(frameText(frame)).toContain("j/k move h/l cycle type text enter esc");
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

				// The height cannot hold every row: the last row, Thinking,
				// drops, and the rows above it keep their columns.
				expect(frameText(frame)).toContain("Model");
				expect(frameText(frame)).not.toContain("Thinking");
			},
			24,
			8,
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
