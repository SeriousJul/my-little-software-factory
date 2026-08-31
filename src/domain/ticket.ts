/**
 * The factory domain: the Ticket type and the ticket state machine.
 *
 * Terms here are defined in CONTEXT.md at the repo root.
 * A ticket is a unit of work sourced from GitHub. Its position in the
 * factory is the ticket state. GitHub's own open/closed status is a
 * separate source fact, not a ticket state.
 */

export const TICKET_STATES = ["open", "handed-off", "running", "done"] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/**
 * Where an agent runs a ticket.
 *
 * `container` is a reserved future kind: it exists in the domain, is not
 * implemented, and is not offered for a handoff.
 */
export const ENVIRONMENT_KINDS = ["live-worktree", "worktree", "container"] as const;

export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** The environment kinds a handoff can use today. */
export const HANDOFF_ENVIRONMENT_KINDS = ["live-worktree", "worktree"] as const;

/**
 * The facts of the last handoff of a ticket: which agent type was started,
 * where it runs, and which task type shaped its prompt.
 */
export interface Handoff {
	agentType: string;
	environment: EnvironmentKind;
	taskType: string;
}

export interface Ticket {
	/** Factory-local identifier. */
	id: string;
	title: string;
	/** The repository this ticket belongs to, e.g. "acme/billing". */
	repository: string;
	/** The ticket's position in the factory. */
	state: TicketState;
	/** The facts of the last handoff, if the ticket has been handed off. */
	handoff: Handoff | null;
	/** Source fact: whether the ticket is closed on GitHub. */
	githubClosed: boolean;
	description: string;
}

/**
 * The ticket state machine. The states form a line:
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

/** The next state in the line, or null when the ticket is done. */
export function nextStateOf(state: TicketState): TicketState | null {
	return NEXT_STATE[state];
}
