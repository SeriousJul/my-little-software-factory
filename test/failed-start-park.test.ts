/**
 * The Failed-start park's rule (issue #298, ADR 0106).
 *
 * The park is the second brake in front of a Ticket whose Handoff starts keep
 * failing: the Attempt hold waits out one failure for the source read that
 * carries the Ticket's current facts, and the park stands when the re-ask on that
 * refresh keeps failing too. Each rule takes its facts and answers, so the gate
 * the observation loop's walk runs, and the marker the row wears, are measured
 * here without a cycle, an Agent, or a state file.
 */
import { describe, expect, test } from "bun:test";
import {
	FAILED_START_PARK_PREFIX,
	type FailedStartParkFacts,
	failedStartParkAttempts,
	failedStartParkLine,
	failedStartParkStands,
} from "../src/domain/failed-start-park.ts";

/** The facts of a Ticket whose newest run holds `failedStartStreak` starts. */
function run(failedStartStreak: number, over: Partial<FailedStartParkFacts> = {}) {
	return failedStartParkStands({
		failedStartStreak,
		handoffLimit: 10,
		judgedOut: false,
		...over,
	});
}

describe("the Failed-start park's count (issue #298)", () => {
	test("the park arrives at half the Handoff limit, before the limit", () => {
		// The cap that ends a work cycle stays the one knob the operator sets, and
		// the park has to stand while that cap still stands behind it.
		expect(failedStartParkAttempts(10)).toBe(5);
		expect(failedStartParkAttempts(20)).toBe(10);
		expect(failedStartParkAttempts(7)).toBe(3);
		// A limit below two cannot be halved below one: one failed start is the
		// earliest the fact can say anything.
		expect(failedStartParkAttempts(1)).toBe(1);
		expect(failedStartParkAttempts(0)).toBe(1);
	});

	test("the run stands at the park's count and not below it", () => {
		expect(run(4)).toBe(false);
		expect(run(5)).toBe(true);
		expect(run(9_356)).toBe(true);
	});

	test("the park stands before the Handoff limit the cycle ends on", () => {
		// The whole point of the second brake: the operator meets the loop while the
		// cap that ends a work cycle is still ahead of it, not after it has run.
		for (const handoffLimit of [2, 4, 10, 20, 41]) {
			const parked = run(failedStartParkAttempts(handoffLimit), { handoffLimit });
			expect(parked).toBe(true);
			expect(failedStartParkAttempts(handoffLimit)).toBeLessThanOrEqual(handoffLimit);
		}
	});

	test("the operator's own act answers the failure and the park leaves", () => {
		// The ignore and the source mute are an answer to the failing starts, and
		// the machine already holds a judged-out Ticket out of every automatic walk.
		expect(run(5, { judgedOut: true })).toBe(false);
		expect(run(9_356, { judgedOut: true })).toBe(false);
	});
});

describe("the Failed-start park's line (issue #298)", () => {
	test("the line names the Ticket and the run the park stands on", () => {
		// The shape every record refusal wears: the prefix, the Ticket's name, and
		// the fact in parentheses. The count is what the operator weighs.
		expect(failedStartParkLine('"Watch agent turns"', 6)).toBe(
			'handoff failure park: "Watch agent turns" (6 Handoff starts in a row never reached an Agent)',
		);
	});

	test("the prefix is the fact that keeps the park apart from the other holds", () => {
		expect(FAILED_START_PARK_PREFIX).toBe("handoff failure park:");
	});
});
