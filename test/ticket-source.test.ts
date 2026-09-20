import { describe, expect, test } from "vitest";

import type { TicketSourceConfig } from "../src/config.ts";
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";
import { createTicketSource } from "../src/ticket-source.ts";

interface SafeCall {
	command: string;
	args: readonly string[];
	secretEnvironmentNames: readonly string[];
}

/** Records command facts without retaining environment values. */
class SourceRunner implements CommandRunner {
	readonly calls: SafeCall[] = [];
	private readonly responses: CommandResult[];

	constructor(responses: CommandResult[]) {
		this.responses = responses;
	}

	async run(
		command: string,
		args: readonly string[],
		options?: CommandOptions,
	): Promise<CommandResult> {
		this.calls.push({ command, args, secretEnvironmentNames: options?.secretEnv ?? [] });
		return this.responses.shift() ?? { code: 0, stdout: "", stderr: "" };
	}

	async listModels(kind: string): Promise<ModelListResult> {
		return { ok: false, reason: `the source runner holds no model list for "${kind}"` };
	}
}

const source = (kind: TicketSourceConfig["kind"]): TicketSourceConfig => ({
	name: kind,
	kind,
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
});

function page(
	nodes: unknown[],
	hasNextPage = false,
	endCursor: string | null = null,
): CommandResult {
	return {
		code: 0,
		stdout: JSON.stringify({
			data: {
				search: {
					issueCount: nodes.length,
					pageInfo: { hasNextPage, endCursor },
					nodes,
				},
			},
		}),
		stderr: "",
	};
}

function searchQueryOf(call: SafeCall): string {
	const index = call.args.findIndex((arg) => arg.startsWith("searchQuery="));
	return call.args[index].slice("searchQuery=".length);
}

function issue(number = 5): object {
	return {
		__typename: "Issue",
		id: `I_${number}`,
		number,
		title: "Use real tickets",
		body: null,
		url: `https://github.com/acme/factory/issues/${number}`,
		state: "OPEN",
		updatedAt: "2026-08-31T10:00:00Z",
		labels: { nodes: [{ name: "ready-for-agent" }] },
		repository: {
			name: "factory",
			nameWithOwner: "acme/factory",
			url: "https://github.com/acme/factory",
		},
	};
}

describe("GitHub ticket sources", () => {
	test("normalizes a complete Issues snapshot and applies its default policy", async () => {
		const runner = new SourceRunner([page([issue()])]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();

		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets).toEqual([
			expect.objectContaining({
				identity: "github:github.com:I_5",
				sourceKind: "github-issue",
				externalKey: "#5",
				description: "",
				repository: {
					identity: "github.com/acme/factory",
					displayName: "acme/factory",
					cloneUrl: "https://github.com/acme/factory.git",
				},
			}),
		]);
		const request = runner.calls[0].args.join(" ");
		expect(request).toContain("is:open is:issue");
		expect(request).toContain("repo:acme/factory");
		// The plane owns the workflow labels (ADR 0027): the default query does
		// not require a workflow label for a ticket to be seen.
		expect(request).toContain("-label:blocked");
		expect(request).not.toContain("label:ready-for-agent");
	});

	test("reads every page before returning a snapshot", async () => {
		const runner = new SourceRunner([page([issue(1)], true, "cursor-1"), page([issue(2)])]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status === "success")
			expect(outcome.tickets.map((ticket) => ticket.externalKey)).toEqual(["#1", "#2"]);
		expect(runner.calls[1].args).toContain("after=cursor-1");
	});

	test("rejects a source result of the wrong kind", async () => {
		const runner = new SourceRunner([
			page([{ ...issue(), __typename: "PullRequest", isDraft: false }]),
		]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({ status: "failed", reason: expect.stringContaining("PullRequest") }),
		);
	});

	test("rejects an item outside the configured repository scope", async () => {
		const runner = new SourceRunner([
			page([{ ...issue(), repository: { name: "other", nameWithOwner: "acme/other" } }]),
		]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: expect.stringContaining("outside configured"),
			}),
		);
	});

	test("passes literal tokens through a secret environment, not argv or command facts", async () => {
		const runner = new SourceRunner([page([issue()])]);
		const outcome = await createTicketSource(
			{ ...source("github-issues"), auth: { token: "secret-token-value" } },
			runner,
		).fetch();
		expect(outcome.status).toBe("success");
		expect(runner.calls[0].args.join(" ")).not.toContain("secret-token-value");
		expect(runner.calls[0].secretEnvironmentNames).toEqual(["GH_TOKEN"]);
	});
});

describe("GitHub ticket source contract", () => {
	function pullRequest(number = 5, over: object = {}): object {
		return {
			__typename: "PullRequest",
			id: `P_${number}`,
			number,
			title: "Add a webhook retry",
			body: "Please review.",
			url: `https://github.com/acme/factory/pulls/${number}`,
			state: "OPEN",
			updatedAt: "2026-08-31T11:00:00Z",
			isDraft: false,
			labels: { nodes: [{ name: "ready-for-review" }] },
			repository: {
				name: "factory",
				nameWithOwner: "acme/factory",
				url: "https://github.com/acme/factory",
			},
			...over,
		};
	}

	test("a custom filter replaces the readiness defaults but keeps kind and scope", async () => {
		const runner = new SourceRunner([page([issue()])]);
		const outcome = await createTicketSource(
			{ ...source("github-issues"), filter: "label:epic author:me" },
			runner,
		).fetch();
		expect(outcome.status).toBe("success");
		const request = runner.calls[0].args.join(" ");
		expect(request).toContain("is:issue repo:acme/factory label:epic author:me");
		expect(request).not.toContain("ready-for-agent");
		expect(request).not.toContain("blocked");

		// The same rule holds for pull requests: no draft policy either.
		const prRunner = new SourceRunner([page([pullRequest()])]);
		await createTicketSource(
			{ ...source("github-pull-requests"), filter: "label:epic" },
			prRunner,
		).fetch();
		const prRequest = prRunner.calls[0].args.join(" ");
		expect(prRequest).toContain("is:pr repo:acme/factory label:epic");
		expect(prRequest).not.toContain("ready-for-review");
		expect(prRequest).not.toContain("draft:false");
	});

	test("the default pull request policy lists every open pull request a draft rule allows", async () => {
		const runner = new SourceRunner([page([pullRequest()]), page([pullRequest()])]);
		const outcome = await createTicketSource(source("github-pull-requests"), runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		// The plane owns the workflow labels (ADR 0027), so an open pull
		// request enters the list before it carries one: that is how the
		// implement transition finds the pull request the agent just opened.
		expect(runner.calls).toHaveLength(2);
		const needsWork = runner.calls[0].args.join(" ");
		const openPulls = runner.calls[1].args.join(" ");
		expect(needsWork).toContain("is:open is:pr repo:acme/factory -label:blocked label:needs-work");
		expect(needsWork).not.toContain("no:draft");
		expect(openPulls).toContain("is:open is:pr repo:acme/factory -label:blocked no:draft");
		expect(openPulls).not.toContain("label:ready-for-review");
		expect(openPulls).not.toContain("label:ready-to-ship");
		for (const query of [searchQueryOf(runner.calls[0]), searchQueryOf(runner.calls[1])]) {
			expect(query).not.toMatch(/\bOR\b/);
			expect(query).not.toContain("(");
			expect(query).not.toContain("draft:false");
		}
		// Both queries matched the same pull request. The snapshot keeps one copy.
		if (outcome.status === "success") expect(outcome.tickets).toHaveLength(1);
	});

	test("multiple repositories produce one query per repository", async () => {
		const runner = new SourceRunner([page([issue()]), page([issue()])]);
		const outcome = await createTicketSource(
			{ ...source("github-issues"), repositories: ["acme/factory", "acme/portal"] },
			runner,
		).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		expect(runner.calls).toHaveLength(2);
		expect(searchQueryOf(runner.calls[0])).toContain("repo:acme/factory");
		expect(searchQueryOf(runner.calls[1])).toContain("repo:acme/portal");
		for (const call of runner.calls) {
			const query = searchQueryOf(call);
			expect(query).not.toMatch(/\bOR\b/);
			expect(query).not.toContain("(");
		}
		// Both queries matched the same issue. The snapshot keeps one copy.
		if (outcome.status === "success") expect(outcome.tickets).toHaveLength(1);
	});

	test("a failure on a later query fails the whole fetch", async () => {
		const runner = new SourceRunner([
			page([pullRequest()]),
			{ code: 1, stdout: "", stderr: "HTTP 502: bad gateway\n" },
		]);
		const outcome = await createTicketSource(source("github-pull-requests"), runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub request failed: HTTP 502: bad gateway",
			}),
		);
	});

	test("normalizes a draft pull request and carries the draft fact in its attributes", async () => {
		const runner = new SourceRunner([
			page([pullRequest(7, { isDraft: true, labels: { nodes: [{ name: "needs-work" }] } })]),
			page([]),
			page([]),
		]);
		const outcome = await createTicketSource(source("github-pull-requests"), runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0]).toEqual(
			expect.objectContaining({
				identity: "github:github.com:P_7",
				sourceKind: "github-pull-request",
				externalKey: "#7",
				attributes: { draft: "true" },
			}),
		);
	});

	test("a pull request without a draft fact is an unreadable failure", async () => {
		const node = pullRequest() as Record<string, unknown>;
		delete node.isDraft;
		const runner = new SourceRunner([page([node])]);
		const outcome = await createTicketSource(source("github-pull-requests"), runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: expect.stringContaining("unreadable pull request"),
			}),
		);
	});

	test("a page failure fails the whole fetch", async () => {
		const runner = new SourceRunner([
			page([issue(1)], true, "cursor-1"),
			{ code: 1, stdout: "", stderr: "HTTP 502: bad gateway\n" },
		]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub request failed: HTTP 502: bad gateway",
			}),
		);
	});

	test("a rate limit is a readable source failure", async () => {
		const runner = new SourceRunner([{ code: 1, stdout: "", stderr: "rate limit exceeded\n" }]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub request failed: rate limit exceeded",
			}),
		);
	});

	test("malformed output is a readable source failure", async () => {
		let outcome = await createTicketSource(
			source("github-issues"),
			new SourceRunner([{ code: 0, stdout: "this is not json", stderr: "" }]),
		).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({ status: "failed", reason: "GitHub returned invalid JSON" }),
		);

		outcome = await createTicketSource(
			source("github-issues"),
			new SourceRunner([
				{
					code: 0,
					stdout: JSON.stringify({ errors: [{ message: "Field 'search' is missing" }] }),
					stderr: "",
				},
			]),
		).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub API error: Field 'search' is missing",
			}),
		);

		outcome = await createTicketSource(
			source("github-issues"),
			new SourceRunner([{ code: 0, stdout: JSON.stringify({ data: {} }), stderr: "" }]),
		).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub returned an unreadable search response",
			}),
		);

		outcome = await createTicketSource(
			source("github-issues"),
			new SourceRunner([page([issue(1)], true, null)]),
		).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub returned a next page without a cursor",
			}),
		);
	});

	test("noise before the JSON body is tolerated", async () => {
		const runner = new SourceRunner([
			{
				code: 0,
				stdout: `shim activation notice\n${JSON.stringify({
					data: {
						search: {
							issueCount: 1,
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [issue()],
						},
					},
				})}`,
				stderr: "",
			},
		]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
	});

	test("1,000 or more search results is an incomplete, failed fetch", async () => {
		const counted = (count: number): CommandResult => ({
			code: 0,
			stdout: JSON.stringify({
				data: {
					search: {
						issueCount: count,
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [issue()],
					},
				},
			}),
			stderr: "",
		});
		let outcome = await createTicketSource(
			source("github-issues"),
			new SourceRunner([counted(1000)]),
		).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub search has 1,000 or more results and is incomplete",
			}),
		);
		outcome = await createTicketSource(
			source("github-issues"),
			new SourceRunner([counted(999)]),
		).fetch();
		expect(outcome).toMatchObject({ status: "success" });
	});

	test("a missing token environment variable fails before any command runs", async () => {
		const runner = new SourceRunner([]);
		const outcome = await createTicketSource(
			{ ...source("github-issues"), auth: { tokenEnv: "FACTORY_TOKEN" } },
			runner,
			{},
		).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub token environment variable FACTORY_TOKEN is not set",
			}),
		);
		expect(runner.calls).toHaveLength(0);
	});

	test("account authentication reads the token once and passes it only through the secret environment", async () => {
		const authCall = { code: 0, stdout: "account-token-value\n", stderr: "" };
		const runner = new SourceRunner([authCall, page([issue()]), page([issue()])]);
		const ticketSource = createTicketSource(
			{ ...source("github-issues"), auth: { account: "seriousjul" } },
			runner,
		);

		const first = await ticketSource.fetch();
		expect(first.status).toBe("success");
		expect(runner.calls[0].args.join(" ")).toBe(
			"auth token --hostname github.com --user seriousjul",
		);
		expect(runner.calls[0].secretEnvironmentNames).toEqual([]);
		expect(runner.calls[1].secretEnvironmentNames).toEqual(["GH_TOKEN"]);
		expect(runner.calls[1].args.join(" ")).not.toContain("account-token-value");

		// A second fetch of the same source reuses the cached account token.
		const second = await ticketSource.fetch();
		expect(second.status).toBe("success");
		expect(runner.calls).toHaveLength(3);
		expect(runner.calls[2].args.join(" ")).not.toBe(
			"auth token --hostname github.com --user seriousjul",
		);
		expect(runner.calls[2].secretEnvironmentNames).toEqual(["GH_TOKEN"]);
	});
});

describe("pull request reference reads (ADR 0023)", () => {
	const prSource = source("github-pull-requests");

	/** One pull request node as the search response resolves it. */
	function pullRequestClosing(over: object = {}): object {
		return {
			__typename: "PullRequest",
			id: "P_7",
			number: 7,
			title: "Add a webhook retry",
			body: "Please review.",
			url: "https://github.com/acme/factory/pulls/7",
			state: "OPEN",
			updatedAt: "2026-08-31T11:00:00Z",
			isDraft: false,
			labels: { nodes: [{ name: "ready-for-review" }] },
			repository: {
				name: "factory",
				nameWithOwner: "acme/factory",
				url: "https://github.com/acme/factory",
			},
			...over,
		};
	}

	/**
	 * One referenced issue node as the search response resolves it. No
	 * labels: the nested label connection put the search over GitHub's
	 * possible-node budget (issue #65).
	 */
	function referenceIssue(number = 5, over: object = {}): object {
		return {
			__typename: "Issue",
			id: `I_${number}`,
			number,
			repository: { name: "factory", nameWithOwner: "acme/factory" },
			...over,
		};
	}

	/** The three search pages a single repository's pull request fetch reads
		(one per policy branch). */
	function prPages(...pages: unknown[][]): CommandResult[] {
		return pages.map((nodes) => page(nodes));
	}

	/** One canned answer for the batched direct read. */
	function referenceRead(...entries: (object | null)[]): CommandResult {
		const data: Record<string, unknown> = {};
		entries.forEach((entry, index) => {
			data[`reference${index}`] = entry;
		});
		return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
	}

	test("a pull request's closing references are stored as source facts", async () => {
		const runner = new SourceRunner(
			prPages(
				[pullRequestClosing({ closingIssuesReferences: { nodes: [referenceIssue(5)] } })],
				[],
			),
		);
		const outcome = await createTicketSource(prSource, runner).fetch([
			{ identity: "github:github.com:I_5", labels: ["critical"] },
		]);
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0]).toEqual(
			expect.objectContaining({
				identity: "github:github.com:P_7",
				attributes: {
					draft: "false",
					closes: JSON.stringify([
						{
							identity: "github:github.com:I_5",
							number: 5,
							repository: "acme/factory",
						},
					]),
				},
			}),
		);
	});

	test("every reference covered by the snapshot costs no extra request", async () => {
		const runner = new SourceRunner(
			prPages(
				[
					pullRequestClosing({
						closingIssuesReferences: { nodes: [referenceIssue(5), referenceIssue(6)] },
					}),
				],
				[],
			),
		);
		const outcome = await createTicketSource(prSource, runner).fetch([
			{ identity: "github:github.com:I_5", labels: ["critical"] },
			{ identity: "github:github.com:I_6", labels: ["critical"] },
		]);
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		// The two search queries, nothing else: the snapshot covers both.
		expect(runner.calls).toHaveLength(2);
		expect(outcome.referencedIssueFacts).toEqual([
			{
				identity: "github:github.com:I_5",
				labels: ["critical"],
				fetchedAt: expect.any(String),
			},
			{
				identity: "github:github.com:I_6",
				labels: ["critical"],
				fetchedAt: expect.any(String),
			},
		]);
	});

	test("one uncovered reference costs exactly one batched read", async () => {
		const runner = new SourceRunner([
			...prPages(
				[
					pullRequestClosing({
						closingIssuesReferences: { nodes: [referenceIssue(5), referenceIssue(6)] },
					}),
				],
				[],
			),
			referenceRead({
				id: "I_6",
				number: 6,
				title: "Use real tickets",
				labels: { nodes: [{ name: "high" }] },
			}),
		]);
		const outcome = await createTicketSource(prSource, runner).fetch([
			{ identity: "github:github.com:I_5", labels: ["critical"] },
		]);
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(runner.calls).toHaveLength(3);
		const read = runner.calls[2].args.join(" ");
		expect(read).toContain("api graphql");
		// The covered reference is not in the read; the uncovered one is
		// addressed by its identity.
		expect(read).toContain("node(id: $ref0Id)");
		expect(read).toContain("ref0Id=I_6");
		expect(read).not.toContain("ref1Id");
		expect(outcome.referencedIssueFacts).toEqual([
			{
				identity: "github:github.com:I_5",
				labels: ["critical"],
				fetchedAt: expect.any(String),
			},
			{
				identity: "github:github.com:I_6",
				labels: ["high"],
				fetchedAt: expect.any(String),
			},
		]);
	});

	test("a reference without an identity is read by repository and number", async () => {
		const runner = new SourceRunner([
			...prPages(
				[
					pullRequestClosing({
						closingIssuesReferences: { nodes: [referenceIssue(6, { id: null })] },
					}),
				],
				[],
			),
			referenceRead({
				issue: {
					id: "I_6",
					number: 6,
					title: "Use real tickets",
					labels: { nodes: [{ name: "high" }] },
				},
			}),
		]);
		const outcome = await createTicketSource(prSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		const read = runner.calls[2].args.join(" ");
		expect(read).toContain("repository(owner: $ref0Owner, name: $ref0Name)");
		expect(read).toContain("issue(number: $ref0Number)");
		expect(read).toContain("ref0Owner=acme");
		expect(read).toContain("ref0Name=factory");
		expect(read).toContain("ref0Number=6");
		expect(outcome.tickets[0]).toEqual(
			expect.objectContaining({
				attributes: {
					draft: "false",
					closes: JSON.stringify([{ identity: null, number: 6, repository: "acme/factory" }]),
				},
			}),
		);
		expect(outcome.referencedIssueFacts).toEqual([
			{
				identity: "github:github.com:I_6",
				labels: ["high"],
				fetchedAt: expect.any(String),
			},
		]);
	});

	test("a failed batched read succeeds the refresh with one warning and no facts", async () => {
		const runner = new SourceRunner([
			...prPages(
				[pullRequestClosing({ closingIssuesReferences: { nodes: [referenceIssue(5)] } })],
				[],
			),
			{ code: 1, stdout: "", stderr: "HTTP 500: internal error\n" },
		]);
		const outcome = await createTicketSource(prSource, runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "success",
				tickets: [expect.objectContaining({ identity: "github:github.com:P_7" })],
				warnings: ["referenced issue read failed: GitHub request failed: HTTP 500: internal error"],
			}),
		);
		if (outcome.status !== "success") return;
		expect(outcome.referencedIssueFacts).toBeUndefined();
	});

	test("an unresolved reference in a successful read carries no fact", async () => {
		const runner = new SourceRunner([
			...prPages(
				[
					pullRequestClosing({
						closingIssuesReferences: { nodes: [referenceIssue(5), referenceIssue(6)] },
					}),
				],
				[],
			),
			referenceRead({
				id: "I_5",
				number: 5,
				title: "Use real tickets",
				labels: { nodes: [{ name: "critical" }] },
			}),
		]);
		const outcome = await createTicketSource(prSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		// I_6 did not resolve: its previous fact stays, the outcome carries
		// only the resolved reference's fact.
		expect(outcome.referencedIssueFacts).toEqual([
			{
				identity: "github:github.com:I_5",
				labels: ["critical"],
				fetchedAt: expect.any(String),
			},
		]);
	});

	test("an issue source refresh issues no reference read", async () => {
		const runner = new SourceRunner([page([issue()])]);
		const outcome = await createTicketSource(source("github-issues"), runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		// The single search query: no direct read is issued.
		expect(runner.calls).toHaveLength(1);
		for (const call of runner.calls)
			expect(call.args.join(" ")).not.toContain("FactoryReferenceRead");
		expect(outcome.referencedIssueFacts).toBeUndefined();
	});

	test("the search query carries no labels on the reference nodes (issue #65)", async () => {
		const runner = new SourceRunner(
			prPages(
				[pullRequestClosing({ closingIssuesReferences: { nodes: [referenceIssue(5)] } })],
				[],
			),
		);
		await createTicketSource(prSource, runner).fetch();
		const call = runner.calls[0];
		const query = (call.args.find((arg) => arg.startsWith("query=")) ?? "")
			.replace("query=", "")
			.replace(/\s+/g, " ");
		// A nested label connection puts the query over GitHub's 500,000
		// possible-node budget, so the reference nodes carry no labels.
		expect(query).toContain(
			"closingIssuesReferences(first: 100) { nodes { id number repository { name nameWithOwner } } }",
		);
	});

	test("uncovered references are read in chunks of 250 (issue #65)", async () => {
		const answer = (number: number) => ({
			id: `I_${number}`,
			number,
			labels: { nodes: [{ name: "high" }] },
		});
		const references = Array.from({ length: 300 }, (_, index) => referenceIssue(101 + index));
		const runner = new SourceRunner([
			...prPages([pullRequestClosing({ closingIssuesReferences: { nodes: references } })], []),
			referenceRead(...Array.from({ length: 250 }, (_, index) => answer(101 + index))),
			referenceRead(...Array.from({ length: 50 }, (_, index) => answer(351 + index))),
		]);
		const outcome = await createTicketSource(prSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		// Two search pages, then two read chunks: 250, then 50.
		expect(runner.calls).toHaveLength(4);
		const firstRead = runner.calls[2].args.join(" ");
		const secondRead = runner.calls[3].args.join(" ");
		expect(firstRead).toContain("ref249Id");
		expect(firstRead).not.toContain("ref250Id");
		expect(secondRead).toContain("ref49Id");
		expect(secondRead).not.toContain("ref50Id");
		expect(outcome.referencedIssueFacts).toHaveLength(300);
		expect(outcome.referencedIssueFacts?.[0]).toMatchObject({
			identity: "github:github.com:I_101",
			labels: ["high"],
		});
		expect(outcome.referencedIssueFacts?.[299]).toMatchObject({
			identity: "github:github.com:I_400",
			labels: ["high"],
		});
	});

	test("a failed later chunk fails the whole read with one warning (issue #65)", async () => {
		const references = Array.from({ length: 251 }, (_, index) => referenceIssue(101 + index));
		const runner = new SourceRunner([
			...prPages([pullRequestClosing({ closingIssuesReferences: { nodes: references } })], []),
			referenceRead(
				...Array.from({ length: 250 }, (_, index) => ({
					id: `I_${101 + index}`,
					number: 101 + index,
					labels: { nodes: [{ name: "high" }] },
				})),
			),
			{ code: 1, stdout: "", stderr: "HTTP 500: internal error\n" },
		]);
		const outcome = await createTicketSource(prSource, runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "success",
				warnings: ["referenced issue read failed: GitHub request failed: HTTP 500: internal error"],
			}),
		);
		if (outcome.status !== "success") return;
		// The whole read failed: no facts, so the previous facts stay in place.
		expect(outcome.referencedIssueFacts).toBeUndefined();
	});
});
