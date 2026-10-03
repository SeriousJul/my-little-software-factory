/**
 * The Consultation warning facts module, read through its interface (issue #203).
 *
 * These are the words a durable Consultation record carries. The record keeps
 * them as written, so the spelling has one owner and the reads that recognize
 * a fact recognize it in either spelling.
 */
import { describe, expect, test } from "bun:test";
import {
	isStaleAgentOutputWarning,
	isTurnEndWarning,
	STALE_AGENT_OUTPUT_WARNING,
	turnEndWarning,
} from "../../src/consultation/warning-facts.ts";

describe("the Consultation warning facts module", () => {
	test("keeps one spelling of the Stale Agent output fact, and reads the older one", () => {
		expect(STALE_AGENT_OUTPUT_WARNING).toBe("Stale Agent output");
		expect(isStaleAgentOutputWarning(STALE_AGENT_OUTPUT_WARNING)).toBe(true);
		// A record an older control plane wrote holds the same fact under the
		// older spelling, and one clear path removes both.
		expect(isStaleAgentOutputWarning("Agent output is stale")).toBe(true);
		expect(isStaleAgentOutputWarning("Turn ended failed")).toBe(false);
		expect(isStaleAgentOutputWarning(null)).toBe(false);
		expect(isStaleAgentOutputWarning(undefined)).toBe(false);
	});

	test("names a failed or aborted turn with its cause and the Agent's own words", () => {
		expect(turnEndWarning("failed", "the API rejected the request")).toBe(
			"Turn ended failed: the API rejected the request",
		);
		// An aborted turn with nothing to say states its cause alone.
		expect(turnEndWarning("aborted", "")).toBe("Turn ended aborted");
		// A turn that answered carries no warning of its own.
		expect(turnEndWarning("completed", "the answer")).toBeNull();
		expect(turnEndWarning("truncated", "the answer")).toBeNull();
		expect(turnEndWarning("unknown", "")).toBeNull();
		// The Agent's words are held to a bound so one turn cannot fill the row.
		expect(turnEndWarning("failed", "x".repeat(300))).toBe(`Turn ended failed: ${"x".repeat(200)}`);
	});

	test("reads the turn-end fact so a later settled turn clears it", () => {
		expect(isTurnEndWarning(turnEndWarning("failed", "the API rejected the request"))).toBe(true);
		expect(isTurnEndWarning("Turn ended aborted")).toBe(true);
		// The Stale Agent output fact is a different fact: a settled turn leaves it
		// for the read that clears it.
		expect(isTurnEndWarning(STALE_AGENT_OUTPUT_WARNING)).toBe(false);
		expect(isTurnEndWarning(null)).toBe(false);
		expect(isTurnEndWarning(undefined)).toBe(false);
	});
});
