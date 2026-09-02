/**
 * The handoff tests: the exact external command sequence each handoff
 * produces, and how a failure settles the ticket.
 *
 * The herdr CLI contract is pinned here, and the fake runner records every
 * command, so a drift in the sequence fails the suite. No test touches a
 * real herdr session.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import {
	checkConsultationStart,
	closeHandoffEnvironment,
	type HandoffOutcome,
	handOffConsultation,
	handOffStoredWorkspace,
	handOffTicket,
	renderPrompt,
	renderSettingArgs,
	settingArgs,
} from "../src/handoff.ts";
import type { Consultation } from "../src/state.ts";
import {
	FakeRunner,
	tabCreateJson,
	WORKTREE_NOT_FOUND_ERROR,
	workspaceCreateJson,
	workspaceListJson,
	worktreeCreateJson,
	worktreeOpenJson,
} from "./fake-runner.ts";

let HOME = "";
let CHECKOUT = "";

/** The reason a non-ok outcome carries; a success has none to read. */
function reasonOf(outcome: HandoffOutcome): string {
	if (outcome.status === "ok") {
		throw new Error("no reason on an ok outcome");
	}
	return outcome.reason;
}

beforeAll(() => {
	// A real home with a real checkout directory: resolution does real
	// filesystem work against it, while every git command stays faked.
	HOME = join(tmpdir(), `factory-handoff-${Math.random().toString(36).slice(2)}`);
	CHECKOUT = join(HOME, "src", "billing");
	mkdirSync(CHECKOUT, { recursive: true });
	writeFileSync(join(CHECKOUT, "marker"), "repo");
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

/** The path a herdr worktree checkout of the ticket's branch takes. */
const WORKTREE_PATH = join(HOME, "worktrees", "billing", "factory-7-retry-policy-for-webhooks");

const ticket: Ticket = {
	identity: "github:github.com:I_7",
	title: "Retry policy for webhooks",
	repository: "acme/billing",
	repositoryRef: {
		identity: "github.com/acme/billing",
		displayName: "acme/billing",
		cloneUrl: "https://github.com/acme/billing.git",
	},
	state: "open",
	handoff: null,
	description: "Add a retry policy.",
	sourceKind: "github-issue",
	externalKey: "#7",
	sourceState: "open",
	url: "https://github.com/acme/billing/issues/7",
	labels: [],
	externalUpdatedAt: "2026-01-01T00:00:00Z",
	memberships: [],
	suggestedTaskType: "implement",
	actionable: true,
	handoffRecoveryRequired: false,
	handoffCount: 0,
	lastCompletion: null,
};

const defaultChoice = {
	agentType: "pi",
	environment: "live-worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
};

/** Stub the live-worktree herdr sequence at the convention checkout. */
function stubLiveWorkspace(runner: FakeRunner): void {
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([{ id: "ws-other" }]) });
	runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
		stdout: workspaceCreateJson("ws-new"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-new", "--cwd", CHECKOUT, "--no-focus"], {
		stdout: tabCreateJson("pane-1"),
	});
}

/** The exact prompt the implement task type renders for this ticket. */
const PROMPT = renderPrompt(DEFAULT_CONFIG.taskTypes.implement.template, ticket);
const AGENT = "retry-policy-for-webhooks";

/** A git checkout that resolves from the convention path. */
function conventionCheckout(runner: FakeRunner): void {
	runner.set("git", ["-C", CHECKOUT, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", CHECKOUT, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
}

/** A Consultation record, as the state hands it to its own start. */
function consultationRecord(over: Partial<Consultation> = {}): Consultation {
	return {
		id: "consultation-1",
		typeName: "grill-with-docs",
		agentType: "pi",
		environment: "live-worktree",
		model: "",
		thinking: "",
		template: "/grill {input}",
		initialInput: "review auth",
		renderedOpeningPrompt: "/grill review auth",
		repository: {
			identity: "github.com/acme/billing",
			displayName: "acme/billing",
			cloneUrl: "https://github.com/acme/billing.git",
			path: CHECKOUT,
		},
		state: "opening",
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		agentName: "consultation-11111111",
		paneId: null,
		tabId: null,
		workspaceId: null,
		sessionId: null,
		latestSequence: null,
		draft: "",
		draftUpdatedAt: null,
		draftOld: false,
		failure: null,
		warning: null,
		replacementOf: null,
		closeResult: null,
		liveConflictOverride: false,
		attentionAt: null,
		pendingResponse: null,
		resources: [],
		...over,
	};
}

describe("renderSettingArgs", () => {
	test("substitutes the value into the token that asks for it", () => {
		expect(renderSettingArgs("--model {value}", "gpt-5.6")).toEqual(["--model", "gpt-5.6"]);
		expect(renderSettingArgs("-c model_reasoning_effort={value}", "high")).toEqual([
			"-c",
			"model_reasoning_effort=high",
		]);
	});

	test("one value is always one argument cell", () => {
		// The rule the Model list is offered against. A value that carries
		// whitespace (a config value, or text pasted into the free-text row) must
		// not split into an argument plus a stray positional, because the agent
		// would start on a model nobody chose.
		expect(renderSettingArgs("--model {value}", "my corp/model-x")).toEqual([
			"--model",
			"my corp/model-x",
		]);
		expect(renderSettingArgs("-c model_reasoning_effort={value}", "x y")).toEqual([
			"-c",
			"model_reasoning_effort=x y",
		]);
	});

	test("dollar patterns in the value stay literal", () => {
		expect(renderSettingArgs("--model {value}", "$&-$1-model")).toEqual(["--model", "$&-$1-model"]);
	});

	test("a template with no value to place leaves no empty argument", () => {
		expect(renderSettingArgs("--model {value}", "")).toEqual(["--model"]);
	});
});

describe("renderPrompt", () => {
	test("fills the three placeholders of the template", () => {
		const prompt = renderPrompt("Repo: {repository}\nTitle: {title}\n{description}", ticket);
		expect(prompt).toBe(
			"Repo: acme/billing\nTitle: Retry policy for webhooks\nAdd a retry policy.",
		);
	});

	test("a value that carries another placeholder is not re-scanned", () => {
		const tricky: Ticket = { ...ticket, title: "Handle {description} in the body" };
		const prompt = renderPrompt("Title: {title}\nBody: {description}", tricky);
		expect(prompt).toBe("Title: Handle {description} in the body\nBody: Add a retry policy.");
	});

	test("dollar patterns in a value stay literal", () => {
		const tricky: Ticket = { ...ticket, description: "match $& and $1 verbatim" };
		const prompt = renderPrompt("Body: {description}", tricky);
		expect(prompt).toBe("Body: match $& and $1 verbatim");
	});

	test("{previous-message} takes the last captured message, empty for open tickets", () => {
		const prompt = renderPrompt("Prev: {previous-message}\n{description}", ticket, "settled");
		expect(prompt).toBe("Prev: settled\nAdd a retry policy.");
		expect(renderPrompt("Prev: {previous-message}", ticket)).toBe("Prev: ");
	});
});

describe("settingArgs", () => {
	test("a chosen setting the agent maps becomes arguments", () => {
		const agent = DEFAULT_CONFIG.agents.pi;
		expect(settingArgs(agent, { ...defaultChoice, model: "gpt-5.6", thinking: "high" })).toEqual([
			"--model",
			"gpt-5.6",
			"--thinking",
			"high",
		]);
	});

	test("an omitted setting is ignored: no template, no arguments", () => {
		// No setting chosen: no arguments at all.
		expect(settingArgs(DEFAULT_CONFIG.agents.pi, defaultChoice)).toEqual([]);
		// Only the thinking chosen: the model template contributes nothing.
		expect(
			settingArgs(DEFAULT_CONFIG.agents.codex, { ...defaultChoice, thinking: "high" }),
		).toEqual(["-c", "model_reasoning_effort=high"]);
		// An agent with no setting template maps nothing at all.
		expect(
			settingArgs({ kind: "cursor" }, { ...defaultChoice, model: "m", thinking: "high" }),
		).toEqual([]);
	});

	test("an empty thinking is left to the agent: no fallback, no arguments", () => {
		// The task type's thinking default is prefilled into the choice by
		// the app, not applied here: an empty choice stays empty, so the
		// panel can show exactly what the handoff will run on.
		expect(settingArgs(DEFAULT_CONFIG.agents.pi, defaultChoice)).toEqual([]);
		expect(settingArgs(DEFAULT_CONFIG.agents.pi, { ...defaultChoice, thinking: "low" })).toEqual([
			"--thinking",
			"low",
		]);
	});
});

describe("handOffTicket: the live worktree sequence", () => {
	test("creates the workspace when none holds the checkout, then tab, agent, prompt", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([{ id: "ws-other" }]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: workspaceCreateJson("ws-new"),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-new", "--cwd", CHECKOUT, "--no-focus"],
			{
				stdout: tabCreateJson("pane-1"),
			},
		);

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome).toEqual({
			status: "ok",
			agent: { paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-new" },
		});
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			"herdr workspace list",
			`herdr workspace create --cwd ${CHECKOUT} --no-focus`,
			`herdr tab create --workspace ws-new --cwd ${CHECKOUT} --no-focus`,
			`herdr agent start ${AGENT} --kind pi --pane pane-1`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
		]);
	});

	test("retries a busy fresh pane until its shell is available", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: workspaceCreateJson("ws-new"),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-new", "--cwd", CHECKOUT, "--no-focus"],
			{ stdout: tabCreateJson("pane-1") },
		);
		runner.setSequence(
			"herdr",
			["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-1"],
			[
				{
					code: 1,
					stderr:
						'{"error":{"code":"agent_pane_busy","message":"agent target pane pane-1 is not an available shell"},"id":"cli:agent:start"}',
				},
				{},
			],
		);

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("ok");
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			"herdr workspace list",
			`herdr workspace create --cwd ${CHECKOUT} --no-focus`,
			`herdr tab create --workspace ws-new --cwd ${CHECKOUT} --no-focus`,
			`herdr agent start ${AGENT} --kind pi --pane pane-1`,
			`herdr agent start ${AGENT} --kind pi --pane pane-1`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
		]);
	});

	test("stops retrying a pane that never reaches a shell", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123\n" });
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--base",
				"abc123",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr:
				'{"error":{"code":"agent_pane_busy","message":"agent target pane pane-wt is not an available shell"},"id":"cli:agent:start"}',
		});

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_pane_busy");
		const starts = runner.commands().filter((command) => command.startsWith("herdr agent start"));
		expect(starts.length).toBeGreaterThan(1);
		// The bounded failure still uses the normal worktree cleanup.
		expect(runner.commands()).toContain("herdr worktree remove --workspace ws-wt");
		expect(runner.commands()).toContain(
			`git -C ${CHECKOUT} branch -D factory/7-retry-policy-for-webhooks`,
		);
	});

	test("reuses the workspace that already holds the checkout", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([
				{ id: "ws-other", checkoutPath: "/elsewhere" },
				{ id: "ws-mine", checkoutPath: CHECKOUT },
			]),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-mine", "--cwd", CHECKOUT, "--no-focus"],
			{
				stdout: tabCreateJson("pane-9"),
			},
		);

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).not.toContain(`herdr workspace create --cwd ${CHECKOUT} --no-focus`);
		expect(commands).toContain(`herdr tab create --workspace ws-mine --cwd ${CHECKOUT} --no-focus`);
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-9`);
	});

	test("settings the agent maps ride on the agent start, after a --", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws", checkoutPath: CHECKOUT }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});

		const choice = { ...defaultChoice, agentType: "codex", model: "gpt-5.6", thinking: "high" };
		const outcome = await handOffTicket(ticket, choice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("ok");
		const start = runner.calls.find(
			(c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "start",
		);
		expect(start?.args).toEqual([
			"agent",
			"start",
			AGENT,
			"--kind",
			"codex",
			"--pane",
			"pane-1",
			"--",
			"--model",
			"gpt-5.6",
			"-c",
			"model_reasoning_effort=high",
		]);
	});

	test("a failed herdr step leaves the ticket open with the reason", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			code: 1,
			stderr: "error: herdr is not running\n",
		});

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome).toEqual({ status: "failed", reason: "error: herdr is not running" });
		// Nothing after the failed step runs.
		expect(runner.commands()).not.toContain(expect.stringContaining("agent start"));
	});

	test("a prompt failure after the agent started still settles the ticket as handed off", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws", checkoutPath: CHECKOUT }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});
		runner.set("herdr", ["agent", "prompt", AGENT, PROMPT], {
			code: 1,
			stderr: "error: agent lost its pane\n",
		});

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("prompt-failed");
		expect(reasonOf(outcome)).toContain("started, but the prompt failed");
	});

	test("an unreadable workspace list fails instead of creating a second workspace", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: "not a workspace list\n" });

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("readable workspace list");
		// Unreadable is not "no workspace": the one-workspace-per-repository
		// rule holds, so no second workspace is created for the checkout.
		expect(runner.commands()).not.toContain(expect.stringContaining("workspace create"));
	});
});

describe("handOffTicket: the worktree sequence", () => {
	test("checks the branch, reads HEAD, creates the worktree, starts the agent, sends the prompt", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123\n" });
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--base",
				"abc123",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			`git -C ${CHECKOUT} branch --list factory/7-retry-policy-for-webhooks`,
			`git -C ${CHECKOUT} rev-parse HEAD`,
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base abc123 --no-focus`,
			`herdr agent start ${AGENT} --kind pi --pane pane-wt`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
		]);
	});

	test("an existing branch reuses the open worktree workspace with a fresh tab", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "  factory/7-retry-policy-for-webhooks\n",
		});
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{
				stdout: worktreeOpenJson("ws-wt", "pane-root", {
					alreadyOpen: true,
					worktreePath: WORKTREE_PATH,
				}),
			},
		);
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-wt", "--cwd", WORKTREE_PATH, "--no-focus"],
			{ stdout: tabCreateJson("pane-tab") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			`git -C ${CHECKOUT} branch --list factory/7-retry-policy-for-webhooks`,
			`herdr worktree open --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
			`herdr tab create --workspace ws-wt --cwd ${WORKTREE_PATH} --no-focus`,
			`herdr agent start ${AGENT} --kind pi --pane pane-tab`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
		]);
		// The pre-existing branch is reused, never recreated or re-based.
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree create"));
		expect(runner.commands()).not.toContain(expect.stringContaining("rev-parse HEAD"));
	});

	test("an existing branch without an open workspace attaches one and starts in its first pane", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "  factory/7-retry-policy-for-webhooks\n",
		});
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{
				stdout: worktreeOpenJson("ws-wt", "pane-wt", {
					alreadyOpen: false,
					worktreePath: WORKTREE_PATH,
				}),
			},
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree open --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-wt`);
		expect(commands).toContain(`herdr agent prompt ${AGENT} ${PROMPT}`);
		// A fresh workspace has its own first pane: no extra tab, no create.
		expect(commands).not.toContain(expect.stringContaining("tab create"));
		expect(commands).not.toContain(expect.stringContaining("worktree create"));
	});

	test("an existing branch no worktree holds is checked out into a fresh worktree", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "  factory/7-retry-policy-for-webhooks\n",
		});
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{ code: 1, stderr: WORKTREE_NOT_FOUND_ERROR },
		);
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		// The existing branch is checked out, not re-created from a base.
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expect(commands).not.toContain(expect.stringContaining("--base"));
		expect(commands).not.toContain(expect.stringContaining("rev-parse HEAD"));
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-wt`);
	});

	test("a failed agent start in an open worktree workspace closes only the fresh tab", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "  factory/7-retry-policy-for-webhooks\n",
		});
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{
				stdout: worktreeOpenJson("ws-wt", "pane-root", {
					alreadyOpen: true,
					worktreePath: WORKTREE_PATH,
				}),
			},
		);
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-wt", "--cwd", WORKTREE_PATH, "--no-focus"],
			{ stdout: tabCreateJson("pane-tab") },
		);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-tab"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		// The fresh tab is removed; the workspace and the branch pre-date the
		// handoff and stay.
		const commands = runner.commands();
		expect(commands.filter((command) => command.startsWith("herdr agent start"))).toHaveLength(1);
		expect(commands).toContain("herdr tab close tab-1");
		expect(commands.indexOf("herdr tab close tab-1")).toBeGreaterThan(
			commands.indexOf(`herdr agent start ${AGENT} --kind pi --pane pane-tab`),
		);
		expect(commands).not.toContain(expect.stringContaining("workspace close"));
		expect(commands).not.toContain(expect.stringContaining("worktree remove"));
		expect(commands).not.toContain(expect.stringContaining("branch -D"));
	});

	test("a failed agent start in an attached worktree closes the attached workspace", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "  factory/7-retry-policy-for-webhooks\n",
		});
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{
				stdout: worktreeOpenJson("ws-wt", "pane-wt", {
					alreadyOpen: false,
					worktreePath: WORKTREE_PATH,
				}),
			},
		);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		// The attached workspace is closed; the worktree and the branch
		// pre-date the handoff and stay.
		const commands = runner.commands();
		expect(commands).toContain("herdr workspace close ws-wt");
		expect(commands).not.toContain(expect.stringContaining("worktree remove"));
		expect(commands).not.toContain(expect.stringContaining("branch -D"));
		expect(commands).not.toContain(expect.stringContaining("tab close"));
	});

	test("a failed agent start on a checked-out branch removes the worktree but keeps the branch", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "  factory/7-retry-policy-for-webhooks\n",
		});
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{ code: 1, stderr: WORKTREE_NOT_FOUND_ERROR },
		);
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		// The fresh worktree is removed, so a retry can run. The branch
		// pre-dates the handoff and may hold the ticket's earlier work: it
		// stays.
		const commands = runner.commands();
		expect(commands).toContain(`herdr worktree remove --workspace ws-wt`);
		expect(commands).not.toContain(expect.stringContaining("branch -D"));
	});

	test("a failed worktree open for a reason other than a missing worktree fails without a create", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "  factory/7-retry-policy-for-webhooks\n",
		});
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{ code: 1, stderr: "error: herdr is not running\n" },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toBe("error: herdr is not running");
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree create"));
	});

	test("a failed agent start removes the worktree and the branch", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123\n" });
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--base",
				"abc123",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		// The residue is removed, so a retry can run instead of failing on
		// the branch the first attempt left behind.
		const commands = runner.commands();
		expect(commands).toContain(`herdr worktree remove --workspace ws-wt`);
		expect(commands).toContain(`git -C ${CHECKOUT} branch -D factory/7-retry-policy-for-webhooks`);
		// The cleanup runs after the failure, not before it.
		expect(commands.indexOf(`herdr worktree remove --workspace ws-wt`)).toBeGreaterThan(
			commands.indexOf(`herdr agent start ${AGENT} --kind pi --pane pane-wt`),
		);
	});

	test("a worktree create without a workspace id points at the leftover branch", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123\n" });
		// A worktree create result without the workspace block.
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--base",
				"abc123",
				"--no-focus",
			],
			{ stdout: JSON.stringify({ result: { root_pane: { pane_id: "pane-wt" } } }) },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("no workspace id");
		expect(reasonOf(outcome)).toContain("leftover branch factory/7-retry-policy-for-webhooks");
		// The cleanup needs the workspace id, so it cannot run and no
		// command ran after the failed step.
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree remove"));
	});

	test("a started agent keeps the worktree even when the prompt fails", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123\n" });
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--base",
				"abc123",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);
		runner.set("herdr", ["agent", "prompt", AGENT, PROMPT], { code: 1, stderr: "prompt failed\n" });

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);

		// The agent is running in the worktree and can be prompted by hand.
		expect(outcome.status).toBe("prompt-failed");
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree remove"));
	});
});

describe("handOffTicket: the guard rails", () => {
	test("only open tickets can be handed off", async () => {
		const runner = new FakeRunner();
		const outcome = await handOffTicket({ ...ticket, state: "running" }, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});
		expect(outcome.status).toBe("failed");
		expect(runner.calls).toHaveLength(0);
	});

	test("the container environment is reserved", async () => {
		const runner = new FakeRunner();
		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "container" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);
		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("reserved");
		expect(runner.calls).toHaveLength(0);
	});

	describe("handOffTicket: the setting fit check (ADR 0010)", () => {
		test("a model the agent does not report fails before its first external change", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

			const outcome = await handOffTicket(
				ticket,
				{ ...defaultChoice, model: "gpt-4o" },
				{ config: DEFAULT_CONFIG, runner, home: HOME },
			);

			expect(outcome.status).toBe("failed");
			expect(reasonOf(outcome)).toBe(
				'agent "pi" (pi) has no model "gpt-4o": check the model id and its provider auth',
			);
			// Nothing ran: not the repository resolution, not herdr, not the start.
			expect(runner.calls).toHaveLength(0);
			expect(runner.modelListCalls).toEqual(["pi"]);
		});

		test("a model the agent reports rides on the start", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

			const outcome = await handOffTicket(
				ticket,
				{ ...defaultChoice, model: "anthropic/claude-sonnet-4-5" },
				{ config: DEFAULT_CONFIG, runner, home: HOME },
			);

			expect(outcome.status).toBe("ok");
			const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
			expect(start?.args).toEqual([
				"agent",
				"start",
				AGENT,
				"--kind",
				"pi",
				"--pane",
				"pane-1",
				"--",
				"--model",
				"anthropic/claude-sonnet-4-5",
			]);
		});

		test("an unfit thinking level fails the handoff, and no list query is needed to see it", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

			const outcome = await handOffTicket(
				ticket,
				{ ...defaultChoice, model: "anthropic/claude-sonnet-4-5", thinking: "ultra" },
				{ config: DEFAULT_CONFIG, runner, home: HOME },
			);

			expect(outcome.status).toBe("failed");
			expect(reasonOf(outcome)).toContain('does not support the thinking level "ultra"');
			expect(runner.calls).toHaveLength(0);
			// The levels the agent declares are in the config, so the check needs
			// no query.
			expect(runner.modelListCalls).toHaveLength(0);
		});

		test("a model list that cannot be fetched lets the handoff run on", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			// The fake holds no list for the pi kind: the query fails as an
			// uninstalled or unreadable CLI would, and the agent's own rejection
			// stands.
			const outcome = await handOffTicket(
				ticket,
				{ ...defaultChoice, model: "gpt-4o" },
				{ config: DEFAULT_CONFIG, runner, home: HOME },
			);

			expect(outcome.status).toBe("ok");
			const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
			expect(start?.args).toContain("gpt-4o");
		});

		test("a restart fails an unfit model before it touches the stored workspace", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

			const outcome = await handOffStoredWorkspace({
				ticket,
				choice: { ...defaultChoice, model: "gpt-4o" },
				config: DEFAULT_CONFIG,
				runner,
				home: HOME,
				workspaceId: "ws-stored",
				environment: "live-worktree",
				previousTabId: "tab-prev",
				previousMessage: "settled earlier",
			});

			expect(outcome.status).toBe("failed");
			expect(reasonOf(outcome)).toContain('has no model "gpt-4o"');
			expect(runner.calls).toHaveLength(0);
		});
	});

	/**
	 * A Consultation start on its own, without the launch route around it.
	 *
	 * The route runs the pre-flight itself and carries its verdict in, so these
	 * tests answer for the branch that backs the claim that no path reaches the
	 * Agent unchecked: a start that carries no verdict is checked here.
	 */
	describe("handOffConsultation: the setting fit check", () => {
		test("a start with no verdict refuses an unfit model before any external change", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

			const outcome = await handOffConsultation({
				consultation: consultationRecord({ model: "gpt-4o" }),
				config: DEFAULT_CONFIG,
				runner,
				home: HOME,
			});

			expect(outcome.status).toBe("failed");
			if (outcome.status === "ok") throw new Error("expected a refusal");
			expect(outcome.reason).toContain('has no model "gpt-4o"');
			// Nothing outside the control plane: not the resolve, not the workspace,
			// not the start, not the prompt.
			expect(runner.calls).toHaveLength(0);
			expect(runner.modelListCalls).toEqual(["pi"]);
		});

		test("a start with no verdict refuses an unfit thinking level", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);

			const outcome = await handOffConsultation({
				consultation: consultationRecord({ thinking: "ultra" }),
				config: DEFAULT_CONFIG,
				runner,
				home: HOME,
			});

			expect(outcome.status).toBe("failed");
			if (outcome.status === "ok") throw new Error("expected a refusal");
			expect(outcome.reason).toContain('does not support the thinking level "ultra"');
			expect(runner.calls).toHaveLength(0);
			// The levels an Agent declares are in the config: no query is needed.
			expect(runner.modelListCalls).toHaveLength(0);
		});

		test("a start with no verdict runs on a fit model, and asks the CLI once", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

			const outcome = await handOffConsultation({
				consultation: consultationRecord({ model: "anthropic/claude-sonnet-4-5" }),
				config: DEFAULT_CONFIG,
				runner,
				home: HOME,
			});

			expect(outcome.status).toBe("ok");
			expect(runner.modelListCalls).toEqual(["pi"]);
			const start = runner.calls.find((c) => c.args[0] === "agent" && c.args[1] === "start");
			expect(start?.args).toEqual([
				"agent",
				"start",
				"consultation-11111111",
				"--kind",
				"pi",
				// A live Consultation with no workspace of its own starts in the root
				// pane of the workspace the launch created.
				"--pane",
				"pane-w",
				"--",
				"--model",
				"anthropic/claude-sonnet-4-5",
			]);
		});

		test("a start that carries the launch route's verdict does not ask again", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
			const consultation = consultationRecord({ model: "anthropic/claude-sonnet-4-5" });
			const startCheck = await checkConsultationStart({
				consultation,
				config: DEFAULT_CONFIG,
				runner,
			});
			expect(startCheck.ok).toBe(true);

			const outcome = await handOffConsultation({
				consultation,
				config: DEFAULT_CONFIG,
				runner,
				home: HOME,
				startCheck,
			});

			expect(outcome.status).toBe("ok");
			// One Consultation, one query: the route checked first, and the start read
			// that verdict instead of asking the agent's CLI a second time.
			expect(runner.modelListCalls).toEqual(["pi"]);
		});
	});

	test("an unknown agent type or task type fails without a command", async () => {
		const runner = new FakeRunner();
		const agent = await handOffTicket(
			ticket,
			{ ...defaultChoice, agentType: "cursor" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);
		expect(agent.status).toBe("failed");
		const task = await handOffTicket(
			ticket,
			{ ...defaultChoice, taskType: "refactor" },
			{ config: DEFAULT_CONFIG, runner, home: HOME },
		);
		expect(task.status).toBe("failed");
		expect(runner.calls).toHaveLength(0);
	});

	test("a failed herdr step after a sibling clone still hands back the mapping", async () => {
		const runner = new FakeRunner();
		// The convention path holds a different repository: a sibling clone.
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", CHECKOUT, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/portal.git\n",
		});
		const sibling = join(HOME, "src", "billing_1");
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", sibling, "--no-focus"], {
			code: 1,
			stderr: "error: herdr is not running\n",
		});

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		// The clone ran and the handoff failed after it: the mapping must not
		// wait for a later successful handoff.
		expect(outcome.notes?.mappingToWrite).toEqual({
			repository: "github.com/acme/billing",
			path: sibling,
		});
		expect(reasonOf(outcome)).toBe("error: herdr is not running");
	});

	test("a sibling clone warns and hands back the mapping to persist", async () => {
		const runner = new FakeRunner();
		// The convention path holds a different repository.
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", CHECKOUT, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/portal.git\n",
		});
		const sibling = join(HOME, "src", "billing_1");
		// The handoff then runs at the sibling, not the conflicting path.
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", sibling, "--no-focus"], {
			stdout: workspaceCreateJson("ws-1"),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", sibling, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("ok");
		expect(outcome.notes?.warning).toContain("sibling");
		expect(outcome.notes?.mappingToWrite).toEqual({
			repository: "github.com/acme/billing",
			path: sibling,
		});
		// The handoff runs at the sibling, not the conflicting path.
		expect(runner.commands()).toContain(`git clone https://github.com/acme/billing.git ${sibling}`);
	});
});

/** A config whose implement template carries the previous message. */
const previousMessageConfig: FactoryConfig = {
	...DEFAULT_CONFIG,
	taskTypes: {
		...DEFAULT_CONFIG.taskTypes,
		implement: {
			...DEFAULT_CONFIG.taskTypes.implement,
			template: "Previous: {previous-message}\n{description}",
		},
	},
};

describe("handOffStoredWorkspace: the workflow handoff and the restart", () => {
	test("reuses the stored live workspace, tabs without a cwd, closes the previous tab", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-stored", "--no-focus"], {
			stdout: tabCreateJson("pane-2"),
		});

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: defaultChoice,
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("ok");
		expect(outcome.status === "ok" && outcome.agent).toEqual({
			paneId: "pane-2",
			tabId: "tab-1",
			workspaceId: "ws-stored",
		});
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			"herdr workspace list",
			"herdr tab create --workspace ws-stored --no-focus",
			`herdr agent start ${AGENT} --kind pi --pane pane-2`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
			"herdr tab close tab-prev",
		]);
	});

	test("the prompt carries the last captured message through the placeholder", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-stored", "--no-focus"], {
			stdout: tabCreateJson("pane-2"),
		});

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: defaultChoice,
			config: previousMessageConfig,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: null,
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("ok");
		const prompt = runner.calls.find(
			(c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "prompt",
		);
		// `herdr agent prompt <name> <prompt>`: the prompt is the last argument.
		expect(prompt?.args.at(-1)).toBe("Previous: settled earlier\nAdd a retry policy.");
		// No previous tab: nothing to close.
		expect(runner.commands()).not.toContain(expect.stringContaining("tab close"));
	});

	test("a stored worktree that is gone is reopened on its branch", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-reopen", "pane-ro") },
		);

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: { ...defaultChoice, environment: "worktree" },
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-gone",
			environment: "worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("ok");
		// Reopen does not recheck the branch or read HEAD: the branch is the
		// branch, and herdr's open owns it.
		const commands = runner.commands();
		expect(commands).not.toContain(expect.stringContaining("branch --list"));
		expect(commands).not.toContain(expect.stringContaining("rev-parse HEAD"));
		expect(commands).toContain(
			`herdr worktree open --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-ro`);
		expect(commands).toContain("herdr tab close tab-prev");
	});

	test("a stored live workspace that is gone falls back to the live sequence", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-still", checkoutPath: CHECKOUT }]),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-still", "--cwd", CHECKOUT, "--no-focus"],
			{ stdout: tabCreateJson("pane-3") },
		);

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: defaultChoice,
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-gone",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		// The live sequence found the workspace the checkout still lives in.
		expect(commands).toContain(
			`herdr tab create --workspace ws-still --cwd ${CHECKOUT} --no-focus`,
		);
		expect(commands).not.toContain(expect.stringContaining("workspace create"));
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-3`);
		expect(commands).toContain("herdr tab close tab-prev");
	});

	test("a stored workspace of another environment kind is not reused", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123\n" });
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--base",
				"abc123",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: { ...defaultChoice, environment: "worktree" },
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-live",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("ok");
		// The choice says worktree, the storage says live: build fresh.
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base abc123 --no-focus`,
		);
		expect(commands).not.toContain(expect.stringContaining("tab create --workspace ws-live"));
	});

	test("an agent that fails in a reused workspace closes the tab the handoff made", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-stored", "--no-focus"], {
			stdout: tabCreateJson("pane-2"),
		});
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-2"], {
			code: 1,
			stderr: "error: herdr is not running\n",
		});

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: defaultChoice,
			config: DEFAULT_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("failed");
		const commands = runner.commands();
		// The fresh tab is closed, so no empty residue sits in the workspace.
		expect(commands).toContain("herdr tab close tab-1");
		// The previous tab belongs to the settled turn: it is not closed here.
		expect(commands).not.toContain("herdr tab close tab-prev");
	});
});

describe("closeHandoffEnvironment: the Close cleanup", () => {
	test("a worktree handoff removes the checkout; herdr closes the workspace with it", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
		);

		expect(failure).toBeUndefined();
		// worktree remove closes the workspace with the checkout and never
		// deletes the branch: there is no workspace close after it.
		expect(runner.commands()).toEqual(["herdr worktree remove --workspace ws-1"]);
		const joined = runner.commands().join("\n");
		expect(joined).not.toContain("branch -D");
		expect(joined).not.toContain("branch --delete");
		expect(joined).not.toContain("workspace close");
		expect(joined).not.toContain("tab close");
	});

	test("a worktree handoff with a dirty checkout reports the removal and keeps the workspace", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"dirty_worktree_requires_force","message":"fatal: the worktree has uncommitted changes, use --force to delete it"},"id":"cli:worktree:remove"}\n',
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
		);

		// The reason is the command's stderr: the caller reports it on the
		// status line with the ticket identity.
		expect(failure).toContain("dirty_worktree_requires_force");
		// The workspace stays: the checkout is still there.
		expect(runner.commands()).toEqual(["herdr worktree remove --workspace ws-1"]);
	});

	test("a worktree handoff whose workspace is already gone is a clean close", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"workspace_not_found","message":"workspace ws-1 not found"},"id":"cli:worktree:remove"}\n',
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
		);

		// The workspace is gone: there is no environment left to clean up.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual(["herdr worktree remove --workspace ws-1"]);
	});

	test("a worktree handoff whose checkout is gone closes the left workspace", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"worktree_remove_failed","message":"fatal: the path is not a working tree"},"id":"cli:worktree:remove"}\n',
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
		);

		// The checkout was deleted outside herdr: workspace close clears the
		// herdr state that remains, so the close is clean.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual([
			"herdr worktree remove --workspace ws-1",
			"herdr workspace close ws-1",
		]);
	});

	test("a worktree handoff whose checkout is gone and whose close fails reports the close", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"worktree_remove_failed","message":"fatal: the path is not a working tree"},"id":"cli:worktree:remove"}\n',
		});
		runner.set("herdr", ["workspace", "close", "ws-1"], {
			code: 1,
			stderr: "error: the herdr server is down\n",
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
		);

		expect(failure).toBe("error: the herdr server is down");
		expect(runner.commands()).toEqual([
			"herdr worktree remove --workspace ws-1",
			"herdr workspace close ws-1",
		]);
	});

	test("a worktree handoff without a stored workspace runs nothing", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: null },
			runner,
		);

		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual([]);
	});

	test("a live worktree handoff closes only the tab it made", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "live-worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
		);

		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual(["herdr tab close tab-1"]);
		const joined = runner.commands().join("\n");
		expect(joined).not.toContain("worktree remove");
		expect(joined).not.toContain("workspace close");
	});

	test("a live worktree handoff without a stored tab runs nothing", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "live-worktree", tabId: null, workspaceId: null },
			runner,
		);

		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual([]);
	});
});
