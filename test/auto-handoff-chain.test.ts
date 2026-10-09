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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig, TransitionOutcome } from "../src/config.ts";
import {
	type EnvironmentKind,
	type FetchedTicket,
	withHeadBranch,
	withIssueReferences,
} from "../src/domain/ticket.ts";
import { BYPASS_CONTRIBUTOR_PUSH_HOOK } from "../src/git-push.ts";
import {
	createHandoffDispatch,
	type HandoffIntent,
	type PlaneActionIntent,
} from "../src/handoff-dispatch.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import { agentNameFor } from "../src/naming.ts";
import { ObservationCoordinator, STARTUP_GRACE_MS } from "../src/observation.ts";
import {
	CONSULTATION_SEAT_STATES,
	parallelSeatCount,
	TICKET_SEAT_STATES,
} from "../src/parallel.ts";
import type { PlaneActionAggregate } from "../src/state/plane-action.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import { fireTransition, isCoveredByFixingPullRequest } from "../src/workflow.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
	worktreeCreateJson,
	worktreeListJson,
	worktreeOpenJson,
} from "./fake-runner.ts";
import { gatedRunner } from "./gated-runner.ts";
import { infoLine, type RecordedLine, recordLogger, warnLine } from "./record-logger.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const repoIdentity = "github.com/acme/factory";
const issueIdentity = "github:github.com:I_5";
const pullIdentity = "github:github.com:P_12";
/** The second pull request in the seat test: the open ticket that queues fresh work. */
const otherPullIdentity = "github:github.com:P_13";

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

/** The issue's factory branch, the branch the cycle's work stands on. */
const ISSUE_FACTORY_BRANCH = "factory/5-persist-source-facts";

/**
 * The pull request the pair of one cycle carries (ADR 0112): the source's own
 * fact, its head branch, names the issue's factory branch.
 */
function pullTicketWithHead(labels: readonly string[] = []): FetchedTicket {
	const pull = pullTicket(labels);
	return {
		...pull,
		attributes: withHeadBranch(pull.attributes, ISSUE_FACTORY_BRANCH),
	};
}

/** The second pull request: open, and its labels suggest a rework of its own. */
function reworkPullTicket(): FetchedTicket {
	return {
		identity: otherPullIdentity,
		sourceKind: "github-pull-request",
		externalKey: "#13",
		sourceState: "open",
		url: "https://github.com/acme/factory/pulls/13",
		title: "Hold the seat for the chain",
		description: "An open pull request with no work started on it.",
		labels: ["needs-work"],
		externalUpdatedAt: "2026-08-31T10:40:00Z",
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

interface ChainRigOptions {
	/** The Parallel limit the rig's seats measure against. */
	maxParallelAgents?: number;
	/**
	 * When set, the seat count is the real one: the shared count over the agent
	 * list the rig controls, the way the app wires it. Without it the count reads
	 * full, and no queue item ever starts an Agent.
	 */
	liveSeats?: boolean;
	/**
	 * Hold every `gh pr merge` command inside the runner, the way a real merge
	 * runs for seconds (issue #327): the Plane action's run stands while the
	 * observation cycle's next tick re-asks the same position.
	 */
	gateMerge?: boolean;
	/** The default Environment the rig's starts resolve to. */
	defaultEnvironment?: EnvironmentKind;
	/** The workflow states the rig's config carries; the chain's by default. */
	workflowStates?: FactoryConfig["workflowStates"];
	/** The task types the rig's config carries; the chain's by default. */ taskTypes?: FactoryConfig["taskTypes"];
}

interface Chain {
	state: FactoryState;
	runner: FakeRunner;
	/** The herdr agent list the observation probe answers and the seats count. */
	setAgents: (agents: readonly HerdrAgent[]) => void;
	/** Land pull request rows on the pulls source, the way a refresh does. */
	landPulls: (...pulls: FetchedTicket[]) => void;
	/**
	 * Put one ticket in flight the way a started handoff does: a settled attempt
	 * with its environment handles, so the ticket holds a seat while its own
	 * agent stands in the probe's list.
	 */
	seedRunningTurn: (identity: string, taskType: string) => string;
	/**
	 * Settle the turn of a ticket already in flight, the way the loop's settle
	 * does: the turn lands on the ticket's own attempt, and the task type's
	 * Transition fires first so the trace carries its outcome.
	 */
	settleRunningTurnWithFire: (
		identity: string,
		taskType: string,
		attemptId: string,
	) => Promise<TransitionOutcome>;
	/** Wait until `count` started handoffs stand inside the held herdr calls. */
	awaitHandoffInFlight: (count?: number) => Promise<void>;
	/** Wait until `count` merge commands stand inside the held gate (issue #327). */
	awaitMergeInFlight: (count?: number) => Promise<void>;
	/** Let the oldest held herdr call answer, the way one herdr call finishing does. */
	releaseHeld: () => void;
	/**
	 * Resolve when a start of the Ticket settles - the report stands beside the
	 * settle, so the waiter reads the settled ledger and the freed checkout.
	 */
	awaitStartSettled: (identity: string) => Promise<void>;
	/** The herdr calls the rig holds, in arrival order. */
	heldCommands: () => string[];
	/** The handoff asks the top-up made, in order. */
	handoffAsks: HandoffIntent[];
	/** The Plane action asks the top-up made, in order. */
	planeAsks: PlaneActionIntent[];
	/** What the dispatch module reported to the Message line, in order. */
	notices: string[];
	/**
	 * The plane's record lines, read back from the `log` seam the dispatch and the
	 * observation cycle share, each with the level it carries (issue #223).
	 */
	lines: RecordedLine[];
	statuses: Array<{ kind: string; text: string }>;
	coordinator: ObservationCoordinator;
	dispatch: ReturnType<typeof createHandoffDispatch>;
	/** The checkout the live rig resolves to; null on a rig with no live seats. */
	checkout: string | null;
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
	awaitAttempt: () => Promise<
		NonNullable<ReturnType<PlaneActionAggregate["latestPlaneActionAttempt"]>>
	>;
}

/** The rig: a real state, a real dispatch module, and a real observation cycle. */
function chainRig(options: ChainRigOptions = {}): Chain {
	const dir = mkdtempSync(join(tmpdir(), "factory-chain-state-"));
	paths.push(dir);
	const nowMs = Date.parse("2026-08-31T11:00:00Z");
	const state = openFactoryState(join(dir, "state.sqlite"), () => nowMs);
	state.sourceFact.initializeSources([issuesSource, pullsSource]);
	state.grouping.setGroupingAxis("tickets", "none");
	const runner = new FakeRunner();
	const config: FactoryConfig = {
		...CHAIN_CONFIG,
		maxParallelAgents: options.maxParallelAgents ?? CHAIN_CONFIG.maxParallelAgents,
		defaultEnvironment: options.defaultEnvironment ?? CHAIN_CONFIG.defaultEnvironment,
		...(options.workflowStates === undefined ? {} : { workflowStates: options.workflowStates }),
		...(options.taskTypes === undefined ? {} : { taskTypes: options.taskTypes }),
	};
	// The app's own agent reference: the probe's list and the seat count read
	// the same array, so the rig cannot hold a seat the count does not see.
	const agentsRef: { current: readonly HerdrAgent[] } = { current: [] };
	// A live-seat rig holds every started handoff inside its herdr call, the way
	// the suite's seat tests do: the work stays in flight, its claim stays open,
	// and the seat it took stays taken while the rest of the queue reads it.
	const gate =
		options.liveSeats === true
			? gatedRunner(runner, (name) => name.startsWith("herdr agent start"))
			: options.gateMerge === true
				? gatedRunner(runner, (name) => name.startsWith("gh pr merge"))
				: null;
	// The live rig's checkout: a real directory the resolution finds, mapped by
	// identity in the config the rig builds.
	const checkout = options.liveSeats === true ? join(dir, "src", "factory") : null;
	if (checkout !== null) {
		mkdirSync(checkout, { recursive: true });
		config.repos = { [repoIdentity]: checkout };
		runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/factory.git\n",
		});
		runner.set("git", ["-C", checkout, "rev-parse", "HEAD"], { stdout: "abcdef\n" });
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["worktree", "list", "--cwd", checkout], { stdout: worktreeListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
			stdout: workspaceCreateJson("ws-1", "pane-root"),
		});
		runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", checkout, "--no-focus"], {
			stdout: tabCreateJson("pane-agent", "tab-agent"),
		});
	}

	const handoffAsks: HandoffIntent[] = [];
	const planeAsks: PlaneActionIntent[] = [];
	const notices: string[] = [];
	const lines: RecordedLine[] = [];
	const statuses: Chain["statuses"] = [];
	// The start-settle signal: the dispatch reports a start's end through its
	// `starting` report, after the settle ran, so the waiter reads the settled
	// ledger and the freed checkout.
	const settledWaiters: Array<{ identity: string; resolve: () => void }> = [];

	// The dispatch the app builds, on the fake runner and the test state. The
	// seat count reads full on purpose: the review item waits in the queue
	// instead of starting an Agent, and the plane action's item runs anyway
	// because it takes no seat (ADR 0068).
	const dispatch = createHandoffDispatch({
		state,
		runner: gate?.runner ?? runner,
		config: () => config,
		seatCount: () =>
			options.liveSeats === true
				? (() => {
						const inFlight = state.ticketWorkCycle.ticketsByState(TICKET_SEAT_STATES);
						const names = state.ticketWorkCycle.agentNamesForTickets(
							inFlight.map((ticket) => ticket.ticketIdentity),
						);
						return parallelSeatCount({
							tickets: inFlight.map((ticket) => ({
								ticketIdentity: ticket.ticketIdentity,
								paneId: ticket.paneId,
								startedAt: ticket.startedAt,
								agentName: names.get(ticket.ticketIdentity) ?? "",
							})),
							handoffAttemptTickets: state.handoff.openAttemptTickets(),
							consultations: state.consultationRecord
								.consultationsByState(CONSULTATION_SEAT_STATES)
								.map((consultation) => ({ state: consultation.state })),
							agents: agentsRef.current,
							now: nowMs,
							startupGraceMs: STARTUP_GRACE_MS,
						});
					})()
				: config.maxParallelAgents,
		home: dir,
		working: () => undefined,
		warning: () => undefined,
		faultWarning: () => undefined,
		error: () => undefined,
		faultError: () => undefined,
		notice: (text) => {
			notices.push(text);
		},
		clearWorking: () => undefined,
		refresh: () => undefined,
		starting: (identity, active) => {
			if (active) return;
			for (let index = settledWaiters.length - 1; index >= 0; index -= 1) {
				const waiter = settledWaiters[index];
				if (waiter !== undefined && waiter.identity === identity) {
					settledWaiters.splice(index, 1);
					waiter.resolve();
				}
			}
		},
		log: recordLogger(lines),
	});

	const coordinator = new ObservationCoordinator({
		state,
		herdr: {
			listAgents: async () => ({ kind: "ok", agents: [...agentsRef.current] }),
			readPane: async () => null,
		},
		config: () => config,
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
				config,
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
		log: recordLogger(lines),
	});

	const refresh = (issue: FetchedTicket, pull: FetchedTicket): void => {
		state.sourceFact.applyFetch(issuesSource, {
			status: "success",
			fetchedAt: new Date(nowMs).toISOString(),
			tickets: [issue],
		});
		state.sourceFact.applyFetch(pullsSource, {
			status: "success",
			fetchedAt: new Date(nowMs).toISOString(),
			tickets: [pull],
		});
	};

	const choiceFor = (taskType: string) => ({
		agentType: "pi" as const,
		environment: "worktree" as const,
		taskType,
		model: "",
		thinking: "",
		contextWindow: "",
	});

	const settleTurnWithFire = async (identity: string, taskType: string) => {
		const claim = state.handoff.claimHandoff(identity, choiceFor(taskType), "workflow");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: `pane-${taskType}`,
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// The settle-time fire, the way the app's seam runs it before the
		// completion decision.
		const outcome = await fireTransition({
			config,
			state,
			runner,
			ticketIdentity: identity,
			taskType,
		});
		if (outcome === null) throw new Error(`no transition fired for ${taskType}`);
		state.ticketWorkCycle.settleTurn({
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
			const attempt = state.planeAction.latestPlaneActionAttempt(pullIdentity);
			if (attempt !== null) return attempt;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("no plane action attempt record landed");
	};

	const seedRunningTurn = (identity: string, taskType: string): string => {
		const claim = state.handoff.claimHandoff(identity, choiceFor(taskType), "workflow");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: `pane-${identity}`,
			tabId: `tab-${identity}`,
			workspaceId: `ws-${identity}`,
		});
		return claim.claim.attemptId;
	};

	const settleRunningTurnWithFire = async (
		identity: string,
		taskType: string,
		attemptId: string,
	): Promise<TransitionOutcome> => {
		const outcome = await fireTransition({
			config,
			state,
			runner,
			ticketIdentity: identity,
			taskType,
		});
		if (outcome === null) throw new Error(`no transition fired for ${taskType}`);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: attemptId,
			taskType,
			agentType: "pi",
			message: "Done. The rework is pushed.",
			turnLog: [{ kind: "text", text: "Done. The rework is pushed." }],
			completedAt: new Date(nowMs).toISOString(),
			cause: "completed",
			detail: "",
			transition: outcome,
		});
		return outcome;
	};

	const landPulls = (...pulls: FetchedTicket[]): void => {
		state.sourceFact.applyFetch(pullsSource, {
			status: "success",
			fetchedAt: new Date(nowMs).toISOString(),
			tickets: [...pulls],
		});
	};

	return {
		state,
		runner,
		setAgents: (agents) => {
			agentsRef.current = agents;
		},
		landPulls,
		seedRunningTurn,
		settleRunningTurnWithFire,
		awaitHandoffInFlight: async (count = 1) => {
			if (gate === null) throw new Error("the rig holds no herdr gate");
			await gate.waitForArrivals(count);
		},
		awaitMergeInFlight: async (count = 1) => {
			if (options.gateMerge !== true || gate === null)
				throw new Error("the rig holds no merge command");
			await gate.waitForArrivals(count);
		},
		releaseHeld: () => {
			if (gate === null) throw new Error("the rig holds no herdr gate");
			gate.release();
		},
		awaitStartSettled: (identity) =>
			new Promise<void>((resolve) => {
				settledWaiters.push({ identity, resolve });
			}),
		heldCommands: () => gate?.heldCommands() ?? [],
		handoffAsks,
		planeAsks,
		notices,
		lines,
		statuses,
		coordinator,
		dispatch,
		checkout,
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
			expect(state.workQueue.items()).toEqual([
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
			expect(state.ticketWorkCycle.lastCompletion(issueIdentity)?.decision).toBe("auto-handed-off");
			const reviewPosition = state.ticketWorkCycle
				.projectedTickets(CHAIN_CONFIG.workflowStates, CHAIN_CONFIG.defaultTaskType)
				.find((candidate) => candidate.identity === pullIdentity);
			expect(reviewPosition?.suggestedTaskType).toBe("review");

			// Hop 2: the review item drains, its turn runs, and its Transition
			// reads the score the review posted on the pull request.
			expect(state.workQueue.removeWorkItem(pullIdentity)).toBe(true);
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
			expect(state.ticketWorkCycle.lastCompletion(pullIdentity)?.decision).toBe("auto-merged");
			// The merged pull request leaves the projection the moment the merge
			// lands (ADR 0068), so the chain ends with nothing waiting.
			expect(state.workQueue.items()).toEqual([]);
			expect(
				state.ticketWorkCycle
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
			state.ticketWorkCycle.applyCompletionDecision({
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
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("awaiting");

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

/**
 * The merge run that stands (issue #327, ADR 0104).
 *
 * The development install's log carries this shape beside every merge it made:
 * the walk's ask enters the row, the pickup's claim takes the row out of the
 * queue, the `gh pr merge` command runs for seconds, and the next observation
 * cycle re-asks the same position. The run's mark refuses that re-ask - the
 * refusal is right, because a second ask would run the same merge twice over one
 * pull request - and the walk answered it with a failure: a warning on the
 * Message line, and the Desktop notification a standing warning carries, over a
 * merge that was landing.
 */
describe("the merge run that stands (issue #327, ADR 0104)", () => {
	test("the walk re-asks a merge already in flight, holds on the refusal, and states no failure", async () => {
		const chain = chainRig({ gateMerge: true });
		const { state, runner, coordinator, lines, statuses } = chain;
		chain.refresh(issueTicket(), pullTicket());
		// The chain up to the merge: the implement turn routes the review, and the
		// review's score branch offers the merge on the pull request.
		await chain.settleTurnWithFire(issueIdentity, "implement");
		await coordinator.tick();
		expect(state.workQueue.removeWorkItem(pullIdentity)).toBe(true);
		runner.set("gh", COMMENT_READ_ARGS, { stdout: "[]" });
		runner.set("gh", REVIEW_READ_ARGS, {
			stdout: JSON.stringify([{ body: VERDICT_BODY, submitted_at: "2026-08-31T11:00:30Z" }]),
		});
		// The run's fresh read finds the pull request open, the fire's read finds it
		// merged: the way the source answers while one merge lands.
		runner.setSequence("gh", PR_READ_ARGS, [
			{ stdout: JSON.stringify({ state: "open", merged: false }) },
			{ stdout: JSON.stringify({ state: "closed", merged: true }) },
		]);
		runner.set("gh", PR_MERGE_ARGS, { code: 0 });
		await chain.settleTurnWithFire(pullIdentity, "review");

		// The ask, and the run: the claim took the row out of the queue, and the
		// merge command stands inside the runner the way it stands at GitHub for
		// seconds.
		await coordinator.tick();
		await chain.awaitMergeInFlight();
		expect(state.workQueue.items()).toEqual([]);

		// The cycles that follow re-ask the same position, the way the poll and
		// every source fetch do on the shipped machine.
		await coordinator.tick();
		await coordinator.tick();
		// Every cycle asks again: the ask's count is not the fact, the refusal's
		// one line is.
		expect(chain.planeAsks.length).toBeGreaterThan(1);

		// The Message line carries nothing about a merge that is landing: the
		// refusal is a hold on work the plane already entered, not a start that
		// could not run.
		expect(statuses.filter((status) => status.text.includes("could not merge"))).toEqual([]);
		// The refusal still reaches the record, once for the run that stands, in
		// the one shape every refusal line wears (issue #223, ADR 0104).
		expect(lines.filter((line) => line.message.startsWith("merge refused:"))).toEqual([
			warnLine(
				'merge refused: "Persist source facts in state" (already has a merge running; the first run stands)',
			),
		]);
		// The walk takes the refusal as a standing gate, the way it takes the rest:
		// the record states the hold in the holds' own voice.
		expect(lines).toContainEqual(
			infoLine(
				'automatic walks hold: the Ticket\'s merge is already running ("Persist source facts in state")',
			),
		);

		// The merge the walk used to call a failure is the merge that lands, once.
		chain.releaseHeld();
		const attempt = await chain.awaitAttempt();
		expect(attempt).toMatchObject({ outcome: "merged", decision: "auto-merged" });
		expect(runner.commands().filter((command) => command.startsWith("gh pr merge"))).toHaveLength(
			1,
		);
		state.close();
	});
});

describe("the seat a settling turn frees (the dev-run miss on PR #206)", () => {
	test("the settled turn's continuation takes the freed seat ahead of the standing open-ticket item", async () => {
		// One seat, and the seat count reads the probe's agent list the way
		// the app wires it. The run is the recorded one: a chain's turn is in
		// flight, an open ticket's item stands in the queue, the chain's turn
		// ends, and the queue's item takes the seat the chain owes itself.
		const chain = chainRig({ maxParallelAgents: 1, liveSeats: true });
		const { state, coordinator } = chain;
		chain.landPulls(pullTicket(["ready-for-review"]), reworkPullTicket());

		// The chain's ticket is in flight on its rework, its own agent live in
		// its pane. The seat is full.
		const runningAttempt = chain.seedRunningTurn(pullIdentity, "rework");
		chain.setAgents([
			{
				paneId: `pane-${pullIdentity}`,
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "",
				agent: "pi",
				status: "working",
			},
		]);

		// Cycle 1: the seat is full with the chain's running rework, so the
		// top-up's open-ticket add lands in the queue and stands there.
		await coordinator.tick();
		expect(state.workQueue.items()).toEqual([
			expect.objectContaining({
				kind: "handoff",
				origin: "open",
				automatic: true,
				ticketIdentity: otherPullIdentity,
				choice: expect.objectContaining({ taskType: "rework" }),
			}),
		]);
		expect(state.ticketWorkCycle.ticketsByState(["handed-off", "running"])).toHaveLength(1);

		// The chain's turn ends. Its fire writes ready-for-review on its own
		// pull request and derives its Next step there: the review. Its agent is
		// gone, so the seat it held stands free.
		const reworkRun = await chain.settleRunningTurnWithFire(pullIdentity, "rework", runningAttempt);
		expect(reworkRun).toMatchObject({
			fired: true,
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
		});
		chain.setAgents([]);

		// Cycle 2: the freed seat, and the two asks for it.
		await coordinator.tick();
		await chain.awaitHandoffInFlight();

		// The seat the settling turn freed went to that turn's own continuation:
		// the review claimed it, and the open ticket's item is the one that waits.
		expect(chain.handoffAsks).toContainEqual(
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: pullIdentity,
				routeFromIdentity: pullIdentity,
				choice: expect.objectContaining({ taskType: "review" }),
			}),
		);
		// The claim that holds the seat is the review's, and the held herdr call
		// is the review agent's own start.
		expect(state.handoff.openAttemptTickets()).toEqual([pullIdentity]);
		expect(chain.heldCommands()).toEqual([
			expect.stringContaining(
				`herdr agent start ${agentNameFor({ identity: pullIdentity, title: "Persist source facts in state" })}`,
			),
		]);
		expect(
			state.workQueue.items().map((item) => {
				if (item.kind !== "handoff") throw new Error("the queue holds no handoff item");
				return [item.ticketIdentity, item.origin];
			}),
		).toEqual([
			// The continuation stands first, and the open ticket's item waits behind
			// it: the seat the settling turn freed went to the settled turn's own
			// next step.
			[pullIdentity, "workflow"],
			[otherPullIdentity, "open"],
		]);
		state.close();
	});

	test("the settled turn's continuation takes the freed seat ahead of the row the operator staged", async () => {
		const PULL_TITLE = "Persist source facts in state";
		const STAGED_TITLE = "Hold the seat for the chain";
		// The dev-run miss on PR #215: one seat, the chain's turn in flight, and
		// the row standing in the queue is the operator's own staging of a fresh
		// ticket, not the factory's fresh work. The chain's turn ends, and the seat
		// it freed went to the operator's row while the review the settled turn owed
		// never ran and its workspace stood open.
		const chain = chainRig({ maxParallelAgents: 1, liveSeats: true });
		const { state, coordinator } = chain;
		chain.landPulls(pullTicket(["ready-for-review"]), reworkPullTicket());

		const runningAttempt = chain.seedRunningTurn(pullIdentity, "rework");
		chain.setAgents([
			{
				paneId: `pane-${pullIdentity}`,
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "",
				agent: "pi",
				status: "working",
			},
		]);

		// The operator stages the fresh ticket by hand while the seat is full.
		await expect(
			chain.dispatch.dispatch({
				origin: "open",
				ticketIdentity: otherPullIdentity,
				choice: {
					agentType: "pi",
					environment: "worktree",
					taskType: "rework",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				previousMessage: "",
			}),
		).resolves.toEqual({ ok: true });

		// Cycle 1: the seat is full with the chain's running rework, and the queue
		// holds the operator's row.
		await coordinator.tick();
		expect(state.workQueue.items()).toEqual([
			expect.objectContaining({
				kind: "handoff",
				origin: "open",
				automatic: false,
				ticketIdentity: otherPullIdentity,
			}),
		]);

		// The chain's turn ends, and its agent is gone: the seat stands free, and
		// the review stands on the chain's own pull request.
		const reworkRun = await chain.settleRunningTurnWithFire(pullIdentity, "rework", runningAttempt);
		expect(reworkRun).toMatchObject({
			fired: true,
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
		});
		chain.setAgents([]);

		// Cycle 2: the freed seat, and the two asks for it.
		await coordinator.tick();
		await chain.awaitHandoffInFlight();

		// The seat the settling turn freed goes to that turn's own next step, and
		// the row the operator staged is the one that waits (ADR 0100).
		expect(chain.handoffAsks).toContainEqual(
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: pullIdentity,
				routeFromIdentity: pullIdentity,
				choice: expect.objectContaining({ taskType: "review" }),
			}),
		);
		expect(state.handoff.openAttemptTickets()).toEqual([pullIdentity]);
		expect(
			state.workQueue.items().map((item) => {
				if (item.kind !== "handoff") throw new Error("the queue holds no handoff item");
				return [item.ticketIdentity, item.origin, item.automatic];
			}),
		).toEqual([
			[pullIdentity, "workflow", true],
			[otherPullIdentity, "open", false],
		]);
		// The record the run could not make then (issue #223). The restart
		// candidate the walk reads holds its startup grace, the operator's row
		// and the factory's own row read differently on one origin, the hold the
		// fresh-work walk took is stated, and the continuation the settled turn
		// owed stands in the file with the path that started it. Every line of
		// this chain is a fact about the run, not a warning, so each carries
		// `info`.
		expect(chain.lines).toEqual([
			infoLine(`handoff queued: "${STAGED_TITLE}" (origin open, operator-staged)`),
			infoLine(`automatic walks hold: the Ticket's startup grace has not passed ("${PULL_TITLE}")`),
			infoLine("automatic walks hold: the Work queue holds a waiting row"),
			infoLine(`handoff queued: "${PULL_TITLE}" (origin workflow, automatic)`),
			infoLine(
				`handoff started: "${PULL_TITLE}" (mode pickup, origin workflow, automatic, seats 0/1)`,
			),
		]);
		state.close();
	});
});

/**
 * The cadence of the failed start's line, read at the observation seam (issue
 * #295 review).
 *
 * The dispatch's own suite pins the line's words. What the acceptance claims is
 * the cadence: the line follows the attempt and never the poll. The development
 * install ran exactly this shape - one Ticket whose start kept failing, asked
 * again on every observation cycle, 9,365 times over five days - so the test
 * walks the loop the plane runs: the automatic ask enqueues the row, the cycle's
 * pickup runs the start, herdr refuses it, and the attempt's own settle leaves
 * one line. The Attempt hold (ADR 0077 as extended by ADR 0101) then holds the
 * walk's re-ask until a source re-reads the Ticket, and the record stays what
 * it was. The next attempt is a start the factory made, and it states itself
 * again.
 */
describe("the failed start's line follows the attempt, not the cycle (issue #295)", () => {
	const failure = "the worktree path already exists";

	/** The record's lines that state how a start ended. */
	const failedLines = (lines: RecordedLine[]) =>
		lines.filter((line) => line.message.startsWith("handoff start failed:"));
	/** The record's lines that state that a start began. */
	const startedLines = (lines: RecordedLine[]) =>
		lines.filter((line) => line.message.startsWith("handoff started:"));

	test("the walk re-asks every cycle, and one failed start leaves one line", async () => {
		// A live seat, so the pickup's start really runs, and a herdr that refuses
		// it: the claim stands, the start ends, and the attempt settles `failed`.
		const chain = chainRig({ liveSeats: true });
		const { state, coordinator } = chain;
		chain.runner.set("herdr", ["workspace", "list"], { code: 1, stderr: failure });
		// One open Ticket, and no pull request standing for the walks to route.
		state.sourceFact.applyFetch(issuesSource, {
			status: "success",
			fetchedAt: "2026-08-31T10:00:00Z",
			tickets: [issueTicket()],
		});
		state.sourceFact.applyFetch(pullsSource, {
			status: "success",
			fetchedAt: "2026-08-31T10:00:00Z",
			tickets: [],
		});

		// The wait the loop implies: the pickup starts the handoff and answers
		// before the run ends, so the failed start's line lands after the tick.
		// The wait is polled, not budgeted: it returns as soon as the lines are
		// there, and the deadline only says how long a missing line takes to fail
		// the test, so a loaded machine slows the test down without reddening it.
		const awaitFailedLines = async (count: number): Promise<void> => {
			const deadline = Date.now() + 10_000;
			for (;;) {
				if (failedLines(chain.lines).length === count) return;
				if (Date.now() > deadline) throw new Error(`no ${count} failed-start line in the record`);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		};

		// Cycle 1: the walk's ask, and the row it leaves in the Work queue.
		await coordinator.tick();
		expect(state.workQueue.hasWorkItem(issueIdentity)).toBe(true);
		// Cycle 2: the cycle's pickup takes the row and runs the start, and herdr
		// refuses it. The start's own line and its ending stand together.
		await coordinator.tick();
		await awaitFailedLines(1);
		expect(failedLines(chain.lines)).toEqual([
			warnLine(`handoff start failed: "Persist source facts" (${failure})`),
		]);
		// The hold is what stands between the walk and the same failing start.
		expect(state.handoff.handoffBlockedUnrefreshed(issueIdentity)).toBe(true);
		// The cycles the development install ran for five days. Each one reaches
		// the same gate and asks nothing, and the attempt that already settled has
		// nothing new to say on any of them.
		await coordinator.tick();
		await coordinator.tick();
		await coordinator.tick();
		expect(failedLines(chain.lines)).toHaveLength(1);
		// The release: an active source re-reads the Ticket, and the walk asks it
		// again. The next ask is a new attempt, and it ends the same way.
		state.sourceFact.applyFetch(issuesSource, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [issueTicket()],
		});
		await coordinator.tick();
		await coordinator.tick();
		await awaitFailedLines(2);
		// Reading the record for this Ticket answers how many starts the factory
		// made and why each one ended: one ending line per start line, and no line
		// for a cycle that started nothing. The two attempts are the ledger's own.
		expect(startedLines(chain.lines)).toHaveLength(2);
		expect(failedLines(chain.lines)).toEqual([
			warnLine(`handoff start failed: "Persist source facts" (${failure})`),
			warnLine(`handoff start failed: "Persist source facts" (${failure})`),
		]);
		expect(state.handoff.handoffCount(issueIdentity)).toBe(2);
		chain.dispatch.stop();
		state.close();
	});
});

/**
 * The two tickets of one cycle share the worktree (ADR 0112).
 *
 * The acceptance: the issue and the pull request its cycle opens work one
 * worktree and one workspace, on the issue's factory branch. The review's
 * start is the seam that proves it: it resolves the branch the pull request
 * holds against the checkout, finds the worktree the implementation left on
 * that branch, and reuses its workspace instead of building the pull request
 * ticket's numbered branch from the Worktree base.
 */
describe("the pair of one cycle shares its worktree (ADR 0112)", () => {
	test(
		"the review start of the issue's pull request works the issue's factory branch " +
			"in the implementation's worktree",
		async () => {
			// A live seat, so the continuation's start really runs, and the
			// worktree Environment, so the start builds the Environment its branch
			// statement names.
			const chain = chainRig({ liveSeats: true, defaultEnvironment: "worktree" });
			const { state, runner, coordinator } = chain;
			const checkout = chain.checkout;
			if (checkout === null) throw new Error("the live rig holds no checkout");

			// The pair: the pull request's head is the issue's factory branch, the
			// branch the implementation's cycle works.
			chain.refresh(issueTicket(["ready-for-agent"]), pullTicketWithHead());

			// The issue's cycle is in flight: its implementation turn runs, and the
			// seat it holds stands full.
			const runningAttempt = chain.seedRunningTurn(issueIdentity, "implement");
			chain.setAgents([
				{
					paneId: `pane-${issueIdentity}`,
					tabId: "tab-1",
					workspaceId: "ws-1",
					sessionId: "",
					agent: "pi",
					status: "working",
				},
			]);

			// The implementation ends: its fire writes ready-for-review on the
			// linked pull request and derives the review there. Its agent is gone,
			// and the seat stands free. The implementation's worktree still stands
			// on the issue's factory branch, and its workspace still holds.
			const implementRun = await chain.settleRunningTurnWithFire(
				issueIdentity,
				"implement",
				runningAttempt,
			);
			expect(implementRun).toMatchObject({
				fired: true,
				pullRequestIdentity: pullIdentity,
				pullRequestWrite: { added: ["ready-for-review"], removed: [] },
				positionTaskType: "review",
				positionTicketIdentity: pullIdentity,
			});
			chain.setAgents([]);

			// The branch the review works stands in the checkout, in the worktree
			// the implementation left, and herdr's open finds the worktree in its
			// own workspace.
			const implWorkspace = "ws-1";
			const implWorktreePath = "/worktrees/factory-5-persist-source-facts";
			runner.set("git", ["-C", checkout, "branch", "--list", ISSUE_FACTORY_BRANCH], {
				stdout: `  ${ISSUE_FACTORY_BRANCH}\n`,
			});
			runner.set(
				"herdr",
				["worktree", "open", "--cwd", checkout, "--branch", ISSUE_FACTORY_BRANCH, "--no-focus"],
				{
					stdout: worktreeOpenJson(implWorkspace, "pane-impl", {
						alreadyOpen: true,
						worktreePath: implWorktreePath,
					}),
				},
			);
			runner.set(
				"herdr",
				["tab", "create", "--workspace", implWorkspace, "--cwd", implWorktreePath, "--no-focus"],
				{ stdout: tabCreateJson("pane-review", "tab-review") },
			);

			// The freed seat, and the continuation's start running inside the held
			// herdr call.
			await coordinator.tick();
			await chain.awaitHandoffInFlight();

			// The seat the settling turn freed went to that turn's own next step:
			// the review on the pull request, claimed and running.
			expect(state.handoff.openAttemptTickets()).toEqual([pullIdentity]);
			expect(chain.heldCommands()).toEqual([
				expect.stringContaining(
					`herdr agent start ${agentNameFor({ identity: pullIdentity, title: "Persist source facts in state" })}`,
				),
			]);
			const commands = runner.commands();
			// The review works the branch the pull request holds - the issue's
			// factory branch - and the open finds it in the implementation's
			// workspace, where a fresh tab lands.
			expect(commands).toContain(`git -C ${checkout} branch --list ${ISSUE_FACTORY_BRANCH}`);
			expect(commands).toContain(
				`herdr worktree open --cwd ${checkout} --branch ${ISSUE_FACTORY_BRANCH} --no-focus`,
			);
			expect(commands).toContain(
				`herdr tab create --workspace ${implWorkspace} --cwd ${implWorktreePath} --no-focus`,
			);
			// The pull request ticket's numbered branch is never named: nothing is
			// created, fetched, or built from the Worktree base.
			expect(commands.find((command) => command.includes("factory/12-"))).toBeUndefined();
			expect(commands.find((command) => command.includes("worktree create"))).toBeUndefined();
			state.close();
		},
	);
});

/**
 * The bug position's machine (issue #330, ADR 0116).
 *
 * The acceptance the ADR's brake claim carries, as one run on the chain's
 * rig: an issue the source labels `bug` and no stronger label claims stands
 * on the diagnosis position. The Open walk offers the `diagnose` type, and
 * the Operator-decides brake holds the machine's ask of it (ADR 0117), so
 * the operator's own Handoff is the start: its row takes the queue, the
 * start opens the draft pull request on the issue's factory
 * branch before the Agent stands, and the settled turn's Transition publishes
 * the draft and writes `ready-for-review` on it. The Operator-decides brake
 * parks the turn for the operator, the operator's close re-derives the issue
 * to open, and from there the issue rests behind its Fixing pull request -
 * the list rule's coverage withholds it from the pile - while the pull
 * request, on the label the fire wrote, runs the review machine in the
 * worktree the diagnosis left, the pair's shared worktree (ADR 0112).
 *
 * Every hop runs through the real modules, the way the chain's cases do: the
 * observation cycle and its walks, the dispatch's claim and pickup, the real
 * start with its worktree build and its pull request open, and the transition
 * fire with its publish and its label writes. The doubles are the suite's
 * standing ones, and the Agent start is the hop the rig holds back, the way
 * the chain holds it.
 */
describe("the bug position runs the diagnosis machine (issue #330, ADR 0116)", () => {
	/** The machine the ADR gates on the source's own type label. */
	const BUG_STATES: FactoryConfig["workflowStates"] = [
		{
			name: "bug",
			taskType: "diagnose",
			match: { sourceKind: "github-issue", labelsAny: ["bug"] },
		},
		{
			name: "ready-for-review",
			taskType: "review",
			match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
		},
	];
	const BUG_TYPES: FactoryConfig["taskTypes"] = {
		diagnose: {
			template:
				"/skill:diagnosing-bugs\n\nRepository: {repository}\n\n{external-key}: {title}\n\n" +
				"URL: {source-url}\n\nPull request: {pull-request-url}\n\nLabels: {labels}\n\n" +
				"Description:\n{description}\n\n" +
				"Previous session message (empty on a first session): {previous-message}",
			thinking: "xhigh",
			operatorDecides: true,
			opensPullRequest: true,
			transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review"] },
		},
		review: { template: "review" },
	};
	/** The direct head-branch read, in the exact argv the open and the fire issue. */
	const OWN_DRAFT_READ_ARGS = [
		"api",
		"--hostname",
		"github.com",
		// The read's path carries the repository's display name, the way the
		// source builds it; the gh commands take the repository's identity.
		`repos/acme/factory/pulls?state=open&head=acme%3Afactory%2F5-persist-source-facts`,
	];
	/** The draft the plane opened, as the direct read answers it. */
	const OWN_DRAFT_RECORD = {
		number: 12,
		state: "open",
		draft: true,
		html_url: "https://github.com/acme/factory/pull/12",
		head: { ref: ISSUE_FACTORY_BRANCH },
		base: { ref: "main" },
		labels: [],
	};
	/** The body the plane writes on the open, closing the issue. */
	const OPEN_BODY =
		"Closes #5\n\nhttps://github.com/acme/factory/issues/5\n\nKeep state independent from GitHub.";

	test(
		"a bug-labeled issue offers diagnose, the Handoff opens the draft pull request, " +
			"the settled turn writes ready-for-review, the issue rests behind its Fixing " +
			"pull request, and the pull request runs the review machine",
		async () => {
			const chain = chainRig({
				liveSeats: true,
				defaultEnvironment: "worktree",
				workflowStates: BUG_STATES,
				taskTypes: BUG_TYPES,
			});
			const { state, runner, coordinator } = chain;
			const checkout = chain.checkout;
			if (checkout === null) throw new Error("the live rig holds no checkout");

			// One open issue the source labels `bug`, no pull request standing yet:
			// the position the machine gates on the source's own type label.
			state.sourceFact.applyFetch(issuesSource, {
				status: "success",
				fetchedAt: "2026-08-31T10:00:00Z",
				tickets: [issueTicket(["bug"])],
			});
			state.sourceFact.applyFetch(pullsSource, {
				status: "success",
				fetchedAt: "2026-08-31T10:00:00Z",
				tickets: [],
			});

			// The start's environment and the pull request open, on the issue's
			// factory branch, fresh on both copies: the base off origin's default
			// branch, the hold commit on a branch the remote does not carry, the
			// push, and the draft the open creates.
			runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
				stdout: "refs/remotes/origin/main\n",
			});
			runner.set(
				"git",
				["-C", checkout, "rev-parse", ISSUE_FACTORY_BRANCH, `${ISSUE_FACTORY_BRANCH}^{tree}`],
				{ stdout: "tip-sha\ntree-sha\n" },
			);
			runner.set(
				"git",
				[
					"-C",
					checkout,
					"commit-tree",
					"tree-sha",
					"-p",
					"tip-sha",
					"-m",
					"factory: hold the branch for the pull request",
				],
				{ stdout: "hold-sha\n" },
			);
			runner.set(
				"git",
				["-C", checkout, "update-ref", `refs/heads/${ISSUE_FACTORY_BRANCH}`, "hold-sha"],
				{ code: 0 },
			);
			runner.set(
				"herdr",
				[
					"worktree",
					"create",
					"--cwd",
					checkout,
					"--branch",
					ISSUE_FACTORY_BRANCH,
					"--base",
					"origin/main",
					"--no-focus",
				],
				{ stdout: worktreeCreateJson("ws-diag", "pane-diag") },
			);
			// The one direct read, twice: the start's open finds no pull request
			// yet, and the fire's publish read finds the draft it created.
			runner.setSequence("gh", OWN_DRAFT_READ_ARGS, [
				{ stdout: "[]" },
				{ stdout: JSON.stringify([OWN_DRAFT_RECORD]) },
			]);
			runner.set(
				"gh",
				[
					"pr",
					"create",
					"--repo",
					repoIdentity,
					"--head",
					ISSUE_FACTORY_BRANCH,
					"--draft",
					"--title",
					"Persist source facts",
					"--body",
					OPEN_BODY,
				],
				{ stdout: "https://github.com/acme/factory/pull/12\n" },
			);
			// The fire's publish: the work test of the head against the base, the
			// ready mark of the draft, and the label write on it.
			runner.set("git", ["-C", checkout, "fetch", "origin", ISSUE_FACTORY_BRANCH, "main"], {
				code: 0,
			});
			runner.set(
				"git",
				["-C", checkout, "diff", "--quiet", "origin/main", `origin/${ISSUE_FACTORY_BRANCH}`],
				{ code: 1 },
			);
			runner.set("gh", ["pr", "ready", "12", "--repo", repoIdentity], { code: 0 });
			runner.set(
				"gh",
				["pr", "edit", "#12", "--repo", repoIdentity, "--add-label", "ready-for-review"],
				{
					code: 0,
				},
			);

			// Cycle 1: the bug position offers the diagnosis, and the Operator-
			// decides brake holds the machine's ask of it (ADR 0117): the walk
			// holds the Ticket only, and the silence is designed, the way the
			// parking state's is. The operator's own Handoff is the start that
			// the brake leaves, and its row takes the queue.
			await coordinator.tick();
			expect(chain.handoffAsks).toEqual([]);
			expect(state.workQueue.items()).toHaveLength(0);
			expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("open");
			await expect(
				chain.dispatch.dispatch({
					origin: "open",
					ticketIdentity: issueIdentity,
					choice: {
						agentType: "pi",
						environment: "worktree",
						taskType: "diagnose",
						model: "",
						thinking: "xhigh",
						contextWindow: "",
					},
					previousMessage: "",
				}),
			).resolves.toEqual({ ok: true });
			expect(state.workQueue.items()).toEqual([
				expect.objectContaining({
					kind: "handoff",
					origin: "open",
					automatic: false,
					ticketIdentity: issueIdentity,
				}),
			]);

			// Cycle 2: the pickup takes the row and runs the start: the worktree
			// stands on the factory branch, the branch is pushed with its hold
			// commit, the Handoff opens the draft pull request, and the gate
			// holds the Agent start behind it.
			await coordinator.tick();
			await chain.awaitHandoffInFlight();
			expect(state.handoff.openAttemptTickets()).toEqual([issueIdentity]);
			expect(chain.heldCommands()).toEqual([
				expect.stringContaining(
					`herdr agent start ${agentNameFor({
						identity: issueIdentity,
						title: "Persist source facts",
					})} --kind pi --pane pane-diag -- --thinking xhigh`,
				),
			]);
			const startCommands = runner.commands();
			// The plane's own push, with the bypass of the contributor pre-push hook
			// (ADR 0127): the hook reads the checkout it stands in, and the only
			// commit here is the plane's hold commit.
			expect(startCommands).toContain(
				`git -C ${checkout} push ${BYPASS_CONTRIBUTOR_PUSH_HOOK.join(" ")} origin ${ISSUE_FACTORY_BRANCH}`,
			);
			expect(
				startCommands.some((command) =>
					command.startsWith(
						`gh pr create --repo ${repoIdentity} --head ${ISSUE_FACTORY_BRANCH} --draft --title Persist source facts --body Closes #5`,
					),
				),
			).toBe(true);

			// The gate lets the start through: the agent stands, the prompt
			// lands, the attempt settles agent-started, and the start lets the
			// shared checkout go (ADR 0109), the way the diagnosis's end does on
			// a real run.
			const settled = chain.awaitStartSettled(issueIdentity);
			chain.releaseHeld();
			await settled;
			expect(state.handoff.openAttemptTickets()).toEqual([]);
			expect(state.handoff.latestHandoff(issueIdentity)).toMatchObject({
				paneId: "pane-diag",
				tabId: "tab-ws-diag",
				workspaceId: "ws-diag",
			});
			// The agent works: its turn stands in the probe the way a started
			// Agent does.
			chain.setAgents([
				{
					paneId: "pane-diag",
					tabId: "tab-ws-diag",
					workspaceId: "ws-diag",
					sessionId: "",
					agent: "pi",
					status: "working",
				},
			]);

			// The diagnosis turn settles: the fire reaches the ticket's own
			// draft through the direct head-branch read, because a draft the
			// machine has not labeled never stands in the ticket list. The
			// refresh that lands the published pull request stands behind the
			// publish, the way the source's next refresh does.
			const settledHandoff = state.handoff.latestHandoff(issueIdentity);
			if (settledHandoff === null) throw new Error("the diagnosis handoff never settled");
			const attemptId = settledHandoff.handoffId;
			chain.landPulls(pullTicketWithHead());
			const outcome = await chain.settleRunningTurnWithFire(issueIdentity, "diagnose", attemptId);
			expect(outcome).toMatchObject({
				fired: true,
				writeFailure: "",
				pullRequestWrite: { added: ["ready-for-review"], removed: [] },
				positionTaskType: "review",
				positionTicketIdentity: pullIdentity,
			});
			expect(runner.commands()).toContain(`gh pr ready 12 --repo ${repoIdentity}`);
			expect(runner.commands()).toContain(
				`gh pr edit #12 --repo ${repoIdentity} --add-label ready-for-review`,
			);
			// The Operator-decides brake (ADR 0085): the settled turn rests in
			// awaiting, and the machine decides nothing on it.
			expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("awaiting");

			// The source's next refresh overwrites the label the fire wrote, and
			// the review start of the pair works the branch the pull request
			// holds in the worktree the diagnosis left (ADR 0112): the branch
			// stands in the checkout, and the open finds the worktree in its
			// workspace, where a fresh tab lands.
			chain.landPulls(pullTicketWithHead(["ready-for-review"]));
			const implWorktreePath = "/worktrees/factory-5-persist-source-facts";
			runner.set("git", ["-C", checkout, "branch", "--list", ISSUE_FACTORY_BRANCH], {
				stdout: `  ${ISSUE_FACTORY_BRANCH}\n`,
			});
			runner.set(
				"herdr",
				["worktree", "open", "--cwd", checkout, "--branch", ISSUE_FACTORY_BRANCH, "--no-focus"],
				{
					stdout: worktreeOpenJson("ws-diag", "pane-diag", {
						alreadyOpen: true,
						worktreePath: implWorktreePath,
					}),
				},
			);
			runner.set(
				"herdr",
				["tab", "create", "--workspace", "ws-diag", "--cwd", implWorktreePath, "--no-focus"],
				{ stdout: tabCreateJson("pane-review", "tab-review") },
			);

			// Cycle 3: the parked turn stays parked, and the open walk asks the
			// review on the pull request the diagnosis published. The issue's own
			// row never re-enters the walk's asks: its start is the operator's,
			// and the brake stands on its type.
			await coordinator.tick();
			expect(state.ticketWorkCycle.lastCompletion(issueIdentity)?.decision).toBe(null);
			expect(chain.handoffAsks).toEqual([
				expect.objectContaining({
					origin: "open",
					automatic: true,
					ticketIdentity: pullIdentity,
					choice: expect.objectContaining({ taskType: "review", environment: "worktree" }),
				}),
			]);
			expect(state.workQueue.items()).toEqual([
				expect.objectContaining({ kind: "handoff", origin: "open", ticketIdentity: pullIdentity }),
			]);

			// The operator's close is the gate out of the parked turn (ADR 0085),
			// and the issue re-derives to open behind the pull request that fixes
			// it: the two brakes that keep it off the pile stand, coverage and
			// the Same-type hold.
			expect(
				state.ticketWorkCycle.applyCompletionDecision({
					ticketIdentity: issueIdentity,
					handoffId: attemptId,
					decision: "closed",
					decidedAt: "2026-08-31T11:05:00.000Z",
				}),
			).toBe(true);
			expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("open");
			const projection = state.ticketWorkCycle.projectedTickets(
				CHAIN_CONFIG.workflowStates,
				CHAIN_CONFIG.defaultTaskType,
			);
			const issueRow = projection.find((row) => row.identity === issueIdentity);
			if (issueRow === undefined) throw new Error("the issue left the projection");
			expect(isCoveredByFixingPullRequest(projection, issueRow)).toBe(true);
			expect(state.ticketWorkCycle.sameTypeHoldActive(issueIdentity, "diagnose")).toBe(true);

			// Cycle 4: the pickup takes the review's row, and the start works
			// the branch the pull request holds in the worktree the diagnosis
			// left. The open walk asks nothing new: the issue is covered by
			// its Fixing pull request and the Same-type hold stands, and the
			// pull request's own row stands behind its in-flight attempt.
			await coordinator.tick();
			await chain.awaitHandoffInFlight(2);
			expect(state.handoff.openAttemptTickets()).toEqual([pullIdentity]);
			expect(chain.heldCommands()).toEqual([
				expect.stringContaining(
					`herdr agent start ${agentNameFor({ identity: issueIdentity, title: "Persist source facts" })}`,
				),
				expect.stringContaining(
					`herdr agent start ${agentNameFor({
						identity: pullIdentity,
						title: "Persist source facts in state",
					})} --kind pi --pane pane-review`,
				),
			]);
			const reviewCommands = runner.commands();
			expect(reviewCommands).toContain(
				`herdr worktree open --cwd ${checkout} --branch ${ISSUE_FACTORY_BRANCH} --no-focus`,
			);
			expect(reviewCommands).toContain(
				`herdr tab create --workspace ws-diag --cwd ${implWorktreePath} --no-focus`,
			);
			// The pair shares the worktree (ADR 0112): the pull request ticket's
			// numbered branch is never named, and nothing is built from the
			// Worktree base for it.
			expect(reviewCommands.find((command) => command.includes("factory/12-"))).toBeUndefined();
			// The issue never re-enters the pile: the walk asked nothing more.
			expect(chain.handoffAsks).toHaveLength(1);
			// The review's row stands in the queue until its start settles, the
			// way the chain's held starts keep theirs.
			expect(state.workQueue.items()).toEqual([
				expect.objectContaining({ kind: "handoff", origin: "open", ticketIdentity: pullIdentity }),
			]);
			state.close();
		},
	);
});
