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
