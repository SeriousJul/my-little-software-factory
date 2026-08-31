/**
 * The naming tests: the slug, the branch name, and the agent name.
 */
import { describe, expect, test } from "vitest";

import type { Ticket } from "../src/domain/ticket.ts";
import { agentNameFor, branchNameFor, titleSlug } from "../src/naming.ts";

const ticket = (title: string, externalKey = "#1"): Ticket => ({
	identity: `github:github.com:I_${externalKey.slice(1)}`,
	title,
	repository: "acme/billing",
	repositoryRef: {
		identity: "github.com/acme/billing",
		displayName: "acme/billing",
		cloneUrl: "https://github.com/acme/billing.git",
	},
	state: "open",
	handoff: null,
	description: "A description.",
	sourceKind: "github-issue",
	externalKey,
	sourceState: "open",
	url: "https://github.com/acme/billing/issues/1",
	labels: [],
	externalUpdatedAt: "2026-01-01T00:00:00Z",
	memberships: [],
	suggestedTaskType: "implement",
	actionable: true,
	handoffRecoveryRequired: false,
	handoffCount: 0,
	lastCompletion: null,
});

describe("titleSlug", () => {
	test("lowercases and collapses runs of non-alphanumerics to one hyphen", () => {
		expect(titleSlug("Fix pan drift in split panes")).toBe("fix-pan-drift-in-split-panes");
		expect(titleSlug("Retry: policy (v2)!!")).toBe("retry-policy-v2");
		expect(titleSlug("  padded  ")).toBe("padded");
	});

	test("a title with no alphanumerics yields ticket, never empty", () => {
		expect(titleSlug("!!!")).toBe("ticket");
		expect(titleSlug("")).toBe("ticket");
	});
});

describe("branchNameFor", () => {
	test("is factory/<ticket id>-<title slug>", () => {
		expect(branchNameFor(ticket("Retry policy for webhooks"))).toBe(
			"factory/1-retry-policy-for-webhooks",
		);
	});

	test("one ticket owns one branch; the id keeps siblings distinct", () => {
		expect(branchNameFor(ticket("Same title", "2"))).toBe("factory/2-same-title");
		expect(branchNameFor(ticket("Same title", "3"))).toBe("factory/3-same-title");
	});
});

describe("agentNameFor", () => {
	test("is the title slug, which already fits herdr's name rule", () => {
		expect(agentNameFor(ticket("Retry policy for webhooks"))).toBe("retry-policy-for-webhooks");
	});

	test("a slug that starts with a digit gets a t- prefix", () => {
		expect(agentNameFor(ticket("2fa rollout"))).toBe("t-2fa-rollout");
	});

	test("a long slug is cut to 32 characters without a trailing hyphen", () => {
		const title = "a-very-long-title-that-goes-on-and-on-past-thirty-two-characters";
		const name = agentNameFor(ticket(title));
		expect(name.length).toBeLessThanOrEqual(32);
		expect(name.endsWith("-")).toBe(false);
		expect(/^[a-z][a-z0-9_-]*$/.test(name)).toBe(true);
	});
});
