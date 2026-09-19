/**
 * The shipped security task type templates (issue #73).
 *
 * Each template renders against one fixture ticket of its kind: the key lines
 * stand, and no placeholder stays literal in the prompt an agent receives.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import { validateConfig } from "../src/config.ts";
import { type Ticket, UNRANKED_PRIORITY } from "../src/domain/ticket.ts";
import { renderPrompt } from "../src/handoff.ts";

const SHIPPED_DEFAULT_CONFIG = fileURLToPath(new URL("../config/default.toml", import.meta.url));

const config = validateConfig(parseToml(readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8")));

/** The ticket facts of one ticket of each kind. */
const tickets: Record<"advisory" | "dependabot" | "secret", Partial<Ticket>> = {
	advisory: {
		title: "Improper input validation in left-pad",
		description: "left-pad allows remote attackers to trigger a denial of service.",
		repository: "acme/factory",
		sourceKind: "github-security-advisory",
		externalKey: "GHSA-1111-2222-3333",
		url: "https://github.com/github/advisories/GHSA-1111-2222-3333",
		labels: ["high"],
	},
	dependabot: {
		title: "CVE-2026-0002: Prototype pollution in lodash",
		description: "Package: lodash\nEcosystem: npm\nFirst patched version: 4.17.19",
		repository: "acme/factory",
		sourceKind: "github-dependabot-alert",
		externalKey: "#7",
		url: "https://github.com/acme/factory/security/dependabot/7",
		labels: ["high"],
	},
	secret: {
		title: "Exposed AWS Access Key",
		description: "Secret type: AWS Access Key\nFile: config.py\nLines: 3",
		repository: "acme/factory",
		sourceKind: "github-secret-scanning-alert",
		externalKey: "#1",
		url: "https://github.com/acme/factory/security/secret-scanning/1",
		labels: ["critical"],
	},
};

/** Fill the fixture facts into one complete ticket for the renderer. */
function ticketOf(kind: keyof typeof tickets): Ticket {
	return {
		identity: `github:github.com:fixture-${kind}`,
		title: "fixture",
		repository: "acme/factory",
		repositoryRef: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		state: "open",
		handoff: null,
		workCycle: 1,
		handoffCount: 0,
		lastCompletion: null,
		description: "fixture",
		sourceKind: kind,
		externalKey: "fixture",
		sourceState: "open",
		url: "https://github.com/fixture",
		labels: [],
		externalUpdatedAt: "2026-01-01T00:00:00Z",
		memberships: [],
		suggestedTaskType: "implement",
		actionable: true,
		handoffRecoveryRequired: false,
		leftover: null,
		priority: UNRANKED_PRIORITY,
		...tickets[kind],
	} as Ticket;
}

/** Every security prompt carries the common tail: no placeholder stays literal. */
function noLiteralPlaceholders(prompt: string): void {
	expect(prompt).not.toMatch(
		/\{repository\}|\{title\}|\{description\}|\{source-kind\}|\{external-key\}|\{source-url\}|\{labels\}|\{previous-message\}/,
	);
}

describe("the resolve-security-advisory template", () => {
	const prompt = renderPrompt(
		config.taskTypes["resolve-security-advisory"].template,
		ticketOf("advisory"),
	);

	test("it names the advisory and carries the ticket facts", () => {
		expect(prompt).toContain("Resolve the following security advisory GHSA-1111-2222-3333:");
		expect(prompt).toContain("URL: https://github.com/github/advisories/GHSA-1111-2222-3333");
		expect(prompt).toContain("Labels: high");
		noLiteralPlaceholders(prompt);
	});

	test("it verifies the report before fixing, and a bad report opens no pull request", () => {
		expect(prompt).toContain("Verify the Report");
		expect(prompt).toContain("Confirm the vulnerable code exists");
		expect(prompt).toContain("open no pull request");
		expect(prompt).toContain("explain in your final message exactly why");
	});

	test("it designs the smallest root-cause fix with sibling call sites", () => {
		expect(prompt).toContain("smallest change that removes the root cause");
		expect(prompt).toContain("Follow the upstream fix");
		expect(prompt).toContain("sibling call sites");
	});

	test("it requires a failing regression test", () => {
		expect(prompt).toContain(
			"regression test that fails on the vulnerable behavior and passes on the fix",
		);
	});

	test("it ends with the common steps", () => {
		expect(prompt).toContain("Add the **`ready-for-review`** label to the pull request");
		expect(prompt).toContain(
			"Never add the **`ready-to-ship`** or **`needs-work`** labels to the pull request",
		);
		expect(prompt).toContain("Never close, resolve, or withdraw the source item");
	});
});

describe("the resolve-dependabot-alert template", () => {
	const prompt = renderPrompt(
		config.taskTypes["resolve-dependabot-alert"].template,
		ticketOf("dependabot"),
	);

	test("it names the alert and carries the ticket facts", () => {
		expect(prompt).toContain(
			"Resolve the following Dependabot alert #7: CVE-2026-0002: Prototype pollution in lodash",
		);
		expect(prompt).toContain("URL: https://github.com/acme/factory/security/dependabot/7");
		noLiteralPlaceholders(prompt);
	});

	test("it reads and verifies the alert, transitive included", () => {
		expect(prompt).toContain("first patched version");
		expect(prompt).toContain("Find the package at a vulnerable version");
		expect(prompt).toContain(
			"transitive dependency lands on the direct dependency or the lockfile",
		);
	});

	test("it refuses a competing pull request", () => {
		expect(prompt).toContain("do not open a competing one");
	});

	test("it upgrades to the first patched version with a lockfile and tests", () => {
		expect(prompt).toContain("smallest change that leaves the vulnerable range");
		expect(prompt).toContain("Update the lockfile with the project's package manager");
		expect(prompt).toContain("Run the test suite");
	});

	test("an unpatched dependency is removed or replaced and recorded", () => {
		expect(prompt).toContain("remove or replace the dependency and record the choice");
	});

	test("it ends with the common steps", () => {
		expect(prompt).toContain("Add the **`ready-for-review`** label to the pull request");
		expect(prompt).toContain("Never close, resolve, or withdraw the source item");
	});
});

describe("the resolve-secret-scanning-alert template", () => {
	const prompt = renderPrompt(
		config.taskTypes["resolve-secret-scanning-alert"].template,
		ticketOf("secret"),
	);

	test("it names the alert and carries the ticket facts", () => {
		expect(prompt).toContain(
			"Resolve the following secret scanning alert #1: Exposed AWS Access Key",
		);
		expect(prompt).toContain("URL: https://github.com/acme/factory/security/secret-scanning/1");
		expect(prompt).toContain("Labels: critical");
		noLiteralPlaceholders(prompt);
	});

	test("rotation comes before the code cleanup", () => {
		const rotate = prompt.indexOf("Rotate First");
		const remove = prompt.indexOf("Remove the Secret");
		expect(rotate).toBeGreaterThan(-1);
		expect(remove).toBeGreaterThan(rotate);
		expect(prompt).toContain("Rotate the exposed credential from your environment");
		expect(prompt).toContain(
			"state in the pull request description exactly which credential to rotate",
		);
	});

	test("it replaces the secret with the project convention", () => {
		expect(prompt).toContain("environment variable or secret store reference");
		expect(prompt).toContain("smallest convention that fits");
	});

	test("it finds every other copy", () => {
		expect(prompt).toContain("every other copy of the secret");
	});

	test("history is never rewritten in the pull request and the purge is noted", () => {
		expect(prompt).toContain("Do not rewrite git history in the pull request");
		expect(prompt).toContain("history must be purged after rotation");
		expect(prompt).toContain("git filter-repo");
	});

	test("the secret value is never printed", () => {
		expect(prompt).toContain(
			"Never print the secret value in the pull request, in a comment, or in a test",
		);
	});

	test("it ends with the common steps", () => {
		expect(prompt).toContain("Add the **`ready-for-review`** label to the pull request");
		expect(prompt).toContain("Never close, resolve, or withdraw the source item");
	});
});
