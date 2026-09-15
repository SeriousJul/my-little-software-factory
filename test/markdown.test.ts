/**
 * The light markdown dressing: the deterministic rules the decision modal
 * renders the turn log with.
 */
import { describe, expect, test } from "vitest";

import { type MdLine, renderMarkdown } from "../src/components/markdown.ts";
import { widthOf } from "../src/components/text.ts";

/** A palette with placeholder voices, so a span's voice is readable. */
const C = { text: "T", dim: "D" };

/** The line's text, across its spans. */
function plain(line: MdLine): string {
	return line.map((span) => span.text).join("");
}

/** The line's spans as (text, voice) pairs. */
function spans(line: MdLine): Array<[string, string]> {
	return line.map((span) => [span.text, span.fg] as [string, string]);
}

/** All the lines of the render. */
function one(source: string, width = 80): MdLine[] {
	return renderMarkdown(source, width, C);
}

/** The first line of the render, or an empty line when there is none. */
function first(source: string, width = 80): MdLine {
	return one(source, width)[0] ?? [];
}

describe("the voices", () => {
	test("a heading is bold text and the hash marks drop", () => {
		expect(one("# Title")).toEqual([[{ text: "Title", fg: "T", bold: true }]]);
		expect(one("#### Deep")).toEqual([[{ text: "Deep", fg: "T", bold: true }]]);
	});

	test("bold is bold text, italic keeps the line's voice", () => {
		const [line] = one("a **bold** and *ital* word");
		expect(line).toEqual([
			{ text: "a", fg: "T" },
			{ text: " ", fg: "T", bold: true },
			{ text: "bold", fg: "T", bold: true },
			{ text: " ", fg: "T" },
			{ text: "and", fg: "T" },
			{ text: " ", fg: "T" },
			{ text: "ital", fg: "T" },
			{ text: " ", fg: "T" },
			{ text: "word", fg: "T" },
		]);
	});

	test("the underscore bold and the double asterisk both raise", () => {
		expect(first("__bold__")).toEqual([{ text: "bold", fg: "T", bold: true }]);
		expect(first("a ***triple*** tail")).toEqual([
			{ text: "a", fg: "T" },
			{ text: " ", fg: "T", bold: true },
			{ text: "triple", fg: "T", bold: true },
			{ text: " ", fg: "T" },
			{ text: "tail", fg: "T" },
		]);
	});

	test("inline code is dim and the backticks drop", () => {
		expect(spans(first("run `npm test` now"))).toEqual([
			["run", "T"],
			[" ", "D"],
			["npm", "D"],
			[" ", "D"],
			["test", "D"],
			[" ", "T"],
			["now", "T"],
		]);
	});

	test("a link keeps its label, an image keeps its alt text", () => {
		expect(plain(first("[the label](http://example.com)"))).toBe("the label");
		expect(plain(first("see ![a diagram](x.png) here"))).toBe("see a diagram here");
	});

	test("a block quote keeps its text and the mark drops", () => {
		expect(plain(first("> quoted text"))).toBe("quoted text");
	});

	test("unmatched markup passes through as text", () => {
		expect(one("a * b and c_d e")).toEqual([
			[
				{ text: "a", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "*", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "b", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "and", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "c_d", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "e", fg: "T" },
			],
		]);
	});
});

describe("the blocks", () => {
	test("a code block drops its fences, dims its lines, and indents two", () => {
		expect(one("```\nconst x = 1;\n```")).toEqual([
			[
				{ text: "  const", fg: "D" },
				{ text: " ", fg: "D" },
				{ text: "x", fg: "D" },
				{ text: " ", fg: "D" },
				{ text: "=", fg: "D" },
				{ text: " ", fg: "D" },
				{ text: "1;", fg: "D" },
			],
		]);
	});

	test("a code block's wrapped rows keep the indent", () => {
		const lines = one("```\nconst value = aLongName;\n```", 16);
		expect(plain(lines[0] ?? [])).toBe("  const value =");
		expect(plain(lines[1] ?? [])).toBe("  aLongName;");
	});

	test("a list keeps its marker and indents two cells per level", () => {
		expect(one("- one\n- two\n  - nested")).toEqual([
			[
				{ text: "-", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "one", fg: "T" },
			],
			[
				{ text: "-", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "two", fg: "T" },
			],
			[
				{ text: "  -", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "nested", fg: "T" },
			],
		]);
	});

	test("a numbered list keeps its number", () => {
		expect(one("1. first")).toEqual([
			[
				{ text: "1.", fg: "T" },
				{ text: " ", fg: "T" },
				{ text: "first", fg: "T" },
			],
		]);
	});

	test("a horizontal rule is a blank line", () => {
		expect(one("before\n---\nafter")).toEqual([
			[{ text: "before", fg: "T" }],
			[],
			[{ text: "after", fg: "T" }],
		]);
	});
});

describe("the wrapping", () => {
	test("words wrap on spaces at the width", () => {
		const lines = one("aa bb cc", 7);
		expect(plain(lines[0] ?? [])).toBe("aa bb");
		expect(plain(lines[1] ?? [])).toBe("cc");
	});

	test("a word wider than the budget is cut on grapheme boundaries", () => {
		const lines = one("abcdefgh", 5);
		expect(plain(lines[0] ?? [])).toBe("abcde");
		expect(plain(lines[1] ?? [])).toBe("fgh");
	});

	test("a wide word keeps its voice across the cut", () => {
		const lines = one("**abcdefgh**", 5);
		expect(lines[0]).toEqual([{ text: "abcde", fg: "T", bold: true }]);
		expect(lines[1]).toEqual([{ text: "fgh", fg: "T", bold: true }]);
	});

	test("multiple spaces collapse to one", () => {
		expect(plain(first("a    b", 40))).toBe("a b");
	});

	test("wide characters take two cells", () => {
		const lines = one("日本語のテキスト", 10);
		expect(plain(lines[0] ?? [])).toBe("日本語のテ");
		expect(widthOf(plain(lines[0] ?? []))).toBe(10);
		expect(plain(lines[1] ?? [])).toBe("キスト");
	});

	test("a zero width renders nothing", () => {
		expect(one("text", 0)).toEqual([]);
	});
});
