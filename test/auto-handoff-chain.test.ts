/**
 * The ADR 0092 acceptance chain as one flow (issue #208).
 *
 * The ticket's acceptance names one run, not four pieces: an implement turn on
 * an issue fires its Transition, whose facts are `pull-request-facts`, so the
 * write lands `ready-for-review` on the linked pull request and the Next step
 * the fire derives is the review standing on that pull request. Auto-handoff
 * mode routes it with no keypress. The review turn then fires its own
 * Transition, its `score-above-threshold` branch holds on the score the review
 * posted, and its Next step is the merge Plane action on the same pull request.
 * The top-up enqueues the automatic item, its pickup runs the merge, and the
 * attempt records `auto-merged`.
 *
 * Every hop runs through the real modules: the transition fire and its label
 * writes, the Work queue's dispatch and pickup, the merge run, and the
 * observation cycle. The doubles are the ones the suite uses everywhere - a
 * fake command runner, fake ticket sources, and an in-memory state - so no test
 * here reaches a herdr session, a live `gh`, or the desktop.
 *
 * The Agent start is the one hop the rig holds back: the seat count reads full,
 * so the review item stands in the queue instead of starting an Agent, and the
 * test settles its turn the way the loop's settle does. The suite drives the
 * real start, the real settle, and the real Agent facts in
 * `test/handoff-dispatch.test.ts` and `test/observation.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig, TransitionOutcome } from "../src/config.ts";
import { type FetchedTicket, withIssueReferences } from "../src/domain/ticket.ts";
import {
	createHandoffDispatch,
	type HandoffIntent,
	type PlaneActionIntent,
} from "../src/handoff-dispatch.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import { ObservationCoordinator } from "../src/observation.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import { fireTransition } from "../src/workflow.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const repoIdentity = "github.com/acme/factory";
const issueIdentity = "github:github.com:I_5";
const pullIdentity = "github:github.com:P_12";

const issuesSource = { name: "issues", kind: "github-issues" as const };
const pullsSource = { name: "pulls", kind: "github-pull-requests" as const };

/** The chain's config: the shipped label machine, with the merge in its action form. */
const CHAIN_CONFIG: FactoryConfig = {
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
			name: "ready-for-review",
			taskType: "review",
			match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
		},
		{
			name: "ready-to-ship",
			taskType: "merge",
			match: { sourceKind: "github-pull-request", labelsAny: ["ready-to-ship"] },
		},
		{
			name: "needs-work",
			taskType: "rework",
			match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
		},
	],
	taskTypes: {
		implement: {
			template: "implement",
			// The chain's first hop writes on the pull request, not on the issue.
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
		merge: { action: "merge-pull-request", method: "squash" },
		rework: {
			template: "rework",
			transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review"] },
		},
	},
	maxParallelAgents: 2,
	maxHandoffsPerTicket: 20,
};

/** The score the review agent posted on the pull request, above the threshold. */
const VERDICT_BODY = "## Review\n\nAll green.\n\n**Score:** 92 / 100";

// The `gh` reads and the merge command, in the exact argv the chain issues.
const COMMENT_READ_ARGS = [
	"api",
	"--paginate",
	"--hostname",
	"github.com",
	"repos/acme/factory/issues/12/comments?per_page=100",
];
const REVIEW_READ_ARGS = [
	"api",
	"--paginate",
	"--hostname",
	"github.com",
	"repos/acme/factory/pulls/12/reviews?per_page=100",
];
const PR_READ_ARGS = ["api", "--hostname", "github.com", "repos/acme/factory/pulls/12"];
const PR_MERGE_ARGS = ["pr", "merge", "#12", "--squash", "--repo", repoIdentity];

function issueTicket(labels: readonly string[] = ["ready-for-agent"]): FetchedTicket {
	return {
		identity: issueIdentity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/5",
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: [...labels],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

/** The pull request the implement agent opened: its body closes the issue. */
function pullTicket(labels: readonly string[] = []): FetchedTicket {
	return {
		identity: pullIdentity,
		sourceKind: "github-pull-request",
		externalKey: "#12",
		sourceState: "open",
		url: "https://github.com/acme/factory/pulls/12",
		title: "Persist source facts in state",
		description: "The implementation of #5.",
		labels: [...labels],
		externalUpdatedAt: "2026-08-31T10:30:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: withIssueReferences({ draft: "false" }, [
			{ identity: issueIdentity, number: 5, repository: "acme/factory" },
		]),
	};
}

interface Chain {
	state: FactoryState;
	runner: FakeRunner;
	/** The handoff asks the top-up made, in order. */
	handoffAsks: HandoffIntent[];
	/** The Plane action asks the top-up made, in order. */
	planeAsks: PlaneActionIntent[];
	/** What the dispatch module reported to the Message line, in order. */
	notices: string[];
	statuses: Array<{ kind: string; text: string }>;
	coordinator: ObservationCoordinator;
	dispatch: ReturnType<typeof createHandoffDispatch>;
	/** Land the two sources' rows, the way a refresh does. */
	refresh: (issue: FetchedTicket, pull: FetchedTicket) => void;
	/**
	 * Run one turn's settle the way the loop's settle does: claim the handoff,
	 * land its start, fire the task type's Transition through the real fire
	 * module, and store the outcome the completion decision reads.
	 */
	settleTurnWithFire: (
		identity: string,
		taskType: string,
	) => Promise<{ outcome: TransitionOutcome; attemptId: string }>;
	/** Wait for the merge's attempt record, which the pickup's run writes. */
	awaitAttempt: () => Promise<NonNullable<ReturnType<FactoryState["latestPlaneActionAttempt"]>>>;
}

/** The rig: a real state, a real dispatch module, and a real observation cycle. */
function chainRig(): Chain {
	const dir = mkdtempSync(join(tmpdir(), "factory-chain-state-"));
	paths.push(dir);
	const nowMs = Date.parse("2026-08-31T11:00:00Z");
	const state = openFactoryState(join(dir, "state.sqlite"), () => nowMs);
	state.initializeSources([issuesSource, pullsSource]);
	state.setGroupingAxis("tickets", "none");
	const runner = new FakeRunner();

	const handoffAsks: HandoffIntent[] = [];
	const planeAsks: PlaneActionIntent[] = [];
	const notices: string[] = [];
	const statuses: Chain["statuses"] = [];

	// The dispatch the app builds, on the fake runner and the test state. The
	// seat count reads full on purpose: the review item waits in the queue
	// instead of starting an Agent, and the plane action's item runs anyway
	// because it takes no seat (ADR 0068).
	const dispatch = createHandoffDispatch({
		state,
		runner,
		config: () => CHAIN_CONFIG,
		seatCount: () => CHAIN_CONFIG.maxParallelAgents,
		home: dir,
		working: () => undefined,
		warning: () => undefined,
		error: () => undefined,
		notice: (text) => {
			notices.push(text);
		},
		clearWorking: () => undefined,
		refresh: () => undefined,
		starting: () => undefined,
	});

	const noAgents: readonly HerdrAgent[] = [];
	const coordinator = new ObservationCoordinator({
		state,
		herdr: {
			listAgents: async () => ({ kind: "ok", agents: [...noAgents] }),
			readPane: async () => null,
		},
		config: () => CHAIN_CONFIG,
		dispatch: (intent) => {
			handoffAsks.push(intent);
			return dispatch.dispatch(intent);
		},
		dispatchPlaneAction: (intent) => {
			planeAsks.push(intent);
			return dispatch.dispatchPlaneAction(intent);
		},
		pickupWorkQueue: () => dispatch.pickupWorkQueue(),
		cleanup: async () => undefined,
		// The app's own fire seam: the task type's Transition, through the
		// command runner, on the state's projection.
		fireCompleted: (ticket) =>
			fireTransition({
				config: CHAIN_CONFIG,
				state,
				runner,
				ticketIdentity: ticket.ticketIdentity,
				taskType: ticket.taskType,
			}),
		now: () => nowMs,
		mode: () => true,
		intervalMs: 60_000,
		onChanged: () => undefined,
		onStatus: (kind, text) => {
			statuses.push({ kind, text });
		},
	});

	const refresh = (issue: FetchedTicket, pull: FetchedTicket): void => {
		state.applyFetch(issuesSource, {
			status: "success",
			fetchedAt: new Date(nowMs).toISOString(),
			tickets: [issue],
		});
		state.applyFetch(pullsSource, {
			status: "success",
			fetchedAt: new Date(nowMs).toISOString(),
			tickets: [pull],
		});
	};

	const settleTurnWithFire = async (identity: string, taskType: string) => {
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
			"workflow",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: `pane-${taskType}`,
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// The settle-time fire, the way the app's seam runs it before the
		// completion decision.
		const outcome = await fireTransition({
			config: CHAIN_CONFIG,
			state,
			runner,
			ticketIdentity: identity,
			taskType,
		});
		if (outcome === null) throw new Error(`no transition fired for ${taskType}`);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType,
			agentType: "pi",
			message: "Done. The pull request is open.",
			turnLog: [{ kind: "text", text: "Done. The pull request is open." }],
			completedAt: new Date(nowMs).toISOString(),
			cause: "completed",
			detail: "",
			transition: outcome,
		});
		return { outcome, attemptId: claim.claim.attemptId };
	};

	const awaitAttempt = async () => {
		// The merge runs on the dispatch's pickup pass, which the ask starts
		// behind its own answer. The wait is bounded and yields the event loop
		// between reads: the fake runner answers at once, so the record stands
		// within a few turns.
		for (let round = 0; round < 100; round += 1) {
			const attempt = state.latestPlaneActionAttempt(pullIdentity);
			if (attempt !== null) return attempt;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("no plane action attempt record landed");
	};

	return {
		state,
		runner,
		handoffAsks,
		planeAsks,
		notices,
		statuses,
		coordinator,
		dispatch,
		refresh,
		settleTurnWithFire,
		awaitAttempt,
	};
}

describe("the ADR 0092 chain runs unattended (issue #208)", () => {
	test(
		"implement routes the review on the linked pull request, and the review's " +
			"score branch enqueues the automatic merge",
		async () => {
			const chain = chainRig();
			const { state, runner, coordinator } = chain;
			chain.refresh(issueTicket(), pullTicket());

			// Hop 1: the implement turn on the issue, and its Transition's fire.
			// The fire writes on the linked pull request and derives its position
			// there, so the Next step is the review standing on #12.
			const implementRun = await chain.settleTurnWithFire(issueIdentity, "implement");
			const implementFire = implementRun.outcome;
			expect(implementFire).toMatchObject({
				fired: true,
				writeFailure: "",
				pullRequestIdentity: pullIdentity,
				pullRequestWrite: { added: ["ready-for-review"], removed: [] },
				positionTaskType: "review",
				positionTicketIdentity: pullIdentity,
			});
			expect(runner.commands()).toContain(
				`gh pr edit #12 --repo ${repoIdentity} --add-label ready-for-review`,
			);

			await coordinator.tick();

			// The route, with no keypress: the top-up's continuation ask, on the
			// position's own ticket, and the Work queue's item standing for it.
			expect(chain.handoffAsks).toHaveLength(1);
			expect(chain.handoffAsks[0]).toMatchObject({
				origin: "workflow",
				automatic: true,
				ticketIdentity: pullIdentity,
				routeFromIdentity: issueIdentity,
			});
			expect(chain.handoffAsks[0]?.choice.taskType).toBe("review");
			expect(state.workQueue()).toEqual([
				expect.objectContaining({
					kind: "handoff",
					origin: "workflow",
					automatic: true,
					ticketIdentity: pullIdentity,
					choice: expect.objectContaining({ taskType: "review" }),
				}),
			]);
			// The route's ask ended the issue's cycle at the ask (ADR 0072), and
			// the pull request wears the label the fire wrote and offers the review.
			expect(state.lastCompletion(issueIdentity)?.decision).toBe("auto-handed-off");
			const reviewPosition = state
				.projectedTickets(CHAIN_CONFIG.workflowStates, CHAIN_CONFIG.defaultTaskType)
				.find((candidate) => candidate.identity === pullIdentity);
			expect(reviewPosition?.suggestedTaskType).toBe("review");

			// Hop 2: the review item drains, its turn runs, and its Transition
			// reads the score the review posted on the pull request.
			expect(state.removeWorkItem(pullIdentity)).toBe(true);
			runner.set("gh", COMMENT_READ_ARGS, { stdout: "[]" });
			runner.set("gh", REVIEW_READ_ARGS, {
				stdout: JSON.stringify([{ body: VERDICT_BODY, submitted_at: "2026-08-31T11:00:30Z" }]),
			});
			// The merge run's fresh read finds the pull request open; the fire the
			// action's outcome runs finds it merged.
			runner.setSequence("gh", PR_READ_ARGS, [
				{ stdout: JSON.stringify({ state: "open", merged: false }) },
				{ stdout: JSON.stringify({ state: "closed", merged: true }) },
			]);
			runner.set("gh", PR_MERGE_ARGS, { code: 0 });

			const reviewRun = await chain.settleTurnWithFire(pullIdentity, "review");
			const reviewFire = reviewRun.outcome;
			expect(reviewFire).toMatchObject({
				fired: true,
				when: "score-above-threshold",
				pullRequestWrite: { added: ["ready-to-ship"], removed: ["ready-for-review"] },
				positionTaskType: "merge",
				positionTicketIdentity: pullIdentity,
			});

			await coordinator.tick();
			const attempt = await chain.awaitAttempt();

			// The chain's last hop is a Plane action, and the top-up asked for it
			// the way it asks for every continuation: automatic, on the position.
			expect(chain.planeAsks).toEqual([
				expect.objectContaining({
					origin: "workflow",
					automatic: true,
					ticketIdentity: pullIdentity,
					routeFromIdentity: pullIdentity,
					taskType: "merge",
				}),
			]);
			// The item's `automatic` fact is the decision word its pickup records,
			// and the run is the merge the config's method names.
			expect(attempt).toMatchObject({
				taskType: "merge",
				decision: "auto-merged",
				outcome: "merged",
			});
			expect(runner.commands()).toContain(`gh ${PR_MERGE_ARGS.join(" ")}`);
			expect(chain.notices).toContain(
				'the merge of "Persist source facts in state" ran from the Work queue',
			);
			expect(state.lastCompletion(pullIdentity)?.decision).toBe("auto-merged");
			// The merged pull request leaves the projection the moment the merge
			// lands (ADR 0068), so the chain ends with nothing waiting.
			expect(state.workQueue()).toEqual([]);
			expect(
				state
					.projectedTickets(CHAIN_CONFIG.workflowStates, CHAIN_CONFIG.defaultTaskType)
					.find((candidate) => candidate.identity === pullIdentity),
			).toBeUndefined();
			state.close();
		},
	);

	// The dev-run miss on PR #207 (issue #210's follow-up): the Same-type hold
	// stood on the settled turn's Next step and the rework never routed.
	test("a review that writes needs-work routes its rework after a finished rework cycle", async () => {
		const chain = chainRig();
		const { state, runner, coordinator } = chain;
		chain.refresh(issueTicket(), pullTicket(["ready-for-review"]));

		// The ticket's earlier cycle: a rework turn that finished, its cycle
		// closed by the operator. Its fire put the pull request back at
		// ready-for-review.
		const reworkRun = await chain.settleTurnWithFire(pullIdentity, "rework");
		expect(reworkRun.outcome).toMatchObject({
			fired: true,
			pullRequestFacts: ["ready-for-review"],
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
		});
		expect(
			state.applyCompletionDecision({
				ticketIdentity: pullIdentity,
				handoffId: reworkRun.attemptId,
				decision: "closed",
				decidedAt: new Date(Date.parse("2026-08-31T11:00:30Z")).toISOString(),
			}),
		).toBe(true);
		chain.refresh(issueTicket(), pullTicket(["ready-for-review"]));

		// The next cycle: the review turn, and a score below the threshold.
		runner.set("gh", COMMENT_READ_ARGS, { stdout: "[]" });
		runner.set("gh", REVIEW_READ_ARGS, {
			stdout: JSON.stringify([
				{ body: "**Score:** 86 / 100", submitted_at: "2026-08-31T11:01:00Z" },
			]),
		});
		const reviewRun = await chain.settleTurnWithFire(pullIdentity, "review");
		expect(reviewRun.outcome).toMatchObject({
			fired: true,
			when: "score-below-threshold",
			pullRequestWrite: { added: ["needs-work"], removed: ["ready-for-review"] },
			positionTaskType: "rework",
			positionTicketIdentity: pullIdentity,
		});
		expect(state.ticketState(pullIdentity)).toBe("awaiting");

		await coordinator.tick();

		// The symptom: auto mode owes this turn a rework on its own position.
		expect(chain.handoffAsks).toEqual([
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: pullIdentity,
				routeFromIdentity: pullIdentity,
				choice: expect.objectContaining({ taskType: "rework" }),
			}),
		]);
		state.close();
	});
});
