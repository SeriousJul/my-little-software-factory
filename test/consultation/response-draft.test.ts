/**
 * The Response draft module's rules, read through its interface (issue #203).
 *
 * No state file and no command runner stand here: every rule is a pure read
 * over the text the operator typed, so the rule a test covers is the rule the
 * plane runs.
 */
import { describe, expect, test } from "bun:test";
import {
	boundedReplacementInput,
	CONSULTATION_INPUT_LIMIT,
	isLiteralText,
	responseOversize,
	sanitizePastedText,
	utf8ByteLength,
	validateConsultationInput,
	validateResponseInput,
} from "../../src/consultation/response-draft.ts";

describe("the Response draft module", () => {
	test("limits input by UTF-8 bytes and preserves literal Unicode text", () => {
		expect(validateConsultationInput("😀", 4)).toBeUndefined();
		expect(validateConsultationInput("😀", 3)).toContain("4 UTF-8 bytes");
		expect(validateResponseInput("\n\tanswer")).toBeUndefined();
		expect(validateResponseInput("   ")).toBe("response cannot be empty");
		expect(isLiteralText("é😀\n\t")).toBe(true);
		expect(isLiteralText("safe\u001b[31m")).toBe(false);
	});

	test("refuses input over the 64 KiB default limit by UTF-8 bytes", () => {
		const atLimit = "a".repeat(64 * 1024);
		const overLimit = "a".repeat(64 * 1024 + 1);
		expect(CONSULTATION_INPUT_LIMIT).toBe(64 * 1024);
		expect(validateConsultationInput(atLimit)).toBeUndefined();
		expect(validateConsultationInput(overLimit)).toBe(
			`initial input is ${64 * 1024 + 1} UTF-8 bytes; the limit is ${64 * 1024}`,
		);
		// A multi-byte character straddling the limit is counted by bytes.
		expect(validateConsultationInput(`${"a".repeat(64 * 1024 - 4)}😀`)).toBeUndefined();
		expect(validateConsultationInput(`${"a".repeat(64 * 1024 - 3)}😀`)).toContain(
			"UTF-8 bytes; the limit",
		);
		expect(validateResponseInput(overLimit)).toContain("UTF-8 bytes; the limit");
	});

	test("states the size reason once, so the field and the Send action agree", () => {
		// The Response field shows this sentence beside the text, and the Send
		// action refuses with it. One owner writes both, so one draft never
		// carries two different reasons.
		const oversized = "a".repeat(CONSULTATION_INPUT_LIMIT + 1);
		const reason = responseOversize(oversized);
		expect(reason).toBe(
			`response is ${CONSULTATION_INPUT_LIMIT + 1} UTF-8 bytes; the limit is ${CONSULTATION_INPUT_LIMIT}`,
		);
		expect(validateResponseInput(oversized)).toBe(reason);
		// Text at the bound carries no size reason, and it stays editable.
		expect(responseOversize("a".repeat(CONSULTATION_INPUT_LIMIT))).toBeUndefined();
	});

	test("sanitizes a bracketed paste of terminal sequences to its literal text", () => {
		// A color sequence, a title sequence, and a stray carriage return
		// are removed; the newline and the Unicode survive.
		expect(sanitizePastedText("a\u001b[31mred\u001b[0m\r\n\ttabé")).toBe("ared\n\ttabé");
		expect(sanitizePastedText("title\u001b]0;name\u0007end")).toBe("titleend");
		expect(sanitizePastedText("title\u001b]0;name\u001b\\end")).toBe("titleend");
		expect(sanitizePastedText("plain")).toBe("plain");
		expect(sanitizePastedText("\u001b[31m\u001b[0m")).toBe("");
	});

	test("joins the original input and the newest turns, and states the opening once", () => {
		const turns = [
			{ input: "Review this repository", output: "first answer" },
			{ input: "second question", output: "second answer" },
		];
		expect(boundedReplacementInput("Review this repository", turns)).toBe(
			"Original input:\nReview this repository\n\n" +
				"Operator response:\nsecond question\nAgent output:\nsecond answer",
		);
		// The opening turn needs no section of its own: the original input
		// already states it.
		expect(boundedReplacementInput("Review this repository", turns)).not.toContain(
			"Operator response:\nReview this repository",
		);
		// A turn with no captured output keeps its own input and nothing else.
		expect(boundedReplacementInput("ask", [{ input: "opening" }, { input: "follow up" }])).toBe(
			"Original input:\nask\n\nOperator response:\nfollow up",
		);
	});

	test("bounds the recovery text with the recovery marker", () => {
		const turns = [
			{ input: "opening", output: "first answer" },
			{ input: "second question", output: "second answer" },
		];
		const full = boundedReplacementInput("opening input", turns);
		const limit = utf8ByteLength(full) - 1;
		const cut = boundedReplacementInput("opening input", turns, limit);
		expect(cut.endsWith("\n[recovery context omitted]\n")).toBe(true);
		expect(utf8ByteLength(cut)).toBe(limit);
	});

	test("bounds replacement context even when the limit cuts through Unicode", () => {
		const result = boundedReplacementInput("😀".repeat(100), [{ input: "é".repeat(100) }], 40);
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(40);
		expect(result).toContain("recovery context omitted");
	});
});
