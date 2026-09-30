/**
 * The plane action's merge (ADR 0068): the merge runs as a plane action,
 * without an agent, a worktree, a herdr pane, or a Parallel limit seat.
 *
 * The suite covers the attempt's record in the state, the action form in the
 * config, the merge run itself through the command runner, the dispatch's
 * ask and pickup (including the open position the top-up asks from), and the
 * surfaces the operator sees: the decision screen's confirm with its
 * unavailable override key, the auto top-up's merge with its blocked
 * outcome, the Handoff limit's count of the attempts, and the Work queue's
 * row and detail for the waiting item.
 *
 * Every test runs against a temporary state with fake sources and a fake
 * command runner: no herdr session, no real `gh`, no live source.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppProps } from "../src/components/app.ts";
import {
	type FactoryConfig,
	type TaskTypeConfig,
	type TransitionOutcome,
	validateConfig,
} from "../src/config.ts";
import type { FetchedTicket, Ticket } from "../src/domain/ticket.ts";
import { resolveHandoffChoice } from "../src/handoff.ts";
import { createHandoffDispatch, type HandoffDispatchReports } from "../src/handoff-dispatch.ts";
import { planeActionSettingOf, runMergePullRequest } from "../src/plane-actions.ts";
import type { CommandOptions, CommandResult } from "../src/runner.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import { firePlaneActionOutcome } from "../src/workflow.ts";
import {
	type AppSetup,
	awaitFrame,
	messageRowOf,
	mouseClick,
	press,
	pressArrow,
	rowsOf,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { agentListJson, FakeRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

// The one repository the fixtures live in, and the pull request the merge
// runs on.
const repoIdentity = "github.com/acme/factory";
const pullIdentity = "github:github.com:P_12";
const pullTitle = "Persist the source facts";

const pullsSource = { name: "pulls", kind: "github-pull-requests" as const };

/** The pull request source's config. */
const pullsConfig = {
	name: "pulls",
	kind: "github-pull-requests" as const,
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
};

/**
 * The config these tests boot on: the base config's types and states, the
 * pull request source, the ready-to-ship position on the pull request, and
 * the merge task type in the action form. The merge's transition writes the
 * needs-work fact when the pull request still reads open - the block's path
 * - and takes the empty facts on the merged one.
 */
const PLANE_TASK_TYPES: Record<string, TaskTypeConfig> = {
	...BASE_CONFIG.taskTypes,
	merge: {
		action: "merge-pull-request",
		method: "squash",
		transition: {
			ticketFacts: [],
			pullRequestFacts: [],
			branches: [
				{ when: "pull-request-open", pullRequestFacts: ["needs-work"] },
				{ pullRequestFacts: [] },
			],
		},
	},
};

const PLANE_WORKFLOW_STATES = [
	...BASE_CONFIG.workflowStates,
	{
		name: "ready-to-ship",
		taskType: "merge",
		match: { sourceKind: "github-pull-request", labelsAny: ["ready-to-ship"] },
	},
];

const PLANE_CONFIG: FactoryConfig = {
	...BASE_CONFIG,
	sources: [pullsConfig],
	workflowStates: PLANE_WORKFLOW_STATES,
	taskTypes: PLANE_TASK_TYPES,
};

/** A fetched ticket of the pulls source: the pull request the merge aims at. */
function pullTicket(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return {
		identity: pullIdentity,
		sourceKind: "github-pull-request",
		externalKey: "#12",
		sourceState: "open",
		url: "https://github.com/acme/factory/pull/12",
		title: pullTitle,
		description: "Keep state independent from GitHub.",
		labels: ["ready-to-ship"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

// The issue the pull request fixes, on the second source the cross-route
// tests boot beside the pulls source.
const issueIdentity = "github:github.com:I_11";
const issueTitle = "Keep state independent from GitHub";

const issuesSource = { name: "issues", kind: "github-issues" as const };

/** The issue source's config, beside the pulls source's. */
const issuesConfig = {
	name: "issues",
	kind: "github-issues" as const,
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
};

/** A fetched ticket of the issues source: the ticket the pull request fixes. */
function issueTicket(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return {
		identity: issueIdentity,
		sourceKind: "github-issue",
		externalKey: "#11",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/11",
		title: issueTitle,
		description: "Keep state independent from GitHub.",
		labels: [],
		externalUpdatedAt: "2026-08-31T09:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

/** The source's success for the issue, the way it stands for the pull request. */
const issueSuccess = (at = new Date(Date.now() - 60_000).toISOString()): FetchOutcome => ({
	status: "success",
	fetchedAt: at,
	tickets: [issueTicket()],
});

/** Boot the state with the issue beside the pull request. */
function withIssueSource(state: FactoryState): void {
	state.initializeSources([pullsSource, issuesSource]);
	state.applyFetch(issuesSource, issueSuccess());
}

/**
 * The source's success for the pull request. The default fetch time is now,
 * the way the live source answers: a test that needs the ticket actionable
 * boots on a fresh fetch, and a stale one is a fact the test names.
 */
const pullSuccess = (at = new Date(Date.now() - 60_000).toISOString()): FetchOutcome => ({
	status: "success",
	fetchedAt: at,
	tickets: [pullTicket()],
});

/** A fresh state with the pull request settled open on its source. */
function planeState(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-plane-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.setGroupingAxis("tickets", "none");
	state.initializeSources([pullsSource]);
	state.applyFetch(pullsSource, pullSuccess());
	return state;
}

// The `gh` commands the merge runs, in the exact order the runner takes them.
const PR_READ_ARGS = ["api", "--hostname", "github.com", "repos/acme/factory/pulls/12"];
const PR_MERGE_ARGS = [
	"pr",
	"merge",
	"#12",
	"--squash",
	"--hostname",
	"github.com",
	"--repo",
	"acme/factory",
];

/** The source's answer that the pull request still reads open. */
function stubOpenRead(runner: FakeRunner): void {
	runner.set("gh", PR_READ_ARGS, { stdout: `{"state":"open"}` });
}

/** The source's answer that the pull request reads merged. */
function stubMergedRead(runner: FakeRunner): void {
	runner.set("gh", PR_READ_ARGS, { stdout: `{"merged":true}` });
}

/** The source's answers in order: the run's fresh read, then the fire's. */
function stubReadSequence(runner: FakeRunner, records: Array<Record<string, unknown>>): void {
	runner.setSequence(
		"gh",
		PR_READ_ARGS,
		records.map((record) => ({ stdout: JSON.stringify(record) })),
	);
}

function stubMerge(runner: FakeRunner, code = 0, stderr = ""): void {
	runner.set("gh", PR_MERGE_ARGS, { code, stderr });
}

/**
 * The transition the seeded turn stored for the awaiting pull request: the
 * machine re-derived the ready-to-ship position on the pull request itself,
 * and the task type the position offers is the merge.
 */
function mergeRoute(over: Partial<TransitionOutcome> = {}): TransitionOutcome {
	return {
		fired: true,
		when: null,
		reason: "",
		ticketFacts: [],
		pullRequestFacts: ["ready-to-ship"],
		autoAdvance: false,
		ticketWrite: null,
		pullRequestWrite: { added: ["ready-to-ship"], removed: [] },
		pullRequestIdentity: pullIdentity,
		pullRequestKey: "#12",
		writeFailure: "",
		positionTaskType: "merge",
		positionTicketIdentity: pullIdentity,
		...over,
	};
}

/** Seed the pull request in the given shape: open, or awaiting with its turn. */
function seed(
	state: FactoryState,
	shape: "open" | "awaiting",
	transition: TransitionOutcome,
): void {
	if (shape === "open") return;
	const claim = state.claimHandoff(
		pullIdentity,
		{
			agentType: "pi",
			environment: "live-worktree",
			taskType: "rework",
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
	state.settleTurn({
		ticketIdentity: pullIdentity,
		handoffId: claim.claim.attemptId,
		taskType: "rework",
		agentType: "pi",
		message: "The turn is done.",
		turnLog: [{ kind: "text", text: "The turn is done." }],
		completedAt: "2026-08-31T11:00:00Z",
		cause: "completed",
		transition,
	});
}

describe("the attempt record in the state", () => {
	test("the attempt lands once, and the outcome's fire writes its fact once", () => {
		const state = planeState();
		const attempt = state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "the source refused the merge",
			at: "2026-08-31T12:00:00Z",
		});
		const latest = state.latestPlaneActionAttempt(pullIdentity);
		expect(latest?.id).toBe(attempt.id);
		expect(latest?.outcome).toBe("blocked");
		expect(latest?.transition).toBeNull();

		const outcome: TransitionOutcome = mergeRoute({
			pullRequestFacts: ["needs-work"],
			pullRequestWrite: { added: ["needs-work"], removed: [] },
		});
		expect(state.recordPlaneActionAttemptOutcome(attempt.id, outcome)).toBe(true);
		// A fire that runs twice writes the fact once: the record is
		// conditional on the fact not standing.
		expect(state.recordPlaneActionAttemptOutcome(attempt.id, outcome)).toBe(false);
		expect(state.latestPlaneActionAttempt(pullIdentity)?.transition?.pullRequestWrite).toEqual({
			added: ["needs-work"],
			removed: [],
		});
		expect(state.planeActionAttempts(pullIdentity)).toHaveLength(1);
		state.close();
	});

	test("the Handoff limit counts the merge attempts beside the handoffs", () => {
		const state = planeState();
		expect(state.handoffCount(pullIdentity)).toBe(0);
		state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: "2026-08-31T12:00:00Z",
		});
		state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "merged",
			outcome: "blocked",
			reason: "the source refused the merge",
			at: "2026-08-31T12:01:00Z",
		});
		expect(state.handoffCount(pullIdentity)).toBe(2);
		state.close();
	});

	test("the queued route settles the ticket to open without a work cycle", () => {
		const state = planeState();
		const before = state.visibleTickets(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType);
		expect(before[0].state).toBe("open");
		expect(before[0].workCycle).toBe(1);

		expect(state.queuePlaneActionRoute(pullIdentity)).toBe(true);
		expect(state.ticketState(pullIdentity)).toBe("queued");

		expect(state.settleQueuedPlaneActionRoute(pullIdentity)).toBe(true);
		const after = state.visibleTickets(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType);
		expect(after[0].state).toBe("open");
		// No work cycle ran for the action: the count never moved.
		expect(after[0].workCycle).toBe(1);
		state.close();
	});
});

describe("the action form in the config", () => {
	const raw = (taskTypes: Record<string, unknown>): Record<string, unknown> => ({
		"state-file": "~/factory/state.sqlite",
		"default-agent": "pi",
		"default-environment": "worktree",
		"default-task-type": "implement",
		agents: { pi: { kind: "pi" } },
		"task-types": { implement: { template: "{title}" }, ...taskTypes },
		sources: [
			{
				name: "pulls",
				kind: "github-pull-requests",
				"refresh-interval-seconds": 30,
				repositories: ["acme/factory"],
			},
		],
	});

	test("the action form validates, and an omitted method takes the registry's default", () => {
		const config = validateConfig(
			raw({ merge: { action: "merge-pull-request", method: "rebase" } }),
		);
		expect(config.taskTypes.merge).toEqual({
			action: "merge-pull-request",
			method: "rebase",
		});
		const defaulted = validateConfig(raw({ merge: { action: "merge-pull-request" } }));
		expect(defaulted.taskTypes.merge).toEqual({
			action: "merge-pull-request",
			method: "squash",
		});
	});

	test("exactly one of template and action is required", () => {
		expect(() =>
			validateConfig(raw({ merge: { template: "{title}", action: "merge-pull-request" } })),
		).toThrow(`task-types.merge: exactly one of "template" or "action" is required`);
		expect(() => validateConfig(raw({ merge: {} }))).toThrow(
			`task-types.merge: exactly one of "template" or "action" is required`,
		);
	});

	test("the action form names the registry's actions and methods, and takes no profile keys", () => {
		expect(() => validateConfig(raw({ merge: { action: "restart-agent" } }))).toThrow(
			`task-types.merge.action: "restart-agent" is not a known plane action (merge-pull-request)`,
		);
		expect(() =>
			validateConfig(raw({ merge: { action: "merge-pull-request", method: "fast-forward" } })),
		).toThrow(
			`task-types.merge.method: "fast-forward" is not a merge method (squash, merge, rebase)`,
		);
		expect(() =>
			validateConfig(raw({ merge: { action: "merge-pull-request", agent: "pi" } })),
		).toThrow(`task-types.merge: unknown key "agent"; the action form takes no profile keys`);
	});

	test("the registry reads the settings back, and an omitted method resolves to squash", () => {
		expect(planeActionSettingOf(PLANE_CONFIG.taskTypes, "merge")).toEqual({
			name: "merge-pull-request",
			method: "squash",
		});
		expect(planeActionSettingOf({ merge: { action: "merge-pull-request" } }, "merge")).toEqual({
			name: "merge-pull-request",
			method: "squash",
		});
		expect(planeActionSettingOf(PLANE_CONFIG.taskTypes, "implement")).toBeNull();
	});
});

describe("the merge run through the command runner", () => {
	/** The pull request as the projection holds it, from a seeded state. */
	function ticketOf(state: FactoryState): Ticket {
		const ticket = state
			.projectedTickets(PLANE_CONFIG.workflowStates, PLANE_CONFIG.defaultTaskType)
			.find((candidate) => candidate.identity === pullIdentity);
		if (ticket === undefined) throw new Error("the pull request is not in the projection");
		return ticket;
	}

	test("the run reads the pull request fresh, merges it, and the merged outcome fires without a write", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);

		const result = await runMergePullRequest({
			runner,
			sources: PLANE_CONFIG.sources,
			pullRequest: ticketOf(state),
			method: "squash",
		});
		expect(result).toEqual({ outcome: "merged", reason: "", alreadyMerged: false });
		expect(runner.commands()).toContain(
			"gh pr merge #12 --squash --hostname github.com --repo acme/factory",
		);

		const attempt = state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: result.outcome,
			reason: result.reason,
			at: "2026-08-31T12:00:00Z",
		});
		const outcome = await firePlaneActionOutcome({
			config: PLANE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			attempt: { id: attempt.id, ticketIdentity: pullIdentity, taskType: "merge" },
		});
		expect(outcome?.fired).toBe(true);
		// The pull request read merged on the fire's fresh read: the
		// pull-request-open branch did not hold, and the fallback wrote no
		// facts, so the fire ran no label command.
		expect(outcome?.pullRequestWrite).toBeNull();
		expect(runner.commands().filter((command) => command.startsWith("gh pr edit"))).toEqual([]);
		expect(state.latestPlaneActionAttempt(pullIdentity)?.transition).not.toBeNull();
		state.close();
	});

	test("a pull request the fresh read finds already merged settles as merged without a command", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		stubMergedRead(runner);

		const result = await runMergePullRequest({
			runner,
			sources: PLANE_CONFIG.sources,
			pullRequest: ticketOf(state),
			method: "squash",
		});
		expect(result).toEqual({ outcome: "merged", reason: "", alreadyMerged: true });
		// Only the fresh read ran: the settle ran no merge command.
		expect(runner.commands()).toEqual(["gh api --hostname github.com repos/acme/factory/pulls/12"]);
		state.close();
	});

	test("a merge the source refuses blocks with the source's reason, and the comment posts before the outcome stands", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		stubOpenRead(runner);
		stubMerge(runner, 1, "GraphQL: PullRequest is not mergeable.\n");

		const result = await runMergePullRequest({
			runner,
			sources: PLANE_CONFIG.sources,
			pullRequest: ticketOf(state),
			method: "squash",
		});
		expect(result).toEqual({
			outcome: "blocked",
			reason: "GraphQL: PullRequest is not mergeable.",
			alreadyMerged: false,
		});
		const commands = runner.commands();
		expect(commands).toContain(
			`gh pr comment #12 --hostname github.com --repo acme/factory --body ` +
				`The factory's merge was blocked: GraphQL: PullRequest is not mergeable.`,
		);
		// The comment posts after the refused merge: the merge's command
		// leads it in the runner's record.
		const mergeAt = commands.findIndex((command) => command.startsWith("gh pr merge"));
		const commentAt = commands.findIndex((command) => command.startsWith("gh pr comment"));
		expect(mergeAt).toBeLessThan(commentAt);
		state.close();
	});

	test("a pull request whose source is not configured blocks without a command", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		const result = await runMergePullRequest({
			runner,
			sources: [{ ...pullsConfig, name: "other" }],
			pullRequest: ticketOf(state),
			method: "squash",
		});
		expect(result).toEqual({
			outcome: "blocked",
			reason: "the pull request's source is not configured",
			alreadyMerged: false,
		});
		expect(runner.commands()).toEqual([]);
		state.close();
	});

	test("the blocked outcome's fire writes the needs-work fact on the pull request", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		// The fire's fresh read: the pull request still reads open, so the
		// pull-request-open branch holds and writes the needs-work fact.
		stubOpenRead(runner);

		const attempt = state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "GraphQL: PullRequest is not mergeable.",
			at: "2026-08-31T12:00:00Z",
		});
		const outcome = await firePlaneActionOutcome({
			config: PLANE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			attempt: { id: attempt.id, ticketIdentity: pullIdentity, taskType: "merge" },
		});
		expect(outcome?.fired).toBe(true);
		expect(outcome?.pullRequestWrite).toEqual({ added: ["needs-work"], removed: [] });
		expect(runner.commands()).toContain(
			"gh pr edit #12 --repo github.com/acme/factory --add-label needs-work",
		);
		expect(state.latestPlaneActionAttempt(pullIdentity)?.transition?.pullRequestWrite).toEqual({
			added: ["needs-work"],
			removed: [],
		});
		state.close();
	});

	test("a blocked fire whose fresh read fails falls back to the projection's open fact", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		// The read fails outright: the fire falls back to the projection's
		// last refresh, which still reads the pull request open.
		runner.set("gh", PR_READ_ARGS, { code: 1, stderr: "the read failed" });

		const attempt = state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "merged",
			outcome: "blocked",
			reason: "the source refused the merge",
			at: "2026-08-31T12:00:00Z",
		});
		const outcome = await firePlaneActionOutcome({
			config: PLANE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			attempt: { id: attempt.id, ticketIdentity: pullIdentity, taskType: "merge" },
		});
		expect(outcome?.fired).toBe(true);
		expect(outcome?.pullRequestWrite).toEqual({ added: ["needs-work"], removed: [] });
		state.close();
	});
});

describe("the dispatch's ask and pickup", () => {
	/** The events the module reports, one string each. */
	function recorder(events: string[]): HandoffDispatchReports {
		return {
			working: (text) => events.push(`working: ${text}`),
			warning: (text) => events.push(`warning: ${text}`),
			error: (text) => events.push(`error: ${text}`),
			notice: (text) => events.push(`notice: ${text}`),
			clearWorking: () => {},
			refresh: () => {},
			starting: () => {},
		};
	}

	function home(): string {
		const dir = mkdtempSync(join(tmpdir(), "factory-plane-home-"));
		paths.push(dir);
		return dir;
	}

	test("the top-up's ask enters the queue, and the pickup runs the merge on the open ticket", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		// The run's fresh read finds the pull request open, the merge lands,
		// and the fire's fresh read finds it merged.
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const events: string[] = [];
		let resolveStarted: () => void = () => {};
		const startedSettled = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => PLANE_CONFIG,
			seatCount: () => 0,
			home: home(),
			...recorder(events),
		});

		const result = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			onStarted: (started) => {
				expect(started).toEqual({ ok: true });
				resolveStarted();
			},
		});
		expect(result).toEqual({ ok: true });
		await startedSettled;

		// The attempt is the durable record: the top-up's decision word, the
		// merged outcome, and the transition fact the fire wrote on it.
		const attempt = state.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("auto-merged");
		expect(attempt?.transition).not.toBeNull();
		// The route settled back to open without a work cycle.
		expect(state.ticketState(pullIdentity)).toBe("open");
		const ticket = state.visibleTickets(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType)[0];
		expect(ticket.workCycle).toBe(1);
		expect(state.workQueue()).toEqual([]);
		expect(events).toContain(`notice: the merge of "${pullTitle}" ran from the Work queue`);
		expect(runner.commands()).toContain(
			"gh pr merge #12 --squash --hostname github.com --repo acme/factory",
		);
		// No agent: the run took no herdr command at all.
		expect(runner.commands().filter((command) => command.startsWith("herdr"))).toEqual([]);
		state.close();
	});

	test("a second ask keeps the first item's place, and the queue pause holds the item standing", async () => {
		const state = planeState();
		state.setQueuePaused(true);
		const runner = new FakeRunner();
		const events: string[] = [];
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => PLANE_CONFIG,
			seatCount: () => 0,
			home: home(),
			...recorder(events),
		});

		const first = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		expect(first).toEqual({ ok: true });
		expect(events).toContain(
			`notice: the merge of "${pullTitle}" waits in the Work queue; the queue is paused`,
		);
		// The item stands: the route took the queued wait, and the second
		// ask refuses with the one-item rule.
		expect(state.ticketState(pullIdentity)).toBe("queued");
		const queue = state.workQueue();
		expect(queue).toHaveLength(1);
		const item = queue[0];
		expect(item.kind).toBe("plane-action");
		if (item.kind === "plane-action") {
			expect(item.ticketIdentity).toBe(pullIdentity);
			expect(item.routeFromIdentity).toBeNull();
			expect(item.automatic).toBe(true);
			expect(item.origin).toBe("open");
			expect(item.taskType).toBe("merge");
		}
		const second = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		expect(second).toEqual({
			ok: false,
			reason: `"${pullTitle}" already has a waiting queue item; the first item keeps its place`,
		});
		// The pause held the pickup: no command ran.
		expect(runner.commands()).toEqual([]);
		state.close();
	});

	test("a ticket that moved on leaves the route stale, and the ask refuses", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		// The ticket moved on: a handoff started on it, so it stands
		// handed-off, and the route is stale.
		const claim = state.claimHandoff(
			pullIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "rework",
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
		const events: string[] = [];
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => PLANE_CONFIG,
			seatCount: () => 0,
			home: home(),
			...recorder(events),
		});
		const result = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		expect(result).toEqual({ ok: false, reason: "the ticket is now handed-off" });
		expect(state.workQueue()).toEqual([]);
		expect(runner.commands()).toEqual([]);
		state.close();
	});

	test("a task type without the action form refuses before the queue", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		const events: string[] = [];
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => PLANE_CONFIG,
			seatCount: () => 0,
			home: home(),
			...recorder(events),
		});
		const result = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "implement",
		});
		expect(result).toEqual({ ok: false, reason: "task type implement carries no plane action" });
		expect(state.workQueue()).toEqual([]);
		state.close();
	});

	test("a pickup under a full Parallel limit still runs the merge", async () => {
		const state = planeState();
		const runner = new FakeRunner();
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const events: string[] = [];
		let resolveStarted: () => void = () => {};
		const startedSettled = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => ({ ...PLANE_CONFIG, maxParallelAgents: 1 }),
			// The limit reads full: the seat is held, and the item still
			// runs, because the plane action takes no seat.
			seatCount: () => 1,
			home: home(),
			...recorder(events),
		});
		const result = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			onStarted: () => resolveStarted(),
		});
		expect(result).toEqual({ ok: true });
		await startedSettled;
		expect(state.latestPlaneActionAttempt(pullIdentity)?.outcome).toBe("merged");
		// The run's own line stands: the pickup did not ask the cap, because
		// the action takes no seat from it.
		expect(events).toContain(`notice: the merge of "${pullTitle}" ran from the Work queue`);
		state.close();
	});

	test("two pickups that read the queue together run the merge once, on the claim", async () => {
		const state = planeState();
		// The pause holds the ask in the queue without the dispatch's own
		// pickup, so the two pickups the test starts read the queue together,
		// before either claims the row.
		state.setQueuePaused(true);
		const runner = new FakeRunner();
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const events: string[] = [];
		let resolveStarted: () => void = () => {};
		const startedSettled = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => PLANE_CONFIG,
			seatCount: () => 0,
			home: home(),
			...recorder(events),
		});
		const result = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			onStarted: (started) => {
				expect(started).toEqual({ ok: true });
				resolveStarted();
			},
		});
		expect(result).toEqual({ ok: true });
		state.setQueuePaused(false);
		await Promise.all([dispatch.pickupWorkQueue(), dispatch.pickupWorkQueue()]);
		await startedSettled;
		// The claim is the row's removal, taken before the run: the second
		// pickup finds no row and leaves, and the run stands once - one merge
		// command, one attempt row for the Handoff limit's count.
		expect(runner.commands().filter((command) => command.startsWith("gh pr merge"))).toHaveLength(
			1,
		);
		expect(state.planeActionAttemptCount(pullIdentity)).toBe(1);
		expect(state.latestPlaneActionAttempt(pullIdentity)?.outcome).toBe("merged");
		expect(state.workQueue()).toEqual([]);
		expect(state.ticketState(pullIdentity)).toBe("open");
		state.close();
	});

	test("a full limit holds the plane item behind a seats-bound item, the way it holds every item", async () => {
		const state = planeState();
		withIssueSource(state);
		const runner = new FakeRunner();
		const events: string[] = [];
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => ({
				...PLANE_CONFIG,
				sources: [pullsConfig, issuesConfig],
				maxParallelAgents: 1,
			}),
			// The limit reads full: the seat is held by the seats-bound item
			// that stands first in the shared order.
			seatCount: () => 1,
			home: home(),
			...recorder(events),
		});
		// The seats-bound item stands first, and a full cap holds it the way
		// it always has: the pickup's walk breaks at it.
		const handoffAsk = await dispatch.dispatch({
			origin: "open",
			automatic: true,
			ticketIdentity: issueIdentity,
			choice: resolveHandoffChoice(
				{ ...PLANE_CONFIG, sources: [pullsConfig, issuesConfig], maxParallelAgents: 1 },
				"rework",
			),
			previousMessage: "",
		});
		expect(handoffAsk).toEqual({ ok: true });
		const result = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		expect(result).toEqual({ ok: true });
		// The walk broke at the held seats-bound item, before it reached the
		// plane item: the item stands behind it in the shared order, with no
		// command run and no attempt recorded, and the route's wait stands.
		const queue = state.workQueue();
		expect(queue).toHaveLength(2);
		expect(queue[0]?.kind).toBe("handoff");
		expect(queue[1]?.kind).toBe("plane-action");
		expect(state.latestPlaneActionAttempt(pullIdentity)).toBeNull();
		expect(runner.commands()).toEqual([]);
		expect(state.ticketState(pullIdentity)).toBe("queued");
		state.close();
	});

	test("a dropped merge settles its route's source, the way the cancel does", async () => {
		const state = planeState();
		withIssueSource(state);
		// The issue stands awaiting with its settled turn: the cross route's
		// source, the way the top-up's continuation ask finds it.
		const claim = state.claimHandoff(
			issueIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "rework",
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
		state.settleTurn({
			ticketIdentity: issueIdentity,
			handoffId: claim.claim.attemptId,
			taskType: "rework",
			agentType: "pi",
			message: "The turn is done.",
			turnLog: [{ kind: "text", text: "The turn is done." }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
			transition: {
				fired: false,
				when: null,
				reason: "",
				ticketFacts: [],
				pullRequestFacts: [],
				autoAdvance: true,
				ticketWrite: null,
				pullRequestWrite: null,
				pullRequestIdentity: null,
				pullRequestKey: null,
				writeFailure: "",
				positionTaskType: "merge",
				positionTicketIdentity: pullIdentity,
			},
		});
		const runner = new FakeRunner();
		const events: string[] = [];
		let config = PLANE_CONFIG;
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => config,
			seatCount: () => 0,
			home: home(),
			...recorder(events),
		});
		state.setQueuePaused(true);
		const result = await dispatch.dispatchPlaneAction({
			origin: "workflow",
			automatic: true,
			ticketIdentity: pullIdentity,
			routeFromIdentity: issueIdentity,
			taskType: "merge",
		});
		expect(result).toEqual({ ok: true });
		// Both waits stand: the item's own ticket took the queued wait, and
		// the decision the ask landed moved the source from awaiting to
		// queued, the way the route's decision does.
		expect(state.ticketState(pullIdentity)).toBe("queued");
		expect(state.ticketState(issueIdentity)).toBe("queued");
		const tickets = state.visibleTickets(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
			"all",
		);
		const issueBefore = tickets.find((t) => t.identity === issueIdentity);
		if (issueBefore === undefined) throw new Error("the issue is not in the read");
		const cycleBefore = issueBefore.workCycle;
		// The pickup drops the item: the task type's action form is gone from
		// the config, and the drop settles both waits it leaves.
		config = { ...PLANE_CONFIG, taskTypes: { ...PLANE_TASK_TYPES, merge: { template: "x" } } };
		state.setQueuePaused(false);
		await dispatch.pickupWorkQueue();
		expect(state.workQueue()).toEqual([]);
		expect(state.latestPlaneActionAttempt(pullIdentity)).toBeNull();
		expect(runner.commands()).toEqual([]);
		// The waits settle: the item's ticket back to open without a work
		// cycle, and the route's source open with its cycle counted once,
		// the way the cancel settles the same row (ADR 0069).
		expect(state.ticketState(pullIdentity)).toBe("open");
		expect(state.ticketState(issueIdentity)).toBe("open");
		const after = state.visibleTickets(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all");
		expect(after.find((t) => t.identity === issueIdentity)?.workCycle).toBe(cycleBefore + 1);
		const pullAfter = after.find((t) => t.identity === pullIdentity);
		expect(pullAfter?.workCycle).toBe(tickets.find((t) => t.identity === pullIdentity)?.workCycle);
		expect(events).toContain(
			`warning: the merge of "${pullTitle}" was not run: task type merge carries no plane action`,
		);
		state.close();
	});

	test("a cross-ticket route that runs to the answer settles its source out of queued", async () => {
		const state = planeState();
		withIssueSource(state);
		// The issue stands awaiting with its settled turn: the cross route's
		// source, the way the top-up's continuation ask finds it.
		const claim = state.claimHandoff(
			issueIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "rework",
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
		state.settleTurn({
			ticketIdentity: issueIdentity,
			handoffId: claim.claim.attemptId,
			taskType: "rework",
			agentType: "pi",
			message: "The turn is done.",
			turnLog: [{ kind: "text", text: "The turn is done." }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
			transition: {
				fired: false,
				when: null,
				reason: "",
				ticketFacts: [],
				pullRequestFacts: [],
				autoAdvance: true,
				ticketWrite: null,
				pullRequestWrite: null,
				pullRequestIdentity: null,
				pullRequestKey: null,
				writeFailure: "",
				positionTaskType: "merge",
				positionTicketIdentity: pullIdentity,
			},
		});
		const ticketsBefore = state.visibleTickets(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
			"all",
		);
		const issueBefore = ticketsBefore.find((t) => t.identity === issueIdentity);
		if (issueBefore === undefined) throw new Error("the issue is not in the read");
		const cycleBefore = issueBefore.workCycle;
		const runner = new FakeRunner();
		// The run's fresh read finds the pull request open, the merge lands,
		// and the fire's fresh read finds it merged.
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const events: string[] = [];
		let resolveStarted: () => void = () => {};
		const startedSettled = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => PLANE_CONFIG,
			seatCount: () => 0,
			home: home(),
			...recorder(events),
		});
		state.setQueuePaused(true);
		const result = await dispatch.dispatchPlaneAction({
			origin: "workflow",
			automatic: true,
			ticketIdentity: pullIdentity,
			routeFromIdentity: issueIdentity,
			taskType: "merge",
			onStarted: (started) => {
				expect(started).toEqual({ ok: true });
				resolveStarted();
			},
		});
		expect(result).toEqual({ ok: true });
		// Both waits stand: the item's own ticket took the queued wait, and
		// the decision the ask landed moved the source from awaiting to
		// queued, the way the route's decision does.
		expect(state.ticketState(pullIdentity)).toBe("queued");
		expect(state.ticketState(issueIdentity)).toBe("queued");
		state.setQueuePaused(false);
		await dispatch.pickupWorkQueue();
		await startedSettled;
		// The run stands: one merge command, one attempt row, and the fire's
		// merged read wrote no facts.
		expect(runner.commands()).toContain(
			"gh pr merge #12 --squash --hostname github.com --repo acme/factory",
		);
		const attempt = state.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("auto-merged");
		expect(state.workQueue()).toEqual([]);
		// The waits settle on the run's answer alike: the item's ticket back
		// to open without a work cycle, and the route's source open with its
		// cycle counted once, the way the drop and the cancel settle the same
		// row (ADR 0069) - so a finished route never leaves its source in the
		// wait with no machine path back.
		expect(state.ticketState(pullIdentity)).toBe("open");
		expect(state.ticketState(issueIdentity)).toBe("open");
		const after = state.visibleTickets(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all");
		expect(after.find((t) => t.identity === issueIdentity)?.workCycle).toBe(cycleBefore + 1);
		expect(after.find((t) => t.identity === pullIdentity)?.workCycle).toBe(
			ticketsBefore.find((t) => t.identity === pullIdentity)?.workCycle,
		);
		expect(events).toContain(`notice: the merge of "${pullTitle}" ran from the Work queue`);
		state.close();
	});
});

/** Whether the merge row stands focused in the decision surface. */
const mergeRowFocused = (frame: string): boolean =>
	rowsOf(frame).some((row) => row.includes("❯") && row.includes("Merge pull request"));

describe("the decision screen's merge", () => {
	/** The props the decision tests boot on: the pull request, seeded. */
	function decisionProps(
		state: FactoryState,
		runner: FakeRunner,
		src: FakeSource,
		extra: Partial<FactoryConfig> = {},
	): AppProps {
		const home = mkdtempSync(join(tmpdir(), "factory-plane-home-"));
		paths.push(home);
		const configPath = join(home, "config.toml");
		writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
		return {
			config: { ...PLANE_CONFIG, ...extra },
			state,
			runner,
			configPath,
			sources: [src],
			pollIntervalMs: 60_000,
		};
	}

	test("the confirm runs the merge with no agent and no worktree, and the record stands", async () => {
		const state = planeState();
		seed(state, "awaiting", mergeRoute());
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const src = new FakeSource("pulls", "github-pull-requests", pullSuccess());
		const props = decisionProps(state, runner, src);

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes(pullTitle.slice(0, 3)), "the row");
				// The decision modal: the merge row stands beside Close and Goto.
				await press(
					setup,
					"return",
					"the decision modal",
					(f) => f.includes("Decision:") && f.includes("Merge pull request"),
				);
				await pressArrow(setup, "down", "the Goto row", () => true);
				await pressArrow(setup, "down", "the merge row's focus", mergeRowFocused);
				// The confirm closes the modal, the way the route's does, and
				// the run's line lands on the Message line.
				await press(setup, "return", "the run's line", (f) =>
					messageRowOf(f).includes(`the merge of "${pullTitle}" ran from the Work queue`),
				);
			},
			WIDTH,
			30,
			props,
		);

		// The record: the operator's decision word, the merged outcome, and
		// the settled turn's decision in the trace.
		const attempt = state.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("merged");
		expect(state.lastCompletion(pullIdentity)?.decision).toBe("merged");
		expect(runner.commands()).toContain(
			"gh pr merge #12 --squash --hostname github.com --repo acme/factory",
		);
		// No agent, no worktree: the run started no herdr command.
		expect(
			runner
				.commands()
				.filter((command) => command.includes("agent start") || command.includes("workspace")),
		).toEqual([]);
		state.close();
	});

	test(
		"the ticket detail shows the latest attempt beside the handoff facts",
		async () => {
			const state = planeState();
			seed(state, "awaiting", mergeRoute());
			const runner = new FakeRunner();
			runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
			// The run's fresh read finds the pull request open, the merge fails, and
			// the fire's fresh read still reads it open: the needs-work branch holds.
			stubReadSequence(runner, [{ state: "open" }, { state: "open" }]);
			stubMerge(runner, 1, "GraphQL: PullRequest is not mergeable.\n");
			const src = new FakeSource("pulls", "github-pull-requests", pullSuccess());
			const props = decisionProps(state, runner, src);

			await withApp(
				async (setup) => {
					await awaitFrame(setup, (f) => f.includes(pullTitle.slice(0, 3)), "the row");
					await press(setup, "return", "the decision modal", (f) =>
						f.includes("Merge pull request"),
					);
					await pressArrow(setup, "down", "the Goto row", () => true);
					await pressArrow(setup, "down", "the merge row's focus", mergeRowFocused);
					// The block keeps the ticket listed, open with the needs-work
					// fact, and the run's line lands on the Message line.
					const frame = await press(setup, "return", "the block's line", (f) =>
						messageRowOf(f).includes(
							`the merge of "${pullTitle}" was blocked: GraphQL: PullRequest is not mergeable.`,
						),
					);
					// The ticket's row: the click lands the cursor on it, and the
					// detail pane stands beside the list.
					const rows = rowsOf(frame);
					const rowIndex = rows.findIndex((row) => row.includes(pullTitle.slice(0, 3)));
					expect(rowIndex).toBeGreaterThanOrEqual(0);
					await mouseClick(setup, 2, rowIndex);
					// The reason wraps at the pane's width, so the wait takes the
					// line's head, and the assertion takes the reason as facts.
					await awaitFrame(
						setup,
						(f) => f.includes("Merge:") && f.includes("blocked - GraphQL: PullRequest"),
						"the attempt's line",
					);
				},
				WIDTH,
				30,
				props,
			);

			// The line the pane painted is the block the run recorded: the record
			// beside the handoff facts names the reason the source gave.
			const attempt = state.latestPlaneActionAttempt(pullIdentity);
			expect(attempt?.outcome).toBe("blocked");
			expect(attempt?.reason).toBe("GraphQL: PullRequest is not mergeable.");
			expect(attempt?.decision).toBe("merged");
			state.close();
		},
		{ timeout: 25_000 },
	);

	test("the override key is unavailable on the merge row, with the reason the catalogue states", async () => {
		const state = planeState();
		seed(state, "awaiting", mergeRoute());
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const src = new FakeSource("pulls", "github-pull-requests", pullSuccess());
		const props = decisionProps(state, runner, src);

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes(pullTitle.slice(0, 3)), "the row");
				await press(setup, "return", "the decision modal", (f) => f.includes("Merge pull request"));
				await pressArrow(setup, "down", "the Goto row", () => true);
				await pressArrow(setup, "down", "the merge row's focus", mergeRowFocused);
				await press(setup, "e", "the unavailable reason", (f) =>
					messageRowOf(f).includes("the plane action holds no settings"),
				);
			},
			WIDTH,
			30,
			props,
		);
		state.close();
	});

	test("a blocked attempt from an earlier turn does not hold the row the newer turn offers", async () => {
		const state = planeState();
		seed(state, "awaiting", mergeRoute());
		// An earlier turn of the ticket already ran the merge, and it was
		// blocked: the attempt stands in the state with an at that predates
		// this turn's completion.
		state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "merged",
			outcome: "blocked",
			reason: "GraphQL: PullRequest is not mergeable.",
			at: "2026-08-31T10:00:00Z",
		});
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const src = new FakeSource("pulls", "github-pull-requests", pullSuccess());
		const props = decisionProps(state, runner, src);

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes(pullTitle.slice(0, 3)), "the row");
				// The decision modal re-stands the merge row for the newer turn,
				// and the earlier block's line does not stand in its place.
				const frame = await press(
					setup,
					"return",
					"the decision modal",
					(f) => f.includes("Decision:") && f.includes("Merge pull request"),
				);
				expect(frame).not.toContain("the merge was blocked");
			},
			WIDTH,
			30,
			props,
		);
		state.close();
	});

	test("the operator's confirm passes the Handoff limit the top-up's ask obeys", async () => {
		const state = planeState();
		seed(state, "awaiting", mergeRoute());
		// The ledger stands full for the ticket: one attempt already recorded
		// and the limit is one, the standing that holds the top-up's ask.
		state.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: "2026-08-31T09:00:00Z",
		});
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const src = new FakeSource("pulls", "github-pull-requests", pullSuccess());
		const props = decisionProps(state, runner, src, { maxHandoffsPerTicket: 1 });

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes(pullTitle.slice(0, 3)), "the row");
				await press(
					setup,
					"return",
					"the decision modal",
					(f) => f.includes("Decision:") && f.includes("Merge pull request"),
				);
				await pressArrow(setup, "down", "the Goto row", () => true);
				await pressArrow(setup, "down", "the merge row's focus", mergeRowFocused);
				// The confirm enters the queue like any start, and the run's
				// line lands on the Message line past the full count.
				await press(setup, "return", "the run's line", (f) =>
					messageRowOf(f).includes(`the merge of "${pullTitle}" ran from the Work queue`),
				);
			},
			WIDTH,
			30,
			props,
		);

		// The confirm passed the full count: the run's attempt stands as the
		// ticket's latest, with the operator's decision word.
		const attempt = state.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("merged");
		state.close();
	});

	test(
		"the outcome stands on the screen where the row stood",
		async () => {
			// A runner that delays the pull request's fresh read, so the window
			// between the attempt's record and the route's settle stands long
			// enough for the decision screen to open on it.
			class SlowReadRunner extends FakeRunner {
				private readonly delayMs: number;

				constructor(delayMs: number) {
					super();
					this.delayMs = delayMs;
				}

				async run(
					command: string,
					args: readonly string[],
					options?: CommandOptions,
				): Promise<CommandResult> {
					if (command === "gh" && args.slice(0, 2).join(" ") === "api --hostname") {
						await new Promise((resolve) => setTimeout(resolve, this.delayMs));
					}
					return super.run(command, args, options);
				}
			}

			const state = planeState();
			seed(state, "awaiting", mergeRoute());
			const runner = new SlowReadRunner(1500);
			runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
			// The run's fresh read finds the pull request open, the merge lands,
			// and the fire's fresh read finds it merged: the run and the fire
			// each take one read, in that order.
			stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
			stubMerge(runner, 0);
			const src = new FakeSource("pulls", "github-pull-requests", pullSuccess());
			const props = decisionProps(state, runner, src);

			await withApp(
				async (setup) => {
					await awaitFrame(setup, (f) => f.includes(pullTitle.slice(0, 3)), "the row");
					// The decision modal: the merge row stands beside Close and Goto.
					await press(
						setup,
						"return",
						"the decision modal",
						(f) => f.includes("Decision:") && f.includes("Merge pull request"),
					);
					await pressArrow(setup, "down", "the Goto row", () => true);
					await pressArrow(setup, "down", "the merge row's focus", mergeRowFocused);
					// The confirm closes the modal: the ticket keeps its decision's
					// wait in queued, and the ask's line stands on the Message line.
					await press(setup, "return", "the ask's line", (f) =>
						messageRowOf(f).includes(`the merge of "${pullTitle}" is in the Work queue`),
					);
					// The attempt stands in the state before the fire's fresh read
					// answers, and the route's settle waits on that read.
					const attemptDeadline = Date.now() + 5000;
					for (;;) {
						if (state.latestPlaneActionAttempt(pullIdentity) !== null) break;
						if (Date.now() >= attemptDeadline)
							throw new Error("the attempt did not stand in the state");
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
					// The decision screen opens again on the queued ticket: the
					// outcome stands where the row stood, and no row waits for a
					// confirm.
					const frame = await press(
						setup,
						"return",
						"the outcome's line",
						(f) => f.includes("Decision:") && f.includes("the merge landed"),
					);
					expect(frame).not.toContain("Merge pull request");
				},
				WIDTH,
				30,
				props,
			);

			// The record stands for the outcome the screen read: the operator's
			// decision word on the merged outcome.
			const attempt = state.latestPlaneActionAttempt(pullIdentity);
			expect(attempt?.outcome).toBe("merged");
			expect(attempt?.decision).toBe("merged");
			state.close();
		},
		{ timeout: 20_000 },
	);
});

describe("the auto top-up merge", () => {
	/** Boot the app in auto mode around a fresh open pull request. */
	async function topUpApp(
		body: (setup: AppSetup) => Promise<void>,
		stub: (runner: FakeRunner) => void,
		extra: Partial<FactoryConfig> = {},
		prep: (state: FactoryState) => void = () => {},
	): Promise<FactoryState> {
		const state = planeState();
		prep(state);
		state.setAutoHandoffMode(true);
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		stub(runner);
		const src = new FakeSource("pulls", "github-pull-requests", pullSuccess());
		const props: AppProps = {
			config: { ...PLANE_CONFIG, ...extra },
			state,
			runner,
			// Fast cycles: the add and the run ride two observation cycles
			// apart, and the wait gives them both room.
			pollIntervalMs: 20,
			configPath: (() => {
				const home = mkdtempSync(join(tmpdir(), "factory-plane-home-"));
				paths.push(home);
				const configPath = join(home, "config.toml");
				writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
				return configPath;
			})(),
			sources: [src],
		};
		await withApp(
			async (setup) => {
				// The poll's in-flight fetch settles to the ticket's facts, so
				// the membership reads healthy and the ticket stands actionable.
				src.settle(pullSuccess());
				await body(setup);
			},
			WIDTH,
			34,
			props,
		);
		return state;
	}

	test("the top-up asks for the merge on the ready position, and it runs without an agent", async () => {
		const state = await topUpApp(
			async (setup) => {
				// The open walk's add and the run's line land on the Message
				// line; the run's line is the one that settles the wait.
				await awaitFrame(
					setup,
					(f) => messageRowOf(f).includes(`the merge of "${pullTitle}" ran from the Work queue`),
					"the run's line",
				);
			},
			(runner) => {
				stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
				stubMerge(runner, 0);
			},
		);

		// The attempt stands with the top-up's decision word.
		const attempt = state.latestPlaneActionAttempt(pullIdentity);
		expect(attempt).not.toBeNull();
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("auto-merged");
		// The route settled back to open without a work cycle.
		expect(state.ticketState(pullIdentity)).toBe("open");
		const ticket = state.visibleTickets(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType)[0];
		expect(ticket.workCycle).toBe(1);
		state.close();
	});

	test("a blocked merge posts its comment, takes the needs-work path, and rings no bell", async () => {
		let bells = 0;
		const bellSpy = spyOn(process.stdout, "write").mockImplementation(((
			chunk: Uint8Array | string,
		) => {
			if (String(chunk).includes("\u0007")) bells += 1;
			return true;
		}) as typeof process.stdout.write);
		try {
			const state = await topUpApp(
				async (setup) => {
					await awaitFrame(
						setup,
						(f) =>
							messageRowOf(f).includes(
								`the merge of "${pullTitle}" was blocked: GraphQL: PullRequest is not mergeable.`,
							),
						"the block's line",
					);
				},
				(runner) => {
					// The run's fresh read finds the pull request open, the
					// merge fails, and the fire's fresh read still reads it
					// open: the needs-work branch holds.
					stubReadSequence(runner, [{ state: "open" }, { state: "open" }]);
					stubMerge(runner, 1, "GraphQL: PullRequest is not mergeable.\n");
				},
			);

			const attempt = state.latestPlaneActionAttempt(pullIdentity);
			expect(attempt?.outcome).toBe("blocked");
			expect(attempt?.reason).toBe("GraphQL: PullRequest is not mergeable.");
			expect(attempt?.decision).toBe("auto-merged");
			expect(attempt?.transition?.pullRequestWrite).toEqual({
				added: ["needs-work"],
				removed: [],
			});
			// The ticket keeps the open state it wore: no cycle ran for it.
			expect(state.ticketState(pullIdentity)).toBe("open");
			state.close();
		} finally {
			bellSpy.mockRestore();
		}
		// No bell: the block stands on the Message line, and the pull
		// request's comment carries the fact to the source.
		expect(bells).toBe(0);
	});

	test("the Handoff limit counts the merge attempts, and a full count holds the top-up", async () => {
		const state = await topUpApp(
			async (setup) => {
				// Let the first observation cycle run, then read the facts.
				await settle(setup);
				await new Promise((resolve) => setTimeout(resolve, 400));
			},
			() => {},
			{ maxHandoffsPerTicket: 1 },
			(s) => {
				// The ledger stands full: one attempt already recorded for
				// the ticket, and the limit is one.
				s.recordPlaneActionAttempt({
					ticketIdentity: pullIdentity,
					taskType: "merge",
					decision: "auto-merged",
					outcome: "merged",
					reason: "",
					at: "2026-08-31T11:00:00Z",
				});
			},
		);

		// The full count held the ask: no item, no attempt but the seed.
		expect(state.workQueue()).toEqual([]);
		expect(state.latestPlaneActionAttempt(pullIdentity)?.at).toBe("2026-08-31T11:00:00Z");
		state.close();
	});

	test("the queue pause holds the merge item standing, and the row and detail name the action", async () => {
		const state = await topUpApp(
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Work") && f.includes("waiting: 1"),
					"the waiting item's count",
				);
				// The row carries the merge's word beside the title.
				const rows = rowsOf(frame);
				expect(
					rows.some((row) => row.includes("merge") && row.includes(pullTitle.slice(0, 3))),
				).toBe(true);
				// The click lands the cursor on the queue row, inside the
				// Work queue's own box.
				const boxTop = rows.findIndex((row) => row.includes("Work queue"));
				const rowIndex = rows
					.slice(boxTop + 1)
					.findIndex((row) => row.includes(pullTitle.slice(0, 3)));
				await mouseClick(setup, 2, boxTop + 1 + rowIndex);
				const detail = await awaitFrame(
					setup,
					(f) => f.includes("Task type: merge"),
					"the item's detail",
				);
				expect(detail).toContain("Origin: merge");
				expect(detail).toContain("Method: squash");
				expect(detail).toContain("The action holds no settings to edit");
				expect(detail).toContain("Asked by: the factory's auto top-up");
			},
			() => {},
			{},
			(s) => {
				// The pause holds the pickup, and the item the test stages
				// stands in the queue for the surfaces the body reads.
				s.setQueuePaused(true);
				expect(
					s.enqueuePlaneActionWork({
						ticketIdentity: pullIdentity,
						origin: "open",
						automatic: true,
						taskType: "merge",
					}),
				).toEqual({ ok: true });
			},
		);
		// The pause held the pickup: no command ran on the item.
		expect(state.latestPlaneActionAttempt(pullIdentity)).toBeNull();
		state.close();
	});

	test("the Dispatch pause holds the automatic merge add, and the release runs it", async () => {
		let failedHandoffId = "";
		let held: FactoryState;
		const state = await topUpApp(
			async (setup) => {
				// Cycles run with the pause held: the held failed trace stops
				// the top-up before the walks, so the open walk's merge add
				// never asks and the queue stays empty, the hold standing on
				// the Message line in the warning voice.
				await settle(setup);
				await new Promise((resolve) => setTimeout(resolve, 400));
				expect(held.dispatchPauseActive()).toBe(true);
				expect(held.workQueue()).toEqual([]);
				expect(held.latestPlaneActionAttempt(pullIdentity)).toBeNull();
				expect(messageRowOf(setup.captureCharFrame())).toContain("Dispatch pause");
				// The release: the decision on the held failed trace ends the
				// pause, and the next cycle's open walk adds and runs the merge,
				// the way the unheld run does. The released ticket's source is
				// stale behind its cycle end, so the re-verify gate holds it out
				// of the same walk that adds the merge.
				held.applyCompletionDecision({
					ticketIdentity: issueIdentity,
					handoffId: failedHandoffId,
					decision: "closed",
					decidedAt: new Date().toISOString(),
				});
				await awaitFrame(
					setup,
					() => held.latestPlaneActionAttempt(pullIdentity)?.outcome === "merged",
					"the merge run",
				);
			},
			(runner) => {
				stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
				stubMerge(runner, 0);
			},
			{},
			(s) => {
				held = s;
				// The pause comes from the issue's held failed turn, beside the
				// open pull request the merge add would run on.
				withIssueSource(s);
				const claim = s.claimHandoff(
					issueIdentity,
					{
						agentType: "pi",
						environment: "live-worktree",
						taskType: "rework",
						model: "",
						thinking: "",
						contextWindow: "",
					},
					"open",
				);
				if (!claim.ok) throw new Error(claim.reason);
				s.settleHandoff(claim.claim.attemptId, true, undefined, {
					paneId: "pane-2",
					tabId: "tab-2",
					workspaceId: "ws-2",
				});
				s.settleTurn({
					ticketIdentity: issueIdentity,
					handoffId: claim.claim.attemptId,
					taskType: "rework",
					agentType: "pi",
					message: "The turn failed.",
					turnLog: [{ kind: "text", text: "The turn failed." }],
					completedAt: "2026-08-31T11:00:00Z",
					cause: "failed",
				});
				failedHandoffId = claim.claim.attemptId;
			},
		);

		// The release let the add through: the attempt stands with the
		// top-up's decision word, the way the unheld run records it.
		const attempt = state.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("auto-merged");
		expect(state.dispatchPauseActive()).toBe(false);
		state.close();
	});
});
