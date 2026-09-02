/** Provider-neutral factory ticket types and state transitions. */

import type { TurnLogEntry } from "../turn-log.ts";

/**
 * The ticket states.
 *
 * A work cycle ends at close: when an agent reports done or idle, the turn
 * settles into `awaiting`, a resting state where the ticket holds its
 * completion for a decision. The operator or an auto-close decision closes
 * the ticket back to `open` with the work cycle incremented, so the cycle
 * never ends in a resting `done` (ADR 0005).
 */
export const TICKET_STATES = ["open", "handed-off", "running", "awaiting"] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const ENVIRONMENT_KINDS = ["live-worktree", "worktree", "container"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];
export const HANDOFF_ENVIRONMENT_KINDS = ["live-worktree", "worktree"] as const;

/**
 * The decision the control plane applies on one turn.
 *
 * The trace records the decisions that decide the settled turn:
 * `handed-off` and `auto-handed-off` started a workflow handoff from the
 * awaiting state; `closed` and `auto-closed` ended the work cycle;
 * `abandoned` ended a cycle whose agent went missing. `goto` is a state
 * move, not a completion decision: it refocused the existing agent and
 * moved the ticket back to running, and the trace does not record it. The
 * turn's pending trace stays pending, and the next settle refreshes it.
 */
export type CompletionDecision =
	| "closed"
	| "auto-closed"
	| "abandoned"
	| "handed-off"
	| "auto-handed-off"
	| "goto";

/** One settled turn of one handoff, as the control plane stored it. */
export interface Completion {
	taskType: string;
	agentType: string;
	agentName: string;
	/** The model the handoff passed to its Agent, empty when left to the Agent. */
	model: string;
	/** The thinking level the handoff passed to its Agent, empty when left to the Agent. */
	thinking: string;
	/** The maximum context window in digits, empty when left to the Agent. */
	contextWindow: string;
	completedAt: string;
	/** The last captured message of the settled agent turn. */
	message: string;
	/** The agent's messages of the turn, in order; the decision modal's body. */
	turnLog: TurnLogEntry[];
	/** Null until a decision was made on this completion. */
	decision: CompletionDecision | null;
}

/** The latest handoff of a ticket, including the herdr handles it started. */
export interface Handoff {
	agentType: string;
	environment: EnvironmentKind;
	taskType: string;
	model: string;
	thinking: string;
	/** The maximum context window in digits, empty when left to the Agent. */
	contextWindow: string;
	attemptId: string;
	/** The pane the agent started in; null for handoffs predating handles. */
	paneId: string | null;
	/** The tab the handoff created; null for handoffs predating handles. */
	tabId: string | null;
	/** The workspace the handoff ran in; null for handoffs predating handles. */
	workspaceId: string | null;
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
	/** The total handoffs ever recorded for the ticket, across work cycles. */
	handoffCount: number;
	/** The ticket's latest settled turn, or null when none settled yet. */
	lastCompletion: Completion | null;
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

/** The marker an observation poll sets on an in-flight ticket. */
export type TicketMarker = "blocked" | "missing";

/**
 * The state line and its moves.
 *
 * - open -> handed-off: a handoff started the agent.
 * - handed-off -> running: herdr reports the agent working.
 * - handed-off/running -> awaiting: herdr reports the agent done or idle,
 *   and the turn settled. A handed-off ticket waits out its startup grace
 *   first: its agent may still be booting.
 * - awaiting -> open: the operator or an auto-close decision closed the
 *   work cycle.
 * - awaiting -> handed-off: a workflow handoff or a restart started a new
 *   turn in the same cycle.
 * - awaiting -> running: goto refocused the existing agent, or the poll
 *   saw the agent working again on its still-pending turn.
 *
 * A settle may land directly from handed-off: an agent can finish inside
 * one poll interval, before a working observation ever saw it. The settle
 * then waits out the startup grace, the window in which a booted agent
 * reports idle before it picks up the prompt and starts working.
 */
const TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
	open: ["handed-off"],
	"handed-off": ["running", "awaiting"],
	running: ["awaiting"],
	awaiting: ["open", "handed-off", "running"],
};

/** Whether a ticket may move from one state to another. */
export function canTransition(from: TicketState, to: TicketState): boolean {
	return TRANSITIONS[from].includes(to);
}
