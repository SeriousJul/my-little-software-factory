/**
 * The blocked-and-unrefreshed rule both attempt holds read (ADR 0077 as extended
 * by ADR 0101, issue #217).
 *
 * Three things are measured here. The rule's own truth table, so the decision a
 * Ticket's newest attempt makes is testable without a cycle, an Agent, or a state
 * file. The two readers against each other: the Handoff aggregate over its
 * `handoff_attempts` rows and the Plane action aggregate over its
 * `plane_action_attempts` rows answer the same question, so on the same attempt
 * times and the same source reads they must agree at every point. And the source
 * half, over the real query the cycle-end re-verify gate runs, because that query
 * owns the wait's boundary and its multi-source rule. A second copy of the rule
 * in one aggregate shows up as a divergence here instead of staying invisible
 * until a failing start loops for five days.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AttemptHoldFacts, blockedUnrefreshedHold } from "../src/domain/attempt-hold.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import { choice, cleanup, fetched, sourceA, sourceB, success } from "./state/harness.ts";
import { sourceFiles } from "./static-checks.ts";

afterEach(cleanup);

const T5 = "github:github.com:I_5";
/** The time both fixtures land their attempt at. */
const ATTEMPT_AT = "2026-08-31T11:00:00Z";
const attemptMs = Date.parse(ATTEMPT_AT);

/** The facts with the hold's standing case: a failed attempt, no read since. */
function facts(over: Partial<AttemptHoldFacts> = {}): AttemptHoldFacts {
	return {
		latestAttempt: { outcome: "failed", at: ATTEMPT_AT },
		unreachedOutcome: "failed",
		unrefreshedSince: () => true,
		...over,
	};
}

describe("the blocked-and-unrefreshed rule (ADR 0077, ADR 0101)", () => {
	test("an attempt that never reached its work, and no source read since, holds", () => {
		expect(blockedUnrefreshedHold(facts())).toBe(true);
	});

	test("every active source read after the attempt releases the hold", () => {
		expect(blockedUnrefreshedHold(facts({ unrefreshedSince: () => false }))).toBe(false);
	});

	test("the wait is measured from the attempt's own time", () => {
		// The fact answers "does any active source still have no read after this
		// time", and the time it is asked for is the newest attempt's. The state
		// module hands it the attempt's outcome time, so a refresh that lands
		// before the failure is not the release (ADR 0101).
		const asked: string[] = [];
		expect(
			blockedUnrefreshedHold(
				facts({
					unrefreshedSince: (at) => {
						asked.push(at);
						return true;
					},
				}),
			),
		).toBe(true);
		expect(asked).toEqual([ATTEMPT_AT]);
	});

	test("the newest attempt decides, and only the unreached outcome holds", () => {
		// No attempt at all, and an attempt with no outcome yet, are both answered
		// the same way: nothing to wait out. The aggregate answers null for both.
		expect(blockedUnrefreshedHold(facts({ latestAttempt: null }))).toBe(false);
		// The Handoff's word and the Plane action's word belong to the caller:
		// each aggregate names the outcome that stands for its own start that
		// never reached its work.
		expect(
			blockedUnrefreshedHold(
				facts({ latestAttempt: { outcome: "agent-started", at: ATTEMPT_AT } }),
			),
		).toBe(false);
		expect(
			blockedUnrefreshedHold(
				facts({
					latestAttempt: { outcome: "blocked", at: ATTEMPT_AT },
					unreachedOutcome: "blocked",
				}),
			),
		).toBe(true);
		expect(
			blockedUnrefreshedHold(
				facts({
					latestAttempt: { outcome: "failed", at: ATTEMPT_AT },
					unreachedOutcome: "blocked",
				}),
			),
		).toBe(false);
	});
});

describe("the two holds read one rule (ADR 0077, ADR 0101)", () => {
	/**
	 * One Ticket with both kinds of attempt landed at 11:00: a Handoff whose
	 * Agent never started, and a Plane action the source blocked. The source's
	 * last read stands at 10:01 until the test re-reads it.
	 */
	function pairState() {
		const state = openFactoryState(":memory:", () => attemptMs);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const claim = state.handoff.claimHandoff(T5, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, false, "the worktree path already exists");
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "the pull request does not merge",
			at: ATTEMPT_AT,
		});
		return state;
	}

	const answers = (state: FactoryState): [boolean, boolean] => [
		state.handoff.handoffBlockedUnrefreshed(T5),
		state.planeAction.planeActionBlockedUnrefreshed(T5),
	];

	test("the Handoff hold and the Plane action hold answer the same way at every point", () => {
		const state = pairState();
		const rows: Array<[string, boolean, boolean]> = [];
		const read = (fetchedAt: string) => {
			state.sourceFact.applyFetch(sourceA, {
				status: "success",
				fetchedAt,
				tickets: [fetched()],
			});
			rows.push([fetchedAt, ...answers(state)]);
		};
		// The read the fixture already landed (10:01) stands before the attempts.
		rows.push(["no read yet", ...answers(state)]);
		read("2026-08-31T10:30:00Z");
		read(ATTEMPT_AT);
		read("2026-08-31T11:00:01Z");
		read("2026-08-31T11:30:00Z");
		state.close();
		expect(rows.map(([, handoff]) => handoff)).toEqual([true, true, false, false, false]);
		// Every row agrees: the two aggregates read one rule over their own rows.
		for (const [fetchedAt, handoff, planeAction] of rows)
			expect(planeAction, `the two holds disagree on the read at ${fetchedAt}`).toBe(handoff);
	});

	test("the read that lands at the attempt's own time is the release", () => {
		// The boundary the plane keeps, stated once because one query owns it: a
		// source read at the attempt's own instant counts as the read after it,
		// the same way the cycle-end re-verify gate counts it. The compare is on
		// the parsed instant, so a read written to the second and an attempt
		// written to the millisecond land on the same side of it.
		const state = pairState();
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:00:00Z",
			tickets: [fetched()],
		});
		expect(answers(state)).toEqual([false, false]);
		state.close();
	});

	test("one stale source out of several holds the re-ask", () => {
		// The wait is on the slowest active source, not on any one refresh: the
		// hold releases only when every active source has read after the attempt,
		// and each source keeps its own refresh interval (src/refresh.ts).
		const state = openFactoryState(":memory:", () => attemptMs);
		state.sourceFact.initializeSources([sourceA, sourceB]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.sourceFact.applyFetch(sourceB, success([fetched()]));
		const claim = state.handoff.claimHandoff(T5, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, false, "the worktree path already exists");
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "blocked",
			reason: "the pull request does not merge",
			at: ATTEMPT_AT,
		});
		expect(answers(state)).toEqual([true, true]);
		// The fast source re-reads; the slow one has not.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [fetched()],
		});
		expect(answers(state)).toEqual([true, true]);
		// The slow source re-reads: every active source has now read after the
		// attempt, and both holds release together.
		state.sourceFact.applyFetch(sourceB, {
			status: "success",
			fetchedAt: "2026-08-31T12:30:00Z",
			tickets: [fetched()],
		});
		expect(answers(state)).toEqual([false, false]);
		state.close();
	});

	test("a start that reached its Agent, and a merge that landed, hold nothing", () => {
		const state = pairState();
		const claim = state.handoff.claimHandoff(T5, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.planeAction.recordPlaneActionAttempt({
			ticketIdentity: T5,
			taskType: "merge",
			decision: "auto-merged",
			outcome: "merged",
			reason: "",
			at: "2026-08-31T11:20:00Z",
		});
		expect(answers(state)).toEqual([false, false]);
		state.close();
	});

	test("a Ticket the sources no longer list holds nothing in either aggregate", () => {
		const state = pairState();
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [],
		});
		expect(answers(state)).toEqual([false, false]);
		state.close();
	});

	test("both aggregates reach the rule through the shared module", () => {
		for (const file of ["src/state/handoff.ts", "src/state/plane-action.ts"]) {
			const text = readFileSync(file, "utf8");
			expect(text, file).toContain("blockedUnrefreshedHold({");
			// The source half is the shared query, the same one the cycle-end
			// re-verify gate runs. A hold that walked the source names itself would
			// be the second copy this check is here to catch.
			expect(text, file).toContain("hasUnrefreshedActiveMembershipSince");
		}
		// Tripwire, not proof: the agreement test above is what measures the rule.
		// The "unrefreshed since T" comparison stands in one query, and the newest
		// attempt's time is compared in one module.
		const offenders = sourceFiles("src").filter((file) => {
			const text = readFileSync(file, "utf8");
			return /latest\.at\s*[<>]/u.test(text) || /last_success\s*[<>]/u.test(text);
		});
		expect(offenders).toEqual([]);
	});
});
