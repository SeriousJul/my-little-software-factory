/**
 * The handoff tests: the exact external command sequence each handoff
 * produces, and how a failure settles the ticket.
 *
 * The herdr CLI contract is pinned here, and the fake runner records every
 * command, so a drift in the sequence fails the suite. No test touches a
 * real herdr session.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig } from "../src/config.ts";
import { type Ticket, UNRANKED_PRIORITY } from "../src/domain/ticket.ts";
import {
	checkConsultationStart,
	closeHandoffEnvironment,
	type HandoffOutcome,
	handOffConsultation,
	handOffStoredWorkspace,
	handOffTicket,
	renderPrompt,
	renderSettingArgs,
	resolveHandoffChoice,
	settingArgs,
} from "../src/handoff.ts";
import type { Consultation } from "../src/state.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	FakeRunner,
	tabCreateJson,
	WORKTREE_NOT_FOUND_ERROR,
	workspaceCreateJson,
	workspaceListJson,
	worktreeCreateJson,
	worktreeListJson,
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
	workCycle: 1,
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
	leftover: null,
	priority: UNRANKED_PRIORITY,
};

const defaultChoice = {
	agentType: "pi",
	environment: "live-worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
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
const PROMPT = renderPrompt(BASE_CONFIG.taskTypes.implement.template, ticket);
const EXPECTED_IMPLEMENT_PROMPT =
	"Implement the following github-issue.\n\nRepository: acme/billing\n\n" +
	"#7: Retry policy for webhooks\n\nURL: https://github.com/acme/billing/issues/7\n\n" +
	"Labels: \n\nDescription:\nAdd a retry policy.";
const AGENT = "retry-policy-for-webhooks";

/** A git checkout that resolves from the convention path. */
function conventionCheckout(runner: FakeRunner): void {
	runner.set("git", ["-C", CHECKOUT, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", CHECKOUT, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/billing.git\n",
	});
}

/**
 * Stub the worktree base rule: the origin/HEAD symref names the default
 * branch and the fetch of its single ref succeeds, so the base is the
 * fetched remote ref `origin/<branch>`.
 */
function stubRemoteDefaultBranch(runner: FakeRunner, branch = "main"): void {
	runner.set("git", ["-C", CHECKOUT, "symbolic-ref", "refs/remotes/origin/HEAD"], {
		stdout: `refs/remotes/origin/${branch}\n`,
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
		contextWindow: "",
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
	test("substitutes every ticket placeholder with its source fact", () => {
		const detailed: Ticket = {
			...ticket,
			sourceKind: "github-pull-request",
			externalKey: "PR-42",
			url: "https://example.test/pulls/42",
			labels: ["ready-for-review", "security"],
		};
		const prompt = renderPrompt(
			"Repo: {repository}\nTitle: {title}\nDescription: {description}\nKind: {source-kind}\n" +
				"Key: {external-key}\nURL: {source-url}\nLabels: {labels}",
			detailed,
		);
		expect(prompt).toBe(
			"Repo: acme/billing\nTitle: Retry policy for webhooks\nDescription: Add a retry policy.\n" +
				"Kind: github-pull-request\nKey: PR-42\nURL: https://example.test/pulls/42\n" +
				"Labels: ready-for-review, security",
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
		const agent = BASE_CONFIG.agents.pi;
		expect(settingArgs(agent, { ...defaultChoice, model: "gpt-5.6", thinking: "high" })).toEqual([
			"--model",
			"gpt-5.6",
			"--thinking",
			"high",
		]);
	});

	test("an omitted setting is ignored: no template, no arguments", () => {
		// No setting chosen: no arguments at all.
		expect(settingArgs(BASE_CONFIG.agents.pi, defaultChoice)).toEqual([]);
		// Only the thinking chosen: the model template contributes nothing.
		expect(settingArgs(BASE_CONFIG.agents.codex, { ...defaultChoice, thinking: "high" })).toEqual([
			"-c",
			"model_reasoning_effort=high",
		]);
		// An agent with no setting template maps nothing at all.
		expect(
			settingArgs({ kind: "cursor" }, { ...defaultChoice, model: "m", thinking: "high" }),
		).toEqual([]);
	});

	test("an empty thinking is left to the agent: no fallback, no arguments", () => {
		// The task type's thinking default is prefilled into the choice by
		// the app, not applied here: an empty choice stays empty, so the
		// panel can show exactly what the handoff will run on.
		expect(settingArgs(BASE_CONFIG.agents.pi, defaultChoice)).toEqual([]);
		expect(settingArgs(BASE_CONFIG.agents.pi, { ...defaultChoice, thinking: "low" })).toEqual([
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
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome).toEqual({
			status: "ok",
			agent: {
				name: AGENT,
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-new",
			},
		});
		// This expected value is deliberately literal, not rendered through the
		// production function. A template or substitution regression changes the
		// command the Agent receives.
		expect(
			runner.calls.find(
				(call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt",
			)?.args,
		).toEqual(["agent", "prompt", AGENT, EXPECTED_IMPLEMENT_PROMPT]);
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			"herdr workspace list",
			`herdr workspace create --cwd ${CHECKOUT} --no-focus`,
			`herdr tab create --workspace ws-new --cwd ${CHECKOUT} --no-focus`,
			`herdr agent start ${AGENT} --kind pi --pane pane-1`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
		]);
		// The live worktree environment takes no fetch: the operator's own
		// checkout stays under their control.
		expect(runner.commands()).not.toContain(expect.stringContaining("fetch origin"));
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
			config: BASE_CONFIG,
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
		stubRemoteDefaultBranch(runner);
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
				"origin/main",
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
			config: BASE_CONFIG,
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
			config: BASE_CONFIG,
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
			config: BASE_CONFIG,
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
			config: BASE_CONFIG,
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
			config: BASE_CONFIG,
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
	test("checks the branch, fetches the remote default branch, creates the worktree, starts the agent, sends the prompt", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		stubRemoteDefaultBranch(runner);
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
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		// The base is the fetched remote default branch, and a clean fetch
		// leaves no fallback note.
		expect(outcome.notes).toBeUndefined();
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			`git -C ${CHECKOUT} branch --list factory/7-retry-policy-for-webhooks`,
			// The base rule checks for a usable origin on its own...
			`git -C ${CHECKOUT} remote get-url origin`,
			`git -C ${CHECKOUT} symbolic-ref refs/remotes/origin/HEAD`,
			`git -C ${CHECKOUT} fetch origin main`,
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base origin/main --no-focus`,
			`herdr agent start ${AGENT} --kind pi --pane pane-wt`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
		]);
	});

	test("with no origin/HEAD symref, detection falls back to origin/main", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			code: 1,
			stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n",
		});
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
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		// The symref was tried first, then origin/main; the fetch pulled the
		// one detected ref.
		expect(runner.commands()).toContain(`git -C ${CHECKOUT} symbolic-ref refs/remotes/origin/HEAD`);
		expect(runner.commands()).toContain(
			`git -C ${CHECKOUT} rev-parse --verify --quiet origin/main^{commit}`,
		);
		expect(runner.commands()).toContain(`git -C ${CHECKOUT} fetch origin main`);
		expect(runner.commands()).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base origin/main --no-focus`,
		);
	});

	test("a failed fetch starts on the local HEAD with a note naming the base and the reason", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		stubRemoteDefaultBranch(runner);
		runner.set("git", ["-C", CHECKOUT, "fetch", "origin", "main"], {
			code: 128,
			stderr: "fatal: unable to access: Network is down\n",
		});
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123def456\n" });
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
				"abc123def456",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		// The handoff still starts, on the local HEAD...
		expect(outcome.status).toBe("ok");
		expect(runner.commands()).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base abc123def456 --no-focus`,
		);
		// ...and the note names the base actually used (ref name plus short
		// sha) and the reason for the fallback.
		expect(outcome.notes?.worktreeBase).toBe(
			"the worktree base fell back to HEAD abc123d: fetching origin/main failed: fatal: unable to access: Network is down",
		);
	});

	test("no default branch ref on the remote falls back to the local HEAD with a note", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", CHECKOUT, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			code: 1,
			stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n",
		});
		runner.set(
			"git",
			["-C", CHECKOUT, "rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
			{
				code: 1,
			},
		);
		runner.set(
			"git",
			["-C", CHECKOUT, "rev-parse", "--verify", "--quiet", "origin/master^{commit}"],
			{
				code: 1,
			},
		);
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { stdout: "abc123def456\n" });
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
				"abc123def456",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		// No fetch ran: there was no ref to fetch.
		expect(runner.commands()).not.toContain(expect.stringContaining("fetch origin"));
		expect(runner.commands()).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base abc123def456 --no-focus`,
		);
		expect(outcome.notes?.worktreeBase).toBe(
			"the worktree base fell back to HEAD abc123d: no default branch found on origin (tried the origin/HEAD symref, then origin/main, then origin/master)",
		);
	});

	test("a repository without a usable origin falls back to the local HEAD with a note", async () => {
		const sibling = join(HOME, "src", "billing_1");
		const runner = new FakeRunner();
		// The convention checkout has no verifiable origin: resolution bends
		// to a sibling clone and warns about it.
		runner.set("git", ["-C", CHECKOUT, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", CHECKOUT, "remote", "get-url", "origin"], { code: 1 });
		// The sibling is a local-only repository: no origin remote to fetch
		// from, so the base is the checkout's own HEAD.
		runner.set("git", ["-C", sibling, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		runner.set("git", ["-C", sibling, "remote", "get-url", "origin"], { code: 1 });
		runner.set("git", ["-C", sibling, "rev-parse", "HEAD"], { stdout: "abc123def456\n" });
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				sibling,
				"--branch",
				"factory/7-retry-policy-for-webhooks",
				"--base",
				"abc123def456",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		// The handoff ran on the sibling the resolution bent to...
		expect(runner.commands()).toContain(`git clone https://github.com/acme/billing.git ${sibling}`);
		// ...and no fetch ran: there was no origin to fetch from.
		expect(runner.commands()).not.toContain(expect.stringContaining("fetch origin"));
		expect(runner.commands()).toContain(
			`herdr worktree create --cwd ${sibling} --branch factory/7-retry-policy-for-webhooks --base abc123def456 --no-focus`,
		);
		// The fallback note and the resolution warning ride the same channel.
		expect(outcome.notes?.worktreeBase).toBe(
			"the worktree base fell back to HEAD abc123d: no usable origin remote",
		);
		expect(outcome.notes?.warning).toContain("no verifiable origin remote");
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
		// The pre-existing branch is reused, never recreated or re-based, and
		// the reuse takes no fetch.
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree create"));
		expect(runner.commands()).not.toContain(expect.stringContaining("rev-parse HEAD"));
		expect(runner.commands()).not.toContain(expect.stringContaining("fetch origin"));
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
		stubRemoteDefaultBranch(runner);
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
				"origin/main",
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
		stubRemoteDefaultBranch(runner);
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
				"origin/main",
				"--no-focus",
			],
			{ stdout: JSON.stringify({ result: { root_pane: { pane_id: "pane-wt" } } }) },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
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
		stubRemoteDefaultBranch(runner);
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
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);
		runner.set("herdr", ["agent", "prompt", AGENT, PROMPT], { code: 1, stderr: "prompt failed\n" });

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		// The agent is running in the worktree and can be prompted by hand.
		expect(outcome.status).toBe("prompt-failed");
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree remove"));
	});

	// The ticket's worktree, left on another branch by the agent that last
	// worked the ticket: the directory herdr names for the branch still
	// stands on disk, holding the branch the work needed.
	const WORKTREE_PARENT = join(HOME, "worktrees", "billing");

	/** The list that holds the ticket's worktree beside one other worktree. */
	function strandedWorktreeList(): string {
		return worktreeListJson([
			{ path: CHECKOUT, linked: false },
			{ path: join(WORKTREE_PARENT, "factory-9-other-branch"), branch: "factory/9-other-branch" },
			{ path: WORKTREE_PATH, branch: "factory/146-the-branch-the-work-needed" },
		]);
	}

	test("an existing branch no worktree holds reopens the ticket's worktree left on another branch", async () => {
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
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			stdout: strandedWorktreeList(),
		});
		runner.set(
			"herdr",
			["worktree", "open", "--cwd", CHECKOUT, "--path", WORKTREE_PATH, "--no-focus"],
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
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		// The branch lookup finds no worktree, the list finds the ticket's
		// worktree at the path herdr names for the branch, and the open by
		// path lands the agent in the worktree the agent last left, on the
		// branch it holds. No create: a create would collide with the
		// directory.
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			`git -C ${CHECKOUT} branch --list factory/7-retry-policy-for-webhooks`,
			`herdr worktree open --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
			`herdr worktree list --cwd ${CHECKOUT}`,
			`herdr worktree open --cwd ${CHECKOUT} --path ${WORKTREE_PATH} --no-focus`,
			`herdr agent start ${AGENT} --kind pi --pane pane-wt`,
			`herdr agent prompt ${AGENT} ${PROMPT}`,
		]);
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree create"));
	});

	test("an existing branch no worktree holds creates fresh when the worktree is gone from disk", async () => {
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
		// The list holds the other worktree, and no worktree at the path the
		// branch names: the checkout is gone, and the create takes it.
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			stdout: worktreeListJson([
				{ path: CHECKOUT, linked: false },
				{ path: join(WORKTREE_PARENT, "factory-9-other-branch"), branch: "factory/9-other-branch" },
			]),
		});
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
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(`herdr worktree list --cwd ${CHECKOUT}`);
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expect(commands).not.toContain(expect.stringContaining("--path"));
	});

	test("an existing branch no worktree holds creates fresh when the ticket's worktree is prunable", async () => {
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
		// The worktree git would prune is not the worktree: the create takes
		// the path it leaves free.
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			stdout: worktreeListJson([
				{ path: CHECKOUT, linked: false },
				{ path: WORKTREE_PATH, branch: "factory/146-the-branch-the-work-needed", prunable: true },
			]),
		});
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
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expect(commands).not.toContain(expect.stringContaining("--path"));
	});

	test("an existing branch no worktree holds creates fresh when the worktree list does not read", async () => {
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
		// A list that refuses does not stop the handoff: the create runs, the
		// way the reuse did before the list looked.
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			code: 1,
			stderr: "the list refused",
		});
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
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expect(commands).not.toContain(expect.stringContaining("--path"));
	});

	test("an open workspace on the ticket's worktree gets a fresh tab, not a create", async () => {
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
		// A workspace already stands on the worktree: the open by path reuses
		// it, and the agent takes a fresh tab in it.
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			stdout: worktreeListJson([
				{ path: CHECKOUT, linked: false },
				{
					path: WORKTREE_PATH,
					branch: "factory/146-the-branch-the-work-needed",
					openWorkspaceId: "ws-open",
				},
			]),
		});
		runner.set(
			"herdr",
			["worktree", "open", "--cwd", CHECKOUT, "--path", WORKTREE_PATH, "--no-focus"],
			{
				stdout: worktreeOpenJson("ws-open", "pane-root", {
					alreadyOpen: true,
					worktreePath: WORKTREE_PATH,
				}),
			},
		);
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-open", "--cwd", WORKTREE_PATH, "--no-focus"],
			{ stdout: tabCreateJson("pane-tab") },
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree open --cwd ${CHECKOUT} --path ${WORKTREE_PATH} --no-focus`,
		);
		expect(commands).toContain(
			`herdr tab create --workspace ws-open --cwd ${WORKTREE_PATH} --no-focus`,
		);
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-tab`);
		expect(commands).not.toContain(expect.stringContaining("worktree create"));
	});

	test("a path open that finds nothing falls through to the fresh create", async () => {
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
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			stdout: strandedWorktreeList(),
		});
		// The worktree went between the list and the open: herdr says so, and
		// the create takes the place it left.
		runner.set(
			"herdr",
			["worktree", "open", "--cwd", CHECKOUT, "--path", WORKTREE_PATH, "--no-focus"],
			{
				code: 1,
				stderr: WORKTREE_NOT_FOUND_ERROR,
			},
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
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree open --cwd ${CHECKOUT} --path ${WORKTREE_PATH} --no-focus`,
		);
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
	});

	test("a refused path open fails the handoff, and no create runs", async () => {
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
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			stdout: strandedWorktreeList(),
		});
		// A refusal that is not "gone" stands on its own: the handoff fails
		// with it, and the create never runs on a directory it would collide
		// with.
		runner.set(
			"herdr",
			["worktree", "open", "--cwd", CHECKOUT, "--path", WORKTREE_PATH, "--no-focus"],
			{
				code: 1,
				stderr: "the worktree will not open",
			},
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("the worktree will not open");
		expect(runner.commands()).not.toContain(expect.stringContaining("worktree create"));
	});
});

describe("handOffTicket: the guard rails", () => {
	test("only open tickets can be handed off", async () => {
		const runner = new FakeRunner();
		const outcome = await handOffTicket({ ...ticket, state: "running" }, defaultChoice, {
			config: BASE_CONFIG,
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
			{ config: BASE_CONFIG, runner, home: HOME },
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
				{ config: BASE_CONFIG, runner, home: HOME },
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
				{ config: BASE_CONFIG, runner, home: HOME },
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
				{ config: BASE_CONFIG, runner, home: HOME },
			);

			expect(outcome.status).toBe("failed");
			expect(reasonOf(outcome)).toBe(
				'agent type "pi" offers no thinking level "ultra" (it offers: off, minimal, low, medium, ' +
					"high, xhigh, max): clear the thinking level in the override panel, or start an agent " +
					"type that offers it",
			);
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
				{ config: BASE_CONFIG, runner, home: HOME },
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
				config: BASE_CONFIG,
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
				config: BASE_CONFIG,
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
				config: BASE_CONFIG,
				runner,
				home: HOME,
			});

			expect(outcome.status).toBe("failed");
			if (outcome.status === "ok") throw new Error("expected a refusal");
			expect(outcome.reason).toContain('offers no thinking level "ultra"');
			expect(runner.calls).toHaveLength(0);
			// The levels an Agent declares are in the config: no query is needed.
			expect(runner.modelListCalls).toHaveLength(0);
		});

		test("a Consultation start refuses every static setting the Agent cannot take", async () => {
			const cases = [
				{
					label: "model",
					config: {
						...BASE_CONFIG,
						agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
					},
					consultation: { agentType: "cursor", model: "factory-model" },
					text: 'defines no model setting, so model "factory-model" cannot reach it',
				},
				{
					label: "thinking",
					config: {
						...BASE_CONFIG,
						agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
					},
					consultation: { agentType: "cursor", thinking: "high" },
					text: 'defines no thinking setting, so thinking level "high" cannot reach it',
				},
				{
					label: "context window",
					config: BASE_CONFIG,
					consultation: { contextWindow: "131072" },
					text: "defines no context window setting, so the count of 131072 tokens cannot reach it",
				},
			];
			for (const item of cases) {
				const runner = new FakeRunner();
				const outcome = await handOffConsultation({
					consultation: consultationRecord({ ...item.consultation }),
					config: item.config,
					runner,
					home: HOME,
				});
				expect(outcome.status, item.label).toBe("failed");
				expect(reasonOf(outcome)).toContain(item.text);
				expect(runner.calls, item.label).toHaveLength(0);
				expect(runner.modelListCalls, item.label).toHaveLength(0);
			}
		});

		test("a Consultation start refuses a count that is not positive digits", async () => {
			const runner = new FakeRunner();
			const config: FactoryConfig = {
				...BASE_CONFIG,
				agents: {
					...BASE_CONFIG.agents,
					pi: { ...BASE_CONFIG.agents.pi, contextWindow: "--context {value}" },
				},
			};
			const outcome = await handOffConsultation({
				consultation: consultationRecord({ contextWindow: "0" }),
				config,
				runner,
				home: HOME,
			});
			expect(outcome.status).toBe("failed");
			expect(reasonOf(outcome)).toContain(
				'context window "0" is not a positive whole number of tokens in digits',
			);
			expect(runner.calls).toHaveLength(0);
		});

		test("a start with no verdict runs on a fit model, and asks the CLI once", async () => {
			const runner = new FakeRunner();
			conventionCheckout(runner);
			stubLiveWorkspace(runner);
			runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);

			const outcome = await handOffConsultation({
				consultation: consultationRecord({ model: "anthropic/claude-sonnet-4-5" }),
				config: BASE_CONFIG,
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
				config: BASE_CONFIG,
				runner,
			});
			expect(startCheck.ok).toBe(true);

			const outcome = await handOffConsultation({
				consultation,
				config: BASE_CONFIG,
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
			{ config: BASE_CONFIG, runner, home: HOME },
		);
		expect(agent).toEqual({ status: "failed", reason: "unknown agent type: cursor" });
		const task = await handOffTicket(
			ticket,
			{ ...defaultChoice, taskType: "refactor" },
			{ config: BASE_CONFIG, runner, home: HOME },
		);
		expect(task).toEqual({ status: "failed", reason: "unknown task type: refactor" });
		expect(runner.calls).toHaveLength(0);
	});

	test("a model the resolved agent cannot map fails before any command", async () => {
		const runner = new FakeRunner();
		// The profile names no model: the default one resolves onto an agent
		// that maps no model, so the value has nowhere to go.
		const config: FactoryConfig = {
			...BASE_CONFIG,
			defaultModel: "factory-model",
			agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, agent: "cursor" },
			},
		};

		const outcome = await handOffTicket(ticket, resolveHandoffChoice(config, "implement"), {
			config,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toBe(
			'agent type "cursor" defines no model setting, so model "factory-model" cannot ' +
				"reach it: clear the model in the override panel, or start an agent type that " +
				"maps one",
		);
		// Nothing ran: the handoff failed before it built an environment.
		expect(runner.calls).toHaveLength(0);
	});

	test("a thinking level the resolved agent cannot map fails before any command", async () => {
		const runner = new FakeRunner();
		const config: FactoryConfig = {
			...BASE_CONFIG,
			agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, agent: "cursor", thinking: "high" },
			},
		};

		const outcome = await handOffTicket(ticket, resolveHandoffChoice(config, "implement"), {
			config,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toBe(
			'agent type "cursor" defines no thinking setting, so thinking level "high" cannot ' +
				"reach it: clear the thinking level in the override panel, or start an agent " +
				"type that maps one",
		);
		expect(runner.calls).toHaveLength(0);
	});

	test("a thinking level the resolved agent does not offer fails before any command", async () => {
		const runner = new FakeRunner();
		// zed maps a thinking template, so the value has an argv to ride on, and
		// it offers only two levels. An operator can still draft a third one by
		// cycling the panel's Agent row onto zed: the level list is the other
		// half of the same loud rule (ADR 0009).
		const config: FactoryConfig = {
			...BASE_CONFIG,
			agents: {
				...BASE_CONFIG.agents,
				zed: { kind: "zed", thinking: "-t {value}", thinkingValues: ["off", "low"] },
			},
		};

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, agentType: "zed", thinking: "minimal" },
			{ config, runner, home: HOME },
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toBe(
			'agent type "zed" offers no thinking level "minimal" (it offers: off, low): clear ' +
				"the thinking level in the override panel, or start an agent type that offers it",
		);
		expect(runner.calls).toHaveLength(0);
	});

	test("a context window that is not a token count fails before any command", async () => {
		const runner = new FakeRunner();
		// The panel keeps a count to digits, but digits are not yet a count: an
		// all-zero one asks for no context at all, and one that runs past the
		// safe integer range cannot be stated without rounding it. A separator
		// or a suffix would split into two argv elements.
		const config: FactoryConfig = {
			...BASE_CONFIG,
			agents: {
				...BASE_CONFIG.agents,
				codex: { ...BASE_CONFIG.agents.codex, contextWindow: "-c model_context_window={value}" },
			},
		};

		for (const draft of ["0", "000", "200k", "272 000", "9007199254740993"]) {
			const outcome = await handOffTicket(
				ticket,
				{ ...defaultChoice, agentType: "codex", contextWindow: draft },
				{ config, runner, home: HOME },
			);
			expect(outcome.status).toBe("failed");
			expect(reasonOf(outcome)).toBe(
				`context window "${draft}" is not a positive whole number of tokens in ` +
					"digits: clear the context row in the override panel, or type a count " +
					"such as 272000",
			);
		}
		// Nothing ran: a bad count is refused before the environment is touched.
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
			config: BASE_CONFIG,
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
			config: BASE_CONFIG,
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
	...BASE_CONFIG,
	taskTypes: {
		...BASE_CONFIG.taskTypes,
		implement: {
			...BASE_CONFIG.taskTypes.implement,
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
			config: BASE_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("ok");
		expect(outcome.status === "ok" && outcome.agent).toEqual({
			name: AGENT,
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

	test("a restart repeats its stored agent model and thinking in the start command", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-stored", "--no-focus"], {
			stdout: tabCreateJson("pane-restart"),
		});

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: { ...defaultChoice, agentType: "codex", model: "gpt-5.6", thinking: "high" },
			config: BASE_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: "tab-interrupted",
			previousMessage: "the interrupted work",
		});

		expect(outcome.status).toBe("ok");
		expect(
			runner.calls.find(
				(call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start",
			)?.args,
		).toEqual([
			"agent",
			"start",
			AGENT,
			"--kind",
			"codex",
			"--pane",
			"pane-restart",
			"--",
			"--model",
			"gpt-5.6",
			"-c",
			"model_reasoning_effort=high",
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
			config: BASE_CONFIG,
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
			config: BASE_CONFIG,
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
		stubRemoteDefaultBranch(runner);
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
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffStoredWorkspace({
			ticket,
			choice: { ...defaultChoice, environment: "worktree" },
			config: BASE_CONFIG,
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
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base origin/main --no-focus`,
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
			config: BASE_CONFIG,
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

	test("every setting the profile names reaches the agent in its own words", async () => {
		// ADR 0009: the profile resolves the values and the agent's templates
		// render them, so one profile says the same three things to three
		// agents in three different argv shapes.
		const profileConfig: FactoryConfig = {
			...BASE_CONFIG,
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
					model: "gpt-5.6",
					thinking: "high",
					contextWindow: "272000",
				},
			},
		};
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

		const outcome = await handOffTicket(ticket, resolveHandoffChoice(profileConfig, "implement"), {
			config: profileConfig,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("ok");
		const start = runner.calls.find((call) => call.args[0] === "agent" && call.args[1] === "start");
		expect(start?.args).toEqual([
			"agent",
			"start",
			AGENT,
			"--kind",
			"codex",
			"--pane",
			"pane-1",
			"--",
			"-m",
			"gpt-5.6",
			"-r",
			"high",
			"-c",
			"model_context_window=272000",
		]);
	});

	test("a context window the resolved agent cannot map fails before any command", async () => {
		const runner = new FakeRunner();
		const config: FactoryConfig = {
			...BASE_CONFIG,
			agents: {
				...BASE_CONFIG.agents,
				// cursor maps nothing: the count the profile names has no argv.
				cursor: { ...BASE_CONFIG.agents.codex, contextWindow: undefined },
			},
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					agent: "cursor",
					contextWindow: "272000",
				},
			},
		};

		const outcome = await handOffTicket(ticket, resolveHandoffChoice(config, "implement"), {
			config,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toBe(
			'agent type "cursor" defines no context window setting, so the count of 272000 ' +
				"tokens cannot reach it: clear it in the override panel, or start an agent " +
				"type that maps one",
		);
		expect(runner.calls).toHaveLength(0);
	});

	test("a restart repeats the context window, and fails loudly where the agent cannot map it", async () => {
		// A restart keeps every setting the interrupted handoff ran with. When
		// the operator restarts onto an agent that maps no context window, the
		// kept count fails the handoff the same way a profile's does: a restart
		// never quietly widens or narrows the room the agent worked in.
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});

		const outcome = await handOffStoredWorkspace({
			ticket: { ...ticket, state: "running" },
			choice: { ...defaultChoice, agentType: "pi", contextWindow: "272000" },
			config: BASE_CONFIG,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "",
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain('agent type "pi" defines no context window setting');
		// Nothing ran: the choice is refused before the environment is touched.
		expect(runner.calls).toHaveLength(0);
	});

	test("an edge reroute onto an agent that cannot map the target model fails", async () => {
		const runner = new FakeRunner();
		// ADR 0009: a model written for the target profile's own agent can
		// fail a handoff an edge routed to another agent, and that failure is
		// how the config error is seen.
		const config: FactoryConfig = {
			...BASE_CONFIG,
			agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				review: { ...BASE_CONFIG.taskTypes.review, model: "pi-model" },
			},
		};
		const edge = { from: "implement", to: ["review"], agent: "cursor" };

		const outcome = await handOffStoredWorkspace({
			ticket: { ...ticket, state: "awaiting" },
			choice: resolveHandoffChoice(config, "review", edge),
			config,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain('agent type "cursor" defines no model setting');
		expect(runner.calls).toHaveLength(0);
	});

	test("an edge reroute onto an agent that does not offer the profile's level fails", async () => {
		const runner = new FakeRunner();
		// Startup paired "medium" with pi, the profile's own agent. The edge
		// replaced only the agent, so the pair the reroute creates is checked at
		// handoff time by the same rule that fails a model (ADR 0009).
		const config: FactoryConfig = {
			...BASE_CONFIG,
			agents: {
				...BASE_CONFIG.agents,
				zed: { kind: "zed", thinking: "-t {value}", thinkingValues: ["off", "low"] },
			},
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				review: { ...BASE_CONFIG.taskTypes.review, thinking: "medium" },
			},
		};
		const edge = { from: "implement", to: ["review"], agent: "zed" };

		const outcome = await handOffStoredWorkspace({
			ticket: { ...ticket, state: "awaiting" },
			choice: resolveHandoffChoice(config, "review", edge),
			config,
			runner,
			home: HOME,
			workspaceId: "ws-stored",
			environment: "live-worktree",
			previousTabId: "tab-prev",
			previousMessage: "settled earlier",
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain('agent type "zed" offers no thinking level "medium"');
		expect(runner.calls).toHaveLength(0);
	});
});

describe("a leftover agent that holds the ticket's name", () => {
	/** The herdr reason that names the holder of a taken agent name. */
	function nameTaken(
		paneId: string,
		workspaceId: string,
		tabId: string,
		name: string = AGENT,
	): string {
		return (
			`{"error":{"code":"agent_name_taken","message":"agent name ${name} is already used; ` +
			`candidates: terminal_id=term_1 pane_id=${paneId} workspace_id=${workspaceId} ` +
			`tab_id=${tabId} cwd=${WORKTREE_PATH} status=Working"},"id":"cli:agent:start"}\n`
		);
	}

	/** The open-worktree sequence, up to the fresh tab the agent starts in. */
	function openedWorktree(runner: FakeRunner, holderPane: string, holderWorkspace: string): void {
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
			stderr: nameTaken(holderPane, holderWorkspace, "ws-old:t1"),
		});
	}

	test("starts under its cycle name beside its own leftover agent", async () => {
		const runner = new FakeRunner();
		openedWorktree(runner, "pane-old", "ws-old");
		const cycle = "retry-policy-for-webhooks-c1";

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				names: { ownPaneIds: ["pane-old"], ownWorkspaceIds: ["ws-old"], leftoverKnown: false },
			},
		);

		// The leftover workspace is the ticket's own, so the handoff does not
		// stop on its name: it starts beside it under the cycle name.
		expect(outcome.status).toBe("ok");
		expect(outcome.status === "ok" && outcome.agent.name).toBe(cycle);
		expect(outcome.status === "ok" && outcome.collision).toEqual({
			stableName: AGENT,
			startedAs: cycle,
			holder: {
				terminalId: "term_1",
				paneId: "pane-old",
				workspaceId: "ws-old",
				tabId: "ws-old:t1",
			},
			own: true,
			reason: expect.stringContaining("agent_name_taken"),
		});
		const commands = runner.commands();
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-tab`);
		expect(commands).toContain(`herdr agent start ${cycle} --kind pi --pane pane-tab`);
		// The prompt goes to the name the agent actually started under.
		expect(commands.filter((command) => command.startsWith("herdr agent prompt "))).toEqual([
			expect.stringContaining(`herdr agent prompt ${cycle} `),
		]);
		// The tab the first attempt created is not closed: the second name started in it.
		expect(commands).not.toContain("herdr tab close tab-1");
	});

	test("takes its cycle name on a known leftover even when herdr names no holder", async () => {
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
					alreadyOpen: false,
					worktreePath: WORKTREE_PATH,
				}),
			},
		);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-root"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				names: { ownPaneIds: [], ownWorkspaceIds: [], leftoverKnown: true },
			},
		);

		// The ticket already knows what it left alive, so herdr's unreadable
		// reason is not the last word: the handoff starts anyway.
		expect(outcome.status).toBe("ok");
		expect(outcome.status === "ok" && outcome.agent.name).toBe("retry-policy-for-webhooks-c1");
	});

	test("fails on a name another agent holds, and says where it is held", async () => {
		const runner = new FakeRunner();
		openedWorktree(runner, "pane-stranger", "ws-stranger");

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				names: { ownPaneIds: ["pane-old"], ownWorkspaceIds: ["ws-old"], leftoverKnown: false },
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		expect(reasonOf(outcome)).toContain("pane pane-stranger in workspace ws-stranger");
		expect(reasonOf(outcome)).toContain("no agent of this ticket");
		// A stranger's name is not the handoff's to take: one attempt only,
		// and the residue of the attempt goes with it.
		expect(
			runner.commands().filter((command) => command.startsWith("herdr agent start")),
		).toHaveLength(1);
		expect(runner.commands()).toContain("herdr tab close tab-1");
		expect(outcome.status === "failed" && outcome.collision).toEqual(
			expect.objectContaining({ stableName: AGENT, startedAs: null, own: false }),
		);
	});

	test("gives up with its own name spent, and points at the leftover", async () => {
		const runner = new FakeRunner();
		openedWorktree(runner, "pane-old", "ws-old");
		// Every name of this ticket is held by one of its own leftover agents.
		for (const name of ["retry-policy-for-webhooks-c1", "retry-policy-for-webhooks-c1-1"]) {
			runner.set("herdr", ["agent", "start", name, "--kind", "pi", "--pane", "pane-tab"], {
				code: 1,
				stderr: nameTaken("pane-old", "ws-old", "ws-old:t1"),
			});
		}

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				names: { ownPaneIds: ["pane-old"], ownWorkspaceIds: [], leftoverKnown: false },
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("own leftover agent still holds the herdr name");
		expect(reasonOf(outcome)).toContain("end its leftover environment in herdr");
		expect(
			runner.commands().filter((command) => command.startsWith("herdr agent start")),
		).toHaveLength(3);
	});

	test("a refusal that names two holders reports the one the ticket recorded", async () => {
		const runner = new FakeRunner();
		openedWorktree(runner, "pane-stranger", "ws-stranger");
		// herdr names the stranger first and the ticket's own leftover pane
		// after it, on every candidate the handoff asks for. The collision the
		// operator reads must point at the pane that is the ticket's to end.
		const bothHeld = (name: string) =>
			`{"error":{"code":"agent_name_taken","message":"agent name ${name} is already used; ` +
			`candidates: terminal_id=term_1 pane_id=pane-stranger workspace_id=ws-stranger ` +
			`tab_id=ws-stranger:t1 cwd=unknown status=Working terminal_id=term_2 pane_id=pane-old ` +
			`workspace_id=ws-old tab_id=ws-old:t2 cwd=unknown status=Idle"},"id":"cli:agent:start"}\n`;
		for (const name of [AGENT, "retry-policy-for-webhooks-c1", "retry-policy-for-webhooks-c1-1"]) {
			runner.set("herdr", ["agent", "start", name, "--kind", "pi", "--pane", "pane-tab"], {
				code: 1,
				stderr: bothHeld(name),
			});
		}

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				names: { ownPaneIds: ["pane-old"], ownWorkspaceIds: ["ws-old"], leftoverKnown: false },
			},
		);

		expect(outcome.status).toBe("failed");
		// The collision is the ticket's own, and its holder is the pane the
		// ticket's handoffs recorded - not the stranger herdr named first.
		expect(outcome.status === "failed" && outcome.collision).toEqual(
			expect.objectContaining({
				stableName: AGENT,
				startedAs: null,
				own: true,
				holder: expect.objectContaining({ paneId: "pane-old", workspaceId: "ws-old" }),
			}),
		);
		expect(reasonOf(outcome)).toContain("pane pane-old in workspace ws-old");
		expect(reasonOf(outcome)).toContain("own leftover agent still holds the herdr name");
	});

	test("asks herdr for each name once, even when its cycle rebuilds the stable one", async () => {
		const runner = new FakeRunner();
		// A 32-character slug whose tail already spells the cycle suffix
		// rebuilds the stable name under the length cut. The handoff drops
		// that repeat instead of asking herdr for one name twice, and still
		// has its ordinal name to start under.
		const stable = `${"a".repeat(29)}-c2`;
		const ordinal = `${"a".repeat(27)}-c2-2`;
		const longTicket: Ticket = { ...ticket, title: stable, workCycle: 2, handoffCount: 1 };
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws", checkoutPath: CHECKOUT }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});
		runner.set("herdr", ["agent", "start", stable, "--kind", "pi", "--pane", "pane-1"], {
			code: 1,
			stderr: nameTaken("pane-old", "ws-old", "ws-old:t1", stable),
		});

		const outcome = await handOffTicket(longTicket, defaultChoice, {
			config: BASE_CONFIG,
			runner,
			home: HOME,
			names: { ownPaneIds: ["pane-old"], ownWorkspaceIds: ["ws-old"], leftoverKnown: false },
		});

		expect(outcome.status).toBe("ok");
		expect(outcome.status === "ok" && outcome.agent.name).toBe(ordinal);
		expect(outcome.status === "ok" && outcome.collision?.startedAs).toBe(ordinal);
		expect(runner.commands().filter((command) => command.startsWith("herdr agent start"))).toEqual([
			`herdr agent start ${stable} --kind pi --pane pane-1`,
			`herdr agent start ${ordinal} --kind pi --pane pane-1`,
		]);
	});

	test("reports the failure a later name really met, not the earlier collision", async () => {
		const runner = new FakeRunner();
		openedWorktree(runner, "pane-old", "ws-old");
		// The stable name is the ticket's own leftover; the cycle name then
		// fails for a reason of its own. The operator reads that reason, not
		// the collision an earlier candidate met.
		runner.set(
			"herdr",
			["agent", "start", "retry-policy-for-webhooks-c1", "--kind", "pi", "--pane", "pane-tab"],
			{
				code: 1,
				stderr:
					'{"error":{"code":"agent_kind_unknown","message":"herdr does not know the agent kind pi"},"id":"cli:agent:start"}\n',
			},
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				names: { ownPaneIds: ["pane-old"], ownWorkspaceIds: ["ws-old"], leftoverKnown: false },
			},
		);

		expect(outcome.status).toBe("failed");
		const reason = reasonOf(outcome);
		expect(reason).toContain("herdr does not know the agent kind pi");
		expect(reason).toContain("agent_kind_unknown");
		expect(reason).not.toContain("agent_name_taken");
		expect(reason).not.toContain("own leftover agent still holds");
		// The collision the handoff did meet still rides along with the
		// failure: the caller makes the leftover it names a durable fact.
		expect(outcome.status === "failed" && outcome.collision).toEqual(
			expect.objectContaining({ stableName: AGENT, startedAs: null, own: true }),
		);
		// The residue of the attempt goes with the failure.
		expect(runner.commands()).toContain("herdr tab close tab-1");
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
		// deletes the branch: there is no workspace close after it. No control
		// plane workspace was named, so the focus restore never runs.
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
				'{"error":{"code":"dirty_worktree_requires_force","message":"fatal: the worktree contains modified or untracked files, use --force to delete it"},"id":"cli:worktree:remove"}\n',
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
		);

		// The reason is herdr's own message with its stable error code: the
		// caller reports it on the Message line, and the ticket carries it as
		// the durable reason of its leftover environment.
		expect(failure).toBe(
			"fatal: the worktree contains modified or untracked files, use --force to delete it (dirty_worktree_requires_force)",
		);
		// The workspace stays: the checkout is still there, and the operator
		// may still be working in it, so no focus restore follows.
		expect(runner.commands()).toEqual(["herdr worktree remove --workspace ws-1"]);
	});

	test("the operator's force removes the checkout herdr refused", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
			{ force: true },
		);

		expect(failure).toBeUndefined();
		// Force is the only difference, and it is never this module's choice:
		// only a caller the operator asked passes it. The branch still stays.
		expect(runner.commands()).toEqual(["herdr worktree remove --workspace ws-1 --force"]);
		const joined = runner.commands().join("\n");
		expect(joined).not.toContain("branch -D");
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

	test("a live worktree handoff whose tab is already gone is a clean close", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["tab", "close", "tab-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"tab_not_found","message":"tab tab-1 not found"},"id":"cli:tab:close"}\n',
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "live-worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
		);

		// The tab is gone: there is no environment left to clean up.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual(["herdr tab close tab-1"]);
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

	test("a worktree close returns herdr's focus to the control plane's workspace", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
			{ controlPlaneWorkspaceId: "ws-cp" },
		);

		// herdr moves its focus to the repository's parent workspace when a
		// linked worktree is removed. The operator worked the close from the
		// control plane, so its workspace is where the view returns.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual([
			"herdr worktree remove --workspace ws-1",
			"herdr workspace focus ws-cp",
		]);
	});

	test("a tab close leaves herdr's focus where it stood", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "live-worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
			{ controlPlaneWorkspaceId: "ws-cp" },
		);

		// The tab close keeps the workspace and the tabs beside it, so herdr
		// leaves its workspace focus where it stood: the cleanup never issues
		// a focus command.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual(["herdr tab close tab-1"]);
	});

	test("a left workspace close returns herdr's focus to the control plane's workspace", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"worktree_remove_failed","message":"fatal: the path is not a working tree"},"id":"cli:worktree:remove"}\n',
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
			{ controlPlaneWorkspaceId: "ws-home" },
		);

		// The workspace the fallback closed is gone too: the focus returns to
		// the control plane.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual([
			"herdr worktree remove --workspace ws-1",
			"herdr workspace close ws-1",
			"herdr workspace focus ws-home",
		]);
	});

	test("a focus failure never fails the close and never retries", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["workspace", "focus", "ws-cp"], {
			code: 1,
			stderr: "error: the herdr server is down\n",
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
			{ controlPlaneWorkspaceId: "ws-cp" },
		);

		// The environment is gone: the close stands. herdr's own choice of the
		// focus stands too: the restore gave up after one error.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual([
			"herdr worktree remove --workspace ws-1",
			"herdr workspace focus ws-cp",
		]);
	});
});
