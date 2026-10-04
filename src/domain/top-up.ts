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
 * Whether the cycle's standing gates hold every automatic add: the mode is off,
 * the brake is on, or a held turn stands undecided. In every one of those the
 * walk reads no candidate and adds nothing.
 */
export function automaticAddsHold(facts: AutomaticAddFacts): boolean {
	return !facts.modeOn || facts.queuePaused || facts.dispatchPauseActive;
}

/**
 * Whether the fresh-work add may enter: the cycle's gates, and a queue with no
 * row in it (ADR 0051). The continuation add reads the same gates and its own
 * queue rule instead, because ADR 0094 lets it enter ahead of a standing
 * fresh-work row.
 */
export function topUpCycleOpen(facts: TopUpCycleFacts): boolean {
	return !automaticAddsHold(facts) && facts.queueDepth === 0;
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
