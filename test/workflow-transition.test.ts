/**
 * The settled turn's fire (issue #430, ADR 0153): the fire's refresh asks the
 * ticket's own pull request sources, and the settling tickets settle side by
 * side.
 *
 * The suite boots the real app over the Stub herdr world with real GitHub
 * ticket sources, so every fetch of the refresh the fire awaits lands as a
 * `gh api graphql` command on the egress runner: a fetch against a source the
 * ticket's membership does not name shows up in the runner's command list and
 * fails the pin. The outside measurement is the command list beside the state
 * the settlements write; no test reaches inside the plane.
 *
 * The turn ends the way the plane reads it: the world holds the agent's
 * session record, and the test moves the agent to a settle state when the
 * turn is done. The sources answer from pinned GraphQL pages; a test that
 * needs a fetch to answer differently across rounds names a sequence.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FactoryConfig, TicketSourceConfig } from "../src/config.ts";
import { withHeadBranch, withIssueReferences } from "../src/domain/ticket.ts";
import { agentNameFor } from "../src/naming.ts";
import type { FactoryState } from "../src/state.ts";
import { createTicketSource, type FetchOutcome, SEARCH_QUERY } from "../src/ticket-source.ts";
import { NO_LINKED_PULL_REQUEST_SKIP } from "../src/workflow.ts";
import {
	HEIGHT,
	pressControl,
	sleep,
	WIDTH,
	waitCommands,
	waitUntil,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";
import {
	type StubHerdrWorld,
	stubHerdrWorld,
	type WorldAgentDescription,
	type WorldEgress,
	worldEgress,
} from "./herdr-world.ts";
import { type Plane, plane, reopenState } from "./plane.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const host = "github.com";
const factoryOwner = "acme/factory";
const otherOwner = "acme/other";
const factoryRepo = `${host}/${factoryOwner}`;
const otherRepo = `${host}/${otherOwner}`;
const issueIdentity = "github:github.com:I_5";
const pullIdentity = "github:github.com:P_12";
const secondPullIdentity = "github:github.com:P_22";
const otherPullIdentity = "github:github.com:P_99";

import { DEFAULT_TICKET_TITLE } from "./fact-fixtures.ts";

const ISSUE_TITLE = DEFAULT_TICKET_TITLE;
const PULL_TITLE = "Fix the projection the fire reads";
const SECOND_PULL_TITLE = "Fix the second projection";
const OTHER_PULL_TITLE = "An unrelated pull request";

/** The three sources every world in this suite runs on: the source's
 * `repositories` carry the owner name the API's `nameWithOwner` answers, and
 * the source answers them as the `host/owner/name` repository identity. */
const issuesSource: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: [factoryOwner],
	host,
};
const pullsSource: TicketSourceConfig = {
	name: "pulls",
	kind: "github-pull-requests",
	refreshIntervalSeconds: 60,
	repositories: [factoryOwner],
	host,
};
const othersSource: TicketSourceConfig = {
	name: "others",
	kind: "github-pull-requests",
	refreshIntervalSeconds: 60,
	repositories: [otherOwner],
	host,
};

/** The one search query the issues source issues per repository. */
const issuesQuery = `is:open is:issue repo:${factoryOwner} -label:blocked`;
/** The two search queries a pull request source issues per repository. */
const pullsQueries = [
	`is:open is:pr repo:${factoryOwner} -label:blocked label:needs-work`,
	`is:open is:pr repo:${factoryOwner} -label:blocked no:draft`,
];
const othersQueries = [
	`is:open is:pr repo:${otherOwner} -label:blocked label:needs-work`,
	`is:open is:pr repo:${otherOwner} -label:blocked no:draft`,
];

/** The owner name one repository identity carries, from the identity itself. */
function ownerOf(repository: string): string {
	return repository.startsWith(`${host}/`) ? repository.slice(host.length + 1) : repository;
}

/** The one GraphQL page a source answers with, shaped as the API answers it. */
function pageJson(nodes: unknown[]): string {
	return JSON.stringify({
		data: {
			rateLimit: { cost: 1 },
			search: { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false } },
		},
	});
}

/** The node one issues source search page holds. */
function issueNode(number: number, title: string, labels: string[]): unknown {
	return {
		__typename: "Issue",
		id: `I_${number}`,
		number,
		title,
		body: `${title}: the issue's body.`,
		url: `https://${host}/${factoryOwner}/issues/${number}`,
		state: "OPEN",
		updatedAt: "2026-08-31T10:00:00Z",
		labels: { nodes: labels.map((name) => ({ name })) },
		repository: {
			name: factoryOwner.split("/")[1] ?? factoryOwner,
			nameWithOwner: factoryOwner,
			url: `https://${host}/${factoryOwner}`,
		},
	};
}

/** The node one pull request source search page holds. */
function pullNode(
	number: number,
	repository: string,
	headBranch: string,
	fields: { title: string; labels: string[]; closing?: { number: number; repo: string }[] },
): unknown {
	const { title, labels, closing } = fields;
	const owner = ownerOf(repository);
	return {
		__typename: "PullRequest",
		id: `P_${number}`,
		number,
		title,
		body: `${title}: the pull request's body.`,
		url: `https://${host}/${owner}/pulls/${number}`,
		state: "OPEN",
		updatedAt: "2026-08-31T10:00:00Z",
		isDraft: false,
		headRefName: headBranch,
		labels: { nodes: labels.map((name) => ({ name })) },
		repository: {
			name: owner.split("/")[1] ?? owner,
			nameWithOwner: owner,
			url: `https://${host}/${owner}`,
		},
		...(closing === undefined
			? {}
			: {
					closingIssuesReferences: {
						nodes: closing.map((item) => ({
							id: `I_${item.number}`,
							number: item.number,
							repository: { nameWithOwner: ownerOf(item.repo) },
						})),
					},
				}),
	};
}

/** The head branch a ticket's work pushes from, by the ticket's number. */
function headBranchOf(number: number): string {
	return `factory/${number}-work-branch`;
}

/** The pull request page that lists the pull request fixing the issue ticket. */
const FIXING_PULLS_PAGE = pageJson([
	pullNode(12, factoryRepo, headBranchOf(12), {
		title: PULL_TITLE,
		labels: [],
		closing: [{ number: 5, repo: factoryRepo }],
	}),
]);
/** The pull request page that lists the other repository's queued pull request. */
const OTHER_PULL_PAGE = pageJson([
	pullNode(99, otherRepo, headBranchOf(99), { title: OTHER_PULL_TITLE, labels: ["queued"] }),
]);

/** One fetched ticket of the issues source, as a projection row. */
function issueTicket(number: number, labels: string[]) {
	return {
		identity: `github:github.com:I_${number}`,
		sourceKind: "github-issue",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://${host}/${factoryOwner}/issues/${number}`,
		title: ISSUE_TITLE,
		description: `${ISSUE_TITLE}: the issue's body.`,
		labels: [...labels],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: factoryRepo,
			displayName: factoryOwner,
			cloneUrl: `https://${factoryRepo}.git`,
		},
		attributes: {},
	};
}

/** One fetched ticket of a pull request source, as a projection row. */
function pullTicket(
	number: number,
	repository: string,
	fields: { title: string; labels: string[]; closing?: { number: number; repo: string }[] },
) {
	const { title, labels, closing } = fields;
	const attributes = withHeadBranch(
		closing === undefined || closing.length === 0
			? {}
			: withIssueReferences(
					{},
					closing.map((item) => ({
						identity: `github:github.com:I_${item.number}`,
						number: item.number,
						repository: ownerOf(item.repo),
					})),
				),
		headBranchOf(number),
	);
	return {
		identity: `github:github.com:P_${number}`,
		sourceKind: "github-pull-request",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://${host}/${ownerOf(repository)}/pulls/${number}`,
		title,
		description: `${title}: the pull request's body.`,
		labels: [...labels],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repository,
			displayName: ownerOf(repository),
			cloneUrl: `https://${repository}.git`,
		},
		attributes,
	};
}

/** The settled turn's session record: one final message, and the stop. */
function completedSession(): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "The turn is done." }],
		},
	});
}

/** The in-flight handoff one ticket carries, beside the agent that works it. */
interface InFlightTicket {
	identity: string;
	agent: string;
	paneId: string;
}

interface FireApp {
	state: FactoryState;
	world: StubHerdrWorld;
	github: FakeRunner;
	runner: WorldEgress;
	checkout: string;
	home: string;
	sessionPath: string;
}

/**
 * The state and the world one fire test runs on: the ticket's sources stand
 * on the test's projections, the in-flight handoffs claim and settle the way
 * the launch leaves them, and the world holds the agents on their panes with
 * the completed session record the turn ends on.
 */
function seedFireApp(fields: {
	inFlight: InFlightTicket[];
	outcomes: { issues: FetchOutcome; pulls: FetchOutcome; others: FetchOutcome };
}): FireApp {
	const stateDir = mkdtempSync(join(tmpdir(), "factory-fire-state-"));
	const home = mkdtempSync(join(tmpdir(), "factory-fire-home-"));
	const checkout = mkdtempSync(join(tmpdir(), "factory-fire-checkout-"));
	paths.push(stateDir, home, checkout);
	const state = reopenState(join(stateDir, "state.sqlite"));
	state.handoff.setAutoHandoffMode(true);
	const definitions = [
		{ name: "issues", kind: "github-issues" },
		{ name: "pulls", kind: "github-pull-requests" },
		{ name: "others", kind: "github-pull-requests" },
	];
	state.sourceFact.initializeSources(definitions);
	state.sourceFact.applyFetch(definitions[0], fields.outcomes.issues);
	state.sourceFact.applyFetch(definitions[1], fields.outcomes.pulls);
	state.sourceFact.applyFetch(definitions[2], fields.outcomes.others);
	for (const ticket of fields.inFlight) {
		const claim = state.handoff.claimHandoff(
			ticket.identity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				host: "herdr",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		const paneNumber = ticket.paneId.slice("pane-".length);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: ticket.paneId,
			tabId: `tab-${paneNumber}`,
			workspaceId: `ws-${paneNumber}`,
		});
	}
	const sessionPath = join(stateDir, "session.jsonl");
	writeFileSync(sessionPath, completedSession());
	writeFileSync(join(home, "config.toml"), "agent-poll-interval-seconds = 60\n");
	const checkoutPath = checkout;
	const agents: WorldAgentDescription[] = fields.inFlight.map((ticket) => ({
		name: ticket.agent,
		kind: "pi",
		status: "working",
		paneId: ticket.paneId,
		sessionId: sessionPath,
	}));
	const number = (paneId: string): string => paneId.slice("pane-".length);
	const world = stubHerdrWorld({
		checkouts: [
			{
				path: checkoutPath,
				cloneUrl: `https://${factoryRepo}.git`,
				defaultBranch: "main",
				worktreesRoot: join(dirname(checkoutPath), "worktrees"),
				branches: [{ name: "main", remote: true }],
				worktrees: [],
			},
		],
		workspaces: fields.inFlight.map((ticket) => ({
			id: `ws-${number(ticket.paneId)}`,
			checkoutPath,
		})),
		tabs: fields.inFlight.map((ticket) => ({
			id: `tab-${number(ticket.paneId)}`,
			workspaceId: `ws-${number(ticket.paneId)}`,
			cwd: checkoutPath,
		})),
		panes: fields.inFlight.map((ticket) => ({
			id: ticket.paneId,
			tabId: `tab-${number(ticket.paneId)}`,
			workspaceId: `ws-${number(ticket.paneId)}`,
		})),
		agents,
	});
	const github = new FakeRunner();
	const runner = worldEgress(world, github);
	return { state, world, github, runner, checkout, home, sessionPath };
}

/**
 * The plane the fire test boots: the seeded state, the test's task type
 * transition, and the real GitHub sources the refresh coordinator drives
 * through the egress runner. The settled turn's task type carries
 * Operator-decides, so a settled turn parks for the operator instead of
 * routing: the test pins the fire's facts, not the route it would start.
 */
async function planeOf(
	app: FireApp,
	transition: { ticketFacts: string[]; pullRequestFacts: string[] },
): Promise<Plane> {
	const config: FactoryConfig = {
		...BASE_CONFIG,
		repos: { [factoryRepo]: app.checkout, [otherRepo]: app.checkout },
		workflowStates: [
			{ name: "ready-for-review", taskType: "review", match: { labelsAny: ["ready-for-review"] } },
		],
		taskTypes: {
			...BASE_CONFIG.taskTypes,
			implement: {
				...BASE_CONFIG.taskTypes.implement,
				operatorDecides: true,
				transition,
			},
		},
	};
	return plane({
		agentHostEnv: { herdrEnv: "1" },
		config: { ...config, sources: [issuesSource, pullsSource, othersSource] },
		existing: app.state,
		groupingAxis: "none",
		runner: () => app.runner,
		prepare: async () => ({
			boundSources: [
				createTicketSource(issuesSource, app.runner),
				createTicketSource(pullsSource, app.runner),
				createTicketSource(othersSource, app.runner),
			],
		}),
	});
}

/** The one command a source's fetch issues per search page. */
function graphqlArgs(host: string, searchQuery: string): string[] {
	return [
		"api",
		"graphql",
		"--hostname",
		host,
		"-f",
		`query=${SEARCH_QUERY}`,
		"-f",
		`searchQuery=${searchQuery}`,
	];
}

const issuesArgs = graphqlArgs("github.com", issuesQuery);
const pullsArgs = pullsQueries.map((query) => graphqlArgs("github.com", query));
const othersArgs = othersQueries.map((query) => graphqlArgs("github.com", query));

/** A successful projection answer for the three sources. */
function success(tickets: unknown[], fetchedAt = "2026-08-31T10:01:00Z"): FetchOutcome {
	return { status: "success", fetchedAt, tickets: tickets as never[] };
}

/** The graphql commands the runner recorded, counted by the repository they search. */
function ghCount(github: FakeRunner, needle: string): number {
	return github.commands().filter((command) => command.includes(needle)).length;
}

/** The pull request pages counted out of the command list, by repository.
 * The issues source searches the same repository, so the plain repository
 * needle counts its pages too. */
function prPageCount(github: FakeRunner, repository: string): number {
	return github
		.commands()
		.filter((command) => command.includes("is:pr") && command.includes(`repo:${repository}`))
		.length;
}

/** The label write the fire runs on one pull request. */
function prEditCmd(number: number, repository: string): string {
	return `gh pr edit #${number} --repo ${repository} --add-label ready-for-review`;
}

/** The three sources' graphql answers the world's fetches receive: each
 * source stands on one page, or answers the boot page and the refresh page
 * in order. A fetch that must hold pins its delay on the runner itself. */
function pinSeeds(
	github: FakeRunner,
	issuePage: string,
	pullsPages: string | [string, string],
	othersPages: string | [string, string],
): void {
	github.set("gh", issuesArgs, { stdout: issuePage });
	if (Array.isArray(pullsPages)) {
		github.setSequence("gh", pullsArgs[0], [{ stdout: pullsPages[0] }, { stdout: pullsPages[1] }]);
		github.setSequence("gh", pullsArgs[1], [{ stdout: pullsPages[0] }, { stdout: pullsPages[1] }]);
	} else {
		github.set("gh", pullsArgs[0], { stdout: pullsPages });
		github.set("gh", pullsArgs[1], { stdout: pullsPages });
	}
	if (Array.isArray(othersPages)) {
		github.setSequence("gh", othersArgs[0], [
			{ stdout: othersPages[0] },
			{ stdout: othersPages[1] },
		]);
		github.setSequence("gh", othersArgs[1], [
			{ stdout: othersPages[0] },
			{ stdout: othersPages[1] },
		]);
	} else {
		github.set("gh", othersArgs[0], { stdout: othersPages });
		github.set("gh", othersArgs[1], { stdout: othersPages });
	}
}

/** The boot's one settled read of every source. */
async function waitBoot(app: ReturnType<typeof seedFireApp>): Promise<void> {
	await waitUntil(() => app.github.settledCommands().length === 5, "the boot's five source reads");
}

describe("the fire's refresh scope (issue #430, ADR 0153)", () => {
	test("a fire on a ticket in one pull request source refreshes only that source, before it writes the position", async () => {
		// Three sources stand: the issues feed, and two pull request sources on
		// two repositories. The ticket is the pull request P_12, listed by the
		// "pulls" source alone: its membership names no other source, so the
		// scoped refresh asks "pulls" and nothing else. A fetch against the
		// other pull request source, or against the issues source, would show
		// up in the command list and fail the pin.
		const agent = agentNameFor({ identity: pullIdentity, title: PULL_TITLE });
		const app = seedFireApp({
			inFlight: [{ identity: pullIdentity, agent, paneId: "pane-1" }],
			outcomes: {
				issues: success([]),
				pulls: success([pullTicket(12, factoryRepo, { title: PULL_TITLE, labels: ["queued"] })]),
				others: success([
					pullTicket(99, otherRepo, { title: OTHER_PULL_TITLE, labels: ["queued"] }),
				]),
			},
		});
		// The boot's read, and the fire's scoped refresh: the source answers
		// the boot's five pages from its standing, and the one page the refresh
		// fetches stands on the agent's work - the label the agent stood is
		// gone, the position the fire writes onto it.
		const bootPage = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: ["queued"] }),
		]);
		const freshPage = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: [] }),
		]);
		const otherPage = pageJson([
			pullNode(99, otherRepo, headBranchOf(99), { title: OTHER_PULL_TITLE, labels: ["queued"] }),
		]);
		pinSeeds(app.github, pageJson([]), [bootPage, freshPage], otherPage);

		const record = await planeOf(app, { ticketFacts: ["ready-for-review"], pullRequestFacts: [] });
		await withApp(
			async (setup) => {
				// The boot's one read of every source, settled.
				await waitBoot(app);
				// The turn ends: the agent stands idle on the completed record.
				app.world.setAgentStatus(agent, "idle", app.sessionPath);
				const edit = prEditCmd(12, factoryRepo);
				await waitCommands(() => app.runner.commands(), [edit], "the fire's label write");
				const commands = app.github.commands();
				// The boot's five pages, the fire's refresh of the ticket's
				// own source alone, and the write: no fetch against the other
				// pull request source, and none against the issues source.
				expect(commands).toHaveLength(8);
				expect(ghCount(app.github, "is:issue")).toBe(1);
				expect(prPageCount(app.github, otherOwner)).toBe(2);
				const pullsFetches = commands.filter(
					(command) => command.includes("is:pr") && command.includes("repo:acme/factory"),
				);
				expect(pullsFetches).toHaveLength(4);
				// The scoped refresh ran before the write: the ticket's own
				// source never leaves the refresh set (ADR 0079, on the scope
				// ADR 0153 pins).
				const editIndex = commands.indexOf(edit);
				expect(editIndex).toBeGreaterThan(commands.indexOf(pullsFetches[2]));
				expect(editIndex).toBeGreaterThan(commands.indexOf(pullsFetches[3]));
				// The outcome the fire lands on the refresh's projection.
				expect(app.state.ticketWorkCycle.lastCompletion(pullIdentity)?.transition).toEqual({
					fired: true,
					when: null,
					reason: "",
					ticketFacts: ["ready-for-review"],
					pullRequestFacts: [],
					ticketWrite: null,
					pullRequestWrite: { added: ["ready-for-review"], removed: [] },
					pullRequestIdentity: pullIdentity,
					pullRequestKey: "#12",
					writeFailure: "",
					positionTaskType: "review",
					positionTicketIdentity: pullIdentity,
				});
				expect(app.state.ticketWorkCycle.ticketState(pullIdentity)).toBe("awaiting");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: record,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		record.close();
	});

	test("a fire on a ticket whose sources list no pull request refreshes none, and stands on the projection the scheduled refresh landed", async () => {
		// The ticket is the issue I_5: its membership lists the issues source
		// alone, and the fire's refresh asks no pull request source. The fire
		// answers from the projection the scheduled refresh has landed - the
		// boot's read here - and finds the fixing pull request the agent
		// already pushed.
		const agent = agentNameFor({ identity: issueIdentity, title: ISSUE_TITLE });
		const app = seedFireApp({
			inFlight: [{ identity: issueIdentity, agent, paneId: "pane-1" }],
			outcomes: {
				issues: success([issueTicket(5, ["queued"])]),
				pulls: success([
					pullTicket(12, factoryRepo, {
						title: PULL_TITLE,
						labels: [],
						closing: [{ number: 5, repo: factoryRepo }],
					}),
				]),
				others: success([
					pullTicket(99, otherRepo, { title: OTHER_PULL_TITLE, labels: ["queued"] }),
				]),
			},
		});
		pinSeeds(
			app.github,
			pageJson([issueNode(5, ISSUE_TITLE, ["queued"])]),
			FIXING_PULLS_PAGE,
			OTHER_PULL_PAGE,
		);

		const record = await planeOf(app, { ticketFacts: [], pullRequestFacts: ["ready-for-review"] });
		await withApp(
			async (setup) => {
				await waitBoot(app);
				const settled = app.github.commands().length;
				app.world.setAgentStatus(agent, "idle", app.sessionPath);
				const edit = `gh pr edit #12 --repo ${factoryRepo} --add-label ready-for-review`;
				await waitCommands(
					() => app.runner.commands(),
					[edit],
					"the fire's label write on the fixing pull request",
				);
				// The fire refreshed none: the command list gained the write
				// and nothing else, the answer the fire already gives when the
				// config lists no pull request source.
				expect(app.github.commands()).toHaveLength(settled + 1);
				// The write lands on the fixing pull request, and the position
				// the fire derives rests on it.
				expect(app.state.ticketWorkCycle.lastCompletion(issueIdentity)?.transition).toEqual({
					fired: true,
					when: null,
					reason: "",
					ticketFacts: [],
					pullRequestFacts: ["ready-for-review"],
					ticketWrite: null,
					pullRequestWrite: { added: ["ready-for-review"], removed: [] },
					pullRequestIdentity: pullIdentity,
					pullRequestKey: "#12",
					writeFailure: "",
					positionTaskType: "review",
					positionTicketIdentity: pullIdentity,
				});
				expect(app.state.ticketWorkCycle.ticketState(issueIdentity)).toBe("awaiting");
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: record,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		record.close();
	});

	test("a fire whose refresh finds no fixing pull request records the skip it names", async () => {
		// The same issue, but the projection the fire reads lists no pull
		// request that fixes the ticket: the fire records the skip, derives
		// no position, and refreshes none, the way it does when the config
		// lists no pull request source at all.
		const agent = agentNameFor({ identity: issueIdentity, title: ISSUE_TITLE });
		const app = seedFireApp({
			inFlight: [{ identity: issueIdentity, agent, paneId: "pane-1" }],
			outcomes: {
				issues: success([issueTicket(5, ["queued"])]),
				pulls: success([]),
				others: success([]),
			},
		});
		pinSeeds(
			app.github,
			pageJson([issueNode(5, ISSUE_TITLE, ["queued"])]),
			pageJson([]),
			pageJson([]),
		);

		const record = await planeOf(app, { ticketFacts: [], pullRequestFacts: ["ready-for-review"] });
		await withApp(
			async (setup) => {
				await waitBoot(app);
				const settled = app.github.commands().length;
				app.world.setAgentStatus(agent, "idle", app.sessionPath);
				// The skip is a fact on the settled turn, not a held command:
				// wait for the settle the skip rides on.
				await waitUntil(
					() => app.state.ticketWorkCycle.ticketState(issueIdentity) === "awaiting",
					"the settled turn to park on the skip",
				);
				expect(app.state.ticketWorkCycle.lastCompletion(issueIdentity)?.transition).toEqual({
					fired: true,
					when: null,
					reason: NO_LINKED_PULL_REQUEST_SKIP,
					ticketFacts: [],
					pullRequestFacts: ["ready-for-review"],
					ticketWrite: null,
					pullRequestWrite: null,
					pullRequestIdentity: null,
					pullRequestKey: null,
					writeFailure: "",
					positionTaskType: null,
					positionTicketIdentity: null,
				});
				// The fire refreshed none, and wrote nothing: the command list
				// stands on the boot's five pages.
				expect(app.github.commands()).toHaveLength(settled);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: record,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		record.close();
	});

	test("a refresh that finds the fixing pull request re-fires the skip, and the sweep's fire pays the skip's ticket's scope", async () => {
		// The skip's ticket is the issue: it lists no pull request source, so
		// the re-fired fire pays no refresh of its own and answers from the
		// projection the operator's refresh just landed (ADR 0153). The
		// refresh is the operator's plane-wide read, the way the standing
		// world drives it, and the sweep settles the skip on the projection
		// it carries.
		const agent = agentNameFor({ identity: issueIdentity, title: ISSUE_TITLE });
		const app = seedFireApp({
			inFlight: [{ identity: issueIdentity, agent, paneId: "pane-1" }],
			outcomes: {
				issues: success([issueTicket(5, ["queued"])]),
				pulls: success([]),
				others: success([
					pullTicket(99, otherRepo, { title: OTHER_PULL_TITLE, labels: ["queued"] }),
				]),
			},
		});
		pinSeeds(
			app.github,
			pageJson([issueNode(5, ISSUE_TITLE, ["queued"])]),
			[pageJson([]), FIXING_PULLS_PAGE],
			OTHER_PULL_PAGE,
		);

		const record = await planeOf(app, { ticketFacts: [], pullRequestFacts: ["ready-for-review"] });
		await withApp(
			async (setup) => {
				await waitBoot(app);
				app.world.setAgentStatus(agent, "idle", app.sessionPath);
				await waitUntil(
					() => app.state.ticketWorkCycle.ticketState(issueIdentity) === "awaiting",
					"the settled turn to park on the skip",
				);
				const skipped = app.state.ticketWorkCycle.lastCompletion(issueIdentity)?.transition;
				expect(skipped?.reason).toBe(NO_LINKED_PULL_REQUEST_SKIP);
				// The operator's refresh reads every source, and lands the
				// fixing pull request in the projection.
				await pressControl(setup, "refresh", { quiet: true });
				const edit = `gh pr edit #12 --repo ${factoryRepo} --add-label ready-for-review`;
				await waitCommands(
					() => app.runner.commands(),
					[edit],
					"the re-fire's label write on the fixing pull request",
				);
				// The refresh's six pages, and nothing the re-fired fire adds:
				// the skip's ticket lists no pull request source, so its fire
				// pays no fetch of its own.
				expect(app.github.commands()).toHaveLength(11);
				expect(ghCount(app.github, "is:issue")).toBe(2);
				expect(prPageCount(app.github, factoryOwner)).toBe(4);
				expect(prPageCount(app.github, otherOwner)).toBe(4);
				expect(app.state.ticketWorkCycle.lastCompletion(issueIdentity)?.transition).toEqual({
					fired: true,
					when: null,
					reason: "",
					ticketFacts: [],
					pullRequestFacts: ["ready-for-review"],
					ticketWrite: null,
					pullRequestWrite: { added: ["ready-for-review"], removed: [] },
					pullRequestIdentity: pullIdentity,
					pullRequestKey: "#12",
					writeFailure: "",
					positionTaskType: "review",
					positionTicketIdentity: pullIdentity,
					refired: true,
				});
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: record,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		record.close();
	});
});

describe("the settling tickets settle side by side (issue #430, ADR 0153)", () => {
	test("two settling tickets that list the same pull request source pay one fetch of it", async () => {
		// Both tickets are pull requests of the "pulls" source, on one
		// repository: the side-by-side walk starts both settlement chains at
		// once, and the refresh coordinator's one-fetch rule lets the second
		// fire join the first fire's fetch. The source answers once, and both
		// fires write on the projection it lands.
		const agent12 = agentNameFor({ identity: pullIdentity, title: PULL_TITLE });
		const agent22 = agentNameFor({ identity: secondPullIdentity, title: SECOND_PULL_TITLE });
		const app = seedFireApp({
			inFlight: [
				{ identity: pullIdentity, agent: agent12, paneId: "pane-1" },
				{ identity: secondPullIdentity, agent: agent22, paneId: "pane-2" },
			],
			outcomes: {
				issues: success([]),
				pulls: success([
					pullTicket(12, factoryRepo, { title: PULL_TITLE, labels: ["queued"] }),
					pullTicket(22, factoryRepo, { title: SECOND_PULL_TITLE, labels: ["queued"] }),
				]),
				others: success([]),
			},
		});
		const bootPage = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: ["queued"] }),
			pullNode(22, factoryRepo, headBranchOf(22), { title: SECOND_PULL_TITLE, labels: ["queued"] }),
		]);
		const freshPage = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: [] }),
			pullNode(22, factoryRepo, headBranchOf(22), { title: SECOND_PULL_TITLE, labels: [] }),
		]);
		// The refresh's pages answer slowly enough that the second fire's
		// refresh meets the first fire's fetch in flight: the join, not a
		// second fetch, is what the one-fetch rule owes it.
		pinSeeds(app.github, pageJson([]), [bootPage, freshPage], pageJson([]));
		app.github.setDelay("gh", pullsArgs[0], 400);
		app.github.setDelay("gh", pullsArgs[1], 400);

		const record = await planeOf(app, { ticketFacts: ["ready-for-review"], pullRequestFacts: [] });
		await withApp(
			async (setup) => {
				await waitBoot(app);
				// Both turns end in the same cycle: the walk starts both
				// settlement chains, and joins them.
				app.world.setAgentStatus(agent12, "idle", app.sessionPath);
				app.world.setAgentStatus(agent22, "idle", app.sessionPath);
				await waitCommands(
					() => app.runner.commands(),
					[prEditCmd(12, factoryRepo), prEditCmd(22, factoryRepo)],
					"both fires' label writes",
				);
				const commands = app.github.commands();
				// The boot's five pages, one fetch of the shared source - the
				// second fire's refresh joined the first's, not a fetch per
				// fire - and the two writes.
				expect(commands).toHaveLength(9);
				expect(ghCount(app.github, "is:issue")).toBe(1);
				expect(prPageCount(app.github, otherOwner)).toBe(2);
				const pullsFetches = commands.filter(
					(command) => command.includes("is:pr") && command.includes("repo:acme/factory"),
				);
				expect(pullsFetches).toHaveLength(4);
				// Both fires wrote on the projection the one fetch landed, and
				// both turns parked beside each other.
				for (const item of [
					{ identity: pullIdentity, key: "#12" },
					{ identity: secondPullIdentity, key: "#22" },
				]) {
					expect(app.state.ticketWorkCycle.lastCompletion(item.identity)?.transition).toEqual({
						fired: true,
						when: null,
						reason: "",
						ticketFacts: ["ready-for-review"],
						pullRequestFacts: [],
						ticketWrite: null,
						pullRequestWrite: { added: ["ready-for-review"], removed: [] },
						pullRequestIdentity: item.identity,
						pullRequestKey: item.key,
						writeFailure: "",
						positionTaskType: "review",
						positionTicketIdentity: item.identity,
					});
					expect(app.state.ticketWorkCycle.ticketState(item.identity)).toBe("awaiting");
				}
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: record,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		record.close();
	});

	test("a slow refresh for one settling ticket does not hold the other ticket's fire", async () => {
		// The two settling tickets list different pull request sources, and
		// the first one's source answers slowly: the side-by-side walk lets
		// the second fire land on the refresh it awaits while the first
		// refresh is still out. A regression to the sequential walk would land
		// the second write behind the first source's answer.
		const agent12 = agentNameFor({ identity: pullIdentity, title: PULL_TITLE });
		const agent99 = agentNameFor({ identity: otherPullIdentity, title: OTHER_PULL_TITLE });
		const app = seedFireApp({
			inFlight: [
				{ identity: pullIdentity, agent: agent12, paneId: "pane-1" },
				{ identity: otherPullIdentity, agent: agent99, paneId: "pane-2" },
			],
			outcomes: {
				issues: success([]),
				pulls: success([pullTicket(12, factoryRepo, { title: PULL_TITLE, labels: ["queued"] })]),
				others: success([
					pullTicket(99, otherRepo, { title: OTHER_PULL_TITLE, labels: ["queued"] }),
				]),
			},
		});
		const bootPulls = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: ["queued"] }),
		]);
		const freshPulls = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: [] }),
		]);
		// The slow source the first fire awaits: the boot's pages answer at
		// once, and the refresh's pages hold the answer for a while.
		const bootOthers = pageJson([
			pullNode(99, otherRepo, headBranchOf(99), { title: OTHER_PULL_TITLE, labels: ["queued"] }),
		]);
		const freshOthers = pageJson([
			pullNode(99, otherRepo, headBranchOf(99), { title: OTHER_PULL_TITLE, labels: [] }),
		]);
		pinSeeds(app.github, pageJson([]), [bootPulls, freshPulls], [bootOthers, freshOthers]);
		app.github.setDelaySequence("gh", pullsArgs[0], [0, 600]);
		app.github.setDelaySequence("gh", pullsArgs[1], [0, 600]);

		const record = await planeOf(app, { ticketFacts: ["ready-for-review"], pullRequestFacts: [] });
		await withApp(
			async (setup) => {
				await waitBoot(app);
				app.world.setAgentStatus(agent12, "idle", app.sessionPath);
				app.world.setAgentStatus(agent99, "idle", app.sessionPath);
				const fast = prEditCmd(99, otherRepo);
				const slow = prEditCmd(12, factoryRepo);
				await waitCommands(() => app.runner.commands(), [fast], "the fast fire's write");
				// The slow refresh is still out: the fast ticket's fire has
				// landed, and the slow ticket's has not.
				expect(app.github.commands()).not.toContain(slow);
				await waitCommands(
					() => app.runner.commands(),
					[slow],
					"the slow fire's write, behind its refresh",
				);
				// Both fires refreshed their own sources alone: one fetch each
				// per source the ticket lists, and no fetch of a source it
				// does not list.
				expect(ghCount(app.github, "is:issue")).toBe(1);
				expect(prPageCount(app.github, factoryOwner)).toBe(4);
				expect(prPageCount(app.github, otherOwner)).toBe(4);
				for (const identity of [pullIdentity, otherPullIdentity]) {
					expect(
						app.state.ticketWorkCycle.lastCompletion(identity)?.transition?.positionTicketIdentity,
					).toBe(identity);
					expect(app.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
				}
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: record,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		record.close();
	});

	test("a cycle where no ticket settles takes no fire's refresh", async () => {
		// The settled turn parks, and the cycles that follow walk nothing that
		// settles: the quiet cycle pays the probe and the walks and nothing
		// more - no fire runs, so no fire refreshes a source.
		const agent = agentNameFor({ identity: pullIdentity, title: PULL_TITLE });
		const app = seedFireApp({
			inFlight: [{ identity: pullIdentity, agent, paneId: "pane-1" }],
			outcomes: {
				issues: success([]),
				pulls: success([pullTicket(12, factoryRepo, { title: PULL_TITLE, labels: ["queued"] })]),
				others: success([]),
			},
		});
		const bootPage = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: ["queued"] }),
		]);
		const freshPage = pageJson([
			pullNode(12, factoryRepo, headBranchOf(12), { title: PULL_TITLE, labels: [] }),
		]);
		pinSeeds(app.github, pageJson([]), [bootPage, freshPage], pageJson([]));

		const record = await planeOf(app, { ticketFacts: ["ready-for-review"], pullRequestFacts: [] });
		await withApp(
			async (setup) => {
				await waitBoot(app);
				app.world.setAgentStatus(agent, "idle", app.sessionPath);
				const edit = prEditCmd(12, factoryRepo);
				await waitCommands(() => app.runner.commands(), [edit], "the fire's label write");
				await waitUntil(
					() => app.state.ticketWorkCycle.ticketState(pullIdentity) === "awaiting",
					"the settled turn to park",
				);
				// The settled fire's refresh has landed, and the walk has
				// joined: every settlement has written.
				const settledCount = app.github.commands().length;
				// Three grid landings on the quiet walk: nothing settles, so
				// nothing refreshes.
				await sleep(350);
				expect(app.github.commands()).toHaveLength(settledCount);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: record,
				loopPolicy: { kind: "polled", intervalMs: 100 },
			},
		);
		record.close();
	});
});
