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

import { NEXT_STEP_GATE_LINES, type NextStepGate } from "../workflow.ts";
import { handoffLimitReached, type TicketState } from "./ticket.ts";

/**
 * The fact a standing gate stood before the machine added anything (issue #223).
 *
 * Every one of these holds the walk out before it asks for a candidate - or, for
 * the held Next step, holds the settled turn's step - so the run shows nothing
 * but the start that never came. Each reason names itself in the plane's record,
 * so a reviewer can tell a correct hold from a broken one. The walk-hold reasons
 * are the walks' own gates, in the order the walks read them, and the awaiting
 * walk's gate stands last.
 */
export const AUTOMATIC_HOLD_REASONS = [
	"auto-handoff-off",
	"queue-paused",
	"dispatch-pause",
	"continuation-standing",
	"operator-row-standing",
	"queue-row-standing",
	"agent-name-held",
	"handoff-failure-park",
	"ticket-ignored",
	"startup-grace",
	"agent-present",
	"handoff-limit",
	"queue-item-standing",
	"restart-mark-standing",
	"row-not-open",
	"row-not-actionable",
	"row-offers-no-task",
	"source-not-reverified",
	"same-type-hold",
	"next-step-held",
] as const;

export type AutomaticHoldReason = (typeof AUTOMATIC_HOLD_REASONS)[number];

/**
 * The holds that name the Work queue row the walk waits behind.
 *
 * The owed continuation is the walk that names it: the row that stands is the
 * one fact the hold acted on, and the walk holds that row in hand when its gate
 * answers, so the line can say which owed start the hold blocked and not only
 * that a hold happened (issue #223 review). The other holds state a bare fact:
 * where their gate stands no row is picked and none is known.
 */
export const AUTOMATIC_ROW_HOLD_REASONS = [
	"continuation-standing",
	"operator-row-standing",
] as const;

export type AutomaticRowHoldReason = (typeof AUTOMATIC_ROW_HOLD_REASONS)[number];

/**
 * The holds that name the candidate Ticket the walk reached and held out.
 *
 * The Agent name collision and the Failed-start park are the first of these:
 * each gate stands on a candidate the walk read, not on a Work queue row, and
 * the record has to say which Ticket the walk left resting - a run with more
 * than one Ticket in play cannot tell a held Ticket from a held factory
 * (issue #298, issue #299).
 *
 * The rest are the facts the fresh-work walk's per-candidate gates stand on
 * (issue #231): the restart candidate's gates, then the open-ticket row gate
 * and the waits it reads, in the order the walks read them. A run that reads
 * candidates and adds nothing states the fact each candidate rested on, and the
 * record has to say which candidate it left resting the same way.
 */
export const AUTOMATIC_CANDIDATE_HOLD_REASONS = [
	"agent-name-held",
	"handoff-failure-park",
	"ticket-ignored",
	"startup-grace",
	"agent-present",
	"handoff-limit",
	"queue-item-standing",
	"restart-mark-standing",
	"row-not-open",
	"row-not-actionable",
	"row-offers-no-task",
	"source-not-reverified",
	"same-type-hold",
] as const;

export type AutomaticCandidateHoldReason = (typeof AUTOMATIC_CANDIDATE_HOLD_REASONS)[number];

/**
 * The holds that name the Ticket whose settled turn the gate holds the Next
 * step of (ADR 0092, issue #232).
 *
 * The awaiting walk is the walk that takes this hold: the settled turn rests in
 * awaiting while the gate stands, and the hold names the ticket, the step the
 * turn owes, the position the step stands on when that is not the ticket
 * itself, and the gate that holds it - four facts the record line states and
 * the key carries.
 */
export const AUTOMATIC_NEXT_STEP_HOLD_REASONS = ["next-step-held"] as const;

export type AutomaticNextStepHoldReason = (typeof AUTOMATIC_NEXT_STEP_HOLD_REASONS)[number];

/** The holds whose line states the fact alone, with no row named. */
export type AutomaticBareHoldReason = Exclude<
	AutomaticHoldReason,
	AutomaticRowHoldReason | AutomaticCandidateHoldReason | AutomaticNextStepHoldReason
>;

/** A hold that names no row. */
export interface AutomaticBareHold {
	readonly reason: AutomaticBareHoldReason;
	readonly row?: undefined;
	readonly candidate?: undefined;
	readonly detail?: undefined;
}

/** A hold that names the Work queue row the walk waits behind. */
export interface AutomaticRowHold {
	readonly reason: AutomaticRowHoldReason;
	/**
	 * The standing row's ticket identity. The rule answers with the identity and
	 * not the name: the walk reads a name only for a fact the record has not
	 * stated yet, so a hold that stands across a hundred polls costs no name read.
	 */
	readonly row: string;
	readonly candidate?: undefined;
	readonly detail?: undefined;
}

/** A hold that names the candidate Ticket the walk reached and held out. */
export interface AutomaticCandidateHold {
	readonly reason: AutomaticCandidateHoldReason;
	/**
	 * The candidate's ticket identity, named the way a standing row is named: the
	 * rule answers the identity and the walk reads the name only for a fact the
	 * record has not stated yet.
	 */
	readonly candidate: string;
	/**
	 * The fact stated beside the Ticket's name, when the hold carries one. The
	 * Agent name collision names the refusal its attempt stored, so the record
	 * states the same reason the ledger holds and the row states (issue #299).
	 */
	readonly detail?: string;
	readonly row?: undefined;
}

/** A hold that names the Ticket whose Next step the gate holds (ADR 0092). */
export interface AutomaticNextStepHold {
	readonly reason: AutomaticNextStepHoldReason;
	/**
	 * The Ticket whose settled turn owes the step. The walk answers with the
	 * identity and not the name: the record reads a name only for a fact it has
	 * not stated yet, so a hold that stands across a hundred polls costs no
	 * projection read.
	 */
	readonly ticket: string;
	/** The task type the derived position offers. */
	readonly step: string;
	/** The ticket the position stands on, when that is not the holding ticket. */
	readonly position?: string;
	/** The gate that holds the step: the line states the gate's own sentence. */
	readonly gate: NextStepGate;
	readonly row?: undefined;
	readonly candidate?: undefined;
	readonly detail?: undefined;
}

/**
 * The hold one automatic walk took: its fact, and the standing row, the held
 * candidate, or the held step's ticket when one names it.
 */
export type AutomaticHold =
	| AutomaticBareHold
	| AutomaticRowHold
	| AutomaticCandidateHold
	| AutomaticNextStepHold;

/**
 * The sentence each hold is stated in.
 *
 * The module that owns the gates owns the words for them, the way
 * `NEXT_STEP_GATE_LINES` does for a gated Next step, so the walk states its
 * hold in one wording and no surface restates it. A standing-row hold's line is
 * this sentence with the row it waits behind beside it (`automaticHoldLine`).
 *
 * The two lines about a standing row name whose row it is, because the origin
 * cannot tell the factory's row from the operator's. The third names the
 * queue's depth instead: the fresh-work gate holds on any row at all, a
 * Consultation row included, and the staging of the row that stands is what the
 * queue's own `handoff queued:` line already states (issue #223 review).
 *
 * The held Next step's entry is a prefix and not a sentence: that hold always
 * names the ticket its step stands on, so its line never stands bare, and the
 * gate's own sentence stands in parentheses at the end (`automaticHoldLine`)
 * (issue #232).
 */
export const AUTOMATIC_HOLD_LINES: Readonly<Record<AutomaticHoldReason, string>> = {
	"auto-handoff-off": "automatic walks hold: auto-handoff is off",
	"queue-paused": "automatic walks hold: the Work queue is paused",
	"dispatch-pause": "automatic walks hold: a failed turn waits for the operator",
	"continuation-standing": "automatic walks hold: the Work queue already holds a continuation",
	"operator-row-standing": "automatic walks hold: the Work queue holds an item the operator staged",
	"queue-row-standing": "automatic walks hold: the Work queue holds a waiting row",
	"agent-name-held": "automatic walks hold: another pane holds the Ticket's Agent name",
	"handoff-failure-park": "automatic walks hold: the Ticket's Handoff starts keep failing",
	// The fresh-work walk's per-candidate facts (issue #231). The first five are
	// the restart candidate's gates; the last six the open-ticket row gate and
	// the waits it reads. The three facts the two candidate gates share - the
	// ignore, the Handoff limit, and the standing item - are one word here and
	// one fact in the record: a hold keyed on the fact and the Ticket it stands
	// on, whatever walk read it.
	"ticket-ignored": "automatic walks hold: the Ticket is ignored or a source is muted",
	"startup-grace": "automatic walks hold: the Ticket's startup grace has not passed",
	"agent-present": "automatic walks hold: the Ticket's Agent is not missing",
	"handoff-limit": "automatic walks hold: the Ticket is at the Handoff limit",
	"queue-item-standing":
		"automatic walks hold: the Work queue already holds an item for the Ticket",
	"restart-mark-standing": "automatic walks hold: the episode already asked the Ticket's restart",
	"row-not-open": "automatic walks hold: the row is not open",
	"row-not-actionable": "automatic walks hold: the row is not actionable",
	"row-offers-no-task": "automatic walks hold: the row offers no task",
	"source-not-reverified":
		"automatic walks hold: the source has not re-read the Ticket since its last cycle ended",
	"same-type-hold": "automatic walks hold: the Same-type hold stands",
	"next-step-held": "next step held:",
};

/**
 * The key a hold states itself under: the fact, and the row, the candidate, or
 * the step's position when the fact names one.
 *
 * A hold is one standing fact, so the key is the fact and not the cycle that
 * reached it. The row is part of it because a later hold behind a different row
 * is a different fact and states itself again (issue #223 review). The held
 * step's key carries the whole fact - the ticket, the step, the position, and
 * the gate - the same way, so a hold that changes its gate or its position is a
 * new fact and states itself again (issue #232).
 */
export function automaticHoldKey(hold: AutomaticHold): string {
	if (hold.reason === "next-step-held") {
		const position = hold.position === undefined ? "" : ` ${hold.position}`;
		return `next-step-held ${hold.ticket} ${hold.step}${position} ${hold.gate}`;
	}
	if (hold.row !== undefined) return `${hold.reason} ${hold.row}`;
	if (hold.candidate !== undefined) return `${hold.reason} ${hold.candidate}`;
	return hold.reason;
}

/**
 * The record line a hold states itself in.
 *
 * `rowName` is the walk's own name read for the standing row - the ticket's
 * title while the ticket is in the projection, its identity once it is gone.
 * The rule owns the sentence and calls for the name only for a hold that names
 * a row.
 *
 * A hold that carries a `detail` states it after the name, under the same
 * parentheses: the Agent name collision names the refusal its attempt stored,
 * so one line answers which Ticket the walk left resting and what stood in its
 * way (issue #299).
 *
 * The held Next step names the ticket the step stands on, the step itself, the
 * position beside it when that is not the ticket, and the gate's own sentence
 * under the same parentheses the other holds use for their fact (issue #232):
 * the line the awaiting walk stated inline before the hold joined the walks'
 * pattern stands here, word for word.
 */
export function automaticHoldLine(
	hold: AutomaticHold,
	rowName: (identity: string) => string,
): string {
	if (hold.reason === "next-step-held") {
		const where = hold.position === undefined ? "" : ` on ${rowName(hold.position)}`;
		return `${AUTOMATIC_HOLD_LINES[hold.reason]} ${rowName(hold.ticket)} ${hold.step}${where} (${NEXT_STEP_GATE_LINES[hold.gate]})`;
	}
	const line = AUTOMATIC_HOLD_LINES[hold.reason];
	const named = hold.row ?? hold.candidate;
	if (named === undefined) return line;
	const detail = hold.detail;
	return detail === undefined
		? `${line} (${rowName(named)})`
		: `${line} (${rowName(named)}: ${detail})`;
}

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
export function automaticAddsHold(facts: AutomaticAddFacts): AutomaticHold | null {
	if (!facts.modeOn) return { reason: "auto-handoff-off" };
	if (facts.queuePaused) return { reason: "queue-paused" };
	if (facts.dispatchPauseActive) return { reason: "dispatch-pause" };
	return null;
}

/**
 * The hold the fresh-work adds stand under: the gates every automatic add reads,
 * then the queue's own depth (ADR 0051). null means the walk may add.
 *
 * The continuation add reads the same gates and its own queue rule instead,
 * because ADR 0094 lets it enter ahead of a standing fresh-work row.
 */
export function freshWorkHold(facts: TopUpCycleFacts): AutomaticHold | null {
	const gate = automaticAddsHold(facts);
	if (gate !== null) return gate;
	if (facts.queueDepth > 0) return { reason: "queue-row-standing" };
	return null;
}

/** One row the Work queue holds, as the continuation's pace gate reads it (ADR 0094, ADR 0100). */
export interface ContinuationRowFacts {
	/** The row's ticket identity: the hold line names the row the walk waits behind. */
	identity: string;
	/**
	 * The row is a Workflow route row the queue already holds: the factory's owed
	 * continuation, or the row the operator's own route decision left there. Either
	 * one holds the next continuation out (ADR 0100 as amended, issue #230).
	 */
	continuation: boolean;
	/**
	 * The staging of that row - the factory's own add or the operator's (GLOSSARY.md
	 * "Staging"). The gate holds on `continuation` alone; this fact answers which
	 * fact the hold line states, because the origin cannot: the operator's route and
	 * the factory's continuation are both `workflow` (issue #223).
	 */
	automatic: boolean;
}

/**
 * Which standing row holds the owed continuation out, named by that row's own
 * staging, or null when no standing row does (ADR 0051, ADR 0094, ADR 0100 as
 * amended by issue #230).
 *
 * One continuation per cycle is the queue's own pace, so a Workflow route row
 * already standing holds the next one out - the factory's own row and the row the
 * operator's route decision left in the queue alike. Nothing else does: a standing
 * fresh-work row is outranked by ADR 0094. ADR 0100's rank is the owed row's place
 * in the queue's order, and a row that already stands is never overtaken by a row
 * that has not entered. The operator keeps the queue pause and the force-dispatch.
 *
 * The staging answers which fact the line states, not whether the row holds: the
 * origin names both stagings `workflow`, and a record that calls the operator's
 * row a continuation names a fact the row is not.
 */
export function continuationHold(rows: readonly ContinuationRowFacts[]): AutomaticHold | null {
	const row = rows.find((candidate) => candidate.continuation);
	if (row === undefined) return null;
	return {
		reason: row.automatic ? "continuation-standing" : "operator-row-standing",
		row: row.identity,
	};
}

/** The facts the restart walk reads for one in-flight Ticket (ADR 0051, ADR 0060, ADR 0070, ADR 0117). */
export interface RestartCandidateFacts {
	/** The Ticket or its source carries the ignore flag. */
	ignoreBlocked: boolean;
	/** The handoff's Task type carries Operator-decides. */
	operatorDecides: boolean;
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
 * The restart gate's answer: the candidate holds, with the fact the hold
 * states when one names it, or it does not.
 *
 * The gates are the flag, the startup grace, the missing Agent, the loop
 * guard, the standing item, and the episode's restart mark. The fact is the
 * first gate that stands, the way the cycle gate states one fact and not six
 * (issue #231). A null fact is a hold that states none: the Operator-decides
 * brake is the designed silence the Missing modal answers (ADR 0117), and a
 * ticket with no pane names no seat the record can state beside.
 */
export type RestartCandidateGate =
	| { holds: false }
	| { holds: true; reason: AutomaticCandidateHoldReason | null };

export function restartCandidateGate(facts: RestartCandidateFacts): RestartCandidateGate {
	if (facts.ignoreBlocked) return { holds: true, reason: "ticket-ignored" };
	if (facts.operatorDecides) return { holds: true, reason: null };
	if (!facts.pastStartupGrace) return { holds: true, reason: "startup-grace" };
	if (!facts.hasPane) return { holds: true, reason: null };
	if (!facts.agentMissing) return { holds: true, reason: "agent-present" };
	if (handoffLimitReached(facts.handoffCount, facts.handoffLimit))
		return { holds: true, reason: "handoff-limit" };
	if (facts.queueItemStands) return { holds: true, reason: "queue-item-standing" };
	if (facts.restartMarkStands) return { holds: true, reason: "restart-mark-standing" };
	return { holds: false };
}

/** The facts the open-ticket add reads off the row it holds (ADR 0051, ADR 0060, ADR 0027, ADR 0117). */
export interface OpenTicketRowFacts {
	/** The row's own state on the walk's view. */
	state: TicketState;
	actionable: boolean;
	ignoreBlocked: boolean;
	handoffCount: number;
	handoffLimit: number;
	/** The task the row's labels suggest; a parking state suggests none. */
	taskType: string | null;
	/** The task the row offers carries Operator-decides; false for a parking row. */
	operatorDecides: boolean;
}

/**
 * The row gate's answer: the row stands for the add, together with the task it
 * offers, or it does not - and the fact the hold states when it does not.
 *
 * The task type is part of the answer so the walk never tests it twice. The
 * fact is the first gate that stands, the way the cycle gate states one fact
 * and not three (issue #231); a null fact is the designed silence the
 * Operator-decides brake keeps (ADR 0117), the way the parking state is.
 */
export type OpenTicketRowGate =
	| { stands: true; taskType: string }
	| { stands: false; hold: AutomaticCandidateHoldReason | null };

/**
 * Whether the row the walk holds stands on its own facts: an open actionable
 * Ticket, not ignored, under the loop guard, and offering a task the machine
 * may start on its own.
 *
 * A row whose position offers an Operator-decides task type holds the same
 * way (ADR 0117): the walk holds that Ticket only and falls to the next
 * candidate, and the hold states nothing - the flag the operator set in their
 * own config is a designed silence, the way the parking state is.
 */
export function openTicketRowGate(facts: OpenTicketRowFacts): OpenTicketRowGate {
	if (facts.state !== "open") return { stands: false, hold: "row-not-open" };
	if (!facts.actionable) return { stands: false, hold: "row-not-actionable" };
	if (facts.ignoreBlocked) return { stands: false, hold: "ticket-ignored" };
	if (handoffLimitReached(facts.handoffCount, facts.handoffLimit))
		return { stands: false, hold: "handoff-limit" };
	if (facts.taskType === null) return { stands: false, hold: "row-offers-no-task" };
	// The designed silence states no fact (ADR 0117): the hold is real, the
	// record is not.
	if (facts.operatorDecides) return { stands: false, hold: null };
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
 * The fact the waits hold the candidate on - the first wait the walk reads -
 * or null when every wait passes: the source has re-read the ticket, the
 * Same-type hold is clear, and no item stands.
 */
export function openTicketWaitsHold(
	facts: OpenTicketWaitsFacts,
): AutomaticCandidateHoldReason | null {
	if (!facts.sourceReverified) return "source-not-reverified";
	if (facts.sameTypeHoldActive) return "same-type-hold";
	if (facts.queueItemStands) return "queue-item-standing";
	return null;
}
