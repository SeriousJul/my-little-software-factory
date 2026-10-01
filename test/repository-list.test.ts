/**
 * The repository list tests: the one read the init's select list stands on
 * (ADR 0082).
 *
 * The read is one GitHub GraphQL query on the authenticated viewer: the user's
 * own repositories and the repositories of each organization the user belongs
 * to. The tests pin the command, the normalized choices, the order, the
 * de-duplication, and every way the read can fail with one line.
 */

import { describe, expect, test } from "bun:test";

import { type InitableRepository, listInitableRepositories } from "../src/repository-list.ts";
import { FakeRunner } from "./fake-runner.ts";

const HOST = "github.com";

/** One viewer answer: two own repositories, then two organizations. */
const VIEWER = {
	login: "seriousjul",
	repositories: {
		nodes: [
			{
				name: "pi-extensions",
				nameWithOwner: "SeriousJul/pi-extensions",
				url: "https://github.com/SeriousJul/pi-extensions",
			},
			{
				name: "my-little-software-factory",
				nameWithOwner: "SeriousJul/my-little-software-factory",
				url: "https://github.com/SeriousJul/my-little-software-factory",
			},
		],
	},
	organizations: {
		nodes: [
			{
				login: "acme",
				repositories: {
					nodes: [
						{
							name: "billing",
							nameWithOwner: "acme/billing",
							url: "https://github.com/acme/billing",
						},
					],
				},
			},
			{
				login: "tools",
				repositories: {
					nodes: [
						{ name: "cli", nameWithOwner: "tools/cli", url: "https://github.com/tools/cli" },
						{ name: "web", nameWithOwner: "tools/web", url: "https://github.com/tools/web" },
					],
				},
			},
		],
	},
};

function viewerAnswer(viewer: object = VIEWER): string {
	return JSON.stringify({ data: { viewer } });
}

describe("listInitableRepositories", () => {
	test("lists the own repositories first, then each organization's, in the API's order", async () => {
		const runner = new FakeRunner();
		runner.setDefault({ stdout: viewerAnswer() });
		const outcome = await listInitableRepositories(runner, HOST);
		expect(outcome.status).toBe("success");
		if (outcome.status !== "success") return;
		const names = outcome.repositories.map((item) => item.displayName);
		expect(names).toEqual([
			"SeriousJul/pi-extensions",
			"SeriousJul/my-little-software-factory",
			"acme/billing",
			"tools/cli",
			"tools/web",
		]);
		expect(outcome.repositories[0]).toEqual({
			identity: "github.com/seriousjul/pi-extensions",
			displayName: "SeriousJul/pi-extensions",
			owner: "SeriousJul",
			name: "pi-extensions",
			htmlUrl: "https://github.com/SeriousJul/pi-extensions",
		} satisfies InitableRepository);
	});

	test("sends the viewer query to the named host through gh", async () => {
		const runner = new FakeRunner();
		runner.setDefault({ stdout: viewerAnswer() });
		await listInitableRepositories(runner, HOST);
		expect(runner.calls).toHaveLength(1);
		const call = runner.calls[0];
		expect(call.command).toBe("gh");
		expect(call.args[0]).toBe("api");
		expect(call.args[1]).toBe("graphql");
		expect(call.args[call.args.indexOf("--hostname") + 1]).toBe(HOST);
		const query = call.args[call.args.indexOf("-f") + 1];
		expect(query).toContain("viewer");
		expect(query).toContain("organizations");
	});

	test("keeps one choice per identity when the API lists a repository twice", async () => {
		const runner = new FakeRunner();
		runner.setDefault({
			stdout: viewerAnswer({
				...VIEWER,
				repositories: {
					nodes: [
						{
							name: "billing",
							nameWithOwner: "acme/billing",
							url: "https://github.com/acme/billing",
						},
						{
							name: "billing",
							nameWithOwner: "acme/billing",
							url: "https://github.com/acme/billing",
						},
					],
				},
				organizations: { nodes: [] },
			}),
		});
		const outcome = await listInitableRepositories(runner, HOST);
		expect(outcome.status).toBe("success");
		if (outcome.status !== "success") return;
		expect(outcome.repositories).toHaveLength(1);
	});

	test("a viewer without a single repository lists none", async () => {
		const runner = new FakeRunner();
		runner.setDefault({
			stdout: viewerAnswer({
				login: "nobody",
				repositories: { nodes: [] },
				organizations: { nodes: [] },
			}),
		});
		const outcome = await listInitableRepositories(runner, HOST);
		expect(outcome).toEqual({ status: "success", repositories: [] });
	});

	test("a gh failure fails the read with the command's text", async () => {
		const runner = new FakeRunner();
		runner.setDefault({ code: 4, stderr: "gh: Not logged in to github.com" });
		const outcome = await listInitableRepositories(runner, HOST);
		expect(outcome.status).toBe("failed");
		if (outcome.status !== "failed") return;
		expect(outcome.reason).toContain("Not logged in");
	});

	test("an API error fails the read with the error's message", async () => {
		const runner = new FakeRunner();
		runner.setDefault({ stdout: JSON.stringify({ errors: [{ message: "Bad query (line 1)" }] }) });
		const outcome = await listInitableRepositories(runner, HOST);
		expect(outcome.status).toBe("failed");
		if (outcome.status !== "failed") return;
		expect(outcome.reason).toContain("Bad query");
	});

	test("an unreadable answer fails the read with one line", async () => {
		const runner = new FakeRunner();
		runner.setDefault({ stdout: "this is not json" });
		const outcome = await listInitableRepositories(runner, HOST);
		expect(outcome.status).toBe("failed");
	});

	test("a node without its readable facts fails the read", async () => {
		const runner = new FakeRunner();
		runner.setDefault({
			stdout: JSON.stringify({
				data: {
					viewer: {
						login: "x",
						repositories: { nodes: [{ name: "a" }] },
						organizations: { nodes: [] },
					},
				},
			}),
		});
		const outcome = await listInitableRepositories(runner, HOST);
		expect(outcome.status).toBe("failed");
	});
});
