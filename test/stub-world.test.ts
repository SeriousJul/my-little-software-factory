/**
 * The Stub world command surface (issue #178, ADR 0073).
 *
 * The prior art is the inverse of the existing suite: the fake runner tests
 * (the ticket source, the security source, the plane action merge, the
 * workflow transition tests) pin the plane's command shapes with canned
 * responses. These tests pin the world's answers to those same shapes, and
 * the closed-surface test walks the real command shapes the suite issues
 * against the world, so the two sides cannot drift.
 *
 * Every test drives the real production modules - the ticket sources, the
 * security sources, the merge action, the label writes - through the stub
 * runner over a world file in a temporary directory: fake external
 * operations, isolated state, no desktop, no live Agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TicketSourceConfig } from "../src/config.ts";
import { loadConfigFile } from "../src/config.ts";
import type { Ticket } from "../src/domain/ticket.ts";
import { runMergePullRequest } from "../src/plane-actions.ts";
import { worldCli } from "../src/stub/cli.ts";
import { createStubRunner } from "../src/stub/runner.ts";
import { renderStubConfig, stubWorldSeed } from "../src/stub/seed.ts";
import { autoScoreBody, StubWorldError, StubWorldStore } from "../src/stub/world.ts";
import { createTicketSource, SEARCH_QUERY } from "../src/ticket-source.ts";
import { scoreFromMessage } from "../src/workflow.ts";
import { FakeRunner } from "./fake-runner.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "stub-world-"));
	paths.push(dir);
	return dir;
}

/** A fresh seeded world file in a temporary directory, loaded as a store. */
function seededStore(dir: string): StubWorldStore {
	const path = join(dir, "world.json");
	writeFileSync(path, `${JSON.stringify(stubWorldSeed(), null, 2)}\n`);
	return StubWorldStore.load(path);
}

const source = (kind: TicketSourceConfig["kind"], name: string = kind): TicketSourceConfig => ({
	name,
	kind,
	refreshIntervalSeconds: 60,
	repositories: ["stub/alpha", "stub/beta"],
	host: "github.com",
});

/** The sources the stub configuration names, for the real modules' reads. */
const SOURCES: TicketSourceConfig[] = [
	source("github-issues", "stub-issues"),
	source("github-pull-requests", "stub-pull-requests"),
];

/** The pull request as the projection holds it, for the merge action's run. */
function pullTicket(repository: string, number: number, sourceName: string): Ticket {
	const identity = `github.com/${repository}`;
	const cloneUrl = `https://github.com/${repository}.git`;
	return {
		identity: `github:github.com:pull-${repository}/${number}`,
		title: `the pull request ${number} of ${repository}`,
		repository,
		repositoryRef: { identity, displayName: repository, cloneUrl },
		state: "open",
		handoff: null,
		workCycle: 1,
		description: "",
		sourceKind: "github-pull-request",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://github.com/${repository}/pull/${number}`,
		labels: [],
		externalUpdatedAt: "2026-01-01T00:00:00Z",
		memberships: [
			{
				sourceName,
				identity: `github:github.com:pull-${repository}/${number}`,
				sourceKind: "github-pull-request",
				externalKey: `#${number}`,
				sourceState: "open",
				url: `https://github.com/${repository}/pull/${number}`,
				title: `the pull request ${number} of ${repository}`,
				description: "",
				labels: [],
				externalUpdatedAt: "2026-01-01T00:00:00Z",
				repository: { identity, displayName: repository, cloneUrl },
				attributes: { draft: "false" },
				health: "healthy",
			},
		],
		suggestedTaskType: "merge",
		matchedStateName: "ready-to-ship",
		actionable: true,
		handoffRecoveryRequired: false,
		handoffCount: 0,
		lastCompletion: null,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
	};
}

describe("the seed", () => {
	test("stands the scenario tickets, the linked draft pull requests, and the gate facts", () => {
		const world = stubWorldSeed();
		expect(world.host).toBe("github.com");
		expect(world.owner).toBe("stub");
		expect(world.autoScore).toEqual({ enabled: true, score: 92 });
		expect(world.repositories.map((repository) => repository.name)).toEqual(["alpha", "beta"]);

		const alpha = world.repositories[0];
		const beta = world.repositories[1];
		expect(alpha.issues[0].labels).toEqual(["ready-for-agent"]);
		expect(beta.issues.map((issue) => issue.number)).toEqual([1, 2]);
		expect(beta.issues.every((issue) => issue.state === "open")).toBe(true);

		// The pre-provisioned linked pull request: the closing reference in
		// the body, the factory branch prefix on the head branch, open, no
		// workflow label, a draft so the issue stands in the list.
		for (const [repository, numbers] of [
			[alpha, [1]],
			[beta, [1, 2]],
		] as const) {
			for (const number of numbers) {
				const pull = repository.pullRequests.find((item) => item.number === number);
				expect(pull).toBeDefined();
				expect(pull?.state).toBe("open");
				expect(pull?.merged).toBe(false);
				expect(pull?.draft).toBe(true);
				expect(pull?.labels).toEqual([]);
				expect(pull?.headBranch).toBe(
					`factory/${number}-${pull?.title.toLowerCase().replace(/ /g, "-")}`,
				);
				expect(pull?.closingIssueNumbers).toEqual([number]);
				expect(pull?.body).toContain(`Fixes #${number}`);
			}
		}

		// The merge gate fact: alpha's gate passes, beta's first pull request
		// fails it with a reason the blocked comment carries.
		expect(alpha.mergeGates["1"]).toEqual({ passing: true, reason: "" });
		expect(beta.mergeGates["1"]).toEqual({
			passing: false,
			reason: "the stub CI gate is failing the build",
		});

		// The security feed items, one of each kind across the two repositories.
		expect(alpha.security.advisories.map((item) => item.state)).toEqual(["published"]);
		expect(alpha.security.secretScanningAlerts.map((item) => item.state)).toEqual(["open"]);
		expect(beta.security.dependabotAlerts.map((item) => item.state)).toEqual(["open"]);
	});
});

describe("the sources read the world", () => {
	test("the issues source lists the open issues, and the draft pull requests do not cover them", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const runner = createStubRunner(new FakeRunner(), store);
		const issueSource = createTicketSource(source("github-issues"), runner);
		const result = await issueSource.fetch();
		expect(result.status).toBe("success");
		if (result.status !== "success") return;
		expect(result.tickets.map((ticket) => ticket.externalKey)).toEqual(["#1", "#2", "#1", "#2"]);
		expect(
			result.tickets
				.filter((ticket) => ticket.repository.identity === "github.com/stub/alpha")
				.map((ticket) => ticket.labels),
		).toEqual([["ready-for-agent"], []]);

		const pullSource = createTicketSource(source("github-pull-requests"), runner);
		const pulls = await pullSource.fetch();
		expect(pulls.status).toBe("success");
		if (pulls.status !== "success") return;
		// The pre-provisioned pull requests are drafts with no workflow
		// label, so the default policy lists none of them: the scenario
		// issues stand in the Ticket section uncovered.
		expect(pulls.tickets).toEqual([]);
		expect(store.refusals).toEqual([]);
	});

	test("an undrafted pull request enters the list with its head branch and closing references", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		store.world.repositories[0].pullRequests[0].draft = false;
		store.save();
		const runner = createStubRunner(new FakeRunner(), store);
		const pullSource = createTicketSource(source("github-pull-requests"), runner);
		const result = await pullSource.fetch();
		expect(result.status).toBe("success");
		if (result.status !== "success") return;
		expect(result.tickets).toHaveLength(1);
		const ticket = result.tickets[0];
		expect(ticket.externalKey).toBe("#1");
		expect(ticket.repository.identity).toBe("github.com/stub/alpha");
		expect(ticket.attributes.headBranch).toBe("factory/1-add-a-greeting-command");
		expect(ticket.attributes.draft).toBe("false");
		expect(store.refusals).toEqual([]);
	});

	test("the security sources list the world's feed items by kind", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const runner = createStubRunner(new FakeRunner(), store);

		const advisories = await createTicketSource(
			source("github-security-advisories"),
			runner,
		).fetch();
		expect(advisories.status).toBe("success");
		if (advisories.status !== "success") return;
		expect(advisories.tickets.map((ticket) => ticket.externalKey)).toEqual(["GHSAA-STUB-ALPHA"]);
		expect(advisories.tickets[0].labels).toEqual(["moderate"]);

		const dependabot = await createTicketSource(source("github-dependabot-alerts"), runner).fetch();
		expect(dependabot.status).toBe("success");
		if (dependabot.status !== "success") return;
		expect(dependabot.tickets.map((ticket) => ticket.externalKey)).toEqual(["#1"]);
		expect(dependabot.tickets[0].repository.identity).toBe("github.com/stub/beta");

		const secrets = await createTicketSource(
			source("github-secret-scanning-alerts"),
			runner,
		).fetch();
		expect(secrets.status).toBe("success");
		if (secrets.status !== "success") return;
		expect(secrets.tickets.map((ticket) => ticket.externalKey)).toEqual(["#1"]);
		expect(secrets.tickets[0].repository.identity).toBe("github.com/stub/alpha");

		expect(store.refusals).toEqual([]);
	});
});

describe("the verdict read and the auto score", () => {
	const commentRead = (repository: string, number: number): string[] => [
		"api",
		"--paginate",
		"--hostname",
		"github.com",
		`repos/${repository}/issues/${number}/comments?per_page=100`,
	];

	test("the first comment read on a verdictless pull request posts the configured score", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const first = await store.answerGh(commentRead("stub/alpha", 1));
		expect(first.code).toBe(0);
		const comments = JSON.parse(first.stdout) as Array<{ body: string; created_at: string }>;
		expect(comments).toHaveLength(1);
		expect(scoreFromMessage(comments[0].body)).toBe(92);

		// The post is the world's, and it is on disk.
		const reloaded = StubWorldStore.load(store.path);
		expect(reloaded.world.repositories[0].pullRequests[0].comments).toHaveLength(1);
		expect(store.refusals).toEqual([]);
	});

	test("the post runs once: the second read adds no score", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		await store.answerGh(commentRead("stub/alpha", 1));
		const second = await store.answerGh(commentRead("stub/alpha", 1));
		const comments = JSON.parse(second.stdout) as Array<{ body: string }>;
		expect(comments).toHaveLength(1);
	});

	test("the rule off, world-level or per pull request, posts nothing", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		store.world.autoScore.enabled = false;
		const off = await store.answerGh(commentRead("stub/beta", 1));
		expect(JSON.parse(off.stdout)).toEqual([]);
		expect(store.world.repositories[1].pullRequests[0].scorePosted).toBe(true);

		// The per-pull-request override both ways: off over an on world, and
		// on over an off world.
		const store2 = seededStore(dir);
		store2.world.repositories[0].pullRequests[0].autoScore = false;
		const overrideOff = await store2.answerGh(commentRead("stub/alpha", 1));
		expect(JSON.parse(overrideOff.stdout)).toEqual([]);
		store2.world.autoScore.enabled = false;
		const beta2 = store2.world.repositories[1].pullRequests[1];
		beta2.autoScore = true;
		const overrideOn = await store2.answerGh(commentRead("stub/beta", 2));
		const posted = JSON.parse(overrideOn.stdout) as Array<{ body: string }>;
		expect(posted).toHaveLength(1);
		expect(scoreFromMessage(posted[0].body)).toBe(92);
	});

	test("a posted verdict stands: no auto score over a manual score", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const pull = store.world.repositories[0].pullRequests[0];
		pull.comments.push({ body: autoScoreBody(40), createdAt: "2026-09-30T00:00:00.000Z" });
		const read = await store.answerGh(commentRead("stub/alpha", 1));
		const comments = JSON.parse(read.stdout) as Array<{ body: string }>;
		expect(comments).toHaveLength(1);
		expect(scoreFromMessage(comments[0].body)).toBe(40);
	});

	test("the reviews read answers the world's reviews", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		store.world.repositories[0].pullRequests[0].reviews.push({
			body: "- **Score:** 55 / 100",
			submittedAt: "2026-09-30T00:05:00.000Z",
		});
		const read = await store.answerGh([
			"api",
			"--paginate",
			"--hostname",
			"github.com",
			"repos/stub/alpha/pulls/1/reviews?per_page=100",
		]);
		expect(read.code).toBe(0);
		const reviews = JSON.parse(read.stdout) as Array<{ body: string; submitted_at: string }>;
		expect(reviews).toHaveLength(1);
		expect(scoreFromMessage(reviews[0].body)).toBe(55);
	});
});

describe("the label writes", () => {
	test("the issue edit writes labels to the world and persists them", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const result = await store.answerGh([
			"issue",
			"edit",
			"#2",
			"--repo",
			"github.com/stub/alpha",
			"--add-label",
			"ready-for-agent",
		]);
		expect(result.code).toBe(0);
		expect(store.world.repositories[0].issues[1].labels).toEqual(["ready-for-agent"]);
		const reloaded = StubWorldStore.load(store.path);
		expect(reloaded.world.repositories[0].issues[1].labels).toEqual(["ready-for-agent"]);
		expect(store.refusals).toEqual([]);
	});

	test("the pull request edit adds and removes labels in one write", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const pull = store.world.repositories[1].pullRequests[0];
		pull.draft = false;
		pull.labels = ["ready-for-review"];
		const result = await store.answerGh([
			"pr",
			"edit",
			"#1",
			"--repo",
			"github.com/stub/beta",
			"--add-label",
			"ready-to-ship",
			"--remove-label",
			"ready-for-review",
		]);
		expect(result.code).toBe(0);
		expect(pull.labels).toEqual(["ready-to-ship"]);
	});

	test("a number that names no item fails the write without recording a refusal", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const result = await store.answerGh([
			"issue",
			"edit",
			"#99",
			"--repo",
			"github.com/stub/alpha",
			"--add-label",
			"ready-for-agent",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Could not resolve to an Issue with the number of 99");
		expect(store.refusals).toEqual([]);
	});

	test("a command shape the world does not know is refused and recorded", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const result = await store.answerGh([
			"issue",
			"close",
			"#1",
			"--repo",
			"github.com/stub/alpha",
		]);
		expect(result.code).toBe(1);
		expect(store.refusals).toHaveLength(1);
		expect(store.refusals[0]).toContain("gh issue close");
	});
});

describe("the merge", () => {
	test("the failing gate refuses the merge with the gate's reason", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const result = await store.answerGh([
			"pr",
			"merge",
			"#1",
			"--squash",
			"--repo",
			"github.com/stub/beta",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the stub CI gate is failing the build");
		const pull = store.world.repositories[1].pullRequests[0];
		expect(pull.merged).toBe(false);
		expect(pull.state).toBe("open");
	});

	test("a clean merge closes the linked issues, the GitHub semantics", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const blocked = await store.answerGh([
			"pr",
			"merge",
			"#1",
			"--squash",
			"--repo",
			"github.com/stub/beta",
		]);
		expect(blocked.code).toBe(1);
		// The gate flip, the world CLI's verb, ends the rework loop.
		const flip = await worldCli([
			store.path,
			"set-merge-gate",
			"--repo",
			"beta",
			"--pr",
			"1",
			"--pass",
		]);
		expect(flip.ok).toBe(true);
		const reloaded = StubWorldStore.load(store.path);
		const merged = await reloaded.answerGh([
			"pr",
			"merge",
			"#1",
			"--squash",
			"--repo",
			"github.com/stub/beta",
		]);
		expect(merged.code).toBe(0);
		const pull = reloaded.world.repositories[1].pullRequests[0];
		expect(pull.merged).toBe(true);
		expect(pull.state).toBe("closed");
		expect(reloaded.world.repositories[1].issues[0].state).toBe("closed");

		// On disk, for the restart: both tickets leave the list.
		const persisted = StubWorldStore.load(store.path);
		expect(persisted.world.repositories[1].pullRequests[0].merged).toBe(true);
		expect(persisted.world.repositories[1].issues[0].state).toBe("closed");

		// The fresh read the plane action takes answers the merged fact.
		const record = await persisted.answerGh([
			"api",
			"--hostname",
			"github.com",
			"repos/stub/beta/pulls/1",
		]);
		const parsed = JSON.parse(record.stdout) as { number: number; state: string; merged: boolean };
		expect(parsed.number).toBe(1);
		expect(parsed.state).toBe("closed");
		expect(parsed.merged).toBe(true);
		// A merge on a merged pull request is refused, the idempotency fact.
		const again = await persisted.answerGh([
			"pr",
			"merge",
			"#1",
			"--squash",
			"--repo",
			"github.com/stub/beta",
		]);
		expect(again.code).toBe(1);
		expect(again.stderr).toContain("already merged");
	});

	test("the blocked comment posts on the pull request", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const result = await store.answerGh([
			"pr",
			"comment",
			"#1",
			"--repo",
			"github.com/stub/beta",
			"--body",
			"The factory's merge was blocked: the gate",
		]);
		expect(result.code).toBe(0);
		const pull = store.world.repositories[1].pullRequests[0];
		expect(pull.comments.map((comment) => comment.body)).toEqual([
			"The factory's merge was blocked: the gate",
		]);
	});
});

describe("the plane action's merge run, the real module over the world", () => {
	test("the blocked outcome runs the real code path, with the gate's reason", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const runner = createStubRunner(new FakeRunner(), store);
		const result = await runMergePullRequest({
			runner,
			sources: SOURCES,
			pullRequest: pullTicket("stub/beta", 1, "stub-pull-requests"),
			method: "squash",
		});
		expect(result.outcome).toBe("blocked");
		if (result.outcome !== "blocked") return;
		expect(result.reason).toBe(
			"GraphQL: Pull request is not mergeable: the stub CI gate is failing the build",
		);
		// The block's comment stood on the pull request in the world.
		const pull = store.world.repositories[1].pullRequests[0];
		expect(pull.comments.some((comment) => comment.body.includes("merge was blocked"))).toBe(true);
		expect(store.refusals).toEqual([]);
	});

	test("the clean merge settles merged, and the fresh read idles it", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const runner = createStubRunner(new FakeRunner(), store);
		const ticket = pullTicket("stub/alpha", 1, "stub-pull-requests");
		const first = await runMergePullRequest({
			runner,
			sources: SOURCES,
			pullRequest: ticket,
			method: "squash",
		});
		expect(first).toEqual({ outcome: "merged", reason: "", alreadyMerged: false });
		// The fresh read after the merge settles the idempotency fact.
		const second = await runMergePullRequest({
			runner,
			sources: SOURCES,
			pullRequest: ticket,
			method: "squash",
		});
		expect(second).toEqual({ outcome: "merged", reason: "", alreadyMerged: true });
		expect(store.refusals).toEqual([]);
	});
});

describe("the closed surface", () => {
	test("the real command shapes the plane issues meet no refusal", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const real = new FakeRunner();
		const runner = createStubRunner(real, store);

		// The searches the sources fetch, for every configured kind.
		const kinds: TicketSourceConfig["kind"][] = [
			"github-issues",
			"github-pull-requests",
			"github-security-advisories",
			"github-dependabot-alerts",
			"github-secret-scanning-alerts",
		];
		for (const kind of kinds) {
			const result = await createTicketSource(source(kind), runner).fetch();
			expect(result.status).toBe("success");
		}

		// The verdict reads the score Judgment walks, on the seed's items.
		for (const repository of store.world.repositories) {
			for (const issue of repository.issues) {
				const comments = await store.answerGh([
					"api",
					"--paginate",
					"--hostname",
					"github.com",
					`repos/stub/${repository.name}/issues/${issue.number}/comments?per_page=100`,
				]);
				expect(comments.code).toBe(0);
			}
			for (const pull of repository.pullRequests) {
				const reviews = await store.answerGh([
					"api",
					"--paginate",
					"--hostname",
					"github.com",
					`repos/stub/${repository.name}/pulls/${pull.number}/reviews?per_page=100`,
				]);
				expect(reviews.code).toBe(0);
				// The pull request record read the open and merged Judgment takes.
				const record = await store.answerGh([
					"api",
					"--hostname",
					"github.com",
					`repos/stub/${repository.name}/pulls/${pull.number}`,
				]);
				expect(record.code).toBe(0);
			}
		}

		// The issue and pull request edits the transitions and the Placement
		// write, for both repositories.
		for (const repository of ["stub/alpha", "stub/beta"]) {
			const issueEdit = await store.answerGh([
				"issue",
				"edit",
				"#1",
				"--repo",
				`github.com/${repository}`,
				"--add-label",
				"ready-for-agent",
			]);
			expect(issueEdit.code).toBe(0);
			const pullEdit = await store.answerGh([
				"pr",
				"edit",
				"#1",
				"--repo",
				`github.com/${repository}`,
				"--add-label",
				"ready-for-review",
			]);
			expect(pullEdit.code).toBe(0);
		}

		// The merge and the blocked comment the plane action runs.
		const merge = await store.answerGh([
			"pr",
			"merge",
			"#2",
			"--squash",
			"--repo",
			"github.com/stub/beta",
		]);
		expect(merge.code).toBe(0);
		const comment = await store.answerGh([
			"pr",
			"comment",
			"#2",
			"--repo",
			"github.com/stub/beta",
			"--body",
			"a comment",
		]);
		expect(comment.code).toBe(0);

		// The auth token a source would resolve, which the stub configuration
		// never names: the answer stands, and no real credential is read.
		const token = await store.answerGh([
			"auth",
			"token",
			"--hostname",
			"github.com",
			"--user",
			"stub",
		]);
		expect(token.code).toBe(0);

		// The surface stayed closed: no real command shape met a refusal, and
		// no command but `gh` reached the real runner.
		expect(store.refusals).toEqual([]);
		expect(real.calls).toEqual([]);
	});

	test("a drifted search document and an unknown command are refused", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const drifted = await store.answerGh([
			"api",
			"graphql",
			"--hostname",
			"github.com",
			"-f",
			"query=query Drifted($searchQuery: String!) { search(query: $searchQuery, type: ISSUE, first: 100) { issueCount } }",
			"-f",
			"searchQuery=is:open is:issue repo:stub/alpha",
		]);
		expect(drifted.code).toBe(1);
		const unknown = await store.answerGh(["release", "create", "--repo", "github.com/stub/alpha"]);
		expect(unknown.code).toBe(1);
		expect(store.refusals).toHaveLength(2);
	});

	test("a search qualifier the world does not know is refused", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const result = await store.answerGh([
			"api",
			"graphql",
			"--hostname",
			"github.com",
			"-f",
			`query=${SEARCH_QUERY}`,
			"-f",
			"searchQuery=is:open is:issue repo:stub/alpha -milestone:stub",
		]);
		expect(result.code).toBe(1);
		expect(store.refusals).toHaveLength(1);
	});
});

describe("the world cli", () => {
	test("adds an issue and a pull request, and persists them", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const added = await worldCli([
			store.path,
			"add-issue",
			"--repo",
			"alpha",
			"--number",
			"3",
			"--title",
			"Add a third thing",
			"--label",
			"ready-for-agent",
		]);
		expect(added.ok).toBe(true);
		const pull = await worldCli([
			store.path,
			"add-pull-request",
			"--repo",
			"alpha",
			"--number",
			"2",
			"--title",
			"Add a third thing",
			"--head-branch",
			"factory/3-add-a-third-thing",
			"--closing",
			"3",
		]);
		expect(pull.ok).toBe(true);
		const reloaded = StubWorldStore.load(store.path);
		expect(reloaded.world.repositories[0].issues.map((issue) => issue.number)).toEqual([1, 2, 3]);
		expect(reloaded.world.repositories[0].issues[2].labels).toEqual(["ready-for-agent"]);
		expect(reloaded.world.repositories[0].pullRequests.map((item) => item.number)).toEqual([1, 2]);
		expect(reloaded.world.repositories[0].pullRequests[1].closingIssueNumbers).toEqual([3]);
	});

	test("sets labels, adds a comment, sets the merge gate, and toggles the auto score", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		expect(
			(
				await worldCli([
					store.path,
					"set-labels",
					"--repo",
					"beta",
					"--issue",
					"2",
					"--labels",
					"ready-for-agent,needs-work",
				])
			).ok,
		).toBe(true);
		expect(
			(
				await worldCli([
					store.path,
					"add-comment",
					"--repo",
					"beta",
					"--pr",
					"2",
					"--body",
					"- **Score:** 50 / 100",
				])
			).ok,
		).toBe(true);
		expect(
			(
				await worldCli([
					store.path,
					"set-merge-gate",
					"--repo",
					"beta",
					"--pr",
					"2",
					"--fail",
					"--reason",
					"the gate turns",
				])
			).ok,
		).toBe(true);
		expect(await worldCli([store.path, "set-auto-score", "--off", "--score", "40"])).toEqual({
			ok: true,
			lines: ["the world's auto score is off, 40 / 100"],
		});
		const reloaded = StubWorldStore.load(store.path);
		expect(reloaded.world.repositories[1].issues[1].labels).toEqual([
			"ready-for-agent",
			"needs-work",
		]);
		expect(
			reloaded.world.repositories[1].pullRequests[1].comments.map((comment) => comment.body),
		).toEqual(["- **Score:** 50 / 100"]);
		expect(reloaded.world.repositories[1].mergeGates["2"]).toEqual({
			passing: false,
			reason: "the gate turns",
		});
		expect(reloaded.world.autoScore).toEqual({ enabled: false, score: 40 });
	});

	test("resets to the seed, and a broken world is disposable", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		await worldCli([
			store.path,
			"add-issue",
			"--repo",
			"alpha",
			"--number",
			"9",
			"--title",
			"extra",
		]);
		const reset = await worldCli([store.path, "reset"]);
		expect(reset.ok).toBe(true);
		const reloaded = StubWorldStore.load(store.path);
		expect(reloaded.world.repositories[0].issues.map((issue) => issue.number)).toEqual([1, 2]);
		expect(reloaded.world.autoScore).toEqual({ enabled: true, score: 92 });
	});

	test("an unknown verb, a missing file, and a world error are failure lines", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const unknown = await worldCli([store.path, "explode"]);
		expect(unknown.ok).toBe(false);
		expect(unknown.lines[0]).toContain("usage: stub-world");
		const missing = await worldCli([join(dir, "nope.json"), "reset"]);
		expect(missing.ok).toBe(false);
		expect(missing.lines[0]).toContain("cannot be read");
		const collision = await worldCli([
			store.path,
			"add-issue",
			"--repo",
			"alpha",
			"--number",
			"1",
			"--title",
			"again",
		]);
		expect(collision.ok).toBe(false);
		expect(collision.lines[0]).toContain("already stands");
	});
});

describe("the stub runner", () => {
	test("serves only the gh commands; every other command runs for real", async () => {
		const dir = tempDir();
		const store = seededStore(dir);
		const real = new FakeRunner();
		real.setDefault({ code: 0, stdout: "real\n" });
		const runner = createStubRunner(real, store);

		const git = await runner.run("git", ["-C", "/tmp/x", "status"], undefined);
		expect(git.stdout).toBe("real\n");
		const herdr = await runner.run("herdr", ["agent", "list"], undefined);
		expect(herdr.stdout).toBe("real\n");
		expect(real.calls.map((call) => call.command)).toEqual(["git", "herdr"]);

		const gh = await runner.run(
			"gh",
			["issue", "edit", "#1", "--repo", "github.com/stub/alpha", "--add-label", "ready-for-agent"],
			undefined,
		);
		expect(gh.code).toBe(0);
		// The gh command never reached the real runner.
		expect(real.calls.every((call) => call.command !== "gh")).toBe(true);

		const models = await runner.listModels("pi");
		expect(models.ok).toBe(false);
	});
});

describe("the stub configuration", () => {
	test("renders a config the loader takes, with no auth on any source", async () => {
		const dir = tempDir();
		const path = join(dir, "config.toml");
		writeFileSync(path, renderStubConfig("/stub/dir"));
		const loaded = await loadConfigFile(path);
		expect(loaded.config.maxParallelAgents).toBe(2);
		expect(loaded.config.sources).toHaveLength(5);
		for (const item of loaded.config.sources) {
			expect(item.auth).toBeUndefined();
			expect(item.repositories).toEqual(["stub/alpha", "stub/beta"]);
			expect(item.host).toBe("github.com");
		}
		expect(Object.keys(loaded.config.repos).sort()).toEqual([
			"github.com/stub/alpha",
			"github.com/stub/beta",
		]);
		expect(loaded.config.repos["github.com/stub/alpha"]).toBe("/stub/dir/checkouts/alpha");
		expect(loaded.config.stateFile).toBe(".factory-stub.sqlite");
		// The workflow machine and its trivial task types stand.
		expect(loaded.config.workflowStates.map((state) => state.name)).toEqual([
			"ready-for-agent",
			"needs-work",
			"ready-for-review",
			"ready-to-ship",
			"security-advisory",
			"security-dependabot-alert",
			"security-secret-alert",
			"pull-request-unlabeled",
		]);
		expect(loaded.config.taskTypes.implement.template).toContain("{external-key}: {title}");
		expect(loaded.config.taskTypes.merge.action).toBe("merge-pull-request");
		expect(loaded.config.taskTypes.merge.method).toBe("squash");
	});
});

describe("the world file", () => {
	test("a missing or malformed file is a readable error", () => {
		const dir = tempDir();
		expect(() => StubWorldStore.load(join(dir, "nope.json"))).toThrow(StubWorldError);
		const path = join(dir, "bad.json");
		writeFileSync(path, "{ not json");
		expect(() => StubWorldStore.load(path)).toThrow(/not valid JSON/);
		const bad = join(dir, "wrong.json");
		writeFileSync(bad, JSON.stringify({ version: 2 }));
		expect(() => StubWorldStore.load(bad)).toThrow(/version 1/);
	});

	test("a save is atomic: the file is never half written", () => {
		const dir = tempDir();
		const store = seededStore(dir);
		store.world.repositories[0].issues[0].labels.push("extra");
		store.save();
		const text = readFileSync(store.path, "utf8");
		expect(JSON.parse(text)).toEqual(store.world);
	});
});
