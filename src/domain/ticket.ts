/** Provider-neutral factory ticket types and state transitions. */

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
	identity: string;
	displayName: string;
	cloneUrl: string;
}

/** A normalized source fact, independent of factory state. */
export interface FetchedTicket {
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

/** The factory projection used by the control plane and handoff boundary. */
export interface Ticket {
	/** Stable external ticket identity. */
	identity: string;
	title: string;
	/** Short repository display name for list and prompt display. */
	repository: string;
	repositoryRef: RepositoryRef;
	state: TicketState;
	handoff: Handoff | null;
	description: string;
	sourceKind: string;
	externalKey: string;
	sourceState: string;
	url: string;
	labels: string[];
	externalUpdatedAt: string;
	memberships: SourceMembership[];
	suggestedTaskType: string;
	actionable: boolean;
	handoffRecoveryRequired: boolean;
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
