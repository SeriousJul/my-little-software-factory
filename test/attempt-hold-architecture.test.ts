/**
 * The source half of the blocked-and-unrefreshed rule (ADR 0077 as extended
 * by ADR 0101, issue #217).
 *
 * The rule's behavior stands in `test/attempt-hold.test.ts`: its truth table,
 * and the two aggregates' answers against each other. This file holds the
 * shape the rule keeps in source: both aggregates reach the shared module,
 * and the "unrefreshed since T" comparison stands in one query, in no
 * aggregate. A second copy of the rule in one aggregate shows up as a red
 * tripwire here instead of staying invisible until a failing start loops for
 * five days.
 *
 * The mutation campaign keeps this file out: it reads the state modules'
 * text, and instrumentation rewrites the call shapes it counts, so under
 * mutation it fails on a text change rather than a behavior change. It stays
 * in `bun run test`, which reads the uninstrumented tree.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sourceFiles } from "./static-checks.ts";

describe("the two holds read one rule (ADR 0077, ADR 0101)", () => {
	test("both aggregates reach the rule through the shared module", () => {
		for (const file of ["src/state/handoff.ts", "src/state/plane-action.ts"]) {
			const text = readFileSync(file, "utf8");
			expect(text, file).toContain("blockedUnrefreshedHold({");
			// The source half is the shared query, the same one the cycle-end
			// re-verify gate runs. A hold that walked the source names itself would
			// be the second copy this check is here to catch.
			expect(text, file).toContain("hasUnrefreshedActiveMembershipSince");
		}
		// Tripwire, not proof: the agreement test in `test/attempt-hold.test.ts`
		// is what measures the rule. The "unrefreshed since T" comparison stands in
		// one query, and the newest attempt's time is compared in one module.
		const offenders = sourceFiles("src").filter((file) => {
			const text = readFileSync(file, "utf8");
			return /latest\.at\s*[<>]/u.test(text) || /last_success\s*[<>]/u.test(text);
		});
		expect(offenders).toEqual([]);
	});
});
