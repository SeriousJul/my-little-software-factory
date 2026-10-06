/**
 * The Ticket's facts (issue #201): the rules the glossary names, in one module.
 *
 * The App module holds state, effects, key dispatch, and Agent actions. The
 * rules the glossary names - the failure badge, the Queue wait, the Starting
 * window, the Handoff limit marker, the in-flight fact, the task type a row
 * names - were read from inside the App module and handed to the surfaces as
 * callbacks, so a surface could not state one fact without a function. This
 * module owns them: it takes the screen's inputs once and answers with the
 * facts as values.
 *
 * The Decision region's lines are a separate interface with separate consumers
 * and stand in `decision-facts.ts`. The Live view's context line names the same
 * Ticket the row names, so it stays here beside the row's facts.
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
import type { WorkQueueItem } from "../state/work-queue.ts";
import { type AgentPoll, agentInPane, normalizeAgentStatus, ticketAgentName } from "./agent.ts";
import { failedStartParkStands } from "./failed-start-park.ts";
import { nameCollisionStands } from "./name-collision.ts";
import {
	automaticStartBlocked,
	handoffLimitReached,
	holdsDecision,
	inFlightState,
	type Ticket,
	type TicketMarker,
} from "./ticket.ts";

/** The task type a row names when the machine offers no task for it (ADR 0027). */
const PARKED_TASK_TYPE = "parked";
/** The word a row names when no task type is recorded for it. */
const UNKNOWN_TASK_TYPE = "unknown";

/** The task type as the fact the plane reads: its value and whether it is missing. */
export interface TaskTypeFact {
	/** The value the list badge and the detail pane show. */
	value: string;
	/** True when no task type is recorded for the Ticket. */
	unknown: boolean;
}

/**
 * The environment the fact module reads once per render.
 *
 * The Tickets a section lists are not part of it: the environment is what the
 * rules read *about* a Ticket, so one record serves the row list and a single
 * Ticket alike, and no reader hands a one-element list to ask about one Ticket.
 *
 * `poll` is the last Agent poll as the domain's fact record, not the raw list:
 * the screen turns the list into the poll once per render and every fact read
 * takes that one record, so no fact read rebuilds it (issue #201 review).
 */
export interface TicketFactInputs {
	/** The Handoff limit the resolved config names. */
	maxHandoffsPerTicket: number;
	/** The last Agent poll, or null when no poll has landed yet. */
	poll: AgentPoll | null;
	/** The claims this run holds: the Starting window's set, by Ticket identity. */
	claims: ReadonlySet<string>;
	/** The Work queue items. */
	queue: readonly WorkQueueItem[];
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
	/** The Queue wait's `queued` badge (GLOSSARY.md). */
	queueWait: boolean;
	/** The Handoff limit marker the row wears at its end. */
	handoffLimit: boolean;
	/**
	 * The Failed-start park the row wears at its end (issue #298, ADR 0106): the
	 * Ticket's Handoff starts keep failing, and the Top-up adds no automatic start
	 * for it. The row names it beside the Handoff limit marker, and the detail
	 * states the run it stands on.
	 */
	failedStartPark: boolean;
	/**
	 * The Agent name collision the row wears (issue #299, ADR 0107): herdr holds
	 * the Ticket's stable Agent name in a pane the plane does not own, and the
	 * Top-up adds no automatic start for it while the fact stands. It rides the
	 * row apart from the Leftover environment the Ticket also carries: one word
	 * names the plane's own environment still open, the other names a name a
	 * stranger holds, and no reader folds one into the other.
	 */
	nameCollision: boolean;
	/** The in-flight fact: the row keeps its row while the operator's flag stands (ADR 0060). */
	inFlight: boolean;
	/** The held turn's badge (ADR 0016): the decision the operator owes. */
	held: boolean;
	/** The task type the row names. */
	taskType: TaskTypeFact;
}

/**
 * The answer: the rows in the order the section lists them.
 *
 * The facts of a Ticket the section does not list come from `ticketFactsFor`,
 * read through the same rules, so no reader needs a second index of the rows.
 */
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
 * named as the two facts they are: the row's `rowTaskType`, and the context
 * lines' `turnTaskType`. The deviation is recorded in
 * `docs/operation/main-view.md` and on issue #201.
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
 * The failure badge of an in-flight Ticket (GLOSSARY.md), or null.
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
	return inFlightState(ticket.state);
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
 * The Queue wait (GLOSSARY.md) one Ticket reads: the item that holds its start.
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

/**
 * The face one row wears: the Starting window, with the failure marker ruled
 * out first (story 7). The marker the row already wears is handed in, so one
 * row resolves its pane once.
 */
function wornFace(ticket: Ticket, failure: TicketMarker | null, claimHeld: boolean): boolean {
	return failure === null && startingWindow(ticket, claimHeld);
}

/** The facts one Ticket wears, read through the fact module's rules. */
function factsOf(ticket: Ticket, inputs: TicketFactInputs): TicketRowFacts {
	const failure = failureMarker(ticket, inputs.poll);
	return {
		identity: ticket.identity,
		ticket,
		failure,
		starting: wornFace(ticket, failure, inputs.claims.has(ticket.identity)),
		queueWait: queueWait(ticket, inputs.queue),
		handoffLimit: handoffLimitReached(ticket.handoffCount, inputs.maxHandoffsPerTicket),
		// The park the same ledger answers: the run of failed starts against half
		// the same limit, and the operator's own act that answers it (issue #298).
		failedStartPark: failedStartParkStands({
			failedStartStreak: ticket.failedStartStreak,
			handoffLimit: inputs.maxHandoffsPerTicket,
			judgedOut: automaticStartBlocked(ticket),
		}),
		// The collision is a stored fact, not a derived one: the row states the
		// record the refused start wrote, and the operator's own act takes it off.
		nameCollision: nameCollisionStands({
			held: ticket.nameCollision !== null,
			judgedOut: automaticStartBlocked(ticket),
		}),
		inFlight: inFlight(ticket),
		held: holdsDecision(ticket),
		taskType: rowTaskType(ticket),
	};
}

/**
 * The screen's facts, read once.
 *
 * Every row's facts come from this one read, so the row's badge, the detail
 * pane's badge, and the ignore key's refusal cannot disagree (ADR 0060).
 */
export function ticketRowFacts(
	inputs: TicketFactInputs,
	tickets: readonly Ticket[],
): readonly TicketRowFacts[] {
	return tickets.map((ticket) => factsOf(ticket, inputs));
}

/** The fact one Ticket carries, read through the same rules as the rows. */
export function ticketFactsFor(ticket: Ticket, inputs: TicketFactInputs): TicketRowFacts {
	return factsOf(ticket, inputs);
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
