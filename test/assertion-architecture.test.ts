/**
 * Every assertion the suite writes must be able to fail.
 *
 * A negated `toContain` that receives an asymmetric matcher is not an
 * assertion. Bun's `toContain` compares by equality, so `expect.stringContaining`
 * inside it matches no element, so `not.toContain` passes whatever the list
 * holds. The suite carried 52 of them, and 10 of those were the keep-half of the
 * start's residue contract (issue #204, stories 7 and 22): "the workspace that
 * pre-dates the attempt stands", "no branch delete runs for a branch this start
 * did not make". A mutation that closed a workspace the start never created left
 * all 149 handoff tests green. The claim those tests make is now written through
 * `expectNoCommand` in `test/command-assertions.ts`, and this check refuses the
 * vacuous shape so it cannot come back.
 *
 * Like the other static architecture checks, this is not a behavior test: it
 * reads the plane's own test sources, so it holds the shape of the assertions
 * rather than the behavior they describe.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { expectNoCommand } from "./command-assertions.ts";
import { sourceFiles } from "./static-checks.ts";

const tests = sourceFiles("test");

/**
 * A negated `toContain` fed any asymmetric matcher. `stringContaining`,
 * `objectContaining`, `any`, and `anything` all compare by equality inside
 * `toContain`, so each one makes the negation always pass.
 */
const VACUOUS_NEGATION =
	/\.not\.toContain\(\s*expect\.(stringContaining|objectContaining|any|anything)\s*\(/u;

describe("no test asserts with a matcher a negated toContain can never see", () => {
	test("the scan reads the suites that carry the command claims", () => {
		// A check that scans nothing passes forever. Every suite that states a
		// "this run did not issue that command" claim must be in the scanned set.
		for (const required of [
			"test/handoff.test.ts",
			"test/handoff-frame.test.ts",
			"test/handoff-dispatch.test.ts",
			"test/consultation-frame.test.ts",
			"test/consultation-operations.test.ts",
			"test/command-assertions.ts",
		]) {
			expect(tests, `${required} must be in the scanned set`).toContain(required);
		}
	});

	test("no test file holds the vacuous negation", () => {
		const offenders = tests.filter((file) => VACUOUS_NEGATION.test(readFileSync(file, "utf8")));
		expect(offenders).toEqual([]);
	});

	test("the shared guard can fail", () => {
		// A guard that never fails is the vacuous assertion under another name.
		expect(() => expectNoCommand(["herdr tab close tab-1"], "tab close")).toThrow();
		expect(() => expectNoCommand(["git -C /repo branch -D factory/1-x"], "branch -D")).toThrow();
		// And it passes only when the command really is absent.
		expectNoCommand(["herdr tab close tab-1"], "workspace close");
		expectNoCommand([], "branch -D");
	});
});
