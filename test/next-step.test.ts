/**
 * The Next step derivation (ADR 0092) measured at its own interface.
 *
 * `deriveNextStep` is the one fact Auto-handoff mode decides a settled turn
 * from, and the one place its gates are read. Every test here calls it
 * directly: the no-step cases, each of the four gates, and the channel choice,
 * so a changed gate branch meets a test that names the gate instead of a test
 * that only notices the route is missing.
 */
import { describe, expect, test } from "bun:test";

import type { FactoryConfig, TransitionOutcome } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import {
	deriveNextStep,
	NEXT_STEP_GATE_LINES,
	NEXT_STEP_GATES,
	type NextStepGate,
} from "../src/workflow.ts";
import { BASE_CONFIG } from "./base-config.ts";

const source = { name: "issues", kind: "github-issues" };
const position = "github:github.com:I_5";

/**
 * The config the derivation reasons about. The labels name the positions:
 * `ready-for-review` offers the review Handoff, `ready-to-merge` offers the
 * merge Plane action, and `parked` is a parking State that offers no task.
 */
const config: FactoryConfig = {
	...BASE_CONFIG,
	taskTypes: {
		implement: { template: "implement" },
		review: { template: "review" },
		merge: { action: "merge-pull-request" },
	},
	maxHandoffsPerTicket: 2,
	workflowStates: [
		{ name: "review-state", taskType: "review", match: { labelsAny: ["ready-for-review"] } },
		{ name: "merge-state", taskType: "merge", match: { labelsAny: ["ready-to-merge"] } },
		{ name: "parking-state", match: { labelsAny: ["parked"] } },
	],
};

const choice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "review",
	model: "",
	thinking: "",
	contextWindow: "",
};

function fetched(
	identity = position,
	labels: readonly string[] = ["ready-for-review"],
): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: `#${identity.split("I_")[1]}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${identity.split("I_")[1]}`,
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: [...labels],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

function stateWith(...tickets: FetchedTicket[]): FactoryState {
	const state = openFactoryState(":memory:", () => Date.parse("2026-08-31T10:00:00Z"));
	state.initializeSources([source]);
	state.applyFetch(source, {
		status: "success",
		fetchedAt: "2026-08-31T10:01:00Z",
		tickets: tickets.length === 0 ? [fetched()] : tickets,
	});
	return state;
}

/** The projection the derivation reads, the way every caller hands it down. */
function projection(state: FactoryState) {
	return state.projectedTickets(config.workflowStates, config.defaultTaskType);
}

/** The outcome a settled turn's Transition left: fired, with its position. */
function fired(over: Partial<TransitionOutcome> = {}): TransitionOutcome {
	return {
		fired: true,
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
		positionTicketIdentity: position,
		...over,
	};
}

function stepFor(state: FactoryState, over: Partial<TransitionOutcome> = {}) {
	return deriveNextStep(config, state, fired(over), projection(state));
}

/** Claim the position's handoff and land its start: the position holds a seat. */
function startTurn(state: FactoryState, taskType: string): string {
	const claim = state.claimHandoff(position, { ...choice, taskType }, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	return claim.claim.attemptId;
}

/** Run one cycle's worth of handoff work on the position, and settle its turn. */
function runTurn(
	state: FactoryState,
	taskType: string,
	cause: "completed" | "aborted",
	decision: "closed" | null,
): void {
	const attemptId = startTurn(state, taskType);
	state.settleTurn({
		ticketIdentity: position,
		handoffId: attemptId,
		taskType,
		agentType: "pi",
		message: "settled the turn",
		turnLog: [{ kind: "text", text: "settled the turn" }],
		completedAt: "2026-08-31T11:00:00Z",
		cause,
	});
	if (decision !== null) {
		state.applyCompletionDecision({
			ticketIdentity: position,
			handoffId: attemptId,
			decision,
			decidedAt: "2026-08-31T11:00:30Z",
		});
	}
}

describe("deriveNextStep (ADR 0092)", () => {
	test("a settled turn's fired Transition gives it a Next step on its position", () => {
		const state = stateWith();
		expect(stepFor(state)).toEqual({
			taskType: "review",
			ticketIdentity: position,
			kind: "handoff",
			gate: null,
		});
		state.close();
	});

	test("the step names the Plane action channel for a task type in the action form", () => {
		// The same derivation, on a position whose State offers the merge: the
		// channel is the task type's own form (ADR 0068), not a fact the reader
		// re-derives from the row.
		const state = stateWith(fetched(position, ["ready-to-merge"]));
		expect(stepFor(state, { positionTaskType: "merge" })).toEqual({
			taskType: "merge",
			ticketIdentity: position,
			kind: "plane-action",
			gate: null,
		});
		state.close();
	});

	test("a fire that did not run derives no Next step", () => {
		const state = stateWith();
		expect(stepFor(state, { fired: false, reason: "no branch held" })).toBeNull();
		state.close();
	});

	test("a fire whose label write failed derives no Next step", () => {
		// The machine does not route from labels it did not write, and the turn
		// parks for the operator rather than closing.
		const state = stateWith();
		expect(stepFor(state, { writeFailure: "the label write was refused" })).toBeNull();
		state.close();
	});

	test("a fire that lands on a parking state derives no Next step", () => {
		// The State the facts landed on offers no task, so the fire names no
		// position, and the cycle ends where the machine put the ticket.
		const state = stateWith(fetched(position, ["parked"]));
		expect(stepFor(state, { positionTaskType: null, positionTicketIdentity: null })).toBeNull();
		state.close();
	});

	test("a position that no longer offers the task holds the step", () => {
		// The write landed and the source has not re-read the ticket: the row
		// still wears the labels that offer something else, so the derived
		// position is not the position the projection stands on.
		const state = stateWith(fetched(position, ["ready-for-agent"]));
		expect(stepFor(state)?.gate).toBe("position-offers-no-task");
		state.close();
	});

	test("a position the projection does not hold holds the step", () => {
		// The ticket left its source between the write and the read: the step
		// names a row no projection answers.
		const state = stateWith(fetched("github:github.com:I_9"));
		expect(stepFor(state)?.gate).toBe("position-offers-no-task");
		state.close();
	});

	test("a position that holds a seat holds the step", () => {
		// The start landed and no turn settled: the position is in flight, and an
		// in-flight row holds no second start.
		const state = stateWith();
		startTurn(state, "implement");
		expect(projection(state).find((ticket) => ticket.identity === position)?.state).toBe(
			"handed-off",
		);
		expect(stepFor(state)?.gate).toBe("position-not-actionable");
		state.close();
	});

	test("an awaiting position is the settled turn's own row, not a gate", () => {
		// The settled turn's own position: the row is the ticket the machine is
		// deciding, and its standing belongs to the ask, not to the open ticket's
		// health, so the gate stands clear of it.
		const state = stateWith();
		runTurn(state, "implement", "completed", null);
		expect(state.ticketState(position)).toBe("awaiting");
		expect(stepFor(state)?.gate).toBeNull();
		state.close();
	});

	test("a position with an unfinished attempt holds the step", () => {
		// Claimed and never settled: the projection folds the attempt into the
		// open row's actionable fact, and the standing gate reads that fact.
		const state = stateWith();
		const claim = state.claimHandoff(position, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		expect(projection(state).find((ticket) => ticket.identity === position)?.actionable).toBe(
			false,
		);
		expect(stepFor(state)?.gate).toBe("position-not-actionable");
		state.close();
	});

	test("a position under the Same-type hold holds the step", () => {
		// The position's newest closed cycle completed the very task it still
		// suggests by labels no refresh has moved.
		const state = stateWith();
		runTurn(state, "review", "completed", "closed");
		state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:01:00Z",
			tickets: [fetched(position, ["ready-for-review"])],
		});
		expect(state.sameTypeHoldActive(position, "review")).toBe(true);
		expect(stepFor(state)?.gate).toBe("same-type-hold");
		state.close();
	});

	test("a position at the Handoff limit holds the step", () => {
		// The limit counts the position's own starts, not the settled ticket's.
		const state = stateWith();
		for (const cause of ["aborted", "aborted"] as const) {
			runTurn(state, "implement", cause, "closed");
			state.applyFetch(source, {
				status: "success",
				fetchedAt: "2026-08-31T11:02:00Z",
				tickets: [fetched(position, ["ready-for-review"])],
			});
		}
		expect(state.handoffCount(position)).toBe(config.maxHandoffsPerTicket);
		expect(stepFor(state)?.gate).toBe("handoff-limit");
		state.close();
	});

	test("every gate has the line the Decision screen states", () => {
		// The four gates are the four holds the screen can name; a gate added
		// without a line, or a line reworded, fails here.
		expect(NEXT_STEP_GATES).toEqual([
			"position-offers-no-task",
			"position-not-actionable",
			"same-type-hold",
			"handoff-limit",
		]);
		const lines = NEXT_STEP_GATES.map((gate: NextStepGate) => NEXT_STEP_GATE_LINES[gate]);
		expect(lines).toEqual([
			"the position no longer offers the task",
			"the position is not actionable",
			"the Same-type hold stands on the position",
			"the position is at the handoff limit",
		]);
		expect(new Set(lines).size).toBe(NEXT_STEP_GATES.length);
	});
});
