import { describe, expect, test } from "vitest";

import type { TicketSourceConfig } from "../src/config.ts";
import type { CommandOptions, CommandResult, CommandRunner } from "../src/runner.ts";
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
		expect(request).toContain("label:ready-for-agent -label:blocked");
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

	test("the default pull request policy lets needs-work drafts through but not ready-for-review drafts", async () => {
		const runner = new SourceRunner([page([pullRequest()])]);
		await createTicketSource(source("github-pull-requests"), runner).fetch();
		const request = runner.calls[0].args.join(" ");
		expect(request).toContain("is:open is:pr");
		expect(request).toContain("-label:blocked");
		expect(request).toContain("(label:needs-work OR (label:ready-for-review draft:false))");
	});

	test("multiple repositories produce one OR-joined scope", async () => {
		const runner = new SourceRunner([page([issue()])]);
		await createTicketSource(
			{ ...source("github-issues"), repositories: ["acme/factory", "acme/portal"] },
			runner,
		).fetch();
		expect(runner.calls[0].args.join(" ")).toContain("(repo:acme/factory OR repo:acme/portal)");
	});

	test("normalizes a draft pull request and carries the draft fact in its attributes", async () => {
		const runner = new SourceRunner([
			page([pullRequest(7, { isDraft: true, labels: { nodes: [{ name: "needs-work" }] } })]),
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
