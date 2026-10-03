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
 * and the mode line can never disagree about the count, and a test states the
 * facts instead of opening a state file.
 */
import type { TicketState } from "./domain/ticket.ts";
import { type HerdrAgent, ownAgentInPane } from "./herdr.ts";
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

/** The combined Parallel limit seat count the gates and the mode line share. */
export function parallelSeatCount(facts: ParallelSeatFacts): number {
	const listedAgents = new Map<string, HerdrAgent>();
	if (facts.agents !== null) {
		for (const agent of facts.agents) listedAgents.set(agent.paneId, agent);
	}
	// One seat per ticket at most: the ticket's own in-flight seat counts
	// for every unresolved claim it carries.
	const counted = new Set<string>();
	let count = 0;
	for (const ticket of facts.tickets) {
		// One seat per ticket at most: the ticket's own in-flight seat counts
		// for every unresolved claim it carries. The one missing-Agent rule the
		// observation cycle and the list's failure badge read: the ticket's own
		// agent is the one that runs under the name the ticket's handoff expects.
		// A different agent in the same pane id - herdr handed the closed pane's
		// id out again - holds no seat for the ticket, the way a missing one does.
		const own = ownAgentInPane(
			ticket.paneId === null ? undefined : listedAgents.get(ticket.paneId),
			ticket.agentName,
		);
		const booting = own === null && facts.now - Date.parse(ticket.startedAt) < facts.startupGraceMs;
		if (own !== null || booting) {
			count += 1;
			counted.add(ticket.ticketIdentity);
		}
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
	return count;
}
