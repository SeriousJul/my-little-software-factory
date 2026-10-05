/**
 * The handoff aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 *
 * The methods on `HandoffAggregate` are the aggregate's interface: what a
 * caller outside the module may reach. The other public methods are the narrow
 * operations this aggregate publishes to the module for another aggregate to
 * call (issue #202, ADR 0095). No caller outside the module reaches them, and
 * the boundary check refuses one that does.
 */

import { randomUUID } from "node:crypto";
import { blockedUnrefreshedHold } from "../domain/attempt-hold.ts";
import type {
	EnvironmentKind,
	LeftoverEnvironment,
	Ticket,
	TicketState,
} from "../domain/ticket.ts";
import { inFlightState } from "../domain/ticket.ts";
import type { HandoffChoice } from "../handoff.ts";
import { identifyHandoffAgentName } from "../naming.ts";
import { identityChunks, placeholders } from "./batch.ts";
import type { StateGraph } from "./graph.ts";
import { jsonChoice } from "./json.ts";
import type { StateScope, StateStore } from "./store.ts";
import { StateError } from "./store.ts";
import { TABLES_OWNED } from "./tables.ts";
import type { TicketCycle } from "./ticket-work-cycle.ts";

export interface HandoffClaim {
	attemptId: string;
}
/**
 * What one Handoff settle leaves in the attempt's own record: the Ticket the
 * attempt names, the outcome its own stage states, and the reason the attempt's
 * row stores.
 *
 * The settle answers this so the caller's record line states the reason the
 * ledger holds, not a second copy of the reason the caller handed the write
 * (issue #295). A settle of an attempt that had already settled answers null:
 * the write runs once per attempt, and the line follows the write.
 *
 * `failureReason` is null for a start that reached its Agent, and for the failed
 * settle that stored no reason at all: the column is nullable in every schema
 * version, so an older state file can hold a failed attempt with no reason in
 * it. The record line says so rather than inventing one.
 */
export interface HandoffSettlement {
	ticketIdentity: string;
	/** `agent-started` when the start reached its Agent, `failed` when it did not. */
	outcome: "agent-started" | "failed";
	/** The reason the attempt's row stores; null when it stores none. */
	failureReason: string | null;
}
export type ClaimOutcome = { ok: true; claim: HandoffClaim } | { ok: false; reason: string };
export type HandoffOrigin = "open" | "workflow" | "restart";
export interface HandoffDetails {
	paneId?: string | null;
	tabId?: string | null;
	workspaceId?: string | null;
	/** The herdr name the agent started under. */
	agentName?: string | null;
	/**
	 * The ticket the started handoff routes from, or null when the start is no
	 * route or its position is the started ticket itself (ADR 0067).
	 */
	routeFromIdentity?: string | null;
}
export interface HandoffTicket {
	ticketIdentity: string;
	/** The ticket's state. */
	state: TicketState;
	workCycle: number;
	taskType: string;
	agentType: string;
	environment: EnvironmentKind;
	/** The model the latest handoff chose; empty leaves it to the agent. */
	model: string;
	/** The thinking level the latest handoff chose; empty leaves it to the agent. */
	thinking: string;
	/** The context window the latest handoff chose, in digits; empty leaves it to the agent. */
	contextWindow: string;
	paneId: string | null;
	tabId: string | null;
	workspaceId: string | null;
	/** The attempt id of the latest handoff. */
	handoffAttemptId: string;
	/** When the handoff's agent started, in ISO time. */
	startedAt: string;
}
interface HandoffRow {
	attempt_id: string;
	choice_json: string;
	pane_id: string | null;
	tab_id: string | null;
	workspace_id: string | null;
}

export interface StoredHandoff {
	attemptId: string;
	workCycle: number;
	startedAt: string;
	choice: HandoffChoice | undefined;
	paneId: string | null;
	tabId: string | null;
	workspaceId: string | null;
	herdrName: string | null;
}

export interface HandoffAggregate {
	handoffInFlight(ticketIdentity: string): boolean;
	/**
	 * The Ticket's start count the Handoff limit reads: every Handoff attempt the
	 * factory made, the starts that reached an Agent and the starts that never
	 * reached one, beside the Ticket's Plane action attempts (ADR 0005 as amended
	 * by ADR 0101, issue #217).
	 */
	handoffCount(identity: string): number;
	/**
	 * The start count of every Ticket in the list, in one grouped statement per
	 * aggregate the count adds (issue #202, ADR 0095). A walk that holds a list
	 * of Tickets takes this instead of `handoffCount` per Ticket.
	 */
	handoffCountsFor(identities: readonly string[]): Map<string, number>;
	/**
	 * Whether the Ticket's newest Handoff attempt holds the auto top-up's re-ask
	 * of that Ticket: the attempt settled `failed` - it started no Agent - and not
	 * every active source has re-read the Ticket since it landed (ADR 0077 as
	 * extended by ADR 0101, issue #217). The hold reads the attempt, not who asked
	 * for the start, and it gates the automatic adds only.
	 */
	handoffBlockedUnrefreshed(identity: string): boolean;
	autoHandoffMode(): boolean;
	setAutoHandoffMode(enabled: boolean): void;
	latestHandoff(identity: string): {
		handoffId: string;
		environment: EnvironmentKind;
		paneId: string | null;
		tabId: string | null;
		workspaceId: string | null;
	} | null;
	handoffHandles(identity: string): { paneIds: string[]; workspaceIds: string[] };
	openAttemptTickets(): string[];
	reclaimHandoff(
		identity: string,
		details: { paneId: string; tabId: string; workspaceId: string; agentName: string },
	): { attemptId: string } | null;
	handoffClaimCheck(
		ticketIdentity: string,
		origin: HandoffOrigin,
	): { ok: true } | { ok: false; reason: string };
	claimHandoff(ticketIdentity: string, choice: HandoffChoice, origin: HandoffOrigin): ClaimOutcome;
	advanceHandoffAttempt(attemptId: string, stage: string): void;
	/**
	 * Settle one Handoff attempt and answer with what its row now holds, or null
	 * when the attempt had already settled. The caller that records the start's
	 * end reads its reason out of that answer (issue #295).
	 */
	settleHandoff(
		attemptId: string,
		agentStarted: boolean,
		failureReason?: string,
		details?: HandoffDetails,
	): HandoffSettlement | null;
	/**
	 * Settle every attempt a previous run left unresolved as a failed start
	 * (ADR 0041) and answer with each attempt's settled record, so the boot can
	 * state in the log why the start never reached its Agent (issue #295).
	 */
	recoverUnsettledHandoffs(): HandoffSettlement[];
	recordLeftoverEnvironment(input: {
		ticketIdentity: string;
		handoffId?: string | null;
		paneId?: string | null;
		reason: string;
		at?: string;
	}): LeftoverEnvironment | null;
	leftoverEnvironment(identity: string): LeftoverEnvironment | null;
	/** The standing leftover environment facts of every Ticket in the list. */
	leftoverEnvironmentsFor(identities: readonly string[]): Map<string, LeftoverEnvironment[]>;
	clearLeftoverEnvironments(
		identity: string,
		ended: { workspaceId: string } | { tabId: string } | { handoffId: string },
	): number;
}

/**
 * The attempt cells a settle's own write answers (issue #295): the row as the
 * ledger holds it once the settle landed, not the values the caller passed.
 */
interface SettledAttemptRow {
	attempt_id: string;
	ticket_identity: string;
	stage: string;
	failure_reason: string | null;
}

/** The handoff cells a read maps into a `StoredHandoff`. */
interface HandoffFactRow {
	attempt_id: string;
	work_cycle: number;
	started_at?: string;
	choice_json: string;
	pane_id: string | null;
	tab_id: string | null;
	workspace_id: string | null;
	herdr_name: string | null;
}

function storedHandoff(row: HandoffFactRow): StoredHandoff {
	return {
		attemptId: row.attempt_id,
		workCycle: row.work_cycle,
		startedAt: row.started_at ?? "",
		choice: jsonChoice(row.choice_json),
		paneId: row.pane_id,
		tabId: row.tab_id,
		workspaceId: row.workspace_id,
		herdrName: row.herdr_name,
	};
}

/**
 * The handoff fact a Ticket row carries, read off the newest handoff. The
 * Ticket work cycle maps it from the batch read `newestHandoffsFor`, so the
 * same shape stands for a single Ticket and for the whole list.
 */
export function ticketHandoffFact(handoff: StoredHandoff | null): Ticket["handoff"] {
	if (handoff == null || handoff.choice == null) return null;
	return {
		agentType: handoff.choice.agentType,
		environment: handoff.choice.environment,
		taskType: handoff.choice.taskType,
		model: handoff.choice.model,
		thinking: handoff.choice.thinking,
		contextWindow: handoff.choice.contextWindow,
		attemptId: handoff.attemptId,
		paneId: handoff.paneId,
		tabId: handoff.tabId,
		workspaceId: handoff.workspaceId,
		herdrName: handoff.herdrName,
	};
}

export class HandoffModule implements HandoffAggregate {
	private readonly db: StateScope;
	readonly graph: () => StateGraph;
	constructor(store: StateStore, graph: () => StateGraph) {
		this.db = store.scopeOf("handoff", TABLES_OWNED.handoff);
		this.graph = graph;
	}
	hasUnresolvedAttempt(identity: string): boolean {
		return (
			this.db
				.prepare(
					"SELECT attempt_id FROM handoff_attempts WHERE ticket_identity = ? AND resolved_at IS NULL LIMIT 1",
				)
				.get(identity) != null
		);
	}
	/** Every Ticket with an unresolved attempt, in one read of the attempt table. */
	ticketsWithUnresolvedAttempts(): Set<string> {
		const rows = this.db
			.prepare("SELECT DISTINCT ticket_identity FROM handoff_attempts WHERE resolved_at IS NULL")
			.all() as Array<{ ticket_identity: string }>;
		return new Set(rows.map((row) => row.ticket_identity));
	}
	handoffInFlight(ticketIdentity: string): boolean {
		return this.hasUnresolvedAttempt(ticketIdentity);
	}
	handoffFor(identity: string): Ticket["handoff"] {
		return ticketHandoffFact(this.newestHandoff(identity));
	}
	handoffCount(identity: string): number {
		// The attempt ledger, not the started-handoff table: a start that never
		// reached an Agent writes an attempt row and no handoff row, and the limit
		// that bounds a run-away loop has to count the starts it is bounding
		// (ADR 0101, issue #217).
		const row = this.db
			.prepare("SELECT COUNT(*) AS count FROM handoff_attempts WHERE ticket_identity = ?")
			.get(identity) as { count: number };
		return Number(row.count) + this.graph().planeAction.planeActionAttemptCount(identity);
	}
	/**
	 * The start count of every Ticket in the list (issue #202, ADR 0095). The
	 * two tables the count adds belong to two aggregates, so the batch is two
	 * grouped statements rather than one statement that reaches past the
	 * Handoff aggregate's own tables.
	 */
	handoffCountsFor(identities: readonly string[]): Map<string, number> {
		const counts = new Map<string, number>();
		for (const identity of identities) counts.set(identity, 0);
		for (const chunk of identityChunks(identities)) {
			const rows = this.db
				.prepare(
					`SELECT ticket_identity, COUNT(*) AS count FROM handoff_attempts WHERE ticket_identity IN (${placeholders(chunk.length)}) GROUP BY ticket_identity`,
				)
				.all(...chunk) as Array<{ ticket_identity: string; count: number }>;
			for (const row of rows) counts.set(row.ticket_identity, Number(row.count));
		}
		for (const [identity, count] of this.graph().planeAction.planeActionAttemptCountsFor(
			identities,
		))
			counts.set(identity, (counts.get(identity) ?? 0) + count);
		return counts;
	}
	/**
	 * The failed start's hold (ADR 0077 as extended by ADR 0101, issue #217). The
	 * rule is the shared blocked-and-unrefreshed rule the Plane action aggregate
	 * reads over its own attempt table; this aggregate supplies the newest
	 * Handoff attempt, the word `failed`, and the source half through
	 * `sourceFact.hasUnrefreshedActiveMembershipSince` - the query the cycle-end
	 * re-verify gate runs, so the two gates wait on one time rule.
	 *
	 * The attempt's own record is the read: the newest attempt by the time it was
	 * claimed, and the time its outcome landed. An attempt still in flight - no
	 * outcome yet - holds nothing here; the unresolved attempt is what the claim
	 * gate and the queue's one-item rule already hold the re-ask on.
	 *
	 * The read cost is two statements per ask the walk reaches: the newest attempt
	 * row, served by `attempts_ticket_latest`, and the source fact over the
	 * Ticket's memberships. The hold runs once per candidate the walk reaches, so
	 * the index behind the newest-attempt read is what keeps that off the cycle's
	 * critical path (ADR 0101).
	 */
	handoffBlockedUnrefreshed(identity: string): boolean {
		return blockedUnrefreshedHold({
			latestAttempt: this.latestHandoffAttemptRow(identity),
			unreachedOutcome: "failed",
			unrefreshedSince: (at) =>
				this.graph().sourceFact.hasUnrefreshedActiveMembershipSince(identity, at),
		});
	}
	/**
	 * The newest attempt row: the stage its outcome landed with and that time.
	 * "Newest" is the newest claim - `created_at`, then the insert order - and the
	 * outcome the claim settled with. `attempts_ticket_latest` serves the read in
	 * one index step: the index stands ascending so its backward scan lands the
	 * newest claim first and breaks a same-millisecond tie on the row order.
	 */
	private latestHandoffAttemptRow(identity: string): { outcome: string; at: string } | null {
		const row = this.db
			.prepare(
				"SELECT stage, resolved_at FROM handoff_attempts WHERE ticket_identity = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as { stage: string; resolved_at: string | null } | undefined;
		if (row == null || row.resolved_at === null) return null;
		return { outcome: row.stage, at: row.resolved_at };
	}
	autoHandoffMode(): boolean {
		const row = this.db.prepare("SELECT enabled FROM auto_handoff_mode WHERE id = 1").get() as
			| { enabled: number }
			| undefined;
		return row?.enabled === 1;
	}
	setAutoHandoffMode(enabled: boolean): void {
		try {
			this.db
				.prepare(
					"INSERT INTO auto_handoff_mode(id, enabled) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled",
				)
				.run(enabled ? 1 : 0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StateError(`cannot store the Auto-handoff mode at ${this.db.path}: ${message}`);
		}
	}
	latestHandoff(identity: string): {
		handoffId: string;
		environment: EnvironmentKind;
		paneId: string | null;
		tabId: string | null;
		workspaceId: string | null;
	} | null {
		const row = this.db
			.prepare(
				"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as
			| {
					attempt_id: string;
					choice_json: string;
					pane_id: string | null;
					tab_id: string | null;
					workspace_id: string | null;
			  }
			| undefined;
		if (row == null) return null;
		const choice = jsonChoice(row.choice_json);
		return {
			handoffId: row.attempt_id,
			environment: choice?.environment ?? "worktree",
			paneId: row.pane_id,
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
		};
	}
	handoffHandles(identity: string): { paneIds: string[]; workspaceIds: string[] } {
		const rows = this.db
			.prepare("SELECT pane_id, workspace_id FROM handoffs WHERE ticket_identity = ?")
			.all(identity) as Array<{ pane_id: string | null; workspace_id: string | null }>;
		const paneIds: string[] = [];
		const workspaceIds: string[] = [];
		for (const row of rows) {
			if (row.pane_id !== null) paneIds.push(row.pane_id);
			if (row.workspace_id !== null) workspaceIds.push(row.workspace_id);
		}
		return { paneIds, workspaceIds };
	}
	openAttemptTickets(): string[] {
		return (
			this.db
				.prepare("SELECT ticket_identity FROM handoff_attempts WHERE resolved_at IS NULL")
				.all() as Array<{ ticket_identity: string }>
		).map((row) => row.ticket_identity);
	}
	reclaimHandoff(
		identity: string,
		details: { paneId: string; tabId: string; workspaceId: string; agentName: string },
	): { attemptId: string } | null {
		return this.db.transaction(() => {
			const ticket = this.graph().ticketWorkCycle.ticketCycleFacts(identity);
			if (ticket == null || ticket.state !== "open") return null;
			// The pane id of a closed pane is handed out again, so the live
			// agent in the ticket's stale pane can run under another name. Only
			// the ticket's own agent is reclaimed; anything else is refused.
			if (
				identifyHandoffAgentName(
					details.agentName,
					this.graph().ticketWorkCycle.agentNameForTicket(identity),
				) !== "own"
			)
				return null;
			const previous = this.newestHandoff(identity);
			if (previous == null || previous.choice == null) return null;
			if (this.hasUnresolvedAttempt(identity)) return null;
			if (!this.graph().ticketWorkCycle.moveTicketState(identity, ["open"], "running")) return null;
			const attemptId = randomUUID();
			const now = new Date(this.db.now()).toISOString();
			this.db
				.prepare(
					"INSERT INTO handoff_attempts(attempt_id, ticket_identity, work_cycle, choice_json, stage, created_at, resolved_at) VALUES (?, ?, ?, ?, 'reclaimed', ?, ?)",
				)
				.run(attemptId, identity, ticket.workCycle, JSON.stringify(previous.choice), now, now);
			this.db
				.prepare(
					"INSERT INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at, pane_id, tab_id, workspace_id, herdr_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					attemptId,
					identity,
					ticket.workCycle,
					JSON.stringify(previous.choice),
					now,
					details.paneId,
					details.tabId,
					details.workspaceId,
					details.agentName,
				);
			return { attemptId };
		});
	}
	private handoffGates(
		ticket: TicketCycle | undefined,
		ticketIdentity: string,
		origin: HandoffOrigin,
	): { ok: true; workCycle: number } | { ok: false; reason: string } {
		if (ticket == null) return { ok: false, reason: "ticket no longer exists" };
		if (origin === "open") {
			if (ticket.state !== "open")
				return {
					ok: false,
					reason: `only open tickets can be handed off (this one is ${ticket.state})`,
				};
			const eligible = this.graph()
				.sourceFact.activeMembershipSourceNames(ticketIdentity)
				.some((name) => this.graph().sourceFact.sourceHealthy(name));
			if (!eligible)
				return {
					ok: false,
					reason: "Ticket is not actionable because source data is stale, removed, or absent",
				};
			// The cycle the ticket just ended may have changed its source item
			// (the agent merged the pull request, or closed the issue). The start
			// waits for the sources to re-read it, so a handoff never starts on
			// facts the agent made stale.
			if (!this.graph().ticketWorkCycle.sourceReverifiedSinceCycleEnd(ticketIdentity))
				return {
					ok: false,
					reason:
						"the ticket's source has not been re-read since its last cycle ended; wait for the source refresh",
				};
		}
		if (origin === "workflow" && ticket.state !== "awaiting" && ticket.state !== "open")
			return {
				ok: false,
				reason: `only open or awaiting tickets can be handed off along a workflow (this one is ${ticket.state})`,
			};
		if (origin === "restart" && !inFlightState(ticket.state))
			return {
				ok: false,
				reason: `only in-flight tickets can be restarted (this one is ${ticket.state})`,
			};
		if (this.hasUnresolvedAttempt(ticketIdentity))
			return { ok: false, reason: "handoff recovery is required before another handoff" };
		return { ok: true, workCycle: ticket.workCycle };
	}
	handoffClaimCheck(
		ticketIdentity: string,
		origin: HandoffOrigin,
	): { ok: true } | { ok: false; reason: string } {
		const gates = this.handoffGates(
			this.graph().ticketWorkCycle.ticketCycleFacts(ticketIdentity),
			ticketIdentity,
			origin,
		);
		return gates.ok ? { ok: true } : gates;
	}
	claimHandoff(ticketIdentity: string, choice: HandoffChoice, origin: HandoffOrigin): ClaimOutcome {
		try {
			return this.db.transaction(() => {
				const gates = this.handoffGates(
					this.graph().ticketWorkCycle.ticketCycleFacts(ticketIdentity),
					ticketIdentity,
					origin,
				);
				if (!gates.ok) return gates;
				const attemptId = randomUUID();
				this.db
					.prepare(
						"INSERT INTO handoff_attempts(attempt_id, ticket_identity, work_cycle, choice_json, stage, created_at) VALUES (?, ?, ?, ?, 'claimed', ?)",
					)
					.run(
						attemptId,
						ticketIdentity,
						gates.workCycle,
						JSON.stringify(choice),
						new Date(this.db.now()).toISOString(),
					);
				return { ok: true, claim: { attemptId } };
			});
		} catch (error) {
			return {
				ok: false,
				reason: `cannot claim handoff: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	advanceHandoffAttempt(attemptId: string, stage: string): void {
		this.db
			.prepare("UPDATE handoff_attempts SET stage = ? WHERE attempt_id = ? AND resolved_at IS NULL")
			.run(stage, attemptId);
	}
	settleHandoff(
		attemptId: string,
		agentStarted: boolean,
		failureReason?: string,
		details?: HandoffDetails,
	): HandoffSettlement | null {
		return this.db.transaction(() => {
			const attempt = this.db
				.prepare(
					"SELECT ticket_identity, work_cycle, choice_json FROM handoff_attempts WHERE attempt_id = ? AND resolved_at IS NULL",
				)
				.get(attemptId) as
				| { ticket_identity: string; work_cycle: number; choice_json: string }
				| undefined;
			if (attempt == null) return null;
			if (agentStarted) {
				this.graph().ticketWorkCycle.moveTicketState(
					attempt.ticket_identity,
					["open", "awaiting"],
					"handed-off",
				);
				// The route's source ended its cycle at the ask (ADR 0072), so the
				// start moves the started ticket alone: the source rests open
				// behind the wait, and the wait is the item's, not a ticket state.
				this.db
					.prepare(
						"INSERT OR REPLACE INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at, pane_id, tab_id, workspace_id, herdr_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						attemptId,
						attempt.ticket_identity,
						attempt.work_cycle,
						attempt.choice_json,
						new Date(this.db.now()).toISOString(),
						details?.paneId ?? null,
						details?.tabId ?? null,
						details?.workspaceId ?? null,
						details?.agentName ?? null,
					);
			}
			// The write answers its own row, so the record line a failed start leaves
			// states the reason the ledger holds rather than a copy of what the
			// caller passed in (issue #295).
			const settled = this.db
				.prepare(
					"UPDATE handoff_attempts SET stage = ?, resolved_at = ?, failure_reason = ? WHERE attempt_id = ? RETURNING attempt_id, ticket_identity, stage, failure_reason",
				)
				.get(
					agentStarted ? "agent-started" : "failed",
					new Date(this.db.now()).toISOString(),
					failureReason ?? null,
					attemptId,
				) as SettledAttemptRow | undefined;
			return settled === undefined ? null : this.settledRecord(settled);
		});
	}
	/**
	 * The record one settled attempt row answers: the Ticket it names, the outcome
	 * its stage states, and the reason its row stores.
	 *
	 * The stage decides the outcome, and only the two stages a settle writes are
	 * an outcome. A row that holds a stage the start advanced through - `claimed`,
	 * `reclaimed`, `creating-environment`, and the rest - settled outside the
	 * settle whose write this read follows. Reading such a stage as
	 * `agent-started` would answer a start that reached its Agent and hide the
	 * failed start's line, so the stage is checked and a stage that is neither
	 * outcome is refused as the ledger break it is (issue #295 review).
	 */
	private settledRecord(row: SettledAttemptRow): HandoffSettlement {
		if (row.stage === "failed")
			return {
				ticketIdentity: row.ticket_identity,
				outcome: "failed",
				failureReason: row.failure_reason,
			};
		if (row.stage === "agent-started")
			return {
				ticketIdentity: row.ticket_identity,
				outcome: "agent-started",
				failureReason: row.failure_reason,
			};
		throw new StateError(
			`the handoff attempt ${row.attempt_id} settled with the stage ${row.stage} at ${this.db.path}`,
		);
	}
	recoverUnsettledHandoffs(): HandoffSettlement[] {
		return this.db.transaction(() => {
			const now = new Date(this.db.now()).toISOString();
			// One write settles every claim the previous run left, and answers each
			// row it settled. Each is a start that ended without its Agent, and the
			// boot records each one the way the dispatch records its own (issue #295).
			const settled = this.db
				.prepare(
					"UPDATE handoff_attempts SET stage = 'failed', resolved_at = ?, failure_reason = ? WHERE resolved_at IS NULL RETURNING attempt_id, ticket_identity, stage, failure_reason",
				)
				.all(
					now,
					"the run that claimed this handoff ended before it settled it",
				) as SettledAttemptRow[];
			return settled.map((row) => this.settledRecord(row));
		});
	}
	/** The stored Handoff row the ticket's newest Handoff stands on. */
	newestHandoff(identity: string): StoredHandoff | null {
		const row = this.db
			.prepare(
				"SELECT attempt_id, work_cycle, started_at, choice_json, pane_id, tab_id, workspace_id, herdr_name FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as HandoffFactRow | undefined;
		return row == null ? null : storedHandoff(row);
	}
	/**
	 * The newest handoff of every Ticket in the list, in one statement per
	 * chunk (issue #202, ADR 0095). The observation loop reads it for the seats
	 * every cycle, so the read is batched: the statements it costs follow the
	 * chunk count and not the Ticket count.
	 */
	newestHandoffsFor(identities: readonly string[]): Map<string, StoredHandoff> {
		const newest = new Map<string, StoredHandoff>();
		for (const chunk of identityChunks(identities)) {
			const rows = this.db
				.prepare(
					`SELECT ticket_identity, attempt_id, work_cycle, started_at, choice_json, pane_id, tab_id, workspace_id, herdr_name FROM handoffs WHERE ticket_identity IN (${placeholders(chunk.length)}) ORDER BY ticket_identity, started_at DESC, rowid DESC`,
				)
				.all(...chunk) as unknown as Array<HandoffFactRow & { ticket_identity: string }>;
			for (const row of rows) {
				// The rows come newest first within each Ticket, so the first
				// row seen for an identity is that Ticket's newest handoff.
				if (newest.has(row.ticket_identity)) continue;
				newest.set(row.ticket_identity, storedHandoff(row));
			}
		}
		return newest;
	}

	/** The stored Handoff row one attempt stands on. */
	handoffRecord(handoffId: string): StoredHandoff | null {
		const row = this.db
			.prepare(
				"SELECT attempt_id, work_cycle, choice_json, pane_id, tab_id, workspace_id, herdr_name FROM handoffs WHERE attempt_id = ?",
			)
			.get(handoffId) as HandoffFactRow | undefined;
		return row == null ? null : storedHandoff(row);
	}
	recordLeftoverEnvironment(input: {
		ticketIdentity: string;
		handoffId?: string | null;
		paneId?: string | null;
		reason: string;
		at?: string;
	}): LeftoverEnvironment | null {
		return this.db.transaction(() => {
			const row =
				input.handoffId != null
					? (this.db
							.prepare(
								"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? AND attempt_id = ?",
							)
							.get(input.ticketIdentity, input.handoffId) as HandoffRow | undefined)
					: input.paneId != null
						? (this.db
								.prepare(
									"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? AND pane_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
								)
								.get(input.ticketIdentity, input.paneId) as HandoffRow | undefined)
						: (this.db
								.prepare(
									"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
								)
								.get(input.ticketIdentity) as HandoffRow | undefined);
			if (row == null) return null;
			const at = input.at ?? new Date(this.db.now()).toISOString();
			const choice = jsonChoice(row.choice_json);
			// A fact that already stood on this handoff is refreshed: the clear
			// that ended it belongs to an attempt that did not end the
			// environment after all, so the new reason stands again.
			this.db
				.prepare(
					"UPDATE handoffs SET leftover_reason = ?, leftover_at = ?, leftover_cleared_at = NULL WHERE attempt_id = ?",
				)
				.run(input.reason, at, row.attempt_id);
			return {
				handoffId: row.attempt_id,
				environment: choice?.environment ?? "worktree",
				workspaceId: row.workspace_id,
				tabId: row.tab_id,
				paneId: row.pane_id,
				reason: input.reason,
				at,
			};
		});
	}
	leftoverEnvironment(identity: string): LeftoverEnvironment | null {
		const rows = this.leftoverEnvironments(identity);
		return rows.length === 0 ? null : rows[0];
	}
	private leftoverEnvironments(identity: string): LeftoverEnvironment[] {
		return this.leftoverEnvironmentsFor([identity]).get(identity) ?? [];
	}
	/** The leftover environment facts of every Ticket in the list, batched. */
	leftoverEnvironmentsFor(identities: readonly string[]): Map<string, LeftoverEnvironment[]> {
		const grouped = new Map<string, LeftoverEnvironment[]>();
		for (const chunk of identityChunks(identities)) {
			const rows = this.db
				.prepare(
					`SELECT ticket_identity, attempt_id, choice_json, pane_id, tab_id, workspace_id, leftover_reason, leftover_at FROM handoffs WHERE ticket_identity IN (${placeholders(chunk.length)}) AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL ORDER BY ticket_identity, started_at DESC, rowid DESC`,
				)
				.all(...chunk) as unknown as Array<
				HandoffRow & {
					ticket_identity: string;
					leftover_reason: string;
					leftover_at: string | null;
				}
			>;
			for (const row of rows) {
				const choice = jsonChoice(row.choice_json);
				const list = grouped.get(row.ticket_identity) ?? [];
				list.push({
					handoffId: row.attempt_id,
					environment: choice?.environment ?? "worktree",
					workspaceId: row.workspace_id,
					tabId: row.tab_id,
					paneId: row.pane_id,
					reason: row.leftover_reason,
					at: row.leftover_at ?? "",
				});
				grouped.set(row.ticket_identity, list);
			}
		}
		return grouped;
	}
	clearLeftoverEnvironments(
		identity: string,
		ended: { workspaceId: string } | { tabId: string } | { handoffId: string },
	): number {
		const at = new Date(this.db.now()).toISOString();
		const cleared =
			"workspaceId" in ended
				? this.db
						.prepare(
							"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND workspace_id = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
						)
						.run(at, identity, ended.workspaceId)
				: "tabId" in ended
					? this.db
							.prepare(
								"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND tab_id = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
							)
							.run(at, identity, ended.tabId)
					: this.db
							.prepare(
								"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND attempt_id = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
							)
							.run(at, identity, ended.handoffId);
		return Number(cleared.changes);
	}
}
