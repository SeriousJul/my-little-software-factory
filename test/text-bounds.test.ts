/**
 * The text bounds module, read through its interface (issue #203 review).
 *
 * The measure and the two cuts are pure reads over a text: no state file, no
 * command runner, and no view stands here.
 */
import { describe, expect, test } from "bun:test";
import { utf8ByteLength, utf8Prefix, utf8Suffix } from "../src/text-bounds.ts";

describe("the text bounds module", () => {
	test("measures a text by UTF-8 bytes", () => {
		expect(utf8ByteLength("")).toBe(0);
		expect(utf8ByteLength("plain")).toBe(5);
		expect(utf8ByteLength("é😀")).toBe(6);
	});

	test("cuts a prefix to the byte bound without splitting a character", () => {
		expect(utf8Prefix("abcdef", 3)).toBe("abc");
		expect(utf8Prefix("abcdef", 100)).toBe("abcdef");
		expect(utf8Prefix("abcdef", 0)).toBe("");
		expect(utf8Prefix("abcdef", -1)).toBe("");
		// The bound lands inside a multi-byte character, so the whole character
		// is dropped rather than cut.
		expect(utf8Prefix("a😀b", 2)).toBe("a");
		expect(utf8ByteLength(utf8Prefix("ééé", 5))).toBeLessThanOrEqual(5);
		expect(utf8Prefix("ééé", 5)).toBe("éé");
	});

	test("cuts a suffix to the byte bound without splitting a character", () => {
		expect(utf8Suffix("abcdef", 3)).toBe("def");
		expect(utf8Suffix("abcdef", 100)).toBe("abcdef");
		expect(utf8Suffix("abcdef", 0)).toBe("");
		expect(utf8Suffix("😀ab", 2)).toBe("ab");
		expect(utf8Suffix("ééé", 5)).toBe("éé");
	});
});
