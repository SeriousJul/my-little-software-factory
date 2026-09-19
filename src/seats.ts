/**
 * The one count the Parallel limit reads (ADR 0034).
 *
 * The cap counts every kind of running work in one number: an in-flight
 * ticket whose agent the latest poll listed, an in-flight ticket whose agent
 * herdr has not listed yet (still inside the startup grace, or a handoff
 * still in progress), and every Consultation in `opening` or `working`. The
 * observation cycle's gates and the mode line's count both read this one
 * function, so the two can never disagree.
 */

/** The in-flight ticket facts the seat count needs. */
export interface SeatTicket {
	ticketIdentity: string;
	paneId: string | null;
	startedAt: string;
}

/** The facts one seat count reads. */
export interface SeatCountInput {
	/** The tickets in the in-flight states (handed-off, running). */
	tickets: readonly SeatTicket[];
	/** The tickets with a handoff attempt still unresolved. */
	openAttempts: readonly string[];
	/** The Consultation seats held beside the ticket seats. */
	consultationSeats: number;
	/** The agents of the latest successful poll, or null before the first. */
	agents: readonly { paneId: string }[] | null;
	now: () => number;
	/** The startup grace a fresh handoff's agent waits out. */
	startupGraceMs: number;
}

/**
 * The Parallel limit seats held by the given facts.
 *
 * An in-flight ticket holds a seat while its agent is alive in the poll, or
 * while the agent has not been listed yet inside the startup grace. An
 * unresolved handoff attempt holds a seat for the work it claimed. A missing
 * agent past the grace holds none, so the restart path can refill the seat.
 */
export function parallelSeatCount({
	tickets,
	openAttempts,
	consultationSeats,
	agents,
	now,
	startupGraceMs,
}: SeatCountInput): number {
	const listed = new Set((agents ?? []).map((agent) => agent.paneId));
	const counted = new Set<string>();
	let count = 0;
	for (const ticket of tickets) {
		const isListed = ticket.paneId !== null && listed.has(ticket.paneId);
		const booting = !isListed && now() - Date.parse(ticket.startedAt) < startupGraceMs;
		if (isListed || booting) {
			count += 1;
			counted.add(ticket.ticketIdentity);
		}
	}
	for (const identity of openAttempts) {
		if (!counted.has(identity)) count += 1;
	}
	return count + Math.max(0, consultationSeats);
}
