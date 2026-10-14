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

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { panelValueCells } from "../src/components/override-panel.ts";
import type {
	FactoryConfig,
	TaskTypeConfig,
	TicketSourceConfig,
	WorkflowState,
} from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { renderPrompt } from "../src/handoff.ts";
import { agentNameFor } from "../src/naming.ts";
import {
	actionBarRowOf,
	detailPaneText,
	fieldKey,
	frameText,
	frameUntil,
	guideKey,
	HEIGHT,
	listHalfOf,
	markerRowOf,
	messageRowOf,
	pasteText,
	pressControl,
	rgb,
	roleColor,
	rowsOf,
	type Setup,
	settle,
	spanColors,
	startingFaceOf,
	typeText,
	unfitTones,
	WIDTH,
	waitSourceHealthy,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { expectNoCommand } from "./command-assertions.ts";
import { DelayedRunner } from "./delayed-runner.ts";
import { SAMPLE_TICKETS } from "./fact-fixtures.ts";
import {
	type FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
	worktreeCreateJson,
} from "./fake-runner.ts";
import { appOn } from "./panel-app.ts";
import type { Plane, PlaneStanding } from "./plane.ts";

/**
 * The runner's commands with the desktop notification's of one standing
 * warning or error fact left out (ADR 0080): the fact's own command may
 * ride along with the handoff's, and the pinned sequence is the other
 * commands, whatever platform the sender branch picked.
 */
function handoffCommands(runner: FakeRunner): string[] {
	return runner.calls
		.filter(
			(call) =>
				call.command !== "notify-send" &&
				call.command !== "osascript" &&
				call.command !== "powershell",
		)
		.map((call) => `${call.command} ${call.args.join(" ")}`.trim());
}

/** The first sample ticket, the one Enter acts on by default. */
/** The task type's prompt template, asserted: the test's task types carry the prompt form. */
function templateOf(taskType: { template?: string }): string {
	return taskType.template as string;
}

const first = SAMPLE_TICKETS[0];
/** The title slug the branch name carries. */
const firstSlug = "retry-policy-for-webhooks";
/** The herdr name the naming rule gives the first sample Ticket (ADR 0098). */
const firstAgent = agentNameFor(first);

/** The first ticket wearing the merge label, the switch tests' standing. */
const mergeTicket: Ticket = { ...first, labels: ["merge"] };
const firstPrompt = renderPrompt(templateOf(BASE_CONFIG.taskTypes.implement), first);

const billingSource: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/billing"],
	host: "github.com",
};

/** The state that matches the merge label to the merge task type: the state
world derives the suggested task type from the label, so the label stands in
for the old projection's direct override.
*/
const mergeState: WorkflowState = {
	name: "merge",
	taskType: "merge",
	match: { labelsAny: ["merge"] },
};

/**
 * A state that offers the fix task type to any ticket its labels permit.
 *
 * The override panel may cycle onto a task type the ticket's suggestion does
 * not wear; the handoff then needs a state that offers it, or the placement
 * refuses the start (ADR 0045). A label-only match keeps the suggestion of an
 * unlabeled ticket on its fallback while the fix rides on the override.
 */
const toFixState: WorkflowState = {
	name: "to-fix",
	taskType: "fix",
	match: { labelsAny: ["to-fix"] },
};

/**
 * A state that offers the implement task type to any ticket its labels
 * permit, beside mergeState: a task type switch that leaves merge needs a
 * state that offers the chosen type, or the placement refuses the start
 * (ADR 0045). A label-only match keeps the merge suggestion on its label.
 */
const toImplementState: WorkflowState = {
	name: "to-implement",
	taskType: "implement",
	match: { labelsAny: ["to-implement"] },
};

const seatOpenConfig: FactoryConfig = {
	...BASE_CONFIG,
	maxParallelAgents: 3,
	workflowStates: [...BASE_CONFIG.workflowStates, toFixState],
};

/** Stub the git answers for a healthy convention checkout. */
function stubCheckout(runner: FakeRunner, path: string): void {
	runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
}

/** Stub a successful live-worktree handoff at the convention checkout. */
function stubLiveHandoff(runner: FakeRunner, path: string): void {
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", path, "--no-focus"], {
		stdout: workspaceCreateJson("ws-1"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", path, "--no-focus"], {
		stdout: tabCreateJson("pane-1"),
	});
}

/** Stub a successful worktree handoff at the convention checkout. */
function stubWorktreeHandoff(runner: FakeRunner, path: string): void {
	runner.set(
		"git",
		["-C", path, "branch", "--list", `factory/${first.externalKey.slice(1)}-${firstSlug}`],
		{
			stdout: "",
		},
	);
	// The worktree base rule: the origin/HEAD symref names the default
	// branch and the fetch of its single ref succeeds, so the base is the
	// fetched remote ref.
	runner.set("git", ["-C", path, "symbolic-ref", "refs/remotes/origin/HEAD"], {
		stdout: "refs/remotes/origin/main\n",
	});
	runner.set(
		"herdr",
		[
			"worktree",
			"create",
			"--cwd",
			path,
			"--branch",
			`factory/${first.externalKey.slice(1)}-${firstSlug}`,
			"--base",
			"origin/main",
			"--no-focus",
		],
		{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
	);
}

/** The mapping the handoff frames stand on: the billing checkout under the home. */
const BILLING_REPOS: Record<string, string> = { "github.com/acme/billing": "src/billing" };

/**
 * The billing checkout the frames map, stubbed under the home; the path it
 * returns stands beside the handoff stubs that take it.
 */
function stubBillingCheckout(fake: FakeRunner, home: string): string {
	const path = join(home, "src", "billing");
	stubCheckout(fake, path);
	return path;
}

/** The live handoff beside the billing checkout. */
function liveBillingCheckout(fake: FakeRunner, home: string): void {
	const path = stubBillingCheckout(fake, home);
	stubLiveHandoff(fake, path);
}

/**
 * Walk the panel selection from its first row down to the Model row.
 *
 * The rows come in order, so three moves reach it whatever the agent maps.
 */
async function moveToModelRow(setup: Setup): Promise<string> {
	await guideKey(setup, "move-list", "j", { quiet: true });
	await frameUntil(setup, "the selection to move to the environment", (f) =>
		f.includes("❯ Environment"),
	);
	await guideKey(setup, "move-list", "j", { quiet: true });
	await frameUntil(setup, "the selection to move to the task type", (f) =>
		f.includes("❯ Task type"),
	);
	await guideKey(setup, "move-list", "j", { quiet: true });
	return frameUntil(setup, "the selection to move to the model", (f) => f.includes("❯ Model"));
}

/**
 * The Model row's search line as the terminal holds it, without its label.
 *
 * The frame's whitespace collapse cannot show an empty field, so this probe
 * reads the row itself: an operator who cleared the query sees nothing after
 * the label, and that is the fact a test has to tell apart from a stale one.
 */
const searchRowOf = (frame: string): string => {
	const row = rowsOf(frame).find((line) => line.includes("Search"));
	if (row === undefined) return "";
	const at = row.indexOf("Search") + "Search".length;
	return (row.slice(at).match(/^\S*/u)?.[0] ?? "").trim();
};

/**
 * Type into the Model row's visible search.
 *
 * The search is a field, so the operator's letters go into it and nothing else:
 * the panel dispatches no control for a printable key while the Model row holds
 * the cursor.
 */
async function typeModelSearch(setup: Setup, text: string): Promise<void> {
	await typeText(setup, text);
}

/** Walk the panel selection down to the Thinking row, below the Model row. */
async function moveToThinkingRow(setup: Setup): Promise<string> {
	await moveToModelRow(setup);
	await guideKey(setup, "move-list", "↓", { quiet: true });
	return frameUntil(setup, "the selection to move to the thinking row", (f) =>
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
 * whole 30-cell column it wants. 46x27 is the narrow panel that still holds
 * its guide row: the value column shrinks, so a real model name
 * reaches the clip boundary and the guide that carries the loading marker is
 * still on screen. The height is the terminal's own floor - the three Main
 * sections at their minimum - so the panel cannot boot below it.
 * Below the width the guide drops out of the panel, so a hint is
 * pinned at its own tiny size instead.
 *
 * The value column comes from `panelValueCells`, so a geometry change moves the
 * assertions with it instead of leaving a hand-copied width behind.
 */
const PANEL_SIZES: readonly PanelSize[] = [
	{ width: WIDTH, height: HEIGHT, valueCells: panelValueCells(WIDTH, HEIGHT) },
	{ width: 46, height: 27, valueCells: panelValueCells(46, 27) },
];

/** The panel row that shows one label, for a check that runs on one row alone. */
function _rowLineOf(frame: string, label: string): string {
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
	return frameUntil(setup, what, () => paintedIn(setup, text, color));
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
	fieldKey(setup, "backspace");
	return frameUntil(setup, what, predicate);
}

/** Press forward Delete, and wait for the effect it should produce. */
async function pressDelete(
	setup: Setup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	fieldKey(setup, "delete");
	return frameUntil(setup, what, predicate);
}

/**
 * Walk from the task type row to the Model row just below it.
 *
 * A task type switch is what the test drives, and the Model row is the value it
 * must not re-derive, so the two rows are walked between by name.
 */
async function moveToModelRowFromTaskType(setup: Setup): Promise<string> {
	await guideKey(setup, "move-list", "↓", { quiet: true });
	return frameUntil(setup, "the selection to move to the model", (f) => f.includes("❯ Model"));
}

/** Walk from the Model row up to the task type row above it. */
async function moveToTaskTypeFromModelRow(setup: Setup): Promise<string> {
	await guideKey(setup, "move-list", "↑", { quiet: true });
	return frameUntil(setup, "the selection to move to the task type", (f) =>
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

/**
 * Walk from the standing's first row to the first open Ticket, the
 * sample row the old projection's first row stood for.
 */
/** The below-minimum frame draws no list, so the same walk goes by row count. */
async function blindWalkToFirstOpen(setup: Setup): Promise<void> {
	for (let i = 0; i < 3; i += 1) {
		await guideKey(setup, "move-list", "j", { quiet: true });
		await settle(setup);
	}
}

async function walkToFirstOpen(setup: Setup): Promise<string> {
	let frame = setup.captureCharFrame();
	for (let i = 0; i < 8; i += 1) {
		// The first open row is the sample the old projection's first row stood
		// for: the rows ahead of it wear their states, not an open badge.
		if (selectedRow(frame).includes("[open]")) return frame;
		await guideKey(setup, "move-list", "j", { quiet: true });
		frame = await settle(setup);
	}
	throw new Error("never reached the first open Ticket");
}

/**
 * True when the selected ticket's handoff has settled in its own row.
 *
 * The Starting window's spinner face (ADR 0030) wears the row from the
 * keypress, so the face says the key registered and only the Working line
 * clearing under it says the settle landed. A failed settle shows its
 * reason instead of clearing, so the face there reads with the error, and
 * the predicate stays false until the line the settle leaves sits on the
 * Message line.
 */
const handoffSettled = (frame: string): boolean =>
	startingFaceOf(selectedRow(frame)) !== null && !messageRowOf(frame).includes("Working:");

/** The handoff's own key: Enter on the row, settled to its named status. */
async function handoffEnter(setup: Setup, what: string, text: string): Promise<string> {
	await guideKey(setup, "handoff", "Enter", { quiet: true });
	return frameUntil(setup, what, (frame) => frame.includes(text));
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
	await guideKey(setup, "move-list", direction === "up" ? "↑" : "↓", { quiet: true });
	return frameUntil(setup, `the ${label} row to be selected`, (f) => f.includes(`❯ ${label}`));
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

const contextProfileConfig: FactoryConfig = {
	...BASE_CONFIG,
	maxParallelAgents: 3,
	agents: {
		...BASE_CONFIG.agents,
		codex: {
			...BASE_CONFIG.agents.codex,
			model: "-m {value}",
			thinking: "-r {value}",
			contextWindow: "-c model_context_window={value}",
		},
	},
	taskTypes: {
		...BASE_CONFIG.taskTypes,
		implement: {
			...BASE_CONFIG.taskTypes.implement,
			agent: "codex",
			model: "gpt-5.6-codex",
			contextWindow: "272000",
		},
	},
};

async function pressEnterToHandoff(setup: Setup): Promise<string> {
	await guideKey(setup, "handoff", "Enter", { quiet: true });
	return frameUntil(setup, "the selected ticket to settle", handoffSettled);
}

/**
 * The panel stands on the first open ticket: the boot settled, the source
 * is healthy, and the selection reached the open row, where the override
 * key opens the panel.
 */
async function openPanel(setup: Setup, planeRecord: Plane): Promise<void> {
	planeRecord.settleFirstFetch();
	await waitSourceHealthy(planeRecord.state);
	await walkToFirstOpen(setup);
	await guideKey(setup, "override", "e", { quiet: true });
}

/**
 * The standing the in-flight tests use: a delayed runner keeps the start
 * pending across the window the test's walk needs.
 */
const delayedStanding = (delayMs: number, limit: number): PlaneStanding => ({
	config: seatOpenConfig,
	runner: (fake) => new DelayedRunner(fake, delayMs, limit),
	repos: BILLING_REPOS,
	commands: liveBillingCheckout,
});

/**
 * One step of the selection walk while a handoff is in flight: settle first
 * so the key never lands in a re-sort, and press again, a bounded number of
 * times, until the named fact is painted.
 */
async function walkStep(
	setup: Setup,
	key: string,
	pred: (f: string) => boolean,
	what: string,
): Promise<void> {
	for (let i = 0; i < 5; i += 1) {
		await settle(setup);
		await guideKey(setup, "move-list", key, { quiet: true });
		try {
			await frameUntil(setup, what, pred);
			return;
		} catch {
			// The step fell into a drop window; press again.
		}
	}
	throw new Error(`never reached ${what}`);
}

/** The agent start call a settled handoff sent, with its argument list. */
const startArgsOf = (runner: FakeRunner): readonly unknown[] | undefined => {
	const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
	return start?.args;
};

/** The start arguments a handoff of the standing agent sends for a model. */
const modelStartArgs = (model: string): string[] => [
	"agent",
	"start",
	firstAgent,
	"--kind",
	"pi",
	"--pane",
	"pane-1",
	"--",
	"--model",
	model,
];

/**
 * The standing config with the implement task type overridden.
 *
 * The panel scenarios stand the plane on one such config each; the helper
 * keeps the shape in one place so a standing change moves one line.
 */
function configWith(
	implement: Partial<TaskTypeConfig>,
	extra: Partial<FactoryConfig> = {},
): FactoryConfig {
	return {
		...BASE_CONFIG,
		maxParallelAgents: 3,
		...extra,
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			implement: { ...BASE_CONFIG.taskTypes.implement, ...implement },
		},
	};
}

/**
 * The standing config with a merge task type on the base's states.
 *
 * The switch tests stand the plane on one such config each; the helper
 * keeps the shape in one place so a standing change moves one line.
 */
function mergeConfig(
	merge: Partial<TaskTypeConfig>,
	states: WorkflowState[] = [mergeState],
): FactoryConfig {
	return {
		...BASE_CONFIG,
		maxParallelAgents: 3,
		workflowStates: [...BASE_CONFIG.workflowStates, ...states],
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			merge: {
				template: "Merge pull request {external-key}.",
				...merge,
			},
		},
	};
}

describe("the Enter handoff", () => {
	test("hands the selected ticket off with the defaults, settles it, and records the command sequence", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				const checkout = join(planeRecord.home, "src", "billing");

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				const frame = await pressEnterToHandoff(setup);
				// The selected ticket settled in the list, its row wearing
				// the Starting window's face where the badge used to stand...
				expect(startingFaceOf(selectedRow(frame))).not.toBeNull();
				// ...and the detail pane carries the handoff facts.
				const detail = detailPaneText(frame);
				expect(detail).toContain("Agent: pi");
				expect(detail).toContain("Environment: live-worktree");
				// The detail line says the value is the handoff's, not a
				// suggestion.
				expect(detail).toContain("Handoff task type: implement");
				// A clean handoff leaves no Working word. The plane's settle reports
				// the start on the Message line, where the old projection left none.
				expect(frame).not.toContain("handing off");
				expect(messageRowOf(frame)).toContain("started from the Work queue");
				expect(rowsOf(frame)[HEIGHT - 3].startsWith("└")).toBe(true);
				// The plane's boot probes the checkout once; the handoff then reads
				// it again, so the read pair stands twice in the record.
				expect(runner.commands()).toEqual([
					`git -C ${checkout} rev-parse --git-dir`,
					`git -C ${checkout} remote get-url origin`,
					`git -C ${checkout} rev-parse --git-dir`,
					`git -C ${checkout} remote get-url origin`,
					"herdr workspace list",
					`herdr workspace create --cwd ${checkout} --no-focus`,
					`herdr tab create --workspace ws-1 --cwd ${checkout} --no-focus`,
					`herdr agent start ${firstAgent} --kind pi --pane pane-1`,
					`herdr agent prompt ${firstAgent} ${firstPrompt}`,
				]);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a failed herdr step leaves the ticket open and shows the reason", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					stubBillingCheckout(fake, home2);
					fake.set("herdr", ["workspace", "list"], {
						code: 1,
						stderr: "error: herdr is not running\n",
					});
				},
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				const frame = await handoffEnter(
					setup,
					"the failure reason to appear",
					"error: herdr is not running",
				);
				// The reason sits on the permanent Message line.
				expect(messageRowOf(frame)).toContain("error: herdr is not running");
				// The selected ticket never left the open state, and a failed
				// attempt is not a handoff: the row still wears the suggestion,
				// and the detail says so.
				const row = listHalfOf(selectedRow(frame));
				expect(row).toContain("[open]");
				expect(row).toContain("[implement]");
				expect(detailPaneText(frame)).toContain("Suggested task type: implement");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("an unreadable workspace list fails with a reason and creates no workspace", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					stubBillingCheckout(fake, home2);
					fake.set("herdr", ["workspace", "list"], { stdout: "not a workspace list\n" });
				},
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				// The plane's drop warning wraps the machine reason: the line the
				// terminal holds names the failed read, cut where the width ends.
				const frame = await handoffEnter(
					setup,
					"the failure reason to appear",
					"herdr workspace list did not return",
				);
				// The reason sits on the permanent Message line; the Ticket stays open...
				expect(messageRowOf(frame)).toContain("was not run: herdr workspace list did not return");
				expect(selectedRow(frame)).toContain("[open]");
				// ...and no second workspace is created for the checkout:
				// unreadable is not "no workspace".
				expectNoCommand(runner.commands(), "workspace create");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("enter on a non-open ticket opens the Live view and issues no handoff command", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					const _path = join(home2, "src", "billing");
					fake.set(
						"herdr",
						[
							"agent",
							"read",
							"pane-implement",
							"--lines",
							"200",
							"--source",
							"recent-unwrapped",
							"--format",
							"text",
						],
						{ stdout: "the agent is editing the layout math\n" },
					);
				},
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				// The second sample ticket is already handed off; the standing's
				// two live rows stand ahead of it in the list.
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the running ticket", (f) =>
					selectedRow(f).includes("Migrate scheduler"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the handed-off ticket", (f) =>
					selectedRow(f).includes("Fix pan drift"),
				);
				// Enter opens the Live view, which streams the agent's output. No
				// handoff starts, and nothing focuses before the Goto confirms.
				await pressControl(setup, "live-view", { quiet: true });
				await frameUntil(setup, "the Live view", (f) =>
					f.includes("Live: Fix pan drift in split panes"),
				);
				expect(runner.commands()).toContain(
					"herdr agent read pane-implement --lines 200 --source recent-unwrapped --format text",
				);
				expect(runner.commands().join("\n")).not.toContain("agent focus");
				await frameUntil(setup, "the stream", (f) =>
					f.includes("the agent is editing the layout math"),
				);
				// Esc closes the view; the ticket stays where it is.
				await guideKey(setup, "cancel-action", "Esc", { quiet: true });
				const closed = await frameUntil(setup, "the view to close", (f) => !f.includes("Live:"));
				expect(startingFaceOf(selectedRow(closed))).not.toBeNull();

				// The override panel is refused the same way: e shows the hint.
				await guideKey(setup, "override", "e", { quiet: true });
				const refused = await settle(setup);
				expect(refused).not.toContain("❯ Agent");
				expect(messageRowOf(refused)).toContain("only an open Ticket can be handed off");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a filesystem error on the clone path shows the reason and keeps the app alive", async () => {
		// A file where ~/src should be: mkdir cannot create the clone parent.
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				const frame = await frameUntil(setup, "the clone failure reason", (f) =>
					messageRowOf(f).includes("cannot create"),
				);
				// The reason sits on the Message line, the ticket stays open,
				// and the handoff ran no command of its own: the failure is
				// before git clone, and the fact's own desktop notification
				// (ADR 0080) is the one command it may send. With the checkout
				// path broken, the plane's boot probe sends no git either.
				expect(selectedRow(frame)).toContain("[open]");
				expect(handoffCommands(runner)).toHaveLength(0);
				// Repair the filesystem: the clone can succeed now.
				rmSync(join(planeRecord.home, "src"), { recursive: true, force: true });
				mkdirSync(join(planeRecord.home, "src"));
				stubLiveHandoff(runner, join(planeRecord.home, "src", "billing"));
				runner.set(
					"git",
					[
						"clone",
						"https://github.com/acme/billing.git",
						join(planeRecord.home, "src", "billing"),
					],
					{
						code: 0,
					},
				);
				// The in-flight guard cleared and the app is alive: a retry on
				// the same ticket runs the handoff to completion.
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				const settled = await frameUntil(setup, "the retry to settle", handoffSettled);
				// The retry re-resolved the repository: the clone ran this time.
				expect(runner.commands()).toContain(
					`git clone https://github.com/acme/billing.git ${join(planeRecord.home, "src", "billing")}`,
				);
				// A clean handoff clears the Message line: the failure reason
				// is gone.
				expect(settled).not.toContain("cannot create");
				// Keys still move the selection. The retry moved the ticket up to
				// the running band and the cursor rides its old row index, so one
				// step down lands on the standing ticket that wears the face.
				const moved = await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the selection to move on", (f) =>
					listHalfOf(selectedRow(f)).includes("Fix pan drift"),
				);
				expect(selectedRow(moved)).toContain("Fix pan drift");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
			(planeRecord) => {
				rmSync(join(planeRecord.home, "src"), { recursive: true, force: true });
				writeFileSync(join(planeRecord.home, "src"), "a file");
			},
		);
	}, 20000);
});

describe("the in-flight guard", () => {
	test("a second Enter while a handoff is in flight starts nothing", async () => {
		await appOn(
			delayedStanding(400, 3),
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				await handoffEnter(setup, "the in-flight status", "handing off");
				// The handoff is in flight. Try to start another one.
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				const frame = await pressEnterToHandoff(setup);
				// Exactly one handoff ran, not two: the refusal's fact sends its
				// own desktop notification (ADR 0080), and the pinned sequence is
				// the handoff's own commands.
				// The plane's boot probes the checkout, and the handoff reuses the
				// remote the probe already resolved, so the read pair's width in
				// the record varies with the boot. The guard's own fact is the
				// start: exactly one, not two.
				const starts = runner.calls.filter(
					(c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "start",
				);
				expect(starts).toHaveLength(1);
				// The status cleared after the handoff settled.
				expect(frame).not.toContain("handing off");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("two Enters in one tick start one handoff", async () => {
		await appOn(
			delayedStanding(400, 3),
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				// Both Enters are queued before a render: the key parser
				// delivers them in one tick, where a state-based guard would
				// still read the stale value and let both through.
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				await pressEnterToHandoff(setup);
				// Exactly one handoff ran, not two: one agent start. The raw
				// command count carries the plane's boot probes and its cached
				// reads, so the start itself is the pin.
				expect(
					runner.calls.filter(
						(c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "start",
					),
				).toHaveLength(1);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("j and k keep moving the selection while a handoff is in flight", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				// Every early command is delayed a beat, so the flight outlives the
				// walk: whichever command the start waits on, the run itself
				// stretches over the window the walk needs.
				runner: (fake) => new DelayedRunner(fake, 800, 12),
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				await handoffEnter(setup, "the in-flight status", "handing off");
				// The cursor walks one sequence: the ticket rows, the
				// Consultations, and the Work queue's item. While the start is
				// pending, the flight row stands last of the tickets, so j
				// steps off it down into the queue's own item, and k climbs
				// back up onto it. Each step settles before pressing, a key
				// sent into a re-sort being dropped, and re-presses a bounded
				// number of times.
				await walkStep(setup, "j", (f) => f.includes("Enter Recovery"), "the queue item's row");
				await walkStep(
					setup,
					"k",
					(f) => listHalfOf(selectedRow(f)).includes("starting"),
					"the flight row",
				);
				// The first handoff still settles, on the ticket it started on.
				await frameUntil(setup, "the handoff to settle", handoffSettled);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);
});

describe("the override panel", () => {
	test("`e` opens the panel, right changes options, enter confirms the handoff", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					const p = stubBillingCheckout(fake, home2);
					stubWorktreeHandoff(fake, p);
				},
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				const checkout = join(planeRecord.home, "src", "billing");

				await openPanel(setup, planeRecord);
				const opened = await settle(setup);
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
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to become codex", (f) => f.includes("codex"));
				// Environment: live-worktree -> worktree.
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(
					setup,
					"the environment to become worktree",
					(f) => !f.includes("live-worktree"),
				);
				// Confirm.
				const settled = await pressEnterToHandoff(setup);
				const detail = detailPaneText(settled);
				expect(detail).toContain("Agent: codex");
				expect(detail).toContain("Environment: worktree");
				// The worktree sequence ran, based on the fetched remote default
				// branch, not a default.
				expect(runner.commands()).toContain(
					`git -C ${checkout} branch --list factory/${first.externalKey.slice(1)}-${firstSlug}`,
				);
				expect(runner.commands()).toContain(
					`git -C ${checkout} symbolic-ref refs/remotes/origin/HEAD`,
				);
				expect(runner.commands()).toContain(`git -C ${checkout} fetch origin main`);
				expect(runner.commands()).toContain(
					`herdr worktree create --cwd ${checkout} --branch factory/${first.externalKey.slice(1)}-${firstSlug} --base origin/main --no-focus`,
				);
				expect(runner.commands()).toContain(
					`herdr agent start ${firstAgent} --kind codex --pane pane-wt`,
				);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("an override that differs from the suggestion rides on the handoff", async () => {
		// The delay holds the pipeline before agent start, so the in-flight
		// handoff is visible while it is not yet recorded.
		await appOn(
			delayedStanding(800, 3),
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				// The open ticket wears its suggestion, and the detail says so.
				expect(listHalfOf(selectedRow(setup.captureCharFrame()))).toContain("[implement]");
				expect(detailPaneText(setup.captureCharFrame())).toContain(
					"Suggested task type: implement",
				);
				// Override the task type to fix.
				await guideKey(setup, "override", "e", { quiet: true });
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);
				// Confirm. The handoff is in flight, but the agent has not
				// started: the override stays provisional, and the list keeps
				// showing the suggestion.
				await guideKey(setup, "confirm-choice", "Enter", { quiet: true });
				const inFlight = await frameUntil(setup, "the in-flight handoff", (frame) =>
					frame.includes("handing off"),
				);
				const row = listHalfOf(selectedRow(inFlight));
				// The Starting window takes the state badge's slot on the
				// keypress (ADR 0030)... while the list keeps showing the
				// suggestion beside it.
				expect(startingFaceOf(row)).not.toBeNull();
				expect(row).toContain("[implement]");
				expect(detailPaneText(inFlight)).toContain("Suggested task type: implement");
				// Once the handoff settles, the row and the detail wear the
				// overridden task type, not the suggestion.
				const settled = await frameUntil(setup, "the handoff to settle", handoffSettled);
				const settledRow = listHalfOf(selectedRow(settled));
				expect(settledRow).toContain("[fix]");
				expect(settledRow).not.toContain("[implement]");
				expect(detailPaneText(settled)).toContain("Handoff task type: fix");
				// The override drove the prompt too.
				const fixPrompt = renderPrompt(templateOf(BASE_CONFIG.taskTypes.fix), first);
				expect(runner.commands()).toContain(`herdr agent prompt ${firstAgent} ${fixPrompt}`);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a failure after agent start keeps the actual task type on the row", async () => {
		const fixPrompt = renderPrompt(templateOf(BASE_CONFIG.taskTypes.fix), first);
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					liveBillingCheckout(fake, home2);
					fake.set("herdr", ["agent", "prompt", firstAgent, fixPrompt], {
						code: 1,
						stderr: "error: the agent is not accepting prompts\n",
					});
				},
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				// Override the task type to fix, then hand off.
				await guideKey(setup, "override", "e", { quiet: true });
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);
				const frame = await pressEnterToHandoff(setup);
				// The agent started, so the handoff is recorded even though
				// the prompt did not get through: the row and the detail keep
				// the actual overridden task type.
				const row = listHalfOf(selectedRow(frame));
				expect(startingFaceOf(row)).not.toBeNull();
				expect(row).toContain("[fix]");
				expect(detailPaneText(frame)).toContain("Handoff task type: fix");
				// The prompt failure still shows its reason.
				expect(frame).toContain("the prompt failed");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("an unset thinking row cycles to the first option on the first right", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				// Move to the Thinking row (Agent, Environment, Task type, Model, Thinking).
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Environment"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Model"));
				// The Model row is free text: j would type into it, so the arrow
				// moves the selection past it.
				await guideKey(setup, "move-list", "↓", { quiet: true });
				const frame = await frameUntil(
					setup,
					"the row selection to move to the thinking row",
					(f) => f.includes("❯ Thinking"),
				);
				// The arrow moved the selection; nothing was typed into the row.
				expect(frameText(frame)).toContain("Model (empty - query failed)");
				// The first right lands on the first option, not the second.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const cycled = await frameUntil(
					setup,
					"the thinking to become the first option",
					(f) => !f.includes("(unset)"),
				);
				expect(cycled).not.toContain("(unset)");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("a task profile prefills the detail and panel, then starts its agent with all settings", async () => {
		const config: FactoryConfig = {
			...BASE_CONFIG,
			maxParallelAgents: 3,
			defaultModel: "global-model",
			agents: {
				...BASE_CONFIG.agents,
				codex: { ...BASE_CONFIG.agents.codex, contextWindow: "-c {value}" },
			},
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					agent: "codex",
					model: "task-model",
					thinking: "high",
					contextWindow: "272000",
				},
			},
		};
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				const before = detailPaneText(setup.captureCharFrame());
				expect(before).toContain("Agent: codex");
				expect(before).toContain("Model: task-model");
				expect(before).toContain("Thinking: high");
				// The fourth profile setting reads the same way, in the same
				// place: the detail shows what Enter will start with.
				expect(before).toContain("Context: 272000");

				await guideKey(setup, "override", "e", { quiet: true });
				const opened = await settle(setup);
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("an open ticket of a second work cycle shows what Enter starts, not its last cycle", async () => {
		// The cycle that closed ran on an agent that maps every setting; the
		// profile the ticket now resolves takes another agent and names none of
		// them, so the record and the next handoff disagree on all four.
		const config: FactoryConfig = {
			...BASE_CONFIG,
			maxParallelAgents: 3,
			agents: {
				...BASE_CONFIG.agents,
				codex: {
					...BASE_CONFIG.agents.codex,
					model: "-m {value}",
					thinking: "-r {value}",
					contextWindow: "-c model_context_window={value}",
				},
			},
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, agent: "pi" },
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
				herdrName: "old-cycle-agent",
				startedAt: "2026-01-01T00:00:00Z",
			},
			handoffCount: 1,
		};
		await appOn(
			{
				groupingAxis: "none",
				config: config,
				sources: [{ config: billingSource, tickets: [secondCycle] }],
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("a model rejected by the profiled agent fails and leaves the ticket open", async () => {
		const config: FactoryConfig = {
			...BASE_CONFIG,
			maxParallelAgents: 3,
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					agent: "codex",
					model: "rejected-model",
				},
			},
		};
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					liveBillingCheckout(fake, home2);
					fake.set(
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
				},
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				const frame = await frameUntil(setup, "the model rejection", (candidate) =>
					candidate.includes("codex rejected model rejected-model"),
				);
				expect(selectedRow(frame)).toContain("[open]");
				expect(detailPaneText(frame)).toContain("Agent: codex");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("clearing a profiled Model row leaves it to the agent", async () => {
		const config = configWith({ model: "task-model" });
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Environment row", (f) => f.includes("❯ Environment"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Task type row", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Model row", (f) => f.includes("❯ Model"));
				fieldKey(setup, "home");
				for (const _ of "task-model") fieldKey(setup, "delete");
				// The list query the panel opens with has no stub: the empty
				// field names the failed query, the merged panel's placeholder
				// carries the cause.
				const cleared = await frameUntil(setup, "the cleared Model value", (frame) =>
					frameText(frame).includes("Model (empty - query failed)"),
				);
				expect(frameText(cleared)).toContain("Model (empty - query failed)");
				await pressEnterToHandoff(setup);

				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).not.toContain("--model");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("clearing a profiled Thinking list row leaves it to the agent", async () => {
		const config = configWith({ thinking: "low" });
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Environment row", (f) => f.includes("❯ Environment"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Task type row", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Model row", (f) => f.includes("❯ Model"));
				await guideKey(setup, "move-list", "↓", { quiet: true });
				await frameUntil(setup, "the Thinking row", (f) => f.includes("❯ Thinking"));
				fieldKey(setup, "delete");
				const cleared = await frameUntil(setup, "the cleared Thinking value", (frame) =>
					frameText(frame).includes("Thinking (unset)"),
				);
				expect(frameText(cleared)).toContain("Thinking (unset)");
				await pressEnterToHandoff(setup);

				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).not.toContain("--thinking");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("a model no agent argument can carry fails the handoff and keeps the ticket open", async () => {
		// The profile sends its handoffs to an agent that maps no setting, and
		// the default model still resolves onto it.
		const config = configWith(
			{ agent: "cursor" },
			{
				defaultModel: "factory-model",
				agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
			},
		);
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				await guideKey(setup, "handoff", "Enter", { quiet: true });
				const frame = await frameUntil(setup, "the mismatch reason", (candidate) =>
					candidate.includes("defines no model setting"),
				);
				expect(selectedRow(frame)).toContain("[open]");
				// The handoff failed before its first external step: no workspace,
				// no agent, so the ticket is ready for a retry once the config is
				// fixed. Only the plane's own boot probe of the checkout stands;
				// the handoff's reads never ran.
				const probePath = join(planeRecord.home, "src", "billing");
				expect(handoffCommands(runner)).toEqual([
					`git -C ${probePath} rev-parse --git-dir`,
					`git -C ${probePath} remote get-url origin`,
				]);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("the panel keeps an unmappable model in reach, and clearing it starts the handoff", async () => {
		const config = configWith(
			{ agent: "cursor" },
			{
				defaultModel: "factory-model",
				agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
			},
		);
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				const opened = await settle(setup);
				// The row is not hidden: the value needs a row to be cleared in, and
				// it states in words why the Agent cannot take it, so the warning
				// never rides on the tone alone.
				expect(frameText(opened)).toContain("Model factory-model");
				expect(frameText(opened)).toContain(
					'Error: Model: agent type "cursor" defines no model setting',
				);
				expect(spanColors(setup, "factory-model")).toEqual(unfitTones());
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Environment row", (f) => f.includes("❯ Environment"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Task type row", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the Model row", (f) => f.includes("❯ Model"));
				// The row's input takes focus on its own render pass: let it land
				// before the edit keys go in.
				await settle(setup);
				// The warning holds while the row is selected: the value is
				// still unfit, and the handoff would still fail on it.
				expect(spanColors(setup, "factory-model")).toEqual(unfitTones());

				fieldKey(setup, "home");
				for (const _ of "factory-model") fieldKey(setup, "delete");
				// With its value gone the row has nothing left to clear, so it
				// drops back behind the agent's capability.
				const cleared = await frameUntil(
					setup,
					"the model row to drop once its value is cleared",
					(frame) => !frameText(frame).includes("Model"),
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("a task type thinking default shows in the panel and rides on the start", async () => {
		const config = mergeConfig({ thinking: "low" });
		await appOn(
			{
				groupingAxis: "none",
				config: config,
				sources: [{ config: billingSource, tickets: [mergeTicket] }],
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await guideKey(setup, "override", "e", { quiet: true });
				const opened = await settle(setup);
				// The thinking row shows the task type default, not the unset hint.
				expect(frameText(opened)).toContain("Thinking low");
				expect(opened).not.toContain("(unset)");
				const settled = await pressEnterToHandoff(setup);
				expect(startingFaceOf(selectedRow(settled))).not.toBeNull();
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("switching the task type re-derives an untouched thinking row", async () => {
		const config = mergeConfig({ thinking: "low" });
		await appOn(
			{
				groupingAxis: "none",
				config: config,
				sources: [{ config: billingSource, tickets: [mergeTicket] }],
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await guideKey(setup, "override", "e", { quiet: true });
				const opened = await settle(setup);
				// The thinking row shows the suggested task type's default.
				expect(frameText(opened)).toContain("Thinking low");
				// Move to the Task type row (Agent, Environment, Task type) and
				// cycle away from merge. The untouched thinking row re-derives
				// from the new task type, so the row keeps showing what the
				// handoff will run on.
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Environment"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const toImplement = await frameUntil(setup, "the task type to wrap to implement", (f) =>
					frameText(f).includes("Task type implement"),
				);
				// implement sets no default: the row is left to the agent.
				expect(frameText(toImplement)).toContain("Thinking (unset)");
				// Cycling back restores the default.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become review", (f) =>
					frameText(f).includes("Task type review"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become rework", (f) =>
					frameText(f).includes("Task type rework"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const back = await frameUntil(setup, "the task type to become merge", (f) =>
					frameText(f).includes("Task type merge"),
				);
				expect(frameText(back)).toContain("Thinking low");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a touched thinking row survives a task type switch", async () => {
		const config = mergeConfig({ thinking: "low" }, [mergeState, toImplementState]);
		await appOn(
			{
				groupingAxis: "none",
				config: config,
				sources: [{ config: billingSource, tickets: [mergeTicket] }],
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await guideKey(setup, "override", "e", { quiet: true });
				const opened = await settle(setup);
				expect(frameText(opened)).toContain("Thinking low");
				// Move to the Thinking row: j walks the list rows, and the arrow
				// passes the free-text Model row.
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Environment"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Model"));
				await guideKey(setup, "move-list", "↓", { quiet: true });
				await frameUntil(setup, "the row selection to move to the thinking row", (f) =>
					f.includes("❯ Thinking"),
				);
				// Touch the row: cycle the level past its default.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the thinking to become medium", (f) =>
					frameText(f).includes("Thinking medium"),
				);
				// Move back to the Task type row and switch away from merge.
				await guideKey(setup, "move-list", "↑", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Model"));
				await guideKey(setup, "move-list", "↑", { quiet: true });
				await frameUntil(setup, "the row selection to move on", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const switched = await frameUntil(setup, "the task type to wrap to implement", (f) =>
					frameText(f).includes("Task type implement"),
				);
				// The explicit choice rides on, not the new task type's default.
				expect(frameText(switched)).toContain("Thinking medium");
				const settled = await pressEnterToHandoff(setup);
				expect(startingFaceOf(selectedRow(settled))).not.toBeNull();
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toContain("--thinking");
				expect(start?.args).toContain("medium");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);
	test("the settings rows hide for an agent that does not map them", async () => {
		// A fourth agent that maps no setting at all.
		const config: FactoryConfig = {
			...BASE_CONFIG,
			maxParallelAgents: 3,
			agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
		};
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				// pi maps both settings: both rows are offered.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to become codex", (f) =>
					frameText(f).includes("Agent codex"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to become claude", (f) =>
					frameText(f).includes("Agent claude"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const frame = await frameUntil(setup, "the agent to become cursor", (f) =>
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the task type row cycles through the task types and wraps", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become fix", (f) =>
					frameText(f).includes("Task type fix"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become review", (f) =>
					frameText(f).includes("Task type review"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the task type to become rework", (f) =>
					frameText(f).includes("Task type rework"),
				);
				// Rework is a shipped task type. The next value wraps to the first.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const wrapped = await frameUntil(setup, "the task type to wrap back", (f) =>
					frameText(f).includes("Task type implement"),
				);
				expect(frameText(wrapped)).toContain("Task type implement");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the container environment is never offered", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				// Move to the Environment row and cycle through every offered value.
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				// "worktree" alone is a substring of "live-worktree", so the
				// predicates read the row, not the whole frame.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the environment to become worktree", (f) =>
					f.includes("Environment worktree"),
				);
				// Wraps back to live-worktree: only two values exist.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const wrapped = await frameUntil(setup, "the environment to wrap back", (f) =>
					f.includes("Environment live-worktree"),
				);
				expect(wrapped).not.toContain("container");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("escape cancels the panel without a handoff", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to change", (f) => f.includes("codex"));
				await pressControl(setup, "cancel", { quiet: true });
				const closed = await frameUntil(
					setup,
					"the override panel to close",
					(f) => !f.includes("❯ Agent"),
				);
				expect(closed).toContain("[open]");
				expect(closed).toContain("e Override");
				// No handoff command ever ran: only the plane's boot probes of
				// the checkout stand.
				expect(
					runner.calls.filter(
						(c) => !(c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "list"),
					),
				).toHaveLength(2);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("switching the task type re-derives an untouched Context row", async () => {
		// A second profile on the same agent, naming another count: the row
		// follows the task type instead of hiding behind an agent.
		const config: FactoryConfig = {
			...contextProfileConfig,
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					agent: "codex",
					model: "gpt-5.6-codex",
					contextWindow: "272000",
				},
				fix: {
					...BASE_CONFIG.taskTypes.fix,
					agent: "codex",
					model: "gpt-5.6-codex",
					contextWindow: "65536",
				},
			},
		};
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				const opened = await settle(setup);
				expect(frameText(opened)).toContain("Context 272000");
				// Cycle the Task type row: the untouched Context row takes the
				// new profile's count, so the panel keeps showing what the
				// handoff will run on.
				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const next = await frameUntil(
					setup,
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
				fieldKey(setup, "end");
				await typeText(setup, "8");
				await frameUntil(setup, "the count the operator typed", (f) =>
					frameText(f).includes("Context 655368"),
				);
				await selectRow(setup, "up", "Thinking");
				await selectRow(setup, "up", "Model");
				await selectRow(setup, "up", "Task type");
				await guideKey(setup, "cycle-choice", "←", { quiet: true });
				const back = await frameUntil(setup, "the task type to come back", (f) =>
					frameText(f).includes("Task type implement"),
				);
				expect(frameText(back)).toContain("Context 655368");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("the Context row carries the profile's count and takes digits only", async () => {
		await appOn(
			{
				config: contextProfileConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				const opened = await settle(setup);
				// The profile names the room and its agent maps it, so the row is
				// there and holds the profile's count from the first frame.
				expect(frameText(opened)).toContain("Context 272000");

				// A free-text row owns j and k, so the walk to the last row uses
				// the arrows, which always move.
				const selected = await selectContextRow(setup);
				expect(rowWith(selected, "Context")).toContain("272000");

				// A count is whole digits: a letter typed at the end of the row
				// never reaches the value the agent starts with, and the digits
				// beside it do.
				fieldKey(setup, "end");
				await typeText(setup, "5x");
				const typed = await frameUntil(
					setup,
					"the count to take the digit and drop the letter",
					(f) => rowWith(f, "Context").includes("2720005"),
				);
				expect(rowWith(typed, "Context")).toContain("2720005");
				expect(typed).not.toContain("5x");

				// A refused character also has to leave the caret where the
				// operator left it: the row is edited from its front here, so a
				// caret that jumped to the end would land every later keystroke
				// after the digits instead of between them.
				fieldKey(setup, "home");
				for (const key of ["1", "2", " ", "3"]) {
					typeText(setup, key);
				}
				const inserted = await frameUntil(
					setup,
					"the typed digits to build the count at the caret",
					(f) => rowWith(f, "Context").includes("1232720005"),
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);

	test("the Context row folds a typed count to one spelling, the way the config does", async () => {
		await appOn(
			{
				config: contextProfileConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await selectContextRow(setup);
				// The profile's own count goes first, so the digits below are the
				// only ones the row can hold: a frame that still carried them could
				// never pass this test by accident.
				fieldKey(setup, "home");
				for (const _ of "272000") fieldKey(setup, "delete");
				await frameUntil(setup, "the Context row to empty", (f) =>
					rowWith(f, "Context").includes("(empty)"),
				);
				// A count is its value, not its spelling: the row folds the leading
				// zeros the way the config parser folds `007`, so the row shows the
				// one spelling the agent gets.
				await typeText(setup, "007");
				const folded = await frameUntil(
					setup,
					"the row to hold one spelling of the count",
					(f) => contextDigitsOf(f) === "7",
				);
				expect(frameText(folded)).toContain("Context 7");

				await pressEnterToHandoff(setup);
				const start = runner.calls.find(
					(call) => call.args[0] === "agent" && call.args[1] === "start",
				);
				expect(start?.args).toContain("model_context_window=7");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);

	test("a Context row that holds no count says so, and the handoff refuses it", async () => {
		await appOn(
			{
				config: contextProfileConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await selectContextRow(setup);
				// The caret sits at the row's end, where the last key landed, so the
				// deletes have to start at its other end. The empty row below is
				// what proves HOME moved the caret there.
				fieldKey(setup, "home");
				for (const _ of "272000") fieldKey(setup, "delete");
				await frameUntil(setup, "the Context row to empty", (f) =>
					rowWith(f, "Context").includes("(empty)"),
				);

				// Digits alone are not yet a count: zero asks an agent for no
				// context at all, so the row holds the digit in the warning
				// color, the same rule a config file is held to.
				await typeText(setup, "0");
				const zero = await frameUntil(setup, "the row to hold the zero", (f) =>
					rowWith(f, "Context").includes("0"),
				);
				expect(rowWith(zero, "Context")).toMatch(/Context\s+0/u);

				await guideKey(setup, "confirm-choice", "Enter", { quiet: true });
				// The Message line at 120 columns cuts the reason short, so the
				// pin reads the visible front of it; the whole reason stands in
				// the record entry behind the line.
				const failed = await frameUntil(
					setup,
					"the count refusal and the ticket returning open",
					(f) =>
						f.includes("context window") &&
						f.includes("is not a positive whole number") &&
						selectedRow(f).includes("[open]"),
				);
				expect(selectedRow(failed)).toContain("[open]");
				// The refusal's fact sends its own desktop notification (ADR 0080),
				// and the handoff ran none of its own commands: only the plane's
				// boot probe of the checkout stands.
				expect(handoffCommands(runner)).toHaveLength(2);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);

	test("a Context row survives an Agent that cannot map it until it is cleared", async () => {
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
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				const opened = await settle(setup);
				// The row is there because the value needs a row to be cleared in,
				// and it warns because the chosen agent cannot carry the count.
				expect(frameText(opened)).toContain("Context 272000");
				expect(frameText(opened)).toContain(
					'Error: Context: agent type "pi" defines no context window setting',
				);
				expect(spanColors(setup, "272000")).toEqual(unfitTones());

				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				await selectRow(setup, "down", "Model");
				await selectRow(setup, "down", "Thinking");
				await selectRow(setup, "down", "Context");
				await settle(setup);
				expect(spanColors(setup, "272000")).toEqual(unfitTones());

				// Up onto the Agent row, then right onto the agent that maps the
				// count: the draft keeps its value, and the row goes plain.
				await selectRow(setup, "up", "Thinking");
				await selectRow(setup, "up", "Model");
				await selectRow(setup, "up", "Task type");
				await selectRow(setup, "up", "Environment");
				await selectRow(setup, "up", "Agent");
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to map the count", (f) =>
					rowWith(f, "Agent").includes("codex"),
				);
				await frameUntil(
					setup,
					"the Context row to return with an agent that maps it",
					(f) => rowWith(f, "Agent").includes("codex") && frameText(f).includes("Context 272000"),
				);
				expect(spanColors(setup, "272000")).not.toEqual(unfitTones());

				// Back onto the agent that cannot map it, then clear the row: the
				// handoff starts and leaves the room to the agent.
				await guideKey(setup, "cycle-choice", "←", { quiet: true });
				await frameUntil(setup, "the agent to map nothing", (f) =>
					rowWith(f, "Agent").includes("pi"),
				);
				await selectRow(setup, "down", "Environment");
				await selectRow(setup, "down", "Task type");
				await selectRow(setup, "down", "Model");
				await selectRow(setup, "down", "Thinking");
				await selectRow(setup, "down", "Context");
				await settle(setup);
				await frameUntil(setup, "the Context row to come back", (f) =>
					frameText(f).includes("Context 272000"),
				);
				expect(spanColors(setup, "272000")).toEqual(unfitTones());
				fieldKey(setup, "home");
				for (const _ of "272000") fieldKey(setup, "delete");
				const cleared = await frameUntil(
					setup,
					"the Context row to drop once it is cleared",
					(f) => !frameText(f).includes("Context"),
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);

	test("a Thinking level the chosen Agent does not offer warns on its row, and fails the handoff", async () => {
		// "minimal" is legal for pi, the profile's own agent, so the panel opens
		// on it. zed maps a thinking template but offers only two other levels:
		// cycling the Agent row onto it leaves a value with an argv to ride on
		// and no Agent that takes it.
		const config: FactoryConfig = {
			...BASE_CONFIG,
			maxParallelAgents: 3,
			agents: {
				...BASE_CONFIG.agents,
				zed: { kind: "zed", thinking: "-t {value}", thinkingValues: ["off", "low"] },
			},
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, agent: "pi", thinking: "minimal" },
			},
		};
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				// zed is the last agent the Agent row offers, and the Thinking row
				// sits under the three rows every panel carries.
				const cycleToZed = async (): Promise<void> => {
					for (const target of ["codex", "claude", "zed"]) {
						await guideKey(setup, "cycle-choice", "→", { quiet: true });
						await frameUntil(setup, `the agent to move to ${target}`, (f) =>
							rowWith(f, "Agent").includes(target),
						);
					}
				};
				const selectThinking = async (): Promise<string> => {
					await selectRow(setup, "down", "Environment");
					await selectRow(setup, "down", "Task type");
					return await selectRow(setup, "down", "Thinking");
				};

				await guideKey(setup, "override", "e", { quiet: true });
				const opened = await settle(setup);
				expect(frameText(opened)).toContain("Thinking minimal");
				expect(spanColors(setup, "minimal")).toEqual([rgb(roleColor("text"))]);

				await cycleToZed();
				// The row keeps the level and shows it in the warning color. It
				// never reads `(unset)` for a value the handoff will still send.
				const warned = await frameUntil(setup, "the Thinking row to keep the level", (f) =>
					rowWith(f, "Thinking").includes("minimal"),
				);
				expect(frameText(warned)).not.toContain("Thinking (unset)");
				expect(frameText(warned)).toContain(
					'Error: Thinking: agent type "zed" offers no thinking level "minimal"',
				);
				expect(spanColors(setup, "minimal")).toEqual(unfitTones());

				// The warning holds while the row is selected: the value is
				// still unfit, and the handoff would still fail on it.
				await selectThinking();
				await settle(setup);
				expect(spanColors(setup, "minimal")).toEqual(unfitTones());

				// Confirming a value the Agent does not offer fails the handoff
				// with a readable reason: what the row showed is what the agent
				// would have been started with, and nothing starts at all.
				await guideKey(setup, "confirm-choice", "Enter", { quiet: true });
				const failed = await frameUntil(
					setup,
					"the mismatch refusal and the ticket returning open",
					(f) =>
						f.includes('offers no thinking level "minimal"') && selectedRow(f).includes("[open]"),
				);
				expect(selectedRow(failed)).toContain("[open]");
				// The refusal's fact sends its own desktop notification (ADR 0080),
				// and nothing of the handoff's started at all: only the plane's
				// boot probe of the checkout stands.
				expect(handoffCommands(runner)).toHaveLength(2);

				// The row is reachable, so the value is not stranded: clearing it
				// hands the level back to the agent, and the handoff starts with no
				// thinking argument at all.
				await guideKey(setup, "override", "e", { quiet: true });
				const reopened = await settle(setup);
				expect(frameText(reopened)).toContain("Thinking minimal");
				await cycleToZed();
				await selectThinking();
				await settle(setup);
				fieldKey(setup, "backspace");
				const cleared = await frameUntil(
					setup,
					"the Thinking row to hand the level to the agent",
					(f) => rowWith(f, "Thinking").includes("(unset)"),
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});

	test("the free-text model row accepts typed text and confirms the handoff", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				// Move to the Model row (Agent, Environment, Task type, then Model).
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				await typeText(setup, "gpt-5.6");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("gpt-5.6"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the selected text field has a focused background and bright text", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				const frame = await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the model", (f) =>
					f.includes("❯ Model"),
				);
				expect(frameText(frame)).toContain("Model (empty - query failed)");
				await typeText(setup, "gpt");
				await frameUntil(setup, "the model text", (f) => frameText(f).includes("Model gpt"));
				const captured = setup.captureSpans();
				const modelLine = captured.lines.find((line) =>
					line.spans.some((span) => span.text.includes("gpt")),
				);
				const valueSpan = modelLine?.spans.find((span) => span.text.includes("gpt"));
				expect(valueSpan?.fg.toInts().slice(0, 3)).toEqual(rgb(roleColor("text")));
				expect(valueSpan?.bg.toInts().slice(0, 3)).toEqual(rgb(roleColor("active_row_bg")));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a non-ASCII model name types into the free-text row and rides on the start", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				// "é" is outside the ASCII range: it must not be dropped.
				await typeText(setup, "gpt-é");
				const frame = await frameUntil(setup, "the non-ASCII model to show in the row", (f) =>
					frameText(f).includes("Model gpt-é"),
				);
				expect(frameText(frame)).toContain("Model gpt-é");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("gpt-é"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a move and a cycle in the same tick act on the moved row", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				// Both keys are queued before a render: the key parser delivers
				// them in one tick, where a render-closure row would still
				// point at the Agent row.
				typeText(setup, "j");
				fieldKey(setup, "right");
				const frame = await frameUntil(setup, "the cycle to land on the moved row", (f) =>
					frameText(f).includes("Environment worktree"),
				);
				// The cycle acted on the Environment row, not the Agent row.
				expect(frameText(frame)).toContain("Environment worktree");
				expect(frameText(frame)).not.toContain("Agent codex");
				expect(frame).toContain("❯ Environment");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("Tab and Shift+Tab move from list and text rows", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				// Both directions work on a list row.
				fieldKey(setup, "tab");
				await frameUntil(setup, "Tab to move down", (f) => f.includes("❯ Environment"));
				fieldKey(setup, "shift+tab");
				await frameUntil(setup, "Shift+Tab to move up", (f) => f.includes("❯ Agent"));
				// Both directions also work when the selected row is a text input.
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the model", (f) =>
					f.includes("❯ Model"),
				);
				fieldKey(setup, "shift+tab");
				await frameUntil(setup, "Shift+Tab from a text row", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to return to the model", (f) =>
					f.includes("❯ Model"),
				);
				fieldKey(setup, "tab");
				await frameUntil(setup, "Tab from a text row", (f) => f.includes("❯ Thinking"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a sibling clone hands off, warns, and writes the mapping back to the config file", async () => {
		// The convention path holds a different repository.
		await appOn(
			{
				config: seatOpenConfig,
				commands: (fake, home2) => {
					// No repos entry: the handoff resolves the convention path,
					// which is the side of the mapping rule that heals.
					const path = join(home2, "src", "billing");
					const sibling = join(home2, "src", "billing_1");
					mkdirSync(path, { recursive: true });
					fake.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
					fake.set("git", ["-C", path, "remote", "get-url", "origin"], {
						stdout: "https://github.com/acme/portal.git\n",
					});
					fake.set("git", ["clone", "https://github.com/acme/billing.git", sibling], {
						code: 0,
					});
					fake.set("git", ["-C", sibling, "rev-parse", "--git-dir"], { stdout: ".git\n" });
					fake.set("git", ["-C", sibling, "remote", "get-url", "origin"], {
						stdout: "https://github.com/acme/billing.git\n",
					});
					fake.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
					fake.set("herdr", ["workspace", "create", "--cwd", sibling, "--no-focus"], {
						stdout: workspaceCreateJson("ws-1"),
					});
					fake.set(
						"herdr",
						["tab", "create", "--workspace", "ws-1", "--cwd", sibling, "--no-focus"],
						{
							stdout: tabCreateJson("pane-1"),
						},
					);
				},
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				const _path = join(planeRecord.home, "src", "billing");
				const sibling = join(planeRecord.home, "src", "billing_1");

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				await pressEnterToHandoff(setup);
				// The projection refresh and the handoff report are separate async
				// facts. Wait for the line, or the frame is read mid-flight.
				const frame = await frameUntil(
					setup,
					"the sibling-clone warning on the Message line",
					(f) => messageRowOf(f).includes("cloned acme/billing to a sibling"),
				);
				// The note about the operator's disk leads the line (ADR 0103), so it
				// reads whole on the row. The write-back fact that follows it names
				// the file it landed on, and the two together are longer than the
				// row, so the whole fact reads in the Message view.
				expect(messageRowOf(frame)).toContain("cloned acme/billing to a sibling");
				const view = await pressControl(setup, "message", { opens: "Message view" });
				expect(frameText(view)).toContain("saved the mapping in");
				expect(frameText(view)).toContain(planeRecord.configPath);
				await pressControl(setup, "message-close", { closes: "Message view" });
				// The mapping was written back to the config file.
				const written = readFileSync(planeRecord.configPath, "utf8");
				expect(written).toContain(`[repos]`);
				expect(written).toContain(`"github.com/acme/billing" = "${sibling}"`);
				// The handoff ran at the sibling, not the conflicting path.
				expect(runner.commands()).toContain(`herdr workspace create --cwd ${sibling} --no-focus`);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);
	test("e opens the Override panel while a handoff is in flight (ADR 0064)", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				// Every early command is delayed a beat, so the flight outlives the
				// walk, the ask, and the panel: whichever command the start waits on,
				// the run itself stretches over the window the walk needs.
				runner: (fake) => new DelayedRunner(fake, 800, 12),
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				await handoffEnter(setup, "the in-flight status", "handing off");
				// The ask never waits on a run (ADR 0064): the Override panel
				// opens while the handoff runs, and the run in flight keeps its
				// Working line beside it: the answer never erases the work in
				// flight (user story 51). The in-flight ticket's own row is
				// starting, and a starting row answers to Enter rather than e,
				// so the ask lands on a different open ticket: the walk steps
				// The cursor walks one sequence, and while the start is pending
				// the flight row stands last of the tickets, so k climbs off it
				// onto an open ticket above. Each step settles before
				// pressing, a key sent into a re-sort being dropped, and
				// re-presses a bounded number of times.
				await walkStep(
					setup,
					"k",
					(f) => listHalfOf(selectedRow(f)).includes("[open]"),
					"the open ticket",
				);
				await settle(setup);
				await guideKey(setup, "override", "e", { quiet: true });
				const opened = await frameUntil(setup, "the override panel", (f) =>
					frameText(f).includes("❯ Agent"),
				);
				expect(messageRowOf(opened)).toContain("Working: handing off");
				// Esc gives the bar back, and the first handoff still settles.
				await guideKey(setup, "cancel", "Esc", { quiet: true });
				await frameUntil(setup, "the panel to close", (f) => !frameText(f).includes("❯ Agent"));
				await frameUntil(setup, "the handoff to settle", (f) =>
					messageRowOf(f).includes("started from the Work queue"),
				);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);
	test("a failed mapping write-back warns on the Message line", async () => {
		// The convention path holds a different repository: a sibling clone.
		// The config file cannot be written: a directory sits at its path.
		await appOn(
			{
				config: seatOpenConfig,
				commands: (fake, home2) => {
					// No repos entry: the handoff resolves the convention path,
					// which is the side of the mapping rule that heals.
					const path = join(home2, "src", "billing");
					const sibling = join(home2, "src", "billing_1");
					mkdirSync(path, { recursive: true });
					fake.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
					fake.set("git", ["-C", path, "remote", "get-url", "origin"], {
						stdout: "https://github.com/acme/portal.git\n",
					});
					fake.set("git", ["clone", "https://github.com/acme/billing.git", sibling], {
						code: 0,
					});
					fake.set("git", ["-C", sibling, "rev-parse", "--git-dir"], { stdout: ".git\n" });
					fake.set("git", ["-C", sibling, "remote", "get-url", "origin"], {
						stdout: "https://github.com/acme/billing.git\n",
					});
					fake.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
					fake.set("herdr", ["workspace", "create", "--cwd", sibling, "--no-focus"], {
						stdout: workspaceCreateJson("ws-1"),
					});
					fake.set(
						"herdr",
						["tab", "create", "--workspace", "ws-1", "--cwd", sibling, "--no-focus"],
						{
							stdout: tabCreateJson("pane-1"),
						},
					);
				},
			},
			async (setup, planeRecord) => {
				const _path = join(planeRecord.home, "src", "billing");
				const _runner = planeRecord.fakeRunner;
				const _sibling = join(planeRecord.home, "src", "billing_1");
				rmSync(planeRecord.configPath, { force: true });
				mkdirSync(planeRecord.configPath, { recursive: true });

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				const frame = await handoffEnter(
					setup,
					"the write-back warning to appear",
					"could not persist",
				);
				// The handoff itself succeeded: the ticket is handed off... and
				// the warning sits on the permanent Message line.
				expect(startingFaceOf(selectedRow(frame))).not.toBeNull();
				expect(messageRowOf(frame)).toContain("could not persist");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);
	test("j, k, h, and l type into the selected free-text row", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				// "claude" carries an l: the movement keys type, they do not
				// move the selection off the row.
				await typeText(setup, "claude");
				const frame = await frameUntil(setup, "the model to carry the typed text", (f) =>
					frameText(f).includes("Model claude"),
				);
				expect(frame).toContain("❯ Model");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("claude"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the free-text row moves the caret and inserts at it", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				// A left arrow moves the caret one cell in, so the next typed
				// character lands before the last one, not after it.
				await typeText(setup, "abcd");
				await fieldKey(setup, "left");
				await typeText(setup, "X");
				const frame = await frameUntil(setup, "the insert at the moved caret", (f) =>
					frameText(f).includes("Model abcXd"),
				);
				expect(frameText(frame)).toContain("Model abcXd");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("abcXd"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the free-text row jumps to the ends with Home and End", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "abcd");
				// Home puts the caret at the start, so the next character lands
				// before the rest. End puts it back at the tail.
				await fieldKey(setup, "home");
				await typeText(setup, "Y");
				await fieldKey(setup, "end");
				await typeText(setup, "Z");
				const frame = await frameUntil(setup, "the Home and End inserts", (f) =>
					frameText(f).includes("Model YabcdZ"),
				);
				expect(frameText(frame)).toContain("Model YabcdZ");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("YabcdZ"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the free-text row deletes with backspace and forward delete", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "abcd");
				// Backspace removes the character before the caret.
				fieldKey(setup, "backspace");
				await frameUntil(setup, "the backspace to shorten the value", (f) =>
					frameText(f).includes("Model abc "),
				);
				// Home, then forward delete, removes the first character.
				await fieldKey(setup, "home");
				await fieldKey(setup, "delete");
				const frame = await frameUntil(
					setup,
					"the forward delete to remove the first character",
					(f) => frameText(f).includes("Model bc "),
				);
				expect(frameText(frame)).toContain("Model bc ");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("bc"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the free-text row deletes a caret selection", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "hello");
				// Shift+left twice selects the last two characters, then
				// backspace removes the whole selection at once.
				await fieldKey(setup, "shift+left");
				await fieldKey(setup, "shift+left");
				fieldKey(setup, "backspace");
				const frame = await frameUntil(setup, "the selection to delete the two characters", (f) =>
					frameText(f).includes("Model hel "),
				);
				expect(frameText(frame)).toContain("Model hel ");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("hel"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("the free-text row undoes with Ctrl+Z and redoes with Ctrl+Y", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				const isShort = (f: string) =>
					frameText(f).includes("Model hell ") && !frameText(f).includes("Model hello");
				await typeText(setup, "hello");
				// Backspace drops the final o; Ctrl+Z restores it.
				fieldKey(setup, "backspace");
				await frameUntil(setup, "the backspace to shorten the value", isShort);
				fieldKey(setup, "ctrl+z");
				await frameUntil(setup, "the undo to restore the value", (f) =>
					frameText(f).includes("Model hello"),
				);
				// A second undo takes the value back, and Ctrl+Y puts it forward.
				fieldKey(setup, "ctrl+z");
				await frameUntil(setup, "the second undo to shorten the value", isShort);
				fieldKey(setup, "ctrl+y");
				const frame = await frameUntil(setup, "the redo to restore the value", (f) =>
					frameText(f).includes("Model hello"),
				);
				expect(frameText(frame)).toContain("Model hello");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("hello"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("bracketed paste works in the free-text Model row of a kind with no model list", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				// codex is an agent kind that reports no Model list, so its Model row
				// stays the standard free-text field (ADR 0010).
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to become codex", (f) =>
					frameText(f).includes("Agent codex"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "move-list", "↓", { quiet: true });
				const model = await frameUntil(setup, "the row selection to move to the model", (f) =>
					f.includes("❯ Model"),
				);
				expect(frameText(model)).toContain("Model (empty - no model list)");
				// Only the agent the panel opened on was queried: switching to a
				// kind with no list runs no query of its own.
				expect(runner.modelListCalls).toEqual(["pi"]);
				await pasteText(setup, "gpt-5.1\u001b[31m-codex\r\n");
				const frame = await frameUntil(setup, "the sanitized Model paste", (f) =>
					frameText(f).includes("Model gpt-5.1-codex"),
				);
				expect(frameText(frame)).toContain("Model gpt-5.1-codex");
				await pressEnterToHandoff(setup);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toContain("gpt-5.1-codex");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a bracketed paste is sanitized of ANSI escapes and line breaks", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				// The paste carries an ANSI color and a line break. The field
				// keeps only the plain text: the color and the break are gone.
				await pasteText(setup, "\x1b[31mhello\r\nworld\x1b[0m");
				const frame = await frameUntil(setup, "the sanitized paste to land in the row", (f) =>
					frameText(f).includes("Model helloworld"),
				);
				expect(frameText(frame)).toContain("Model helloworld");
				expect(frameText(frame)).not.toContain("\x1b");
				await pressEnterToHandoff(setup);
				expect(startArgsOf(runner)).toEqual(modelStartArgs("helloworld"));
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("pasting at the start, middle, end, and over a selection edits in place", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "ab");
				await fieldKey(setup, "home");
				await pasteText(setup, "S");
				await frameUntil(setup, "the start paste", (f) => frameText(f).includes("Model Sab"));
				await fieldKey(setup, "end");
				await pasteText(setup, "E");
				await frameUntil(setup, "the end paste", (f) => frameText(f).includes("Model SabE"));
				await fieldKey(setup, "home");
				await fieldKey(setup, "right");
				await pasteText(setup, "M");
				await frameUntil(setup, "the middle paste", (f) => frameText(f).includes("Model SMabE"));
				await fieldKey(setup, "home");
				await fieldKey(setup, "shift+right");
				await pasteText(setup, "X");
				// The bar cursor and the selection agree on one cell, so the selected
				// "S" is exactly what the pasted "X" replaces.
				const frame = await frameUntil(setup, "the paste over a selection", (f) =>
					frameText(f).includes("Model XMabE"),
				);
				expect(frameText(frame)).toContain("Model XMabE");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a long free-text value scrolls in its column and hands off whole", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				// biome-ignore lint/security/noSecrets: a fixed test fixture, not a credential
				const longValue = "abcdefghijklmnopqrstuv9876543210";

				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				// The value is wider than the column. The row keeps one line and
				// scrolls the caret into view, showing the tail of the value.
				await typeText(setup, longValue);
				const frame = await frameUntil(setup, "the value to scroll its tail into view", (f) =>
					frameText(f).includes("9876543210"),
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("word deletion removes a word in either direction", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "hello world");
				fieldKey(setup, "ctrl+backspace");
				await frameUntil(setup, "the backward word deletion", (f) =>
					frameText(f).includes("Model hello "),
				);
				await fieldKey(setup, "home");
				fieldKey(setup, "ctrl+delete");
				const frame = await frameUntil(setup, "the forward word deletion", (f) =>
					frameText(f).includes("Model (empty - query failed)"),
				);
				expect(frameText(frame)).toContain("Model (empty - query failed)");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("question mark and m type into a selected free-text row", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "?m");
				const frame = await frameUntil(setup, "the typed punctuation", (f) =>
					frameText(f).includes("Model ?m"),
				);
				expect(frameText(frame)).toContain("Model ?m");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("typing and confirming in one tick hands off the complete value", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "gpt");
				await guideKey(setup, "confirm-choice", "Enter", { quiet: true });
				await frameUntil(setup, "the handoff to settle", handoffSettled);
				const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
				expect(start?.args).toContain("gpt");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a text draft survives an agent change and terminal resize", async () => {
		const config = {
			...BASE_CONFIG,
			agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
		};
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				await openPanel(setup, planeRecord);
				await moveToModelRow(setup);
				await typeText(setup, "draft");
				await frameUntil(setup, "the draft text", (f) => frameText(f).includes("Model draft"));

				// The cursor agent maps no model, but the draft keeps its row in
				// the warning color: a value with no row is a value the operator
				// cannot clear, and the handoff would fail on it out of sight.
				await guideKey(setup, "move-list", "↑", { quiet: true });
				await frameUntil(setup, "the task type row", (f) => f.includes("❯ Task type"));
				await guideKey(setup, "move-list", "↑", { quiet: true });
				await frameUntil(setup, "the environment row", (f) => f.includes("❯ Environment"));
				await guideKey(setup, "move-list", "↑", { quiet: true });
				await frameUntil(setup, "the agent row", (f) => f.includes("❯ Agent"));
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to become codex", (f) =>
					frameText(f).includes("Agent codex"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to become claude", (f) =>
					frameText(f).includes("Agent claude"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				const unmapped = await frameUntil(setup, "the agent to become cursor", (f) =>
					frameText(f).includes("Agent cursor"),
				);
				expect(frameText(unmapped)).toContain("Model draft");
				expect(spanColors(setup, "draft")).toEqual(unfitTones());

				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the agent to return to pi", (f) =>
					frameText(f).includes("Agent pi"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the task type", (f) =>
					f.includes("❯ Task type"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the restored model", (f) =>
					frameText(f).includes("Model draft"),
				);
				setup.resize(24, 8);
				await frameUntil(setup, "the resized panel", (f) => frameText(f).includes("Model"));
				setup.resize(WIDTH, HEIGHT);
				const restored = await frameUntil(setup, "the draft after resizing back", (f) =>
					frameText(f).includes("Model draft"),
				);
				expect(frameText(restored)).toContain("Model draft");
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a short terminal scrolls the rows to keep the selected one on screen", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				// The list is not drawn below the minimum, so the walk goes
				// blind: the selection still moves through the standing's rows.
				await blindWalkToFirstOpen(setup);
				// A six-row terminal holds the box's two borders, the Action
				// bar, and three of the five panel rows, so the last row is off
				// screen while the first is selected...
				const open = await guideKey(setup, "override", "e", { quiet: true });
				expect(frameText(open)).not.toContain("Thinking");
				// ...and pressing down to the last row scrolls the viewport to it.
				await moveToModelRow(setup);
				await guideKey(setup, "move-list", "↓", { quiet: true });
				const frame = await frameUntil(setup, "the viewport to reach the thinking row", (f) =>
					f.includes("❯ Thinking"),
				);
				// The selected row is on screen, and the first row has scrolled off.
				expect(frameText(frame)).toContain("❯ Thinking");
				expect(frameText(frame)).not.toContain("Agent");
			},
			(planeRecord) => ({ width: 24, height: 6, plane: planeRecord }),
		);
	});
	test("the shared Action bar documents the list-row controls", async () => {
		// The canned list makes the Model row a list row, so its guide reads as a
		// choice row rather than as a text field.
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					const _path = join(home2, "src", "billing");
					fake.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
				},
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await walkToFirstOpen(setup);
				const frame = await guideKey(setup, "override", "e", { quiet: true });
				// The panel has no local hint row. Its shared Action bar shows
				// the keys the shared control catalogue dispatches.
				expect(frameText(frame)).toContain(
					"↑↓/jk Move ←→/hl Change ⌫ Clear Enter Hand off Esc Cancel F1 Help",
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the task type", (f) =>
					f.includes("❯ Task type"),
				);
				const modelFrame = await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to reach the model", (f) =>
					f.includes("❯ Model"),
				);
				// The Model list row's bar names its controls. The row takes
				// typed letters, so j and k are not on its Move hint, and it
				// cycles with the arrows only.
				// The Model row is the shared Type-ahead: its search is a field, so
				// the bar names the arrows as movement and the letters as editing, and
				// its one explicit clear key.
				expect(frameText(modelFrame)).toContain(
					"↑↓ Move Type Edit Enter Hand off Esc Cancel Del Clear F1 Help",
				);
				expect(frameText(modelFrame)).not.toContain("Backspace Delete");
				// On the Model row `j` is a letter, not a move: the selection
				// stays on the row.
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the letter that stays a letter", (f) => f.includes("❯ Model"));
				// Leaving the Model list row takes the arrow, not `j`.
				await guideKey(setup, "move-list", "↓", { quiet: true });
				const thinkingFrame = await frameUntil(setup, "the row selection to reach Thinking", (f) =>
					f.includes("❯ Thinking"),
				);
				expect(frameText(thinkingFrame)).toContain(
					"↑↓/jk Move ←→/hl Change ⌫ Clear Enter Hand off Esc Cancel F1 Help",
				);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
	test("a narrow terminal sizes the panel instead of corrupting rows", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				const _runner = planeRecord.fakeRunner;

				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await blindWalkToFirstOpen(setup);
				const frame = await guideKey(setup, "override", "e", { quiet: true });
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
				// ...and the shared Action bar packs to the hints that fit:
				// Cancel and Help survive, the rest drops as whole units.
				const bar = actionBarRowOf(frame);
				expect(bar).toContain("Esc Cancel");
				expect(bar).toContain("F1 Help");
				expect(bar).not.toContain("Move");
				expect(bar).not.toContain("Change");
				expect(bar).not.toContain("Hand off");
			},
			(planeRecord) => ({ width: 30, height: 12, plane: planeRecord }),
		);
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
			},
			async (setup, planeRecord) => {
				planeRecord.settleFirstFetch();
				await waitSourceHealthy(planeRecord.state);
				await blindWalkToFirstOpen(setup);
				const frame = await guideKey(setup, "override", "e", { quiet: true });
				const rows = rowsOf(frame);
				expect(rows).toHaveLength(7);
				for (const row of rows) {
					expect(row.length).toBe(24);
				}
				// The height cannot hold every row once the surface owns its
				// Message line and Action bar: the box gives up its padding first,
				// then its rows from the bottom, so the last two rows drop. The
				// rows above them keep their columns.
				expect(frameText(frame)).toContain("Task type");
				expect(frameText(frame)).not.toContain("Model");
				expect(frameText(frame)).not.toContain("Thinking");
			},
			(planeRecord) => ({ width: 24, height: 7, plane: planeRecord }),
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
		test(`the Model search names the first model that holds its text (${size.width}x${size.height})`, async () => {
			// The panel keeps the order the agent reported: pi sorts the list itself.

			await appOn(
				{
					config: seatOpenConfig,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", [
							"anthropic/claude-sonnet-4-5",
							"openai/gpt-5.1",
							"openai/gpt-5.1-codex",
						]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					expect(runner.modelListCalls).toEqual(["pi"]);
					await moveToModelRow(setup);
					// The task type names no model, so the row starts unset and the
					// search line under it is empty.
					expect(frameText(setup.captureCharFrame())).toContain("Model (unset)");
					await typeModelSearch(setup, "gpt-5.1");
					const matched = await frameUntil(setup, "the first model that holds the query", (f) =>
						frameText(f).includes("Model openai/gpt-5.1"),
					);
					// The query stays on screen beside the value it named, so the
					// operator reads the search and the setting as two things.
					expect(frameText(matched)).toContain("Search gpt-5.1");
					await typeModelSearch(setup, "-codex");
					const longer = await frameUntil(setup, "the longer query to narrow the match", (f) =>
						frameText(f).includes("Model openai/gpt-5.1-codex"),
					);
					expect(frameText(longer)).toContain("Search gpt-5.1-codex");
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("openai/gpt-5.1-codex");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`a query that matches nothing keeps its text and says so (${size.width}x${size.height})`, async () => {
			await appOn(
				{
					config: seatOpenConfig,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", [
							"anthropic/claude-sonnet-4-5",
							"openai/gpt-5.1",
							"openai/gpt-5.1-codex",
						]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					await moveToModelRow(setup);
					await typeModelSearch(setup, "gpt-5.1");
					await frameUntil(setup, "the first match", (f) =>
						frameText(f).includes("Model openai/gpt-5.1"),
					);
					// A letter no model holds extends the query and changes nothing:
					// the value stays on the last match, and the failed query stays
					// readable instead of restarting from its last character.
					await typeModelSearch(setup, "q");
					const held = await frameUntil(setup, "the no-match feedback", (f) =>
						frameText(f).includes("no match"),
					);
					expect(frameText(held)).toContain("gpt-5.1q");
					expect(frameText(held)).toContain("Model openai/gpt-5.1");
					// Backspace edits the query, so the operator corrects it in place.
					fieldKey(setup, "backspace");
					const fixed = await frameUntil(
						setup,
						"the corrected query to match again",
						(f) => frameText(f).includes("Search gpt-5.1 ") && !frameText(f).includes("no match"),
					);
					expect(frameText(fixed)).toContain("gpt-5.1");
					// Delete clears the whole query in one key, and the Model it
					// named stands: clearing a search is not clearing a setting.
					fieldKey(setup, "delete");
					const cleared = await frameUntil(
						setup,
						"the query to clear and the value to stay",
						(f) => searchRowOf(f) === "" && frameText(f).includes("Model openai/gpt-5.1"),
					);
					expect(frameText(cleared)).toContain("Model openai/gpt-5.1");
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("openai/gpt-5.1");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`Delete on an empty search gives the Model back to the agent (${size.width}x${size.height})`, async () => {
			await appOn(
				{
					config: seatOpenConfig,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					await moveToModelRow(setup);
					await typeModelSearch(setup, "gpt");
					await frameUntil(setup, "the matched model", (f) =>
						frameText(f).includes("openai/gpt-5.1"),
					);
					fieldKey(setup, "delete");
					await frameUntil(setup, "the query to clear", (f) => searchRowOf(f) === "");
					// The second Delete has no query left to remove, so it gives the
					// setting back to the agent: one key, two explicit steps.
					fieldKey(setup, "delete");
					const unset = await frameUntil(setup, "the Model row to clear", (f) =>
						frameText(f).includes("Model (unset)"),
					);
					expect(frameText(unset)).toContain("Model (unset)");
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					// A row the operator cleared names no model: the agent starts on its own.
					expect(start?.args).not.toContain("--model");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`an unset Model is not a warning with any available list (${size.width}x${size.height})`, async () => {
			for (const models of [["anthropic/claude-sonnet-4-5"], []] as const) {
				await appOn(
					{
						config: seatOpenConfig,
						repos: BILLING_REPOS,
						commands: (fake, home2) => {
							liveBillingCheckout(fake, home2);
							fake.setModelList("pi", [...models]);
						},
					},
					async (setup, planeRecord) => {
						const _runner = planeRecord.fakeRunner;

						await openPanel(setup, planeRecord);
						const placeholder = models.length > 0 ? "(unset)" : "(no models available)";
						const expected = `Model ${placeholder}`;
						const frame = await frameUntil(
							setup,
							`the unset Model row for ${models.length === 0 ? "an empty" : "a non-empty"} list`,
							(f) => frameText(f).includes(expected),
						);
						expect(frameText(frame)).toContain(expected);
						expect(spanColors(setup, placeholder)).not.toContainEqual(rgb(roleColor("yellow")));
					},
					(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
				);
			}
		});
		test(`the Model row holds a loading marker while the control plane fetches the list (${size.width}x${size.height})`, async () => {
			await appOn(
				{
					config: seatOpenConfig,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					const opened = await settle(setup);
					expect(frameText(opened)).toContain("Model (loading...)");
					await moveToModelRow(setup);
					// The waiting row is not a field: it holds no list to search, so
					// the letters cannot be mistaken for a model the operator meant
					// to choose, and no search line appears under it.
					await typeText(setup, "sonnet");
					const held = await settle(setup);
					expect(frameText(held)).toContain("Model (loading...)");
					expect(frameText(held)).not.toContain("sonnet");
					expect(searchRowOf(held)).toBe("");
					// Only movement keys leave the row.
					await guideKey(setup, "move-list", "↓", { quiet: true });
					const thinking = await frameUntil(setup, "the selection to move to Thinking", (f) =>
						f.includes("❯ Thinking"),
					);
					expect(frameText(thinking)).toContain("❯ Thinking");
					// The query answers: the row becomes the list it reported, with
					// its search line under it.
					runner.releaseModelLists();
					await guideKey(setup, "move-list", "↑", { quiet: true });
					const ready = await frameUntil(setup, "the Model row to hold the list", (f) =>
						f.includes("❯ Model"),
					);
					expect(frameText(ready)).toContain("Model (unset)");
					await typeModelSearch(setup, "sonnet");
					await frameUntil(setup, "the match", (f) =>
						frameText(f).includes("anthropic/claude-sonnet-4-5"),
					);
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
				(planeRecord) => {
					planeRecord.fakeRunner.holdModelLists();
				},
			);
		});
		test(`the Model row says so when the agent reports no models (${size.width}x${size.height})`, async () => {
			await appOn(
				{
					config: seatOpenConfig,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", []);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					const opened = await settle(setup);
					expect(frameText(opened)).toContain("Model (no models available)");
					await moveToModelRow(setup);
					// Nothing to cycle and nothing to type: the row takes the letters
					// as a run that can never match, so the value stays unset.
					await typeText(setup, "gpt");
					await pressBackspace(setup, "the row to stay cleared", (f) =>
						frameText(f).includes("Model (no models available)"),
					);
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).not.toContain("--model");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`a Model the selected agent cannot run shows in the warning color (${size.width}x${size.height})`, async () => {
			const config = configWith({ model: "gpt-4o" });

			await appOn(
				{
					config: config,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
					},
				},
				async (setup, planeRecord) => {
					const _runner = planeRecord.fakeRunner;

					await openPanel(setup, planeRecord);
					const opened = await settle(setup);
					// The task type names a model the agent's own list does not hold:
					// the handoff would fail on it, so the row warns before it can, and
					// states why in words at every size the panel renders at.
					expect(frameText(opened)).toContain("Model gpt-4o");
					expect(frameText(opened)).toContain("Error: Model:");
					expect(spanColors(setup, "gpt-4o")).toContainEqual(rgb(roleColor("yellow")));
					// The thinking level the task type names is supported, so it stays plain.
					expect(frameText(opened)).toContain("Thinking (unset)");
					// A search that names a model the agent does hold clears the
					// warning, because the value it selects is one the handoff can send.
					await moveToModelRow(setup);
					await typeModelSearch(setup, "claude");
					await frameUntil(setup, "the model the agent offers", (f) =>
						frameText(f).includes("Model anthropic/claude-sonnet-4-5"),
					);
					expect(spanColors(setup, "gpt-4o")).toEqual([]);
					// The selected row reads in the bright color, never the warning one.
					expect(spanColors(setup, "anthropic/claude-sonnet-4-5")).toEqual([
						rgb(roleColor("text")),
					]);
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`a Model the config prefilled is not judged while its list loads (${size.width}x${size.height})`, async () => {
			const config = configWith({ model: "openai/gpt-4o" });

			await appOn(
				{
					config: config,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					const opened = await settle(setup);
					expect(runner.modelListCalls).toEqual(["pi"]);
					// The row holds the config's own value. It is not judged: the list it
					// would be judged against has not arrived, so a model the config
					// resolved correctly must not read as a handoff that would fail.
					expect(frameText(opened)).toContain("Model openai/gpt-4o");
					expect(paintedIn(setup, "openai/gpt-4o", rgb(roleColor("subtext0")))).toBe(true);
					await moveToModelRow(setup);
					// The bar still names the row's controls while it waits: the row
					// holds the config's value, dim, where an empty row shows the
					// loading marker.
					expect(frameText(setup.captureCharFrame())).toContain("↑↓/jk Move");
					// The row takes no input while it waits.
					await typeText(setup, "sonnet");
					const held = await settle(setup);
					expect(frameText(held)).toContain("Model openai/gpt-4o");
					expect(frameText(held)).not.toContain("sonnet");
					// The list arrives: the row can judge its value, and says the agent
					// offers it.
					runner.releaseModelLists();
					await awaitPaintedIn(
						setup,
						"openai/gpt-4o",
						rgb(roleColor("text")),
						"the fetched list to confirm the value",
					);
					// The bar switches to the Model list row's controls, which take
					// typed letters instead of j and k.
					expect(frameText(setup.captureCharFrame())).toContain("Type Edit");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
				(planeRecord) => {
					planeRecord.fakeRunner.holdModelLists();
				},
			);
		});
		test(`a Thinking level the selected agent does not declare shows in the warning color (${size.width}x${size.height})`, async () => {
			const config = configWith({ thinking: "xhigh" }, { defaultAgent: "claude" });

			await appOn(
				{
					config: config,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
					},
				},
				async (setup, planeRecord) => {
					const _runner = planeRecord.fakeRunner;

					await openPanel(setup, planeRecord);
					const opened = await settle(setup);
					expect(frameText(opened)).toContain("Thinking xhigh");
					expect(paintedIn(setup, "xhigh", rgb(roleColor("text")))).toBe(true);
					// The agent row is the one selected on open: cycling it left reaches
					// codex, which declares no level above high.
					await guideKey(setup, "cycle-choice", "←", { quiet: true });
					await frameUntil(setup, "the agent to become codex", (f) =>
						frameText(f).includes("Agent codex"),
					);
					// The level the task type named is one the new agent cannot run, so the
					// handoff would fail on it: the row says so before the operator can,
					// in words at every size the panel renders at.
					const warned = setup.captureCharFrame();
					expect(frameText(warned)).toContain("Thinking xhigh");
					expect(frameText(warned)).toContain("Error: Thinking:");
					expect(spanColors(setup, "xhigh")).toContainEqual(rgb(roleColor("yellow")));
					// The row still takes input: the operator can put a level the new agent
					// declares on it, and the warning goes with the old value.
					await moveToThinkingRow(setup);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "a level the agent declares", (f) =>
						frameText(f).includes("Thinking minimal"),
					);
					expect(spanColors(setup, "xhigh")).toEqual([]);
					expect(spanColors(setup, "minimal")).toEqual([rgb(roleColor("text"))]);
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`switching the agent keeps an untouched Model and queries the new agent's list (${size.width}x${size.height})`, async () => {
			const config = configWith({ model: "gpt-4o" });

			await appOn(
				{
					config: config,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					// Each setting resolves on its own chain: the agent row is the only
					// thing cycling it changes, so the task type's model rides on.
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the agent to become codex", (f) =>
						frameText(f).includes("Agent codex"),
					);
					expect(frameText(setup.captureCharFrame())).toContain("Model gpt-4o");
					// codex reports no list, so no query runs for it.
					expect(runner.modelListCalls).toEqual(["pi"]);
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`switching the task type re-derives an untouched Model row (${size.width}x${size.height})`, async () => {
			const config = mergeConfig({ model: "openai/gpt-5.1" });
			await appOn(
				{
					groupingAxis: "none",
					config: config,
					sources: [{ config: billingSource, tickets: [mergeTicket] }],
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					planeRecord.settleFirstFetch();
					await waitSourceHealthy(planeRecord.state);
					await guideKey(setup, "override", "e", { quiet: true });
					const opened = await settle(setup);
					expect(frameText(opened)).toContain("Model openai/gpt-5.1");
					await guideKey(setup, "move-list", "j", { quiet: true });
					await frameUntil(setup, "the selection to move to the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await guideKey(setup, "move-list", "j", { quiet: true });
					await frameUntil(setup, "the selection to move to the task type", (f) =>
						f.includes("❯ Task type"),
					);
					// implement names no model: the untouched row re-derives to unset.
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const toImplement = await frameUntil(setup, "the task type to become implement", (f) =>
						frameText(f).includes("Task type implement"),
					);
					expect(frameText(toImplement)).toContain("Model (unset)");
					// Cycling back restores the merge profile's model.
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const back = await frameUntil(setup, "the task type to cycle", (f) =>
						frameText(f).includes("Task type fix"),
					);
					expect(frameText(back)).toContain("Model (unset)");
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become review", (f) =>
						frameText(f).includes("Task type review"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become rework", (f) =>
						frameText(f).includes("Task type rework"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const toMerge = await frameUntil(setup, "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					expect(frameText(toMerge)).toContain("Model openai/gpt-5.1");
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("openai/gpt-5.1");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`a Model wider than its column shows its end and rides on whole (${size.width}x${size.height})`, async () => {
			// A real agent list carries one long provider in front of many models:
			// the head of the value says nothing the neighbour's head does not.
			const long =
				"llama-server=http://127.0.0.1:8080/AtomicChat/DeepSeek-V4-Flash-0731-GGUF:IQ1_M_XL";

			await appOn(
				{
					config: seatOpenConfig,
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", [long, `${long.slice(0, long.length - 1)}2`]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					await moveToModelRow(setup);
					await typeModelSearch(setup, "IQ1_M_XL");
					const shown = await frameUntil(setup, "the long model to show its tail", (f) =>
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
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`a failed model list query falls the Model row back to free text (${size.width}x${size.height})`, async () => {
			await appOn(
				{
					config: seatOpenConfig,
					repos: BILLING_REPOS,
					commands: liveBillingCheckout,
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					const onModel = await moveToModelRow(setup);
					// The fallback keeps the whole input: the caret and the editing keys,
					// and the empty field names the cause, so a kind that reports no
					// list and a query that failed do not read the same.
					expect(frameText(onModel)).toContain("Model (empty - query failed)");
					await typeText(setup, "gpt-4o");
					await pressEnterToHandoff(setup);
					const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
					expect(start?.args).toContain("gpt-4o");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
				(planeRecord) => {
					planeRecord.fakeRunner.setModelListFailure("pi", "network unreachable");
				},
			);
		});
		test(`a Model row the agent's kind cannot list names that cause (${size.width}x${size.height})`, async () => {
			const config: FactoryConfig = { ...BASE_CONFIG, defaultAgent: "codex" };

			await appOn(
				{
					config: config,
					repos: BILLING_REPOS,
					commands: liveBillingCheckout,
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					await openPanel(setup, planeRecord);
					const onModel = await moveToModelRow(setup);
					// The row is free text for the same reason the query failure makes it
					// free text, and the empty field says which of the two it is.
					expect(frameText(onModel)).toContain("Model (empty - no model list)");
					expect(frameText(onModel)).not.toContain("query failed");
					// No query ran for a kind that has no list command.
					expect(runner.modelListCalls).toEqual([]);
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`a Model the operator typed survives a task type switch (${size.width}x${size.height})`, async () => {
			const config = mergeConfig({ model: "openai/gpt-5.1" });
			await appOn(
				{
					groupingAxis: "none",
					config: config,
					sources: [{ config: billingSource, tickets: [mergeTicket] }],
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
					},
				},
				async (setup, planeRecord) => {
					const _runner = planeRecord.fakeRunner;

					planeRecord.settleFirstFetch();
					await waitSourceHealthy(planeRecord.state);
					// Story 15 for the Model row: a typed value counts as the operator's
					// own, because typing is how a list row is chosen.
					await guideKey(setup, "override", "e", { quiet: true });
					await moveToModelRow(setup);
					await typeText(setup, "clau");
					await frameUntil(setup, "the typed model", (f) =>
						frameText(f).includes("anthropic/claude-sonnet-4-5"),
					);
					await moveToTaskTypeFromModelRow(setup);
					// implement names gpt-5.1-2 and merge names gpt-5.1: a row the
					// operator typed into keeps claude at both stops.
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const switched = await frameUntil(setup, "the task type to become implement", (f) =>
						frameText(f).includes("Task type implement"),
					);
					expect(frameText(switched)).toContain("Model anthropic/claude-sonnet-4-5");
					await guideKey(setup, "cycle-choice", "←", { quiet: true });
					await frameUntil(setup, "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					const backOnModel = await moveToModelRowFromTaskType(setup);
					expect(frameText(backOnModel)).toContain("Model anthropic/claude-sonnet-4-5");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`a Model the operator cleared survives a task type switch (${size.width}x${size.height})`, async () => {
			// A list that arrives late shows why an untouched row alone is not enough:
			// the clear is the operator's decision either way.
			const config = mergeConfig({ model: "openai/gpt-5.1" });
			await appOn(
				{
					groupingAxis: "none",
					config: config,
					sources: [{ config: billingSource, tickets: [mergeTicket] }],
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5", "openai/gpt-5.1"]);
					},
				},
				async (setup, planeRecord) => {
					const _runner = planeRecord.fakeRunner;

					planeRecord.settleFirstFetch();
					await waitSourceHealthy(planeRecord.state);
					// Story 15 for the Model row, with clearing as the only touch: the
					// operator who cleared the profile's model to hand off with the
					// agent's own default must not watch it come back.
					await guideKey(setup, "override", "e", { quiet: true });
					const opened = await settle(setup);
					expect(frameText(opened)).toContain("Model openai/gpt-5.1");
					await moveToModelRow(setup);
					// The row starts with no query, so one Delete gives the setting
					// back to the agent.
					await pressDelete(setup, "the Model row to clear", (f) =>
						frameText(f).includes("Model (unset)"),
					);
					await moveToTaskTypeFromModelRow(setup);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become implement", (f) =>
						frameText(f).includes("Task type implement"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become fix", (f) =>
						frameText(f).includes("Task type fix"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become review", (f) =>
						frameText(f).includes("Task type review"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become rework", (f) =>
						frameText(f).includes("Task type rework"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const toMerge = await frameUntil(setup, "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					// merge names a model, and the row the operator cleared stays cleared.
					expect(frameText(toMerge)).toContain("Model (unset)");
					expect(frameText(toMerge)).not.toContain("Model openai/gpt-5.1");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
		test(`switching the task type re-derives an untouched Agent row (${size.width}x${size.height})`, async () => {
			const config = mergeConfig({ agent: "claude" });
			await appOn(
				{
					groupingAxis: "none",
					config: config,
					sources: [{ config: billingSource, tickets: [mergeTicket] }],
					repos: BILLING_REPOS,
					commands: (fake, home2) => {
						liveBillingCheckout(fake, home2);
						fake.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
					},
				},
				async (setup, planeRecord) => {
					const runner = planeRecord.fakeRunner;
					planeRecord.settleFirstFetch();
					await waitSourceHealthy(planeRecord.state);
					// The merge profile names claude, so the agent row starts there: the
					// profile leg of the chain, not `default-agent`.
					await guideKey(setup, "override", "e", { quiet: true });
					const opened = await settle(setup);
					expect(frameText(opened)).toContain("Agent claude");
					// claude reports no list, so no query ran for the agent the row opened on.
					expect(runner.modelListCalls).toEqual([]);
					await guideKey(setup, "move-list", "j", { quiet: true });
					await frameUntil(setup, "the selection to reach the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await guideKey(setup, "move-list", "j", { quiet: true });
					await frameUntil(setup, "the selection to reach the task type", (f) =>
						f.includes("❯ Task type"),
					);
					// implement names no agent, so the untouched row follows its profile
					// through the default agent instead of holding claude.
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const toImplement = await frameUntil(setup, "the task type to become implement", (f) =>
						frameText(f).includes("Task type implement"),
					);
					expect(frameText(toImplement)).toContain("Agent pi");
					// The operator touches the agent row, and a later switch leaves it be.
					await guideKey(setup, "move-list", "k", { quiet: true });
					await frameUntil(setup, "the selection to reach the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await guideKey(setup, "move-list", "k", { quiet: true });
					await frameUntil(setup, "the selection to reach the agent row", (f) =>
						f.includes("❯ Agent"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the agent to become codex", (f) =>
						frameText(f).includes("Agent codex"),
					);
					await guideKey(setup, "move-list", "j", { quiet: true });
					await frameUntil(setup, "the selection to reach the environment", (f) =>
						f.includes("❯ Environment"),
					);
					await guideKey(setup, "move-list", "j", { quiet: true });
					await frameUntil(setup, "the selection to reach the task type", (f) =>
						f.includes("❯ Task type"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const back = await frameUntil(setup, "the task type to become fix", (f) =>
						frameText(f).includes("Task type fix"),
					);
					expect(frameText(back)).toContain("Agent codex");
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become review", (f) =>
						frameText(f).includes("Task type review"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					await frameUntil(setup, "the task type to become rework", (f) =>
						frameText(f).includes("Task type rework"),
					);
					await guideKey(setup, "cycle-choice", "→", { quiet: true });
					const toMerge = await frameUntil(setup, "the task type to become merge", (f) =>
						frameText(f).includes("Task type merge"),
					);
					// merge names claude, and the row the operator set keeps codex.
					expect(frameText(toMerge)).toContain("Agent codex");
				},
				(planeRecord) => ({ width: size.width, height: size.height, plane: planeRecord }),
			);
		});
	}
	for (const size of PANEL_SIZES) modelListRowScenarios(size);
	test("the Thinking row offers the selected agent's levels, and backspace clears it", async () => {
		const config: FactoryConfig = { ...BASE_CONFIG, maxParallelAgents: 3, defaultAgent: "claude" };
		await appOn(
			{
				config: config,
				repos: BILLING_REPOS,
				commands: liveBillingCheckout,
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				await openPanel(setup, planeRecord);
				await moveToThinkingRow(setup);
				expect(frameText(setup.captureCharFrame())).toContain("Thinking (unset)");
				// claude declares low through max, in that order: its row starts on
				// low and never offers minimal or off.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the first level the agent supports", (f) =>
					frameText(f).includes("Thinking low"),
				);
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the next level", (f) => frameText(f).includes("Thinking medium"));
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the next level", (f) => frameText(f).includes("Thinking high"));
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the next level", (f) => frameText(f).includes("Thinking xhigh"));
				const last = await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the last level the agent supports", (f) =>
					frameText(f).includes("Thinking max"),
				);
				expect(frameText(last)).toContain("Thinking max");
				expect(frameText(last)).not.toContain("Thinking minimal");
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the level to wrap to the first", (f) =>
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
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	}, 20000);
	test("a failed worktree handoff removes its residue and keeps the ticket open", async () => {
		await appOn(
			{
				config: seatOpenConfig,
				repos: BILLING_REPOS,
				commands: (fake, home2) => {
					const path = stubBillingCheckout(fake, home2);
					stubWorktreeHandoff(fake, path);
					fake.set("herdr", ["agent", "start", firstAgent, "--kind", "pi", "--pane", "pane-wt"], {
						code: 1,
						stderr: "agent name is already used\n",
					});
				},
			},
			async (setup, planeRecord) => {
				const runner = planeRecord.fakeRunner;
				const checkout = join(planeRecord.home, "src", "billing");

				await openPanel(setup, planeRecord);
				await guideKey(setup, "move-list", "j", { quiet: true });
				await frameUntil(setup, "the row selection to move to the environment", (f) =>
					f.includes("❯ Environment"),
				);
				// The value column shows the new kind; "live-worktree" still
				// carries "worktree", so the full row is the predicate.
				await guideKey(setup, "cycle-choice", "→", { quiet: true });
				await frameUntil(setup, "the environment to cycle to worktree", (f) =>
					frameText(f).includes("Environment worktree"),
				);
				const frame = await handoffEnter(
					setup,
					"the failure reason to appear",
					"agent name is already used",
				);
				// The reason sits on the permanent Message line; the Ticket stays open.
				expect(messageRowOf(frame)).toContain("agent name is already used");
				expect(selectedRow(frame)).toContain("[open]");
				// The residue is removed: the worktree and the branch, so a
				// retry can run.
				const commands = runner.commands();
				expect(commands).toContain("herdr worktree remove --workspace ws-wt");
				expect(commands).toContain(
					`git -C ${checkout} branch -D factory/${first.externalKey.slice(1)}-${firstSlug}`,
				);
			},
			(planeRecord) => ({ width: WIDTH, height: HEIGHT, plane: planeRecord }),
		);
	});
});
