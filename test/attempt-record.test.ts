/**
 * The line a Handoff start leaves when its attempt settles `failed` (issue #295).
 *
 * The dispatch's failed starts and the boot's recovery of a crashed run's
 * claims both read this one builder, so the two channels cannot state the same
 * ending in two different shapes. This suite holds the shape itself: the prefix
 * that keeps the line apart from a pre-start gate refusal, the Ticket's name
 * beside it, and the reason the attempt's own row stores - including the case
 * the ledger can hold, a failed attempt whose row stores no reason at all.
 */
import { describe, expect, test } from "bun:test";
import {
	HANDOFF_START_FAILED_PREFIX,
	NO_FAILURE_RECORDED_FACT,
	handoffStartFailedLine,
} from "../src/domain/attempt-record.ts";

describe("the failed Handoff start's line (issue #295)", () => {
	test("the line names the Ticket and the reason its attempt's row stores", () => {
		expect(handoffStartFailedLine('"Add a webhook retry policy"', "the worktree path already exists")).toBe(
			'handoff start failed: "Add a webhook retry policy" (the worktree path already exists)',
		);
	});

	test("the prefix is its own, and never the gate refusal's", () => {
		// A `handoff refused:` line answers a hard gate before the start began and
		// leaves no attempt row; this line stands only under a start that claimed
		// and settled `failed`. One grep has to answer one of them.
		expect(HANDOFF_START_FAILED_PREFIX).toBe("handoff start failed:");
		expect(HANDOFF_START_FAILED_PREFIX).not.toContain("refused");
	});

	test("a failed attempt whose row stores no reason states that fact", () => {
		// The settle's own interface lets a failed settle name no reason, and the
		// attempt's reason column is nullable in every schema version, so an older
		// state file can hold a failed attempt with nothing in it. The line says so
		// instead of inventing an ending the ledger never recorded.
		expect(handoffStartFailedLine("ticket github:github.com:I_9", null)).toBe(
			"handoff start failed: ticket github:github.com:I_9 (the attempt recorded no reason)",
		);
		expect(NO_FAILURE_RECORDED_FACT).toBe("the attempt recorded no reason");
	});
});
