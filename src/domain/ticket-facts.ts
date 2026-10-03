/**
 * The screen's facts: the rules the glossary names, in one module.
 *
 * The App module holds state, effects, key dispatch, and Agent actions. The
 * rules the glossary names - the failure badge, the Queue wait, the Starting
 * window, the Handoff limit marker, the in-flight fact, the task type a row
 * names - were read from inside the App module and handed to the surfaces as
 * callbacks, so a surface could not state one fact without a function. This
 * module owns them: it takes the screen's inputs once and answers with the
 * facts as values.
 *
 * The module is pure. It reads no state file, mounts no renderer, and holds no
 * palette: a fact here is a value a surface can paint, and the color comes from
 * the shared paint layer (ADR 0024). One test per rule stands at this
 * interface, so a rule cannot be read two ways without a test going red.
 *
 * The Missing agent rule is read here, not redefined: it lives in the domain's
 * agent module and every reader of the fact calls it. The Startup grace is read
 * beside it the same way.
 */
import type { TransitionOutcome } from "../config.ts";
import type { HerdrAgent } from "../herdr.ts";
import type { PlaneActionAttempt, WorkQueueItem } from "../state.ts";
import {
	type AgentPoll,
	agentInPane,
	agentPoll,
	normalizeAgentStatus,
	ticketAgentName,
} from "./agent.ts";
import { holdsDecision, type Ticket, type TicketMarker } from "./ticket.ts";

/** The task type a row names when the machine offers no task for it (ADR 0027). */
export const PARKED_TASK_TYPE = "parked";
/** The word a row names when no task type is recorded for it. */
export const UNKNOWN_TASK_TYPE = "unknown";

/** The task type as the fact the plane reads: its value and whether it is missing. */
export interface TaskTypeFact {
	/** The value the list badge and the detail pane show. */
	value: string;
	/** True when no task type is recorded for the Ticket. */
	unknown: boolean;
}

/** The inputs the fact module reads once per render. */
export interface TicketFactInputs {
	/** The Handoff limit the resolved config names. */
	maxHandoffsPerTicket: number;
	/** The task type the resolved config falls back to (story 18's context lines). */
	defaultTaskType: string;
	/** The last Agent poll, or null when no poll has landed yet. */
	agents: readonly HerdrAgent[] | null;
	/** The claims this run holds: the Starting window's set, by Ticket identity. */
	claims: ReadonlySet<string>;
	/** The Work queue items. */
	queue: readonly WorkQueueItem[];
	/** The rows the section lists. */
	tickets: readonly Ticket[];
}

/** The facts one Ticket's row wears. */
export interface TicketRowFacts {
	/** The identity the row names: the fact the cursor holds onto. */
	identity: string;
	/** The Ticket the row names. */
	ticket: Ticket;
	/** The failure badge the row wears, or null when the row wears none. */
	failure: TicketMarker | null;
	/**
	 * The Starting face the row wears (ADR 0030), in place of its state badge.
	 * The failure marker rules the face out before it is read, so a dead or
	 * blocked Agent is never hidden behind the motion: the fact answers false
	 * while a marker stands.
	 */
	starting: boolean;
	/** The Queue wait's `queued` badge (CONTEXT.md). */
	queueWait: boolean;
	/** The Handoff limit marker the row wears at its end. */
	handoffLimit: boolean;
	/** The in-flight fact: the row keeps its row while the operator's flag stands (ADR 0060). */
	inFlight: boolean;
	/** The held turn's badge (ADR 0016): the decision the operator owes. */
	held: boolean;
	/** The task type the row names. */
	taskType: TaskTypeFact;
}

/** The answer: the rows in the order the section lists them, and the same facts by identity. */
export interface TicketFacts {
	rows: readonly TicketRowFacts[];
	/** The facts of one Ticket by identity, so a detail pane reads the same fact the row wears. */
	byIdentity: ReadonlyMap<string, TicketRowFacts>;
}

/**
 * The task type the row names and the detail pane's line carries.
 *
 * The row names the task type of the turn the Ticket is on: the handoff's while
 * a turn runs, and the suggestion for an open Ticket, whose handoff record is
 * the closed cycle's history - the row must describe the next handoff, not the
 * closed one. Nothing is recorded: an open Ticket that suggests nothing names
 * `parked`, because the machine offers no task for it and starts nothing on it
 * (ADR 0027); a Ticket that is not open names `unknown`, because the value is
 * missing rather than a task type.
 *
 * Story 18 asks for one task type per Ticket across the whole screen. The frame
 * tests - the contract - name the settled turn's task type on the context lines
 * even while a different turn runs, so the two rules stay separate here and are
 * named as the two facts they are. The row's rule is this one; the context
 * lines read `turnTaskType`. Recorded on the pull request as a deviation from
 * story 18.
 */
export function rowTaskType(ticket: Ticket): TaskTypeFact {
	// A ticket that is open holds no cycle: its handoff record is the closed
	// cycle's history, so the row names the next handoff - the suggestion. The
	// machine offers no task for an open ticket that suggests nothing, so the
	// row names `parked` (ADR 0027).
	if (ticket.state === "open") {
		const suggested = ticket.suggestedTaskType;
		if (suggested !== null && suggested !== "") return { value: suggested, unknown: false };
		return { value: PARKED_TASK_TYPE, unknown: false };
	}
	const recorded = ticket.handoff?.taskType ?? "";
	if (recorded !== "") return { value: recorded, unknown: false };
	return { value: UNKNOWN_TASK_TYPE, unknown: true };
}

/**
 * The task type the context lines name: the settled turn's, else the handoff's,
 * else the Ticket's suggestion, else the config's default.
 *
 * The Decision modal's context row and the Live view's context line name the
 * turn that settled, not the turn the row is on, so this is the second rule and
 * not the row's. It is read here so the two surfaces cannot state two different
 * task types for one Ticket.
 */
export function turnTaskType(ticket: Ticket, defaultTaskType: string): string {
	const settled = ticket.lastCompletion?.taskType ?? "";
	if (settled !== "") return settled;
	const recorded = ticket.handoff?.taskType ?? "";
	if (recorded !== "") return recorded;
	const suggested = ticket.suggestedTaskType;
	if (suggested !== null && suggested !== "") return suggested;
	return defaultTaskType;
}

/**
 * The failure badge of an in-flight Ticket (CONTEXT.md), or null.
 *
 * The row wears `blocked` or `missing` in place of its state badge. No poll has
 * landed: an unreadable herdr must not read as "every pane is missing", so the
 * fact answers null. The Missing agent rule is the domain's one function, read
 * the way the in-flight pass, the Restart walk, and the Parallel limit seat
 * count read it.
 */
export function failureMarker(ticket: Ticket, poll: AgentPoll | null): TicketMarker | null {
	if (!inFlight(ticket)) return null;
	const paneId = ticket.handoff?.paneId ?? null;
	if (paneId === null || poll === null) return null;
	if (agentInPane(poll, paneId, ticketAgentName(ticket)) === null) return "missing";
	const agent = poll.get(paneId);
	return agent !== undefined && normalizeAgentStatus(agent.status) === "blocked" ? "blocked" : null;
}

/** Whether the Ticket is in flight: an Agent works on it or its start is pending. */
export function inFlight(ticket: Ticket): boolean {
	return ticket.state === "handed-off" || ticket.state === "running";
}

/**
 * The Starting window (ADR 0030) one Ticket reads: the claim this run holds on
 * it, or its `handed-off` state.
 *
 * The row and the detail header wear the spinner face the window opens in place
 * of the state badge. A failure marker rules the face out before it is read, so
 * a dead or blocked Agent is never hidden behind the motion.
 */
export function startingWindow(ticket: Ticket, claimHeld: boolean): boolean {
	return claimHeld || (!ticket.handoffRecoveryRequired && ticket.state === "handed-off");
}

/**
 * The Queue wait (CONTEXT.md) one Ticket reads: the item that holds its start.
 *
 * An open-origin item stands while the Ticket rests open; a route's item stands
 * on the position the route chose, open or awaiting alike (ADR 0064, ADR 0072),
 * the Plane action's merge item the same way (ADR 0068). The row wears the
 * `queued` badge in place of its state badge while the item stands. The Ticket
 * keeps its state, so the counts and the state file never learn the badge.
 */
export function queueWait(ticket: Ticket, queue: readonly WorkQueueItem[]): boolean {
	return queue.some(
		(item) =>
			(item.kind === "handoff" || item.kind === "plane-action") &&
			((item.origin === "open" &&
				item.ticketIdentity === ticket.identity &&
				ticket.state === "open") ||
				(item.origin === "workflow" &&
					item.ticketIdentity === ticket.identity &&
					(ticket.state === "open" || ticket.state === "awaiting"))),
	);
}

/** Whether the Ticket has used up its Handoff limit. */
export function handoffLimitReached(ticket: Ticket, maxHandoffsPerTicket: number): boolean {
	return ticket.handoffCount >= maxHandoffsPerTicket;
}

/**
 * The screen's facts, read once.
 *
 * Every row's facts come from this one read, so the row's badge, the detail
 * pane's badge, and the ignore key's refusal cannot disagree (ADR 0060).
 */
export function ticketRowFacts(inputs: TicketFactInputs): TicketFacts {
	const poll = agentPoll(inputs.agents);
	const rows = inputs.tickets.map(
		(ticket): TicketRowFacts => ({
			identity: ticket.identity,
			ticket,
			failure: failureMarker(ticket, poll),
			starting: wornFace(ticket, poll, inputs),
			queueWait: queueWait(ticket, inputs.queue),
			handoffLimit: handoffLimitReached(ticket, inputs.maxHandoffsPerTicket),
			inFlight: inFlight(ticket),
			held: holdsDecision(ticket),
			taskType: rowTaskType(ticket),
		}),
	);
	return { rows, byIdentity: new Map(rows.map((row) => [row.identity, row])) };
}

/** The fact one Ticket carries, read through the same rules as the rows. */
export function ticketFactsFor(ticket: Ticket, inputs: TicketFactInputs): TicketRowFacts {
	const poll = agentPoll(inputs.agents);
	return {
		identity: ticket.identity,
		ticket,
		failure: failureMarker(ticket, poll),
		starting: wornFace(ticket, poll, inputs),
		queueWait: queueWait(ticket, inputs.queue),
		handoffLimit: handoffLimitReached(ticket, inputs.maxHandoffsPerTicket),
		inFlight: inFlight(ticket),
		held: holdsDecision(ticket),
		taskType: rowTaskType(ticket),
	};
}

/** The face the row wears: the Starting window, with the failure marker ruled out first. */
function wornFace(ticket: Ticket, poll: AgentPoll | null, inputs: TicketFactInputs): boolean {
	return (
		failureMarker(ticket, poll) === null &&
		startingWindow(ticket, inputs.claims.has(ticket.identity))
	);
}

/**
 * The Decision region's facts: the lines the modal states above its rows, and
 * the context line under its border (ADR 0027).
 *
 * The modal keeps its rows, its Decision region, and its focus. The words the
 * settled turn's transition wrote, the route's standing line, and the turn's
 * outcome are facts, so they are read here and handed to the surface as values.
 */
export interface DecisionFactInputs {
	/** The Ticket the decision is about. */
	ticket: Ticket;
	/** The Work queue items. */
	queue: readonly WorkQueueItem[];
	/** The claims this run holds: the Starting window's set. */
	claims: ReadonlySet<string>;
	/** The Ticket the transition's position stands on, or undefined when none does. */
	positionTicket: Ticket | undefined;
	/** Whether the position's Ticket still stands in a source. */
	positionStillListed: boolean;
	/** Whether the position's task type carries the plane action form. */
	positionIsPlaneAction: boolean;
	/** The newest plane-action attempt the state read for this Ticket, or null. */
	latestPlaneActionAttempt: PlaneActionAttempt | null;
	/** The task type the resolved config falls back to. */
	defaultTaskType: string;
}

/** The row the settled turn's transition offers, as the fact the modal reads. */
export type DecisionOffer =
	| { kind: "merge"; taskType: string }
	| { kind: "handoff"; taskType: string };

/** The Decision region's facts for one settled turn. */
export interface DecisionFacts {
	/** One context row under the border: repository, task type, agent, time. */
	contextLine: string;
	/** The fact lines the modal states above its rows. */
	factLines: readonly string[];
	/** The row the transition offers, or null when none stands. */
	offer: DecisionOffer | null;
}

/** One surface's label write as the decision's fact line. */
export function transitionFactLine(
	surface: string,
	write: { added: string[]; removed: string[] },
): string {
	const parts = [surface];
	if (write.added.length > 0) parts.push(`added ${write.added.join(", ")}`);
	if (write.removed.length > 0) parts.push(`removed ${write.removed.join(", ")}`);
	return parts.join(" · ");
}

/**
 * Where a living route stands (ADR 0064), or null while the route is dead: no
 * queue item waits for it, and its position holds no handoff.
 *
 * The decision row reads the answer as the fact line it names - waiting in the
 * Work queue, starting, or running on its position Ticket - and the live route
 * row stands again the moment the route dies.
 */
export function routeStandingLine(
	ticket: Ticket,
	outcome: TransitionOutcome,
	mergeRoute: boolean,
	inputs: DecisionFactInputs,
): string | null {
	const positionIdentity = outcome.positionTicketIdentity ?? ticket.identity;
	if (mergeRoute) {
		// The merge's route stands in the Work queue's row (ADR 0068): the item
		// takes no seat, so the pickup's walk runs it when it reaches it.
		const waiting = inputs.queue.some(
			(item) => item.kind === "plane-action" && item.ticketIdentity === positionIdentity,
		);
		return waiting ? "the merge is waiting in the Work queue" : null;
	}
	const waiting = inputs.queue.some(
		(item) =>
			item.kind === "handoff" &&
			item.origin === "workflow" &&
			item.routeFromIdentity === ticket.identity,
	);
	if (waiting) return "the route is waiting in the Work queue";
	if (inputs.claims.has(positionIdentity)) return "the route is starting";
	if (inputs.positionTicket !== undefined && inFlight(inputs.positionTicket))
		return "the route is running on its position ticket";
	return null;
}

/** The Decision region's facts for one settled turn, read once. */
export function decisionFacts(inputs: DecisionFactInputs): DecisionFacts {
	const ticket = inputs.ticket;
	const completion = ticket.lastCompletion;
	const time = completion === null ? "" : completion.completedAt.slice(0, 16).replace("T", " ");
	const contextLine = [
		ticket.repository,
		turnTaskType(ticket, inputs.defaultTaskType),
		completion?.agentType ?? "?",
		time,
	]
		.filter((part) => part !== "")
		.join(" · ");

	const factLines: string[] = [];
	const outcome = completion?.transition ?? null;
	if (outcome === null) return { contextLine, factLines, offer: null };

	// The reason is a visible fact either way: the branch that did not hold, or
	// the pull-request fact the fire skipped because no linked pull request was
	// found (ADR 0027).
	if (outcome.reason !== "") {
		factLines.push(outcome.fired ? outcome.reason : `no transition branch held: ${outcome.reason}`);
	}
	if (outcome.ticketWrite !== null)
		factLines.push(transitionFactLine("ticket", outcome.ticketWrite));
	if (outcome.pullRequestWrite !== null && outcome.pullRequestIdentity !== null) {
		const surface =
			outcome.pullRequestKey !== null ? `pull request ${outcome.pullRequestKey}` : "pull request";
		factLines.push(transitionFactLine(surface, outcome.pullRequestWrite));
	}
	if (outcome.writeFailure !== "") factLines.push(`label write failed: ${outcome.writeFailure}`);

	let offer: DecisionOffer | null = null;
	if (outcome.positionTaskType !== null) {
		// The merged position the transition offers (ADR 0068): the task type
		// resolves on the plane action, so the row asks for the merge, not for a
		// handoff. While the route is alive the row reads as the fact line that
		// names where it stands, and takes no key (ADR 0064). The record settles
		// only the turn that ran it: it stands while it postdates the turn's
		// completion, so a blocked merge never hides the re-merge the following
		// review asks for.
		const attempt = inputs.latestPlaneActionAttempt;
		const attemptStands = attempt !== null && attempt.at >= (completion?.completedAt ?? "");
		const standing = routeStandingLine(ticket, outcome, inputs.positionIsPlaneAction, inputs);
		if (standing !== null) {
			factLines.push(standing);
		} else if (attemptStands && attempt !== null) {
			// The outcome stands where the row stood (ADR 0068).
			factLines.push(
				attempt.outcome === "merged"
					? `the merge ${attempt.decision === "auto-merged" ? "ran" : "landed"}`
					: `the merge was blocked: ${attempt.reason}`,
			);
			if (attempt.transition !== null && attempt.transition.pullRequestWrite !== null) {
				factLines.push(transitionFactLine("pull request", attempt.transition.pullRequestWrite));
			}
		} else if (inputs.positionStillListed) {
			// The position is derived, never stored (ADR 0027): the Ticket it
			// sits on can leave its source between the fire and the decision. No
			// list holds such a Ticket, and no task can host on it, so the offer
			// stands withdrawn.
			offer = inputs.positionIsPlaneAction
				? { kind: "merge", taskType: outcome.positionTaskType }
				: { kind: "handoff", taskType: outcome.positionTaskType };
		} else {
			factLines.push(
				inputs.positionIsPlaneAction
					? "the position's ticket left its source; no merge stands"
					: "the position's ticket left its source; no handoff stands",
			);
		}
	}

	// The re-fire row stands on an outcome the fire did not complete (ADR 0054):
	// no branch held, or the label write failed. A complete outcome states no
	// fact line here.
	return { contextLine, factLines, offer };
}

/** The Live view's context line: repository, task type, agent. No time: the turn has not settled. */
export function liveContextLine(ticket: Ticket, defaultTaskType: string): string {
	return [
		ticket.repository,
		turnTaskType(ticket, defaultTaskType),
		ticket.handoff?.agentType ?? "?",
	]
		.filter((part) => part !== "")
		.join(" · ");
}

/** Whether a settled turn holds its decision: the row's `held` badge and the header's count. */
export function heldTurn(ticket: Ticket): boolean {
	return holdsDecision(ticket);
}
