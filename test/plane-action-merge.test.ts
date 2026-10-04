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
import { withIssueReferences } from "../src/domain/ticket.ts";
import { resolveHandoffChoice } from "../src/handoff.ts";
import { createHandoffDispatch, type HandoffDispatchReports } from "../src/handoff-dispatch.ts";
import { planeActionSettingOf } from "../src/plane-action-registry.ts";
import { runMergePullRequest } from "../src/plane-actions.ts";
import type { CommandOptions, CommandResult } from "../src/runner.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import { createTicketSource, type FetchOutcome, SEARCH_QUERY } from "../src/ticket-source.ts";
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
import { recordLogger } from "./record-logger.ts";

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
	state.sourceFact.initializeSources([pullsSource, issuesSource]);
	state.sourceFact.applyFetch(issuesSource, issueSuccess());
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

/**
 * The pull request's success with its closing reference to the issue: the
 * reference is a source fact on the membership, and the merge closes the
 * issue on GitHub when it lands.
 */
const pullClosingIssueSuccess = (
	at = new Date(Date.now() - 60_000).toISOString(),
): FetchOutcome => ({
	status: "success",
	fetchedAt: at,
	tickets: [
		pullTicket({
			attributes: withIssueReferences({}, [
				{ identity: issueIdentity, number: 11, repository: "acme/factory" },
			]),
		}),
	],
});

/** A fresh state with the pull request settled open on its source. */
function planeState(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-plane-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.grouping.setGroupingAxis("tickets", "none");
	state.sourceFact.initializeSources([pullsSource]);
	state.sourceFact.applyFetch(pullsSource, pullSuccess());
	return state;
}

// The `gh` commands the merge runs, in the exact order the runner takes them.
const PR_READ_ARGS = ["api", "--hostname", "github.com", "repos/acme/factory/pulls/12"];
// The host rides in the repository identity: `gh pr merge` maps no
// `--hostname`, and the identity is the form its `--repo` takes.
const PR_MERGE_ARGS = ["pr", "merge", "#12", "--squash", "--repo", repoIdentity];
// The outcome fire's label write on the pull request, in the fire's exact
// argument order: the branch's facts over the projection's labels.
const PR_EDIT_ARGS = ["pr", "edit", "#12", "--repo", repoIdentity, "--add-label", "needs-work"];

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
	const claim = state.handoff.claimHandoff(
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
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	state.ticketWorkCycle.settleTurn({
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
		const attempt = state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "the source refused the merge",
			at: "2026-08-31T12:00:00Z",
		});
		const latest = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(latest?.id).toBe(attempt.id);
		expect(latest?.outcome).toBe("blocked");
		expect(latest?.transition).toBeNull();

		const outcome: TransitionOutcome = mergeRoute({
			pullRequestFacts: ["needs-work"],
			pullRequestWrite: { added: ["needs-work"], removed: [] },
		});
		expect(state.planeAction.recordPlaneActionAttemptOutcome(attempt.id, outcome)).toBe(true);
		// A fire that runs twice writes the fact once: the record is
		// conditional on the fact not standing.
		expect(state.planeAction.recordPlaneActionAttemptOutcome(attempt.id, outcome)).toBe(false);
		expect(
			state.planeAction.latestPlaneActionAttempt(pullIdentity)?.transition?.pullRequestWrite,
		).toEqual({
			added: ["needs-work"],
			removed: [],
		});
		expect(state.planeAction.planeActionAttemptCount(pullIdentity)).toBe(1);
		state.close();
	});

	test("the Handoff limit counts the merge attempts beside the handoffs", () => {
		const state = planeState();
		expect(state.handoff.handoffCount(pullIdentity)).toBe(0);
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: "2026-08-31T12:00:00Z",
		});
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "merged",
			outcome: "blocked",
			reason: "the source refused the merge",
			at: "2026-08-31T12:01:00Z",
		});
		expect(state.handoff.handoffCount(pullIdentity)).toBe(2);
		state.close();
	});

	test("the blocked attempt's hold stands until the source re-reads the ticket", () => {
		const state = planeState();
		// The base state's fetch landed a moment ago, so the attempts stand
		// after it: the times offset from now the way the live source answers.
		const base = Date.now();
		const at1 = new Date(base + 60_000).toISOString();
		const at2 = new Date(base + 120_000).toISOString();
		const reread = new Date(base + 180_000).toISOString();
		// No attempt: the hold answers clear.
		expect(state.planeAction.planeActionBlockedUnrefreshed(pullIdentity)).toBe(false);
		// A merged attempt answers clear beside it: the hold is the block's.
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: at1,
		});
		expect(state.planeAction.planeActionBlockedUnrefreshed(pullIdentity)).toBe(false);
		// The blocked attempt that posts the source's last read: the hold stands.
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "GraphQL: PullRequest is not mergeable.",
			at: at2,
		});
		expect(state.planeAction.planeActionBlockedUnrefreshed(pullIdentity)).toBe(true);
		// A merged attempt that posts the block lifts the hold on the newest row.
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: reread,
		});
		expect(state.planeAction.planeActionBlockedUnrefreshed(pullIdentity)).toBe(false);
		// The blocked attempt again, and the re-read that posts it: the hold lifts.
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: pullIdentity,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "GraphQL: PullRequest is not mergeable.",
			at: reread,
		});
		expect(state.planeAction.planeActionBlockedUnrefreshed(pullIdentity)).toBe(true);
		state.sourceFact.applyFetch(pullsSource, pullSuccess(reread));
		expect(state.planeAction.planeActionBlockedUnrefreshed(pullIdentity)).toBe(false);
		state.close();
	});

	test("the fire's convergence lands the written labels on the newest membership", () => {
		const state = planeState();
		const ticketOf = () =>
			state.ticketWorkCycle
				.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all")
				.rows.find((candidate) => candidate.identity === pullIdentity);
		expect(ticketOf()?.labels).toEqual(["ready-to-ship"]);
		// The write's answer lands on the projection at once, and the
		// position the machine derives stands on it: needs-work offers the
		// rework, not the merge the block moved off.
		state.sourceFact.convergeMembershipLabels(pullIdentity, ["needs-work"]);
		const after = ticketOf();
		expect(after?.labels).toEqual(["needs-work"]);
		expect(after?.suggestedTaskType).toBe("rework");
		// A ticket no source lists answers nothing: the draft the machine
		// just made ready is not listed yet, and there is no row for the
		// write to land on.
		state.sourceFact.convergeMembershipLabels("github:github.com:P_999", ["no-listing"]);
		expect(
			state.ticketWorkCycle
				.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all")
				.rows.find((candidate) => candidate.identity === "github:github.com:P_999"),
		).toBeUndefined();
		state.close();
	});

	test("the merge's decision ends the settled turn's cycle, the way the route's does (ADR 0072)", () => {
		const state = planeState();
		withIssueSource(state);
		const claim = state.handoff.claimHandoff(
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
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
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
				ticketWrite: null,
				pullRequestWrite: null,
				pullRequestIdentity: null,
				pullRequestKey: null,
				writeFailure: "",
				positionTaskType: "merge",
				positionTicketIdentity: pullIdentity,
			},
		});
		expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("awaiting");
		// The merge's ask records the decision on the settled turn, and the
		// cycle ends in the same write, the way the route's ask does: the
		// wait stands on the item, not on a ticket state.
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: issueIdentity,
				handoffId: claim.claim.attemptId,
				decision: "auto-merged",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("open");
		const ticket = state.ticketWorkCycle
			.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all")
			.rows.find((candidate) => candidate.identity === issueIdentity);
		expect(ticket?.workCycle).toBe(2);
		expect(state.ticketWorkCycle.lastCompletion(issueIdentity)?.decision).toBe("auto-merged");
		state.close();
	});

	test("the merged ticket's retirement leaves it from the projection at once", () => {
		const state = planeState();
		withIssueSource(state);
		const before = state.ticketWorkCycle.ticketListViews(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
		).rows;
		expect(before.map((ticket) => ticket.identity).sort()).toEqual(
			[issueIdentity, pullIdentity].sort(),
		);
		// The retirement is the source's own move, done now: the source stops
		// returning the pull request at its next refresh.
		expect(state.sourceFact.retireTicket(pullIdentity)).toBe(true);
		const after = state.ticketWorkCycle.ticketListViews(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
		).rows;
		expect(after.map((ticket) => ticket.identity)).toEqual([issueIdentity]);
		// The issue the pull request closes retires with it, and an identity
		// that already retired leaves no write behind.
		expect(state.sourceFact.retireTicket(issueIdentity)).toBe(true);
		expect(
			state.ticketWorkCycle.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType)
				.rows,
		).toEqual([]);
		expect(state.sourceFact.retireTicket(issueIdentity)).toBe(false);
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
		const ticket = state.ticketWorkCycle
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
		expect(runner.commands()).toContain("gh pr merge #12 --squash --repo github.com/acme/factory");

		const attempt = state.planeAction.recordPlaneActionAttempt({
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
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)?.transition).not.toBeNull();
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
			`gh pr comment #12 --repo github.com/acme/factory --body ` +
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

		const attempt = state.planeAction.recordPlaneActionAttempt({
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
		expect(
			state.planeAction.latestPlaneActionAttempt(pullIdentity)?.transition?.pullRequestWrite,
		).toEqual({
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

		const attempt = state.planeAction.recordPlaneActionAttempt({
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
			starting: (identity, active) => events.push(`starting ${active ? "on" : "off"}: ${identity}`),
		};
	}

	function home(): string {
		const dir = mkdtempSync(join(tmpdir(), "factory-plane-home-"));
		paths.push(dir);
		return dir;
	}

	/**
	 * One merge ask through the module, with the record's lines kept: the ask's
	 * `automatic` mark decides whether the start line names the pickup or the
	 * operator's direct ask (issue #209).
	 */
	async function mergeAskLines(automatic: boolean): Promise<string[]> {
		const state = planeState();
		const runner = new FakeRunner();
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const lines: string[] = [];
		const events: string[] = [];
		let resolveStarted: () => void = () => {};
		const startedSettled = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => PLANE_CONFIG,
			// One seat held of the limit two: the reading the start line states.
			seatCount: () => 1,
			home: home(),
			log: recordLogger(lines),
			...recorder(events),
		});
		const result = await dispatch.dispatchPlaneAction({
			origin: "open",
			automatic,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			onStarted: (started) => {
				expect(started).toEqual({ ok: true });
				resolveStarted();
			},
		});
		expect(result).toEqual({ ok: true });
		await startedSettled;
		state.close();
		return lines;
	}

	test("the merge's start line names its mode, its origin, and its seat reading", async () => {
		// The factory's ask: the pickup's walk ran the merge, so the line names
		// the pickup (issue #209).
		expect(await mergeAskLines(true)).toEqual([
			`merge queued: "${pullTitle}" (origin open)`,
			`merge started: "${pullTitle}" (mode pickup, origin open, seats 1/2)`,
		]);
	});

	test("the operator's merge ask names the direct ask on its start line", async () => {
		// The operator's ask, with a free seat: the ask's own pass ran the merge,
		// so the line names the direct ask, not the pickup.
		expect(await mergeAskLines(false)).toEqual([
			`merge queued: "${pullTitle}" (origin open)`,
			`merge started: "${pullTitle}" (mode direct-ask, origin open, seats 1/2)`,
		]);
	});

	test("the force-dispatch of a waiting merge names its mode on the start line", async () => {
		// The queue pause holds the ask in the queue, so the row waits, and the
		// operator's key on that row starts it (issue #209). The cap reads full
		// and the action takes no seat (ADR 0068), so `seats 1/1` here is the
		// count the plane stood on at the start, not a cap breach.
		const state = planeState();
		state.workQueue.setQueuePaused(true);
		const runner = new FakeRunner();
		stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
		stubMerge(runner, 0);
		const lines: string[] = [];
		const events: string[] = [];
		let resolveStarted: () => void = () => {};
		const startedSettled = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const dispatch = createHandoffDispatch({
			state,
			runner,
			config: () => ({ ...PLANE_CONFIG, maxParallelAgents: 1 }),
			seatCount: () => 1,
			home: home(),
			log: recordLogger(lines),
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
		expect(state.workQueue.items()).toHaveLength(1);
		state.workQueue.setQueuePaused(false);
		dispatch.forceDispatchWorkQueueItem(pullIdentity);
		await startedSettled;
		expect(lines).toEqual([
			`merge queued: "${pullTitle}" (origin open)`,
			`merge started: "${pullTitle}" (mode force-dispatch, origin open, seats 1/1)`,
		]);
		state.close();
	});

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
		const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("auto-merged");
		expect(attempt?.transition).not.toBeNull();
		// The position kept the state it wears: the top-up's ask on the open
		// ticket moves no state, and the merged pull request left the
		// projection the moment the run settled: its membership retired now,
		// the way the source's next refresh would do.
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		expect(
			state.ticketWorkCycle
				.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType)
				.rows.find((candidate) => candidate.identity === pullIdentity),
		).toBeUndefined();
		expect(state.workQueue.items()).toEqual([]);
		expect(events).toContain(`notice: the merge of "${pullTitle}" ran from the Work queue`);
		expect(runner.commands()).toContain("gh pr merge #12 --squash --repo github.com/acme/factory");
		// The run wore the start's spinner face on the ticket's row: the
		// Starting window opened before the run and closed behind the settle.
		const onAt = events.indexOf(`starting on: ${pullIdentity}`);
		const offAt = events.indexOf(`starting off: ${pullIdentity}`);
		expect(onAt).toBeGreaterThanOrEqual(0);
		expect(offAt).toBeGreaterThan(onAt);
		// No agent: the run took no herdr command at all.
		expect(runner.commands().filter((command) => command.startsWith("herdr"))).toEqual([]);
		state.close();
	});

	test("the lagged refresh that still lists the merged pull request leaves it retired", async () => {
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

		// The GitHub search index lags the merge: the next refresh still
		// answers the pull request on the open search, in the state
		// `MERGED`, with the labels the index still held. The source drops
		// the node, the way it drops the blocked one, and the retirement
		// the pickup ran stands: the ticket does not reappear in the list.
		const lagRunner = new FakeRunner();
		const lagNode = {
			__typename: "PullRequest",
			id: "P_12",
			number: 12,
			title: pullTitle,
			body: null,
			url: "https://github.com/acme/factory/pull/12",
			state: "MERGED",
			updatedAt: new Date(Date.now() + 60_000).toISOString(),
			isDraft: false,
			headRefName: "feature/top-up",
			labels: { nodes: [{ name: "ready-to-ship" }] },
			repository: {
				name: "factory",
				nameWithOwner: "acme/factory",
				url: "https://github.com/acme/factory",
			},
		};
		const lagPage = JSON.stringify({
			data: {
				search: {
					issueCount: 1,
					pageInfo: { hasNextPage: false },
					nodes: [lagNode],
				},
			},
		});
		const graphqlArgs = (searchQuery: string): string[] => [
			"api",
			"graphql",
			"--hostname",
			"github.com",
			"-f",
			`query=${SEARCH_QUERY}`,
			"-f",
			`searchQuery=${searchQuery}`,
		];
		lagRunner.set(
			"gh",
			graphqlArgs("is:open is:pr repo:acme/factory -label:blocked label:needs-work"),
			{ stdout: lagPage },
		);
		lagRunner.set("gh", graphqlArgs("is:open is:pr repo:acme/factory -label:blocked no:draft"), {
			stdout: lagPage,
		});
		const outcome = await createTicketSource(pullsConfig, lagRunner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		state.sourceFact.applyFetch(pullsSource, outcome);
		expect(
			state.ticketWorkCycle
				.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all")
				.rows.find((candidate) => candidate.identity === pullIdentity),
		).toBeUndefined();
		state.close();
	});

	test("a dispatch on a plane action's task type crosses the plane action's channel", async () => {
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

		// The ask enters through the handoff's own seam: the ticket list's
		// start, with the merge's task type on its choice.
		const result = await dispatch.dispatch({
			origin: "open",
			ticketIdentity: pullIdentity,
			choice: {
				agentType: "pi",
				environment: "worktree",
				taskType: "merge",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			previousMessage: "",
			onStarted: (started) => {
				expect(started).toEqual({ ok: true });
				resolveStarted();
			},
		});
		expect(result).toEqual({ ok: true });
		await startedSettled;

		// The ask crossed the plane action's channel: its attempt record
		// holds the merged outcome, the queue is clear, and no handoff item
		// ever stood on it.
		const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).not.toBeNull();
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		expect(state.workQueue.items()).toEqual([]);
		// The merge command carries no `--hostname`: the host rides in the
		// repository identity its `--repo` takes.
		expect(runner.commands()).toContain("gh pr merge #12 --squash --repo github.com/acme/factory");
		// No agent: the run took no herdr command at all.
		expect(runner.commands().filter((command) => command.startsWith("herdr"))).toEqual([]);
		state.close();
	});

	test("a second ask keeps the first item's place, and the queue pause holds the item standing", async () => {
		const state = planeState();
		state.workQueue.setQueuePaused(true);
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
		// The item stands behind the pause, and the position keeps the state
		// it wears (ADR 0072), so the second ask refuses with the one-item
		// rule.
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		const queue = state.workQueue.items();
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
		const claim = state.handoff.claimHandoff(
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
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
		expect(state.workQueue.items()).toEqual([]);
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
		expect(state.workQueue.items()).toEqual([]);
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
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)?.outcome).toBe("merged");
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
		state.workQueue.setQueuePaused(true);
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
		state.workQueue.setQueuePaused(false);
		await Promise.all([dispatch.pickupWorkQueue(), dispatch.pickupWorkQueue()]);
		await startedSettled;
		// The claim is the row's removal, taken before the run: the second
		// pickup finds no row and leaves, and the run stands once - one merge
		// command, one attempt row for the Handoff limit's count.
		expect(runner.commands().filter((command) => command.startsWith("gh pr merge"))).toHaveLength(
			1,
		);
		expect(state.planeAction.planeActionAttemptCount(pullIdentity)).toBe(1);
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)?.outcome).toBe("merged");
		expect(state.workQueue.items()).toEqual([]);
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		state.close();
	});

	test("an ask that arrives after the claim runs the merge once", async () => {
		// The window the live log shows: the settled turn's ask enqueues the row,
		// the pickup's claim removes it, and the `gh pr merge` command runs for
		// seconds. A second ask in that window finds no standing row, so it must
		// not stand for a second run of the same merge.
		const state = planeState();
		const runner = new FakeRunner();
		// Every read answers open: the way the source answers while the first
		// merge is still landing, so the run's fresh read cannot tell the two.
		stubOpenRead(runner);
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
		const first = await dispatch.dispatchPlaneAction({
			origin: "workflow",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			onStarted: (started) => {
				expect(started).toEqual({ ok: true });
				resolveStarted();
			},
		});
		expect(first).toEqual({ ok: true });
		// The claim took the row before the run: the queue holds nothing while the
		// merge command is still out.
		expect(state.workQueue.items()).toEqual([]);
		const second = await dispatch.dispatchPlaneAction({
			origin: "workflow",
			automatic: true,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		await startedSettled;
		// The merge stands once: one command, one attempt row, and the second ask
		// is a refusal that states the run already stands.
		expect(runner.commands().filter((command) => command.startsWith("gh pr merge"))).toHaveLength(
			1,
		);
		expect(state.planeAction.planeActionAttemptCount(pullIdentity)).toBe(1);
		expect(second).toEqual({
			ok: false,
			reason: `"${pullTitle}" already has a merge running; the first run stands`,
		});
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
		const queue = state.workQueue.items();
		expect(queue).toHaveLength(2);
		expect(queue[0]?.kind).toBe("handoff");
		expect(queue[1]?.kind).toBe("plane-action");
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)).toBeNull();
		expect(runner.commands()).toEqual([]);
		// The item stands behind the held seats, and the position keeps the
		// state it wears (ADR 0072).
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		state.close();
	});

	test("a merged pull request on the cross route leaves the projection with the issue it fixes", async () => {
		const state = planeState();
		withIssueSource(state);
		// The pull request closes the issue on the merge: the closing
		// reference is a source fact on the pull request's membership.
		state.sourceFact.applyFetch(pullsSource, pullClosingIssueSuccess());
		// The issue stands awaiting with its settled turn: the cross route's
		// source, the way the top-up's continuation ask finds it.
		const claim = state.handoff.claimHandoff(
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
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: issueIdentity,
			handoffId: claim.claim.attemptId,
			taskType: "rework",
			agentType: "pi",
			message: "The turn is done.",
			turnLog: [{ kind: "text", text: "The turn is done." }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
			transition: mergeRoute(),
		});
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

		// While the pull request stands open, the issue rests behind it: the
		// list rule withholds a ticket its open fixing pull request covers,
		// and the row the operator sees is the pull request's alone.
		// The issue stands awaiting with its settled turn: the await is never
		// covered, so the issue's row stands beside the pull request's while
		// the merge waits. The ask ends the wait, and the issue rests open
		// behind the open pull request it is fixed by: the list rule withholds
		// it while the merge runs, and the merge's retirement leaves it with
		// the pull request, so it does not stand again behind it.
		const listed = state.ticketWorkCycle.ticketListViews(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
		).rows;
		expect(listed.map((ticket) => ticket.identity).sort()).toEqual(
			[issueIdentity, pullIdentity].sort(),
		);
		expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("awaiting");

		// The route's ask: the issue's settled turn offers the merge of the
		// pull request it fixes.
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
		await startedSettled;

		// The merged pull request left the projection the moment the run
		// settled, and so did the issue it closed on the merge: the sources
		// stop returning both at the next refresh, and the retirement does it
		// now (ADR 0068).
		const after = state.ticketWorkCycle.ticketListViews(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
		).rows;
		expect(after.find((candidate) => candidate.identity === pullIdentity)).toBeUndefined();
		expect(after.find((candidate) => candidate.identity === issueIdentity)).toBeUndefined();
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)?.outcome).toBe("merged");
		state.close();
	});

	test(
		"the decision screen's merge ask closes the settled turn's environment at the ask",
		async () => {
			const state = planeState();
			withIssueSource(state);
			// The issue's settled turn stored its environment: the environment
			// the decision screen's ask asks to close, the way the route's ask
			// does (ADR 0046).
			const claim = state.handoff.claimHandoff(
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
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			state.ticketWorkCycle.settleTurn({
				ticketIdentity: issueIdentity,
				handoffId: claim.claim.attemptId,
				taskType: "rework",
				agentType: "pi",
				message: "The turn is done.",
				turnLog: [{ kind: "text", text: "The turn is done." }],
				completedAt: "2026-08-31T11:00:00Z",
				cause: "completed",
				transition: mergeRoute(),
			});
			const runner = new FakeRunner();
			stubReadSequence(runner, [{ state: "open" }, { merged: true }]);
			stubMerge(runner, 0);
			const events: string[] = [];
			const dispatch = createHandoffDispatch({
				state,
				runner,
				config: () => PLANE_CONFIG,
				seatCount: () => 0,
				home: home(),
				...recorder(events),
			});
			// The operator's ask: no `automatic` word, the way the decision
			// screen's confirm dispatches it.
			const result = await dispatch.dispatchPlaneAction({
				origin: "workflow",
				ticketIdentity: pullIdentity,
				routeFromIdentity: issueIdentity,
				taskType: "merge",
			});
			expect(result).toEqual({ ok: true });
			// The close takes the seat, the way every environment change does,
			// so it lands behind the ask's answer, on the cleanup's own pass.
			const deadline = Date.now() + 5000;
			while (
				!runner.commands().includes("herdr tab close tab-1") ||
				!events.some((event) => event.startsWith(`starting off: ${pullIdentity}`))
			) {
				// The Starting window's close stands behind the run's whole
				// settle: the state's writes are all in when it lands, and the
				// state may close behind it.
				if (Date.now() >= deadline) throw new Error("the ask did not settle");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			state.close();
		},
		{ timeout: 15_000 },
	);

	test(
		"the automatic merge ask closes the settled turn's environment, the way the confirm does",
		async () => {
			const state = planeState();
			withIssueSource(state);
			// The settled turn ran in the shipped machine's own environment: the
			// worktree environment, so herdr holds a workspace the merge must take
			// down.
			const claim = state.handoff.claimHandoff(
				issueIdentity,
				{
					agentType: "pi",
					environment: "worktree",
					taskType: "review",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				"open",
			);
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			state.ticketWorkCycle.settleTurn({
				ticketIdentity: issueIdentity,
				handoffId: claim.claim.attemptId,
				taskType: "review",
				agentType: "pi",
				message: "Score: 95 / 100.",
				turnLog: [{ kind: "text", text: "Score: 95 / 100." }],
				completedAt: "2026-08-31T11:00:00Z",
				cause: "completed",
				transition: mergeRoute(),
			});
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
			await startedSettled;
			// The close takes the seat, the way every environment change does, so
			// it lands behind the ask's answer on the cleanup's own pass, and the
			// merge run stands beside it.
			const deadline = Date.now() + 5000;
			while (!runner.commands().includes("herdr workspace close ws-1")) {
				if (Date.now() >= deadline) throw new Error("the ask never closed the environment");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			// The merge still ran, and the close is the ask's whole act on the
			// environment: the workspace goes, the checkout and the branch stay,
			// and no other herdr command stands.
			expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)?.outcome).toBe("merged");
			expect(runner.commands().filter((command) => command.startsWith("herdr"))).toEqual([
				"herdr workspace close ws-1",
			]);
			state.close();
		},
		{ timeout: 15_000 },
	);

	test("a dropped merge settles its route's source, the way the cancel does", async () => {
		const state = planeState();
		withIssueSource(state);
		// The issue stands awaiting with its settled turn: the cross route's
		// source, the way the top-up's continuation ask finds it.
		const claim = state.handoff.claimHandoff(
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
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
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
		state.workQueue.setQueuePaused(true);
		const result = await dispatch.dispatchPlaneAction({
			origin: "workflow",
			automatic: true,
			ticketIdentity: pullIdentity,
			routeFromIdentity: issueIdentity,
			taskType: "merge",
		});
		expect(result).toEqual({ ok: true });
		// Both waits stand: the ask ended the source's cycle with the decision
		// it landed (ADR 0072), the way the route's decision does, and the
		// item's own ticket keeps the state it wears.
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("open");
		const tickets = state.ticketWorkCycle.ticketListViews(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
			"all",
		).rows;
		const issueBefore = tickets.find((t) => t.identity === issueIdentity);
		if (issueBefore === undefined) throw new Error("the issue is not in the read");
		const cycleBefore = issueBefore.workCycle;
		// The pickup drops the item: the task type's action form is gone from
		// the config, and the row leaves: no settle stands for the machine's
		// drop, the waits are the items', not the tickets'.
		config = { ...PLANE_CONFIG, taskTypes: { ...PLANE_TASK_TYPES, merge: { template: "x" } } };
		state.workQueue.setQueuePaused(false);
		await dispatch.pickupWorkQueue();
		expect(state.workQueue.items()).toEqual([]);
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)).toBeNull();
		// The drop ran no source work: no merge command, no comment. The ask's
		// own close of the settled turn's environment stands beside it, the way
		// it stands for a merge that runs (ADR 0046): the close belongs to the
		// ask, not to the run.
		expect(runner.commands().filter((command) => command.startsWith("gh"))).toEqual([]);
		// The cycles hold: the source's cycle ended at its ask, the position's
		// never ran, and the machine's drop writes no mark.
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("open");
		const after = state.ticketWorkCycle.ticketListViews(
			PLANE_WORKFLOW_STATES,
			PLANE_CONFIG.defaultTaskType,
			"all",
		).rows;
		expect(after.find((t) => t.identity === issueIdentity)?.workCycle).toBe(cycleBefore);
		const pullAfter = after.find((t) => t.identity === pullIdentity);
		expect(pullAfter?.workCycle).toBe(tickets.find((t) => t.identity === pullIdentity)?.workCycle);
		expect(
			state.ticketWorkCycle.lastCompletion(issueIdentity)?.transition?.routeRemoved,
		).toBeUndefined();
		expect(events).toContain(
			`warning: the merge of "${pullTitle}" was not run: task type merge carries no plane action`,
		);
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
		const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("merged");
		expect(state.ticketWorkCycle.lastCompletion(pullIdentity)?.decision).toBe("merged");
		expect(runner.commands()).toContain("gh pr merge #12 --squash --repo github.com/acme/factory");
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
			const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
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
		state.planeAction.recordPlaneActionAttempt({
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
		state.planeAction.recordPlaneActionAttempt({
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
		const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("merged");
		state.close();
	});

	test(
		"the outcome settles on the list, and the screen fell back at the ask (ADR 0072)",
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
					// The confirm ended the ticket's cycle in the same write (ADR
					// 0072): the ticket rests open, the wait stands in the Work
					// queue, and the Decision screen - an awaiting screen again -
					// fell back to the list with the ask's line on the Message line.
					const fallback = await press(setup, "return", "the ask's line", (f) =>
						messageRowOf(f).includes(`the merge of "${pullTitle}" is in the Work queue`),
					);
					expect(fallback).not.toContain("Decision:");
					expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
					// The attempt stands in the state before the fire's fresh read
					// answers, and the run's settle waits on that read.
					const attemptDeadline = Date.now() + 5000;
					for (;;) {
						if (state.planeAction.latestPlaneActionAttempt(pullIdentity) !== null) break;
						if (Date.now() >= attemptDeadline)
							throw new Error("the attempt did not stand in the state");
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
					// The run settles on the list, the way every other settle does:
					// the outcome's line stands, and no decision screen stands for
					// the open ticket.
					const list = await settle(setup);
					expect(list).not.toContain("Decision:");
				},
				WIDTH,
				30,
				props,
			);

			// The record stands for the outcome the screen read: the operator's
			// decision word on the merged outcome.
			const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
			expect(attempt?.outcome).toBe("merged");
			expect(attempt?.decision).toBe("merged");
			state.close();
		},
		{ timeout: 20_000 },
	);

	test("the outcome stands on the Message line, and the merged row leaves the list", async () => {
		const state = planeState();
		seed(state, "awaiting", mergeRoute());
		const runner = new FakeRunner();
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
				// The confirm closes the modal and the run settles behind it:
				// the run's line stands on the Message line, and the merged
				// ticket's row leaves the list the moment the run settles.
				const frame = await press(setup, "return", "the run's line", (f) =>
					messageRowOf(f).includes(`the merge of "${pullTitle}" ran from the Work queue`),
				);
				// The run's line alone names the ticket still: the row and the
				// detail pane both left it.
				const naming = rowsOf(frame).filter((row) => row.includes(pullTitle.slice(0, 3)));
				expect(naming).toHaveLength(1);
				expect(naming[0]).toContain("ran from the Work queue");
			},
			WIDTH,
			30,
			props,
		);

		// The record stands for the outcome the line read: the operator's
		// decision word on the merged outcome, and the ticket's membership
		// retired with the settle, the way the source's next refresh would
		// leave it.
		const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("merged");
		expect(
			state.ticketWorkCycle
				.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType)
				.rows.find((candidate) => candidate.identity === pullIdentity),
		).toBeUndefined();
		state.close();
	});
});

describe("the auto top-up merge", () => {
	/** Boot the app in auto mode around a fresh open pull request. */
	async function topUpApp(
		body: (setup: AppSetup) => Promise<void>,
		stub: (runner: FakeRunner) => void,
		extra: Partial<FactoryConfig> = {},
		prep: (state: FactoryState, runner: FakeRunner) => void = () => {},
	): Promise<{ state: FactoryState; runner: FakeRunner }> {
		const state = planeState();
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		prep(state, runner);
		state.handoff.setAutoHandoffMode(true);
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
		return { state, runner };
	}

	test("the top-up asks for the merge on the ready position, and it runs without an agent", async () => {
		const { state } = await topUpApp(
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
		const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(attempt).not.toBeNull();
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("auto-merged");
		// The position kept the state it wears: the top-up's ask on the open
		// ticket moves no state, and the merged pull request left the
		// projection the moment the run settled.
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		expect(
			state.ticketWorkCycle
				.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType)
				.rows.find((candidate) => candidate.identity === pullIdentity),
		).toBeUndefined();
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
			let held: FactoryState;
			const { state } = await topUpApp(
				async (setup) => {
					// The block's line on the Message line races the rework
					// handoff's working line, which the converged position asks
					// on the next cycle, so the wait reads the attempt from the
					// state the line would state.
					await awaitFrame(
						setup,
						() => held.planeAction.latestPlaneActionAttempt(pullIdentity)?.outcome === "blocked",
						"the block's attempt",
					);
				},
				(runner) => {
					// The run's fresh read finds the pull request open, the
					// merge fails, and the fire's fresh read still reads it
					// open: the needs-work branch holds.
					stubReadSequence(runner, [{ state: "open" }, { state: "open" }]);
					stubMerge(runner, 1, "GraphQL: PullRequest is not mergeable.\n");
				},
				{
					// The converged position asks the rework handoff on every
					// cycle, and the unstubbed herdr refuses each start: the cap
					// must not engage while the test reads the block's facts.
					maxHandoffsPerTicket: 1000,
				},
				(s) => {
					held = s;
				},
			);

			const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
			expect(attempt?.outcome).toBe("blocked");
			expect(attempt?.reason).toBe("GraphQL: PullRequest is not mergeable.");
			expect(attempt?.decision).toBe("auto-merged");
			expect(attempt?.transition?.pullRequestWrite).toEqual({
				added: ["needs-work"],
				removed: [],
			});
			// The fire's convergence (ADR 0079): the block's labels stand on
			// the projection at once, no refresh between the block and the
			// read, and the position stands on them: needs-work offers the
			// rework, not the merge the block already moved off.
			const position = state.ticketWorkCycle
				.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all")
				.rows.find((candidate) => candidate.identity === pullIdentity);
			expect(position?.labels).toEqual(["ready-to-ship", "needs-work"]);
			expect(position?.suggestedTaskType).toBe("rework");
			// The ticket keeps the open state it wore: no cycle ran for it, and
			// the block ran no retirement, so the ticket stays listed.
			expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
			expect(position).toBeDefined();
			state.close();
		} finally {
			bellSpy.mockRestore();
		}
		// No bell: the block stands on the Message line, and the pull
		// request's comment carries the fact to the source.
		expect(bells).toBe(0);
	});

	test("a blocked merge whose label write failed keeps the merge position, and the hold stands until the source re-reads", async () => {
		let held: FactoryState;
		let heldRunner: FakeRunner;
		const { state, runner } = await topUpApp(
			async (setup) => {
				await awaitFrame(
					setup,
					() => held.planeAction.latestPlaneActionAttempt(pullIdentity)?.outcome === "blocked",
					"the block's attempt",
				);
				// The failed write converged nothing (ADR 0079): the labels the
				// source last fetched still wear the merge position, and the
				// hold is the one gate between the top-up and the re-ask.
				const position = held.ticketWorkCycle
					.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all")
					.rows.find((candidate) => candidate.identity === pullIdentity);
				expect(position?.labels).toEqual(["ready-to-ship"]);
				expect(position?.suggestedTaskType).toBe("merge");
				expect(held.planeAction.planeActionBlockedUnrefreshed(pullIdentity)).toBe(true);
				// The hold's window: the cycles keep running with the queue
				// empty, and the position still reads the labels the source
				// last fetched. A re-ask the hold failed to stop would run the
				// merge again here and post its second comment, which the
				// count below refuses.
				await settle(setup);
				await new Promise((resolve) => setTimeout(resolve, 600));
				// The release: the source re-reads the ticket, and the read
				// still wears the merge position, the way a block whose label
				// write failed stands. The next cycle's walk asks the merge
				// again.
				held.sourceFact.applyFetch(
					pullsSource,
					pullSuccess(new Date(Date.now() + 60_000).toISOString()),
				);
				await awaitFrame(
					setup,
					() =>
						heldRunner.commands().filter((command) => command.startsWith("gh pr merge ")).length >=
						2,
					"the re-ask's merge",
				);
			},
			(runner) => {
				// The run's fresh read, then the fire's, for both attempts:
				// the label write fails on the stubbed edit, so the fire
				// converges nothing and the position keeps its merge.
				stubReadSequence(runner, [
					{ state: "open" },
					{ state: "open" },
					{ state: "open" },
					{ state: "open" },
				]);
				stubMerge(runner, 1, "GraphQL: PullRequest is not mergeable.\n");
				runner.set("gh", PR_EDIT_ARGS, { code: 1, stderr: "the label write was refused\n" });
			},
			{},
			(s, r) => {
				held = s;
				heldRunner = r;
			},
		);

		// The re-ask ran on the refresh, and only on it: the hold stood while
		// the cycles ran with the merge position the failed write never moved,
		// and the second attempt is the read that carried the labels.
		const mergeCommands = runner.commands().filter((command) => command.startsWith("gh pr merge "));
		expect(mergeCommands).toHaveLength(2);
		expect(state.planeAction.planeActionAttemptCount(pullIdentity)).toBe(2);
		expect(
			runner.commands().filter((command) => command.startsWith("gh pr comment ")),
		).toHaveLength(2);
		// The failed write converged nothing on either attempt: the position
		// still wears the labels the source last fetched and offers the merge
		// the hold keeps checking.
		const position = state.ticketWorkCycle
			.ticketListViews(PLANE_WORKFLOW_STATES, PLANE_CONFIG.defaultTaskType, "all")
			.rows.find((candidate) => candidate.identity === pullIdentity);
		expect(position?.labels).toEqual(["ready-to-ship"]);
		expect(position?.suggestedTaskType).toBe("merge");
		state.close();
	});

	test("the Handoff limit counts the merge attempts, and a full count holds the top-up", async () => {
		const { state } = await topUpApp(
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
				s.planeAction.recordPlaneActionAttempt({
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
		expect(state.workQueue.items()).toEqual([]);
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)?.at).toBe(
			"2026-08-31T11:00:00Z",
		);
		state.close();
	});

	test("the queue pause holds the merge item standing, and the row and detail name the action", async () => {
		const { state } = await topUpApp(
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
				s.workQueue.setQueuePaused(true);
				expect(
					s.workQueue.enqueuePlaneActionWork({
						ticketIdentity: pullIdentity,
						origin: "open",
						automatic: true,
						taskType: "merge",
					}),
				).toEqual({ ok: true });
			},
		);
		// The pause held the pickup: no command ran on the item.
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)).toBeNull();
		state.close();
	});

	test("the merge's wait wears the queued badge on the position's row (ADR 0072)", async () => {
		// The wait is the position's own fact: the ask enqueues the item on the
		// position, the position's row wears the queue-wait badge in the state
		// badge's place, and the position keeps the state the ask left it,
		// the way the route's wait wears the badge on the position's row.
		const { state } = await topUpApp(
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => {
						const rows = rowsOf(f);
						return rows.some(
							(row) => row.includes(pullTitle.slice(0, 3)) && row.includes("[queued]"),
						);
					},
					"the position's row",
				);
				const row = rowsOf(frame).find((row) => row.includes(pullTitle.slice(0, 3))) ?? "";
				expect(row).toContain("[queued]");
				expect(row).not.toContain("[open]");
			},
			() => {},
			{},
			(s) => {
				// The pull request's own turn settles on its own position: the
				// ask records the decision and ends the cycle in the same
				// write, so the position rests open, and the wait stands on the
				// item alone. The pause holds the pickup.
				seed(s, "awaiting", mergeRoute());
				const handoffId = s.handoff.latestHandoff(pullIdentity)?.handoffId ?? "";
				if (handoffId === "") throw new Error("the seeded turn left no handoff");
				expect(
					s.ticketWorkCycle.applyCompletionDecision({
						ticketIdentity: pullIdentity,
						handoffId,
						decision: "auto-merged",
						decidedAt: "2026-08-31T11:10:00Z",
					}),
				).toBe(true);
				expect(s.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
				expect(
					s.workQueue.enqueuePlaneActionWork({
						ticketIdentity: pullIdentity,
						origin: "workflow",
						automatic: true,
						taskType: "merge",
					}),
				).toEqual({ ok: true });
				s.workQueue.setQueuePaused(true);
			},
		);
		// The pause held the pickup: no command ran on the item, and the
		// position kept the open state the ask left it.
		expect(state.planeAction.latestPlaneActionAttempt(pullIdentity)).toBeNull();
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		state.close();
	});

	test("the Dispatch pause holds the automatic merge add, and the release runs it", async () => {
		let failedHandoffId = "";
		let held: FactoryState;
		const { state } = await topUpApp(
			async (setup) => {
				// Cycles run with the pause held: the held failed trace stops
				// the top-up before the walks, so the open walk's merge add
				// never asks and the queue stays empty, the hold standing on
				// the Message line in the warning voice.
				await settle(setup);
				await new Promise((resolve) => setTimeout(resolve, 400));
				expect(held.ticketWorkCycle.dispatchPauseActive()).toBe(true);
				expect(held.workQueue.items()).toEqual([]);
				expect(held.planeAction.latestPlaneActionAttempt(pullIdentity)).toBeNull();
				expect(messageRowOf(setup.captureCharFrame())).toContain("Dispatch pause");
				// The release: the decision on the held failed trace ends the
				// pause, and the next cycle's open walk adds and runs the merge,
				// the way the unheld run does. The released ticket's source is
				// stale behind its cycle end, so the re-verify gate holds it out
				// of the same walk that adds the merge.
				held.ticketWorkCycle.applyCompletionDecision({
					ticketIdentity: issueIdentity,
					handoffId: failedHandoffId,
					decision: "closed",
					decidedAt: new Date().toISOString(),
				});
				await awaitFrame(
					setup,
					() => held.planeAction.latestPlaneActionAttempt(pullIdentity)?.outcome === "merged",
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
				const claim = s.handoff.claimHandoff(
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
				s.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
					paneId: "pane-2",
					tabId: "tab-2",
					workspaceId: "ws-2",
				});
				s.ticketWorkCycle.settleTurn({
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
		const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
		expect(attempt?.outcome).toBe("merged");
		expect(attempt?.decision).toBe("auto-merged");
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		state.close();
	});
});
