/**
 * The blocked-and-unrefreshed rule both attempt holds read (ADR 0077 as extended
 * by ADR 0100, issue #217).
 *
 * Two things are measured here. The rule's own truth table, so the decision a
 * Ticket's newest attempt makes is testable without a cycle, an Agent, or a state
 * file. And the two readers against each other: the Handoff aggregate over its
 * `handoff_attempts` rows and the Plane action aggregate over its
 * `plane_action_attempts` rows answer the same question, so on the same attempt
 * times and the same source reads they must agree at every point. A second copy
 * of the rule in one aggregate shows up here as a divergence instead of staying
 * invisible until a failing start loops for five days.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AttemptHoldFacts, blockedUnrefreshedHold } from "../src/domain/attempt-hold.ts";
import { openFactoryState } from "../src/state.ts";
import { choice, cleanup, fetched, sourceA, success } from "./state/harness.ts";
import { sourceFiles } from "./static-checks.ts";

afterEach(cleanup);

const T5 = "github:github.com:I_5";
/** The time both fixtures land their attempt at. */
const ATTEMPT_AT = "2026-08-31T11:00:00Z";
const attemptMs = Date.parse(ATTEMPT_AT);

/** The facts with the hold's standing case: a failed attempt, a stale read. */
function facts(over: Partial<AttemptHoldFacts> = {}): AttemptHoldFacts {
	return {
		latestAttempt: { outcome: "failed", at: ATTEMPT_AT },
		unreachedOutcome: "failed",
		activeSourceNames: ["issues"],
		lastSourceRead: () => "2026-08-31T10:01:00Z",
		...over,
	};
}

describe("the blocked-and-unrefreshed rule (ADR 0077, ADR 0100)", () => {
	test("an attempt that never reached its work, and no read since, holds", () => {
		expect(blockedUnrefreshedHold(facts())).toBe(true);
		// A source that has never read at all cannot carry the move either.
		expect(blockedUnrefreshedHold(facts({ lastSourceRead: () => null }))).toBe(true);
	});

	test("one active source read after the attempt releases the hold", () => {
		expect(blockedUnrefreshedHold(facts({ lastSourceRead: () => "2026-08-31T11:30:00Z" }))).toBe(
			false,
		);
		// The read that lands at the attempt's own time is not a read after it.
		expect(blockedUnrefreshedHold(facts({ lastSourceRead: () => ATTEMPT_AT }))).toBe(false);
	});

	test("one stale source out of several holds the re-ask", () => {
		expect(
			blockedUnrefreshedHold(
				facts({
					activeSourceNames: ["issues", "pulls"],
					lastSourceRead: (name) => (name === "pulls" ? "2026-08-31T11:30:00Z" : null),
				}),
			),
		).toBe(true);
		expect(
			blockedUnrefreshedHold(
				facts({
					activeSourceNames: ["issues", "pulls"],
					lastSourceRead: () => "2026-08-31T11:30:00Z",
				}),
			),
		).toBe(false);
	});

	test("a Ticket with no active source holds nothing", () => {
		// No read can ever release the hold, and no automatic add stands on a
		// Ticket the sources no longer list.
		expect(blockedUnrefreshedHold(facts({ activeSourceNames: [] }))).toBe(false);
	});

	test("the newest attempt decides, and only the unreached outcome holds", () => {
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

describe("the two holds read one rule (ADR 0077, ADR 0100)", () => {
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

	test("the Handoff hold and the Plane action hold answer the same way at every point", () => {
		const state = pairState();
		const answers: Array<[string, boolean, boolean]> = [];
		const read = (fetchedAt: string) => {
			state.sourceFact.applyFetch(sourceA, {
				status: "success",
				fetchedAt,
				tickets: [fetched()],
			});
			answers.push([
				fetchedAt,
				state.handoff.handoffBlockedUnrefreshed(T5),
				state.planeAction.planeActionBlockedUnrefreshed(T5),
			]);
		};
		// The read the fixture already landed (10:01) stands before the attempts.
		answers.push([
			"no read yet",
			state.handoff.handoffBlockedUnrefreshed(T5),
			state.planeAction.planeActionBlockedUnrefreshed(T5),
		]);
		read("2026-08-31T10:30:00Z");
		read(ATTEMPT_AT);
		read("2026-08-31T11:00:01Z");
		read("2026-08-31T11:30:00Z");
		state.close();
		expect(answers.map(([, handoff]) => handoff)).toEqual([true, true, false, false, false]);
		// Every row agrees: the two aggregates read one rule over their own rows.
		for (const [fetchedAt, handoff, planeAction] of answers)
			expect(planeAction, `the two holds disagree on the read at ${fetchedAt}`).toBe(handoff);
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
		expect(state.handoff.handoffBlockedUnrefreshed(T5)).toBe(false);
		expect(state.planeAction.planeActionBlockedUnrefreshed(T5)).toBe(false);
		state.close();
	});

	test("a Ticket the sources no longer list holds nothing in either aggregate", () => {
		const state = pairState();
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [],
		});
		expect(state.handoff.handoffBlockedUnrefreshed(T5)).toBe(false);
		expect(state.planeAction.planeActionBlockedUnrefreshed(T5)).toBe(false);
		state.close();
	});

	test("both aggregates reach the rule through the shared module", () => {
		for (const file of ["src/state/handoff.ts", "src/state/plane-action.ts"]) {
			const text = readFileSync(file, "utf8");
			expect(text, file).toContain("blockedUnrefreshedHold({");
		}
		// The comparison the rule makes stands in one file. A second copy of it is
		// the drift the shared module exists to prevent.
		const offenders = sourceFiles("src").filter(
			(file) =>
				file !== "src/domain/attempt-hold.ts" &&
				(/=== null \|\| last </u.test(readFileSync(file, "utf8")) ||
					/latest\.at\s*[<>]/u.test(readFileSync(file, "utf8"))),
		);
		expect(offenders).toEqual([]);
	});
});
