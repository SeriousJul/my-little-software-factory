/**
 * The ticket work cycle aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 *
 * The methods on `TicketWorkCycleAggregate` are the aggregate's interface: what a
 * caller outside the module may reach. The other public methods are the narrow
 * operations this aggregate publishes to the module for another aggregate to
 * call (issue #202, ADR 0095). No caller outside the module reaches them, and
 * the boundary check refuses one that does.
 */

import { randomUUID } from "node:crypto";
import type { TransitionOutcome, WorkflowState } from "../config.ts";
import type {
	AgentNameCollision,
	Completion,
	CompletionDecision,
	LeftoverEnvironment,
	Ticket,
	TicketListFilter,
	TicketMarker,
	TicketObligation,
	TicketState,
} from "../domain/ticket.ts";
import {
	attentionBand,
	type CompletionTraceOrder,
	dispatchPauseHolds,
	flagWithholdsRow,
	ignoreRefusal,
	inFlightState,
	obligationOf,
	sameTypeHoldHolds,
	ticketListRank,
} from "../domain/ticket.ts";
import { agentNameFor } from "../naming.ts";
import { matchState, taskTypeOfMatch } from "../task-selection.ts";
import type { TurnEndCause, TurnLogEntry } from "../turn-log.ts";
import {
	EMPTY_PULL_REQUEST_SKIP,
	isCoveredByFixingPullRequest,
	NO_LINKED_PULL_REQUEST_SKIP,
} from "../workflow.ts";
import { identityChunks, placeholders } from "./batch.ts";
import type { StateGraph } from "./graph.ts";
import { type HandoffTicket, type StoredHandoff, ticketHandoffFact } from "./handoff.ts";
import { transitionOf, turnEndCauseOf, turnLogOf } from "./json.ts";
import type { StoredMembership } from "./source-fact.ts";
import type { StateScope, StateStore } from "./store.ts";
import { TABLES_OWNED } from "./tables.ts";

export interface SettleTurnInput {
	ticketIdentity: string;
	/** The attempt id of the handoff whose turn settled. */
	handoffId: string;
	taskType: string;
	agentType: string;
	message: string;
	/** The agent's messages of the turn, in order, from its session record. */
	turnLog: TurnLogEntry[];
	/**
	 * Why the turn ended, from its session record. Omitted when the settler
	 * has no record to read, and stored as `unknown`: a settle without a cause
	 * fails open, so it neither holds nor pauses.
	 */
	cause?: TurnEndCause;
	/** The agent's or the provider's own text for the cause; empty when none. */
	detail?: string;
	completedAt: string;
	/**
	 * The transition the plane fired on this completed turn (ADR 0027). The
	 * trace holds its outcome, so the decision modal and the automatic
	 * decision read the facts the plane wrote, not a re-read of the source.
	 * Null: the settle fired no transition (not completed, no transition
	 * configured, or the fire refused).
	 */
	transition?: TransitionOutcome | null;
}
export interface CompletionDecisionInput {
	ticketIdentity: string;
	/** The attempt id of the handoff the decision was made on. */
	handoffId: string;
	decision: CompletionDecision;
	decidedAt: string;
}
/**
 * The work cycle's own two facts about a Ticket: where the cycle stands and
 * how many cycles have run. The Handoff gates read them through
 * `ticketCycleFacts`, the narrow operation the Ticket work cycle publishes to
 * the module (issue #202, ADR 0095).
 */
export interface TicketCycle {
	state: TicketState;
	workCycle: number;
}
export interface TicketListViews {
	/** The rows the Ticket section draws, in the operator's List filter. */
	rows: readonly Ticket[];
	/** The active view: the machine's rows, the header's counts, and the bell. */
	active: readonly Ticket[];
	/** The rows the flag names: the pile the `ignored` view shows and the header count. */
	ignored: readonly Ticket[];
	/**
	 * The rows the mute names (ADR 0070): the ledger of the source acts, every
	 * ticket of a muted source, and the header's `muted` count.
	 *
	 * It is read over the projection before the list rule, the way the pile
	 * reads the ticket flag: it is the ledger of the source acts, live rows and
	 * covered rows alike, because the only key that ends a mute rides on a row
	 * the operator can reach.
	 */
	muted: readonly Ticket[];
	/**
	 * The whole projection, before the list rule: the reads that resolve a Ticket
	 * by identity, never the rows the operator happens to be shown.
	 *
	 * It is not the `all` value of the List filter. That view is the *list*: the
	 * covered rule still holds its rows out, and only the flags' withhold is
	 * lifted. This is the projection the list rule is applied to.
	 */
	projection: TicketProjection;
}
/**
 * One Ticket projection read, held as a value (ADR 0042, ADR 0093).
 *
 * The aggregate makes every one: `ticketListViews`'s own `projection` view, and
 * `ticketProjection` for a caller that holds no read of its own. No caller
 * builds one by hand, so the read a derivation takes is always a read the
 * aggregate actually ran. The Next step derivation reads the position's row out
 * of it, and a value a caller made up - an empty list, a partial list - silently
 * answers `position-offers-no-task` for every step and routes nothing.
 */
export interface TicketProjection {
	/** The projected rows, before the list rule. */
	readonly rows: readonly Ticket[];
	/** The row of one identity, or undefined when the projection holds none. */
	rowFor(identity: string): Ticket | undefined;
}

/**
 * The read value over rows the aggregate just read.
 *
 * Private to this module: the only way to hold a projection is to ask the
 * aggregate for one.
 */
function ticketProjectionOf(rows: readonly Ticket[]): TicketProjection {
	return {
		rows,
		rowFor: (identity: string) => rows.find((candidate) => candidate.identity === identity),
	};
}
export function inMemoryTicketViews(projection: readonly Ticket[]): TicketListViews {
	// Each view is its own array, so an in-place reorder of one can never reach
	// another: the shell's whole point is that its three views agree, and that
	// agreement is a fact of the rule, not of an alias.
	const rows = [...projection];
	return {
		rows,
		active: [...rows],
		ignored: [],
		muted: [],
		projection: ticketProjectionOf([...rows]),
	};
}
export function listTicketViews(
	projection: readonly Ticket[],
	filter: TicketListFilter,
): TicketListViews {
	const ordered = [...projection].sort(
		(left, right) =>
			attentionBand(left) - attentionBand(right) ||
			ticketListRank(left) - ticketListRank(right) ||
			left.identity.localeCompare(right.identity),
	);
	const listed = ordered.filter((ticket) => !isCoveredByFixingPullRequest(projection, ticket));
	// The pile is every row the ticket flag stands on - the ledger of what the
	// operator put away ticket by ticket, including a Ticket the list shows
	// again while its work is live or its decision stays owed, and one the
	// covered rule takes out of the list.
	const ignored = ordered.filter((ticket) => ticket.ignored);
	// The muted view reads the source flag over the projection before the list
	// rule, the way the pile reads the ticket flag: the ledger of the source
	// acts, live and covered tickets of a muted source alike (ADR 0070).
	const muted = ordered.filter((ticket) => ticket.muted);
	// The active view is the machine's read: every row the list rule leaves,
	// which is the drawn rows except the ones the flags withhold while they
	// rest.
	const active = listed.filter((ticket) => !flagWithholdsRow(ticket));
	return {
		rows:
			filter === "active"
				? active
				: filter === "ignored"
					? ignored
					: filter === "muted"
						? muted
						: listed,
		active,
		ignored,
		muted,
		projection: ticketProjectionOf([...projection]),
	};
}

export interface TicketWorkCycleAggregate {
	projectedTickets(states: readonly WorkflowState[], fallbackTaskType: string): Ticket[];
	/**
	 * The projection read a derivation takes (ADR 0042, ADR 0093): one
	 * `projectedTickets` read held as the value the Next step derivation asks its
	 * gates of. A caller that holds no read of its own asks here; a caller that
	 * already read the pile hands its own value down.
	 */
	ticketProjection(states: readonly WorkflowState[], fallbackTaskType: string): TicketProjection;
	ticketListViews(
		states: readonly WorkflowState[],
		fallbackTaskType: string,
		filter?: TicketListFilter,
	): TicketListViews;
	lastCompletion(identity: string): Completion | null;
	recordSkipRefire(ticketIdentity: string, outcome: TransitionOutcome): boolean;
	recordedTransitionJson(ticketIdentity: string): string | null;
	recordRefiredOutcome(
		ticketIdentity: string,
		recordedJson: string,
		outcome: TransitionOutcome,
	): boolean;
	dispatchPauseActive(): boolean;
	sourceReverifiedSinceCycleEnd(identity: string): boolean;
	sameTypeHoldActive(identity: string, suggestedTaskType: string | null): boolean;
	ignoredTickets(): Set<string>;
	setTicketIgnored(
		identity: string,
		ignored: boolean,
		marker?: TicketMarker | null,
	): { ok: true } | { ok: false; reason: string };
	ticketState(identity: string): TicketState | undefined;
	agentNameForTicket(identity: string): string;
	agentNamesForTickets(identities: readonly string[]): Map<string, string>;
	automaticStartBlockedTickets(): Set<string>;
	/**
	 * Whether this one Ticket stands judged out of the factory's way (ADR 0060,
	 * ADR 0070): its own ignore, or the mute of one of its sources. The set read
	 * above answers the predicate for a walk that holds every row; this is the read
	 * a walk takes when it reached one candidate and the Failed-start park has to
	 * know whether the operator already answered the failure (issue #298).
	 */
	automaticStartBlockedTicket(ticketIdentity: string): boolean;
	ticketsByState(states: readonly TicketState[]): HandoffTicket[];
	markTicketRunning(identity: string): boolean;
	reopenTurn(identity: string, handoffId: string): boolean;
	settleTurn(input: SettleTurnInput): void;
	applyCompletionDecision(input: CompletionDecisionInput): boolean;
	closeWorkCycle(ticketIdentity: string): boolean;
}

/** The completion trace cells a read maps into a `Completion`. */
const COMPLETION_COLUMNS =
	"task_type, agent_type, agent_name, model, thinking, context_window, completed_at, last_message, turn_log_json, cause, detail, decision, transition_json";
interface CompletionRow {
	task_type: string;
	agent_type: string;
	agent_name: string;
	model: string;
	thinking: string;
	context_window: string;
	completed_at: string;
	last_message: string;
	turn_log_json: string | null;
	cause: string | null;
	detail: string | null;
	decision: string | null;
	transition_json: string | null;
}
function completionFromRow(row: CompletionRow): Completion {
	return {
		taskType: row.task_type,
		agentType: row.agent_type,
		agentName: row.agent_name,
		model: row.model,
		thinking: row.thinking,
		contextWindow: row.context_window,
		completedAt: row.completed_at,
		message: row.last_message,
		turnLog: turnLogOf(row.turn_log_json, row.last_message),
		cause: turnEndCauseOf(row.cause),
		detail: row.detail ?? "",
		decision: row.decision as CompletionDecision | null,
		transition: transitionOf(row.transition_json),
	};
}

/** One row of the tickets table, as the projection read names it. */
type TicketRow = {
	identity: string;
	state: TicketState;
	work_cycle: number;
	ignored: number;
	ignored_at: string | null;
};

/** The projection's batched reads, one statement per chunk of the list. */
interface ProjectionReads {
	memberships: Map<string, StoredMembership[]>;
	pendingTickets: Set<string>;
	newestHandoffs: Map<string, StoredHandoff>;
	handoffCounts: Map<string, number>;
	failedStartStreaks: Map<string, number>;
	completions: Map<string, Completion | null>;
	leftovers: Map<string, LeftoverEnvironment[]>;
	nameCollisions: Map<string, AgentNameCollision>;
}

/** The standing the row's state and its memberships give it (issue #345). */
function ticketStanding(
	row: TicketRow,
	storedMemberships: StoredMembership[],
	pending: boolean,
): { actionable: boolean; listActionable: boolean; ignored: boolean } {
	const active = storedMemberships.filter(
		(membership) => membership.active && membership.health !== "removed",
	);
	const actionable =
		row.state === "open" &&
		!pending &&
		active.some((membership) => membership.health === "healthy");
	// The standing the Ticket list's Attention band reads (issue #345): the
	// row lists on a source the Config still holds, and that source's last
	// read did not fail. A `removed` source is already out of `active`, so the
	// one health left that holds a row out of the pile is `stale`: a read that
	// failed. `loading` is this run's fetch schedule and no fact about the
	// Ticket, so it moves no row - the boot, and the config write-back that
	// re-runs the refresh, never reorder the open work.
	const listActionable =
		row.state === "open" &&
		!pending &&
		active.some((membership) => membership.health === "healthy" || membership.health === "loading");
	const ignored = row.ignored === 1;
	return { actionable, listActionable, ignored };
}

/** The source facts the row's newest membership carries. */
function ticketFactsOf(storedMemberships: StoredMembership[]): StoredMembership | undefined {
	return [...storedMemberships].sort(
		(a, b) =>
			b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
			a.sourceName.localeCompare(b.sourceName),
	)[0];
}

/** The mute of the ticket's sources (ADR 0070). */
function ticketMute(storedMemberships: StoredMembership[]): {
	muted: boolean;
	mutedAt: string | null;
} {
	// The mute of the ticket's sources, folded into the row's facts in this
	// one read (ADR 0070): the gate and the list rule both read the facts,
	// and a ticket is withheld and blocked while any of its sources' mute
	// stands. The moment any of them was set is the newest of them.
	let muted = false;
	let mutedAt: string | null = null;
	for (const membership of storedMemberships) {
		if (!membership.sourceMuted) continue;
		muted = true;
		if (
			mutedAt === null ||
			(membership.sourceMutedAt !== null && membership.sourceMutedAt > mutedAt)
		)
			mutedAt = membership.sourceMutedAt;
	}
	return { muted, mutedAt: muted ? mutedAt : null };
}

/** The Ticket one row's facts build. */
function projectedTicketOf(fields: {
	row: TicketRow;
	facts: StoredMembership;
	handoff: ReturnType<typeof ticketHandoffFact>;
	matched: WorkflowState | null;
	standing: { actionable: boolean; listActionable: boolean; ignored: boolean };
	mute: { muted: boolean; mutedAt: string | null };
	reads: ProjectionReads;
	states: readonly WorkflowState[];
	fallbackTaskType: string;
	memberships: StoredMembership[];
}): Ticket {
	const { row, facts, handoff, matched, standing, mute, reads, fallbackTaskType, memberships } =
		fields;
	return {
		identity: row.identity,
		title: facts.title,
		repository: facts.repository.displayName,
		state: row.state,
		handoff,
		workCycle: row.work_cycle,
		handoffCount: reads.handoffCounts.get(row.identity) ?? 0,
		failedStartStreak: reads.failedStartStreaks.get(row.identity) ?? 0,
		lastCompletion: reads.completions.get(row.identity) ?? null,
		description: facts.description,
		sourceKind: facts.sourceKind,
		externalKey: facts.externalKey,
		sourceState: facts.sourceState,
		url: facts.url,
		labels: facts.labels,
		externalUpdatedAt: facts.externalUpdatedAt,
		repositoryRef: facts.repository,
		memberships: memberships.map(
			({ active: _active, sourceMuted: _muted, sourceMutedAt: _mutedAt, ...membership }) =>
				membership,
		),
		suggestedTaskType: taskTypeOfMatch(matched, fallbackTaskType),
		matchedStateName: matched === null ? null : matched.name,
		actionable: standing.actionable,
		listActionable: standing.listActionable,
		handoffRecoveryRequired: reads.pendingTickets.has(row.identity),
		leftover: reads.leftovers.get(row.identity)?.[0] ?? null,
		nameCollision: reads.nameCollisions.get(row.identity) ?? null,
		ignored: standing.ignored,
		ignoredAt: standing.ignored ? row.ignored_at : null,
		muted: mute.muted,
		mutedAt: mute.muted ? mute.mutedAt : null,
	};
}

export class TicketWorkCycleModule implements TicketWorkCycleAggregate {
	private readonly db: StateScope;
	readonly graph: () => StateGraph;
	constructor(store: StateStore, graph: () => StateGraph) {
		this.db = store.scopeOf("ticketWorkCycle", TABLES_OWNED.ticketWorkCycle);
		this.graph = graph;
	}
	/**
	 * Every fact the row carries is read once for the whole list (issue
	 * #202, ADR 0095): the memberships, the unresolved attempts, the newest
	 * handoffs, the start counts, the completion traces, and the leftover
	 * environments each cost one statement per chunk of Tickets, not one per
	 * Ticket. The observation loop runs this read every cycle.
	 */
	private projectionReads(rows: Array<{ identity: string; state: TicketState }>): ProjectionReads {
		const identities = rows.map((row) => row.identity);
		const memberships = this.graph().sourceFact.membershipsForTickets(
			rows.map((row) => ({ identity: row.identity, state: row.state })),
		);
		const pendingTickets = this.graph().handoff.ticketsWithUnresolvedAttempts();
		const newestHandoffs = this.graph().handoff.newestHandoffsFor(identities);
		const handoffCounts = this.graph().handoff.handoffCountsFor(identities);
		// The Failed-start park counts the run of failed starts the same way, over
		// the same ledger for the same rows (issue #298, ADR 0106).
		const failedStartStreaks = this.graph().handoff.failedStartStreaksFor(identities);
		const completions = this.lastCompletionsFor(identities);
		const leftovers = this.graph().handoff.leftoverEnvironmentsFor(identities);
		// The Agent name collision rides the same one read per cycle (issue #299,
		// ADR 0107): the row's marker and the detail's block state it without a rule
		// of their own, the way the leftover's do.
		const nameCollisions = this.graph().handoff.nameCollisionsFor(identities);
		return {
			memberships,
			pendingTickets,
			newestHandoffs,
			handoffCounts,
			failedStartStreaks,
			completions,
			leftovers,
			nameCollisions,
		};
	}
	projectedTickets(states: readonly WorkflowState[], fallbackTaskType: string): Ticket[] {
		const rows = this.db
			.prepare("SELECT identity, state, work_cycle, ignored, ignored_at FROM tickets")
			.all() as TicketRow[];
		const reads = this.projectionReads(rows);
		const tickets: Ticket[] = [];
		for (const row of rows) {
			const ticket = this.projectedTicketFor(row, reads, states, fallbackTaskType);
			if (ticket !== null) tickets.push(ticket);
		}
		return tickets;
	}
	/** The Ticket one row projects to, or nothing while the row stands unread. */
	private projectedTicketFor(
		row: TicketRow,
		reads: ProjectionReads,
		states: readonly WorkflowState[],
		fallbackTaskType: string,
	): Ticket | null {
		const storedMemberships = reads.memberships.get(row.identity) ?? [];
		const pending = reads.pendingTickets.has(row.identity);
		const standing = ticketStanding(row, storedMemberships, pending);
		if (storedMemberships.length === 0 && !inFlightState(row.state) && row.state !== "awaiting")
			return null;
		const facts = ticketFactsOf(storedMemberships);
		if (facts == null) return null;
		const handoff = ticketHandoffFact(reads.newestHandoffs.get(row.identity) ?? null);
		// One match answers both facts the list reads: the task the machine
		// suggests and the name of the position that suggests it. The name is
		// derived here and never stored, and no rule but the list's grouping
		// reads it (issue #159).
		const listed = storedMemberships.filter((membership) => membership.active);
		const matched = matchState(listed, states);
		const mute = ticketMute(storedMemberships);
		return projectedTicketOf({
			row,
			facts,
			handoff,
			matched,
			standing,
			mute,
			reads,
			states,
			fallbackTaskType,
			memberships: storedMemberships,
		});
	}
	/**
	 * The projection read a derivation takes (ADR 0042, ADR 0093): one
	 * `projectedTickets` read held as the value the Next step derivation asks its
	 * gates of.
	 */
	ticketProjection(states: readonly WorkflowState[], fallbackTaskType: string): TicketProjection {
		return ticketProjectionOf(this.projectedTickets(states, fallbackTaskType));
	}
	ticketListViews(
		states: readonly WorkflowState[],
		fallbackTaskType: string,
		filter: TicketListFilter = "active",
	): TicketListViews {
		return listTicketViews(this.projectedTickets(states, fallbackTaskType), filter);
	}
	lastCompletion(identity: string): Completion | null {
		const row = this.db
			.prepare(
				`SELECT ${COMPLETION_COLUMNS} FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1`,
			)
			.get(identity) as CompletionRow | undefined;
		return row == null ? null : completionFromRow(row);
	}
	/**
	 * The newest completion trace of every Ticket in the list, in one statement
	 * per chunk (issue #202, ADR 0095). The rows arrive newest first within
	 * each Ticket, so the first row seen for an identity is its newest trace.
	 */
	lastCompletionsFor(identities: readonly string[]): Map<string, Completion | null> {
		const found = new Map<string, Completion | null>();
		for (const identity of identities) found.set(identity, null);
		for (const chunk of identityChunks(identities)) {
			const rows = this.db
				.prepare(
					`SELECT ticket_identity, ${COMPLETION_COLUMNS} FROM completion_traces WHERE ticket_identity IN (${placeholders(chunk.length)}) ORDER BY ticket_identity, completed_at DESC, rowid DESC`,
				)
				.all(...chunk) as unknown as Array<CompletionRow & { ticket_identity: string }>;
			for (const row of rows) {
				if (found.get(row.ticket_identity) !== null) continue;
				found.set(row.ticket_identity, completionFromRow(row));
			}
		}
		return found;
	}
	recordSkipRefire(ticketIdentity: string, outcome: TransitionOutcome): boolean {
		return this.db.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT id, transition_json FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1",
				)
				.get(ticketIdentity) as { id: string; transition_json: string | null } | null;
			if (row == null || row.transition_json === null) return false;
			const recorded = transitionOf(row.transition_json);
			if (
				recorded === null ||
				recorded.fired !== true ||
				(recorded.reason !== NO_LINKED_PULL_REQUEST_SKIP &&
					recorded.reason !== EMPTY_PULL_REQUEST_SKIP)
			)
				return false;
			const result = this.db
				.prepare(
					"UPDATE completion_traces SET transition_json = ? WHERE id = ? AND transition_json = ?",
				)
				.run(JSON.stringify(outcome), row.id, row.transition_json);
			return Number(result.changes) > 0;
		});
	}
	recordedTransitionJson(ticketIdentity: string): string | null {
		const row = this.db
			.prepare(
				"SELECT transition_json FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1",
			)
			.get(ticketIdentity) as { transition_json: string | null } | undefined;
		return row?.transition_json ?? null;
	}
	recordRefiredOutcome(
		ticketIdentity: string,
		recordedJson: string,
		outcome: TransitionOutcome,
	): boolean {
		return this.db.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT id, transition_json FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1",
				)
				.get(ticketIdentity) as { id: string; transition_json: string | null } | null;
			if (row == null || row.transition_json !== recordedJson) return false;
			const result = this.db
				.prepare(
					"UPDATE completion_traces SET transition_json = ? WHERE id = ? AND transition_json = ?",
				)
				.run(JSON.stringify(outcome), row.id, recordedJson);
			return Number(result.changes) > 0;
		});
	}
	/**
	 * The Dispatch pause (ADR 0016). The aggregate answers the two facts the
	 * traces hold - the newest held `failed` turn, and the newest `completed`
	 * turn - and the domain rule says whether the pause stands on them. The
	 * pause is never stored (issue #202, ADR 0095).
	 */
	dispatchPauseActive(): boolean {
		return dispatchPauseHolds(this.heldFailureTrace(), this.newestCompletedTrace());
	}
	/**
	 * The newest Held turn that settled `failed` (GLOSSARY.md, ADR 0016): an
	 * undecided `failed` trace that still stands as the decision the operator
	 * owes - the Ticket rests `awaiting` on the cycle the trace belongs to.
	 *
	 * The two guards are what keep the pause releasable (issue #338). An Agent
	 * that reports working again reopens its turn (ADR 0016): the row leaves
	 * `awaiting` for `running`, and its `held` badge, its `held` count, and its
	 * Decision screen leave with the state, so no surface can land a decision on
	 * that trace until the Agent settles again. A cycle the operator closes
	 * (ADR 0031) leaves the pending trace behind in the closed cycle, where no
	 * surface offers it one either. The pause holds every automatic start, and a
	 * `completed` settle is the only release besides the operator's decision, so
	 * a pause that read a trace neither of them can answer never releases: the
	 * factory stops on a fact the operator cannot see and cannot decide.
	 */
	private heldFailureTrace(): CompletionTraceOrder | null {
		const row = this.db
			.prepare(
				`SELECT t.completed_at, t.rowid FROM completion_traces t
				 JOIN tickets k ON k.identity = t.ticket_identity
				 WHERE t.cause = 'failed' AND t.decision IS NULL
				   AND k.state = 'awaiting' AND k.work_cycle = t.work_cycle
				 ORDER BY t.completed_at DESC, t.rowid DESC LIMIT 1`,
			)
			.get() as { completed_at: string; rowid: number } | null;
		return row == null ? null : { completedAt: row.completed_at, rowId: row.rowid };
	}
	/** The newest trace whose turn settled `completed`. */
	private newestCompletedTrace(): CompletionTraceOrder | null {
		const row = this.db
			.prepare(
				"SELECT completed_at, rowid FROM completion_traces WHERE cause = 'completed' ORDER BY completed_at DESC, rowid DESC LIMIT 1",
			)
			.get() as { completed_at: string; rowid: number } | null;
		return row == null ? null : { completedAt: row.completed_at, rowId: row.rowid };
	}
	sourceReverifiedSinceCycleEnd(identity: string): boolean {
		const ended = this.lastCycleEnd(identity);
		if (ended === null) return true;
		return !this.graph().sourceFact.hasUnrefreshedActiveMembershipSince(identity, ended.decidedAt);
	}
	sameTypeHoldActive(identity: string, suggestedTaskType: string | null): boolean {
		return sameTypeHoldHolds(this.holdTurn(identity), suggestedTaskType);
	}
	ignoredTickets(): Set<string> {
		const rows = this.db.prepare("SELECT identity FROM tickets WHERE ignored = 1").all() as Array<{
			identity: string;
		}>;
		return new Set(rows.map((row) => row.identity));
	}
	private ticketObligation(
		identity: string,
		marker: TicketMarker | null = null,
	): TicketObligation | null {
		const row = this.db.prepare("SELECT state FROM tickets WHERE identity = ?").get(identity) as
			| { state: TicketState }
			| undefined;
		if (row === undefined) return null;
		// The marker is the row's face: only an in-flight Ticket reads a missing
		// Agent, exactly as the list's failure badge does, so a caller that hands
		// the poll's fact in cannot make a resting Ticket owe what it does not.
		const inFlight = inFlightState(row.state);
		return obligationOf(
			{ state: row.state, lastCompletion: this.lastCompletion(identity) },
			inFlight ? marker : null,
		);
	}
	setTicketIgnored(
		identity: string,
		ignored: boolean,
		marker: TicketMarker | null = null,
	): { ok: true } | { ok: false; reason: string } {
		if (ignored) {
			const refusal = ignoreRefusal(this.ticketObligation(identity, marker));
			if (refusal !== null) return { ok: false, reason: refusal };
		}
		const row = this.db.prepare("SELECT 1 FROM tickets WHERE identity = ?").get(identity) as
			| { 1: number }
			| undefined;
		if (row === undefined) return { ok: false, reason: "the ticket no longer exists" };
		this.db
			.prepare("UPDATE tickets SET ignored = ?, ignored_at = ? WHERE identity = ?")
			.run(ignored ? 1 : 0, ignored ? new Date(this.db.now()).toISOString() : null, identity);
		return { ok: true };
	}
	ticketState(identity: string): TicketState | undefined {
		const row = this.db.prepare("SELECT state FROM tickets WHERE identity = ?").get(identity) as
			| { state: TicketState }
			| undefined;
		return row?.state;
	}
	agentNameForTicket(identity: string): string {
		const row = this.graph().handoff.newestHandoff(identity);
		if (row !== null && row.herdrName !== null && row.herdrName !== "") {
			return row.herdrName;
		}
		const title = this.graph().sourceFact.newestMembershipTitle(identity);
		return title == null ? "" : agentNameFor({ identity, title });
	}
	/**
	 * The Agent name of every Ticket the caller names, in one batched read
	 * (issue #202, ADR 0095). The name is the same fact `agentNameForTicket`
	 * answers - the herdr name the newest handoff recorded, else the name the
	 * ticket's newest source title gives - so the seat count the observation
	 * loop and the mode cell read costs one statement per chunk of Tickets and
	 * not two per Ticket.
	 */
	agentNamesForTickets(identities: readonly string[]): Map<string, string> {
		const newestHandoffs = this.graph().handoff.newestHandoffsFor(identities);
		const needsTitle = identities.filter((identity) => {
			const handoff = newestHandoffs.get(identity);
			return handoff === undefined || handoff.herdrName === null || handoff.herdrName === "";
		});
		const titles = this.graph().sourceFact.newestMembershipTitlesFor(needsTitle);
		const names = new Map<string, string>();
		for (const identity of identities) {
			const handoff = newestHandoffs.get(identity);
			if (handoff !== undefined && handoff.herdrName !== null && handoff.herdrName !== "") {
				names.set(identity, handoff.herdrName);
				continue;
			}
			const title = titles.get(identity) ?? null;
			names.set(identity, title === null ? "" : agentNameFor({ identity, title }));
		}
		return names;
	}
	automaticStartBlockedTickets(): Set<string> {
		const rows = this.db.prepare("SELECT identity FROM tickets WHERE ignored = 1").all() as Array<{
			identity: string;
		}>;
		const blocked = new Set(rows.map((row) => row.identity));
		for (const identity of this.graph().sourceFact.ticketsWithMutedSource()) blocked.add(identity);
		return blocked;
	}
	/**
	 * Whether this one Ticket stands judged out of the factory's way (ADR 0060,
	 * ADR 0070): its own ignore, or the mute of one of its sources.
	 */
	automaticStartBlockedTicket(ticketIdentity: string): boolean {
		const row = this.db
			.prepare("SELECT ignored FROM tickets WHERE identity = ?")
			.get(ticketIdentity) as { ignored: number } | undefined;
		if (row !== undefined && row.ignored === 1) return true;
		return this.graph().sourceFact.ticketHasMutedSource(ticketIdentity);
	}
	recordRouteRemovedMark(ticketIdentity: string, decision: string): boolean {
		const row = this.db
			.prepare(
				"SELECT id, transition_json FROM completion_traces WHERE ticket_identity = ? AND decision = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1",
			)
			.get(ticketIdentity, decision) as { id: string; transition_json: string | null } | null;
		if (row == null || row.transition_json === null) return false;
		const recorded = transitionOf(row.transition_json);
		if (recorded === null || recorded.routeRemoved === true) return false;
		const result = this.db
			.prepare(
				"UPDATE completion_traces SET transition_json = ? WHERE id = ? AND transition_json = ?",
			)
			.run(JSON.stringify({ ...recorded, routeRemoved: true }), row.id, row.transition_json);
		return Number(result.changes) > 0;
	}
	ticketsByState(states: readonly TicketState[]): HandoffTicket[] {
		const clauses = states.map(() => "?").join(", ");
		const rows = this.db
			.prepare(
				`SELECT identity AS ticket_identity, state, work_cycle FROM tickets WHERE state IN (${clauses}) ORDER BY identity`,
			)
			.all(...states) as Array<{
			ticket_identity: string;
			state: TicketState;
			work_cycle: number;
		}>;
		// The newest handoff of every row arrives in one batch read, so the
		// seat count the observation loop runs every cycle costs two statements
		// and not one per Ticket (issue #202, ADR 0095).
		const newestHandoffs = this.graph().handoff.newestHandoffsFor(
			rows.map((row) => row.ticket_identity),
		);
		const out: HandoffTicket[] = [];
		for (const row of rows) {
			const handoff = newestHandoffs.get(row.ticket_identity) ?? null;
			if (handoff === null || handoff.choice === undefined) continue;
			const choice = handoff.choice;
			out.push({
				ticketIdentity: row.ticket_identity,
				state: row.state,
				workCycle: row.work_cycle,
				taskType: choice.taskType,
				agentType: choice.agentType,
				environment: choice.environment,
				model: choice.model,
				thinking: choice.thinking,
				contextWindow: choice.contextWindow,
				paneId: handoff.paneId,
				tabId: handoff.tabId,
				workspaceId: handoff.workspaceId,
				handoffAttemptId: handoff.attemptId,
				startedAt: handoff.startedAt,
			});
		}
		return out;
	}
	markTicketRunning(identity: string): boolean {
		const result = this.db
			.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'handed-off'")
			.run(identity);
		return Number(result.changes) > 0;
	}
	reopenTurn(identity: string, handoffId: string): boolean {
		return this.db.transaction(() => {
			const pending = this.db
				.prepare("SELECT id FROM completion_traces WHERE handoff_id = ? AND decision IS NULL")
				.get(handoffId) as { id: string } | undefined;
			if (pending == null) return false;
			const moved = this.db
				.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'awaiting'")
				.run(identity);
			return Number(moved.changes) > 0;
		});
	}
	settleTurn(input: SettleTurnInput): void {
		this.db.transaction(() => {
			this.settleTurnWrites(input);
		});
	}

	/** The one settle write set a settled turn lands. */
	private settleTurnWrites(input: SettleTurnInput): void {
		// A settle without a read cause is stored as `unknown`, the fail-open
		// cause: it neither holds a turn nor pauses dispatch.
		const cause = input.cause ?? "unknown";
		const detail = input.detail ?? "";
		this.db
			.prepare(
				"UPDATE tickets SET state = 'awaiting' WHERE identity = ? AND state IN ('handed-off', 'running', 'awaiting')",
			)
			.run(input.ticketIdentity);
		const handoff = this.graph().handoff.handoffRecord(input.handoffId);
		const pending = this.db
			.prepare("SELECT id FROM completion_traces WHERE handoff_id = ? AND decision IS NULL")
			.get(input.handoffId) as { id: string } | undefined;
		if (handoff == null) return;
		const choice = handoff.choice;
		if (pending != null) {
			// A reopened turn settles again: the same trace is refreshed, its
			// cause and detail overwritten, so a recovered turn reads as the
			// turn it became.
			this.db
				.prepare(
					"UPDATE completion_traces SET last_message = ?, turn_log_json = ?, completed_at = ?, cause = ?, detail = ?, transition_json = ? WHERE id = ?",
				)
				.run(
					input.message,
					JSON.stringify(input.turnLog),
					input.completedAt,
					cause,
					detail,
					input.transition == null ? null : JSON.stringify(input.transition),
					pending.id,
				);
		} else {
			this.db
				.prepare(
					"INSERT INTO completion_traces(id, handoff_id, ticket_identity, work_cycle, task_type, agent_type, agent_name, model, thinking, context_window, completed_at, last_message, turn_log_json, cause, detail, transition_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					randomUUID(),
					input.handoffId,
					input.ticketIdentity,
					handoff.workCycle,
					input.taskType,
					input.agentType,
					this.agentNameForTicket(input.ticketIdentity),
					choice?.model ?? "",
					choice?.thinking ?? "",
					choice?.contextWindow ?? "",
					input.completedAt,
					input.message,
					JSON.stringify(input.turnLog),
					cause,
					detail,
					input.transition == null ? null : JSON.stringify(input.transition),
				);
		}
	}
	applyCompletionDecision(input: CompletionDecisionInput): boolean {
		return this.db.transaction(() => {
			return this.applyCompletionDecisionWrites(input);
		});
	}

	/** The one completion-decision write set a decided turn lands. */
	private applyCompletionDecisionWrites(input: CompletionDecisionInput): boolean {
		const decided = this.db
			.prepare(
				"UPDATE completion_traces SET decision = ?, decided_at = ? WHERE handoff_id = ? AND decision IS NULL",
			)
			.run(input.decision, input.decidedAt, input.handoffId);
		if (Number(decided.changes) > 0) {
			this.applyDecisionStateChange(input);
			return true;
		}
		// A cycle-end decision on a turn that already decided: this close
		// ends the cycle the decision left. The recorded decision stands -
		// a fact is not rewritten - but the cycle still ends. The move runs
		// only from the resting state the decision leaves, so a repeated
		// close changes nothing. A routed ticket's cycle already ended at
		// the ask (ADR 0072), so a close on it moves nothing here.
		if (input.decision === "closed" || input.decision === "auto-closed") {
			const ended = this.db
				.prepare(
					"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ? AND state = 'awaiting'",
				)
				.run(input.ticketIdentity);
			if (Number(ended.changes) > 0) return true;
		}
		// No pending row: the turn never settled. Abandon records its
		// decision anyway, once per handoff, so the trace stays complete
		// and the cycle number moves exactly once.
		if (input.decision !== "abandoned") return false;
		const existing = this.db
			.prepare(
				"SELECT COUNT(*) AS count FROM completion_traces WHERE handoff_id = ? AND decision = ?",
			)
			.get(input.handoffId, input.decision) as { count: number };
		if (existing.count > 0) return false;
		const handoff = this.graph().handoff.handoffRecord(input.handoffId);
		if (handoff == null) return false;
		const choice = handoff.choice;
		this.db
			.prepare(
				"INSERT INTO completion_traces(id, handoff_id, ticket_identity, work_cycle, task_type, agent_type, agent_name, model, thinking, context_window, completed_at, last_message, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				randomUUID(),
				input.handoffId,
				input.ticketIdentity,
				handoff.workCycle,
				choice?.taskType ?? "",
				choice?.agentType ?? "",
				this.agentNameForTicket(input.ticketIdentity),
				choice?.model ?? "",
				choice?.thinking ?? "",
				choice?.contextWindow ?? "",
				input.decidedAt,
				"",
				input.decision,
				input.decidedAt,
			);
		this.applyDecisionStateChange(input);
		return true;
	}
	private applyDecisionStateChange(input: CompletionDecisionInput): void {
		if (
			input.decision === "closed" ||
			input.decision === "auto-closed" ||
			input.decision === "abandoned"
		) {
			this.db
				.prepare(
					"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ?",
				)
				.run(input.ticketIdentity);
		}
		// A route decision ends the cycle in the same write that lands the
		// decision (ADR 0072): the settled ticket leaves awaiting for open
		// with the cycle incremented, and the wait stands on the Work
		// queue's item the ask enqueued. The guard on awaiting keeps a re-ask
		// of a dead route a no-op. The plane action's merge decisions end the
		// cycle the same way (ADR 0068): the settled ticket leaves awaiting
		// for open with its merge waiting in the Work queue.
		if (
			input.decision === "handed-off" ||
			input.decision === "auto-handed-off" ||
			input.decision === "merged" ||
			input.decision === "auto-merged"
		) {
			this.db
				.prepare(
					"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ? AND state = 'awaiting'",
				)
				.run(input.ticketIdentity);
		}
		// The other handoff decisions move nothing: the handoff's settle moves
		// the state.
	}
	closeWorkCycle(ticketIdentity: string): boolean {
		return this.db.transaction(() => {
			const ticket = this.db
				.prepare("SELECT state FROM tickets WHERE identity = ?")
				.get(ticketIdentity) as { state: TicketState } | undefined;
			if (ticket == null) return false;
			if (!inFlightState(ticket.state)) return false;
			this.db
				.prepare(
					"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ?",
				)
				.run(ticketIdentity);
			return true;
		});
	}
	private lastCycleEnd(identity: string): {
		decidedAt: string;
		taskType: string;
		cause: string | null;
	} | null {
		const row = this.db
			.prepare(
				`SELECT decided_at, task_type, cause FROM completion_traces
				 WHERE ticket_identity = ? AND decision IN ('closed', 'auto-closed', 'abandoned')
				   AND decided_at IS NOT NULL
				   AND work_cycle = (SELECT work_cycle - 1 FROM tickets WHERE identity = ?)
				 ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
			)
			.get(identity, identity) as
			| { decided_at: string; task_type: string; cause: string | null }
			| undefined;
		if (row == null) return null;
		return { decidedAt: row.decided_at, taskType: row.task_type, cause: row.cause };
	}
	/**
	 * The turn the Same-type hold reads (ADR 0026, ADR 0093): the current cycle's
	 * settled turn, or the newest closed cycle's row when the current cycle has
	 * settled none.
	 *
	 * The cycle-end read alone answers the open ticket, whose current cycle has
	 * settled no turn yet. It does not answer a settled turn's Next step: that
	 * turn stands in the cycle the ticket is in now, and it is the newest fact
	 * about the ticket. A review that finished and wrote `needs-work` is a new
	 * signal whatever the cycle before it finished, so the hold reads the review
	 * and stands clear of the rework the review asks for. Reading the older
	 * closed cycle instead holds the rework on the ticket forever, and the review
	 * and rework loop Auto-handoff mode runs unattended never runs.
	 *
	 * The window stays two cycles wide, the way the cycle-end read is: a cycle
	 * that settled no turn - the in-flight Close (ADR 0031), an abandon over a
	 * turn that never settled - asserts nothing and clears the hold, and the read
	 * never reaches back past the cycle before the current one.
	 */
	private holdTurn(identity: string): { taskType: string; cause: string | null } | null {
		const row = this.db
			.prepare(
				`SELECT task_type, cause FROM completion_traces
				 WHERE ticket_identity = ?
				   AND (
				     work_cycle = (SELECT work_cycle FROM tickets WHERE identity = ?)
				     OR (
				       work_cycle = (SELECT work_cycle - 1 FROM tickets WHERE identity = ?)
				       AND decision IN ('closed', 'auto-closed', 'abandoned')
				       AND decided_at IS NOT NULL
				     )
				   )
				 ORDER BY work_cycle DESC, decided_at DESC, rowid DESC LIMIT 1`,
			)
			.get(identity, identity, identity) as { task_type: string; cause: string | null } | undefined;
		if (row == null) return null;
		return { taskType: row.task_type, cause: row.cause };
	}
	/** Open the Ticket row for a ticket a source lists for the first time. */
	openTicket(identity: string): void {
		this.db
			.prepare(
				"INSERT INTO tickets(identity, state, work_cycle) VALUES (?, 'open', 1) ON CONFLICT(identity) DO NOTHING",
			)
			.run(identity);
	}

	/** The Ticket row's own facts: its state and the cycle number it is on. */
	ticketCycleFacts(identity: string): TicketCycle | undefined {
		const row = this.db
			.prepare("SELECT state, work_cycle FROM tickets WHERE identity = ?")
			.get(identity) as { state: TicketState; work_cycle: number } | undefined;
		return row == null ? undefined : { state: row.state, workCycle: row.work_cycle };
	}

	/** Move the Ticket state, only from the states the caller names. */
	moveTicketState(identity: string, from: readonly TicketState[], to: TicketState): boolean {
		const clauses = from.map(() => "?").join(", ");
		const result = this.db
			.prepare(`UPDATE tickets SET state = ? WHERE identity = ? AND state IN (${clauses})`)
			.run(to, identity, ...from);
		return Number(result.changes) > 0;
	}
}
