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
	AUTOMATIC_HOLD_LINES,
	AUTOMATIC_HOLD_REASONS,
	AUTOMATIC_ROW_HOLD_REASONS,
	type AutomaticBareHoldReason,
	automaticAddsHold,
	automaticHoldKey,
	automaticHoldLine,
	continuationHold,
	freshWorkHold,
	type OpenTicketRowFacts,
	openTicketRowGate,
	openTicketWaitsHold,
	type RestartCandidateFacts,
	restartCandidateHolds,
	type TopUpCycleFacts,
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
		expect(freshWorkHold(cycle())).toBeNull();
	});

	test("each single wait holds the whole cycle", () => {
		expect(freshWorkHold(cycle({ modeOn: false }))).not.toBeNull();
		expect(freshWorkHold(cycle({ queuePaused: true }))).not.toBeNull();
		expect(freshWorkHold(cycle({ dispatchPauseActive: true }))).not.toBeNull();
		// One item is enough: the queue's depth is the top-up's pace.
		expect(freshWorkHold(cycle({ queueDepth: 1 }))).not.toBeNull();
		expect(freshWorkHold(cycle({ queueDepth: 4 }))).not.toBeNull();
	});
});

describe("the gates every automatic add reads (ADR 0051, ADR 0052, ADR 0016)", () => {
	test("mode on, brake down, no held turn: the gates hold nothing", () => {
		expect(automaticAddsHold(cycle())).toBeNull();
	});

	test("each single wait holds every add, and names itself (issue #223)", () => {
		expect(automaticAddsHold(cycle({ modeOn: false }))).toEqual({ reason: "auto-handoff-off" });
		expect(automaticAddsHold(cycle({ queuePaused: true }))).toEqual({ reason: "queue-paused" });
		expect(automaticAddsHold(cycle({ dispatchPauseActive: true }))).toEqual({
			reason: "dispatch-pause",
		});
	});

	test("the first gate the walk reads is the fact it states", () => {
		// The mode, the brake, and the held turn stand at once: one hold is stated,
		// and it is the one the walk reached first.
		expect(
			automaticAddsHold(cycle({ modeOn: false, queuePaused: true, dispatchPauseActive: true })),
		).toEqual({ reason: "auto-handoff-off" });
		expect(automaticAddsHold(cycle({ queuePaused: true, dispatchPauseActive: true }))).toEqual({
			reason: "queue-paused",
		});
	});

	test("the fresh-work add enters an empty queue only (ADR 0051)", () => {
		expect(freshWorkHold(cycle())).toBeNull();
		// One item is enough: the queue's depth is the top-up's pace.
		expect(freshWorkHold(cycle({ queueDepth: 1 }))).toEqual({ reason: "queue-row-standing" });
		expect(freshWorkHold(cycle({ queueDepth: 4 }))).toEqual({ reason: "queue-row-standing" });
		// The depth is the fresh-work walk's own gate. The standing gates above
		// hold the continuation add too, and ADR 0094 lets that add enter a queue
		// that already holds fresh work.
		expect(automaticAddsHold(cycle({ queueDepth: 1 }))).toBeNull();
		expect(freshWorkHold(cycle({ queueDepth: 1 }))).toEqual({ reason: "queue-row-standing" });
	});

	test("the fresh-work hold reads the standing gates first (ADR 0051, ADR 0052, ADR 0016)", () => {
		expect(freshWorkHold(cycle({ queueDepth: 2, modeOn: false }))).toEqual({
			reason: "auto-handoff-off",
		});
		expect(freshWorkHold(cycle({ queueDepth: 2, queuePaused: true }))).toEqual({
			reason: "queue-paused",
		});
		expect(freshWorkHold(cycle({ queueDepth: 2, dispatchPauseActive: true }))).toEqual({
			reason: "dispatch-pause",
		});
		expect(freshWorkHold(cycle({ queueDepth: 0 }))).toBeNull();
	});
});

/**
 * The record words (issue #223). A hold that names nothing cannot be told apart
 * from a walk that broke, so each reason states its own fact and no two reasons
 * share a line.
 */
describe("each automatic-walk hold names itself in the record (issue #223)", () => {
	test("every reason has its own line", () => {
		const lines = AUTOMATIC_HOLD_REASONS.map((reason) => AUTOMATIC_HOLD_LINES[reason]);
		expect(new Set(lines).size).toBe(AUTOMATIC_HOLD_REASONS.length);
		expect(lines).toEqual([
			"automatic walks hold: auto-handoff is off",
			"automatic walks hold: the Work queue is paused",
			"automatic walks hold: a failed turn waits for the operator",
			"automatic walks hold: the Work queue already holds a continuation",
			"automatic walks hold: the Work queue holds an item the operator staged",
			"automatic walks hold: the Work queue holds a waiting row",
		]);
	});

	test("the rule answers only reasons the words cover", () => {
		for (const facts of [
			cycle({ modeOn: false }),
			cycle({ queuePaused: true }),
			cycle({ dispatchPauseActive: true }),
			cycle({ queueDepth: 1 }),
		]) {
			const hold = freshWorkHold(facts);
			if (hold === null) throw new Error("the gate holds nothing for these facts");
			expect(AUTOMATIC_HOLD_LINES[hold.reason]).not.toBeUndefined();
		}
	});

	/**
	 * The row the walk waits behind is part of the line (issue #223 review). A run
	 * with more than one ticket in play has to say which owed start the hold
	 * blocked, not only that a hold happened.
	 */
	test("a standing-row line names the row, and every other line stays bare", () => {
		const name = (identity: string) => `"${identity} title"`;
		expect(automaticHoldLine({ reason: "continuation-standing", row: "I_6" }, name)).toBe(
			'automatic walks hold: the Work queue already holds a continuation ("I_6 title")',
		);
		expect(automaticHoldLine({ reason: "operator-row-standing", row: "I_7" }, name)).toBe(
			'automatic walks hold: the Work queue holds an item the operator staged ("I_7 title")',
		);
		// Every other hold states a bare fact: no row is picked where its gate
		// stands, so none can be named. The fresh-work gate holds on any row at all,
		// a Consultation row included, and the staging of the row that stands is what
		// the queue's own `handoff queued:` line states.
		expect(AUTOMATIC_ROW_HOLD_REASONS).toEqual(["continuation-standing", "operator-row-standing"]);
		const bare = AUTOMATIC_HOLD_REASONS.filter(
			(reason) => !(AUTOMATIC_ROW_HOLD_REASONS as readonly string[]).includes(reason),
		) as AutomaticBareHoldReason[];
		expect(bare).toHaveLength(AUTOMATIC_HOLD_REASONS.length - AUTOMATIC_ROW_HOLD_REASONS.length);
		for (const reason of bare) {
			expect(automaticHoldLine({ reason }, name)).toBe(AUTOMATIC_HOLD_LINES[reason]);
		}
	});

	test("the same fact behind a different row is a different fact", () => {
		expect(automaticHoldKey({ reason: "queue-paused" })).toBe(
			automaticHoldKey({ reason: "queue-paused" }),
		);
		const first = automaticHoldKey({ reason: "operator-row-standing", row: "I_6" });
		expect(first).toBe(automaticHoldKey({ reason: "operator-row-standing", row: "I_6" }));
		// A later cycle that waits behind another row states its own line again.
		expect(first).not.toBe(automaticHoldKey({ reason: "operator-row-standing", row: "I_7" }));
		expect(first).not.toBe(automaticHoldKey({ reason: "continuation-standing", row: "I_6" }));
	});
});

describe("the row a continuation must not jump (ADR 0051, ADR 0094, ADR 0100, issue #230)", () => {
	test("an empty queue, or a queue of fresh work alone, holds nothing", () => {
		expect(continuationHold([])).toBeNull();
		expect(
			continuationHold([{ identity: "I_6", continuation: false, automatic: true }]),
		).toBeNull();
	});

	test("a standing Workflow route row holds the add, of either staging (issue #230)", () => {
		// The queue's own pace - one continuation at a time - is the whole rule. A
		// row the operator confirmed from the Decision screen counts as a continuation
		// already standing: ADR 0100 ranks the owed row ahead in the queue's order, and
		// a row that already stands is never overtaken by a row that has not entered.
		expect(
			continuationHold([{ identity: "I_6", continuation: false, automatic: false }]),
		).toBeNull();
		expect(continuationHold([{ identity: "I_6", continuation: true, automatic: true }])).toEqual({
			reason: "continuation-standing",
			row: "I_6",
		});
		expect(continuationHold([{ identity: "I_6", continuation: true, automatic: false }])).toEqual({
			reason: "operator-row-standing",
			row: "I_6",
		});
	});

	test("the hold names the staging of the row the walk waits behind (issue #223)", () => {
		// The origin cannot tell the two apart - the operator's route and the
		// factory's continuation are both `workflow` - so the line has to. A row
		// the operator staged is stated as the operator's row, never as a
		// continuation the factory owes.
		// The first standing row in the queue's order is the one the walk waits
		// behind, and it is the row the line names.
		expect(
			continuationHold([
				{ identity: "I_6", continuation: true, automatic: false },
				{ identity: "I_7", continuation: true, automatic: true },
			]),
		).toEqual({ reason: "operator-row-standing", row: "I_6" });
		expect(
			continuationHold([
				{ identity: "I_7", continuation: true, automatic: true },
				{ identity: "I_6", continuation: true, automatic: false },
			]),
		).toEqual({ reason: "continuation-standing", row: "I_7" });
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
