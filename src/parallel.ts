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
 * The readers pass the same ingredients - the state database, the latest
 * successful agent list (null before the first success or while it fails),
 * the clock, and the Startup grace - so the gates and the mode line can
 * never disagree about the count.
 */
import type { TicketState } from "./domain/ticket.ts";
import { type HerdrAgent, ownAgentInPane } from "./herdr.ts";
import type { ConsultationState, FactoryState } from "./state.ts";

/** The Consultation states that hold a Parallel limit seat. */
export const CONSULTATION_SEAT_STATES: readonly ConsultationState[] = ["opening", "working"];

/** The ticket states that can hold a Parallel limit seat. */
const TICKET_SEAT_STATES: readonly TicketState[] = ["handed-off", "running"];

export interface ParallelSeatCountInput {
	/** The factory state: the tickets, the handoff claims, the Consultations. */
	state: FactoryState;
	/** The latest successful herdr agent list; null until it holds one. */
	agents: readonly HerdrAgent[] | null;
	/** The clock, in epoch milliseconds. */
	now: number;
	/** The Startup grace a started agent waits out, in milliseconds. */
	startupGraceMs: number;
}

/** The combined Parallel limit seat count the gates and the mode line share. */
export function parallelSeatCount(input: ParallelSeatCountInput): number {
	const listedAgents = new Map<string, HerdrAgent>();
	if (input.agents !== null) {
		for (const agent of input.agents) listedAgents.set(agent.paneId, agent);
	}
	const inFlight = input.state.ticketsByState(TICKET_SEAT_STATES);
	// One seat per ticket at most: the ticket's own in-flight seat counts
	// for every unresolved claim it carries.
	const counted = new Set<string>();
	let count = 0;
	for (const ticket of inFlight) {
		// One seat per ticket at most: the ticket's own in-flight seat counts
		// for every unresolved claim it carries. The one missing-Agent rule the
		// observation cycle and the list's failure badge read: the ticket's own
		// agent is the one that runs under the name the ticket's handoff expects.
		// A different agent in the same pane id - herdr handed the closed pane's
		// id out again - holds no seat for the ticket, the way a missing one does.
		const own = ownAgentInPane(
			ticket.paneId === null ? undefined : listedAgents.get(ticket.paneId),
			input.state.agentNameForTicket(ticket.ticketIdentity),
		);
		const booting = own === null && input.now - Date.parse(ticket.startedAt) < input.startupGraceMs;
		if (own !== null || booting) {
			count += 1;
			counted.add(ticket.ticketIdentity);
		}
	}
	for (const identity of input.state.openAttemptTickets()) {
		if (!counted.has(identity)) {
			count += 1;
			counted.add(identity);
		}
	}
	count += input.state.consultationsByState(CONSULTATION_SEAT_STATES).length;
	return count;
}
