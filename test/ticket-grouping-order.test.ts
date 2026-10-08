/**
 * The Group order rule (ADR 0071), unit-tested at the shared module: the full
 * order an axis keeps, the move that trades two visible Groups, and the
 * default order each axis names for its values.
 *
 * The frame tests cover the same rule through the real application flow.
 */

import { describe, expect, test } from "bun:test";

import {
	groupOrderOf,
	movedGroupOrder,
	ticketGroupCompare,
} from "../src/components/shared/grouping.ts";

const byName = (a: string, b: string): number => a.localeCompare(b);

describe("the Group order an axis keeps", () => {
	test("no stored order: the values stand in the axis' default order", () => {
		expect(groupOrderOf([], ["acme/zeta", "acme/factory"], byName)).toEqual([
			"acme/factory",
			"acme/zeta",
		]);
	});

	test("the stored order stands first, the never-ordered values after it in default order", () => {
		expect(groupOrderOf(["acme/zeta"], ["acme/factory", "acme/zeta", "acme/mid"], byName)).toEqual([
			"acme/zeta",
			"acme/factory",
			"acme/mid",
		]);
	});

	test("a stored value no row carries today keeps no row: the render drops it", () => {
		expect(groupOrderOf(["acme/ghost"], ["acme/b", "acme/a"], byName)).toEqual([
			"acme/a",
			"acme/b",
		]);
	});

	test("the stored values keep their stored places around a ghost", () => {
		expect(groupOrderOf(["acme/a", "acme/ghost", "acme/b"], ["acme/a", "acme/b"], byName)).toEqual([
			"acme/a",
			"acme/b",
		]);
	});
});

describe("the move that trades two visible Groups", () => {
	const present = ["acme/a", "acme/b", "acme/c"];

	test("the move trades the two values and answers the full order to store", () => {
		expect(movedGroupOrder([], present, byName, { value: "acme/a", neighbor: "acme/b" })).toEqual([
			"acme/b",
			"acme/a",
			"acme/c",
		]);
		expect(movedGroupOrder([], present, byName, { value: "acme/c", neighbor: "acme/b" })).toEqual([
			"acme/a",
			"acme/c",
			"acme/b",
		]);
	});

	test("a first move stores the whole list's order, not only the two moved values", () => {
		// The list holds a and c, b is hidden: the write carries c's slot.
		expect(
			movedGroupOrder([], ["acme/a", "acme/c"], byName, { value: "acme/a", neighbor: "acme/c" }),
		).toEqual(["acme/c", "acme/a"]);
	});

	test("a value no row carries answers no move", () => {
		expect(
			movedGroupOrder([], present, byName, { value: "acme/ghost", neighbor: "acme/b" }),
		).toBeNull();
		expect(
			movedGroupOrder([], present, byName, { value: "acme/a", neighbor: "acme/ghost" }),
		).toBeNull();
	});

	test("a value the filter hides keeps its slot in the stored order", () => {
		// The list holds a and c, and the operator ordered a above c while b
		// was hidden. b's slot stands where the order wrote it.
		const moved = movedGroupOrder(["acme/a", "acme/b", "acme/c"], ["acme/a", "acme/c"], byName, {
			value: "acme/c",
			neighbor: "acme/a",
		});
		expect(moved).toEqual(["acme/c", "acme/b", "acme/a"]);
	});
});

describe("the default order each axis names", () => {
	const positions = ["ready-for-agent", "awaiting-review", "done"];
	const position = ticketGroupCompare("position", positions);

	test("the position axis reads the Workflow's own order of its positions", () => {
		expect(position("ready-for-agent", "awaiting-review")).toBeLessThan(0);
		expect(position("awaiting-review", "done")).toBeLessThan(0);
	});

	test("unmatched stands last, and a position the config no longer names stands before it", () => {
		expect(position("unmatched", "done")).toBeGreaterThan(0);
		expect(position("retired-position", "done")).toBeGreaterThan(0);
		expect(position("retired-position", "unmatched")).toBeLessThan(0);
	});

	test("two positions the config does not name stand by their name", () => {
		expect(position("z-retired", "a-retired")).toBeGreaterThan(0);
	});

	const state = ticketGroupCompare("state", []);

	test("the state axis reads the Ticket states in their declared order", () => {
		expect(state("open", "running")).toBeLessThan(0);
		expect(state("running", "awaiting")).toBeLessThan(0);
		expect(state("awaiting", "queued")).toBeLessThan(0);
	});

	for (const axis of ["repository", "source", "task"] as const) {
		const compare = ticketGroupCompare(axis, []);

		test(`${axis} reads the names, and unknown stands last`, () => {
			expect(compare("acme/a", "acme/b")).toBeLessThan(0);
			expect(compare("unknown", "zzz")).toBeGreaterThan(0);
			expect(compare("a-value", "unknown")).toBeLessThan(0);
		});
	}
});
