/**
 * The naming tests: the slug, the branch name, and the agent name.
 */
import { describe, expect, test } from "vitest";

import type { Ticket } from "../src/domain/ticket.ts";
import {
	agentNameFor,
	branchNameFor,
	consultationAgentName,
	consultationBranchName,
	cycleAgentName,
	shortStableIdentity,
	ticketAgentNames,
	titleSlug,
} from "../src/naming.ts";

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
	workCycle: 1,
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
	leftover: null,
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

	test("removes every leading and trailing slug separator", () => {
		expect(titleSlug("---A title---")).toBe("a-title");
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

	test("an external key with no safe characters falls back to ticket", () => {
		expect(branchNameFor(ticket("Safe title", "///"))).toBe("factory/ticket-safe-title");
	});

	test("normalizes unsafe runs and outer separators in an external key", () => {
		expect(branchNameFor(ticket("Safe title", " /#77! "))).toBe("factory/77-safe-title");
	});

	test("keeps a safe separator inside an external key", () => {
		expect(branchNameFor(ticket("Safe title", "PR.42_x-7"))).toBe("factory/PR.42_x-7-safe-title");
	});

	test("collapses a run of unsafe characters inside an external key to one hyphen", () => {
		expect(branchNameFor(ticket("Safe title", "77!!##88"))).toBe("factory/77-88-safe-title");
	});

	test("collapses each run of a long external key separately", () => {
		expect(branchNameFor(ticket("Safe title", "77!!88##99"))).toBe("factory/77-88-99-safe-title");
	});

	test("removes every outer separator of an external key", () => {
		expect(branchNameFor(ticket("Safe title", "--77--"))).toBe("factory/77-safe-title");
	});
});

describe("agentNameFor", () => {
	test("is the title slug, which already fits herdr's name rule", () => {
		expect(agentNameFor("Retry policy for webhooks")).toBe("retry-policy-for-webhooks");
	});

	test("a slug that starts with a digit gets a t- prefix", () => {
		expect(agentNameFor("2fa rollout")).toBe("t-2fa-rollout");
	});

	test("keeps an agent name of exactly 32 characters", () => {
		const name = "a".repeat(32);
		expect(agentNameFor(name)).toBe(name);
	});

	test("a long slug cuts at 32 characters and drops a trailing hyphen", () => {
		const title = `a${"x".repeat(30)}-more`;
		const name = agentNameFor(title);
		expect(name).toBe(`a${"x".repeat(30)}`);
		expect(name.length).toBe(31);
		expect(name.endsWith("-")).toBe(false);
		expect(/^[a-z][a-z0-9_-]*$/.test(name)).toBe(true);
	});

	test("a cut that lands on a word keeps every inner hyphen", () => {
		expect(agentNameFor("Fix pan drift in split panes today")).toBe(
			"fix-pan-drift-in-split-panes-tod",
		);
	});
});

describe("Consultation naming", () => {
	test("uses unknown when a stable identity has no alphanumerics", () => {
		expect(shortStableIdentity("---")).toBe("unknown0");
	});

	test("pads a short stable identity to the full width", () => {
		expect(shortStableIdentity("a1")).toBe("a1000000");
		expect(shortStableIdentity("Ab-12")).toBe("ab120000");
	});

	test("cuts a long stable identity at the full width", () => {
		expect(shortStableIdentity("github:github.com:I_123456789")).toBe("githubgi");
	});

	test("drops every unsafe character of a stable identity before it pads", () => {
		expect(shortStableIdentity("ab!!cd##ef12")).toBe("abcdef12");
		expect(shortStableIdentity("a!!b")).toBe("ab000000");
	});

	test("the Agent name of a Consultation is its short stable identity", () => {
		expect(consultationAgentName("c-77")).toBe("consultation-c7700000");
	});

	test("uses consultation when a Consultation type has no safe characters", () => {
		expect(consultationBranchName("abc", "---")).toBe("factory/consultation-abc00000-consultation");
		expect(consultationBranchName("abc", "!Review__!")).toBe(
			"factory/consultation-abc00000-review__",
		);
	});

	test("collapses each run of unsafe characters in a Consultation type", () => {
		expect(consultationBranchName("abc", "re!!view!!x")).toBe(
			"factory/consultation-abc00000-re-view-x",
		);
	});

	test("removes every outer separator of a Consultation type", () => {
		expect(consultationBranchName("abc", "--review--")).toBe(
			"factory/consultation-abc00000-review",
		);
	});

	test("cuts an overlong Consultation branch at the width without a trailing hyphen", () => {
		const branch = consultationBranchName("abc", `${"x".repeat(68)}--tail`);
		expect(branch).toBe(`factory/consultation-abc00000-${"x".repeat(68)}`);
		expect(branch.endsWith("-")).toBe(false);
	});

	test("cuts an overlong Consultation branch without a trailing hyphen", () => {
		const branch = consultationBranchName("abc", `type-${"x".repeat(120)}`);
		expect(branch.length).toBe(100);
		expect(branch.endsWith("-")).toBe(false);
	});
});

describe("cycleAgentName", () => {
	test("keeps the ticket's own words and names the work cycle", () => {
		expect(cycleAgentName("Retry policy for webhooks", 2)).toBe("retry-policy-for-webhooks-c2");
	});

	test("the handoff's ordinal tells two handoffs of one cycle apart", () => {
		expect(cycleAgentName("Retry policy for webhooks", 2, 5)).toBe(
			"retry-policy-for-webhooks-c2-5",
		);
	});

	test("a digit slug keeps its prefix beside its cycle", () => {
		expect(cycleAgentName("2fa rollout", 1)).toBe("t-2fa-rollout-c1");
	});

	test("a cut cycle name still says which cycle it belongs to", () => {
		const title = "a-very-long-title-that-goes-on-and-on-past-thirty-two-characters";
		const stable = agentNameFor(title);
		const cycle = cycleAgentName(title, 3);
		expect(stable.length).toBe(32);
		expect(cycle.length).toBeLessThanOrEqual(32);
		expect(cycle.endsWith("-c3")).toBe(true);
		expect(cycle).not.toBe(stable);
		expect(/^[a-z][a-z0-9_-]{0,31}$/.test(cycle)).toBe(true);
	});

	test("a short title's cycle name differs from its stable name", () => {
		for (const title of ["Retry policy", "2fa rollout", "!!!", "Close the mutation testing gaps"]) {
			expect(cycleAgentName(title, 1)).not.toBe(agentNameFor(title));
			expect(cycleAgentName(title, 1).length).toBeLessThanOrEqual(32);
		}
	});
});

describe("ticketAgentNames", () => {
	/**
	 * A slug whose own tail spells the cycle suffix: the cut that keeps the
	 * suffix can rebuild the stable name out of it. `-c2` at the 32-character
	 * boundary is the shortest case where the two names meet.
	 */
	const rebuildsStable = `${"a".repeat(29)}-c2`;

	test("offers the stable name, then the cycle, then the handoff ordinal", () => {
		expect(ticketAgentNames("Retry policy", 2, 3)).toEqual([
			"retry-policy",
			"retry-policy-c2",
			"retry-policy-c2-3",
		]);
	});

	test("drops a cycle name that rebuilds the stable name", () => {
		expect(agentNameFor(rebuildsStable)).toBe(rebuildsStable);
		expect(cycleAgentName(rebuildsStable, 2)).toBe(rebuildsStable);
		// The repeat is gone rather than left for the caller to notice, and
		// the ordinal name is still there to start under.
		expect(ticketAgentNames(rebuildsStable, 2, 1)).toEqual([
			rebuildsStable,
			`${"a".repeat(27)}-c2-1`,
		]);
	});

	test("drops an ordinal name that rebuilds the stable name", () => {
		const title = `${"b".repeat(27)}-c2-3`;
		expect(agentNameFor(title)).toBe(title);
		// Here the cycle name is the usable one, and the ordinal name is the
		// repeat: both orders of the same rebuild.
		expect(ticketAgentNames(title, 2, 3)).toEqual([title, cycleAgentName(title, 2)]);
	});

	test("the t- prefix moves the same boundary", () => {
		const title = `2${"a".repeat(26)}-c2`;
		const stable = agentNameFor(title);
		expect(stable).toBe(`t-${title}`);
		expect(cycleAgentName(title, 2)).toBe(stable);
		expect(ticketAgentNames(title, 2, 1)).toEqual([stable, `t-2${"a".repeat(24)}-c2-1`]);
	});

	test("a handoff always keeps two names to ask for, and no name repeats", () => {
		const titles = [
			"Retry policy",
			"2fa rollout",
			"!!!",
			rebuildsStable,
			`${"b".repeat(27)}-c2-3`,
			`2${"a".repeat(26)}-c2`,
			"a-very-long-title-that-goes-on-and-on-past-thirty-two-characters",
		];
		for (const title of titles) {
			for (const cycle of [1, 2, 12]) {
				const candidates = ticketAgentNames(title, cycle, cycle + 1);
				expect(candidates.length).toBe(new Set(candidates).size);
				expect(candidates.length).toBeGreaterThanOrEqual(2);
				expect(candidates[0]).toBe(agentNameFor(title));
				for (const name of candidates) {
					expect(name.length).toBeLessThanOrEqual(32);
					expect(/^[a-z][a-z0-9_-]{0,31}$/.test(name)).toBe(true);
				}
			}
		}
	});
});
