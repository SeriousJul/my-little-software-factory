/**
 * The ticket priority tests (ADR 0022): the rank function, the one
 * comparator, the bump rules, the config section, and the operator's
 * override.
 *
 * The rank is asserted as the order a projection returns and the value the
 * state stores, not as an internal shape. The rank function and the bump
 * rules are the domain's own words, so those are pinned directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, test } from "vitest";

import { validateConfigWithWarnings } from "../src/config.ts";
import type { FetchedTicket, IssueReference } from "../src/domain/ticket.ts";
import { withIssueReferences } from "../src/domain/ticket.ts";
import {
	bumpPriority,
	compareTicketPriority,
	effectivePriority,
	effectivePullRequestPriority,
	inheritedPriority,
	PRIORITY_OFF,
	type TicketPriority,
} from "../src/priority.ts";
import { openFactoryState } from "../src/state.ts";
import { issueTicket, success } from "./state-fixture.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function statePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-priority-"));
	paths.push(dir);
	return join(dir, "state.sqlite");
}

const RANKS = ["critical", "high", "low"];

describe("the rank function", () => {
	test("an override wins over the ticket's own labels", () => {
		expect(effectivePriority(RANKS, "high", ["critical"])).toEqual({
			rank: 1,
			label: "high",
			source: "override",
			inheritedFrom: null,
		});
	});

	test("off forces the ticket unranked, over a ranked label", () => {
		const p = effectivePriority(RANKS, PRIORITY_OFF, ["critical"]);
		expect(p.rank).toBeNull();
		expect(p.source).toBe("override");
	});

	test("the best rank among a ticket's own labels wins", () => {
		expect(effectivePriority(RANKS, null, ["low", "critical", "high"])).toEqual({
			rank: 0,
			label: "critical",
			source: "label",
			inheritedFrom: null,
		});
	});

	test("a duplicate label takes the rank of its first occurrence", () => {
		expect(effectivePriority(["a", "b", "a"], null, ["a"]).rank).toBe(0);
	});

	test("a ticket whose labels are not in the list is unranked", () => {
		expect(effectivePriority(RANKS, null, ["urgent"])).toEqual({
			rank: null,
			label: null,
			source: "none",
			inheritedFrom: null,
		});
	});

	test("an empty list ranks no ticket", () => {
		expect(effectivePriority([], null, ["critical"])).toEqual({
			rank: null,
			label: null,
			source: "none",
			inheritedFrom: null,
		});
	});

	test("an override that is no longer in the list names no rank, but states its label", () => {
		expect(effectivePriority(["high"], "critical", [])).toEqual({
			rank: null,
			label: "critical",
			source: "override",
			inheritedFrom: null,
		});
	});

	test("a stale override outranks nothing in the comparator", () => {
		const stale = {
			priority: effectivePriority(["high"], "critical", []),
			externalUpdatedAt: "2026-08-31T10:00:00Z",
			identity: "a",
		};
		const ranked = entry("b", 0);
		expect(compareTicketPriority(stale, ranked)).toBeGreaterThan(0);
	});
});

describe("the inherited rank (ADR 0023)", () => {
	const refs = {
		low: { number: 3, labels: ["low"], override: null },
		critical: { number: 1, labels: ["critical"], override: null },
		high: { number: 2, labels: ["high"], override: null },
		urgent: { number: 4, labels: ["urgent"], override: null },
	};

	test("the highest ranked reference wins, named by its number", () => {
		expect(inheritedPriority(RANKS, [refs.low, refs.critical])).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 1,
		});
	});

	test("a reference's own override beats its labels", () => {
		expect(inheritedPriority(RANKS, [{ number: 2, labels: ["low"], override: "high" }])).toEqual({
			rank: 1,
			label: "high",
			source: "inherited",
			inheritedFrom: 2,
		});
	});

	test("an override set on the referenced ticket travels through inheritance", () => {
		expect(
			inheritedPriority(RANKS, [{ number: 7, labels: ["low"], override: "critical" }]),
		).toEqual({ rank: 0, label: "critical", source: "inherited", inheritedFrom: 7 });
	});

	test("a reference whose override is off is unranked, and the next wins", () => {
		expect(
			inheritedPriority(RANKS, [
				{ number: 1, labels: ["critical"], override: PRIORITY_OFF },
				refs.high,
			]),
		).toEqual({ rank: 1, label: "high", source: "inherited", inheritedFrom: 2 });
	});

	test("a reference with no ranked label and no override carries no rank", () => {
		expect(inheritedPriority(RANKS, [refs.urgent])).toEqual({
			rank: null,
			label: null,
			source: "none",
			inheritedFrom: null,
		});
	});

	test("no references inherit nothing", () => {
		expect(inheritedPriority(RANKS, [])).toEqual({
			rank: null,
			label: null,
			source: "none",
			inheritedFrom: null,
		});
	});

	test("a tie at the best rank names the lowest issue number", () => {
		expect(
			inheritedPriority(RANKS, [
				{ number: 9, labels: ["critical"], override: null },
				{ number: 5, labels: ["critical"], override: null },
			]),
		).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 5,
		});
	});

	test("the pull request's own override beats the inherited rank", () => {
		expect(effectivePullRequestPriority(RANKS, "high", ["low"], [refs.critical])).toEqual({
			rank: 1,
			label: "high",
			source: "override",
			inheritedFrom: null,
		});
	});

	test("the pull request's own label beats the inherited rank", () => {
		expect(effectivePullRequestPriority(RANKS, null, ["high"], [refs.critical])).toEqual({
			rank: 1,
			label: "high",
			source: "label",
			inheritedFrom: null,
		});
	});

	test("the pull request's own off keeps it unranked, not inherited", () => {
		expect(effectivePullRequestPriority(RANKS, PRIORITY_OFF, [], [refs.critical])).toEqual({
			rank: null,
			label: "off",
			source: "override",
			inheritedFrom: null,
		});
	});

	test("an override the list dropped stays stated when no reference ranks", () => {
		expect(effectivePullRequestPriority(RANKS, "urgent", [], [refs.urgent])).toEqual({
			rank: null,
			label: "urgent",
			source: "override",
			inheritedFrom: null,
		});
	});

	test("an override the list dropped still lets a ranked reference inherit", () => {
		expect(effectivePullRequestPriority(RANKS, "urgent", [], [refs.critical])).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 1,
		});
	});

	test("an unranked pull request inherits its reference's rank", () => {
		expect(effectivePullRequestPriority(RANKS, null, [], [refs.critical])).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 1,
		});
	});

	test("closing only unranked issues stays unranked", () => {
		expect(effectivePullRequestPriority(RANKS, null, [], [refs.urgent])).toEqual({
			rank: null,
			label: null,
			source: "none",
			inheritedFrom: null,
		});
	});
});

/** One comparator input, built from the facts the projections carry. */
function entry(
	identity: string,
	rank: number | null,
	updated = "2026-08-31T10:00:00Z",
): { priority: TicketPriority; externalUpdatedAt: string; identity: string } {
	return {
		priority: { rank, label: null, source: rank === null ? "none" : "label", inheritedFrom: null },
		externalUpdatedAt: updated,
		identity,
	};
}

describe("the one comparator", () => {
	test("a ranked ticket comes before an unranked one", () => {
		expect(compareTicketPriority(entry("a", 1), entry("b", null))).toBeLessThan(0);
		expect(compareTicketPriority(entry("a", null), entry("b", 0))).toBeGreaterThan(0);
	});

	test("the better rank comes first", () => {
		expect(compareTicketPriority(entry("a", 0), entry("b", 1))).toBeLessThan(0);
		expect(compareTicketPriority(entry("a", 2), entry("b", 0))).toBeGreaterThan(0);
	});

	test("one shared rank falls back to the newest update, then the identity", () => {
		// b updates later, so b comes first.
		expect(
			compareTicketPriority(
				entry("a", 0, "2026-08-31T09:00:00Z"),
				entry("b", 0, "2026-08-31T10:00:00Z"),
			),
		).toBeGreaterThan(0);
		// The same update: the identity breaks the tie.
		expect(compareTicketPriority(entry("a", 0), entry("b", 0))).toBeLessThan(0);
	});

	test("the unranked share the same tie-break", () => {
		expect(compareTicketPriority(entry("a", null), entry("b", null))).toBeLessThan(0);
	});
});

describe("the bump rules", () => {
	test("up from unranked takes the lowest rank", () => {
		expect(bumpPriority("up", RANKS, null)).toEqual({
			kind: "moved",
			value: "low",
			message: "priority set to low",
		});
	});

	test("up from a rank takes the next better rank", () => {
		expect(bumpPriority("up", RANKS, 2)).toEqual({
			kind: "moved",
			value: "high",
			message: "priority raised to high",
		});
	});

	test("up at the highest rank is a no-op", () => {
		expect(bumpPriority("up", RANKS, 0)).toEqual({
			kind: "noop",
			message: "already at the highest priority",
		});
	});

	test("down from a rank takes the next worse rank", () => {
		expect(bumpPriority("down", RANKS, 0)).toEqual({
			kind: "moved",
			value: "high",
			message: "priority lowered to high",
		});
	});

	test("down from the lowest rank takes off", () => {
		expect(bumpPriority("down", RANKS, 2)).toEqual({
			kind: "moved",
			value: PRIORITY_OFF,
			message: "priority set to off",
		});
	});

	test("down from unranked is a no-op", () => {
		expect(bumpPriority("down", RANKS, null)).toEqual({
			kind: "noop",
			message: "already unranked",
		});
	});

	test("no labels is a no-op", () => {
		expect(bumpPriority("up", [], null)).toEqual({
			kind: "noop",
			message:
				"no Priority labels are configured - add a [priority] labels list to the config file",
		});
	});
});

describe("the config section", () => {
	const body = `
default-agent = "pi"
default-environment = "live-worktree"
default-task-type = "implement"

[agents.pi]
kind = "pi"
model = "--model {value}"
thinking = "--thinking {value}"
thinking-values = ["low", "high"]

[task-types.implement]
template = "Implement it: {repository} {title} {description}"
`;

	function withSection(section: string) {
		return validateConfigWithWarnings(parseToml(body + section));
	}

	test("a labels list is read as the priority section", () => {
		const { config, warnings } = withSection('\n[priority]\nlabels = ["critical", "high"]\n');
		expect(warnings).toEqual([]);
		expect(config.priority).toEqual({ labels: ["critical", "high"] });
	});

	test("a missing section starts with no ranking", () => {
		const { config, warnings } = withSection("");
		expect(warnings).toEqual([]);
		expect(config.priority).toBeUndefined();
	});

	test("an empty labels list reads as no ranking", () => {
		const { config, warnings } = withSection("\n[priority]\nlabels = []\n");
		expect(warnings).toEqual([]);
		expect(config.priority).toEqual({ labels: [] });
		expect(effectivePriority(config.priority?.labels ?? [], null, ["critical"]).rank).toBeNull();
	});

	test("a section that is not a table warns and starts with no ranking", () => {
		// A top-level scalar must sit in the top block, before any table.
		const data = {
			...(parseToml(body) as object),
			priority: "critical",
		};
		const { config, warnings } = validateConfigWithWarnings(data);
		expect(config.priority).toBeUndefined();
		expect(warnings).toEqual([expect.stringContaining("[priority] must be a table")]);
	});

	test("an unknown key in the section warns and drops the section", () => {
		const { config, warnings } = withSection('\n[priority]\nlabels = ["a"]\norder = "desc"\n');
		expect(config.priority).toBeUndefined();
		expect(warnings).toEqual([expect.stringContaining("unknown key")]);
	});

	test("a labels value that is not a list warns", () => {
		const { config, warnings } = withSection('\n[priority]\nlabels = "critical"\n');
		expect(config.priority).toBeUndefined();
		expect(warnings).toEqual([expect.stringContaining("labels must be a list")]);
	});

	test("an empty-string label warns", () => {
		const { config, warnings } = withSection('\n[priority]\nlabels = ["critical", ""]\n');
		expect(config.priority).toBeUndefined();
		expect(warnings).toEqual([expect.stringContaining("non-empty strings")]);
	});
});

describe("the operator's override", () => {
	const source = { name: "issues", kind: "github-issues" } as const;

	function seed(path: string) {
		const state = openFactoryState(path);
		state.initializeSources([source]);
		state.applyFetch(
			source,
			success([
				issueTicket("github:github.com:I_5", { labels: ["high"] }),
				issueTicket("github:github.com:I_6", { labels: ["critical"] }),
			]),
		);
		return state;
	}

	test("it stores the override and reads it back", () => {
		const state = seed(statePath());
		expect(state.priorityOverride("github:github.com:I_5")).toBeNull();
		expect(state.setPriorityOverride("github:github.com:I_5", "critical")).toBe(true);
		expect(state.priorityOverride("github:github.com:I_5")).toBe("critical");
		state.close();
	});

	test("it clears to the default", () => {
		const state = seed(statePath());
		state.setPriorityOverride("github:github.com:I_5", "critical");
		expect(state.setPriorityOverride("github:github.com:I_5", null)).toBe(true);
		expect(state.priorityOverride("github:github.com:I_5")).toBeNull();
		state.close();
	});

	test("it persists across a close and a reopen", () => {
		const path = statePath();
		const state = seed(path);
		state.setPriorityOverride("github:github.com:I_5", "critical");
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.priorityOverride("github:github.com:I_5")).toBe("critical");
		reopened.close();
	});

	test("an override outranks the ticket's own label in the projection", () => {
		const state = seed(statePath());
		// I_6 carries critical (rank 0), I_5 carries high (rank 1): I_6 leads.
		expect(state.visibleTickets([], "implement", RANKS).map((t) => t.identity)).toEqual([
			"github:github.com:I_6",
			"github:github.com:I_5",
		]);

		// Raising I_5 to critical lifts it to the same rank as I_6. The shared
		// rank falls back to the identity, so I_5 now leads.
		state.setPriorityOverride("github:github.com:I_5", "critical");
		expect(state.visibleTickets([], "implement", RANKS).map((t) => t.identity)).toEqual([
			"github:github.com:I_5",
			"github:github.com:I_6",
		]);
		state.close();
	});

	test("off pushes a ranked ticket below the ranked work", () => {
		const state = seed(statePath());
		// I_5's own label is high (rank 1); I_6 is critical (rank 0).
		state.setPriorityOverride("github:github.com:I_5", PRIORITY_OFF);
		// I_5 is now unranked and rests below I_6, and below any ranked work.
		expect(state.visibleTickets([], "implement", RANKS).map((t) => t.identity)).toEqual([
			"github:github.com:I_6",
			"github:github.com:I_5",
		]);
		state.close();
	});
});

describe("inherited priority through closed issues (ADR 0023)", () => {
	const issues = { name: "issues", kind: "github-issues" } as const;
	const pulls = { name: "pulls", kind: "github-pull-request" } as const;

	const ref = (identity: string, number: number): IssueReference => ({
		identity,
		number,
		repository: "acme/factory",
	});

	/** One pull request ticket on the shared sample repository. */
	function pullTicket(
		identity: string,
		number: number,
		references: readonly IssueReference[],
		over: Partial<FetchedTicket> = {},
	): FetchedTicket {
		return {
			identity,
			sourceKind: "github-pull-request",
			externalKey: `#${number}`,
			sourceState: "open",
			url: `https://github.com/acme/factory/pulls/${number}`,
			title: `Pull ${number}`,
			description: "",
			labels: [],
			externalUpdatedAt: "2026-08-31T10:00:00Z",
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: withIssueReferences({ draft: "false" }, [...references]),
			...over,
		};
	}

	function openPullState(path: string): import("../src/state.ts").FactoryState {
		const state = openFactoryState(path);
		state.initializeSources([issues, pulls]);
		return state;
	}

	test("a pull request takes the highest rank of the issues it closes, live, last known, and fact", () => {
		const state = openPullState(statePath());
		state.applyFetch(
			issues,
			success([
				issueTicket("github:github.com:I_5", { labels: ["high"] }),
				issueTicket("github:github.com:I_6", { labels: ["low"] }),
			]),
		);
		// The PR closes I_5 (live), I_6 (about to leave the source), and I_7,
		// which no source lists: the read stored its fact.
		state.applyFetch(pulls, {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [
				pullTicket("github:github.com:P_7", 7, [
					ref("github:github.com:I_5", 5),
					ref("github:github.com:I_6", 6),
					ref("github:github.com:I_7", 7),
				]),
			],
			referencedIssueFacts: [
				{
					identity: "github:github.com:I_7",
					labels: ["critical"],
					fetchedAt: "2026-08-31T10:01:00Z",
				},
			],
		});
		// I_6 leaves the issue source: it stays a last known ticket, ranked by
		// its stored labels. I_7 keeps its fact.
		state.applyFetch(issues, success([issueTicket("github:github.com:I_5", { labels: ["high"] })]));
		const [pr] = state
			.visibleTickets([], "implement", RANKS)
			.filter((t) => t.identity === "github:github.com:P_7");
		if (pr === undefined) throw new Error("missing pull request ticket");
		expect(pr.priority).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 7,
		});
		state.close();
	});

	test("a snapshot beats a fact for the same issue", () => {
		const state = openPullState(statePath());
		state.applyFetch(
			issues,
			success([issueTicket("github:github.com:I_5", { labels: ["critical"] })]),
		);
		state.applyFetch(pulls, {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_5", 5)])],
			// The direct read saw a stale label set: the snapshot wins.
			referencedIssueFacts: [
				{ identity: "github:github.com:I_5", labels: ["low"], fetchedAt: "2026-08-31T10:01:00Z" },
			],
		});
		const [pr] = state
			.visibleTickets([], "implement", RANKS)
			.filter((t) => t.identity === "github:github.com:P_7");
		if (pr === undefined) throw new Error("missing pull request ticket");
		expect(pr.priority).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 5,
		});
		state.close();
	});

	test("a Priority override set on the referenced ticket travels through inheritance", () => {
		const state = openPullState(statePath());
		state.applyFetch(issues, success([issueTicket("github:github.com:I_5", { labels: ["low"] })]));
		state.applyFetch(
			pulls,
			success([pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_5", 5)])]),
		);
		state.setPriorityOverride("github:github.com:I_5", "critical");
		const [pr] = state
			.visibleTickets([], "implement", RANKS)
			.filter((t) => t.identity === "github:github.com:P_7");
		if (pr === undefined) throw new Error("missing pull request ticket");
		expect(pr.priority).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 5,
		});
		state.close();
	});

	test("a refresh that changes the pull request's references changes its rank", () => {
		const state = openPullState(statePath());
		state.applyFetch(
			issues,
			success([
				issueTicket("github:github.com:I_5", { labels: ["critical"] }),
				issueTicket("github:github.com:I_6", { labels: ["low"] }),
			]),
		);
		state.applyFetch(
			pulls,
			success([pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_5", 5)])]),
		);
		const before = state
			.visibleTickets([], "implement", RANKS)
			.find((t) => t.identity === "github:github.com:P_7");
		if (before === undefined) throw new Error("missing pull request ticket");
		expect(before.priority.rank).toBe(0);
		// The PR now closes only I_6.
		state.applyFetch(
			pulls,
			success([pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_6", 6)])]),
		);
		const after = state
			.visibleTickets([], "implement", RANKS)
			.find((t) => t.identity === "github:github.com:P_7");
		if (after === undefined) throw new Error("missing pull request ticket");
		expect(after.priority).toEqual({
			rank: 2,
			label: "low",
			source: "inherited",
			inheritedFrom: 6,
		});
		state.close();
	});

	test("an orphaned fact persists harmlessly", () => {
		const state = openPullState(statePath());
		state.applyFetch(issues, success([issueTicket("github:github.com:I_5", { labels: ["low"] })]));
		state.applyFetch(pulls, {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [
				pullTicket("github:github.com:P_7", 7, [
					ref("github:github.com:I_5", 5),
					ref("github:github.com:I_7", 7),
				]),
			],
			referencedIssueFacts: [
				{
					identity: "github:github.com:I_7",
					labels: ["critical"],
					fetchedAt: "2026-08-31T10:01:00Z",
				},
			],
		});
		// The refresh drops I_7 from the references: the fact is orphaned.
		state.applyFetch(
			pulls,
			success([pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_5", 5)])]),
		);
		// A later refresh re-references I_7: the kept fact still carries its
		// rank, no direct read is needed by the state.
		state.applyFetch(
			pulls,
			success([pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_7", 7)])]),
		);
		const [pr] = state
			.visibleTickets([], "implement", RANKS)
			.filter((t) => t.identity === "github:github.com:P_7");
		if (pr === undefined) throw new Error("missing pull request ticket");
		expect(pr.priority).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 7,
		});
		state.close();
	});

	test("a draft pull request inherits exactly like a ready one", () => {
		const state = openPullState(statePath());
		state.applyFetch(
			issues,
			success([issueTicket("github:github.com:I_5", { labels: ["critical"] })]),
		);
		state.applyFetch(
			pulls,
			success([
				pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_5", 5)], {
					attributes: withIssueReferences({ draft: "true" }, [ref("github:github.com:I_5", 5)]),
				}),
			]),
		);
		const [pr] = state
			.visibleTickets([], "implement", RANKS)
			.filter((t) => t.identity === "github:github.com:P_7");
		if (pr === undefined) throw new Error("missing pull request ticket");
		expect(pr.priority).toEqual({
			rank: 0,
			label: "critical",
			source: "inherited",
			inheritedFrom: 5,
		});
		state.close();
	});

	test("the pull request's own override beats the inherited rank", () => {
		const state = openPullState(statePath());
		state.applyFetch(
			issues,
			success([issueTicket("github:github.com:I_5", { labels: ["critical"] })]),
		);
		state.applyFetch(
			pulls,
			success([pullTicket("github:github.com:P_7", 7, [ref("github:github.com:I_5", 5)])]),
		);
		state.setPriorityOverride("github:github.com:P_7", "low");
		const [pr] = state
			.visibleTickets([], "implement", RANKS)
			.filter((t) => t.identity === "github:github.com:P_7");
		if (pr === undefined) throw new Error("missing pull request ticket");
		expect(pr.priority).toEqual({
			rank: 2,
			label: "low",
			source: "override",
			inheritedFrom: null,
		});
		state.close();
	});
});
