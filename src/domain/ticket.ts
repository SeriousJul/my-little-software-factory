/**
 * The factory domain: the Ticket type and the ticket state machine.
 *
 * Terms here are defined in CONTEXT.md at the repo root.
 * A ticket is a unit of work sourced from GitHub. Its position in the
 * factory pipeline is the ticket state. GitHub's own open/closed status is
 * a separate source fact, not a ticket state.
 */

export const TICKET_STATES = ["open", "handed-off", "running", "done"] as const;

export type TicketState = (typeof TICKET_STATES)[number];

export interface Ticket {
	/** Factory-local identifier. */
	id: string;
	title: string;
	/** The repository this ticket belongs to, e.g. "acme/billing". */
	repository: string;
	/** The ticket's position in the factory pipeline. */
	state: TicketState;
	/**
	 * The assigned agent, if any. Agent-agnostic: a name or runtime identifier,
	 * no assumed runtime. Data only. The control plane launches no agents.
	 */
	agent: string | null;
	/** Source fact: whether the GitHub issue is closed. */
	githubClosed: boolean;
	description: string;
}

/**
 * The ticket state machine. The pipeline is a line:
 *
 *   open -> handed-off -> running -> done
 *
 * `handed-off` and `running` gain real meaning when handoff lands and the
 * control plane observes an agent process. For now they are positions.
 */
const NEXT_STATE: Record<TicketState, TicketState | null> = {
	open: "handed-off",
	"handed-off": "running",
	running: "done",
	done: null,
};

/** Whether a ticket may move from `from` to `to`. Forward steps only. */
export function canTransition(from: TicketState, to: TicketState): boolean {
	return NEXT_STATE[from] === to;
}

/** The next state in the pipeline, or null when the ticket is done. */
export function nextStateOf(state: TicketState): TicketState | null {
	return NEXT_STATE[state];
}

/**
 * Move a ticket one step forward in the pipeline.
 *
 * Pure: returns a new ticket, does not mutate the input.
 * Throws when the ticket is already done.
 */
export function advanceTicket(ticket: Ticket): Ticket {
	const next = NEXT_STATE[ticket.state];
	if (next === null) {
		throw new Error(`ticket ${ticket.id} is already done`);
	}
	return { ...ticket, state: next };
}
