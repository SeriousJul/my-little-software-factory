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
import { COLORS } from "../src/components/theme.ts";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { renderPrompt } from "../src/handoff.ts";
import type { CommandResult, CommandRunner } from "../src/runner.ts";
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
				expect(frameText(selected)).toContain("no such Agent setting: clear it");
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
				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				await selectRow(setup, "down", "Model");
				await selectRow(setup, "down", "Thinking");
				const selected = await selectRow(setup, "down", "Context");
				await settle(setup);
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
					"model_context_window=2720005",
				]);
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
				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				await selectRow(setup, "down", "Model");
				await selectRow(setup, "down", "Thinking");
				await selectRow(setup, "down", "Context");
				await settle(setup);
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
				// says what the row takes, the same rule a config file is held to.
				await typeText(setup, "0");
				const zero = await awaitFrame(
					setup,
					(f) => frameText(f).includes("not a token count"),
					"the row to refuse the zero",
				);
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
				expect(frameText(selected)).toContain("no such Agent setting: clear it");

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
				zed: { kind: "zed", thinking: "-t {value}", thinkingValues: ["off", "on"] },
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
				expect(frameText(selected)).toContain("Agent offers no such value: clear it");

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

	test("bracketed paste works in a free-text Thinking row", async () => {
		const runner = new FakeRunner();
		stubCheckout(runner);
		stubLiveHandoff(runner);
		const props = { config: DEFAULT_CONFIG, runner, home, configPath };

		await withApp(
			async (setup) => {
				await openPanel(setup);
				// codex exposes Thinking as a free-text field rather than a list.
				await pressArrow(setup, "right", "the agent to become codex", (f) =>
					frameText(f).includes("Agent codex"),
				);
				await press(setup, "j", "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await press(setup, "j", "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await press(setup, "j", "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				const thinking = await pressArrow(
					setup,
					"down",
					"the row selection to move to free-text Thinking",
					(f) => f.includes("❯ Thinking"),
				);
				expect(frameText(thinking)).toContain("Thinking (empty)");

				await setup.mockInput.pasteBracketedText("med\u001b[31mium\r\n");
				const frame = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Thinking medium"),
					"the sanitized Thinking paste",
				);
				expect(frameText(frame)).toContain("Thinking medium");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toContain("model_reasoning_effort=medium");
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
				const textFrame = await press(setup, "j", "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				// A text row describes editing and terminal paste, not cycling.
				expect(frameText(textFrame)).toContain("move ↑↓ tab/⇧tab edit hjkl/←→ paste ↵ esc");
				expect(frameText(textFrame)).not.toContain("cycle ←→/hl");
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
