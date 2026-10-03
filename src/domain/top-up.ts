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
 * The walk keeps the reads. It asks for a fact only when the waits before it
 * leave the candidate standing, so a large ticket list costs no statement for a
 * row an earlier wait already held out. The rules decide; the walk decides
 * nothing.
 */

import type { TransitionOutcome } from "../config.ts";
import { type EnvironmentKind, handoffLimitReached, type TicketState } from "./ticket.ts";

/** The facts the top-up asks before it looks for a candidate at all (ADR 0051). */
export interface TopUpCycleFacts {
	/** Auto-handoff mode is on. */
	modeOn: boolean;
	/** The operator's queue pause stands (ADR 0052). */
	queuePaused: boolean;
	/** A held failed turn holds new automatic work (ADR 0016). */
	dispatchPauseActive: boolean;
	/** How many items the queue holds. The top-up adds into an empty queue only. */
	queueDepth: number;
}

/**
 * Whether this cycle may add at all. The mode is off, the brake is on, a held
 * turn stands undecided, or the queue already holds an item: in every one of
 * those the walk reads no candidate and adds nothing.
 */
export function topUpCycleOpen(facts: TopUpCycleFacts): boolean {
	return facts.modeOn && !facts.queuePaused && !facts.dispatchPauseActive && facts.queueDepth === 0;
}

/**
 * The re-fired skip's answer (ADR 0042): the settled turn is a re-fire the
 * top-up must route, together with the position it routes to, or it is not.
 * The marker carries the shape: `refired` is set only on an outcome that fired
 * and derived a position, so these tests hold the record against a damaged
 * trace, and no walk reaches them on its own. The position the answer names is
 * part of it so the walk never re-tests the marker's fields.
 */
export type RefiredRoute =
	| {
			stands: true;
			taskType: string;
			positionTicketIdentity: string;
			/** The Agent and environment the settled turn ran with. */
			agent: string | undefined;
			environment: EnvironmentKind | undefined;
	  }
	| { stands: false };

export function refiredRoute(outcome: TransitionOutcome | null): RefiredRoute {
	if (
		outcome === null ||
		outcome.refired !== true ||
		outcome.fired !== true ||
		outcome.autoAdvance !== true ||
		outcome.writeFailure !== "" ||
		outcome.positionTaskType === null ||
		outcome.positionTicketIdentity === null
	)
		return { stands: false };
	return {
		stands: true,
		taskType: outcome.positionTaskType,
		positionTicketIdentity: outcome.positionTicketIdentity,
		agent: outcome.agent,
		environment: outcome.environment,
	};
}

/** The facts the re-fired skip's walk reads for the position it routes to. */
export interface RefiredPositionFacts {
	/** The projection's own standing: not in flight, not awaiting, not gone. */
	actionable: boolean;
	/** The position's newest closed cycle completed the task it still suggests. */
	sameTypeHoldActive: boolean;
	handoffCount: number;
	handoffLimit: number;
}

/**
 * Whether the position the skip routes to still stands for the add: the
 * standing, the hold, and the loop guard the handoff's add ran (ADR 0042,
 * ADR 0026, ADR 0005).
 */
export function refiredPositionStands(facts: RefiredPositionFacts): boolean {
	return (
		facts.actionable &&
		!facts.sameTypeHoldActive &&
		!handoffLimitReached(facts.handoffCount, facts.handoffLimit)
	);
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
