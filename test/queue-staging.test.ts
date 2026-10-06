/**
 * The staging fact on its own (issue #223).
 *
 * The queue's lines, the hold lines, and the configuration reference all name this
 * fact by the same two words, and the modules that write those lines read them
 * from here. A direct test keeps the names from drifting from the words the docs
 * state: the two stagings have to stay two different words, and each has to be the
 * word the record prints.
 */
import { describe, expect, test } from "bun:test";
import { type QueueStaging, queueStagingOf } from "../src/domain/queue-staging.ts";

describe('the staging of a Work queue row (GLOSSARY.md "Staging")', () => {
	test("the row's automatic mark names the staging", () => {
		expect(queueStagingOf(true)).toBe("automatic");
		expect(queueStagingOf(false)).toBe("operator-staged");
	});

	test("the two stagings are two different words", () => {
		// A reviewer tells the factory's row from their own off these words alone:
		// the origin names the operator's route and the factory's continuation both
		// `workflow`, and the operator's staged ticket and the factory's fresh
		// ticket both `open`.
		const stagings = new Set<QueueStaging>([queueStagingOf(true), queueStagingOf(false)]);
		expect(stagings.size).toBe(2);
	});
});
