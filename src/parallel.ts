/**
 * The shared Parallel limit seat count (issue #87, ADR 0034).
 *
 * One source for every reader of the count: the Work queue's pickup, which
 * takes only the free seats for its waiting items (ADR 0049), and the mode
 * line in the app. The automatic gates read it through the pickup, not on
 * their own: the top-up adds into the queue whatever the seats look like, and
 * the wait lives in the row (ADR 0051). A seat is held by:
 *
 * - an in-flight ticket (`handed-off` or `running`) whose own agent the
 *   latest successful herdr poll listed - a live agent in the ticket's pane
 *   that runs under another name holds no seat for it, herdr having handed
 *   the closed pane's id out again - or whose started agent is still inside
 *   its Startup grace,
 * - every in-progress handoff (an unresolved claim), counted once even when
 *   its ticket already holds a seat above, and
 * - every Consultation in `opening` or `working` state; the other
 *   Consultation states hold no seat.
 *
 * The rule takes its facts as data (issue #202): the caller passes the ticket
 * facts, the claim identities, the Consultation states, the agent list, the
 * clock, and the grace. The rule never reaches a state module, so the gates
 * and the Ticket header's mode cell can never disagree about the count, and a
 * test states the facts instead of opening a state file.
 *
 * The same read answers a second question (ADR 0108): which in-flight tickets
 * hold no seat because their own agent the latest poll does not list and their
 * Startup grace has run out. Those are the Missing agents, and the seat each
 * one leaves is reserved for that ticket's own restart row.
 */

import { agentInPane } from "./domain/agent.ts";
import type { TicketState } from "./domain/ticket.ts";
import type { HerdrAgent } from "./herdr.ts";
import type { ConsultationState } from "./state/consultation-record.ts";

/** The Consultation states that hold a Parallel limit seat. */
export const CONSULTATION_SEAT_STATES: readonly ConsultationState[] = ["opening", "working"];

/** The ticket states that can hold a Parallel limit seat. */
export const TICKET_SEAT_STATES: readonly TicketState[] = ["handed-off", "running"];

/** What one in-flight ticket holds for the seat count. */
export interface ParallelSeatTicketFact {
	ticketIdentity: string;
	/** The pane the ticket's agent runs in; null when it has none. */
	paneId: string | null;
	/** When the ticket's agent started, in ISO time. */
	startedAt: string;
	/** The agent name the ticket's handoff expects. */
	agentName: string;
}

/** What one Consultation holds for the seat count. */
export interface ParallelSeatConsultationFact {
	/** The Consultation's state. */
	state: ConsultationState;
}

/** The facts the seat count reads, as data. */
export interface ParallelSeatFacts {
	/** The tickets in a state that can hold a seat. */
	tickets: readonly ParallelSeatTicketFact[];
	/** The tickets with an unresolved handoff claim. */
	handoffAttemptTickets: readonly string[];
	/** Every Consultation, with its state. The rule keeps the states that hold a seat. */
	consultations: readonly ParallelSeatConsultationFact[];
	/** The latest successful herdr agent list; null until it holds one. */
	agents: readonly HerdrAgent[] | null;
	/** The clock, in epoch milliseconds. */
	now: number;
	/** The Startup grace a started agent waits out, in milliseconds. */
	startupGraceMs: number;
}

/** The seat answer one in-flight ticket gives for the latest poll. */
type ParallelSeatState = "held" | "booting" | "missing";

/** The seat the one in-flight ticket holds, read from the poll and the clock. */
function seatStateOf(
	ticket: ParallelSeatTicketFact,
	listedAgents: ReadonlyMap<string, HerdrAgent>,
	now: number,
	startupGraceMs: number,
): ParallelSeatState {
	// The one missing-Agent rule the observation cycle and the list's failure
	// badge read: the ticket's own agent is the one that runs under the name the
	// ticket's handoff expects. A different agent in the same pane id - herdr
	// handed the closed pane's id out again - holds no seat for the ticket, the
	// way a missing one does.
	const own = agentInPane(listedAgents, ticket.paneId, ticket.agentName);
	if (own !== null) return "held";
	return now - Date.parse(ticket.startedAt) < startupGraceMs ? "booting" : "missing";
}

/** The Parallel limit seat reading the gates, the pickup, and the mode cell share (ADR 0034, ADR 0108). */
export interface ParallelSeatAccount {
	/** The seats held: the count the mode cell shows and every cap gate reads. */
	count: number;
	/**
	 * The in-flight tickets that hold no seat because their own agent the latest
	 * poll does not list and their Startup grace has run out, in the order the
	 * facts name them. A ticket whose unresolved claim holds its seat is not
	 * here: its seat is held, and nothing stands reserved for it.
	 */
	missingTickets: string[];
}

/**
 * The seat reading: the held seats, and the tickets whose Agent is Missing
 * past the Startup grace (ADR 0034, ADR 0108).
 *
 * One read answers both, so the count the mode cell shows and the seats the
 * pickup reserves cannot disagree about which ticket is missing.
 */
export function parallelSeatAccount(facts: ParallelSeatFacts): ParallelSeatAccount {
	const listedAgents = new Map<string, HerdrAgent>();
	if (facts.agents !== null) {
		for (const agent of facts.agents) listedAgents.set(agent.paneId, agent);
	}
	// One seat per ticket at most: the ticket's own in-flight seat counts
	// for every unresolved claim it carries.
	const counted = new Set<string>();
	let count = 0;
	const missing: string[] = [];
	for (const ticket of facts.tickets) {
		const state = seatStateOf(ticket, listedAgents, facts.now, facts.startupGraceMs);
		if (state === "missing") {
			missing.push(ticket.ticketIdentity);
			continue;
		}
		count += 1;
		counted.add(ticket.ticketIdentity);
	}
	for (const identity of facts.handoffAttemptTickets) {
		if (!counted.has(identity)) {
			count += 1;
			counted.add(identity);
		}
	}
	count += facts.consultations.filter((consultation) =>
		CONSULTATION_SEAT_STATES.includes(consultation.state),
	).length;
	// A ticket whose unresolved claim holds its seat is not missing for the
	// reservation: its seat is spent on the claim that is starting it, and a
	// reserved seat beside that claim would count the same seat twice.
	return {
		count,
		missingTickets: missing.filter((identity) => !counted.has(identity)),
	};
}

/** The combined Parallel limit seat count the gates and the mode cell share. */
export function parallelSeatCount(facts: ParallelSeatFacts): number {
	return parallelSeatAccount(facts).count;
}

/**
 * The Parallel limit gate (ADR 0034): the seat count stands at or over the
 * limit, so a start that wants a seat finds none free.
 *
 * The rule takes its two facts as data (issue #202). The force-dispatch's
 * three call sites and the screen that fills the Ticket header's mode cell ask
 * the same question, so they call this one rule instead of each restating
 * `limit > 0 && count >= limit` at its own site. A limit of 0 lifts the cap, so
 * it never reads over.
 */
export function overParallelLimit(limit: number, seatCount: number): boolean {
	return limit > 0 && seatCount >= limit;
}

/**
 * The seat reading's text (issue #209): the seats held, beside the limit they
 * are measured against.
 *
 * The Ticket header's mode cell and a dispatch start line state the same
 * measurement in their own words, so the one rule that decides whether a limit
 * is named at all lives here: a limit of 0 states no limit, and the reading
 * names the bare count.
 */
export function parallelSeatText(seats: number, limit: number): string {
	return limit === 0 ? `${seats}` : `${seats}/${limit}`;
}

/**
 * The seat field a start line states (issue #209, issue #220): the held seats
 * beside the limit they are measured against, behind its `seats` word.
 *
 * Three start lines carry the same measurement in the same words -
 * `handoff started:`, `merge started:`, and `consultation started:` - and each
 * belongs to a different module. The field's text lives here beside the count
 * rule and the limit text rule, so the three lines cannot drift the way
 * `parallelSeatText` keeps the count from drifting.
 */
export function parallelSeatReading(seats: number, limit: number): string {
	return `seats ${parallelSeatText(seats, limit)}`;
}
