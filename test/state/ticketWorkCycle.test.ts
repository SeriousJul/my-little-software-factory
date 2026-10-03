/**
 * The ticketWorkCycle aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TransitionOutcome } from "../../src/config.ts";
import { SCHEMA_V1 } from "../../src/state/schema.ts";
import { openFactoryState } from "../../src/state.ts";
import {
	choice,
	cleanup,
	closedCycle,
	fetched,
	sourceA,
	sourceB,
	statePath,
	success,
	textLog,
} from "./harness.ts";

afterEach(cleanup);

describe("the ticketWorkCycle aggregate", () => {
	test("a settled turn rests in awaiting with a pending completion trace", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-7",
			tabId: "tab-7",
			workspaceId: "ws-7",
		});

		// The agent reports working, then settles the turn.
		expect(state.ticketWorkCycle.markTicketRunning(ticket.identity)).toBe(true);
		expect(state.ticketWorkCycle.markTicketRunning(ticket.identity)).toBe(false);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The work is done. Tests pass.",
			turnLog: textLog("The work is done. Tests pass."),
			completedAt: "2026-08-31T11:00:00Z",
		});

		const [rested] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(rested.state).toBe("awaiting");
		// The herdr handles the handoff started are stored on the ticket.
		expect(rested.handoff).toEqual(
			expect.objectContaining({
				agentType: "pi",
				environment: "worktree",
				taskType: "implement",
				paneId: "pane-7",
				tabId: "tab-7",
				workspaceId: "ws-7",
			}),
		);
		expect(rested.lastCompletion).toEqual(
			expect.objectContaining({
				taskType: "implement",
				agentType: "pi",
				message: "The work is done. Tests pass.",
				decision: null,
			}),
		);
		state.close();
	});
	test("the transition outcome the fire wrote is stored on the trace and reads back", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		const written: TransitionOutcome = {
			fired: true,
			when: "score-above-threshold",
			reason: "",
			ticketFacts: [],
			pullRequestFacts: ["ready-to-ship"],
			autoAdvance: true,
			agent: "codex",
			environment: "worktree",
			ticketWrite: null,
			pullRequestWrite: { added: ["ready-to-ship"], removed: ["ready-for-review"] },
			pullRequestIdentity: ticket.identity,
			pullRequestKey: "#5",
			writeFailure: "",
			positionTaskType: "merge",
			positionTicketIdentity: ticket.identity,
		};
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "- **Score:** 95 / 100",
			turnLog: textLog("- **Score:** 95 / 100"),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
			transition: written,
		});

		// The decision modal and the automatic decision read the facts the
		// plane wrote, not a re-read of the source (ADR 0027).
		expect(state.ticketWorkCycle.lastCompletion(ticket.identity)?.transition).toEqual(written);

		// A turn that settled with no fire stores null, and a stored record
		// that no longer parses fails open the same way a broken cause does.
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "second",
			turnLog: textLog("second"),
			completedAt: "2026-08-31T12:00:00Z",
		});
		expect(state.ticketWorkCycle.lastCompletion(ticket.identity)?.transition).toBeNull();
		state.close();
	});
	test("the manual re-fire swaps its outcome onto the trace it acted on (ADR 0054)", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		const recorded: TransitionOutcome = {
			fired: false,
			when: null,
			reason: "the pull request carries no review score",
			ticketFacts: [],
			pullRequestFacts: ["ready-to-ship"],
			autoAdvance: true,
			agent: undefined,
			environment: undefined,
			ticketWrite: null,
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: null,
			positionTicketIdentity: null,
		};
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "- **Score:** 97 / 100",
			turnLog: textLog("- **Score:** 97 / 100"),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
			transition: recorded,
		});

		// The stored text the swap conditions on is the outcome's own bytes.
		const recordedJson = state.ticketWorkCycle.recordedTransitionJson(ticket.identity);
		expect(recordedJson).toBe(JSON.stringify(recorded));

		// The re-fired outcome lands in place of the recorded one.
		const refired: TransitionOutcome = { ...recorded, fired: true, reason: "", writeFailure: "" };
		expect(
			state.ticketWorkCycle.recordRefiredOutcome(ticket.identity, recordedJson ?? "", refired),
		).toBe(true);
		expect(state.ticketWorkCycle.lastCompletion(ticket.identity)?.transition).toEqual(refired);

		// The swap declines once the trace stands on other text: a second
		// re-fire on the moved record, and a trace a new settle moved.
		expect(
			state.ticketWorkCycle.recordRefiredOutcome(ticket.identity, recordedJson ?? "", recorded),
		).toBe(false);
		expect(state.ticketWorkCycle.lastCompletion(ticket.identity)?.transition).toEqual(refired);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "a later turn",
			turnLog: textLog("a later turn"),
			completedAt: "2026-08-31T12:00:00Z",
		});
		expect(
			state.ticketWorkCycle.recordRefiredOutcome(ticket.identity, recordedJson ?? "", refired),
		).toBe(false);

		// A ticket whose newest trace records no outcome reads null, and no
		// swap stands on it.
		expect(state.ticketWorkCycle.recordedTransitionJson(ticket.identity)).toBeNull();
		expect(
			state.ticketWorkCycle.recordRefiredOutcome(ticket.identity, recordedJson ?? "", refired),
		).toBe(false);
		state.close();
	});
	test("records the model, thinking level, and context window of the settled handoff", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(
			ticket.identity,
			{ ...choice, model: "gpt-5.6", thinking: "high", contextWindow: "272000" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});

		expect(state.ticketWorkCycle.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({
				model: "gpt-5.6",
				thinking: "high",
				contextWindow: "272000",
			}),
		);
		state.close();
	});
	test("a second settle of the same turn refreshes the trace instead of adding one", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "First capture.",
			turnLog: textLog("First capture."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Last capture.",
			turnLog: textLog("Last capture."),
			completedAt: "2026-08-31T11:05:00Z",
		});

		const [rested] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(rested.lastCompletion?.message).toBe("Last capture.");
		const traceCount = new Database(path)
			.prepare("SELECT COUNT(*) AS n FROM completion_traces WHERE ticket_identity = ?")
			.get(ticket.identity) as { n: number };
		expect(traceCount.n).toBe(1);
		state.close();
	});
	test("the route ask ends the cycle, and a close on the decided turn stands a no-op", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		if (ticket === undefined) throw new Error("the fixture holds no ticket");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		// The route decides the turn when the route is asked for: the decision
		// lands and the cycle ends in the same write, the ticket leaving
		// awaiting for open with the cycle incremented (ADR 0072).
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(state.ticketWorkCycle.visibleTickets([], "implement")[0].state).toBe("open");
		expect(state.ticketWorkCycle.visibleTickets([], "implement")[0].workCycle).toBe(2);
		// The turn is decided, so a close on it rewrites nothing and ends
		// nothing: the cycle already ended at the ask, and the recorded
		// decision stands.
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:30:00Z",
			}),
		).toBe(false);
		const [returned] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		expect(returned.workCycle).toBe(2);
		expect(returned.lastCompletion?.decision).toBe("handed-off");
		state.close();
	});
	test("the auto close on a turn the auto route decided stands a no-op", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		if (ticket === undefined) throw new Error("the fixture holds no ticket");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		// The auto route ends the cycle at the ask (ADR 0072), and a close on
		// the decided turn rewrites nothing: the recorded decision stands, and
		// the cycle already ended.
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "auto-handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "auto-closed",
				decidedAt: "2026-08-31T11:30:00Z",
			}),
		).toBe(false);
		const [returned] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		expect(returned.workCycle).toBe(2);
		expect(returned.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});
	test("an in-flight close ends the cycle and writes no completion trace (ADR 0031)", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("handed-off");

		expect(state.ticketWorkCycle.closeWorkCycle(identity)).toBe(true);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		// The cycle the close ended counts like any other cycle end.
		expect(ticket.workCycle).toBe(2);
		expect(ticket.handoffCount).toBe(1);
		// And no completion trace exists: the turn never settled, so the handoff
		// row is the only record the closed cycle leaves.
		expect(state.ticketWorkCycle.lastCompletion(identity)).toBe(null);
		state.close();
		const stored = new Database(path)
			.prepare("SELECT COUNT(*) AS count FROM completion_traces")
			.get() as { count: number };
		expect(stored).toEqual({ count: 0 });
	});
	test("an in-flight close moves nothing on an open or awaiting ticket", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// An open ticket holds no work to close.
		expect(state.ticketWorkCycle.closeWorkCycle(identity)).toBe(false);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");

		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		// A settled turn closes through its decision, not through this move.
		expect(state.ticketWorkCycle.closeWorkCycle(identity)).toBe(false);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
		expect(state.ticketWorkCycle.visibleTickets([], "implement")[0].workCycle).toBe(1);
		state.close();
	});
	test("only a cycle end moves the work cycle, the fact the gates count on (ADR 0031)", () => {
		// `lastCycleEnd` reads the end row of `work_cycle - 1`, so the two gates
		// name the newest ended cycle exactly. That holds only while nothing else
		// moves the number: a migration or an import path that raised a ticket's
		// `work_cycle` would silently point both gates at the wrong row, and no
		// other check reads this file's SQL. The check is on the statements, so a
		// new move must be a cycle end or must answer here first.
		//
		// The read takes each statement's own quoted text, never the whole line
		// that holds it. A tool that rewrites the source around a literal - the
		// mutation runner's instrumentation wraps an expression in a call, and
		// the suite runs under that instrumented copy - must not change what the
		// file states.
		const statements = [
			...readFileSync("src/state/ticket-work-cycle.ts", "utf8").matchAll(
				/"UPDATE tickets SET[^"]*work_cycle[^"]*"/gu,
			),
			...readFileSync("src/state/schema.ts", "utf8").matchAll(
				/"UPDATE tickets SET[^"]*work_cycle[^"]*"/gu,
			),
		].map((match) => match[0]);
		// The ends: the route's ask that ends the settled turn's cycle in the
		// same write that lands the decision, guarded on awaiting (ADR 0072),
		// the decided close of a settled turn, guarded on awaiting, the
		// abandoned close that writes no trace, and the in-flight Close that
		// writes no trace. The heal-at-open migration of a file still carrying
		// the retired state stands alone on the state gate (ADR 0072).
		expect([...new Set(statements)].sort()).toEqual([
			"\"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ? AND state = 'awaiting'\"",
			"\"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ?\"",
			"\"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE state = 'queued'\"",
		]);
		expect(statements.length).toBe(5);
		// A cycle's moves that end nothing hold the number: the handoff that starts
		// a cycle, the running mark, a settled turn, and a reclaimed handoff.
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const cycleOf = () => state.ticketWorkCycle.visibleTickets([], "implement")[0].workCycle;
		expect(cycleOf()).toBe(1);
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			agentName: "agent-one",
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(state.ticketWorkCycle.markTicketRunning(identity)).toBe(true);
		expect(cycleOf()).toBe(1);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		expect(cycleOf()).toBe(1);
		// A reclaim of the same agent holds the number too: the cycle it lands in
		// is the one it works in.
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		expect(cycleOf()).toBe(2);
		const reclaimed = state.handoff.reclaimHandoff(identity, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			// The same agent the handoff started, still under the name it runs.
			agentName: "agent-one",
		});
		expect(reclaimed).not.toBeNull();
		expect(cycleOf()).toBe(2);
		state.close();
	});
	test("the cycle-end gates read an in-flight close as holding nothing (ADR 0031)", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// Cycle 1: a completed turn, closed by decision. That end arms the
		// re-verify gate and the Same-type hold for the suggestion.
		const first = state.handoff.claimHandoff(identity, choice, "open");
		if (!first.ok) throw new Error(first.reason);
		state.handoff.settleHandoff(first.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		expect(state.ticketWorkCycle.sourceReverifiedSinceCycleEnd(identity)).toBe(false);
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "implement")).toBe(true);
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});

		// Cycle 2: the agent never settles, and the operator closes it over key
		// `w`. That end writes no row, so it holds nothing and re-verifies
		// nothing: neither gate falls back to cycle 1's finished turn.
		const second = state.handoff.claimHandoff(identity, choice, "open");
		if (!second.ok) throw new Error(second.reason);
		state.handoff.settleHandoff(second.claim.attemptId, true);
		expect(state.ticketWorkCycle.closeWorkCycle(identity)).toBe(true);
		expect(state.ticketWorkCycle.sourceReverifiedSinceCycleEnd(identity)).toBe(true);
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "implement")).toBe(false);
		// A manual handoff passes both gates either way, and the next cycle
		// starts on the fact the in-flight close left: none.
		const third = state.handoff.claimHandoff(identity, choice, "open");
		expect(third.ok).toBe(true);
		state.close();
	});
	test("the re-verification reads the latest end decision against every listing source", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA, sourceB]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.sourceFact.applyFetch(sourceB, success([fetched()]));
		const identity = "github:github.com:I_5";
		// A ticket whose cycle has never ended is verified.
		expect(state.ticketWorkCycle.sourceReverifiedSinceCycleEnd(identity)).toBe(true);

		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "auto-closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		// The close outlives both sources' last reads: the ticket is not
		// verified, even though both sources still list it and are healthy.
		expect(state.ticketWorkCycle.sourceReverifiedSinceCycleEnd(identity)).toBe(false);

		// One source re-reads; the other's listing still stands on the stale
		// fetch, and the ticket is not verified on a mixed view.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});
		expect(state.ticketWorkCycle.sourceReverifiedSinceCycleEnd(identity)).toBe(false);

		// The second source re-reads, and the ticket is verified again.
		state.sourceFact.applyFetch(sourceB, {
			status: "success",
			fetchedAt: "2026-08-31T11:32:00Z",
			tickets: [fetched()],
		});
		expect(state.ticketWorkCycle.sourceReverifiedSinceCycleEnd(identity)).toBe(true);
		state.close();
	});
	test("the same-type hold reads the newest cycle end against the suggestion", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// A ticket whose cycle has never ended holds nothing.
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "implement")).toBe(false);

		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "auto-closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		// The closed cycle completed implement, and the ticket still suggests
		// it: the hold is on.
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "implement")).toBe(true);
		// The suggestion moved - the label flipped, a new kind of work - and
		// the hold is off.
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "review")).toBe(false);

		// The hold gates the auto-handoff, not the operator: a manual claim
		// passes it while the hold is on.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});
		const manual = state.handoff.claimHandoff(identity, choice, "open");
		expect(manual.ok).toBe(true);
		if (!manual.ok) return;
		state.handoff.settleHandoff(manual.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: manual.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The agent stopped.",
			turnLog: textLog("The agent stopped."),
			completedAt: "2026-08-31T11:35:00Z",
			cause: "aborted",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: manual.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:40:00Z",
		});
		// The newest cycle end is a closed cycle after an aborted turn: the
		// work did not finish, and the hold is off for the same suggestion.
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "implement")).toBe(false);

		// The newest cycle end wins: a later completed cycle re-arms the
		// hold over the aborted one it outlives.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:41:00Z",
			tickets: [fetched()],
		});
		const third = state.handoff.claimHandoff(identity, choice, "open");
		if (!third.ok) throw new Error(third.reason);
		state.handoff.settleHandoff(third.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: third.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done again.",
			turnLog: textLog("Done again."),
			completedAt: "2026-08-31T11:45:00Z",
			cause: "completed",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: third.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:50:00Z",
		});
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "implement")).toBe(true);

		// An abandon whose turn never settled writes its own row without a
		// cause, and the newest cycle end holds nothing.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:51:00Z",
			tickets: [fetched()],
		});
		const fourth = state.handoff.claimHandoff(identity, choice, "open");
		if (!fourth.ok) throw new Error(fourth.reason);
		state.handoff.settleHandoff(fourth.claim.attemptId, true);
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: fourth.claim.attemptId,
			decision: "abandoned",
			decidedAt: "2026-08-31T11:55:00Z",
		});
		expect(state.ticketWorkCycle.sameTypeHoldActive(identity, "implement")).toBe(false);
		state.close();
	});
	test("an abandoned decision ends the work cycle too", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Lost.",
			turnLog: textLog("Lost."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			decision: "abandoned",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		const [returned] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		state.close();
	});
	test("a v1 database migrates to v2: done becomes awaiting and the traces table appears", () => {
		const path = statePath();
		const db = new Database(path);
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(SCHEMA_V1);
		db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
		db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
		db.prepare(
			"INSERT INTO source_health VALUES ('issues', 'github-issues', 'healthy', NULL, '2026-08-31T09:00:00Z')",
		).run();
		db.prepare("INSERT INTO tickets VALUES ('github:github.com:I_5', 'done', 1, 0)").run();
		db.prepare(
			"INSERT INTO memberships (" +
				"source_name, ticket_identity, active, source_kind, external_key, source_state, url, " +
				"title, description, labels_json, external_updated_at, repository_identity, " +
				"repository_display_name, repository_clone_url, attributes_json) " +
				"VALUES ('issues', 'github:github.com:I_5', 1, 'github-issue', '#5', 'open', " +
				"'https://github.com/acme/billing/issues/5', 'Persist source facts', 'Persist them.', " +
				"'[]', '2026-08-31T09:00:00Z', 'acme/billing', 'acme/billing', " +
				"'https://github.com/acme/billing.git', '{}')",
		).run();
		db.close();

		const state = openFactoryState(path);
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(ticket).toEqual(expect.objectContaining({ state: "awaiting" }));
		const tables = new Database(path)
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>;
		expect(tables.map((t) => t.name)).toContain("completion_traces");
		state.close();
	});
	test("a settled turn stores its log and a re-settle refreshes it in place", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "first capture",
			turnLog: [{ kind: "text", text: "first capture" }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		// The agent works again and settles the same turn: the log refreshes.
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "final text",
			turnLog: [
				{ kind: "tool", name: "bash", target: "npm test", failed: false },
				{ kind: "text", text: "final text" },
			],
			completedAt: "2026-08-31T11:05:00Z",
		});
		expect(state.ticketWorkCycle.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({
				message: "final text",
				turnLog: [
					{ kind: "tool", name: "bash", target: "npm test", failed: false },
					{ kind: "text", text: "final text" },
				],
				decision: null,
			}),
		);
		state.close();
	});
	test("a reclaim runs the ticket in a new handoff of its current cycle", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		closedCycle(state, identity);
		const claimed = state.handoff.reclaimHandoff(identity, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			agentName: "persist-source-facts",
		});
		expect(claimed).toEqual({ attemptId: expect.any(String) });
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([
			expect.objectContaining({
				ticketIdentity: identity,
				workCycle: 2,
				taskType: "implement",
				agentType: "pi",
				paneId: "pane-1",
				handoffAttemptId: claimed?.attemptId,
			}),
		]);
		// The reclaimed handoff copies the previous handoff's choices, and the
		// closed cycle keeps its handoff and its decided trace.
		expect(state.handoff.handoffCount(identity)).toBe(2);
		expect(state.ticketWorkCycle.visibleTickets([], "implement")[0]).toEqual(
			expect.objectContaining({
				state: "running",
				handoff: expect.objectContaining({ attemptId: claimed?.attemptId, taskType: "implement" }),
				lastCompletion: expect.objectContaining({
					decision: "closed",
					completedAt: "2026-08-31T10:02:00Z",
				}),
			}),
		);
		// The closed cycle's trace stays decided and is not rewritten.
		expect(state.ticketWorkCycle.lastCompletion(identity)).toEqual(
			expect.objectContaining({ decision: "closed", completedAt: "2026-08-31T10:02:00Z" }),
		);
		state.close();
	});
});
