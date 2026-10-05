/** Provider-neutral factory ticket types and state transitions. */

import type { TransitionOutcome } from "../config.ts";
import { isHeldCause, type TurnEndCause, type TurnLogEntry } from "../turn-log.ts";

/**
 * The ticket states.
 *
 * A work cycle ends at close: when an agent reports done or idle, the turn
 * settles into `awaiting`, a resting state where the ticket holds its
 * completion for a decision. The operator or an auto-close decision closes
 * the ticket back to `open` with the work cycle incremented, so the cycle
 * never ends in a resting `done` (ADR 0005).
 *
 * A route ask ends the cycle in the same state write that lands the
 * decision: `awaiting` moves to `open` with the cycle incremented, guarded
 * on `awaiting`, and the wait stands on the Work queue's item the ask
 * enqueued. The position's row wears the queue wait's badge while the item
 * stands; a drop or the operator's removal leaves the source `open` with its
 * decision recorded (ADR 0072).
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
 * awaiting state; `merged` and `auto-merged` started the plane action's
 * merge route from the awaiting state (ADR 0068); `closed` and `auto-closed`
 * ended the work cycle; `abandoned` ended a cycle whose agent went
 * missing. Goto is navigation, not a decision (ADR 0033): it focuses the
 * agent's pane and records nothing here.
 */
export type CompletionDecision =
	| "closed"
	| "auto-closed"
	| "abandoned"
	| "handed-off"
	| "auto-handed-off"
	| "merged"
	| "auto-merged";

/** One settled turn of one handoff, as the control plane stored it. */
export interface Completion {
	taskType: string;
	/**
	 * The TransitionOutcome the task type's transition wrote on this turn
	 * (ADR 0027); null when the turn settled without a transition fire.
	 */
	transition: TransitionOutcome | null;
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
	/**
	 * Why the turn ended, the agent's fact read from its session record. A
	 * legacy trace predates the cell and reads `unknown`, which fails open.
	 */
	cause: TurnEndCause;
	/** The agent's or the provider's own text for the cause; empty when none. */
	detail: string;
	/** Null until a decision was made on this completion. */
	decision: CompletionDecision | null;
}

/**
 * Whether a completion holds its turn (ADR 0016, ADR 0017): its end cause is
 * failed, aborted, truncated, or no-turn, and no decision has landed on it
 * yet. A decided held trace is no longer held - the operator already chose -
 * and an `unknown` cause never holds, so a broken record cannot hold a good
 * turn.
 */
export function isHeldCompletion(completion: Completion | null): boolean {
	return completion !== null && completion.decision === null && isHeldCause(completion.cause);
}

/**
 * Where one completion trace sits in the trace table's own order: its
 * completion time, then its row. Two traces completed in the same instant are
 * told apart by the row, so the order is the pair and never the time alone.
 */
export interface CompletionTraceOrder {
	completedAt: string;
	rowId: number;
}

/**
 * Compare two traces in the order the trace table sorts them. The comparison
 * stays inside the module: the rules that need it state their order through
 * `CompletionTraceOrder`, which is the fact, not the comparison.
 */
function completionTraceOrder(left: CompletionTraceOrder, right: CompletionTraceOrder): number {
	return left.completedAt.localeCompare(right.completedAt) || left.rowId - right.rowId;
}

/**
 * The Dispatch pause (ADR 0016): the newest trace whose turn settled `failed`
 * and whose decision has not landed holds every automatic start until the
 * operator decides that turn or another turn settles `completed`.
 *
 * The rule takes the two facts the traces answer as data (issue #202): the
 * held failure, and the newest `completed` trace. The pause clears when a
 * completed trace is newer than the held failure, and the trace order - the
 * completion time, then the row - is what "newer" means. The aggregate reads
 * the two facts and stores no pause: the derived fact stays derived.
 */
export function dispatchPauseHolds(
	heldFailure: CompletionTraceOrder | null,
	newestCompleted: CompletionTraceOrder | null,
): boolean {
	if (heldFailure === null) return false;
	if (newestCompleted === null) return true;
	return completionTraceOrder(newestCompleted, heldFailure) <= 0;
}

/**
 * The turn the Same-type hold reads (ADR 0093): the cause that settled the
 * ticket's newest turn, and the task type that turn ran. The turn stands in the
 * cycle the ticket is in now, or in the closed cycle behind it.
 */
export interface HoldTurnFact {
	cause: string | null;
	taskType: string;
}

/**
 * The Same-type hold (ADR 0026, read as ADR 0093 states it): the ticket's
 * newest turn settled `completed` on exactly the task type the ticket now
 * suggests, so the plane starts no repeat of work that already completed.
 *
 * The rule takes the turn as data (issue #202). Which trace is the ticket's
 * newest turn is the aggregate's read; what that turn means for a suggested
 * task type is this rule.
 */
export function sameTypeHoldHolds(
	holdTurn: HoldTurnFact | null,
	suggestedTaskType: string | null,
): boolean {
	return (
		holdTurn !== null && holdTurn.cause === "completed" && holdTurn.taskType === suggestedTaskType
	);
}

/**
 * The Handoff limit (CONTEXT.md, ADR 0005): the per-ticket cap on started
 * handoffs and plane action attempts that stops the close-and-rehandoff loop.
 *
 * The rule takes its facts as data (issue #202 review): the count the aggregate
 * read, and the cap the config resolved. Every gate that holds an automatic add
 * at the cap - the missing-Agent pass, the auto-advance route, the top-up walk,
 * the restart pass, the force-dispatch pass, the Work queue's Ticket line -
 * asks this rule instead of restating the comparison, so the cap means one
 * thing in one place. A manual handoff or a manual plane action confirm is not
 * this rule's to hold (ADR 0068).
 */
export function handoffLimitReached(handoffCount: number, limit: number): boolean {
	return handoffCount >= limit;
}

/**
 * The in-flight fact of one Ticket state (CONTEXT.md): an Agent works on the
 * Ticket or its start is pending.
 *
 * The state is all the rule reads, so every reader of the fact asks it from the
 * data it already holds - a projection row, a table row, a full Ticket. The
 * Ticket fact module reads it for the row's badge, the in-flight pass, the
 * Restart walk, the Parallel limit seat count, and the claim gates alike, so no
 * surface holds its own spelling of the two states.
 */
export function inFlightState(state: TicketState): boolean {
	return state === "handed-off" || state === "running";
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
	/**
	 * The name the handoff started the agent under; null for handoffs
	 * predating the column. A live agent in the handoff's pane that runs
	 * under any other name is not the handoff's own: herdr hands the id of a
	 * closed pane out again.
	 */
	herdrName: string | null;
}

/** A stable, host-qualified repository fact supplied by a ticket source. */
export interface RepositoryRef {
	identity: string;
	displayName: string;
	cloneUrl: string;
}

/**
 * The attribute key a pull request membership stores its Issue references
 * in (ADR 0042, kept by ADR 0050). The key is the module's own: every reader
 * and writer of the fact goes through `issueReferencesOf` and
 * `withIssueReferences`.
 */
const ISSUE_REFERENCES_ATTRIBUTE = "closes";

/**
 * One Issue reference a pull request membership stores as a source fact
 * (ADR 0042, kept by ADR 0050). The reference is tracked by the issue's identity, which is
 * stable across the repository.
 */
export interface IssueReference {
	/** The issue's stable identity, or null when the source never learned it. */
	identity: string | null;
	/** The issue's number in its repository; what the detail pane names. */
	number: number;
	/** The issue's repository as owner/name, for the direct read's fallback. */
	repository: string;
}

/**
 * The references a membership's attributes store.
 *
 * A pull request's refresh re-reads its closing-issue references, so a
 * malformed or missing fact reads as no references rather than failing the
 * read.
 */
export function issueReferencesOf(attributes: Record<string, string>): IssueReference[] {
	const stored = attributes[ISSUE_REFERENCES_ATTRIBUTE];
	if (stored === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const references: IssueReference[] = [];
	for (const item of parsed) {
		const record = item as Record<string, unknown>;
		const identity =
			typeof record.identity === "string" && record.identity !== "" ? record.identity : null;
		const number = record.number;
		const repository = record.repository;
		if (typeof number !== "number" || typeof repository !== "string") continue;
		references.push({ identity, number, repository });
	}
	return references;
}

/**
 * A membership's attributes with the pull request's Issue references stored
 * (ADR 0042, kept by ADR 0050). A pull request that closes nothing carries no attribute. The
 * references are a source fact like `draft`: a refresh can change them.
 */
export function withIssueReferences(
	attributes: Record<string, string>,
	references: readonly IssueReference[],
): Record<string, string> {
	if (references.length === 0) return attributes;
	return {
		...attributes,
		[ISSUE_REFERENCES_ATTRIBUTE]: JSON.stringify(
			references.map((reference) => ({
				identity: reference.identity,
				number: reference.number,
				repository: reference.repository,
			})),
		),
	};
}

/**
 * The attribute key a pull request membership stores its head branch in
 * (ADR 0042): the branch the pull request pushes from, read from the source.
 * The key is the module's own, the way the Issue references key is.
 */
const HEAD_BRANCH_ATTRIBUTE = "headBranch";

/**
 * The head branch a pull request membership carries, or null when the
 * membership has no such fact: a refresh can change it, and an issue
 * membership never carries one.
 */
export function headBranchOf(attributes: Record<string, string>): string | null {
	const stored = attributes[HEAD_BRANCH_ATTRIBUTE];
	return stored === undefined || stored === "" ? null : stored;
}

/**
 * A membership's attributes with the pull request's head branch stored
 * (ADR 0042). The branch is a source fact like `draft`: a refresh can
 * change it.
 */
export function withHeadBranch(
	attributes: Record<string, string>,
	headBranch: string,
): Record<string, string> {
	if (headBranch === "") return attributes;
	return { ...attributes, [HEAD_BRANCH_ATTRIBUTE]: headBranch };
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

/**
 * The herdr environment of one of the ticket's closed handoffs that outlived
 * its work cycle: a workspace, a tab, or an agent herdr still holds. The
 * Close cleanup could not remove it, or a handoff found its name still taken
 * by the agent it started. It is a fact on the ticket until the operator
 * clears it, and it never blocks a handoff.
 */
export interface LeftoverEnvironment {
	/** The handoff whose environment survived its close. */
	handoffId: string;
	environment: EnvironmentKind;
	/** The herdr workspace still open, when one is recorded. */
	workspaceId: string | null;
	/** The herdr tab still open, when one is recorded. */
	tabId: string | null;
	/** The pane the leftover agent holds, when one is recorded. */
	paneId: string | null;
	/** Why the control plane knows the environment is still alive. */
	reason: string;
	/** When it learned that, in ISO time. */
	at: string;
}

/**
 * The Agent name collision: the fact one Ticket carries when a Handoff start
 * asked herdr for its stable Agent name and herdr refused because a pane the
 * plane does not own holds that name (issue #299, ADR 0107).
 *
 * It is not a Leftover environment. A Leftover environment is the Ticket's own
 * workspace, tab, or Agent that outlived its close, and the plane can name the
 * cleanup that ends it; the holder here belongs to no Handoff the plane made,
 * so the plane owns no cleanup for it and the operator is sent to the pane.
 * The two facts stand apart on the row and in the detail for that reason.
 *
 * The fact is durable until the operator's own Handoff takes the name, and
 * while it stands the Top-up adds no automatic start for the Ticket.
 */
export interface AgentNameCollision {
	/**
	 * The herdr Agent name the holder holds: the Ticket's stable name, or its
	 * work-cycle name when its own Leftover environment held the stable one and
	 * the search reached the next candidate (ADR 0098). The fact names the name
	 * the named pane actually holds, so the operator reads a name there.
	 */
	heldName: string;
	/** The herdr pane that holds the name, when herdr named one. */
	holderPaneId: string | null;
	/** The herdr workspace that holds the name, when herdr named one. */
	holderWorkspaceId: string | null;
	/**
	 * The refusal the Handoff attempt stored, which names the pane and the
	 * workspace. The record line states this same reason, so the row, the
	 * detail, and the file name one refusal (issue #299, issue #231).
	 */
	reason: string;
	/** When the plane last met the refusal, in ISO time. */
	at: string;
}

/**
 * The gate's facts on one Ticket's row (ADR 0060, widened by ADR 0070).
 *
 * The ignore is the operator's act on this Ticket: the flag and the moment it
 * was set are factory state on the ticket row, written by the operator's `i`
 * key alone, and the plane writes nothing to the source. The mute is the
 * operator's act on a source, on the source's row, and the facts widen with it
 * (ADR 0070): a Ticket is withheld and blocked while any of its sources' mute
 * stands, and the moment any of them was set is the newest of them. The state
 * module folds the source flag into these facts in its one read per cycle, so
 * a walk never pays a second projection read for the cause that widened the
 * gate.
 */
export interface TicketIgnoreFacts {
	ignored: boolean;
	ignoredAt: string | null;
	/** Whether any of the Ticket's sources stands muted (ADR 0070). */
	muted: boolean;
	/**
	 * The newest moment any of the Ticket's sources' mute was set (ADR 0070),
	 * null while none of them is muted.
	 */
	mutedAt: string | null;
}

/** The factory projection used by the control plane and handoff boundary. */
export interface Ticket extends TicketIgnoreFacts {
	/** Stable external ticket identity. */
	identity: string;
	title: string;
	/** Short repository display name for list and prompt display. */
	repository: string;
	repositoryRef: RepositoryRef;
	state: TicketState;
	handoff: Handoff | null;
	/** The number of the work cycle the ticket is in now. */
	workCycle: number;
	/** The total handoffs ever recorded for the ticket, across work cycles. */
	handoffCount: number;
	/**
	 * The length of this Ticket's newest run of Handoff attempts that settled
	 * `failed` (issue #298, ADR 0106): the starts that claimed, ran, and started no
	 * Agent. The Failed-start park counts it against half the Handoff limit; any
	 * attempt that settled otherwise, or that has not settled yet, ends the run.
	 */
	failedStartStreak: number;
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
	/**
	 * The task the machine's first matching Workflow state offers, or null
	 * when the ticket sits on a parking state: the control plane does nothing
	 * on it, and only an external label write moves it (ADR 0027). An
	 * operator's handoff of a parked ticket starts the default task type.
	 */
	suggestedTaskType: string | null;
	actionable: boolean;
	handoffRecoveryRequired: boolean;
	/**
	 * The ticket's newest leftover environment that stands unresolved, or
	 * null when nothing of its closed handoffs is still alive in herdr.
	 */
	leftover: LeftoverEnvironment | null;
	/**
	 * The Agent name collision that stands unresolved on the ticket, or null
	 * when no start of this ticket was refused on its stable Agent name
	 * (issue #299, ADR 0107). It is a separate fact from the Leftover
	 * environment above, and no reader folds one into the other.
	 */
	nameCollision: AgentNameCollision | null;
	/**
	 * The name of the first Workflow state whose match holds on the ticket,
	 * or null when no state matches it.
	 *
	 * The projection derives it on every read and never stores it, the way it
	 * derives the Fixing pull request. It exists for the Ticket list's
	 * `position` grouping alone (issue #159): no domain rule, gate, count, or
	 * queue order reads it, so a drift in the name cannot move work.
	 */
	matchedStateName: string | null;
}

/** The marker an observation poll sets on an in-flight ticket. */
export type TicketMarker = "blocked" | "missing";

/**
 * The Ticket section's List filter (ADR 0060, widened by ADR 0070): the
 * operator's view of which rows exist in the list.
 *
 * It is a view fact, not factory state, and it says nothing about any Ticket:
 * the machine's reads always take the active view, whatever the operator's
 * screen shows, and the filter opens on `active` at every boot.
 */
export type TicketListFilter = "active" | "ignored" | "muted" | "all";

/**
 * The next value of the Ticket section's `f` cycle (ADR 0070): the mute's
 * ledger stands beside the ignore's in the same key, so the cycle reads
 * active, ignored, muted, all.
 */
export function nextTicketListFilter(filter: TicketListFilter): TicketListFilter {
	if (filter === "active") return "ignored";
	if (filter === "ignored") return "muted";
	if (filter === "muted") return "all";
	return "active";
}

/**
 * The decision a Ticket owes the operator right now (ADR 0060), or null when
 * it owes none: `awaiting` for the resting state a settled turn leaves, `held`
 * for the newest settled turn that holds its decision, and `missing` for the
 * Agent herdr no longer reports.
 */
export type TicketObligation = "awaiting" | "held" | "missing";

/**
 * Whether a Ticket owes the operator a decision, in one read (ADR 0060).
 *
 * `obligationOf` is the one predicate: the control's availability calls it with
 * the row's facts in hand, and the state's write calls it again as the authority.
 *
 * The ignore ends where an obligation begins: the plane refuses to put away a
 * row the operator still has to act on. The facts are the ones the row's own
 * face reads - the Ticket state, the newest settled turn and its decision, and
 * the latest poll's missing-Agent marker - so the control's availability and
 * the write's refusal can never disagree. The marker is not a Ticket state:
 * the caller passes the same fact the list's failure badge wears.
 */
export function obligationOf(
	ticket: { state: TicketState; lastCompletion: Completion | null },
	marker: TicketMarker | null,
): TicketObligation | null {
	if (ticket.state === "awaiting")
		return isHeldCompletion(ticket.lastCompletion) ? "held" : "awaiting";
	if (marker === "missing") return "missing";
	return null;
}

/** The obligation's own fact, as one clause of the refusal's sentence. */
const OBLIGATION_WORDS: Record<TicketObligation, string> = {
	awaiting: "it awaits a decision",
	held: "its held turn awaits a decision",
	missing: "its Agent is missing",
};

/**
 * Why a Ticket cannot be ignored, in one sentence, or null when it can (ADR 0060).
 *
 * The refusal's words live beside the predicate, so the control's availability
 * and the write's authority state one sentence and cannot drift from it.
 */
export function ignoreRefusal(obligation: TicketObligation | null): string | null {
	return obligation === null
		? null
		: `the selected Ticket cannot be ignored: ${OBLIGATION_WORDS[obligation]}`;
}

/**
 * Whether the operator has judged this Ticket out of the factory's way
 * (ADR 0060, widened by ADR 0070).
 *
 * The one gate on automatic work, named: `judged out means no automatic start,
 * no exception`, and every Top-up walk that holds a projected row asks this
 * predicate instead of re-stating the rule at its own site. It takes the facts
 * and never the row's face - a judged-out Ticket whose row the list reveals
 * for its live work is still no automatic start - and it is a gate on the
 * machine's own starts only: the Pickup, the asked-for start, and the
 * force-dispatch run past it. The operator's own hand is not blocked: a manual
 * start, a manual route, and the pickup of an operator ask all pass the gate,
 * the way they pass the ignore.
 *
 * The facts the predicate reads are the Ticket's flag and the mute of the
 * Ticket's sources (ADR 0070): the act on the source withholds and blocks the
 * same way the act on the ticket does, and the state module folds both into
 * the row's facts in its one read per cycle, so no walk pays a second
 * projection read for the widened gate. The Restart walk reads the in-flight
 * rows, which carry no facts of their own, so it asks
 * `TicketWorkCycleAggregate.automaticStartBlockedTickets` once per cycle: the same columns
 * on the same rows, read by identity instead of by row.
 */
export function automaticStartBlocked(ticket: TicketIgnoreFacts): boolean {
	return ticket.ignored || ticket.muted;
}

/**
 * Whether a flag takes this Ticket's row out of the list (ADR 0060, widened
 * by ADR 0070).
 *
 * The flag withholds a resting Ticket and never a live one, the ignore and
 * the mute alike: a Ticket with an Agent in flight keeps the row its Live
 * view, Goto, and Close hang from, because there is live work to reach, and a
 * Ticket whose turn settled keeps the row its decision lives on. The flags
 * stay set under both - only the operator's own keys clear them - so the row
 * wears its `ignored` and `muted` markers beside its own state badge while
 * the work runs, and goes back into the list when the cycle ends and the
 * Ticket rests `open` again, the flag's view aside.
 *
 * This is ADR 0042's shape for the same reason: the in-flight states are never
 * covered, so live work stays listed whatever pull requests exist, and the
 * mute ends where an obligation begins in the ignore's own shape. Because
 * every obligation the refusal predicate names lives on a non-`open` Ticket,
 * the rule hides no obligation at all: a flagged Held turn never stalls the
 * factory behind an empty list.
 */
export function flagWithholdsRow(ticket: TicketIgnoreFacts & { state: TicketState }): boolean {
	return automaticStartBlocked(ticket) && ticket.state === "open";
}

/**
 * The Attention band of a ticket: the list's first sort (ADR 0050).
 *
 * It is the invisible rank the rows read, never a visible thing: the flat
 * list orders by it, and a Group's rows stand in it inside the Group
 * (ADR 0070 orders the Groups themselves, by the axis' own values). Awaiting
 * work comes first, then the in-flight states with the running turn ahead of
 * the handoff that started it, then open work the factory can act on, then
 * open work it cannot. A state the plane has no band for stands last, so a
 * fact it does not know cannot outrank a decision.
 */
export function attentionBand(ticket: Ticket): number {
	if (ticket.state === "awaiting") return 0;
	if (ticket.state === "running") return 1;
	if (ticket.state === "handed-off") return 2;
	if (ticket.state === "open" && ticket.actionable) return 3;
	if (ticket.state === "open") return 4;
	return 5;
}

/**
 * The number a source-visible external key carries (`#5` is 5), or null when
 * the key names none.
 */
export function externalKeyNumber(key: string): number | null {
	const match = /^#(\d+)$/.exec(key);
	return match === null ? null : Number(match[1]);
}

/**
 * The ticket's second rank inside its Attention band, smaller stands first
 * (ADR 0050 for the live bands, ADR 0065 for the open ones).
 *
 * The live bands - awaiting, running, and handed-off - keep the rank
 * ADR 0050 made: the newest external update first, the update as a negative
 * epoch so the newest is the smallest. The open bands order by the ticket
 * number ascending, the ticket whose key names no number after every numbered
 * one: the number never changes under a refresh, so the rows of the open pile
 * hold their place. The live ranks are negative and the open ranks
 * non-negative, so the rank of a ticket's best band always stands in the
 * regime of that band.
 */
export function ticketListRank(ticket: Ticket): number {
	if (ticket.state === "awaiting" || ticket.state === "running" || ticket.state === "handed-off") {
		const ms = Date.parse(ticket.externalUpdatedAt);
		return -(Number.isNaN(ms) ? 0 : ms);
	}
	return externalKeyNumber(ticket.externalKey) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Whether a Ticket holds a decision the operator owes (ADR 0016, ADR 0017).
 *
 * The held turn is an awaiting ticket whose last settled turn ended failed,
 * aborted, truncated, or with no turn, and carries no decision yet. Every
 * surface that marks or counts one reads this rule: the row's `held` badge,
 * the detail pane's warning, the Section header's held count, and a Group
 * header's held count. The last two must agree beside the same title, so the
 * test of the state stands here and not at each call site: a held turn whose
 * agent works again has left `awaiting` and is retried, not held.
 */
export function holdsDecision(ticket: Ticket): boolean {
	return ticket.state === "awaiting" && isHeldCompletion(ticket.lastCompletion);
}

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
 * - handed-off/running -> open: the operator closed a work cycle whose turn
 *   never settled (ADR 0031). No trace row records that end.
 * - awaiting -> handed-off: a workflow handoff or a restart started a new
 *   turn in the same cycle.
 * - awaiting -> running: the poll saw the agent working again on its
 *   still-pending turn.
 * - awaiting -> open: the route's ask ended the cycle in the same write that
 *   landed the decision, the route's wait standing on the Work queue's item
 *   (ADR 0064, ADR 0072).
 *
 * A settle may land directly from handed-off: an agent can finish inside
 * one poll interval, before a working observation ever saw it. The settle
 * then waits out the startup grace, the window in which a booted agent
 * reports idle before it picks up the prompt and starts working.
 *
 * The two in-flight states reach `open` directly, because key `w` closes a
 * cycle the agent is still working in (ADR 0031). That close ends the cycle
 * with no completion trace, so the cycle-end gates read no row for it: the
 * move stands in the state line, and no trace row carries it.
 */
const TRANSITIONS: Record<TicketState, readonly TicketState[]> = {
	open: ["handed-off"],
	"handed-off": ["running", "awaiting", "open"],
	running: ["awaiting", "open"],
	awaiting: ["open", "handed-off", "running"],
};

/** Whether a ticket may move from one state to another. */
export function canTransition(from: TicketState, to: TicketState): boolean {
	return TRANSITIONS[from].includes(to);
}
