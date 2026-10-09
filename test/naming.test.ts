/**
 * The naming tests: the slug, the branch name, and the agent name.
 */
import { describe, expect, test } from "bun:test";

import type { Ticket } from "../src/domain/ticket.ts";
import {
	agentNameFor,
	branchNameFor,
	consultationAgentName,
	consultationBranchName,
	cycleAgentName,
	identifyHandoffAgentName,
	pullRequestBranchFallbackLine,
	pullRequestBranchFor,
	shortStableIdentity,
	ticketAgentNames,
	ticketNameTag,
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
	matchedStateName: null,
	actionable: true,
	listActionable: true,
	handoffRecoveryRequired: false,
	ignored: false,
	ignoredAt: null,
	muted: false,
	mutedAt: null,
	handoffCount: 0,
	failedStartStreak: 0,
	lastCompletion: null,
	leftover: null,
	nameCollision: null,
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

describe("ticketNameTag", () => {
	test("is the same eight hex characters for the same identity, every run", () => {
		// FNV-1a 32-bit, the published vectors: "" is 811c9dc5, "a" is e40c292c,
		// "foobar" is bf9cf968. The tag is the whole digest, so every vector
		// stands in the tag unchanged.
		expect(ticketNameTag("")).toBe("811c9dc5");
		expect(ticketNameTag("a")).toBe("e40c292c");
		expect(ticketNameTag("foobar")).toBe("bf9cf968");
	});

	test("is eight characters of hex, so it always fits herdr's name rule", () => {
		for (const identity of [
			"",
			"a",
			"github:github.com:I_1",
			"github:github.com:seriousjul/seriousjul.github.io:dependabot:51",
		]) {
			expect(ticketNameTag(identity)).toMatch(/^[0-9a-f]{8}$/);
		}
	});

	test("separates two identities that share every leading word", () => {
		// A truncation of a Ticket identity is no help: every GitHub identity
		// starts with the same words, and `shortStableIdentity` proves it.
		expect(shortStableIdentity("github:github.com:I_123456789")).toBe("githubgi");
		expect(ticketNameTag("github:github.com:I_123456789")).not.toBe(
			ticketNameTag("github:github.com:I_987654321"),
		);
	});
});

describe("agentNameFor", () => {
	test("is the title slug with the ticket's own identity tag", () => {
		expect(agentNameFor(ticket("Retry policy for webhooks"))).toBe(
			"retry-policy-for-webhoo-444d8b55",
		);
	});

	test("a slug that starts with a digit gets a t- prefix", () => {
		expect(agentNameFor(ticket("2fa rollout"))).toBe("t-2fa-rollout-444d8b55");
	});

	test("keeps an agent name inside herdr's name rule", () => {
		const name = agentNameFor(ticket("a".repeat(32)));
		expect(name).toBe(`${"a".repeat(23)}-444d8b55`);
		expect(name.length).toBe(32);
		expect(/^[a-z][a-z0-9_-]{0,31}$/.test(name)).toBe(true);
	});

	test("a long slug cuts at 32 characters and drops a trailing hyphen", () => {
		const title = `a${"x".repeat(21)}-more`;
		const name = agentNameFor(ticket(title));
		expect(name).toBe(`${"a"}${"x".repeat(21)}-444d8b55`);
		expect(name.length).toBe(31);
		expect(name.endsWith("-")).toBe(false);
		expect(/^[a-z][a-z0-9_-]*$/.test(name)).toBe(true);
	});

	test("the identity tag survives the cut, whatever the title's length", () => {
		for (const title of [
			"Retry policy",
			"!!!",
			"Fix pan drift in split panes today",
			"a-very-long-title-that-goes-on-and-on-past-thirty-two-characters",
		]) {
			expect(agentNameFor(ticket(title)).endsWith("-444d8b55")).toBe(true);
		}
	});

	test("two Tickets that share a title get two stable names (issue #216)", () => {
		// The live case: a pull request and the Dependabot alert of the same
		// advisory, and an issue and the pull request opened for it.
		const title = "GHSA-6h2x-m376-mqjq: joi: Quadratic regular-expression backtracking";
		const names = new Set(
			["#45", "#51", "#209", "#215", "#6", "#7"].map((key) => agentNameFor(ticket(title, key))),
		);
		expect(names.size).toBe(6);
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
		expect(cycleAgentName(ticket("Retry policy for webhooks"), 2)).toBe(
			"retry-policy-for-web-444d8b55-c2",
		);
	});

	test("the handoff's ordinal tells two handoffs of one cycle apart", () => {
		expect(cycleAgentName(ticket("Retry policy for webhooks"), 2, 5)).toBe(
			"retry-policy-for-w-444d8b55-c2-5",
		);
	});

	test("a digit slug keeps its prefix beside its cycle", () => {
		expect(cycleAgentName(ticket("2fa rollout"), 1)).toBe("t-2fa-rollout-444d8b55-c1");
	});

	test("a cut cycle name still says which cycle it belongs to", () => {
		const one = ticket("a-very-long-title-that-goes-on-and-on-past-thirty-two-characters");
		const stable = agentNameFor(one);
		const cycle = cycleAgentName(one, 3);
		expect(stable.length).toBeLessThanOrEqual(32);
		expect(stable.endsWith("-444d8b55")).toBe(true);
		expect(cycle.length).toBeLessThanOrEqual(32);
		expect(cycle.endsWith("-c3")).toBe(true);
		expect(cycle).not.toBe(stable);
		expect(/^[a-z][a-z0-9_-]{0,31}$/.test(cycle)).toBe(true);
	});

	test("a short title's cycle name differs from its stable name", () => {
		for (const title of ["Retry policy", "2fa rollout", "!!!", "Close the mutation testing gaps"]) {
			expect(cycleAgentName(ticket(title), 1)).not.toBe(agentNameFor(ticket(title)));
			expect(cycleAgentName(ticket(title), 1).length).toBeLessThanOrEqual(32);
		}
	});
});

describe("ticketAgentNames", () => {
	/**
	 * A slug whose own tail spells the cycle suffix. Before the identity tag
	 * this was the shape where the cut rebuilt the stable name; the tag at a
	 * fixed width is what makes the three candidates meet nowhere.
	 */
	const rebuildsStable = `${"a".repeat(29)}-c2`;

	test("offers the stable name, then the cycle, then the handoff ordinal", () => {
		expect(ticketAgentNames(ticket("Retry policy"), 2, 3)).toEqual([
			"retry-policy-444d8b55",
			"retry-policy-444d8b55-c2",
			"retry-policy-444d8b55-c2-3",
		]);
	});

	test("the identity tag keeps the three candidates apart on a rebuilding slug", () => {
		const one = ticket(rebuildsStable);
		const candidates = ticketAgentNames(one, 2, 1);
		expect(candidates).toEqual([
			`${"a".repeat(23)}-444d8b55`,
			`${"a".repeat(20)}-444d8b55-c2`,
			`${"a".repeat(18)}-444d8b55-c2-1`,
		]);
		expect(new Set(candidates).size).toBe(3);
	});

	test("the t- prefix moves the same boundary", () => {
		const one = ticket(`2${"a".repeat(26)}-c2`);
		const stable = agentNameFor(one);
		expect(stable).toBe(`t-2${"a".repeat(20)}-444d8b55`);
		expect(cycleAgentName(one, 2)).toBe(`t-2${"a".repeat(17)}-444d8b55-c2`);
		expect(ticketAgentNames(one, 2, 1)).toEqual([
			stable,
			`t-2${"a".repeat(17)}-444d8b55-c2`,
			`t-2${"a".repeat(15)}-444d8b55-c2-1`,
		]);
	});

	test("a handoff always keeps three names to ask for, and no name repeats", () => {
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
				const candidates = ticketAgentNames(ticket(title), cycle, cycle + 1);
				expect(candidates.length).toBe(3);
				expect(candidates.length).toBe(new Set(candidates).size);
				expect(candidates[0]).toBe(agentNameFor(ticket(title)));
				for (const name of candidates) {
					expect(name.length).toBeLessThanOrEqual(32);
					expect(/^[a-z][a-z0-9_-]{0,31}$/.test(name)).toBe(true);
				}
			}
		}
	});

	test("two Tickets of one title ask for no name in common (issue #216)", () => {
		const title = "GHSA-6h2x-m376-mqjq: joi: Quadratic regular-expression backtracking";
		const asked = [
			...ticketAgentNames(ticket(title, "#45"), 1, 1),
			...ticketAgentNames(ticket(title, "#51"), 1, 1),
		];
		expect(new Set(asked).size).toBe(6);
	});
});

describe("identifyHandoffAgentName", () => {
	test("the same name is the ticket's own agent", () => {
		expect(identifyHandoffAgentName("persist-source-facts", "persist-source-facts")).toBe("own");
	});

	test("any other name is a foreign agent in a reused pane id", () => {
		expect(identifyHandoffAgentName("consultation-27e1542c", "persist-source-facts")).toBe(
			"foreign",
		);
		expect(
			identifyHandoffAgentName("add-sync-extension-cross-device", "persist-source-facts"),
		).toBe("foreign");
	});

	test("either name unknown to the reader is unverifiable", () => {
		expect(identifyHandoffAgentName(undefined, "persist-source-facts")).toBe("unverifiable");
		expect(identifyHandoffAgentName("", "persist-source-facts")).toBe("unverifiable");
		expect(identifyHandoffAgentName("persist-source-facts", "")).toBe("unverifiable");
	});
});

describe("pullRequestBranchFor (ADR 0112)", () => {
	const factoryBranch = "factory/12-persist-source-facts";
	const headBranch = "factory/5-persist-source-facts";

	test("works the head branch when it stands in the checkout", () => {
		expect(
			pullRequestBranchFor({
				factoryBranch,
				headBranch,
				headStandsInCheckout: true,
				headStandsOnOrigin: false,
			}),
		).toEqual({ branch: headBranch, fallback: null });
	});

	test("works the head branch when it stands only on origin", () => {
		expect(
			pullRequestBranchFor({
				factoryBranch,
				headBranch,
				headStandsInCheckout: false,
				headStandsOnOrigin: true,
			}),
		).toEqual({ branch: headBranch, fallback: null });
	});

	test("falls back to the ticket's own branch when the head stands in neither copy", () => {
		expect(
			pullRequestBranchFor({
				factoryBranch,
				headBranch,
				headStandsInCheckout: false,
				headStandsOnOrigin: false,
			}),
		).toEqual({ branch: factoryBranch, fallback: "unavailable" });
	});

	test("falls back to the ticket's own branch when the head fact is missing", () => {
		expect(
			pullRequestBranchFor({
				factoryBranch,
				headBranch: null,
				headStandsInCheckout: false,
				headStandsOnOrigin: false,
			}),
		).toEqual({ branch: factoryBranch, fallback: "missing-fact" });
	});

	test("a human-made pull request works whatever branch its pull request holds", () => {
		expect(
			pullRequestBranchFor({
				factoryBranch: "factory/44-add-cache",
				headBranch: "feature/add-cache",
				headStandsInCheckout: true,
				headStandsOnOrigin: true,
			}),
		).toEqual({ branch: "feature/add-cache", fallback: null });
	});

	test("every standing fact answers a branch, never a refusal", () => {
		for (const headBranch of [null, "fork:feature", "factory/5-persist-source-facts"]) {
			for (const standsInCheckout of [true, false]) {
				for (const standsOnOrigin of [true, false]) {
					branchAnswerFacts(headBranch, standsInCheckout, standsOnOrigin);
				}
			}
		}
	});

	/** The branch one head fact stands on, answered the way the rule answers it. */
	function branchAnswerFacts(
		headBranch: string | null,
		standsInCheckout: boolean,
		standsOnOrigin: boolean,
	): void {
		const answer = pullRequestBranchFor({
			factoryBranch,
			headBranch,
			headStandsInCheckout: standsInCheckout,
			headStandsOnOrigin: standsOnOrigin,
		});
		// The answer always names a branch, and never refuses.
		expect(answer.branch).not.toBe("");
		// The fallback stands only where the head branch cannot work.
		const headWorks = headBranch !== null && (standsInCheckout || standsOnOrigin);
		expect(answer.fallback === null).toBe(headWorks);
		expect(answer.branch).toBe(headWorks ? headBranch : factoryBranch);
	}

	describe("pullRequestBranchFallbackLine", () => {
		test("names the missing fact and the branch the start works", () => {
			expect(pullRequestBranchFallbackLine("missing-fact", null, factoryBranch)).toBe(
				`the pull request's head branch is not recorded, so the start works the ticket's own branch ${factoryBranch}`,
			);
		});

		test("names the head branch, both copies, and the branch the start works", () => {
			expect(pullRequestBranchFallbackLine("unavailable", headBranch, factoryBranch)).toBe(
				`the pull request's head branch ${headBranch} stands neither in the checkout nor on origin, so the start works the ticket's own branch ${factoryBranch}`,
			);
		});
	});
});
