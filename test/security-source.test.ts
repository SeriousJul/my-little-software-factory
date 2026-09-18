/**
 * The security feed ticket sources (issue #73).
 *
 * The external behavior only: the exact `gh` argv a source issues, the exact
 * fetch outcome it returns, and the normalized ticket facts per kind. No
 * test reaches a real GitHub.
 */
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

/** One JSON array page body. */
function json(items: unknown[]): CommandResult {
	return { code: 0, stdout: JSON.stringify(items), stderr: "" };
}

const advisorySource: TicketSourceConfig = {
	name: "advisories",
	kind: "github-security-advisories",
	refreshIntervalSeconds: 300,
	repositories: ["acme/factory"],
	host: "github.com",
};

const dependabotSource: TicketSourceConfig = {
	name: "dependabot",
	kind: "github-dependabot-alerts",
	refreshIntervalSeconds: 300,
	repositories: ["acme/factory"],
	host: "github.com",
};

const secretSource: TicketSourceConfig = {
	name: "secrets",
	kind: "github-secret-scanning-alerts",
	refreshIntervalSeconds: 300,
	repositories: ["acme/factory"],
	host: "github.com",
};

function advisory(over: object = {}): object {
	return {
		ghsa_id: "GHSA-1111-2222-3333",
		cve_id: "CVE-2026-0001",
		summary: "Improper input validation in left-pad",
		description: "left-pad allows remote attackers to trigger a denial of service.",
		severity: "high",
		state: "published",
		url: "https://api.github.com/advisories/GHSA-1111-2222-3333",
		html_url: "https://github.com/github/advisories/GHSA-1111-2222-3333",
		published_at: "2026-07-01T00:00:00Z",
		updated_at: "2026-08-01T00:00:00Z",
		vulnerabilities: [
			{
				package: { ecosystem: "npm", name: "left-pad" },
				vulnerable_version_range: "<= 1.3.1",
				first_patched_version: "1.3.2",
			},
		],
		...over,
	};
}

function dependabotAlert(over: object = {}): object {
	return {
		number: 7,
		state: "open",
		security_advisory: {
			ghsa_id: "GHSA-4444-5555-6666",
			cve_id: "CVE-2026-0002",
			severity: "high",
			cvss: { score: 7.2, vector_string: "CVSS:3.1/AV:N" },
			summary: "Prototype pollution in lodash",
			description: "Versions of lodash before 4.17.19 are vulnerable to prototype pollution.",
			published_at: "2026-06-01T00:00:00Z",
			updated_at: "2026-07-01T00:00:00Z",
		},
		security_vulnerability: {
			package: { ecosystem: "npm", name: "lodash" },
			vulnerable_version_range: ">= 4.17.0, < 4.17.19",
			first_patched_version: "4.17.19",
			severity: "high",
		},
		manifest_path: "package-lock.json",
		scope: "unspecified",
		created_at: "2026-07-10T00:00:00Z",
		updated_at: "2026-08-10T00:00:00Z",
		html_url: "https://github.com/acme/factory/security/dependabot/7",
		repository: {
			full_name: "acme/factory",
			name: "factory",
			html_url: "https://github.com/acme/factory",
		},
		...over,
	};
}

function secretAlert(over: object = {}): object {
	return {
		id: 900,
		number: 1,
		state: "open",
		secret_type: { id: 5, name: "AWS Access Key" },
		location: { file: "config.py", start_line: 3, end_line: 3 },
		commit: "abc123",
		created_at: "2026-08-05T00:00:00Z",
		updated_at: null,
		html_url: "https://github.com/acme/factory/security/secret-scanning/1",
		...over,
	};
}

describe("the security advisory source", () => {
	test("reads one request per working state, in order, and stops on a short page", async () => {
		const runner = new SourceRunner([
			json([advisory()]),
			json([]),
			json([advisory({ ghsa_id: "GHSA-9999-8888-7777", summary: "A triage report" })]),
		]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		expect(runner.calls).toHaveLength(3);
		expect(runner.calls[0].args.join(" ")).toBe(
			"api repos/acme/factory/security-advisories --hostname github.com -f state=triage -f per_page=100 -f page=1",
		);
		expect(runner.calls[1].args.join(" ")).toContain("-f state=draft");
		expect(runner.calls[2].args.join(" ")).toContain("-f state=published");
		if (outcome.status !== "success") return;
		expect(outcome.tickets.map((ticket) => ticket.externalKey)).toEqual([
			"GHSA-1111-2222-3333",
			"GHSA-9999-8888-7777",
		]);
	});

	test("several repositories read in order, one call set per repository", async () => {
		const runner = new SourceRunner([json([]), json([]), json([]), json([]), json([]), json([])]);
		await createTicketSource(
			{ ...advisorySource, repositories: ["acme/factory", "acme/portal"] },
			runner,
		).fetch();
		expect(runner.calls).toHaveLength(6);
		expect(runner.calls[0].args.join(" ")).toContain("repos/acme/factory/security-advisories");
		expect(runner.calls[3].args.join(" ")).toContain("repos/acme/portal/security-advisories");
		expect(runner.calls[3].args.join(" ")).toContain("-f state=triage");
	});

	test("paginates until a page returns fewer than 100 items", async () => {
		const pageOne = Array.from({ length: 100 }, (_, index) =>
			advisory({ ghsa_id: `GHSA-PAGE1-${index}` }),
		);
		const pageTwo = Array.from({ length: 100 }, (_, index) =>
			advisory({ ghsa_id: `GHSA-PAGE2-${index}` }),
		);
		const shortPage = [
			advisory({ ghsa_id: "GHSA-PAGE3-0" }),
			advisory({ ghsa_id: "GHSA-PAGE3-1" }),
		];
		const runner = new SourceRunner([
			json(pageOne),
			json(pageTwo),
			json(shortPage),
			json([]),
			json([]),
		]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		// The triage state paginates 100 + 100 + 2; the other states stop on
		// their first page.
		expect(runner.calls).toHaveLength(5);
		expect(runner.calls[1].args.join(" ")).toContain("-f page=2");
		expect(runner.calls[2].args.join(" ")).toContain("-f page=3");
		expect(outcome.tickets).toHaveLength(202);
	});

	test("normalizes one advisory item into its ticket facts", async () => {
		const runner = new SourceRunner([json([advisory()]), json([]), json([])]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0]).toEqual({
			identity: "github:github.com:GHSA-1111-2222-3333",
			sourceKind: "github-security-advisory",
			externalKey: "GHSA-1111-2222-3333",
			sourceState: "published",
			url: "https://github.com/github/advisories/GHSA-1111-2222-3333",
			title: "Improper input validation in left-pad",
			description:
				"left-pad allows remote attackers to trigger a denial of service.\n\n" +
				"Affected components:\n" +
				"- npm left-pad: vulnerable <= 1.3.1, first patched 1.3.2",
			labels: ["high"],
			externalUpdatedAt: "2026-08-01T00:00:00Z",
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: {},
		});
	});

	test("an advisory without a severity carries no label", async () => {
		const item = advisory() as Record<string, unknown>;
		delete item.severity;
		const runner = new SourceRunner([json([item]), json([]), json([])]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].labels).toEqual([]);
	});

	test("an advisory without vulnerable components keeps its plain description", async () => {
		const item = advisory() as Record<string, unknown>;
		delete item.vulnerabilities;
		const runner = new SourceRunner([json([item]), json([]), json([])]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].description).toBe(
			"left-pad allows remote attackers to trigger a denial of service.",
		);
	});

	test("a null updated-at falls back to the published-at", async () => {
		const runner = new SourceRunner([json([advisory({ updated_at: null })]), json([]), json([])]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].externalUpdatedAt).toBe("2026-07-01T00:00:00Z");
	});

	test("a missing gh id is an unreadable failure", async () => {
		const item = advisory() as Record<string, unknown>;
		delete item.ghsa_id;
		const runner = new SourceRunner([json([item])]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub returned an unreadable security advisory",
			}),
		);
	});

	test("a failed request on a later state fails the whole fetch", async () => {
		const runner = new SourceRunner([
			json([advisory()]),
			{ code: 1, stdout: "", stderr: "HTTP 403: resource not accessible by the token\n" },
			json([]),
		]);
		const outcome = await createTicketSource(advisorySource, runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub request failed: HTTP 403: resource not accessible by the token",
			}),
		);
	});

	test("malformed output is a readable source failure", async () => {
		const outcome = await createTicketSource(
			advisorySource,
			new SourceRunner([{ code: 0, stdout: "this is not json", stderr: "" }]),
		).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({ status: "failed", reason: "GitHub returned invalid JSON" }),
		);
	});
});

describe("the Dependabot alerts source", () => {
	test("reads one open-state request per repository and stops on a short page", async () => {
		const runner = new SourceRunner([
			json([dependabotAlert()]),
			json([dependabotAlert()]),
			json([dependabotAlert()]),
		]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0].args.join(" ")).toBe(
			"api repos/acme/factory/dependabot/alerts --hostname github.com -f state=open -f per_page=100 -f page=1",
		);
		if (outcome.status !== "success") return;
		expect(outcome.tickets).toHaveLength(1);
	});

	test("paginates until a page returns fewer than 100 items", async () => {
		const fullPage = Array.from({ length: 100 }, (_, index) =>
			dependabotAlert({ number: index + 1 }),
		);
		const runner = new SourceRunner([json(fullPage), json([dependabotAlert({ number: 101 })])]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(runner.calls).toHaveLength(2);
		expect(runner.calls[1].args.join(" ")).toContain("-f page=2");
		expect(outcome.tickets).toHaveLength(101);
	});

	test("normalizes one alert into its ticket facts", async () => {
		const runner = new SourceRunner([json([dependabotAlert()])]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0]).toEqual({
			identity: "github:github.com:acme/factory:dependabot:7",
			sourceKind: "github-dependabot-alert",
			externalKey: "#7",
			sourceState: "open",
			url: "https://github.com/acme/factory/security/dependabot/7",
			title: "CVE-2026-0002: Prototype pollution in lodash",
			description:
				"Package: lodash\n" +
				"Ecosystem: npm\n" +
				"Manifest: package-lock.json\n" +
				"Scope: unspecified\n" +
				"Vulnerable range: >= 4.17.0, < 4.17.19\n" +
				"First patched version: 4.17.19\n" +
				"Severity: high\n" +
				"CVSS score: 7.2\n\n" +
				"Versions of lodash before 4.17.19 are vulnerable to prototype pollution.",
			labels: ["high"],
			externalUpdatedAt: "2026-08-10T00:00:00Z",
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: {},
		});
	});

	test("the title carries the GHSA id when the advisory has no CVE", async () => {
		const item = dependabotAlert() as Record<string, unknown>;
		const advisory = item.security_advisory as Record<string, unknown>;
		delete advisory.cve_id;
		const runner = new SourceRunner([json([item])]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].title).toBe("GHSA-4444-5555-6666: Prototype pollution in lodash");
	});

	test("the label falls back to the embedded security vulnerability severity", async () => {
		const item = dependabotAlert() as Record<string, unknown>;
		const advisory = item.security_advisory as Record<string, unknown>;
		delete advisory.severity;
		const runner = new SourceRunner([json([item])]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].labels).toEqual(["high"]);
	});

	test("an alert without severity facts carries no label", async () => {
		const item = dependabotAlert() as Record<string, unknown>;
		const advisory = item.security_advisory as Record<string, unknown>;
		const vulnerability = item.security_vulnerability as Record<string, unknown>;
		delete advisory.severity;
		delete vulnerability.severity;
		const runner = new SourceRunner([json([item])]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].labels).toEqual([]);
		expect(outcome.tickets[0].description).not.toContain("Severity:");
	});

	test("an alert without a patched version omits the line", async () => {
		const item = dependabotAlert() as Record<string, unknown>;
		const vulnerability = item.security_vulnerability as Record<string, unknown>;
		delete vulnerability.first_patched_version;
		const runner = new SourceRunner([json([item])]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].description).not.toContain("First patched version:");
	});

	test("an item outside the configured repositories fails the fetch", async () => {
		const item = dependabotAlert() as Record<string, unknown>;
		item.repository = {
			full_name: "acme/other",
			name: "other",
			html_url: "https://github.com/acme/other",
		};
		const runner = new SourceRunner([json([item])]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub returned a ticket outside configured repositories: acme/other",
			}),
		);
	});

	test("a failed request fails the whole fetch", async () => {
		const runner = new SourceRunner([{ code: 1, stdout: "", stderr: "rate limit exceeded\n" }]);
		const outcome = await createTicketSource(dependabotSource, runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub request failed: rate limit exceeded",
			}),
		);
	});
});

describe("the secret scanning alerts source", () => {
	test("reads one open-state request per repository and stops on a short page", async () => {
		const runner = new SourceRunner([json([secretAlert()])]);
		const outcome = await createTicketSource(secretSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0].args.join(" ")).toBe(
			"api repos/acme/factory/secret-scanning/alerts --hostname github.com -f state=open -f per_page=100 -f page=1",
		);
		if (outcome.status !== "success") return;
		expect(outcome.tickets).toHaveLength(1);
	});

	test("normalizes one alert into its ticket facts", async () => {
		const runner = new SourceRunner([
			json([
				secretAlert(),
				secretAlert({
					id: 901,
					number: 2,
					location: { file: "app.env", start_line: 1, end_line: 4 },
				}),
			]),
		]);
		const outcome = await createTicketSource(secretSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0]).toEqual({
			identity: "github:github.com:secret-scanning:900",
			sourceKind: "github-secret-scanning-alert",
			externalKey: "#1",
			sourceState: "open",
			url: "https://github.com/acme/factory/security/secret-scanning/1",
			title: "Exposed AWS Access Key",
			description: "Secret type: AWS Access Key\nFile: config.py\nLines: 3",
			labels: ["critical"],
			// The secret scanning object can carry a null updated-at; the
			// created-at is the fallback.
			externalUpdatedAt: "2026-08-05T00:00:00Z",
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: {},
		});
		expect(outcome.tickets[1].description).toBe(
			"Secret type: AWS Access Key\nFile: app.env\nLines: 1-4",
		);
	});

	test("an alert with a non-null updated-at keeps it", async () => {
		const runner = new SourceRunner([json([secretAlert({ updated_at: "2026-08-06T00:00:00Z" })])]);
		const outcome = await createTicketSource(secretSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
		if (outcome.status !== "success") return;
		expect(outcome.tickets[0].externalUpdatedAt).toBe("2026-08-06T00:00:00Z");
	});

	test("a failed request fails the whole fetch", async () => {
		const runner = new SourceRunner([{ code: 1, stdout: "", stderr: "HTTP 404: not found\n" }]);
		const outcome = await createTicketSource(secretSource, runner).fetch();
		expect(outcome).toEqual(
			expect.objectContaining({
				status: "failed",
				reason: "GitHub request failed: HTTP 404: not found",
			}),
		);
	});
});

describe("the security feed shared contract", () => {
	test("a literal token travels in the environment, never in argv", async () => {
		const runner = new SourceRunner([json([dependabotAlert()])]);
		const outcome = await createTicketSource(
			{ ...dependabotSource, auth: { token: "secret-token-value" } },
			runner,
		).fetch();
		expect(outcome.status).toBe("success");
		expect(runner.calls[0].args.join(" ")).not.toContain("secret-token-value");
		expect(runner.calls[0].secretEnvironmentNames).toEqual(["GH_TOKEN"]);
	});

	test("a missing token environment variable fails before any command runs", async () => {
		const runner = new SourceRunner([]);
		const outcome = await createTicketSource(
			{ ...secretSource, auth: { tokenEnv: "FACTORY_TOKEN" } },
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

	test("noise before the JSON body is tolerated", async () => {
		const runner = new SourceRunner([
			{
				code: 0,
				stdout: `shim activation notice\n${JSON.stringify([secretAlert()])}`,
				stderr: "",
			},
		]);
		const outcome = await createTicketSource(secretSource, runner).fetch();
		expect(outcome).toMatchObject({ status: "success" });
	});

	test("a closed or resolved state never lists, because the request asks open", async () => {
		// The state filter rides the request: a closed, fixed, dismissed, or
		// resolved item cannot come back through an open-state feed.
		for (const [source, endpoint] of [
			[dependabotSource, "repos/acme/factory/dependabot/alerts"],
			[secretSource, "repos/acme/factory/secret-scanning/alerts"],
		] as const) {
			const runner = new SourceRunner([json([])]);
			await createTicketSource(source, runner).fetch();
			expect(runner.calls[0].args.join(" ")).toContain(`-f state=open`);
			expect(runner.calls[0].args.join(" ")).toContain(endpoint);
		}
	});
});
