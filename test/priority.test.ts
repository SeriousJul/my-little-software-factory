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
import {
	bumpPriority,
	compareTicketPriority,
	effectivePriority,
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
		});
	});

	test("an empty list ranks no ticket", () => {
		expect(effectivePriority([], null, ["critical"])).toEqual({
			rank: null,
			label: null,
			source: "none",
		});
	});

	test("an override that is no longer in the list names no rank", () => {
		expect(effectivePriority(["high"], "critical", [])).toEqual({
			rank: null,
			label: null,
			source: "none",
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
		priority: { rank, label: null, source: rank === null ? "none" : "label" },
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
			message: "no Priority labels are configured",
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
