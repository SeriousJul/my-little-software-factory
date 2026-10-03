/**
 * The auto top-up's gate rules (ADR 0051, ADR 0088, issue #202 review).
 *
 * Each rule takes its facts and answers, so the decision the observation loop's
 * walk makes is measured here without a cycle, an Agent, a command runner, or a
 * state file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TransitionOutcome } from "../src/config.ts";
import {
	type OpenTicketRowFacts,
	openTicketRowGate,
	openTicketWaitsHold,
	type RestartCandidateFacts,
	refiredPositionStands,
	refiredRoute,
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

/** One transition outcome, with the re-fired skip's shape by default. */
function outcome(overrides: Partial<TransitionOutcome> = {}): TransitionOutcome {
	return {
		fired: true,
		when: null,
		reason: "",
		ticketFacts: [],
		pullRequestFacts: [],
		autoAdvance: true,
		ticketWrite: null,
		pullRequestWrite: null,
		pullRequestIdentity: null,
		pullRequestKey: null,
		writeFailure: "",
		positionTaskType: "implement",
		positionTicketIdentity: "github:github.com:I_1",
		refired: true,
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

describe("the re-fired skip's route (ADR 0042)", () => {
	test("a re-fired fire with a position answers with the position it routes to", () => {
		const route = refiredRoute(outcome({ agent: "herdr-coder", environment: "worktree" }));
		expect(route).toEqual({
			stands: true,
			taskType: "implement",
			positionTicketIdentity: "github:github.com:I_1",
			agent: "herdr-coder",
			environment: "worktree",
		});
	});

	test("a turn that settled without a transition is no route", () => {
		expect(refiredRoute(null)).toEqual({ stands: false });
	});

	test("a damaged record is no route", () => {
		// `refired` is set only on an outcome that fired and derived a position,
		// so each of these is a state the plane does not write.
		expect(refiredRoute(outcome({ refired: undefined }))).toEqual({ stands: false });
		expect(refiredRoute(outcome({ refired: false }))).toEqual({ stands: false });
		expect(refiredRoute(outcome({ fired: false }))).toEqual({ stands: false });
		expect(refiredRoute(outcome({ autoAdvance: false }))).toEqual({ stands: false });
		expect(refiredRoute(outcome({ writeFailure: "label write failed" }))).toEqual({
			stands: false,
		});
		expect(refiredRoute(outcome({ positionTaskType: null }))).toEqual({ stands: false });
		expect(refiredRoute(outcome({ positionTicketIdentity: null }))).toEqual({
			stands: false,
		});
	});
});

describe("the position the re-fired skip routes to (ADR 0042)", () => {
	test("an actionable position under the limit with the hold clear stands", () => {
		expect(
			refiredPositionStands({
				actionable: true,
				sameTypeHoldActive: false,
				handoffCount: 3,
				handoffLimit: 10,
			}),
		).toBe(true);
	});

	test("each single guard holds the position out", () => {
		expect(
			refiredPositionStands({
				actionable: false,
				sameTypeHoldActive: false,
				handoffCount: 3,
				handoffLimit: 10,
			}),
		).toBe(false);
		expect(
			refiredPositionStands({
				actionable: true,
				sameTypeHoldActive: true,
				handoffCount: 3,
				handoffLimit: 10,
			}),
		).toBe(false);
		// The loop guard is the same rule the handoff's add ran (ADR 0005).
		expect(
			refiredPositionStands({
				actionable: true,
				sameTypeHoldActive: false,
				handoffCount: 10,
				handoffLimit: 10,
			}),
		).toBe(false);
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
