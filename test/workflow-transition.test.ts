/**
 * The workflow machine's transition tests (ADR 0027).
 *
 * The state machine lives in tested code, so the transition's two halves are
 * pinned here: the evaluation (which branch holds, what facts and pins it
 * carries), and the fire (the label write through the command runner, and the
 * position the written labels put the tickets in).
 *
 * Every test runs on a real in-memory state, a fake command runner, and
 * isolated test tickets. No test reaches GitHub or a real herdr session.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig, TransitionOutcome, WorkflowTransition } from "../src/config.ts";
import type {
	FetchedTicket,
	IssueReference,
	SourceMembership,
	Ticket,
} from "../src/domain/ticket.ts";
import { withHeadBranch, withIssueReferences } from "../src/domain/ticket.ts";
import { openFactoryState } from "../src/state.ts";
import type { TurnLogEntry } from "../src/turn-log.ts";
import {
	evaluateTransition,
	findFixingPullRequest,
	fireTransition,
	fixingPullRequests,
	isCoveredByFixingPullRequest,
	isDraft,
	NO_LINKED_PULL_REQUEST_SKIP,
	pullRequestFixesTicket,
	refireRecordedSkips,
	scoreFromMessage,
	transitionLabelSet,
} from "../src/workflow.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";

const issueSource = { name: "issues", kind: "github-issues" as const };
const pullSource = { name: "pulls", kind: "github-pull-requests" as const };
const securitySource = { name: "security", kind: "github-dependabot-alert" as const };
const issueIdentity = "github:github.com:I_5";
const pullIdentity = "github:github.com:P_12";
const securityIdentity = "github:github.com:SEC_9";
const securityPullIdentity = "github:github.com:P_97";
const repository = {
	identity: "github.com/acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
};

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * The shipped label machine (ADR 0027): the four states of the label workflow
 * and the four task types with their transitions.
 */
const MACHINE_CONFIG: FactoryConfig = {
	...BASE_CONFIG,
	sources: [
		{
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
		{
			name: "pulls",
			kind: "github-pull-requests",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
	workflowStates: [
		{
			name: "ready-for-agent",
			taskType: "implement",
			match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
		},
		{
			name: "needs-work",
			taskType: "rework",
			match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
		},
		{
			name: "ready-for-review",
			taskType: "review",
			match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
		},
		{
			name: "ready-to-ship",
			taskType: "merge",
			match: { sourceKind: "github-pull-request", labelsAny: ["ready-to-ship"] },
		},
	],
	taskTypes: {
		implement: {
			template: "implement",
			transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review"] },
		},
		review: {
			template: "review",
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
		rework: {
			template: "rework",
			transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review"] },
		},
		merge: {
			template: "merge",
			transition: {
				ticketFacts: [],
				pullRequestFacts: [],
				branches: [
					{ when: "pull-request-open", pullRequestFacts: ["needs-work"] },
					{ pullRequestFacts: [] },
				],
			},
		},
	},
};

/** One transition with the fields a bare fact-only test does not name. */
function transition(over: Partial<WorkflowTransition> = {}): WorkflowTransition {
	return { ticketFacts: [], pullRequestFacts: [], ...over };
}

function issueTicketData(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return {
		identity: issueIdentity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/5",
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository,
		attributes: {},
		...over,
	};
}

function pullTicketData(
	over: Partial<FetchedTicket> = {},
	references: readonly IssueReference[] = [
		{ identity: issueIdentity, number: 5, repository: "acme/factory" },
	],
): FetchedTicket {
	return {
		identity: pullIdentity,
		sourceKind: "github-pull-request",
		externalKey: "#12",
		sourceState: "open",
		url: "https://github.com/acme/factory/pulls/12",
		title: "Persist source facts in state",
		description: "The implementation of #5.",
		labels: [],
		externalUpdatedAt: "2026-08-31T11:00:00Z",
		repository,
		attributes: withIssueReferences({ draft: "false" }, references),
		...over,
	};
}

/** A security item the agent works, with no issue identity of its own. */
function securityTicketData(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return {
		identity: securityIdentity,
		sourceKind: "github-dependabot-alert",
		externalKey: "#9",
		sourceState: "open",
		url: "https://github.com/acme/factory/security/dependabot/9",
		title: "Patch the vulnerable dependency",
		description: "The Dependabot alert.",
		labels: ["high"],
		externalUpdatedAt: "2026-08-31T10:30:00Z",
		repository,
		attributes: {},
		...over,
	};
}

/**
 * The pull request the agent opened for the security item: in the item's
 * repository, its head branch carries the item's factory-branch prefix, and
 * it closes nothing - the link is the branch, not a body reference.
 */
function securityPullTicketData(over: Partial<FetchedTicket> = {}): FetchedTicket {
	return {
		identity: securityPullIdentity,
		sourceKind: "github-pull-request",
		externalKey: "#97",
		sourceState: "open",
		url: "https://github.com/acme/factory/pulls/97",
		title: "Patch the vulnerable dependency",
		description: "Bumps the vulnerable dependency.",
		labels: [],
		externalUpdatedAt: "2026-08-31T11:00:00Z",
		repository,
		attributes: withHeadBranch({ draft: "false" }, "factory/9-patch-the-vulnerable-dependency"),
		...over,
	};
}

/** A state holding the security item and, when given, its pull request. */
function securitySeededState(...tickets: FetchedTicket[]) {
	const dir = mkdtempSync(join(tmpdir(), "factory-workflow-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.initializeSources([securitySource, pullSource]);
	state.applyFetch(securitySource, {
		status: "success",
		fetchedAt: "2026-08-31T11:01:00Z",
		tickets: tickets.filter((ticket) => ticket.sourceKind === "github-dependabot-alert"),
	});
	state.applyFetch(pullSource, {
		status: "success",
		fetchedAt: "2026-08-31T11:01:00Z",
		tickets: tickets.filter((ticket) => ticket.sourceKind === "github-pull-request"),
	});
	return state;
}

/** A state holding the issue and, when given, its pull request. */
function seededState(...tickets: FetchedTicket[]) {
	const dir = mkdtempSync(join(tmpdir(), "factory-workflow-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.initializeSources([issueSource, pullSource]);
	state.applyFetch(issueSource, {
		status: "success",
		fetchedAt: "2026-08-31T11:01:00Z",
		tickets: tickets.filter((ticket) => ticket.sourceKind === "github-issue"),
	});
	state.applyFetch(pullSource, {
		status: "success",
		fetchedAt: "2026-08-31T11:01:00Z",
		tickets: tickets.filter((ticket) => ticket.sourceKind === "github-pull-request"),
	});
	return state;
}

function ticketAt(state: ReturnType<typeof seededState>, identity: string): Ticket {
	const ticket = state
		.visibleTickets(MACHINE_CONFIG.workflowStates, MACHINE_CONFIG.defaultTaskType)
		.find((candidate) => candidate.identity === identity);
	if (ticket === undefined) throw new Error(`no ticket ${identity} in the projection`);
	return ticket;
}

/**
 * The exact argv of the pull request's comment read: the source's host, and
 * the issue-style comment list of the pull the score tests fire on (#12).
 */
const COMMENT_READ_ARGS = [
	"api",
	"--hostname",
	"github.com",
	"repos/acme/factory/issues/12/comments?per_page=100",
];
/** The full command the score read issues, as the runner records it. */
const COMMENT_READ_COMMAND = `gh ${COMMENT_READ_ARGS.join(" ")}`;

/** Make the runner answer the comment read with these GitHub issue comments. */
function setReviewComments(
	runner: FakeRunner,
	comments: readonly { body: string; created_at?: string }[],
): void {
	runner.set("gh", COMMENT_READ_ARGS, { stdout: JSON.stringify(comments) });
}

/**
 * The exact argv of the pull request's state read: the source's host, and
 * the pull's own REST record (#12).
 */
const STATE_READ_ARGS = ["api", "--hostname", "github.com", "repos/acme/factory/pulls/12"];
/** The full command the state read issues, as the runner records it. */
const STATE_READ_COMMAND = `gh ${STATE_READ_ARGS.join(" ")}`;

/** Make the runner answer the state read with this pull request record. */
function setPullRequestState(runner: FakeRunner, record: { state: string; merged: boolean }): void {
	runner.set("gh", STATE_READ_ARGS, { stdout: JSON.stringify(record) });
}

describe("the transition evaluation", () => {
	test("a fact-only transition always fires", () => {
		const evaluation = evaluateTransition(transition({ ticketFacts: ["ready-for-review"] }), {
			score: null,
			pullRequestOpen: null,
		});
		expect(evaluation).toMatchObject({
			fired: true,
			when: null,
			reason: "",
			ticketFacts: ["ready-for-review"],
			autoAdvance: false,
		});
	});

	test("the first judgment branch whose judgment holds fires", () => {
		const review = transition({
			scoreThreshold: 90,
			branches: [
				{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] },
				{ when: "score-below-threshold", pullRequestFacts: ["needs-work"] },
			],
		});
		expect(
			evaluateTransition(review, { score: 90, pullRequestOpen: true }).pullRequestFacts,
		).toEqual(["ready-to-ship"]);
		expect(
			evaluateTransition(review, { score: 89, pullRequestOpen: true }).pullRequestFacts,
		).toEqual(["needs-work"]);
	});

	test("the threshold belongs to the judgment: exactly at it ships", () => {
		const review = transition({
			scoreThreshold: 92,
			branches: [
				{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] },
				{ when: "score-below-threshold", pullRequestFacts: ["needs-work"] },
			],
		});
		expect(evaluateTransition(review, { score: 92, pullRequestOpen: true }).when).toBe(
			"score-above-threshold",
		);
		expect(evaluateTransition(review, { score: 91, pullRequestOpen: true }).when).toBe(
			"score-below-threshold",
		);
	});

	test("a branch's facts and pins replace the transition's for the field it names", () => {
		const evaluation = evaluateTransition(
			transition({
				ticketFacts: ["blocked"],
				pullRequestFacts: ["needs-work"],
				agent: "pi",
				environment: "worktree",
				scoreThreshold: 90,
				branches: [{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] }],
			}),
			{ score: 95, pullRequestOpen: true },
		);
		// The branch names the pull request only: the ticket keeps the
		// transition's fact, and so do the pins.
		expect(evaluation).toMatchObject({
			fired: true,
			when: "score-above-threshold",
			ticketFacts: ["blocked"],
			pullRequestFacts: ["ready-to-ship"],
			agent: "pi",
			environment: "worktree",
		});
	});

	test("a branch without a judgment is the fallback the transition fires on last", () => {
		const evaluation = evaluateTransition(
			transition({
				branches: [
					{ when: "pull-request-open", pullRequestFacts: ["needs-work"] },
					{ pullRequestFacts: ["shipped"] },
				],
			}),
			{ score: null, pullRequestOpen: false },
		);
		expect(evaluation).toMatchObject({ fired: true, when: null, pullRequestFacts: ["shipped"] });
	});

	test("no branch holds: the transition does not fire and names why", () => {
		const noScore = evaluateTransition(
			transition({
				scoreThreshold: 90,
				branches: [{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] }],
			}),
			{ score: null, pullRequestOpen: true },
		);
		expect(noScore).toMatchObject({
			fired: false,
			reason: "the pull request carries no review score",
		});

		const noPull = evaluateTransition(
			transition({
				branches: [{ when: "pull-request-closed", ticketFacts: ["done"] }],
			}),
			{ score: null, pullRequestOpen: null },
		);
		expect(noPull).toMatchObject({
			fired: false,
			reason: "no pull request was found for the ticket",
		});

		// A score the transition cannot read is not a judgment: the facts the
		// transition names stand, and nothing fires on a score with no branch.
		const unknown = evaluateTransition(
			transition({
				branches: [{ when: "pull-request-open", ticketFacts: ["x"] }],
			}),
			{ score: null, pullRequestOpen: false },
		);
		expect(unknown).toMatchObject({ fired: false, reason: "no judgment held" });
	});

	test("the auto-advance flag is the branch's when the branch sets it", () => {
		const base = transition({ autoAdvance: true, branches: [{ when: "pull-request-open" }] });
		expect(evaluateTransition(base, { score: null, pullRequestOpen: true }).autoAdvance).toBe(true);
		const overridden = transition({
			autoAdvance: true,
			branches: [{ when: "pull-request-open", autoAdvance: false }],
		});
		expect(evaluateTransition(overridden, { score: null, pullRequestOpen: true }).autoAdvance).toBe(
			false,
		);
	});
});

describe("the review score", () => {
	test("the seed's fixed format is read", () => {
		expect(
			scoreFromMessage("Here is the review.\n- **Score:** 85 / 100\n- **Specification:** Pass"),
		).toBe(85);
	});

	test("a score named in loose prose is not a score", () => {
		// The plane reads only the fixed format line the template carries, not
		// any number in the message: a prose sentence that names a number is
		// not the agent's verdict.
		expect(scoreFromMessage("Score: 92 out of 100.")).toBeNull();
		expect(scoreFromMessage("The total score is 61.")).toBeNull();
	});

	test("the last score line is the verdict", () => {
		// The agent restates the score after a final pass: the earlier line is
		// scratch, and the quoted number in between is not a line at all.
		expect(scoreFromMessage("- **Score:** 40 / 100\nOn re-check: **Score:** 92 / 100")).toBe(92);
	});

	test("no score, and a number out of range, read as no score", () => {
		expect(scoreFromMessage("The work is done.")).toBeNull();
		expect(scoreFromMessage("- **Score:** 140 / 100")).toBeNull();
		expect(scoreFromMessage("")).toBeNull();
	});
});

describe("the review score read from the pull request's comments", () => {
	// Each test seeds the open pull and fires the review transition; the
	// verdict is the pull request's own comment, read through the command
	// runner, not the agent's last message.
	function loadPull(): ReturnType<typeof seededState> {
		return seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
	}

	test("the newest comment that reports a score is the verdict", async () => {
		const runner = new FakeRunner();
		const state = loadPull();
		setReviewComments(runner, [
			{ body: "- **Score:** 40 / 100", created_at: "2026-08-31T11:00:00Z" },
			{ body: "Re-reviewed.\n- **Score:** 95 / 100", created_at: "2026-08-31T12:00:00Z" },
		]);
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		expect(outcome).toMatchObject({ when: "score-above-threshold" });
	});

	test("a later comment's lower score is the verdict over an earlier higher one", async () => {
		const runner = new FakeRunner();
		const state = loadPull();
		setReviewComments(runner, [
			{ body: "- **Score:** 95 / 100", created_at: "2026-08-31T12:00:00Z" },
			{ body: "On re-check, lower: - **Score:** 40 / 100", created_at: "2026-08-31T13:00:00Z" },
		]);
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		expect(outcome).toMatchObject({ when: "score-below-threshold" });
	});

	test("a comment without the fixed line is not a score", async () => {
		const runner = new FakeRunner();
		const state = loadPull();
		setReviewComments(runner, [
			{ body: "The total score is 61.", created_at: "2026-08-31T12:00:00Z" },
		]);
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		expect(outcome).toMatchObject({
			fired: false,
			reason: "the pull request carries no review score",
		});
	});

	test("a failed comment read carries no score and fires no branch", async () => {
		const runner = new FakeRunner();
		const state = loadPull();
		runner.set("gh", COMMENT_READ_ARGS, { code: 1, stderr: "the comment read failed" });
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		expect(outcome).toMatchObject({
			fired: false,
			reason: "the pull request carries no review score",
		});
		expect(runner.commands()).toEqual([COMMENT_READ_COMMAND]);
	});

	test("the comment read runs only for a score judgment, not for merge", async () => {
		const runner = new FakeRunner();
		const state = loadPull();
		setPullRequestState(runner, { state: "open", merged: false });
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		// The merge transition tests the pull request's own state: the state
		// read ran, and no score judgment, so no comment read for it.
		expect(outcome).toMatchObject({ fired: true });
		expect(runner.commands()).toContain(STATE_READ_COMMAND);
		expect(runner.commands().some((command) => command.includes("comments"))).toBe(false);
	});
});

describe("the machine's written label set", () => {
	test("it holds the labels the transitions write, and not the states' scoping labels", () => {
		const config: FactoryConfig = {
			...MACHINE_CONFIG,
			workflowStates: [
				{
					name: "parked",
					match: { labelsAll: ["needs-triage"], labelsNone: ["do-not-process"] },
				},
			],
			taskTypes: {
				one: {
					template: "x",
					transition: transition({
						ticketFacts: ["mine"],
						branches: [{ pullRequestFacts: ["MIXED-case"] }],
					}),
				},
			},
		};
		const labels = transitionLabelSet(config);
		expect([...labels].sort()).toEqual(["mine", "mixed-case"]);
		// A scoping label the operator matches on is not a write fact: the
		// fire never removes it.
		expect(labels.has("needs-triage")).toBe(false);
		expect(labels.has("do-not-process")).toBe(false);
		expect(labels.has("mine")).toBe(true);
		expect(labels.has("mixed-case")).toBe(true);
	});

	test("a fire leaves a scoping label the state match names but no transition writes", async () => {
		const config: FactoryConfig = {
			...MACHINE_CONFIG,
			workflowStates: [
				{
					name: "scoped",
					taskType: "implement",
					match: { sourceKind: "github-issue", labelsAll: ["factory"] },
				},
			],
		};
		const state = seededState(
			issueTicketData({ labels: ["factory", "ready-for-agent"] }),
			pullTicketData({ labels: ["factory"] }),
		);
		const runner = new FakeRunner();
		const outcome = await fireTransition({
			config,
			state,
			runner,
			ticketIdentity: issueIdentity,
			taskType: "implement",
		});
		// The scoping label outlives the fire on both surfaces: the issue's
		// write adds nothing and removes nothing, and the pull request's adds
		// the fact and removes nothing.
		expect(outcome?.ticketWrite).toBeNull();
		expect(outcome?.pullRequestWrite).toEqual({ added: ["ready-for-review"], removed: [] });
		expect(runner.commands()).toEqual([
			"gh pr edit #12 --repo github.com/acme/factory --add-label ready-for-review",
		]);
	});
});

/** A stub pull request with the membership facts one test gives it. */
function pullStub(over: Partial<Ticket> = {}): Ticket {
	return stubTicket(pullIdentity, "github-pull-request", "#12", over);
}

/** The membership facts of one stub pull request's newest membership. */
function pullStubWith(attributes: Record<string, string>, over: Partial<SourceMembership> = {}) {
	return pullStub({
		memberships: [
			{ ...stubMembership(pullIdentity, "github-pull-request", "#12"), ...over, attributes },
		],
	});
}

/** A stub pull request with its own identity and number, for the ordering. */
function pullStubAs(
	number: number,
	attributes: Record<string, string>,
	externalUpdatedAt: string,
): Ticket {
	const identity = `github:github.com:P_${number}`;
	const key = `#${number}`;
	return {
		...stubTicket(identity, "github-pull-request", key),
		externalUpdatedAt,
		memberships: [
			{
				...stubMembership(identity, "github-pull-request", key),
				attributes,
				externalUpdatedAt,
			},
		],
	};
}

/** A closed-pull-request fact set on a stub membership. */
function closedMembership(over: Partial<SourceMembership> = {}): SourceMembership {
	return {
		...stubMembership(pullIdentity, "github-pull-request", "#12"),
		sourceState: "closed",
		...over,
	};
}

describe("the fixing pull request", () => {
	test("the pull request that closes the ticket is found by its identity", () => {
		const tickets: Ticket[] = [
			pullStubWith(
				withIssueReferences({}, [
					{ identity: issueIdentity, number: 5, repository: "acme/factory" },
				]),
			),
		];
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		expect(findFixingPullRequest(tickets, issue)?.identity).toBe(pullIdentity);
	});

	test("a reference the source only knows by number still fixes", () => {
		const tickets: Ticket[] = [
			pullStubWith(
				withIssueReferences({}, [{ identity: null, number: 5, repository: "acme/factory" }]),
			),
		];
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		expect(findFixingPullRequest(tickets, issue)?.identity).toBe(pullIdentity);
	});

	test("the head branch that carries the ticket's factory prefix fixes the ticket", () => {
		const tickets: Ticket[] = [
			// The branch slug names a title the ticket no longer carries: the
			// match is on the ticket id alone, so the changed title cannot sever
			// the link (ADR 0042).
			pullStubWith(withHeadBranch({}, "factory/5-persist-source-facts")),
		];
		const issue = stubTicket(issueIdentity, "github-issue", "#5", { title: "A changed title" });
		expect(findFixingPullRequest(tickets, issue)?.identity).toBe(pullIdentity);
	});

	test("a pull request in another repository does not fix the ticket", () => {
		const tickets: Ticket[] = [
			pullStubWith(withHeadBranch({}, "factory/5-persist-source-facts"), {
				repository: {
					identity: "github.com/acme/other",
					displayName: "acme/other",
					cloneUrl: "https://github.com/acme/other.git",
				},
			}),
		];
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		expect(fixingPullRequests(tickets, issue)).toHaveLength(0);
	});

	test("a branch that carries another ticket's prefix does not fix the ticket", () => {
		const tickets: Ticket[] = [pullStubWith(withHeadBranch({}, "factory/6-persist-source-facts"))];
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		expect(fixingPullRequests(tickets, issue)).toHaveLength(0);
	});

	test("an unrelated pull request fixes nothing", () => {
		const tickets: Ticket[] = [pullStubWith({})];
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		expect(fixingPullRequests(tickets, issue)).toHaveLength(0);
	});

	test("a closed pull request still fixes the ticket, but no longer covers it", () => {
		const closed = pullStub({
			sourceState: "closed",
			memberships: [closedMembership({ attributes: withHeadBranch({}, "factory/5-persist") })],
		});
		const tickets: Ticket[] = [closed];
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		expect(pullRequestFixesTicket(closed, issue)).toBe(true);
		expect(fixingPullRequests(tickets, issue)).toHaveLength(0);
		expect(findFixingPullRequest(tickets, issue)).toBeNull();
	});

	test("the newest non-draft wins, and a draft alone fixes nothing the machine acts on", () => {
		const older = pullStubAs(12, withHeadBranch({}, "factory/5-persist"), "2026-08-30T10:00:00Z");
		const newest = pullStubAs(13, withHeadBranch({}, "factory/5-persist"), "2026-08-31T12:00:00Z");
		const draft = pullStubAs(
			14,
			withHeadBranch({ draft: "true" }, "factory/5-persist"),
			"2026-09-01T09:00:00Z",
		);
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		// The draft is the newest fixing pull request, and the machine acts on
		// the newest non-draft: P_13, ahead of the older P_12 and the draft
		// P_14.
		expect(findFixingPullRequest([older, newest, draft], issue)?.identity).toBe(
			"github:github.com:P_13",
		);
		// A draft alone: the machine acts on nothing, and the ticket is still
		// covered - the draft's work is in flight.
		const draftOnly = [draft];
		expect(findFixingPullRequest(draftOnly, issue)).toBeNull();
		expect(isCoveredByFixingPullRequest(draftOnly, issue)).toBe(true);
	});

	test("an in-flight ticket is never covered, whatever pull requests exist", () => {
		const awaiting = stubTicket(issueIdentity, "github-issue", "#5", { state: "awaiting" });
		const tickets: Ticket[] = [pullStubWith(withHeadBranch({}, "factory/5-persist")), awaiting];
		expect(isCoveredByFixingPullRequest(tickets, awaiting)).toBe(false);
		const running = stubTicket(issueIdentity, "github-issue", "#5", { state: "running" });
		expect(isCoveredByFixingPullRequest(tickets, running)).toBe(false);
	});

	test("the draft fact is the membership's newest word", () => {
		const draft = ticketAt(
			seededState(pullTicketData({ attributes: { draft: "true" } })),
			pullIdentity,
		);
		expect(isDraft(draft)).toBe(true);
		expect(isDraft(ticketAt(seededState(pullTicketData()), pullIdentity))).toBe(false);
	});
});

/** A ticket built by hand, for the link tests that need no state. */
function stubMembership(
	identity: string,
	sourceKind: string,
	externalKey: string,
	over: Partial<SourceMembership> = {},
): SourceMembership {
	return {
		sourceName: sourceKind === "github-issue" ? "issues" : "pulls",
		health: "healthy",
		identity,
		sourceKind,
		externalKey,
		sourceState: "open",
		url: `https://github.com/acme/factory/${externalKey}`,
		title: "t",
		description: "",
		labels: [],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository,
		attributes: {},
		...over,
	};
}

function stubTicket(
	identity: string,
	sourceKind: string,
	externalKey: string,
	over: Partial<Ticket> = {},
): Ticket {
	const membership = stubMembership(identity, sourceKind, externalKey);
	return {
		identity,
		title: membership.title,
		repository: repository.displayName,
		repositoryRef: repository,
		state: "open",
		handoff: null,
		workCycle: 1,
		handoffCount: 0,
		lastCompletion: null,
		description: "",
		sourceKind,
		externalKey,
		sourceState: "open",
		url: membership.url,
		labels: membership.labels,
		externalUpdatedAt: membership.externalUpdatedAt,
		memberships: [membership],
		suggestedTaskType: "implement",
		actionable: true,
		handoffRecoveryRequired: false,
		leftover: null,
		...over,
	};
}

describe("the transition fire", () => {
	test("a completed implement writes the review fact on the pull request and keeps the ticket's own labels", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-agent"] }));
		const runner = new FakeRunner();
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: issueIdentity,
			taskType: "implement",
		});
		expect(outcome).toMatchObject({
			fired: true,
			ticketFacts: [],
			pullRequestFacts: ["ready-for-review"],
			pullRequestIdentity: pullIdentity,
			pullRequestKey: "#12",
			writeFailure: "",
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
		});
		// The issue keeps its labels: `ready-for-agent` is a scoping label a
		// state match names, and no transition writes it, so the fire never
		// removes it, and the machine's own labels the issue does not wear
		// add nothing.
		expect(outcome?.ticketWrite).toBeNull();
		// The pull request wears the written fact alone: the write adds it and
		// removes no label, because the issue's scoping label is not a write
		// fact.
		expect(outcome?.pullRequestWrite).toEqual({
			added: ["ready-for-review"],
			removed: [],
		});
		expect(runner.commands()).toEqual([
			"gh pr edit #12 --repo github.com/acme/factory --add-label ready-for-review",
		]);
	});

	test("a completed turn on a security item writes the facts on the pull request its branch names, and derives the position", async () => {
		const state = securitySeededState(securityTicketData(), securityPullTicketData());
		const runner = new FakeRunner();
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: securityIdentity,
			taskType: "implement",
		});
		expect(outcome).toMatchObject({
			fired: true,
			pullRequestFacts: ["ready-for-review"],
			pullRequestIdentity: securityPullIdentity,
			pullRequestKey: "#97",
			positionTaskType: "review",
			positionTicketIdentity: securityPullIdentity,
		});
		// The item's own surface writes no fact: the transition names none for
		// it, and the written fact lands on the pull request the branch names.
		expect(outcome?.ticketWrite).toBeNull();
		expect(outcome?.pullRequestWrite).toEqual({ added: ["ready-for-review"], removed: [] });
		expect(runner.commands()).toEqual([
			"gh pr edit #97 --repo github.com/acme/factory --add-label ready-for-review",
		]);
	});

	test("a second fire on the same labels writes nothing", async () => {
		const state = seededState(
			issueTicketData({ labels: [] }),
			pullTicketData({ labels: ["ready-for-review"] }),
		);
		const runner = new FakeRunner();
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: issueIdentity,
			taskType: "implement",
		});
		expect(outcome).toMatchObject({ fired: true, ticketWrite: null, pullRequestWrite: null });
		expect(runner.commands()).toEqual([]);
	});

	test("the review score picks the branch, and the written label is the new position", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
		const runner = new FakeRunner();
		setReviewComments(runner, [
			{ body: "The review passes.\n- **Score:** 95 / 100", created_at: "2026-08-31T12:00:00Z" },
		]);
		const shipped = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		expect(shipped).toMatchObject({
			fired: true,
			when: "score-above-threshold",
			positionTaskType: "merge",
			positionTicketIdentity: pullIdentity,
		});
		// The review runs on the pull request's own ticket: one surface, one
		// write, and it converges the pull request to the branch's facts.
		expect(shipped?.ticketWrite).toBeNull();
		expect(shipped?.pullRequestWrite).toEqual({
			added: ["ready-to-ship"],
			removed: ["ready-for-review"],
		});
		// The verdict is read from the pull request's comment before the label
		// write: the comment read, then the write it decided.
		expect(runner.commands()).toEqual([
			"gh api --hostname github.com repos/acme/factory/issues/12/comments?per_page=100",
			"gh pr edit #12 --repo github.com/acme/factory --add-label ready-to-ship --remove-label ready-for-review",
		]);
	});

	test("a review score below the threshold moves the pull request to rework", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
		const runner = new FakeRunner();
		setReviewComments(runner, [
			{ body: "- **Score:** 40 / 100", created_at: "2026-08-31T12:00:00Z" },
		]);
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		expect(outcome).toMatchObject({
			when: "score-below-threshold",
			positionTaskType: "rework",
		});
	});

	test("a settled review with no score fires no branch and writes no label", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
		const runner = new FakeRunner();
		setReviewComments(runner, [
			{ body: "I could not finish the review.", created_at: "2026-08-31T12:00:00Z" },
		]);
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		expect(outcome).toMatchObject({
			fired: false,
			reason: "the pull request carries no review score",
			positionTaskType: null,
		});
		// The comment read ran and found no verdict: no label write follows.
		expect(runner.commands()).toEqual([COMMENT_READ_COMMAND]);
	});

	test("no pull request found is a visible fact, and the ticket's own facts still stand", async () => {
		const state = seededState(issueTicketData());
		const runner = new FakeRunner();
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: issueIdentity,
			taskType: "implement",
		});
		expect(outcome).toMatchObject({
			fired: true,
			pullRequestIdentity: null,
			pullRequestWrite: null,
			reason: "no linked pull request was found for the ticket",
			positionTaskType: null,
		});
		expect(outcome?.ticketWrite).toBeNull();
		expect(runner.commands()).toEqual([]);
	});

	test("a blocked merge moves the pull request to rework", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-to-ship"] }));
		const runner = new FakeRunner();
		setPullRequestState(runner, { state: "open", merged: false });
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		expect(outcome).toMatchObject({
			when: "pull-request-open",
			positionTaskType: "rework",
		});
		expect(runner.commands()).toEqual([
			STATE_READ_COMMAND,
			"gh pr edit #12 --repo github.com/acme/factory --add-label needs-work --remove-label ready-to-ship",
		]);
	});

	test("a failed state read falls back to the projection's fact", async () => {
		// The read's failure is the projection's fact: the fire decides on the
		// last refresh, the way it does before the read exists.
		const closed = seededState(
			issueTicketData(),
			pullTicketData({
				labels: ["ready-to-ship"],
				sourceState: "closed",
				externalUpdatedAt: "2026-08-31T12:00:00Z",
			}),
		);
		const closedRunner = new FakeRunner();
		closedRunner.set("gh", STATE_READ_ARGS, { code: 1, stderr: "the state read failed" });
		const closedOutcome = await fireTransition({
			config: MACHINE_CONFIG,
			state: closed,
			runner: closedRunner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		// The closed pull request is no longer open, so no judgment holds: the
		// fallback fires and names no fact, and the write converges the
		// machine's labels away from it.
		expect(closedOutcome).toMatchObject({ fired: true, when: null, positionTaskType: null });
		expect(closedOutcome?.pullRequestWrite).toEqual({ added: [], removed: ["ready-to-ship"] });

		const open = seededState(issueTicketData(), pullTicketData({ labels: ["ready-to-ship"] }));
		const openRunner = new FakeRunner();
		openRunner.set("gh", STATE_READ_ARGS, { code: 1, stderr: "the state read failed" });
		const openOutcome = await fireTransition({
			config: MACHINE_CONFIG,
			state: open,
			runner: openRunner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		expect(openOutcome).toMatchObject({
			when: "pull-request-open",
			positionTaskType: "rework",
		});
	});

	test("the state read runs only for a pull request state judgment, not for review", async () => {
		const runner = new FakeRunner();
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
		setReviewComments(runner, [
			{ body: "- **Score:** 95 / 100", created_at: "2026-08-31T12:00:00Z" },
		]);
		await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
		});
		// The review transition tests the score, not the pull request's state:
		// the comment read ran, and no state read followed.
		expect(runner.commands()).toContain(COMMENT_READ_COMMAND);
		expect(runner.commands().some((command) => command.includes("pulls/"))).toBe(false);
	});

	test("a merged pull request the projection still lists as open routes nowhere", async () => {
		// The merge settles before the search index drops the pull request from
		// the open list: the projection still reads it open, and the source,
		// read direct, says merged. The judgment decides on the source, not on
		// the projection's last refresh, so the fallback fires, no fact is
		// written, and the position derives nowhere.
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-to-ship"] }));
		const runner = new FakeRunner();
		setPullRequestState(runner, { state: "closed", merged: true });
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
		});
		expect(outcome).toMatchObject({ fired: true, when: null, positionTaskType: null });
		expect(outcome?.pullRequestWrite).toEqual({ added: [], removed: ["ready-to-ship"] });
		expect(runner.commands()).toEqual([
			STATE_READ_COMMAND,
			"gh pr edit #12 --repo github.com/acme/factory --remove-label ready-to-ship",
		]);
	});

	test("a failed write stands as the failure fact and routes nothing", async () => {
		const state = seededState(issueTicketData(), pullTicketData());
		const runner = new FakeRunner();
		runner.set(
			"gh",
			["pr", "edit", "#12", "--repo", "github.com/acme/factory", "--add-label", "ready-for-review"],
			{
				code: 1,
				stderr: "HTTP 403: Must have admin rights to Repository.\n",
				stdout: "",
			},
		);
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: issueIdentity,
			taskType: "implement",
		});
		expect(outcome?.writeFailure).toContain("gh pr edit #12 failed: HTTP 403");
		// The plane does not re-derive a position from labels it did not write.
		expect(outcome?.positionTaskType).toBeNull();
		expect(outcome?.pullRequestWrite).toBeNull();
	});

	test("a task type with no transition fires nothing", async () => {
		const state = seededState(issueTicketData());
		const runner = new FakeRunner();
		const outcome = await fireTransition({
			config: { ...MACHINE_CONFIG, taskTypes: { chat: { template: "x" } } },
			state,
			runner,
			ticketIdentity: issueIdentity,
			taskType: "chat",
		});
		expect(outcome).toBeNull();
		expect(runner.commands()).toEqual([]);
	});

	test("a ticket that left the list fires nothing", async () => {
		const state = seededState(issueTicketData());
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner: new FakeRunner(),
			ticketIdentity: "github:github.com:I_404",
			taskType: "implement",
		});
		expect(outcome).toBeNull();
	});

	test("the pull request sources are pulled before the judgment reads them", async () => {
		const state = openFactoryState(
			join(
				(() => {
					const dir = mkdtempSync(join(tmpdir(), "factory-workflow-refresh-"));
					paths.push(dir);
					return dir;
				})(),
				"state.sqlite",
			),
		);
		state.initializeSources([issueSource, pullSource]);
		state.applyFetch(issueSource, {
			status: "success",
			fetchedAt: "2026-08-31T11:01:00Z",
			tickets: [issueTicketData()],
		});
		let refreshed = 0;
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner: new FakeRunner(),
			ticketIdentity: issueIdentity,
			taskType: "implement",
			refresh: async () => {
				refreshed += 1;
				// The refresh lands the pull request the agent just opened.
				state.applyFetch(pullSource, {
					status: "success",
					fetchedAt: "2026-08-31T11:02:00Z",
					tickets: [pullTicketData()],
				});
			},
		});
		expect(refreshed).toBe(1);
		expect(outcome).toMatchObject({ pullRequestIdentity: pullIdentity });
		state.close();
	});

	test("a custom host reaches its own GitHub through the repo flag", async () => {
		const config: FactoryConfig = {
			...MACHINE_CONFIG,
			sources: [
				{
					name: "pulls",
					kind: "github-pull-requests",
					refreshIntervalSeconds: 60,
					repositories: ["acme/factory"],
					host: "ghe.example.com",
				},
			],
		};
		const state = openFactoryState(":memory:");
		state.initializeSources([{ name: "pulls", kind: "github-pull-requests" }]);
		state.applyFetch(
			{ name: "pulls", kind: "github-pull-requests" },
			{
				status: "success",
				fetchedAt: "2026-08-31T11:01:00Z",
				tickets: [
					pullTicketData({
						identity: "github:ghe.example.com:P_12",
						url: "https://ghe.example.com/acme/factory/pulls/12",
						repository: {
							identity: "ghe.example.com/acme/factory",
							displayName: "acme/factory",
							cloneUrl: "https://ghe.example.com/acme/factory.git",
						},
					}),
				],
			},
		);
		const runner = new FakeRunner();
		await fireTransition({
			config,
			state,
			runner,
			ticketIdentity: "github:ghe.example.com:P_12",
			taskType: "rework",
		});
		expect(runner.commands()).toEqual([
			"gh pr edit #12 --repo ghe.example.com/acme/factory --add-label ready-for-review",
		]);
		state.close();
	});

	test("a machine with no states derives no position and still writes the facts", async () => {
		const config: FactoryConfig = { ...MACHINE_CONFIG, workflowStates: [] };
		const state = seededState(issueTicketData(), pullTicketData());
		const outcome = await fireTransition({
			config,
			state,
			runner: new FakeRunner(),
			ticketIdentity: issueIdentity,
			taskType: "implement",
		});
		expect(outcome).toMatchObject({ fired: true, positionTaskType: null });
	});

	test("a parking state offers no task, so the position names none", async () => {
		const config: FactoryConfig = {
			...MACHINE_CONFIG,
			workflowStates: [{ name: "waiting-for-a-human", match: {} }],
		};
		const state = seededState(issueTicketData(), pullTicketData());
		const outcome = await fireTransition({
			config,
			state,
			runner: new FakeRunner(),
			ticketIdentity: issueIdentity,
			taskType: "implement",
		});
		expect(outcome).toMatchObject({ fired: true, positionTaskType: null });
	});
});

/**
 * The skip outcome the implement fire stored on the settled turn's trace
 * when it found no fixing pull request (ADR 0027, ADR 0042): the fire
 * wrote the ticket's facts - none here - and the pull request's facts went
 * unwritten, so the fire derived no position.
 */
function skipOutcome(): TransitionOutcome {
	return {
		fired: true,
		when: null,
		reason: NO_LINKED_PULL_REQUEST_SKIP,
		ticketFacts: [],
		pullRequestFacts: ["ready-for-review"],
		autoAdvance: false,
		ticketWrite: null,
		pullRequestWrite: null,
		pullRequestIdentity: null,
		pullRequestKey: null,
		writeFailure: "",
		positionTaskType: null,
		positionTicketIdentity: null,
	};
}

/** A settled turn of the given task type on the ticket, with the stored transition. */
function settledTurn(
	state: ReturnType<typeof seededState>,
	identity: string,
	taskType: string,
	transition: TransitionOutcome | null,
): void {
	const claim = state.claimHandoff(
		identity,
		{
			agentType: "pi",
			environment: "worktree",
			taskType,
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
		ticketIdentity: identity,
		handoffId: claim.claim.attemptId,
		taskType,
		agentType: "pi",
		message: "The turn is done.",
		turnLog: [{ kind: "text", text: "The turn is done." }] as TurnLogEntry[],
		completedAt: "2026-08-31T11:00:00Z",
		...(transition === null ? {} : { transition }),
	});
}

/**
 * A state whose ticket's newest completion trace records the skip: the
 * settled turn's fire found no fixing pull request and stored the skip
 * outcome (ADR 0042).
 */
function skipSeededState(issue: FetchedTicket, transition: TransitionOutcome | null) {
	const state = seededState(issue);
	settledTurn(state, issue.identity, "implement", transition);
	return state;
}

/** Land the pull request on the pulls source, the way a refresh would. */
function landPullRequests(state: ReturnType<typeof seededState>, ...pulls: FetchedTicket[]): void {
	state.applyFetch(pullSource, {
		status: "success",
		fetchedAt: "2026-08-31T12:01:00Z",
		tickets: pulls,
	});
}

describe("the recorded skip's re-fire", () => {
	test("a refresh that found the pull request re-fires the skip, and the trace takes the re-fired outcome", async () => {
		const state = skipSeededState(issueTicketData(), skipOutcome());
		const runner = new FakeRunner();
		landPullRequests(state, pullTicketData());
		const refired = await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner });
		expect(refired).toEqual([
			{
				ticketIdentity: issueIdentity,
				outcome: expect.objectContaining({
					fired: true,
					reason: "",
					refired: true,
					ticketWrite: null,
					pullRequestWrite: { added: ["ready-for-review"], removed: [] },
					pullRequestIdentity: pullIdentity,
					pullRequestKey: "#12",
					positionTaskType: "review",
					positionTicketIdentity: pullIdentity,
					writeFailure: "",
				}),
			},
		]);
		// The skip left the pull request's facts unwritten; the re-fire writes
		// them and the ticket's own labels, which already match, stand.
		expect(runner.commands()).toEqual([
			"gh pr edit #12 --repo github.com/acme/factory --add-label ready-for-review",
		]);
		// The trace took the re-fired outcome in place of the skip it recorded.
		expect(state.lastCompletion(issueIdentity)?.transition).toMatchObject({
			refired: true,
			reason: "",
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
		});
		state.close();
	});

	test("the re-fire lands once: a second sweep re-fires nothing", async () => {
		const state = skipSeededState(issueTicketData(), skipOutcome());
		const runner = new FakeRunner();
		landPullRequests(state, pullTicketData());
		const first = await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner });
		expect(first).toHaveLength(1);
		// The trace no longer records the skip, so the sweep's only bound - the
		// recorded fact - holds: the re-fire re-runs nothing.
		const second = await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner });
		expect(second).toEqual([]);
		expect(runner.commands()).toEqual([
			"gh pr edit #12 --repo github.com/acme/factory --add-label ready-for-review",
		]);
		state.close();
	});

	test("a re-fire writes nothing the pull request already wears, and still derives the position", async () => {
		const state = skipSeededState(issueTicketData(), skipOutcome());
		landPullRequests(state, pullTicketData({ labels: ["ready-for-review"] }));
		const runner = new FakeRunner();
		const refired = await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner });
		expect(refired).toHaveLength(1);
		expect(refired[0].outcome).toMatchObject({
			fired: true,
			refired: true,
			pullRequestWrite: null,
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
		});
		expect(runner.commands()).toEqual([]);
		state.close();
	});

	test("a ticket without an open fixing pull request re-fires nothing", async () => {
		// A draft pull request fixes nothing for the machine: the skip stands.
		const draft = skipSeededState(issueTicketData(), skipOutcome());
		landPullRequests(
			draft,
			pullTicketData({
				attributes: withIssueReferences({ draft: "true" }, [
					{ identity: issueIdentity, number: 5, repository: "acme/factory" },
				]),
			}),
		);
		const draftRunner = new FakeRunner();
		expect(
			await refireRecordedSkips({ config: MACHINE_CONFIG, state: draft, runner: draftRunner }),
		).toEqual([]);
		expect(draftRunner.commands()).toEqual([]);
		expect(draft.lastCompletion(issueIdentity)?.transition).toMatchObject({
			reason: NO_LINKED_PULL_REQUEST_SKIP,
		});
		draft.close();

		// A closed pull request is not an open fixing pull request either.
		const closed = skipSeededState(issueTicketData(), skipOutcome());
		landPullRequests(closed, pullTicketData({ sourceState: "closed" }));
		const closedRunner = new FakeRunner();
		expect(
			await refireRecordedSkips({ config: MACHINE_CONFIG, state: closed, runner: closedRunner }),
		).toEqual([]);
		expect(closedRunner.commands()).toEqual([]);
		closed.close();
	});

	test("a trace that recorded any other fact re-fires nothing", async () => {
		// A routable outcome the settle-time fire recorded stands as recorded,
		// pull request or no: the re-fire is bounded to the skip reason.
		const routed = seededState(issueTicketData(), pullTicketData());
		settledTurn(routed, issueIdentity, "implement", {
			...skipOutcome(),
			reason: "",
			refired: false,
			pullRequestIdentity: pullIdentity,
			pullRequestKey: "#12",
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
		});
		const routedRunner = new FakeRunner();
		expect(
			await refireRecordedSkips({ config: MACHINE_CONFIG, state: routed, runner: routedRunner }),
		).toEqual([]);
		expect(routedRunner.commands()).toEqual([]);
		routed.close();

		// A turn that settled without a transition carries no recorded fact.
		const bare = skipSeededState(issueTicketData(), null);
		landPullRequests(bare, pullTicketData());
		const bareRunner = new FakeRunner();
		expect(
			await refireRecordedSkips({ config: MACHINE_CONFIG, state: bare, runner: bareRunner }),
		).toEqual([]);
		expect(bareRunner.commands()).toEqual([]);
		bare.close();
	});

	test("a ticket that left the list re-fires nothing", async () => {
		const state = skipSeededState(issueTicketData(), skipOutcome());
		landPullRequests(state, pullTicketData());
		// The refresh no longer lists the issue: it left every source, and the
		// sweep reads the projection.
		state.applyFetch(issueSource, {
			status: "success",
			fetchedAt: "2026-08-31T12:02:00Z",
			tickets: [],
		});
		const runner = new FakeRunner();
		expect(await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner })).toEqual([]);
		expect(runner.commands()).toEqual([]);
		state.close();
	});

	test("a pull request ticket's recorded skip re-fires nothing", async () => {
		// A pull request fixes no ticket, so its own skip is not a missing
		// fixing pull request to re-fire against.
		const state = seededState(pullTicketData());
		settledTurn(state, pullIdentity, "rework", skipOutcome());
		landPullRequests(state, pullTicketData());
		const runner = new FakeRunner();
		expect(await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner })).toEqual([]);
		expect(runner.commands()).toEqual([]);
		state.close();
	});

	test("a re-fired write failure stands on the trace, and the position derives none", async () => {
		const state = skipSeededState(issueTicketData(), skipOutcome());
		landPullRequests(state, pullTicketData());
		const runner = new FakeRunner();
		runner.set(
			"gh",
			["pr", "edit", "#12", "--repo", "github.com/acme/factory", "--add-label", "ready-for-review"],
			{ code: 1, stderr: "HTTP 403: Must have admin rights to Repository.\n", stdout: "" },
		);
		const refired = await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner });
		expect(refired).toHaveLength(1);
		expect(refired[0].outcome).toMatchObject({
			fired: true,
			refired: true,
			reason: "",
			pullRequestWrite: null,
			positionTaskType: null,
			positionTicketIdentity: null,
		});
		expect(refired[0].outcome?.writeFailure).toContain("gh pr edit #12 failed: HTTP 403");
		// The failure stands on the trace where the skip stood: the operator
		// reads it beside the settled turn, and the sweep's bound holds it
		// there - a second sweep re-fires nothing.
		expect(state.lastCompletion(issueIdentity)?.transition?.writeFailure).toContain("HTTP 403");
		const again = await refireRecordedSkips({ config: MACHINE_CONFIG, state, runner });
		expect(again).toEqual([]);
		state.close();
	});
});
