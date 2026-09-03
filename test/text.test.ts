/**
 * The cell-width text helpers, in cells rather than string length.
 *
 * Terminal layout is measured in cells: CJK and emoji take two, combining
 * marks take none. These tests pin the clips that keep a row to its column.
 */
import { describe, expect, test } from "vitest";

import {
	padToWidth,
	truncateTailToWidth,
	truncateToWidth,
	widthOf,
} from "../src/components/text.ts";

describe("widthOf", () => {
	test("counts cells, not code units", () => {
		expect(widthOf("abc")).toBe(3);
		expect(widthOf("é")).toBe(1);
		expect(widthOf("中")).toBe(2);
		expect(widthOf("🙂")).toBe(2);
	});
});

describe("truncateToWidth", () => {
	test("keeps the start and cuts on a grapheme boundary", () => {
		expect(truncateToWidth("abcdef", 3)).toBe("abc");
		// A two-cell cluster that no longer fits the budget is dropped whole.
		expect(truncateToWidth("a🙂b", 2)).toBe("a");
		// "a" plus a combining mark is one cluster of one cell, never a cut
		// between the two.
		expect(truncateToWidth("á\u0301b", 1)).toBe("á\u0301");
	});

	test("an empty width yields an empty string", () => {
		expect(truncateToWidth("abc", 0)).toBe("");
	});
});

describe("truncateTailToWidth", () => {
	test("a value that fits is returned whole, without a marker", () => {
		expect(truncateTailToWidth("anthropic/claude-sonnet", 30)).toBe("anthropic/claude-sonnet");
		expect(truncateTailToWidth("exactly-ten!", 12)).toBe("exactly-ten!");
	});

	test("keeps the end, where a long list tells its values apart", () => {
		expect(truncateTailToWidth("llama.cpp/deepseek-v4-flash-0731", 10)).toBe("…lash-0731");
		// The marker costs one cell, so the result holds exactly the column.
		expect(widthOf(truncateTailToWidth("llama.cpp/deepseek-v4-flash-0731", 10))).toBe(10);
	});

	test("cuts on a grapheme boundary, never mid-cluster", () => {
		// Walking back from the end: "h" fills the last cell, then the emoji no
		// longer fits the budget and drops whole.
		const cut = truncateTailToWidth("abcdefgh🙂", 4);
		expect(cut).toBe("…h🙂");
		expect(widthOf(cut)).toBe(4);
		expect(truncateTailToWidth("abcd🙂efgh", 4)).toBe("…fgh");
		// A wide cluster at the very end of a two-cell column cannot fit beside
		// the marker. The walk stops there, like the head clip: the marker
		// stands alone rather than the row overrun or skip inside the name.
		expect(truncateTailToWidth("abc🙂", 2)).toBe("…");
	});

	test("a one-cell column holds only the marker", () => {
		expect(truncateTailToWidth("abcdef", 1)).toBe("…");
		expect(truncateTailToWidth("abcdef", 0)).toBe("");
	});

	test("the whole value stays intact for the caller: the clip is display only", () => {
		const value = "openai/gpt-5.1-codex";
		expect(truncateTailToWidth(value, 8)).toBe("…1-codex");
		expect(value).toBe("openai/gpt-5.1-codex");
	});
});

describe("padToWidth", () => {
	test("pads to the column and leaves a wider string alone", () => {
		expect(padToWidth("ab", 5)).toBe("ab   ");
		expect(padToWidth("abcdef", 3)).toBe("abcdef");
	});
});
