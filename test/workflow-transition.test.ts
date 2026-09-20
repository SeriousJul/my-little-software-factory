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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { FactoryConfig, WorkflowTransition } from "../src/config.ts";
import type {
	FetchedTicket,
	IssueReference,
	SourceMembership,
	Ticket,
} from "../src/domain/ticket.ts";
import { withIssueReferences } from "../src/domain/ticket.ts";
import { openFactoryState } from "../src/state.ts";
import {
	evaluateTransition,
	findLinkedPullRequest,
	fireTransition,
	isDraft,
	scoreFromMessage,
	workflowLabelSet,
} from "../src/workflow.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";

const issueSource = { name: "issues", kind: "github-issues" as const };
const pullSource = { name: "pulls", kind: "github-pull-requests" as const };
const issueIdentity = "github:github.com:I_5";
const pullIdentity = "github:github.com:P_12";
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
			reason: "the completion message carries no score",
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

	test("a plain score line is read too", () => {
		expect(scoreFromMessage("Score: 92 out of 100.")).toBe(92);
		// A score named in loose prose is not the fixed format: the plane
		// reads the line the template's format carries, not any number.
		expect(scoreFromMessage("The total score is 61.")).toBeNull();
	});

	test("no score, and a number out of range, read as no score", () => {
		expect(scoreFromMessage("The work is done.")).toBeNull();
		expect(scoreFromMessage("- **Score:** 140 / 100")).toBeNull();
		expect(scoreFromMessage("")).toBeNull();
	});
});

describe("the machine's workflow label set", () => {
	test("it holds the labels the states match and the transitions write, and not the none set", () => {
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
		const labels = workflowLabelSet(config);
		expect([...labels].sort()).toEqual(["mine", "mixed-case", "needs-triage"]);
		expect(labels.has("do-not-process")).toBe(false);
		expect(workflowLabelSet(config).has("mine")).toBe(true);
		expect(workflowLabelSet(config).has("mixed-case")).toBe(true);
	});
});

describe("the linked pull request", () => {
	test("the pull request that references the issue is found by its identity", async () => {
		const state = seededState(issueTicketData(), pullTicketData());
		const tickets = state.visibleTickets(
			MACHINE_CONFIG.workflowStates,
			MACHINE_CONFIG.defaultTaskType,
		);
		const issue = ticketAt(state, issueIdentity);
		expect(findLinkedPullRequest(tickets, issue)?.identity).toBe(pullIdentity);
	});

	test("a reference the source only knows by number still links", () => {
		const tickets: Ticket[] = [
			{
				...stubTicket(pullIdentity, "github-pull-request", "#12"),
				memberships: [
					{
						...stubMembership(pullIdentity, "github-pull-request", "#12"),
						attributes: withIssueReferences({}, [
							{ identity: null, number: 5, repository: "acme/factory" },
						]),
					},
				],
			},
		];
		const issue = stubTicket(issueIdentity, "github-issue", "#5");
		expect(findLinkedPullRequest(tickets, issue)?.identity).toBe(pullIdentity);
	});

	test("the newest non-draft wins, and a draft alone links nothing", () => {
		const older = pullTicketData({ externalUpdatedAt: "2026-08-30T10:00:00Z" });
		const newest = pullTicketData({
			identity: "github:github.com:P_13",
			externalKey: "#13",
			externalUpdatedAt: "2026-08-31T12:00:00Z",
		});
		const state = seededState(issueTicketData(), older, newest);
		const tickets = state.visibleTickets(
			MACHINE_CONFIG.workflowStates,
			MACHINE_CONFIG.defaultTaskType,
		);
		expect(findLinkedPullRequest(tickets, ticketAt(state, issueIdentity))?.identity).toBe(
			"github:github.com:P_13",
		);

		const drafted = pullTicketData({ attributes: { draft: "true" } });
		const draftState = seededState(issueTicketData(), drafted);
		const draftTickets = draftState.visibleTickets(
			MACHINE_CONFIG.workflowStates,
			MACHINE_CONFIG.defaultTaskType,
		);
		expect(findLinkedPullRequest(draftTickets, ticketAt(draftState, issueIdentity))).toBeNull();
	});

	test("an unrelated pull request is not the link", () => {
		const state = seededState(issueTicketData(), pullTicketData({}, []));
		const tickets = state.visibleTickets(
			MACHINE_CONFIG.workflowStates,
			MACHINE_CONFIG.defaultTaskType,
		);
		expect(findLinkedPullRequest(tickets, ticketAt(state, issueIdentity))).toBeNull();
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
		priority: { rank: null, label: null, source: "none", inheritedFrom: null },
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
			message: "Opened the pull request.",
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
		// The issue converges to no workflow label: the plane removes
		// `ready-for-agent` itself, and never touches a label the machine
		// does not own.
		expect(outcome?.ticketWrite).toEqual({ added: [], removed: ["ready-for-agent"] });
		// The pull request wore `ready-for-agent` too, the mistake issue #70
		// records: the machine owns that label, so the write takes it off the
		// pull request as well and leaves it on the review fact alone.
		expect(outcome?.pullRequestWrite).toEqual({
			added: ["ready-for-review"],
			removed: ["ready-for-agent"],
		});
		expect(runner.commands()).toEqual([
			"gh issue edit #5 --repo github.com/acme/factory --remove-label ready-for-agent",
			"gh pr edit #12 --repo github.com/acme/factory --add-label ready-for-review --remove-label ready-for-agent",
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
			message: "Opened the pull request.",
		});
		expect(outcome).toMatchObject({ fired: true, ticketWrite: null, pullRequestWrite: null });
		expect(runner.commands()).toEqual([]);
	});

	test("the review score picks the branch, and the written label is the new position", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
		const runner = new FakeRunner();
		const shipped = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
			message: "- **Score:** 95 / 100",
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
		expect(runner.commands()).toEqual([
			"gh pr edit #12 --repo github.com/acme/factory --add-label ready-to-ship --remove-label ready-for-review",
		]);
	});

	test("a review score below the threshold moves the pull request to rework", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner: new FakeRunner(),
			ticketIdentity: pullIdentity,
			taskType: "review",
			message: "- **Score:** 40 / 100",
		});
		expect(outcome).toMatchObject({
			when: "score-below-threshold",
			positionTaskType: "rework",
		});
	});

	test("a settled review with no score fires no branch and writes no label", async () => {
		const state = seededState(issueTicketData(), pullTicketData({ labels: ["ready-for-review"] }));
		const runner = new FakeRunner();
		const outcome = await fireTransition({
			config: MACHINE_CONFIG,
			state,
			runner,
			ticketIdentity: pullIdentity,
			taskType: "review",
			message: "I could not finish the review.",
		});
		expect(outcome).toMatchObject({
			fired: false,
			reason: "the completion message carries no score",
			positionTaskType: null,
		});
		expect(runner.commands()).toEqual([]);
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
			message: "The work is done on a local branch.",
		});
		expect(outcome).toMatchObject({
			fired: true,
			pullRequestIdentity: null,
			pullRequestWrite: null,
			reason: "no linked pull request was found for the ticket",
			positionTaskType: null,
		});
		expect(outcome?.ticketWrite).toEqual({ added: [], removed: ["ready-for-agent"] });
		expect(runner.commands()).toEqual([
			"gh issue edit #5 --repo github.com/acme/factory --remove-label ready-for-agent",
		]);
	});

	test("a blocked merge moves the pull request to rework, and a merged one writes nothing", async () => {
		const blocked = seededState(issueTicketData(), pullTicketData({ labels: ["ready-to-ship"] }));
		const blockedRunner = new FakeRunner();
		const blockedOutcome = await fireTransition({
			config: MACHINE_CONFIG,
			state: blocked,
			runner: blockedRunner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			message: "The merge is blocked by a failing check.",
		});
		expect(blockedOutcome).toMatchObject({
			when: "pull-request-open",
			positionTaskType: "rework",
		});
		expect(blockedRunner.commands()).toEqual([
			"gh pr edit #12 --repo github.com/acme/factory --add-label needs-work --remove-label ready-to-ship",
		]);

		const merged = seededState(
			issueTicketData(),
			pullTicketData({
				labels: ["ready-to-ship"],
				sourceState: "closed",
				externalUpdatedAt: "2026-08-31T12:00:00Z",
			}),
		);
		const mergedRunner = new FakeRunner();
		const mergedOutcome = await fireTransition({
			config: MACHINE_CONFIG,
			state: merged,
			runner: mergedRunner,
			ticketIdentity: pullIdentity,
			taskType: "merge",
			message: "Merged.",
		});
		// The merged pull request is no longer open, so no judgment holds: the
		// fallback fires and names no fact, and the write converges the
		// machine's labels away from it.
		expect(mergedOutcome).toMatchObject({ fired: true, when: null, positionTaskType: null });
		expect(mergedOutcome?.pullRequestWrite).toEqual({ added: [], removed: ["ready-to-ship"] });
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
			message: "Opened the pull request.",
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
			message: "done",
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
			message: "done",
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
			message: "Opened the pull request.",
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
			message: "Reworked.",
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
			message: "Opened the pull request.",
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
			message: "Opened the pull request.",
		});
		expect(outcome).toMatchObject({ fired: true, positionTaskType: null });
	});
});
