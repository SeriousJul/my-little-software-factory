/**
 * The pull request lifecycle module tests (ADR 0076).
 *
 * The module's answers are pinned here against the fake runner: the direct
 * head-branch read, the open, the publish, the close, the commit count, and
 * the body the open writes. The handoff and the workflow tests pin the
 * sequences the module stands in; these pin the module's own answers.
 */
import { describe, expect, test } from "bun:test";
import type { TicketSourceConfig } from "../src/config.ts";
import type { RepositoryRef, Ticket } from "../src/domain/ticket.ts";
import {
	closeCycleEndDraftPullRequest,
	listOpenPullRequestsByHeadBranch,
	openDraftPullRequest,
	pullRequestBodyFor,
	readTicketOwnPullRequest,
} from "../src/pull-request.ts";
import { FakeRunner } from "./fake-runner.ts";

const source: TicketSourceConfig = {
	name: "issues",
	kind: "github-issues",
	refreshIntervalSeconds: 60,
	repositories: ["acme/billing"],
	host: "github.com",
};

const repository: RepositoryRef = {
	identity: "github.com/acme/billing",
	displayName: "acme/billing",
	cloneUrl: "https://github.com/acme/billing.git",
};

const ticket: Ticket = {
	identity: "github:github.com:issue-github.com/acme/billing/7",
	title: "Retry policy for webhooks",
	repository: "acme/billing",
	repositoryRef: repository,
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
	memberships: [
		{
			sourceName: "issues",
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
			repository,
			attributes: {},
		},
	],
	suggestedTaskType: "implement",
	matchedStateName: null,
	actionable: true,
	handoffRecoveryRequired: false,
	ignored: false,
	ignoredAt: null,
	muted: false,
	mutedAt: null,
	handoffCount: 0,
	failedStartStreak: 0,
	lastCompletion: null,
	leftover: null,
};

const branch = "factory/7-retry-policy-for-webhooks";
const pullsPath = `repos/acme/billing/pulls?state=open&head=${encodeURIComponent(
	`acme:${branch}`,
)}`;

/** Stub the direct read's answer with these raw pull request records. */
function setRead(runner: FakeRunner, records: readonly unknown[]): void {
	runner.set("gh", ["api", "--hostname", "github.com", pullsPath], {
		stdout: JSON.stringify(records),
	});
}

const record = {
	number: 42,
	state: "open",
	draft: true,
	html_url: "https://github.com/acme/billing/pull/42",
	head: { ref: branch },
	base: { ref: "main" },
	labels: [{ name: "work-in-progress" }],
};

describe("listOpenPullRequestsByHeadBranch", () => {
	test("reads the branch's open pull requests and carries their facts", async () => {
		const runner = new FakeRunner();
		setRead(runner, [record]);
		const answer = await listOpenPullRequestsByHeadBranch(runner, source, repository, branch);
		expect(answer).toEqual([
			{
				number: 42,
				state: "open",
				draft: true,
				url: "https://github.com/acme/billing/pull/42",
				headBranch: branch,
				baseBranch: "main",
				labels: ["work-in-progress"],
			},
		]);
	});

	test("a failed read, a non-list answer, and an unreadable record all come back as reasons", async () => {
		const failed = new FakeRunner();
		failed.set("gh", ["api", "--hostname", "github.com", pullsPath], {
			code: 1,
			stderr: "HTTP 401: Bad credentials\n",
		});
		expect(
			"fail" in (await listOpenPullRequestsByHeadBranch(failed, source, repository, branch)),
		).toBe(true);

		const nonList = new FakeRunner();
		nonList.set("gh", ["api", "--hostname", "github.com", pullsPath], {
			stdout: '{"message":"Not Found"}',
		});
		expect(
			"fail" in (await listOpenPullRequestsByHeadBranch(nonList, source, repository, branch)),
		).toBe(true);

		const unreadable = new FakeRunner();
		setRead(unreadable, [{ number: 42 }]);
		expect(
			"fail" in (await listOpenPullRequestsByHeadBranch(unreadable, source, repository, branch)),
		).toBe(true);
	});
});

describe("openDraftPullRequest", () => {
	test("opens the draft on the branch and parses the number from the answered url", async () => {
		const runner = new FakeRunner();
		runner.set(
			"gh",
			[
				"pr",
				"create",
				"--repo",
				"github.com/acme/billing",
				"--head",
				branch,
				"--draft",
				"--title",
				"Retry policy for webhooks",
				"--body",
				"The body",
			],
			{
				stdout:
					"Opening draft pull request for factory/7 into main from acme...\nhttps://github.com/acme/billing/pull/42\n",
			},
		);
		const answer = await openDraftPullRequest(
			runner,
			source,
			repository,
			branch,
			"Retry policy for webhooks",
			"The body",
		);
		expect(answer).toEqual({ number: 42, url: "https://github.com/acme/billing/pull/42" });
	});

	const createArgs = [
		"pr",
		"create",
		"--repo",
		"github.com/acme/billing",
		"--head",
		branch,
		"--draft",
		"--title",
		"Retry policy for webhooks",
		"--body",
		"The body",
	];

	test("a create that answers the fresh branch's lag retries until the branch stands", async () => {
		const runner = new FakeRunner();
		runner.setSequence("gh", createArgs, [
			{
				code: 1,
				stderr:
					"GraphQL: No commits exist on github.com:acme/billing:factory/7-retry-policy-for-webhooks. (HTTP 400)\n",
			},
			{ stdout: "https://github.com/acme/billing/pull/42\n" },
		]);
		const answer = await openDraftPullRequest(
			runner,
			source,
			repository,
			branch,
			"Retry policy for webhooks",
			"The body",
		);
		expect(answer).toEqual({ number: 42, url: "https://github.com/acme/billing/pull/42" });
		const creates = runner.commands().filter((command) => command === `gh ${createArgs.join(" ")}`);
		expect(creates).toHaveLength(2);
	});

	test("a create that never stops answering the fresh branch's lag stops and reports the failure", async () => {
		const runner = new FakeRunner();
		runner.set("gh", createArgs, {
			code: 1,
			stderr:
				"GraphQL: No commits exist on github.com:acme/billing:factory/7-retry-policy-for-webhooks. (HTTP 400)\n",
		});
		const answer = await openDraftPullRequest(
			runner,
			source,
			repository,
			branch,
			"Retry policy for webhooks",
			"The body",
		);
		expect("fail" in answer).toBe(true);
		if ("fail" in answer) expect(answer.fail).toContain("No commits exist");
		const creates = runner.commands().filter((command) => command === `gh ${createArgs.join(" ")}`);
		expect(creates.length).toBeGreaterThan(1);
	});

	test("a create that answers another failure is not retried", async () => {
		const runner = new FakeRunner();
		runner.set("gh", createArgs, {
			code: 1,
			stderr: "GraphQL: Pull request already exists: acme/billing#43\n",
		});
		const answer = await openDraftPullRequest(
			runner,
			source,
			repository,
			branch,
			"Retry policy for webhooks",
			"The body",
		);
		expect("fail" in answer).toBe(true);
		const creates = runner.commands().filter((command) => command === `gh ${createArgs.join(" ")}`);
		expect(creates).toHaveLength(1);
	});

	test("a create that answers no url is a failure with the answer it got", async () => {
		const runner = new FakeRunner();
		runner.set(
			"gh",
			[
				"pr",
				"create",
				"--repo",
				"github.com/acme/billing",
				"--head",
				branch,
				"--draft",
				"--title",
				"Retry policy for webhooks",
				"--body",
				"The body",
			],
			{ stdout: "" },
		);
		const answer = await openDraftPullRequest(
			runner,
			source,
			repository,
			branch,
			"Retry policy for webhooks",
			"The body",
		);
		expect("fail" in answer).toBe(true);
	});
});

describe("pullRequestBodyFor", () => {
	test("an issue ticket's pull request carries the closing reference, the url, and the description", () => {
		expect(pullRequestBodyFor(ticket)).toBe(
			"Closes #7\n\nhttps://github.com/acme/billing/issues/7\n\nAdd a retry policy.",
		);
	});

	test("a security item's pull request carries a plain reference, never a closing one", () => {
		const security: Ticket = {
			...ticket,
			sourceKind: "github-dependabot-alert",
			externalKey: "#9",
			url: "https://github.com/acme/billing/security/dependabot/9",
			description: "Bump lodash.",
			memberships: ticket.memberships.map((membership) => ({
				...membership,
				identity: "github:github.com:dep-9",
				sourceKind: "github-dependabot-alert",
				externalKey: "#9",
				url: "https://github.com/acme/billing/security/dependabot/9",
			})),
		};
		expect(pullRequestBodyFor(security)).toBe(
			"https://github.com/acme/billing/security/dependabot/9\n\nBump lodash.",
		);
	});
});

describe("readTicketOwnPullRequest", () => {
	test("synthesizes the pull request ticket from the read's record, inheriting the ticket's facts", async () => {
		const runner = new FakeRunner();
		setRead(runner, [record]);
		const answer = await readTicketOwnPullRequest(runner, [source], ticket);
		expect(answer).not.toBeNull();
		expect(answer?.identity).toBe("github:github.com:pull-github.com/acme/billing/42");
		expect(answer?.sourceKind).toBe("github-pull-request");
		expect(answer?.externalKey).toBe("#42");
		expect(answer?.url).toBe("https://github.com/acme/billing/pull/42");
		expect(answer?.labels).toEqual(["work-in-progress"]);
		// The surrogate inherits the ticket it stands for: the repository, and
		// the factory facts the ticket carries.
		expect(answer?.repositoryRef).toEqual(repository);
		expect(answer?.ignored).toBe(false);
		const membership = answer?.memberships[0];
		expect(membership?.sourceName).toBe("issues");
		expect(membership?.attributes).toEqual({
			draft: "true",
			headBranch: branch,
			baseBranch: "main",
		});
	});

	test("a ticket that lists on no source, or a source that is not configured, answers null", async () => {
		const runner = new FakeRunner();
		setRead(runner, [record]);
		const noMembership = await readTicketOwnPullRequest(runner, [source], {
			...ticket,
			memberships: [],
		});
		expect(noMembership).toBeNull();
		const noSource = await readTicketOwnPullRequest(runner, [], ticket);
		expect(noSource).toBeNull();
	});

	test("a branch that carries no open pull request answers null", async () => {
		const runner = new FakeRunner();
		setRead(runner, []);
		expect(await readTicketOwnPullRequest(runner, [source], ticket)).toBeNull();
	});
});

describe("closeCycleEndDraftPullRequest", () => {
	test("closes the draft the branch carries, and answers null when there is nothing to close", async () => {
		const runner = new FakeRunner();
		setRead(runner, [record]);
		const answer = await closeCycleEndDraftPullRequest(runner, [source], ticket);
		expect(answer).toBeNull();
		expect(runner.commands()).toEqual([
			`gh api --hostname github.com ${pullsPath}`,
			"gh pr close 42 --repo github.com/acme/billing",
		]);

		// A published pull request is never touched: only a draft closes.
		const published = new FakeRunner();
		setRead(published, [{ ...record, draft: false }]);
		expect(await closeCycleEndDraftPullRequest(published, [source], ticket)).toBeNull();
		expect(published.commands()).toEqual([`gh api --hostname github.com ${pullsPath}`]);

		// A branch with no open pull request closes nothing.
		const none = new FakeRunner();
		setRead(none, []);
		expect(await closeCycleEndDraftPullRequest(none, [source], ticket)).toBeNull();
		expect(none.commands()).toEqual([`gh api --hostname github.com ${pullsPath}`]);
	});

	test("a failed close comes back as its reason for the caller to report", async () => {
		const runner = new FakeRunner();
		setRead(runner, [record]);
		runner.set("gh", ["pr", "close", "42", "--repo", "github.com/acme/billing"], {
			code: 1,
			stderr: "GraphQL: Pull request is already merged.\n",
		});
		const answer = await closeCycleEndDraftPullRequest(runner, [source], ticket);
		expect(answer).not.toBeNull();
		expect(answer).toContain("already merged");
	});
});
