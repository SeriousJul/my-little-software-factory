/**
 * The provider-neutral factory ticket and its state machine.
 *
 * A ticket state belongs to the factory. Source facts belong to a ticket
 * source and can change during refresh without changing factory state.
 */

export const TICKET_STATES = ["open", "handed-off", "running", "done"] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const ENVIRONMENT_KINDS = ["live-worktree", "worktree", "container"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];
export const HANDOFF_ENVIRONMENT_KINDS = ["live-worktree", "worktree"] as const;

export interface Handoff {
	agentType: string;
	environment: EnvironmentKind;
	taskType: string;
}

/** A stable, host-qualified repository fact supplied by a ticket source. */
export interface RepositoryRef {
	/** For example, github.com/SeriousJul/my-little-software-factory. */
	identity: string;
	/** A compact name for the control plane, for example SeriousJul/factory. */
	displayName: string;
	/** A credential-free clone URL. */
	cloneUrl: string;
}

/** A normalized source fact, independent of factory state. */
export interface FetchedTicket {
	/** Stable provider identity. It must not contain the configured source name. */
	identity: string;
	sourceKind: string;
	externalKey: string;
	sourceState: string;
	url: string;
	title: string;
	description: string;
	labels: string[];
	externalUpdatedAt: string;
	repository: RepositoryRef;
	attributes: Record<string, string>;
}

/** One configured source's current membership of a ticket. */
export interface SourceMembership extends FetchedTicket {
	sourceName: string;
	health: "loading" | "healthy" | "stale" | "removed";
}

/**
 * The factory projection used by the TUI and the handoff boundary.
 *
 * The legacy `repository` and `githubClosed` fields remain as display
 * conveniences. They keep old handoff integrations compatible while new
 * sources use the normalized facts below.
 */
export interface Ticket {
	/** Stable external identity. Legacy tests can still provide a short id. */
	id: string;
	title: string;
	repository: string;
	state: TicketState;
	handoff: Handoff | null;
	githubClosed: boolean;
	description: string;
	identity?: string;
	sourceKind?: string;
	externalKey?: string;
	sourceState?: string;
	url?: string;
	labels?: string[];
	externalUpdatedAt?: string;
	repositoryRef?: RepositoryRef;
	memberships?: SourceMembership[];
	/** The task rule suggestion. The override can replace it for one handoff. */
	suggestedTaskType?: string;
	/** False when no healthy current membership can start work. */
	actionable?: boolean;
	/** A crash left an external handoff outcome uncertain. */
	handoffRecoveryRequired?: boolean;
}

const NEXT_STATE: Record<TicketState, TicketState | null> = {
	open: "handed-off",
	"handed-off": "running",
	running: "done",
	done: null,
};

export function canTransition(from: TicketState, to: TicketState): boolean {
	return NEXT_STATE[from] === to;
}

export function nextStateOf(state: TicketState): TicketState | null {
	return NEXT_STATE[state];
}
