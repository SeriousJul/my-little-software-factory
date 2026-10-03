/**
 * The routed Ticket's wait (ADR 0072), read through the aggregates that own
 * each half of it (issue #202, re-homed from the flat state suite): the ask
 * ends the cycle in the same write that lands the decision, the Ticket rests
 * open behind the queue item, the operator's removal takes the item and marks
 * the trace, and the pickup's start runs in the started Ticket's own cycle.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { TransitionOutcome } from "../../src/config.ts";
import { workQueueIdentityOf } from "../../src/state/work-queue.ts";
import { openFactoryState } from "../../src/state.ts";
import { choice, cleanup, fetched, sourceA, statePath, success, textLog } from "./harness.ts";

afterEach(cleanup);

describe("the routed Ticket's wait (ADR 0072)", () => {
	type State = ReturnType<typeof openFactoryState>;

	/** One Ticket with its turn settled, and the attempt the turn ran on. */
	function settledTurn(state: State, transition?: TransitionOutcome) {
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			transition,
		});
		return { identity: ticket.identity, attemptId: claim.claim.attemptId };
	}

	/** The settled turn's transition, routing to the named position. */
	function routeOutcome(positionIdentity: string): TransitionOutcome {
		return {
			fired: false,
			when: null,
			reason: "",
			ticketFacts: [],
			pullRequestFacts: [],
			ticketWrite: null,
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: "review",
			positionTicketIdentity: positionIdentity,
		};
	}

	/** The row the list holds for a Ticket, with the cycle number it carries. */
	const listed = (state: State, identity: string) =>
		state.ticketWorkCycle
			.ticketListViews([], "implement")
			.rows.find((t) => t.identity === identity);

	test("the route ask ends the cycle at the ask, and the re-confirm stands a no-op", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const { identity, attemptId } = settledTurn(state);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		// The decision lands and the cycle ends in the same write: the
		// ticket rests open with the cycle incremented, and the wait is the
		// item's, not a ticket state (ADR 0072).
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(listed(state, identity)?.workCycle).toBe(2);
		expect(state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("handed-off");
		// A re-confirm of a dead route re-lands the same decision as a no-op,
		// and the cycle number holds.
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:11:00Z",
			}),
		).toBe(false);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(listed(state, identity)?.workCycle).toBe(2);
		state.close();
	});

	test("the cross-position start runs in the started ticket's own cycle", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		// The source ended its cycle at the ask and rests open behind the
		// wait, so the start moves the started ticket alone.
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(listed(state, identity)?.workCycle).toBe(2);
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "settled the turn",
			}),
		).toEqual({ ok: true });
		const claim = state.handoff.claimHandoff("github:github.com:I_6", choice, "workflow");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			routeFromIdentity: identity,
		});
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("handed-off");
		const settled = listed(state, identity);
		if (settled === undefined) throw new Error("the settled ticket left the list");
		expect(settled.state).toBe("open");
		expect(settled.workCycle).toBe(2);
		expect(state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("handed-off");
		state.close();
	});

	test("the same-position start hands the open ticket off in its next cycle", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const { identity, attemptId } = settledTurn(state);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		// A route onto the ticket's own new position names itself, and the
		// normalization leaves its item without a route from. The start is
		// the ticket's next cycle, so it runs from the open state the ask
		// left.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: identity,
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "settled the turn",
			}),
		).toEqual({ ok: true });
		const waiting = state.workQueue.items()[0];
		if (waiting?.kind !== "handoff") throw new Error("the waiting item is not a handoff");
		expect(waiting.routeFromIdentity).toBe(null);
		const claim = state.handoff.claimHandoff(identity, choice, "workflow");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			routeFromIdentity: null,
		});
		const moved = listed(state, identity);
		if (moved === undefined) throw new Error("the ticket left the list");
		expect(moved.state).toBe("handed-off");
		expect(moved.workCycle).toBe(2);
		state.close();
	});

	test("the close of a routed ticket's position takes the route's item", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "settled the turn",
			}),
		).toEqual({ ok: true });
		expect(state.workQueue.items()).toHaveLength(1);
		// The position's own turn is the one the close runs on: the position
		// rests awaiting with no decision, and the close ends its cycle and
		// takes the item that waited on it. A closed cycle never leaves a
		// live start in the queue.
		const positionClaim = state.handoff.claimHandoff("github:github.com:I_6", choice, "open");
		if (!positionClaim.ok) throw new Error(positionClaim.reason);
		state.handoff.settleHandoff(positionClaim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: "github:github.com:I_6",
			handoffId: positionClaim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:20:00Z",
		});
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("awaiting");
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: "github:github.com:I_6",
				handoffId: positionClaim.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:30:00Z",
			}),
		).toBe(true);
		expect(state.workQueue.removeWorkflowRouteItem("github:github.com:I_6")).toBe(1);
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("open");
		expect(listed(state, "github:github.com:I_6")?.workCycle).toBe(2);
		expect(state.workQueue.items()).toHaveLength(0);
		state.close();
	});

	test("removeWorkflowRouteItem takes the route's item and leaves the open wait", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		// The ticket's own open-origin wait is not the route's item.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: identity,
				origin: "open",
				choice,
				previousMessage: "asked by hand",
			}),
		).toEqual({ ok: true });
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		expect(state.workQueue.items()).toHaveLength(2);
		expect(state.workQueue.removeWorkflowRouteItem(identity)).toBe(1);
		expect(state.workQueue.items()).toHaveLength(1);
		const waiting = state.workQueue.items()[0];
		if (waiting?.kind !== "handoff") throw new Error("the waiting item is not a handoff");
		expect(waiting.ticketIdentity).toBe(identity);
		expect(waiting.origin).toBe("open");
		state.close();
	});

	test("the cancel of the route's item takes the mark on the turn (ADR 0072)", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state, routeOutcome("github:github.com:I_6"));
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "settled the turn",
			}),
		).toEqual({ ok: true });
		// The operator removes the item: the row leaves, and the source's
		// trace takes the removal's mark, the way the re-fired skip's mark
		// stands. The source's cycle already ended at the ask, so the
		// removal takes the item alone, and the decision the ask recorded
		// stands on the trace.
		expect(state.workQueue.cancelWorkItem("github:github.com:I_6")).toBe(true);
		const settled = listed(state, identity);
		if (settled === undefined) throw new Error("the settled ticket left the list");
		expect(settled.state).toBe("open");
		expect(settled.workCycle).toBe(2);
		expect(state.workQueue.items()).toHaveLength(0);
		expect(state.ticketWorkCycle.lastCompletion(identity)?.decision).toBe("handed-off");
		expect(state.ticketWorkCycle.lastCompletion(identity)?.transition?.routeRemoved).toBe(true);
		// The cancelled start may enqueue again for its ticket.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: identity,
				origin: "open",
				choice,
				previousMessage: "asked by hand",
			}),
		).toEqual({ ok: true });
		expect(state.workQueue.items().map(workQueueIdentityOf)).toEqual([identity]);
		state.close();
	});

	test("the cancel marks the trace the item's decision answers, not a newer turn (ADR 0072)", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state, routeOutcome("github:github.com:I_6"));
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "auto-handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "the automatic route",
				automatic: true,
			}),
		).toEqual({ ok: true });
		// The source settles a new turn while the route's item waits: a
		// manual start on the source can do it, and the queue holds only the
		// automatic adds.
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The new turn is done.",
			turnLog: textLog("The new turn is done."),
			completedAt: "2026-08-31T12:00:00Z",
			transition: routeOutcome("github:github.com:I_6"),
		});
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
		// The operator removes the item: the mark stands on the trace the
		// item's decision answers - the turn that recorded the automatic
		// route - and the newer turn's trace keeps the removal off of it.
		expect(state.workQueue.cancelWorkItem("github:github.com:I_6")).toBe(true);
		const db = new Database(path, { readonly: true });
		const traces = db
			.prepare(
				"SELECT decision, transition_json FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC",
			)
			.all(identity) as Array<{ decision: string | null; transition_json: string | null }>;
		db.close();
		expect(traces).toHaveLength(2);
		// The newer turn's trace carries no mark: its route still stands for
		// the operator's decision.
		const [newer, older] = traces;
		expect(newer.decision).toBeNull();
		expect(
			newer.transition_json === null
				? undefined
				: (JSON.parse(newer.transition_json) as { routeRemoved?: boolean }).routeRemoved,
		).toBeUndefined();
		// The settled turn the item's decision answers carries the mark.
		expect(older.decision).toBe("auto-handed-off");
		expect(
			(JSON.parse(older.transition_json ?? "") as { routeRemoved?: boolean }).routeRemoved,
		).toBe(true);
		state.close();
	});

	test("a cancel takes the item alone when the row names no route (ADR 0072)", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state);
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		// The ticket's own open-origin wait stands beside the route's item
		// under the ticket's own name.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: identity,
				origin: "open",
				choice,
				previousMessage: "asked by hand",
			}),
		).toEqual({ ok: true });
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		// The operator removes the ticket's own wait: the row leaves, the
		// route's item stands, and no mark is written: the row named no
		// route, so the removal is the item's alone.
		expect(state.workQueue.cancelWorkItem(identity)).toBe(true);
		expect(state.workQueue.items()).toHaveLength(1);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(listed(state, identity)?.workCycle).toBe(2);
		expect(
			state.ticketWorkCycle.lastCompletion(identity)?.transition?.routeRemoved,
		).toBeUndefined();
		// A second cancel answers false and moves nothing.
		expect(state.workQueue.cancelWorkItem(identity)).toBe(false);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		state.close();
	});

	test("a cancel of a route whose turn already decided moves no cycle (ADR 0072)", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state, routeOutcome("github:github.com:I_6"));
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		// The close on the decided turn stands a no-op: the cycle already
		// ended at the ask, and the route's item stands until the cancel
		// takes it.
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:20:00Z",
			}),
		).toBe(false);
		expect(listed(state, identity)?.state).toBe("open");
		expect(listed(state, identity)?.workCycle).toBe(2);
		// The cancel that lands on the item after the move takes the row
		// and takes the mark on the turn's trace.
		expect(state.workQueue.cancelWorkItem("github:github.com:I_6")).toBe(true);
		expect(state.workQueue.items()).toHaveLength(0);
		expect(listed(state, identity)?.workCycle).toBe(2);
		expect(state.ticketWorkCycle.lastCompletion(identity)?.transition?.routeRemoved).toBe(true);
		state.close();
	});

	test("the cancel of the merge's item takes the item alone (ADR 0068, ADR 0072)", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// The merge's wait stands in the Work queue under the ticket's own
		// name, and the ticket keeps its open state behind it.
		expect(
			state.workQueue.enqueuePlaneActionWork({
				ticketIdentity: identity,
				origin: "open",
				taskType: "merge",
			}),
		).toEqual({ ok: true });
		// The operator removes the item: the row leaves, and the ticket
		// keeps the state it wears: the row named no route, so no mark is
		// written and no cycle moves.
		expect(state.workQueue.cancelWorkItem(identity)).toBe(true);
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(listed(state, identity)?.workCycle).toBe(1);
		expect(state.workQueue.items()).toHaveLength(0);
		state.close();
	});

	test("the cancel of the merge's item marks the route and leaves the source (ADR 0069, ADR 0072)", () => {
		const state = openFactoryState(statePath());
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		const { identity, attemptId } = settledTurn(state, routeOutcome("github:github.com:I_6"));
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attemptId,
				decision: "auto-merged",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		// The auto merge ends the source's cycle at the ask, the way the
		// auto route does.
		expect(state.ticketWorkCycle.ticketState(identity)).toBe("open");
		expect(listed(state, identity)?.workCycle).toBe(2);
		// The merge's item crosses to the fixing pull request's ticket:
		// its wait stands under that ticket's name, beside the source's
		// row.
		expect(
			state.workQueue.enqueuePlaneActionWork({
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: identity,
				origin: "workflow",
				taskType: "merge",
				automatic: true,
			}),
		).toEqual({ ok: true });
		// The operator removes the item: the row leaves, the merge's own
		// wait keeps the state it wears, and the source's trace takes the
		// removal's mark, the way the cancelled handoff route does.
		expect(state.workQueue.cancelWorkItem("github:github.com:I_6")).toBe(true);
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("open");
		expect(listed(state, "github:github.com:I_6")?.workCycle).toBe(1);
		const settled = listed(state, identity);
		if (settled === undefined) throw new Error("the settled ticket left the list");
		expect(settled.state).toBe("open");
		expect(settled.workCycle).toBe(2);
		expect(state.ticketWorkCycle.lastCompletion(identity)?.transition?.routeRemoved).toBe(true);
		expect(state.workQueue.items()).toHaveLength(0);
		state.close();
	});
});
