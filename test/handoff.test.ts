/**
 * The handoff tests: the exact external command sequence each handoff
 * produces, and how a failure settles the ticket.
 *
 * The herdr CLI contract is pinned here, and the fake runner records every
 * command, so a drift in the sequence fails the suite. No test touches a
 * real herdr session.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig, TicketSourceConfig } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import {
	checkStart,
	closeHandoffEnvironment,
	type HandoffOutcome,
	handOffConsultation,
	handOffTicket,
	renderPrompt,
	renderSettingArgs,
	resolveHandoffChoice,
	reviewVerdictFill,
	settingArgs,
} from "../src/handoff.ts";
import type { Consultation } from "../src/state/consultation-record.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { expectNoCommand } from "./command-assertions.ts";
import {
	FakeRunner,
	herdrFocusCommands,
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
	matchedStateName: null,
	actionable: true,
	handoffRecoveryRequired: false,
	ignored: false,
	ignoredAt: null,
	muted: false,
	mutedAt: null,
	handoffCount: 0,
	lastCompletion: null,
	leftover: null,
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

/** The task type's prompt template, asserted: the test's task types carry the prompt form. */
function templateOf(taskType: { template?: string }): string {
	return taskType.template as string;
}

/** The exact prompt the implement task type renders for this ticket. */
const PROMPT = renderPrompt(templateOf(BASE_CONFIG.taskTypes.implement), ticket);
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

/**
 * The Agent start failure a start cleans up after. The name is the Ticket's own;
 * `stubConsultationStartFailure` is the same failure under a Consultation's name.
 */
function stubStartFailure(runner: FakeRunner, pane: string): void {
	runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", pane], {
		code: 1,
		stderr: '{"error":{"code":"agent_start_failed","message":"the pane is gone"}}\n',
	});
}

/** The same failure for the name a Consultation start runs under. */
function stubConsultationStartFailure(runner: FakeRunner, pane: string): void {
	runner.set("herdr", ["agent", "start", "consultation-11111111", "--kind", "pi", "--pane", pane], {
		code: 1,
		stderr: '{"error":{"code":"agent_start_failed","message":"the pane is gone"}}\n',
	});
}

/**
 * The absolute path herdr's naming rule gives the ticket's worktree checkout.
 *
 * The file's `WORKTREE_PATH` constant is built before the temp home exists, so
 * it is the path the fake herdr answers carry. A test that stands a real
 * directory on disk reads this one instead.
 */
function ticketWorktreePath(): string {
	return join(HOME, "worktrees", "billing", "factory-7-retry-policy-for-webhooks");
}

/**
 * The herdr answer for a create git refuses because the checkout path stands:
 * the stable code, and Git's whole stderr as the message.
 */
function worktreeCreateBlocked(path: string): { code: number; stderr: string } {
	return {
		code: 1,
		stderr:
			'{"error":{"code":"worktree_create_failed","message":"Preparing worktree (checking out \'factory/7-retry-policy-for-webhooks\')' +
			`\\nfatal: '${path}' already exists` +
			'"},"id":"cli:worktree:create"}\n',
	};
}

/**
 * The worktree list that names the directory herdr will use for the ticket's
 * branch, without holding that directory: the repository's other linked
 * worktree gives the parent, the same way ADR 0046 reads it.
 */
function siblingWorktreeList(): string {
	return worktreeListJson([
		{ path: CHECKOUT, linked: false },
		{
			path: join(HOME, "worktrees", "billing", "factory-6-another-ticket"),
			branch: "factory/6-another-ticket",
		},
	]);
}

/** Stand one directory up with the entries a removed checkout leaves behind. */
function makeDirectory(path: string, entries: Record<string, string>): void {
	for (const name of Object.keys(entries)) {
		const full = join(path, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, entries[name]);
	}
}

/** The reuse sequence up to its fresh create: the branch exists, no worktree holds it. */
function reuseToFreshCreate(runner: FakeRunner): void {
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
	runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], { stdout: siblingWorktreeList() });
}

/** The create argv the reuse sequence sends for the ticket's branch. */
function createOnBranch(): string[] {
	return [
		"worktree",
		"create",
		"--cwd",
		CHECKOUT,
		"--branch",
		"factory/7-retry-policy-for-webhooks",
		"--no-focus",
	];
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

	test("{review-verdict} takes the verdict fill, empty for a plain render", () => {
		const prompt = renderPrompt(
			"Verdict: {review-verdict}\n{description}",
			ticket,
			"settled",
			"Posted as a review at 2026-08-31T12:00:00Z:\n- **Score:** 85 / 100",
		);
		expect(prompt).toBe(
			"Verdict: Posted as a review at 2026-08-31T12:00:00Z:\n- **Score:** 85 / 100\nAdd a retry policy.",
		);
		expect(renderPrompt("Verdict: {review-verdict}", ticket)).toBe("Verdict: ");
	});
});

describe("reviewVerdictFill", () => {
	const body = "Required Changes:\n- Fix the tabs";

	test("the standing verdict stands under its timeline and post time, with its body unchanged", () => {
		expect(
			reviewVerdictFill({
				kind: "verdict",
				verdict: { timeline: "review", at: "2026-08-31T12:00:00Z", body },
			}),
		).toBe(`Posted as a review at 2026-08-31T12:00:00Z:\n${body}`);
		expect(
			reviewVerdictFill({
				kind: "verdict",
				verdict: { timeline: "comment", at: "2026-08-31T13:00:00Z", body },
			}),
		).toBe(`Posted as a comment at 2026-08-31T13:00:00Z:\n${body}`);
	});

	test("no standing verdict is the fact line", () => {
		expect(reviewVerdictFill({ kind: "none" })).toBe(
			"No review verdict found on the pull request.",
		);
	});

	test("every timeline failing is the failure fact with the read's reason", () => {
		expect(
			reviewVerdictFill({
				kind: "failed",
				reason: "the comment read failed (x); the review read failed (y)",
			}),
		).toBe(
			"The review verdict read failed: the comment read failed (x); the review read failed (y).",
		);
	});

	const gatesFact = (score: number, threshold: number) =>
		`The review passed: the score ${score} stands at or above the threshold ${threshold}. ` +
		"The failure stands in the pull request's gates: a merge conflict or a failing CI check. " +
		"Rebase the branch onto its base and fix what the gates report.";

	test("a verdict score at or above the workflow threshold fills the gates fact", () => {
		// ADR 0078: the review passed, so the rework works the gates, not the
		// review's feedback.
		expect(
			reviewVerdictFill(
				{
					kind: "verdict",
					verdict: {
						timeline: "review",
						at: "2026-08-31T12:00:00Z",
						body: `${body}\n- **Score:** 95 / 100`,
					},
				},
				90,
			),
		).toBe(gatesFact(95, 90));
	});

	test("a score exactly at the threshold fills the gates fact, the judgment's rule", () => {
		expect(
			reviewVerdictFill(
				{
					kind: "verdict",
					verdict: {
						timeline: "comment",
						at: "2026-08-31T12:00:00Z",
						body: `${body}\n- **Score:** 90 / 100`,
					},
				},
				90,
			),
		).toBe(gatesFact(90, 90));
	});

	test("a score below the threshold keeps the verdict's body", () => {
		expect(
			reviewVerdictFill(
				{
					kind: "verdict",
					verdict: {
						timeline: "review",
						at: "2026-08-31T12:00:00Z",
						body: `${body}\n- **Score:** 85 / 100`,
					},
				},
				90,
			),
		).toBe(`Posted as a review at 2026-08-31T12:00:00Z:\n${body}\n- **Score:** 85 / 100`);
	});

	test("a verdict without a score line keeps its body beside a threshold", () => {
		expect(
			reviewVerdictFill(
				{ kind: "verdict", verdict: { timeline: "review", at: "2026-08-31T12:00:00Z", body } },
				90,
			),
		).toBe(`Posted as a review at 2026-08-31T12:00:00Z:\n${body}`);
	});

	test("no threshold keeps the verdict's body for a passing score", () => {
		expect(
			reviewVerdictFill({
				kind: "verdict",
				verdict: {
					timeline: "review",
					at: "2026-08-31T12:00:00Z",
					body: `${body}\n- **Score:** 95 / 100`,
				},
			}),
		).toBe(`Posted as a review at 2026-08-31T12:00:00Z:\n${body}\n- **Score:** 95 / 100`);
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
			claim: "open",
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
		expectNoCommand(runner.commands(), "fetch origin");
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
			claim: "open",
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
			claim: "open",
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
			claim: "open",
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
			claim: "open",
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome).toEqual({ status: "failed", reason: "error: herdr is not running" });
		// Nothing after the failed step runs.
		expectNoCommand(runner.commands(), "agent start");
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
			claim: "open",
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
			claim: "open",
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("readable workspace list");
		// Unreadable is not "no workspace": the one-workspace-per-repository
		// rule holds, so no second workspace is created for the checkout.
		expectNoCommand(runner.commands(), "workspace create");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		// No fetch ran: there was no ref to fetch.
		expectNoCommand(runner.commands(), "fetch origin");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		// The handoff ran on the sibling the resolution bent to...
		expect(runner.commands()).toContain(`git clone https://github.com/acme/billing.git ${sibling}`);
		// ...and no fetch ran: there was no origin to fetch from.
		expectNoCommand(runner.commands(), "fetch origin");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
		expectNoCommand(runner.commands(), "worktree create");
		expectNoCommand(runner.commands(), "rev-parse HEAD");
		expectNoCommand(runner.commands(), "fetch origin");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree open --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expect(commands).toContain(`herdr agent start ${AGENT} --kind pi --pane pane-wt`);
		expect(commands).toContain(`herdr agent prompt ${AGENT} ${PROMPT}`);
		// A fresh workspace has its own first pane: no extra tab, no create.
		expectNoCommand(commands, "tab create");
		expectNoCommand(commands, "worktree create");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		// The existing branch is checked out, not re-created from a base.
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expectNoCommand(commands, "--base");
		expectNoCommand(commands, "rev-parse HEAD");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
		expectNoCommand(commands, "workspace close");
		expectNoCommand(commands, "worktree remove");
		expectNoCommand(commands, "branch -D");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		// The attached workspace is closed; the worktree and the branch
		// pre-date the handoff and stay.
		const commands = runner.commands();
		expect(commands).toContain("herdr workspace close ws-wt");
		expectNoCommand(commands, "worktree remove");
		expectNoCommand(commands, "branch -D");
		expectNoCommand(commands, "tab close");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		// The fresh worktree is removed, so a retry can run. The branch
		// pre-dates the handoff and may hold the ticket's earlier work: it
		// stays.
		const commands = runner.commands();
		expect(commands).toContain(`herdr worktree remove --workspace ws-wt`);
		expectNoCommand(commands, "branch -D");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toBe("error: herdr is not running");
		expectNoCommand(runner.commands(), "worktree create");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("no workspace id");
		expect(reasonOf(outcome)).toContain("leftover branch factory/7-retry-policy-for-webhooks");
		// The cleanup needs the workspace id, so it cannot run and no
		// command ran after the failed step.
		expectNoCommand(runner.commands(), "worktree remove");
	});

	test("a refused worktree create states the line that names the failure", async () => {
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
		// herdr answers a refused create with Git's whole stderr: the line of
		// the work it was doing first, and the refusal last.
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
			{
				code: 1,
				stderr:
					'{"error":{"code":"worktree_create_failed","message":"Preparing worktree (checking out \'factory/7-retry-policy-for-webhooks\')' +
					"\\nfatal: 'factory/7-retry-policy-for-webhooks' is already used by worktree at '/home/op/worktrees/billing/factory-7'" +
					'"},"id":"cli:worktree:create"}\n',
			},
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		// The operator reads the refusal they can act on and herdr's stable
		// code, never the progress line that precedes it.
		expect(reasonOf(outcome)).toBe(
			"fatal: 'factory/7-retry-policy-for-webhooks' is already used by worktree at '/home/op/worktrees/billing/factory-7' (worktree_create_failed)",
		);
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		// The agent is running in the worktree and can be prompted by hand.
		expect(outcome.status).toBe("prompt-failed");
		expectNoCommand(runner.commands(), "worktree remove");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
		expectNoCommand(runner.commands(), "worktree create");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(`herdr worktree list --cwd ${CHECKOUT}`);
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expectNoCommand(commands, "--path");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expectNoCommand(commands, "--path");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --no-focus`,
		);
		expectNoCommand(commands, "--path");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
		expectNoCommand(commands, "worktree create");
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("the worktree will not open");
		expectNoCommand(runner.commands(), "worktree create");
	});
});

describe("handOffTicket: the leftover worktree directory that blocks a create", () => {
	afterEach(() => {
		rmSync(join(HOME, "worktrees"), { recursive: true, force: true });
	});

	test("the plane moves the leftover aside, creates again, and starts the agent", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		reuseToFreshCreate(runner);
		makeDirectory(ticketWorktreePath(), { ".docusaurus/routes.js": "cache" });
		runner.setSequence("herdr", createOnBranch(), [
			worktreeCreateBlocked(ticketWorktreePath()),
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		]);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		// The create ran twice: the refusal, the move, then the same ask.
		expect(
			runner.commands().filter((command) => command.includes("worktree create --cwd")),
		).toHaveLength(2);
		// Nothing was deleted: the leftover stands whole under the name that says so.
		expect(existsSync(ticketWorktreePath())).toBe(false);
		expect(readFileSync(`${ticketWorktreePath()}.leftover/.docusaurus/routes.js`, "utf8")).toBe(
			"cache",
		);
		expect(outcome.notes?.leftoverWorktree).toBe(
			`the plane moved the leftover worktree directory ${ticketWorktreePath()} aside to ${ticketWorktreePath()}.leftover`,
		);
	});

	test("a second leftover takes the next free name, so the first stays where it is", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		reuseToFreshCreate(runner);
		makeDirectory(ticketWorktreePath(), { ".docusaurus/routes.js": "second" });
		makeDirectory(`${ticketWorktreePath()}.leftover`, { ".docusaurus/routes.js": "first" });
		runner.setSequence("herdr", createOnBranch(), [
			worktreeCreateBlocked(ticketWorktreePath()),
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		]);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		expect(readFileSync(`${ticketWorktreePath()}.leftover/.docusaurus/routes.js`, "utf8")).toBe(
			"first",
		);
		expect(readFileSync(`${ticketWorktreePath()}.leftover-2/.docusaurus/routes.js`, "utf8")).toBe(
			"second",
		);
	});

	test("a refusal with no leftover directory beside it runs one create and moves nothing", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		reuseToFreshCreate(runner);
		runner.set("herdr", createOnBranch(), worktreeCreateBlocked(ticketWorktreePath()));

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("already exists");
		expect(runner.commands().filter((command) => command.includes("worktree create"))).toHaveLength(
			1,
		);
		expect(outcome.notes?.leftoverWorktree).toBeUndefined();
	});

	test("an empty directory blocks nothing, so the plane leaves it and its refusal alone", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		reuseToFreshCreate(runner);
		mkdirSync(ticketWorktreePath(), { recursive: true });
		runner.set("herdr", createOnBranch(), worktreeCreateBlocked(ticketWorktreePath()));

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		// git takes an empty directory, so that refusal is about something else.
		expect(existsSync(ticketWorktreePath())).toBe(true);
		expect(existsSync(`${ticketWorktreePath()}.leftover`)).toBe(false);
	});

	test("a path git still records is herdr's to clear: the plane never moves it", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		reuseToFreshCreate(runner);
		makeDirectory(ticketWorktreePath(), { ".docusaurus/routes.js": "cache" });
		// git's list holds the ticket's own path, and prunes it: a stale record,
		// not an untracked directory.
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], {
			stdout: worktreeListJson([
				{ path: CHECKOUT, linked: false },
				{
					path: ticketWorktreePath(),
					branch: "factory/7-retry-policy-for-webhooks",
					prunable: true,
				},
			]),
		});
		runner.set("herdr", createOnBranch(), {
			code: 1,
			stderr:
				'{"error":{"code":"worktree_create_failed","message":"Preparing worktree (checking out \'factory/7-retry-policy-for-webhooks\')' +
				`\\nfatal: '${ticketWorktreePath()}' is a missing but already registered worktree;` +
				"\\nuse 'add -f' to override, or 'prune' or 'remove' to clear\"},\"id\":\"cli:worktree:create\"}\n",
		});

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("already registered worktree");
		expect(existsSync(`${ticketWorktreePath()}.leftover`)).toBe(false);
		expect(readFileSync(join(ticketWorktreePath(), ".docusaurus/routes.js"), "utf8")).toBe("cache");
	});

	test("a path that holds a .git entry is a checkout: the plane never moves it", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		reuseToFreshCreate(runner);
		makeDirectory(ticketWorktreePath(), {
			".git": "gitdir: /somewhere/worktrees/x",
			"src/app.ts": "the work",
		});
		runner.set("herdr", createOnBranch(), worktreeCreateBlocked(ticketWorktreePath()));

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(existsSync(`${ticketWorktreePath()}.leftover`)).toBe(false);
		expect(existsSync(join(ticketWorktreePath(), ".git"))).toBe(true);
	});

	test("the fresh create on a new branch takes the same recovery", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-retry-policy-for-webhooks"], {
			stdout: "",
		});
		stubRemoteDefaultBranch(runner);
		runner.set("herdr", ["worktree", "list", "--cwd", CHECKOUT], { stdout: siblingWorktreeList() });
		makeDirectory(ticketWorktreePath(), { ".docusaurus/routes.js": "cache" });
		runner.setSequence(
			"herdr",
			[...createOnBranch().slice(0, 6), "--base", "origin/main", "--no-focus"],
			[
				worktreeCreateBlocked(ticketWorktreePath()),
				{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
			],
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		// The retry asks the same create, the worktree base and all.
		expect(runner.commands().filter((command) => command.includes("worktree create"))).toHaveLength(
			2,
		);
		expect(
			runner.commands().filter((command) => command.includes("--base origin/main")),
		).toHaveLength(2);
		expect(existsSync(`${ticketWorktreePath()}.leftover/.docusaurus/routes.js`)).toBe(true);
	});
});

describe("handOffTicket: the guard rails", () => {
	test("only open tickets can be handed off", async () => {
		const runner = new FakeRunner();
		const outcome = await handOffTicket({ ...ticket, state: "running" }, defaultChoice, {
			claim: "open",
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
				{
					claim: "open",
					config: BASE_CONFIG,
					runner,
					home: HOME,
				},
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
				{
					claim: "open",
					config: BASE_CONFIG,
					runner,
					home: HOME,
				},
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
				{
					claim: "open",
					config: BASE_CONFIG,
					runner,
					home: HOME,
				},
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
				{
					claim: "open",
					config: BASE_CONFIG,
					runner,
					home: HOME,
				},
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

			const outcome = await handOffTicket(
				ticket,
				{ ...defaultChoice, model: "gpt-4o" },
				{
					config: BASE_CONFIG,
					runner,
					home: HOME,
					previousMessage: "settled earlier",
					claim: "continuation",
					previous: {
						workspaceId: "ws-stored",
						environment: "live-worktree",
						tabId: "tab-prev",
					},
				},
			);

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
			const startCheck = await checkStart(consultation, BASE_CONFIG, runner);
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
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);
		expect(agent).toEqual({ status: "failed", reason: "unknown agent type: cursor" });
		const task = await handOffTicket(
			ticket,
			{ ...defaultChoice, taskType: "refactor" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
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
			claim: "open",
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
			claim: "open",
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
			{
				claim: "open",
				config,
				runner,
				home: HOME,
			},
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
				{
					claim: "open",
					config,
					runner,
					home: HOME,
				},
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
			claim: "open",
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
			claim: "open",
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

describe("handOffTicket: the workflow handoff and the restart", () => {
	test("reuses the stored live workspace, tabs without a cwd, closes the previous tab", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-stored", "--no-focus"], {
			stdout: tabCreateJson("pane-2"),
		});

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: BASE_CONFIG,
			runner,
			home: HOME,
			previousMessage: "settled earlier",
			claim: "continuation",
			previous: {
				workspaceId: "ws-stored",
				environment: "live-worktree",
				tabId: "tab-prev",
			},
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

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, agentType: "codex", model: "gpt-5.6", thinking: "high" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				previousMessage: "the interrupted work",
				claim: "continuation",
				previous: {
					workspaceId: "ws-stored",
					environment: "live-worktree",
					tabId: "tab-interrupted",
				},
			},
		);

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

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: previousMessageConfig,
			runner,
			home: HOME,
			previousMessage: "settled earlier",
			claim: "continuation",
			previous: {
				workspaceId: "ws-stored",
				environment: "live-worktree",
				tabId: null,
			},
		});

		expect(outcome.status).toBe("ok");
		const prompt = runner.calls.find(
			(c) => c.command === "herdr" && c.args[0] === "agent" && c.args[1] === "prompt",
		);
		// `herdr agent prompt <name> <prompt>`: the prompt is the last argument.
		expect(prompt?.args.at(-1)).toBe("Previous: settled earlier\nAdd a retry policy.");
		// No previous tab: nothing to close.
		expectNoCommand(runner.commands(), "tab close");
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

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				previousMessage: "settled earlier",
				claim: "continuation",
				previous: {
					workspaceId: "ws-gone",
					environment: "worktree",
					tabId: "tab-prev",
				},
			},
		);

		expect(outcome.status).toBe("ok");
		// Reopen does not recheck the branch or read HEAD: the branch is the
		// branch, and herdr's open owns it.
		const commands = runner.commands();
		expectNoCommand(commands, "branch --list");
		expectNoCommand(commands, "rev-parse HEAD");
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

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: BASE_CONFIG,
			runner,
			home: HOME,
			previousMessage: "settled earlier",
			claim: "continuation",
			previous: {
				workspaceId: "ws-gone",
				environment: "live-worktree",
				tabId: "tab-prev",
			},
		});

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		// The live sequence found the workspace the checkout still lives in.
		expect(commands).toContain(
			`herdr tab create --workspace ws-still --cwd ${CHECKOUT} --no-focus`,
		);
		expectNoCommand(commands, "workspace create");
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

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				previousMessage: "settled earlier",
				claim: "continuation",
				previous: {
					workspaceId: "ws-live",
					environment: "live-worktree",
					tabId: "tab-prev",
				},
			},
		);

		expect(outcome.status).toBe("ok");
		// The choice says worktree, the storage says live: build fresh.
		const commands = runner.commands();
		expect(commands).toContain(
			`herdr worktree create --cwd ${CHECKOUT} --branch factory/7-retry-policy-for-webhooks --base origin/main --no-focus`,
		);
		expectNoCommand(commands, "tab create --workspace ws-live");
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

		const outcome = await handOffTicket(ticket, defaultChoice, {
			config: BASE_CONFIG,
			runner,
			home: HOME,
			previousMessage: "settled earlier",
			claim: "continuation",
			previous: {
				workspaceId: "ws-stored",
				environment: "live-worktree",
				tabId: "tab-prev",
			},
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
			claim: "open",
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
			claim: "open",
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

		const outcome = await handOffTicket(
			{ ...ticket, state: "running" },
			{ ...defaultChoice, agentType: "pi", contextWindow: "272000" },
			{
				config: BASE_CONFIG,
				runner,
				home: HOME,
				previousMessage: "",
				claim: "continuation",
				previous: {
					workspaceId: "ws-stored",
					environment: "live-worktree",
					tabId: "tab-prev",
				},
			},
		);

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

		const outcome = await handOffTicket(
			{ ...ticket, state: "awaiting" },
			resolveHandoffChoice(config, "review", edge),
			{
				config,
				runner,
				home: HOME,
				previousMessage: "settled earlier",
				claim: "continuation",
				previous: {
					workspaceId: "ws-stored",
					environment: "live-worktree",
					tabId: "tab-prev",
				},
			},
		);

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

		const outcome = await handOffTicket(
			{ ...ticket, state: "awaiting" },
			resolveHandoffChoice(config, "review", edge),
			{
				config,
				runner,
				home: HOME,
				previousMessage: "settled earlier",
				claim: "continuation",
				previous: {
					workspaceId: "ws-stored",
					environment: "live-worktree",
					tabId: "tab-prev",
				},
			},
		);

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
				claim: "open",
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
				claim: "open",
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
				claim: "open",
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
				claim: "open",
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
				claim: "open",
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
			claim: "open",
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
				claim: "open",
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

	test("a worktree close sends no focus command; herdr keeps the operator's view", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
		);

		// The control plane never moves herdr's view on its own (ADR 0061).
		// herdr 0.9.1 keeps each client on the workspace it views, and a close
		// of a workspace the client is not viewing leaves that view alone, so
		// there is nothing to return and no focus command follows the removal.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual(["herdr worktree remove --workspace ws-1"]);
		expect(herdrFocusCommands(runner.commands())).toEqual([]);
	});

	test("a tab close sends no focus command", async () => {
		const runner = new FakeRunner();

		const failure = await closeHandoffEnvironment(
			{ environment: "live-worktree", tabId: "tab-1", workspaceId: "ws-1" },
			runner,
		);

		// The tab close keeps the workspace and the tabs beside it, so herdr
		// leaves the operator's view where it stood: the cleanup never issues
		// a focus command.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual(["herdr tab close tab-1"]);
		expect(herdrFocusCommands(runner.commands())).toEqual([]);
	});

	test("a left workspace close sends no focus command", async () => {
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

		// The fallback workspace close is a close like any other: the plane
		// names no workspace for its own, so the sequence ends at herdr.
		expect(failure).toBeUndefined();
		expect(runner.commands()).toEqual([
			"herdr worktree remove --workspace ws-1",
			"herdr workspace close ws-1",
		]);
		expect(herdrFocusCommands(runner.commands())).toEqual([]);
	});

	test("a herdr refusal of a close still reports its reason and takes no focus", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"workspace_close_failed","message":"the server is down"},"id":"cli"}\n',
		});

		const failure = await closeHandoffEnvironment(
			{ environment: "worktree", tabId: null, workspaceId: "ws-1" },
			runner,
		);

		// Dropping the focus call costs no bookkeeping: a refusal is still one
		// command and still comes back as the reason the caller reports.
		expect(failure).toBe("the server is down (workspace_close_failed)");
		expect(runner.commands()).toEqual(["herdr worktree remove --workspace ws-1"]);
	});
});

describe("the review verdict of the rework handoff prompt", () => {
	// The shared seam of the issue: the handoff functions with a faked
	// command runner. The verdict read's command shapes are the judgment's
	// shapes, the pull request's two posting timelines, each walked to its
	// last page (ADR 0047, ADR 0053, ADR 0057, ADR 0063, ADR 0074).
	const COMMENT_READ: readonly string[] = [
		"api",
		"--paginate",
		"--hostname",
		"github.com",
		"repos/acme/billing/issues/12/comments?per_page=100",
	];
	const REVIEW_READ: readonly string[] = [
		"api",
		"--paginate",
		"--hostname",
		"github.com",
		"repos/acme/billing/pulls/12/reviews?per_page=100",
	];

	const verdictSource: TicketSourceConfig = {
		name: "github",
		kind: "github-pull-requests",
		refreshIntervalSeconds: 60,
		repositories: ["github.com/acme/billing"],
		host: "github.com",
	};

	const reviewVerdictConfig: FactoryConfig = {
		...BASE_CONFIG,
		sources: [verdictSource],
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			rework: {
				...BASE_CONFIG.taskTypes.rework,
				template: "Verdict:\n{review-verdict}\n\nPrev: {previous-message}\n\nBody: {description}",
			},
		},
	};

	// The pull request ticket the rework handoff renders: its newest
	// membership supplies the source name, the repository, and the pull
	// request number.
	const pullTicket: Ticket = {
		...ticket,
		identity: "github:github.com:P_12",
		sourceKind: "github-pull-request",
		externalKey: "#12",
		title: "Persist source facts",
		description: "The implementation of #5.",
		url: "https://github.com/acme/billing/pulls/12",
		labels: ["needs-work"],
		memberships: [
			{
				identity: "github:github.com:P_12",
				sourceKind: "github-pull-request",
				externalKey: "#12",
				sourceState: "open",
				url: "https://github.com/acme/billing/pulls/12",
				title: "Persist source facts",
				description: "The implementation of #5.",
				labels: ["needs-work"],
				externalUpdatedAt: "2026-01-01T00:00:00Z",
				repository: {
					identity: "github.com/acme/billing",
					displayName: "acme/billing",
					cloneUrl: "https://github.com/acme/billing.git",
				},
				attributes: {},
				sourceName: "github",
				health: "healthy",
			},
		],
	};

	// The config the threshold rule decides against (ADR 0078): the review
	// task type's transition tests the score at the 90 the stub walk stands
	// on, so a verdict at or above it fills the gates fact.
	const thresholdConfig: FactoryConfig = {
		...reviewVerdictConfig,
		taskTypes: {
			...reviewVerdictConfig.taskTypes,
			review: {
				...reviewVerdictConfig.taskTypes.review,
				transition: {
					ticketFacts: [],
					pullRequestFacts: [],
					scoreThreshold: 90,
					branches: [
						{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] },
						{ when: "score-below-threshold", pullRequestFacts: ["needs-work"] },
					],
				},
			},
		},
	};

	const reworkChoice = { ...defaultChoice, taskType: "rework" };

	const VERDICT_BODY = "Required Changes:\n- Fix the tabs\n- **Score:** 85 / 100";

	function setComments(
		runner: FakeRunner,
		comments: readonly { body: string; created_at?: string }[],
	): void {
		runner.set("gh", COMMENT_READ, { stdout: JSON.stringify(comments) });
	}

	function setReviews(
		runner: FakeRunner,
		reviews: readonly { body: string; submitted_at?: string }[],
	): void {
		runner.set("gh", REVIEW_READ, { stdout: JSON.stringify(reviews) });
	}

	/** The prompt string the agent receives, from the herdr prompt send. */
	function promptOf(runner: FakeRunner): string {
		const call = runner.calls.find(
			(item) => item.command === "herdr" && item.args[0] === "agent" && item.args[1] === "prompt",
		);
		if (call === undefined) throw new Error("no prompt was sent");
		return String(call.args[call.args.length - 1]);
	}

	function freshRework(
		runner: FakeRunner,
		config: FactoryConfig = reviewVerdictConfig,
	): Promise<HandoffOutcome> {
		conventionCheckout(runner);
		stubLiveWorkspace(runner);
		return handOffTicket(pullTicket, reworkChoice, {
			claim: "open",
			config,
			runner,
			home: HOME,
		});
	}

	test("a template without the placeholder issues no verdict read", async () => {
		// The gate: the read is issued only when the template text references
		// the placeholder, so the command stream of a template that names no
		// placeholder is unchanged.
		const runner = new FakeRunner();
		const outcome = await freshRework(runner, BASE_CONFIG);
		expect(outcome.status).toBe("ok");
		expect(runner.commands().filter((command) => command.startsWith("gh "))).toEqual([]);
	});

	test("a template with the placeholder reads both timelines", async () => {
		const runner = new FakeRunner();
		setComments(runner, []);
		setReviews(runner, []);
		const outcome = await freshRework(runner);
		expect(outcome.status).toBe("ok");
		expect(runner.commands()).toContain(`gh ${COMMENT_READ.join(" ")}`);
		expect(runner.commands()).toContain(`gh ${REVIEW_READ.join(" ")}`);
	});

	test("the standing verdict fills the prompt: header and body unchanged", async () => {
		const runner = new FakeRunner();
		setComments(runner, []);
		setReviews(runner, [{ body: VERDICT_BODY, submitted_at: "2026-08-31T12:00:00Z" }]);
		const outcome = await freshRework(runner);
		expect(outcome.status).toBe("ok");
		expect(promptOf(runner)).toBe(
			"Verdict:\n" +
				`Posted as a review at 2026-08-31T12:00:00Z:\n${VERDICT_BODY}\n\n` +
				"Prev: \n\n" +
				"Body: The implementation of #5.",
		);
	});

	test("the newest score-carrying record across both timelines decides", async () => {
		// The rule is the judgment's: newest first across both timelines, and
		// the first record that carries the fixed score line stands.
		const runner = new FakeRunner();
		setComments(runner, [
			{ body: "On re-check:\n- **Score:** 95 / 100", created_at: "2026-08-31T13:00:00Z" },
		]);
		setReviews(runner, [{ body: VERDICT_BODY, submitted_at: "2026-08-31T12:00:00Z" }]);
		const outcome = await freshRework(runner);
		expect(outcome.status).toBe("ok");
		expect(promptOf(runner)).toBe(
			"Verdict:\n" +
				"Posted as a comment at 2026-08-31T13:00:00Z:\nOn re-check:\n- **Score:** 95 / 100\n\n" +
				"Prev: \n\n" +
				"Body: The implementation of #5.",
		);
	});

	test("no record carrying the score line fills the no-verdict fact", async () => {
		const runner = new FakeRunner();
		setComments(runner, [
			{ body: "Looks good, no score line here.", created_at: "2026-08-31T12:00:00Z" },
		]);
		setReviews(runner, [{ body: "Approved.", submitted_at: "2026-08-31T13:00:00Z" }]);
		const outcome = await freshRework(runner);
		expect(outcome.status).toBe("ok");
		expect(promptOf(runner)).toBe(
			"Verdict:\n" +
				"No review verdict found on the pull request.\n\n" +
				"Prev: \n\n" +
				"Body: The implementation of #5.",
		);
	});

	test("every timeline failing fills the failure fact with the read's reason", async () => {
		const runner = new FakeRunner();
		runner.set("gh", COMMENT_READ, { code: 1, stderr: "rate limited by the source\n" });
		runner.set("gh", REVIEW_READ, { code: 1, stderr: "the source timed out\n" });
		const outcome = await freshRework(runner);
		expect(outcome.status).toBe("ok");
		expect(promptOf(runner)).toBe(
			"Verdict:\n" +
				"The review verdict read failed: the comment read failed (rate limited by the source); " +
				"the review read failed (the source timed out).\n\n" +
				"Prev: \n\n" +
				"Body: The implementation of #5.",
		);
	});

	test("a verdict score at or above the workflow threshold fills the gates fact", async () => {
		// ADR 0078: the review passed, so the rework works the gates - the
		// merge conflict or the failing CI check - not the review's feedback.
		const runner = new FakeRunner();
		setComments(runner, []);
		setReviews(runner, [
			{ body: "Looks good.\n- **Score:** 95 / 100", submitted_at: "2026-08-31T12:00:00Z" },
		]);
		const outcome = await freshRework(runner, thresholdConfig);
		expect(outcome.status).toBe("ok");
		expect(promptOf(runner)).toBe(
			"Verdict:\n" +
				"The review passed: the score 95 stands at or above the threshold 90. " +
				"The failure stands in the pull request's gates: a merge conflict or a failing CI check. " +
				"Rebase the branch onto its base and fix what the gates report.\n\n" +
				"Prev: \n\n" +
				"Body: The implementation of #5.",
		);
	});

	test("a verdict score below the workflow threshold keeps the verdict's body", async () => {
		const runner = new FakeRunner();
		setComments(runner, []);
		setReviews(runner, [{ body: VERDICT_BODY, submitted_at: "2026-08-31T12:00:00Z" }]);
		const outcome = await freshRework(runner, thresholdConfig);
		expect(outcome.status).toBe("ok");
		expect(promptOf(runner)).toBe(
			"Verdict:\n" +
				`Posted as a review at 2026-08-31T12:00:00Z:\n${VERDICT_BODY}\n\n` +
				"Prev: \n\n" +
				"Body: The implementation of #5.",
		);
	});

	test("one timeline failing: the standing records decide, no failure fact", async () => {
		// The per-timeline fail-open the judgment runs: the failing timeline
		// contributes nothing, and the standing timeline's record decides.
		const runner = new FakeRunner();
		setComments(runner, [{ body: VERDICT_BODY, created_at: "2026-08-31T12:00:00Z" }]);
		runner.set("gh", REVIEW_READ, { code: 1, stderr: "the source timed out\n" });
		const outcome = await freshRework(runner);
		expect(outcome.status).toBe("ok");
		const prompt = promptOf(runner);
		expect(prompt).toContain(`Posted as a comment at 2026-08-31T12:00:00Z:\n${VERDICT_BODY}`);
		expect(prompt).not.toContain("review verdict read failed");
	});

	test("the stored-workspace handoff and the restart carry the fill", async () => {
		// The restart and the Work queue pickup render through the stored
		// workspace's render point, the way the workflow handoff does: the
		// verdict stands in the prompt with the last captured message beside
		// it, and a new agent session starts with the same context.
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-stored", "--no-focus"], {
			stdout: tabCreateJson("pane-2"),
		});
		setComments(runner, []);
		setReviews(runner, [{ body: VERDICT_BODY, submitted_at: "2026-08-31T12:00:00Z" }]);

		const outcome = await handOffTicket(pullTicket, reworkChoice, {
			config: reviewVerdictConfig,
			runner,
			home: HOME,
			previousMessage: "the last message",
			claim: "continuation",
			previous: {
				workspaceId: "ws-stored",
				environment: "live-worktree",
				tabId: "tab-prev",
			},
		});

		expect(outcome.status).toBe("ok");
		expect(promptOf(runner)).toBe(
			"Verdict:\n" +
				`Posted as a review at 2026-08-31T12:00:00Z:\n${VERDICT_BODY}\n\n` +
				"Prev: the last message\n\n" +
				"Body: The implementation of #5.",
		);
	});
});

// ---------------------------------------------------------------------------
// ADR 0076: the pull request the plane opens before the agent works.
// ---------------------------------------------------------------------------

const PR_SOURCE: TicketSourceConfig = {
	name: "github",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/billing"],
	host: "github.com",
};

/** The handoff ticket with the membership its task type's open step reads. */
const PR_TICKET: Ticket = {
	...ticket,
	memberships: [
		{
			sourceName: "github",
			health: "healthy",
			identity: "github:github.com:issue-github.com/acme/billing/7",
			sourceKind: "github-issue",
			externalKey: "#7",
			sourceState: "open",
			url: "https://github.com/acme/billing/issues/7",
			title: "Retry policy for webhooks",
			description: "Add a retry policy.",
			labels: [],
			externalUpdatedAt: "2026-01-01T00:00:00Z",
			repository: ticket.repositoryRef,
			attributes: {},
		},
	],
};

const PR_CONFIG: FactoryConfig = {
	...BASE_CONFIG,
	sources: [PR_SOURCE],
	taskTypes: {
		...BASE_CONFIG.taskTypes,
		implement: {
			opensPullRequest: true,
			template: "Implement {external-key}.\n\nPull request: {pull-request-url}",
		},
	},
};

const PR_BRANCH = "factory/7-retry-policy-for-webhooks";
const PR_URL = "https://github.com/acme/billing/pull/42";
const PR_READ_ARGS = [
	"api",
	"--hostname",
	"github.com",
	`repos/acme/billing/pulls?state=open&head=${encodeURIComponent(`acme:${PR_BRANCH}`)}`,
];
const PR_BODY = `Closes #7\n\n${ticket.url}\n\n${ticket.description}`;
const PR_CREATE_COMMAND = [
	"gh",
	"pr",
	"create",
	"--repo",
	"github.com/acme/billing",
	"--head",
	PR_BRANCH,
	"--draft",
	"--title",
	ticket.title,
	"--body",
	PR_BODY,
].join(" ");

/**
 * Stub the hold commit the open steps a fresh branch onto: the refs read,
 * the empty commit built on them, and the branch moved to it.
 */
function stubHoldCommit(runner: FakeRunner): void {
	runner.set("git", ["-C", CHECKOUT, "rev-parse", PR_BRANCH, `${PR_BRANCH}^{tree}`], {
		stdout: "abc123\ndef456\n",
	});
	runner.set(
		"git",
		[
			"-C",
			CHECKOUT,
			"commit-tree",
			"def456",
			"-p",
			"abc123",
			"-m",
			"factory: hold the branch for the pull request",
		],
		{ stdout: "sha1111\n" },
	);
	runner.set("git", ["-C", CHECKOUT, "update-ref", `refs/heads/${PR_BRANCH}`, "sha1111"], {
		stdout: "",
	});
}

/**
 * Stub the branch push and the branch's pull request read of the open step.
 * A standing draft stands on a branch the remote already carried, so the
 * branch read answers it in the standing mode.
 */
function stubPullRequestOpenStep(runner: FakeRunner, { standing = false } = {}): void {
	runner.set("git", ["-C", CHECKOUT, "ls-remote", "--heads", "origin", PR_BRANCH], {
		stdout: standing ? `abc123\trefs/heads/${PR_BRANCH}\n` : "",
	});
	if (!standing) stubHoldCommit(runner);
	runner.set("git", ["-C", CHECKOUT, "push", "origin", PR_BRANCH], { stdout: "" });
	if (standing) {
		runner.set("gh", PR_READ_ARGS, {
			stdout: JSON.stringify([
				{
					number: 42,
					state: "open",
					draft: true,
					html_url: PR_URL,
					head: { ref: PR_BRANCH },
					base: { ref: "main" },
					labels: [],
				},
			]),
		});
	} else {
		runner.set("gh", PR_READ_ARGS, { stdout: "[]" });
		runner.set(
			"gh",
			[
				"pr",
				"create",
				"--repo",
				"github.com/acme/billing",
				"--head",
				PR_BRANCH,
				"--draft",
				"--title",
				ticket.title,
				"--body",
				PR_BODY,
			],
			{ stdout: `${PR_URL}\n` },
		);
	}
}

/** Stub the worktree sequence the open step follows. */
function stubPrWorktreeHandoff(runner: FakeRunner): void {
	conventionCheckout(runner);
	runner.set("git", ["-C", CHECKOUT, "branch", "--list", PR_BRANCH], { stdout: "" });
	stubRemoteDefaultBranch(runner);
	runner.set(
		"herdr",
		[
			"worktree",
			"create",
			"--cwd",
			CHECKOUT,
			"--branch",
			PR_BRANCH,
			"--base",
			"origin/main",
			"--no-focus",
		],
		{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
	);
}

describe("handOffTicket: the pull request the plane opens (ADR 0076)", () => {
	test("a task type that opens a pull request pushes the branch, opens the draft, and sends the prompt with its url", async () => {
		const runner = new FakeRunner();
		stubPrWorktreeHandoff(runner);
		stubPullRequestOpenStep(runner);

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		// The open step stands between the environment and the agent: the
		// fresh branch takes the plane's hold commit - the branch moved by its
		// name, the checkout's current branch untouched - the branch is
		// pushed, the branch's pull requests are read by its head branch, the
		// draft is opened, and the prompt the agent receives carries the pull
		// request's url.
		expect(runner.commands()).toEqual([
			`git -C ${CHECKOUT} rev-parse --git-dir`,
			`git -C ${CHECKOUT} remote get-url origin`,
			`git -C ${CHECKOUT} branch --list ${PR_BRANCH}`,
			`git -C ${CHECKOUT} remote get-url origin`,
			`git -C ${CHECKOUT} symbolic-ref refs/remotes/origin/HEAD`,
			`git -C ${CHECKOUT} fetch origin main`,
			`herdr worktree create --cwd ${CHECKOUT} --branch ${PR_BRANCH} --base origin/main --no-focus`,
			`git -C ${CHECKOUT} ls-remote --heads origin ${PR_BRANCH}`,
			`git -C ${CHECKOUT} rev-parse ${PR_BRANCH} ${PR_BRANCH}^{tree}`,
			`git -C ${CHECKOUT} commit-tree def456 -p abc123 -m factory: hold the branch for the pull request`,
			`git -C ${CHECKOUT} update-ref refs/heads/${PR_BRANCH} sha1111`,
			`git -C ${CHECKOUT} push origin ${PR_BRANCH}`,
			`gh ${PR_READ_ARGS.join(" ")}`,
			PR_CREATE_COMMAND,
			`herdr agent start ${AGENT} --kind pi --pane pane-wt`,
			`herdr agent prompt ${AGENT} Implement #7.\n\nPull request: ${PR_URL}`,
		]);
	});

	test("a draft create that answers the fresh branch's lag retries, and the prompt still goes out", async () => {
		const runner = new FakeRunner();
		stubPrWorktreeHandoff(runner);
		runner.set("git", ["-C", CHECKOUT, "ls-remote", "--heads", "origin", PR_BRANCH], {
			stdout: "",
		});
		stubHoldCommit(runner);
		runner.set("git", ["-C", CHECKOUT, "push", "origin", PR_BRANCH], { stdout: "" });
		runner.set("gh", PR_READ_ARGS, { stdout: "[]" });
		runner.setSequence(
			"gh",
			[
				"pr",
				"create",
				"--repo",
				"github.com/acme/billing",
				"--head",
				PR_BRANCH,
				"--draft",
				"--title",
				ticket.title,
				"--body",
				PR_BODY,
			],
			[
				{
					code: 1,
					stderr:
						"GraphQL: No commits exist on github.com:acme/billing:factory/7-retry-policy-for-webhooks. (HTTP 400)\n",
				},
				{ stdout: `${PR_URL}\n` },
			],
		);

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		// The create is the one command the retry re-runs, and the prompt the
		// agent receives still carries the pull request's url.
		const creates = runner.commands().filter((command) => command === PR_CREATE_COMMAND);
		expect(creates).toHaveLength(2);
		expect(runner.commands()).toContain(
			`herdr agent prompt ${AGENT} Implement #7.\n\nPull request: ${PR_URL}`,
		);
	});

	test("a draft the branch already carries is reused: no second draft is opened", async () => {
		const runner = new FakeRunner();
		stubPrWorktreeHandoff(runner);
		stubPullRequestOpenStep(runner, { standing: true });

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).toContain(`gh ${PR_READ_ARGS.join(" ")}`);
		expect(commands).not.toContain(PR_CREATE_COMMAND);
		// The standing branch pre-dates the attempt: the attempt commits no
		// hold on it, the way it opens no second draft.
		expect(commands).not.toContain(`git -C ${CHECKOUT} update-ref refs/heads/${PR_BRANCH} sha1111`);
		// The prompt still carries the standing pull request's url.
		expect(commands).toContain(
			`herdr agent prompt ${AGENT} Implement #7.\n\nPull request: ${PR_URL}`,
		);
	});

	test("a failed agent start after the open closes the opened draft and deletes the pushed branch", async () => {
		const runner = new FakeRunner();
		stubPrWorktreeHandoff(runner);
		stubPullRequestOpenStep(runner);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("agent_name_taken");
		const commands = runner.commands();
		const openedAt = commands.indexOf(PR_CREATE_COMMAND);
		const closedAt = commands.indexOf(`gh pr close 42 --repo github.com/acme/billing`);
		const deletedAt = commands.indexOf(`git -C ${CHECKOUT} push origin --delete ${PR_BRANCH}`);
		const removedAt = commands.indexOf(`herdr worktree remove --workspace ws-wt`);
		expect(openedAt).toBeGreaterThanOrEqual(0);
		// The no-residue contract: the attempt closes the pull request it
		// opened, deletes the remote branch it pushed, and removes the
		// environment it created, in that order, after the failure.
		expect(closedAt).toBeGreaterThan(openedAt);
		expect(deletedAt).toBeGreaterThan(closedAt);
		expect(removedAt).toBeGreaterThan(deletedAt);
		expect(commands).toContain(`git -C ${CHECKOUT} branch -D ${PR_BRANCH}`);
	});

	test("a reused draft is not closed when the agent start fails after it", async () => {
		const runner = new FakeRunner();
		stubPrWorktreeHandoff(runner);
		stubPullRequestOpenStep(runner, { standing: true });
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		const commands = runner.commands();
		// The standing draft pre-dates the attempt: the attempt closes
		// nothing and deletes nothing of the branch it did not push.
		expect(commands).not.toContain(`gh pr close 42 --repo github.com/acme/billing`);
		expect(commands).not.toContain(`git -C ${CHECKOUT} push origin --delete ${PR_BRANCH}`);
		expect(commands).toContain(`herdr worktree remove --workspace ws-wt`);
	});

	test("a failed push leaves no residue of its own to clean up", async () => {
		const runner = new FakeRunner();
		stubPrWorktreeHandoff(runner);
		runner.set("git", ["-C", CHECKOUT, "ls-remote", "--heads", "origin", PR_BRANCH], {
			stdout: "",
		});
		stubHoldCommit(runner);
		runner.set("git", ["-C", CHECKOUT, "push", "origin", PR_BRANCH], {
			code: 128,
			stderr: "fatal: unable to access: Network is down\n",
		});

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("pushing the factory branch");
		const commands = runner.commands();
		expect(commands).not.toContain(`gh ${PR_READ_ARGS.join(" ")}`);
		expect(commands).not.toContain(PR_CREATE_COMMAND);
		expect(commands).not.toContain(`gh pr close 42 --repo github.com/acme/billing`);
		// The environment is removed, and the branch the remote never carried
		// is never deleted.
		expect(commands).toContain(`herdr worktree remove --workspace ws-wt`);
		expect(commands).not.toContain(`git -C ${CHECKOUT} push origin --delete ${PR_BRANCH}`);
	});

	test("a branch the remote already carries is not deleted on a later failure", async () => {
		const runner = new FakeRunner();
		stubPrWorktreeHandoff(runner);
		runner.set("git", ["-C", CHECKOUT, "ls-remote", "--heads", "origin", PR_BRANCH], {
			stdout: "abc123\trefs/heads/factory/7-retry-policy-for-webhooks\n",
		});
		runner.set("git", ["-C", CHECKOUT, "push", "origin", PR_BRANCH], { stdout: "" });
		runner.set("gh", PR_READ_ARGS, { stdout: "[]" });
		runner.set(
			"gh",
			[
				"pr",
				"create",
				"--repo",
				"github.com/acme/billing",
				"--head",
				PR_BRANCH,
				"--draft",
				"--title",
				ticket.title,
				"--body",
				PR_BODY,
			],
			{ stdout: `${PR_URL}\n` },
		);
		runner.set("herdr", ["agent", "start", AGENT, "--kind", "pi", "--pane", "pane-wt"], {
			code: 1,
			stderr: '{"error":{"code":"agent_name_taken","message":"agent name is already used"}}\n',
		});

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		const commands = runner.commands();
		// The attempt opened a draft on a branch it did not create: it closes
		// its draft and deletes nothing.
		expect(commands).toContain(`gh pr close 42 --repo github.com/acme/billing`);
		expect(commands).not.toContain(`git -C ${CHECKOUT} push origin --delete ${PR_BRANCH}`);
	});

	test("a task type that opens a pull request refuses the live worktree before it acts", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "live-worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("opens a pull request");
		expect(reasonOf(outcome)).toContain("worktree environment");
		// The refusal is the one pre-flight's own sentence, so it answers before
		// the start resolves - and could clone - a repository it will never use.
		expect(runner.commands()).toEqual([]);
	});

	test("a ticket that lists on no source the task type can read fails the open's pre-flight", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: PR_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("opens a pull request");
		// The open's own pre-flight reads the ticket and the config, so it answers
		// before the start resolves a repository it would never use.
		expect(runner.commands()).toEqual([]);
	});

	test("a task type that opens no pull request runs no open step", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", PR_BRANCH], { stdout: "" });
		stubRemoteDefaultBranch(runner);
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				PR_BRANCH,
				"--base",
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-wt", "pane-wt") },
		);

		const outcome = await handOffTicket(
			PR_TICKET,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		expect(commands).not.toContain(`git -C ${CHECKOUT} push origin ${PR_BRANCH}`);
		expect(commands).not.toContain(`gh ${PR_READ_ARGS.join(" ")}`);
	});
});

/**
 * The one start (issue #204): the rules every start path shares, measured at the
 * handoff interface instead of inside a caller.
 */
describe("the one start: one pre-flight order on both paths", () => {
	// Issue #204 measured the drift this block closes: an unknown Agent type
	// beside the reserved container Environment answered `the container
	// environment is reserved and not yet built` on the Ticket path and
	// `unknown agent type: nope` on the Consultation path. One rule now answers
	// one order, so the Message line and the Desktop notification carry the fact
	// the plane really read.

	const AGENT_AND_ENVIRONMENT_FACTS = { agentType: "nope", environment: "container" as const };

	test("an unknown Agent type beside the reserved Environment answers the Agent type on both paths", async () => {
		const runner = new FakeRunner();
		const onTicket = await handOffTicket(
			ticket,
			{ ...defaultChoice, ...AGENT_AND_ENVIRONMENT_FACTS },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);
		const onConsultation = await handOffConsultation({
			consultation: consultationRecord(AGENT_AND_ENVIRONMENT_FACTS),
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});
		expect(reasonOf(onTicket)).toBe("unknown agent type: nope");
		expect(reasonOf(onConsultation)).toBe(reasonOf(onTicket));
		// The pre-flight answers before either start touches anything external.
		expect(runner.calls).toHaveLength(0);
	});

	test("a known Agent type with the reserved Environment answers the Environment on both paths", async () => {
		const runner = new FakeRunner();
		const facts = { agentType: "pi", environment: "container" as const };
		const onTicket = await handOffTicket(
			ticket,
			{ ...defaultChoice, ...facts },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);
		const onConsultation = await handOffConsultation({
			consultation: consultationRecord(facts),
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});
		expect(reasonOf(onTicket)).toBe("the container environment is reserved and not yet built");
		expect(reasonOf(onConsultation)).toBe(reasonOf(onTicket));
		expect(runner.calls).toHaveLength(0);
	});

	test("the Agent type is answered before the Task type on the Ticket path", async () => {
		const runner = new FakeRunner();
		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, agentType: "nope", taskType: "refactor" },
			{ claim: "open", config: BASE_CONFIG, runner, home: HOME },
		);
		expect(reasonOf(outcome)).toBe("unknown agent type: nope");
	});

	test("the Task type is answered before the Setting fit on the Ticket path", async () => {
		const runner = new FakeRunner();
		// The model is unfit too, and the Agent type is known: the Task type is
		// the fact the order puts first, so its reason is the one the operator reads.
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, taskType: "refactor", model: "gpt-4o" },
			{ claim: "open", config: BASE_CONFIG, runner, home: HOME },
		);
		expect(reasonOf(outcome)).toBe("unknown task type: refactor");
		expect(runner.modelListCalls).toHaveLength(0);
	});

	test("the Setting fit is the last half of the order on both paths", async () => {
		const runner = new FakeRunner();
		runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		const onTicket = await handOffTicket(
			ticket,
			{ ...defaultChoice, model: "gpt-4o" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);
		const onConsultation = await handOffConsultation({
			consultation: consultationRecord({ model: "gpt-4o" }),
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});
		expect(reasonOf(onTicket)).toContain('has no model "gpt-4o"');
		expect(reasonOf(onConsultation)).toBe(reasonOf(onTicket));
		// The fit is a runtime read, and it is the only half that asks for one.
		expect(runner.modelListCalls).toEqual(["pi", "pi"]);
		expect(runner.calls).toHaveLength(0);
	});

	test("a choice that names no Task type answers with a whole reason", async () => {
		const runner = new FakeRunner();
		// One facts builder for every start (issue #204): an empty Task type reads
		// as "no Task type", so the answer is never `unknown task type: ` with a
		// trailing space for a name no start ever named.
		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, taskType: "" },
			{ claim: "open", config: BASE_CONFIG, runner, home: HOME },
		);
		expect(reasonOf(outcome)).toBe("the handoff names no task type");
		expect(runner.commands().join("\n")).not.toContain("herdr");
	});
});

describe("the one start: one stage order on both paths", () => {
	// Story 11: the stage facts appear in the same order on every path, so the
	// Message line reads the same progress whatever the operator asked for. The
	// dispatch writes these stages into the durable attempt, and the Consultation
	// launch reports them under its own id in test/consultation-operations.test.ts.
	// This block measures the order at the start module's own interface on every
	// path it serves: the Ticket's live Environment, the Ticket's worktree
	// Environment, and the Consultation's.

	/** Collect the stages one start reports, in the order it reports them. */
	function stageRecorder(into: string[]): (stage: string) => void {
		return (stage) => into.push(stage);
	}

	/**
	 * The order every path answers with. `checking-live-checkout-safety` is the
	 * Consultation live safety step's own stage, written by its launch before it
	 * calls the start, so it is not part of the start's order.
	 */
	const START_STAGES = [
		"resolving-repository",
		"creating-environment",
		"starting-agent",
		"sending-prompt",
	];

	test("a Ticket live start reports the stages in one order", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([{ id: "ws-other" }]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: workspaceCreateJson("ws-new"),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-new", "--cwd", CHECKOUT, "--no-focus"],
			{ stdout: tabCreateJson("pane-1") },
		);
		const stages: string[] = [];

		const outcome = await handOffTicket(ticket, defaultChoice, {
			claim: "open",
			config: BASE_CONFIG,
			runner,
			home: HOME,
			onStage: stageRecorder(stages),
		});

		expect(outcome.status).toBe("ok");
		expect(stages).toEqual(START_STAGES);
	});

	test("a Ticket worktree start reports the same stages in the same order", async () => {
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
		const stages: string[] = [];

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
				onStage: stageRecorder(stages),
			},
		);

		expect(outcome.status).toBe("ok");
		expect(stages).toEqual(START_STAGES);
	});

	test("a Consultation start reports the same stages in the same order", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-live", checkoutPath: CHECKOUT }]),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-live", "--cwd", CHECKOUT, "--no-focus"],
			{ stdout: tabCreateJson("pane-c1", "tab-c1") },
		);
		const stages: string[] = [];

		const outcome = await handOffConsultation({
			consultation: consultationRecord(),
			config: BASE_CONFIG,
			runner,
			home: HOME,
			onStage: stageRecorder(stages),
		});

		expect(outcome.status).toBe("ok");
		expect(stages).toEqual(START_STAGES);
	});

	test("a start that never reaches its Agent reports the stages it did reach", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([{ id: "ws-other" }]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: workspaceCreateJson("ws-new"),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-new", "--cwd", CHECKOUT, "--no-focus"],
			{ stdout: tabCreateJson("pane-1") },
		);
		stubStartFailure(runner, "pane-1");
		const stages: string[] = [];

		const outcome = await handOffTicket(ticket, defaultChoice, {
			claim: "open",
			config: BASE_CONFIG,
			runner,
			home: HOME,
			onStage: stageRecorder(stages),
		});

		expect(outcome.status).toBe("failed");
		// The order is the same as far as it goes: the failure stops after the
		// Environment stage, so the Message line never shows a stage the start did
		// not reach.
		expect(stages).toEqual(["resolving-repository", "creating-environment", "starting-agent"]);
	});
});

describe("the one start: one cleanup rule on every Environment kind", () => {
	test("a live start that creates its workspace removes its tab and that workspace", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
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
		stubStartFailure(runner, "pane-1");

		const outcome = await handOffTicket(ticket, defaultChoice, {
			claim: "open",
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		// The live kind cleans up the way the worktree kind always did: the tab
		// first, then the workspace behind it. No branch stands in this kind.
		const commands = runner.commands();
		expect(commands).toContain("herdr tab close tab-1");
		expect(commands).toContain("herdr workspace close ws-new");
		expect(commands.indexOf("herdr tab close tab-1")).toBeLessThan(
			commands.indexOf("herdr workspace close ws-new"),
		);
		expectNoCommand(commands, "branch -D");
	});

	test("a live start in the checkout's own workspace closes only the tab it created", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-live", checkoutPath: CHECKOUT }]),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-live", "--cwd", CHECKOUT, "--no-focus"],
			{
				stdout: tabCreateJson("pane-1"),
			},
		);
		stubStartFailure(runner, "pane-1");

		const outcome = await handOffTicket(ticket, defaultChoice, {
			claim: "open",
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		const commands = runner.commands();
		expect(commands).toContain("herdr tab close tab-1");
		// The workspace pre-dates the attempt: the operator's own tabs may stand
		// in it, so it stays.
		expectNoCommand(commands, "workspace close");
	});

	test("a stored live start closes the tab it created and keeps the stored workspace", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-stored" }]),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-stored", "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});
		stubStartFailure(runner, "pane-1");

		const outcome = await handOffTicket(ticket, defaultChoice, {
			claim: "continuation",
			config: BASE_CONFIG,
			runner,
			home: HOME,
			previous: { workspaceId: "ws-stored", environment: "live-worktree", tabId: "tab-prev" },
		});

		expect(outcome.status).toBe("failed");
		const commands = runner.commands();
		expect(commands).toContain("herdr tab close tab-1");
		expectNoCommand(commands, "workspace close");
	});

	test("a Consultation start in its fresh workspace closes the workspace it created", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: workspaceCreateJson("ws-new", "pane-c1"),
		});
		stubConsultationStartFailure(runner, "pane-c1");

		const outcome = await handOffConsultation({
			consultation: consultationRecord(),
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		// The Consultation owns this workspace, so its failure takes it down. No
		// tab was created for the Agent, so no tab close runs either.
		const commands = runner.commands();
		expect(commands).toContain("herdr workspace close ws-new");
		expectNoCommand(commands, "tab close");
	});

	test("a Ticket worktree start removes the checkout it created and the branch it created", async () => {
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
		stubStartFailure(runner, "pane-wt");

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		// The worktree kind's row of the same rule: the checkout goes, and so does
		// the branch this start created. The kind creates no tab of its own, so no
		// tab close runs.
		const commands = runner.commands();
		expect(commands).toContain("herdr worktree remove --workspace ws-wt");
		expect(commands).toContain(`git -C ${CHECKOUT} branch -D factory/7-retry-policy-for-webhooks`);
		expectNoCommand(commands, "tab close");
	});

	test("a start whose fresh tab fails to open closes the workspace it created", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: workspaceCreateJson("ws-new"),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-new", "--cwd", CHECKOUT, "--no-focus"],
			{ code: 1, stderr: '{"error":{"code":"tab_create_failed","message":"no pane"}}\n' },
		);

		const outcome = await handOffTicket(ticket, defaultChoice, {
			claim: "open",
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		// The workspace was written into the residue record before the tab was
		// asked for, so a failure at the tab still takes the workspace down.
		const commands = runner.commands();
		expect(commands).toContain("herdr workspace close ws-new");
		expectNoCommand(commands, "tab close");
		expectNoCommand(commands, "agent start");
	});

	test("a worktree open that answers no pane id closes the workspace herdr attached", async () => {
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
			// herdr attached a fresh workspace and answered no root pane.
			{
				stdout: JSON.stringify({
					result: {
						already_open: false,
						workspace: { workspace_id: "ws-wt" },
						tab: { tab_id: "tab-ws-wt" },
						worktree: { path: WORKTREE_PATH },
					},
				}),
			},
		);

		const outcome = await handOffTicket(
			ticket,
			{ ...defaultChoice, environment: "worktree" },
			{
				claim: "open",
				config: BASE_CONFIG,
				runner,
				home: HOME,
			},
		);

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toContain("worktree open returned no pane id");
		// The attached workspace stands in the residue record, so the one cleanup
		// rule takes it down: no start builder closes anything itself.
		const commands = runner.commands();
		expect(commands).toContain("herdr workspace close ws-wt");
		// The branch and the worktree git recorded pre-date the start: they stay.
		expectNoCommand(commands, "worktree remove");
		expectNoCommand(commands, "branch -D");
	});
});

describe("the one start: the Consultation sequence at the handoff interface", () => {
	const CONSULTATION_BRANCH = "factory/consultation-consulta-grill-with-docs";

	/** The resources a Consultation start recorded, in the order it recorded them. */
	function recorder(
		into: string[],
	): (kind: string, resourceId: string, owned: boolean, details?: string) => void {
		return (kind, resourceId, owned, details) => {
			into.push(
				`${kind} ${resourceId}${owned ? "" : " shared"}${details === undefined ? "" : ` ${details}`}`,
			);
		};
	}

	test("a Consultation reuses the checkout's workspace and adds a fresh tab", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-live", checkoutPath: CHECKOUT }]),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-live", "--cwd", CHECKOUT, "--no-focus"],
			{
				stdout: tabCreateJson("pane-c1", "tab-c1"),
			},
		);
		const resources: string[] = [];

		const outcome = await handOffConsultation({
			consultation: consultationRecord(),
			config: BASE_CONFIG,
			runner,
			home: HOME,
			onResource: recorder(resources),
		});

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		const listAt = commands.indexOf("herdr workspace list");
		const tabAt = commands.findIndex((command) => command.startsWith("herdr tab create"));
		const startAt = commands.findIndex((command) => command.startsWith("herdr agent start"));
		const promptAt = commands.findIndex((command) => command.startsWith("herdr agent prompt"));
		expect(listAt).toBeGreaterThan(-1);
		expect(tabAt).toBeGreaterThan(listAt);
		expect(startAt).toBeGreaterThan(tabAt);
		expect(promptAt).toBeGreaterThan(startAt);
		// The workspace the checkout already lives in is never recreated.
		expect(commands.join("\n")).not.toContain("workspace create");
		// The record lands before the next external step, so a failure in the
		// middle of the sequence still shows what might remain in the Close panel.
		expect(resources).toEqual(["tab tab-c1 Consultation tab"]);
	});

	test("a Consultation creates the missing checkout workspace and starts in its root pane", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"], {
			stdout: workspaceCreateJson("ws-new", "pane-c1"),
		});
		const resources: string[] = [];

		const outcome = await handOffConsultation({
			consultation: consultationRecord(),
			config: BASE_CONFIG,
			runner,
			home: HOME,
			onResource: recorder(resources),
		});

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		const listAt = commands.indexOf("herdr workspace list");
		const createAt = commands.findIndex((command) => command.startsWith("herdr workspace create"));
		const startAt = commands.findIndex((command) => command.startsWith("herdr agent start"));
		const promptAt = commands.findIndex((command) => command.startsWith("herdr agent prompt"));
		expect(listAt).toBeGreaterThan(-1);
		expect(createAt).toBeGreaterThan(listAt);
		expect(startAt).toBeGreaterThan(createAt);
		expect(promptAt).toBeGreaterThan(startAt);
		// No empty tab: the Agent takes the root pane of the workspace it owns.
		expect(commands.join("\n")).not.toContain("tab create");
		expect(resources).toEqual([
			"workspace ws-new Consultation workspace",
			"tab tab-ws-new Consultation root tab",
		]);
	});

	test("a Consultation worktree start creates its worktree from the worktree base", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", CONSULTATION_BRANCH], { stdout: "" });
		stubRemoteDefaultBranch(runner);
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				CONSULTATION_BRANCH,
				"--base",
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-cwt", "pane-c1") },
		);
		const resources: string[] = [];

		const outcome = await handOffConsultation({
			consultation: consultationRecord({ environment: "worktree" }),
			config: BASE_CONFIG,
			runner,
			home: HOME,
			onResource: recorder(resources),
		});

		expect(outcome.status).toBe("ok");
		const commands = runner.commands();
		const branchAt = commands.findIndex((command) => command.includes("branch --list"));
		const createAt = commands.findIndex((command) => command.startsWith("herdr worktree create"));
		const startAt = commands.findIndex((command) => command.startsWith("herdr agent start"));
		const promptAt = commands.findIndex((command) => command.startsWith("herdr agent prompt"));
		expect(branchAt).toBeGreaterThan(-1);
		expect(createAt).toBeGreaterThan(branchAt);
		expect(startAt).toBeGreaterThan(createAt);
		expect(promptAt).toBeGreaterThan(startAt);
		expect(commands).toContain(`herdr agent start consultation-11111111 --kind pi --pane pane-c1`);
		expect(resources).toEqual([
			"workspace ws-cwt Consultation worktree workspace",
			"worktree ws-cwt Consultation worktree checkout for factory/consultation-consulta-grill-with-docs",
			"tab tab-ws-cwt Consultation worktree tab",
		]);
	});

	test("a Consultation branch that already exists is refused before any herdr step", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", CONSULTATION_BRANCH], {
			stdout: `  ${CONSULTATION_BRANCH}\n`,
		});

		const outcome = await handOffConsultation({
			consultation: consultationRecord({ environment: "worktree" }),
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		expect(reasonOf(outcome)).toBe(`Consultation branch already exists: ${CONSULTATION_BRANCH}`);
		// The refusal is the branch policy, not a reuse: no worktree is opened on
		// the branch, and nothing is removed.
		expect(runner.commands().join("\n")).not.toContain("herdr");
		expectNoCommand(runner.commands(), "branch -D");
	});

	test("a Consultation worktree start removes the worktree and the branch it created", async () => {
		const runner = new FakeRunner();
		conventionCheckout(runner);
		runner.set("git", ["-C", CHECKOUT, "branch", "--list", CONSULTATION_BRANCH], { stdout: "" });
		stubRemoteDefaultBranch(runner);
		runner.set(
			"herdr",
			[
				"worktree",
				"create",
				"--cwd",
				CHECKOUT,
				"--branch",
				CONSULTATION_BRANCH,
				"--base",
				"origin/main",
				"--no-focus",
			],
			{ stdout: worktreeCreateJson("ws-cwt", "pane-c1") },
		);
		runner.set(
			"herdr",
			["agent", "start", "consultation-11111111", "--kind", "pi", "--pane", "pane-c1"],
			{
				code: 1,
				stderr: '{"error":{"code":"agent_start_failed","message":"the pane is gone"}}\n',
			},
		);

		const outcome = await handOffConsultation({
			consultation: consultationRecord({ environment: "worktree" }),
			config: BASE_CONFIG,
			runner,
			home: HOME,
		});

		expect(outcome.status).toBe("failed");
		// One cleanup rule for every kind: the checkout goes, and so does the
		// branch this start created.
		const commands = runner.commands();
		expect(commands).toContain("herdr worktree remove --workspace ws-cwt");
		expect(commands).toContain(`git -C ${CHECKOUT} branch -D ${CONSULTATION_BRANCH}`);
	});
});
