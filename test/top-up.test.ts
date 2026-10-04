/**
 * The auto top-up's gate rules (ADR 0051, ADR 0088, issue #202 review).
 *
 * Each rule takes its facts and answers, so the decision the observation loop's
 * walk makes is measured here without a cycle, an Agent, a command runner, or a
 * state file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	automaticAddsHold,
	continuationQueueHolds,
	type OpenTicketRowFacts,
	openTicketRowGate,
	openTicketWaitsHold,
	type RestartCandidateFacts,
	restartCandidateHolds,
	type TopUpCycleFacts,
	topUpCycleOpen,
} from "../src/domain/top-up.ts";
import { sourceFiles } from "./static-checks.ts";

/** The cycle facts with every wait clear. */
function cycle(overrides: Partial<TopUpCycleFacts> = {}): TopUpCycleFacts {
	return {
		modeOn: true,
		queuePaused: false,
		dispatchPauseActive: false,
		queueDepth: 0,
		...overrides,
	};
}

/** The restart candidate's facts with every gate clear. */
function restart(overrides: Partial<RestartCandidateFacts> = {}): RestartCandidateFacts {
	return {
		ignoreBlocked: false,
		pastStartupGrace: true,
		hasPane: true,
		agentMissing: true,
		handoffCount: 1,
		handoffLimit: 10,
		queueItemStands: false,
		restartMarkStands: false,
		...overrides,
	};
}

describe("the Handoff limit is one rule (ADR 0005)", () => {
	test("no surface restates the comparison the rule takes", () => {
		// The gate stood at seven sites that each wrote the comparison. The rule
		// takes the count and the cap now, so a surface that writes the comparison
		// again is a second gate that can drift from the first.
		const offenders: string[] = [];
		for (const file of sourceFiles("src")) {
			if (file === "src/domain/ticket.ts") continue;
			if (/\bhandoffCount\s*(?:>=|>|<=|<)\s*/u.test(readFileSync(file, "utf8"))) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("the top-up's cycle gate (ADR 0051)", () => {
	test("mode on, brake down, no held turn, empty queue: the cycle may add", () => {
		expect(topUpCycleOpen(cycle())).toBe(true);
	});

	test("each single wait holds the whole cycle", () => {
		expect(topUpCycleOpen(cycle({ modeOn: false }))).toBe(false);
		expect(topUpCycleOpen(cycle({ queuePaused: true }))).toBe(false);
		expect(topUpCycleOpen(cycle({ dispatchPauseActive: true }))).toBe(false);
		// One item is enough: the queue's depth is the top-up's pace.
		expect(topUpCycleOpen(cycle({ queueDepth: 1 }))).toBe(false);
		expect(topUpCycleOpen(cycle({ queueDepth: 4 }))).toBe(false);
	});
});

describe("the gates every automatic add reads (ADR 0051, ADR 0052, ADR 0016)", () => {
	test("mode on, brake down, no held turn: the gates hold nothing", () => {
		expect(automaticAddsHold(cycle())).toBe(false);
	});

	test("each single wait holds every add", () => {
		expect(automaticAddsHold(cycle({ modeOn: false }))).toBe(true);
		expect(automaticAddsHold(cycle({ queuePaused: true }))).toBe(true);
		expect(automaticAddsHold(cycle({ dispatchPauseActive: true }))).toBe(true);
	});

	test("the fresh-work add enters an empty queue only (ADR 0051)", () => {
		expect(topUpCycleOpen(cycle())).toBe(true);
		// One item is enough: the queue's depth is the top-up's pace.
		expect(topUpCycleOpen(cycle({ queueDepth: 1 }))).toBe(false);
		expect(topUpCycleOpen(cycle({ queueDepth: 4 }))).toBe(false);
		// The depth is the fresh-work walk's own gate. The standing gates above
		// hold the continuation add too, and ADR 0094 lets that add enter a queue
		// that already holds fresh work.
		expect(automaticAddsHold(cycle({ queueDepth: 1 }))).toBe(false);
	});
});

describe("the row a continuation must not jump (ADR 0051, ADR 0094, ADR 0100)", () => {
	test("an empty queue, or a queue of fresh work alone, holds nothing", () => {
		expect(continuationQueueHolds([])).toBe(false);
		expect(continuationQueueHolds([{ continuation: false }, { continuation: false }])).toBe(false);
	});

	test("only a continuation already standing holds the add (ADR 0100)", () => {
		// The operator's staging is no longer a fact this rule reads: the seat a
		// settling turn freed belongs to that turn's own next step, and the
		// operator's row waits for the next seat. The queue's own pace - one
		// continuation - still holds. `test/observation.test.ts` and
		// `test/auto-handoff-chain.test.ts` carry the staged-row case.
		expect(continuationQueueHolds([{ continuation: false }])).toBe(false);
		expect(continuationQueueHolds([{ continuation: true }])).toBe(true);
	});
});

describe("the restart candidate (ADR 0051, ADR 0060, ADR 0070)", () => {
	test("a flagged in-flight Ticket with a missing Agent is the candidate", () => {
		expect(restartCandidateHolds(restart())).toBe(true);
	});

	test("each single gate holds the ticket out", () => {
		expect(restartCandidateHolds(restart({ ignoreBlocked: true }))).toBe(false);
		expect(restartCandidateHolds(restart({ pastStartupGrace: false }))).toBe(false);
		expect(restartCandidateHolds(restart({ hasPane: false }))).toBe(false);
		expect(restartCandidateHolds(restart({ agentMissing: false }))).toBe(false);
		expect(restartCandidateHolds(restart({ handoffCount: 10 }))).toBe(false);
		expect(restartCandidateHolds(restart({ queueItemStands: true }))).toBe(false);
		// The episode mark stands while the asked-for start holds its place or runs.
		expect(restartCandidateHolds(restart({ restartMarkStands: true }))).toBe(false);
	});
});

describe("the top-up's open-ticket row gate (ADR 0051, ADR 0060, ADR 0027)", () => {
	/** The row facts with every gate clear. */
	function row(overrides: Partial<OpenTicketRowFacts> = {}): OpenTicketRowFacts {
		return {
			state: "open",
			actionable: true,
			ignoreBlocked: false,
			handoffCount: 0,
			handoffLimit: 10,
			taskType: "implement",
			...overrides,
		};
	}

	test("an open actionable row under the limit answers with the task it offers", () => {
		expect(openTicketRowGate(row())).toEqual({ stands: true, taskType: "implement" });
	});

	test("each single row fact holds the row out", () => {
		expect(openTicketRowGate(row({ state: "awaiting" }))).toEqual({ stands: false });
		expect(openTicketRowGate(row({ state: "running" }))).toEqual({ stands: false });
		expect(openTicketRowGate(row({ actionable: false }))).toEqual({ stands: false });
		expect(openTicketRowGate(row({ ignoreBlocked: true }))).toEqual({ stands: false });
		expect(openTicketRowGate(row({ handoffCount: 10 }))).toEqual({ stands: false });
		// A parking state offers no task (ADR 0027).
		expect(openTicketRowGate(row({ taskType: null }))).toEqual({ stands: false });
	});
});

describe("the top-up's open-ticket waits (ADR 0051, ADR 0026)", () => {
	test("a re-verified ticket with the hold clear and no item stands", () => {
		expect(
			openTicketWaitsHold({
				sourceReverified: true,
				sameTypeHoldActive: false,
				queueItemStands: false,
			}),
		).toBe(true);
	});

	test("each single wait holds the ticket out", () => {
		expect(
			openTicketWaitsHold({
				sourceReverified: false,
				sameTypeHoldActive: false,
				queueItemStands: false,
			}),
		).toBe(false);
		expect(
			openTicketWaitsHold({
				sourceReverified: true,
				sameTypeHoldActive: true,
				queueItemStands: false,
			}),
		).toBe(false);
		expect(
			openTicketWaitsHold({
				sourceReverified: true,
				sameTypeHoldActive: false,
				queueItemStands: true,
			}),
		).toBe(false);
	});
});
