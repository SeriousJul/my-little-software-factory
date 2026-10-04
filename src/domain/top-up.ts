/**
 * The auto top-up's gate rules (ADR 0051, ADR 0088).
 *
 * The walk that adds one item to an empty Work queue lives in the observation
 * loop, because the add it makes is a call to the dispatch and the facts it
 * reads come from the state module. Every decision the walk makes on facts it
 * already holds lives here: a rule that takes its facts and answers yes or no,
 * so a test measures the decision without a cycle, an Agent, or a state file
 * (issue #202 review).
 *
 * The walk keeps the reads, and it keeps them in two shapes (issue #202 review).
 * The open-ticket walk asks for a fact only when the waits before it leave the
 * candidate standing, so a row an earlier wait holds out costs no statement, and
 * the row gate answers on the facts the row already carries. The restart walk
 * holds no row - the in-flight read gives it an identity, a pane, and a start
 * time - so its per-Ticket facts come as one batched read for the whole
 * in-flight list: the start counts from the Handoff aggregate, and the queue's
 * items the cycle gate already read. Neither walk asks a fact per candidate.
 * The rules decide; the walk decides nothing.
 */

import { handoffLimitReached, type TicketState } from "./ticket.ts";

/**
 * The fact an automatic walk acted on when it added nothing (issue #223).
 *
 * Every one of these holds the walk out before it asks for a candidate, so the
 * run shows nothing but the start that never came. Each reason names itself in
 * the plane's record, so a reviewer can tell a correct hold from a broken one.
 * The reasons are the walk's own gates, in the order the walk reads them.
 */
export const AUTOMATIC_HOLD_REASONS = [
	"auto-handoff-off",
	"queue-paused",
	"dispatch-pause",
	"continuation-standing",
	"queue-row-standing",
] as const;

export type AutomaticHoldReason = (typeof AUTOMATIC_HOLD_REASONS)[number];

/**
 * The sentence each hold is stated in.
 *
 * The module that owns the gates owns the words for them, the way
 * `NEXT_STEP_GATE_LINES` does for a gated Next step, so the walk states its
 * hold in one wording and no surface restates it.
 */
export const AUTOMATIC_HOLD_LINES: Readonly<Record<AutomaticHoldReason, string>> = {
	"auto-handoff-off": "automatic walks hold: auto-handoff is off",
	"queue-paused": "automatic walks hold: the Work queue is paused",
	"dispatch-pause": "automatic walks hold: a failed turn waits for the operator",
	"continuation-standing": "automatic walks hold: the Work queue already holds a continuation",
	"queue-row-standing": "automatic walks hold: the Work queue holds a waiting row",
};

/** The gates every automatic add reads (ADR 0051, ADR 0052, ADR 0016). */
export interface AutomaticAddFacts {
	/** Auto-handoff mode is on. */
	modeOn: boolean;
	/** The operator's queue pause stands (ADR 0052). */
	queuePaused: boolean;
	/** A held failed turn holds new automatic work (ADR 0016). */
	dispatchPauseActive: boolean;
}

/** The facts the fresh-work walk asks before it looks for a candidate at all. */
export interface TopUpCycleFacts extends AutomaticAddFacts {
	/** How many items the queue holds. The fresh-work add enters an empty queue. */
	queueDepth: number;
}

/**
 * Which of the cycle's standing gates holds every automatic add, or null when
 * none does: the mode is off, the brake is on, or a held turn stands undecided.
 * In every one of those the walk reads no candidate and adds nothing, and the
 * reason it names is the fact the record states (issue #223).
 *
 * The order is the walk's own: the first gate that stands is the fact the cycle
 * acted on, so one hold is stated and not three.
 */
export function automaticAddsHold(facts: AutomaticAddFacts): AutomaticHoldReason | null {
	if (!facts.modeOn) return "auto-handoff-off";
	if (facts.queuePaused) return "queue-paused";
	if (facts.dispatchPauseActive) return "dispatch-pause";
	return null;
}

/**
 * The hold the fresh-work adds stand under: the gates every automatic add reads,
 * then the queue's own depth (ADR 0051). null means the walk may add.
 *
 * The continuation add reads the same gates and its own queue rule instead,
 * because ADR 0094 lets it enter ahead of a standing fresh-work row.
 */
export function freshWorkHold(facts: TopUpCycleFacts): AutomaticHoldReason | null {
	const gate = automaticAddsHold(facts);
	if (gate !== null) return gate;
	if (facts.queueDepth > 0) return "queue-row-standing";
	return null;
}

/**
 * Whether the fresh-work add may enter: the cycle's gates, and a queue with no
 * row in it (ADR 0051).
 */
export function topUpCycleOpen(facts: TopUpCycleFacts): boolean {
	return freshWorkHold(facts) === null;
}

/** One row the Work queue holds, as the continuation's gate reads it (ADR 0094, ADR 0100). */
export interface ContinuationRowFacts {
	/** The row is a continuation the queue already holds. */
	continuation: boolean;
}

/**
 * Whether the queue holds a row the continuation add must not jump (ADR 0051,
 * ADR 0094, ADR 0100): one continuation per cycle is the queue's own pace, so a
 * continuation already standing holds the next one out. Nothing else does. A
 * standing fresh-work row is outranked by ADR 0094, and a row the operator
 * staged is a standing row of the same kind: the seat a settling turn freed
 * belongs to that turn's own next step, and the operator's row waits for the
 * next seat. The operator keeps the queue pause and the force-dispatch.
 */
export function continuationQueueHolds(rows: readonly ContinuationRowFacts[]): boolean {
	return rows.some((row) => row.continuation);
}

/** The facts the restart walk reads for one in-flight Ticket (ADR 0051, ADR 0060, ADR 0070). */
export interface RestartCandidateFacts {
	/** The Ticket or its source carries the ignore flag. */
	ignoreBlocked: boolean;
	/** The handoff has stood longer than the startup grace. */
	pastStartupGrace: boolean;
	/** The ticket names the pane its Agent ran in. */
	hasPane: boolean;
	/** That pane holds no Agent of this ticket. */
	agentMissing: boolean;
	handoffCount: number;
	handoffLimit: number;
	/** The queue already holds an item for this ticket. */
	queueItemStands: boolean;
	/** This episode's restart mark stands: the asked-for start holds its place or runs. */
	restartMarkStands: boolean;
}

/**
 * Whether this in-flight Ticket is the restart candidate: the flag is out, the
 * grace has passed, the Agent is missing, the loop guard leaves room, no item
 * or mark already stands for it.
 */
export function restartCandidateHolds(facts: RestartCandidateFacts): boolean {
	return (
		!facts.ignoreBlocked &&
		facts.pastStartupGrace &&
		facts.hasPane &&
		facts.agentMissing &&
		!handoffLimitReached(facts.handoffCount, facts.handoffLimit) &&
		!facts.queueItemStands &&
		!facts.restartMarkStands
	);
}

/** The facts the open-ticket add reads off the row it holds (ADR 0051, ADR 0060, ADR 0027). */
export interface OpenTicketRowFacts {
	/** The row's own state on the walk's view. */
	state: TicketState;
	actionable: boolean;
	ignoreBlocked: boolean;
	handoffCount: number;
	handoffLimit: number;
	/** The task the row's labels suggest; a parking state suggests none. */
	taskType: string | null;
}

/**
 * The row gate's answer: the row stands for the add, together with the task it
 * offers, or it does not. The task type is part of the answer so the walk never
 * tests it twice.
 */
export type OpenTicketRowGate = { stands: true; taskType: string } | { stands: false };

/**
 * Whether the row the walk holds stands on its own facts: an open actionable
 * Ticket, not ignored, under the loop guard, and offering a task.
 */
export function openTicketRowGate(facts: OpenTicketRowFacts): OpenTicketRowGate {
	if (facts.state !== "open" || !facts.actionable) return { stands: false };
	if (facts.ignoreBlocked) return { stands: false };
	if (handoffLimitReached(facts.handoffCount, facts.handoffLimit)) return { stands: false };
	if (facts.taskType === null) return { stands: false };
	return { stands: true, taskType: facts.taskType };
}

/** The waits the open-ticket add reads from the state module (ADR 0051, ADR 0026). */
export interface OpenTicketWaitsFacts {
	/** The sources re-read the ticket since its last cycle ended. */
	sourceReverified: boolean;
	/** The ticket's newest closed cycle completed the task the row still suggests. */
	sameTypeHoldActive: boolean;
	/** The queue already holds an item for this ticket. */
	queueItemStands: boolean;
}

/**
 * Whether the waits the row's own facts could not answer all pass: the source
 * has re-read the ticket, the Same-type hold is clear, and no item stands.
 */
export function openTicketWaitsHold(facts: OpenTicketWaitsFacts): boolean {
	return facts.sourceReverified && !facts.sameTypeHoldActive && !facts.queueItemStands;
}
