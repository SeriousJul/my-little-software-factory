/**
 * SQLite state ownership for the control plane.
 *
 * Source adapters only return external facts. This module owns work cycles,
 * memberships, source health, handoff claims, completion traces, and the
 * one-process lease.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskRule } from "./config.ts";
import type {
	Completion,
	CompletionDecision,
	EnvironmentKind,
	SourceMembership,
	Ticket,
	TicketState,
} from "./domain/ticket.ts";
import type { HandoffChoice } from "./handoff.ts";
import { agentNameFor } from "./naming.ts";
import { selectTaskType } from "./task-selection.ts";
import type { FetchOutcome } from "./ticket-source.ts";

const SCHEMA_VERSION = 2;
type Health = SourceMembership["health"];

export class StateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateError";
	}
}

export interface SourceDefinition {
	name: string;
	kind: string;
}

export interface HandoffClaim {
	attemptId: string;
}

export type ClaimOutcome = { ok: true; claim: HandoffClaim } | { ok: false; reason: string };

/**
 * Where a handoff claim comes from. Each origin rechecks the states and the
 * source health it is allowed to start from, atomically.
 *
 * - `open`: an open, actionable ticket with a healthy source membership.
 * - `workflow`: an awaiting ticket handed off along a workflow edge.
 * - `restart`: an in-flight ticket whose agent went missing, restarted in
 *   its existing work cycle.
 */
export type HandoffOrigin = "open" | "workflow" | "restart";

interface SettleTurnInput {
	ticketIdentity: string;
	/** The attempt id of the handoff whose turn settled. */
	handoffId: string;
	taskType: string;
	agentType: string;
	message: string;
	completedAt: string;
}

interface CompletionDecisionInput {
	ticketIdentity: string;
	/** The attempt id of the handoff the decision was made on. */
	handoffId: string;
	decision: CompletionDecision;
	decidedAt: string;
}

interface HandoffDetails {
	paneId?: string | null;
	tabId?: string | null;
	workspaceId?: string | null;
}

interface StoredMembership extends SourceMembership {
	active: boolean;
}

interface MembershipRow {
	source_name: string;
	health: Health;
	active: number;
	source_kind: string;
	external_key: string;
	source_state: string;
	url: string;
	title: string;
	description: string;
	labels_json: string;
	external_updated_at: string;
	repository_identity: string;
	repository_display_name: string;
	repository_clone_url: string;
	attributes_json: string;
}

/** A ticket with its latest handoff's choices and herdr handles. */
export interface HandoffTicket {
	ticketIdentity: string;
	workCycle: number;
	taskType: string;
	agentType: string;
	environment: EnvironmentKind;
	paneId: string | null;
	tabId: string | null;
	workspaceId: string | null;
	/** The attempt id of the latest handoff. */
	handoffAttemptId: string;
}

/** The version 1 schema, kept verbatim for the v1 to v2 migration test. */
export const SCHEMA_V1 = `
	CREATE TABLE tickets (
		identity TEXT PRIMARY KEY, state TEXT NOT NULL, work_cycle INTEGER NOT NULL,
		absent INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE source_health (
		source_name TEXT PRIMARY KEY, kind TEXT NOT NULL, health TEXT NOT NULL,
		error TEXT, last_success TEXT
	);
	CREATE TABLE memberships (
		source_name TEXT NOT NULL, ticket_identity TEXT NOT NULL, active INTEGER NOT NULL,
		source_kind TEXT NOT NULL, external_key TEXT NOT NULL, source_state TEXT NOT NULL,
		url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, labels_json TEXT NOT NULL,
		external_updated_at TEXT NOT NULL, repository_identity TEXT NOT NULL,
		repository_display_name TEXT NOT NULL, repository_clone_url TEXT NOT NULL,
		attributes_json TEXT NOT NULL,
		PRIMARY KEY (source_name, ticket_identity),
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE,
		FOREIGN KEY (source_name) REFERENCES source_health(source_name) ON DELETE CASCADE
	);
	CREATE TABLE handoff_attempts (
		attempt_id TEXT PRIMARY KEY, ticket_identity TEXT NOT NULL, work_cycle INTEGER NOT NULL,
		choice_json TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
		failure_reason TEXT,
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE
	);
	CREATE TABLE handoffs (
		attempt_id TEXT PRIMARY KEY, ticket_identity TEXT NOT NULL, work_cycle INTEGER NOT NULL,
		choice_json TEXT NOT NULL, started_at TEXT NOT NULL,
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE
	);
	CREATE TABLE lease (
		name TEXT PRIMARY KEY CHECK(name = 'control-plane'), owner_token TEXT NOT NULL,
		pid INTEGER NOT NULL, host TEXT NOT NULL, heartbeat_at INTEGER NOT NULL
	);
	CREATE INDEX memberships_ticket_active ON memberships(ticket_identity, active);
	CREATE INDEX attempts_ticket_open ON handoff_attempts(ticket_identity, resolved_at);
`;

/** The v1 to v2 step: completion handling (the spec's migration). */
const MIGRATION_V1_TO_V2 = `
	ALTER TABLE handoffs ADD COLUMN pane_id TEXT;
	ALTER TABLE handoffs ADD COLUMN tab_id TEXT;
	ALTER TABLE handoffs ADD COLUMN workspace_id TEXT;
	CREATE TABLE completion_traces (
		id TEXT PRIMARY KEY,
		handoff_id TEXT NOT NULL,
		ticket_identity TEXT NOT NULL,
		work_cycle INTEGER NOT NULL,
		task_type TEXT NOT NULL,
		agent_type TEXT NOT NULL,
		agent_name TEXT NOT NULL,
		completed_at TEXT NOT NULL,
		last_message TEXT NOT NULL,
		decision TEXT,
		decided_at TEXT,
		FOREIGN KEY (handoff_id) REFERENCES handoffs(attempt_id) ON DELETE CASCADE,
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE
	);
	CREATE INDEX traces_handoff_pending ON completion_traces(handoff_id, decision);
	CREATE INDEX traces_ticket ON completion_traces(ticket_identity, completed_at);
`;

/** Open state synchronously after creating its parent directory. */
export function openFactoryState(path: string): FactoryState {
	try {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		return new FactoryState(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new StateError(`cannot open factory state at ${path}: ${message}`);
	}
}

export class FactoryState {
	private readonly db: DatabaseSync;
	private leaseToken: string | undefined;
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		this.db = new DatabaseSync(path);
		try {
			this.db.exec("PRAGMA foreign_keys = ON");
			this.db.exec("PRAGMA journal_mode = WAL");
			this.migrate();
			const integrity = this.db.prepare("PRAGMA integrity_check").get() as
				| { integrity_check?: string }
				| undefined;
			if (integrity?.integrity_check !== "ok")
				throw new StateError(
					`database integrity check failed: ${integrity?.integrity_check ?? "unknown result"}`,
				);
		} catch (error) {
			this.db.close();
			if (error instanceof StateError) throw error;
			throw new StateError(
				`cannot prepare database ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private migrate(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
			const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as
				| { version: number }
				| undefined;
			const version = row?.version ?? 0;
			if (version > SCHEMA_VERSION)
				throw new StateError(`database ${this.path} uses newer schema version ${version}`);
			if (version < 1) this.db.exec(SCHEMA_V1);
			if (version < 2) {
				this.db.exec(MIGRATION_V1_TO_V2);
				// A resting done ticket's cycle has already ended: it returns
				// to open without a work-cycle bump.
				this.db.exec("UPDATE tickets SET state = 'open' WHERE state = 'done'");
				// The absent flag only served the old done-cycle bump.
				this.db.exec("ALTER TABLE tickets DROP COLUMN absent");
			}
			this.db.exec("DELETE FROM schema_version");
			this.db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
			this.db.exec("COMMIT");
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	/** Set configured sources to loading and deactivate removed memberships. */
	initializeSources(sources: readonly SourceDefinition[]): void {
		this.transaction(() => {
			const names = new Set(sources.map((source) => source.name));
			for (const row of this.db.prepare("SELECT source_name FROM source_health").all() as Array<{
				source_name: string;
			}>) {
				if (!names.has(row.source_name)) {
					this.db
						.prepare(
							"UPDATE source_health SET health = 'removed', error = 'source removed from config' WHERE source_name = ?",
						)
						.run(row.source_name);
					this.db
						.prepare("UPDATE memberships SET active = 0 WHERE source_name = ?")
						.run(row.source_name);
				}
			}
			for (const source of sources) {
				const exists = this.db
					.prepare("SELECT source_name FROM source_health WHERE source_name = ?")
					.get(source.name);
				if (exists === undefined) {
					this.db
						.prepare(
							"INSERT INTO source_health(source_name, kind, health, error, last_success) VALUES (?, ?, 'loading', NULL, NULL)",
						)
						.run(source.name, source.kind);
				} else {
					this.db
						.prepare(
							"UPDATE source_health SET kind = ?, health = 'loading', error = NULL WHERE source_name = ?",
						)
						.run(source.kind, source.name);
				}
			}
			// A configuration removal is not a successful external snapshot.
			// A renamed source can return the same identity during this startup,
			// so it must not start a new work cycle merely from this change.
		});
	}

	/** Apply a complete snapshot. A failed fetch changes only source health. */
	applyFetch(source: SourceDefinition, outcome: FetchOutcome): void {
		this.transaction(() => {
			this.ensureSource(source);
			if (outcome.status === "failed") {
				this.db
					.prepare("UPDATE source_health SET health = 'stale', error = ? WHERE source_name = ?")
					.run(outcome.reason, source.name);
				return;
			}
			const returned = new Set(outcome.tickets.map((ticket) => ticket.identity));
			for (const ticket of outcome.tickets) {
				this.db
					.prepare(
						"INSERT INTO tickets(identity, state, work_cycle) VALUES (?, 'open', 1) ON CONFLICT(identity) DO NOTHING",
					)
					.run(ticket.identity);
				this.db
					.prepare(`
					INSERT INTO memberships(source_name, ticket_identity, active, source_kind, external_key, source_state, url, title, description, labels_json, external_updated_at, repository_identity, repository_display_name, repository_clone_url, attributes_json)
					VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(source_name, ticket_identity) DO UPDATE SET
						active = 1, source_kind = excluded.source_kind, external_key = excluded.external_key,
						source_state = excluded.source_state, url = excluded.url, title = excluded.title,
						description = excluded.description, labels_json = excluded.labels_json,
						external_updated_at = excluded.external_updated_at, repository_identity = excluded.repository_identity,
						repository_display_name = excluded.repository_display_name, repository_clone_url = excluded.repository_clone_url,
						attributes_json = excluded.attributes_json
				`)
					.run(
						source.name,
						ticket.identity,
						ticket.sourceKind,
						ticket.externalKey,
						ticket.sourceState,
						ticket.url,
						ticket.title,
						ticket.description,
						JSON.stringify(ticket.labels),
						ticket.externalUpdatedAt,
						ticket.repository.identity,
						ticket.repository.displayName,
						ticket.repository.cloneUrl,
						JSON.stringify(ticket.attributes),
					);
			}
			for (const row of this.db
				.prepare("SELECT ticket_identity FROM memberships WHERE source_name = ? AND active = 1")
				.all(source.name) as Array<{ ticket_identity: string }>) {
				if (!returned.has(row.ticket_identity))
					this.db
						.prepare(
							"UPDATE memberships SET active = 0 WHERE source_name = ? AND ticket_identity = ?",
						)
						.run(source.name, row.ticket_identity);
			}
			this.db
				.prepare(
					"UPDATE source_health SET health = 'healthy', error = NULL, last_success = ? WHERE source_name = ?",
				)
				.run(outcome.fetchedAt, source.name);
		});
	}

	private ensureSource(source: SourceDefinition): void {
		const row = this.db
			.prepare("SELECT source_name FROM source_health WHERE source_name = ?")
			.get(source.name);
		if (row === undefined)
			this.db
				.prepare("INSERT INTO source_health(source_name, kind, health) VALUES (?, ?, 'loading')")
				.run(source.name, source.kind);
	}

	/** Health facts are separate from handoff messages in the TUI. */
	sourceHealths(): Array<{ name: string; kind: string; health: Health; error?: string }> {
		return (
			this.db
				.prepare("SELECT source_name, kind, health, error FROM source_health ORDER BY source_name")
				.all() as Array<{ source_name: string; kind: string; health: Health; error: string | null }>
		).map((row) => ({
			name: row.source_name,
			kind: row.kind,
			health: row.health,
			...(row.error === null ? {} : { error: row.error }),
		}));
	}

	/**
	 * Current visible ticket projection, ordered for operator attention.
	 *
	 * Tickets that hold in-flight work or a pending decision (handed-off,
	 * running, awaiting) keep their memberships even when every source has
	 * gone inactive: an agent can close or change its source item while it
	 * works, and the ticket must stay visible for the decision.
	 */
	visibleTickets(rules: readonly TaskRule[], fallbackTaskType: string): Ticket[] {
		const rows = this.db.prepare("SELECT identity, state FROM tickets").all() as Array<{
			identity: string;
			state: TicketState;
		}>;
		const tickets: Ticket[] = [];
		for (const row of rows) {
			const storedMemberships = this.membershipsFor(row.identity, row.state);
			const active = storedMemberships.filter(
				(membership) => membership.active && membership.health !== "removed",
			);
			const pending = this.hasUnresolvedAttempt(row.identity);
			const actionable =
				row.state === "open" &&
				!pending &&
				active.some((membership) => membership.health === "healthy");
			if (
				storedMemberships.length === 0 &&
				row.state !== "handed-off" &&
				row.state !== "running" &&
				row.state !== "awaiting"
			)
				continue;
			const facts = [...storedMemberships].sort(
				(a, b) =>
					b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
					a.sourceName.localeCompare(b.sourceName),
			)[0];
			if (facts === undefined) continue;
			const handoff = this.handoffFor(row.identity);
			tickets.push({
				identity: row.identity,
				title: facts.title,
				repository: facts.repository.displayName,
				state: row.state,
				handoff,
				handoffCount: this.handoffCount(row.identity),
				lastCompletion: this.lastCompletion(row.identity),
				description: facts.description,
				sourceKind: facts.sourceKind,
				externalKey: facts.externalKey,
				sourceState: facts.sourceState,
				url: facts.url,
				labels: facts.labels,
				externalUpdatedAt: facts.externalUpdatedAt,
				repositoryRef: facts.repository,
				memberships: storedMemberships.map(({ active: _active, ...membership }) => membership),
				suggestedTaskType: selectTaskType(
					storedMemberships.filter((membership) => membership.active),
					rules,
					fallbackTaskType,
				),
				actionable,
				handoffRecoveryRequired: pending,
			});
		}
		return tickets.sort(
			(left, right) =>
				attentionGroup(left) - attentionGroup(right) ||
				right.externalUpdatedAt.localeCompare(left.externalUpdatedAt) ||
				left.identity.localeCompare(right.identity),
		);
	}

	private membershipsFor(identity: string, state: TicketState): StoredMembership[] {
		const where =
			state === "handed-off" || state === "running" || state === "awaiting"
				? ""
				: "AND m.active = 1";
		const rows = this.db
			.prepare(`
			SELECT m.*, h.health FROM memberships m JOIN source_health h ON h.source_name = m.source_name
			WHERE m.ticket_identity = ? ${where}
		`)
			.all(identity) as unknown as MembershipRow[];
		return rows.map((row) => ({
			active: row.active === 1,
			sourceName: row.source_name,
			health: row.health,
			identity,
			sourceKind: row.source_kind,
			externalKey: row.external_key,
			sourceState: row.source_state,
			url: row.url,
			title: row.title,
			description: row.description,
			labels: jsonStringArray(row.labels_json),
			externalUpdatedAt: row.external_updated_at,
			repository: {
				identity: row.repository_identity,
				displayName: row.repository_display_name,
				cloneUrl: row.repository_clone_url,
			},
			attributes: jsonStringRecord(row.attributes_json),
		}));
	}

	private hasUnresolvedAttempt(identity: string): boolean {
		return (
			this.db
				.prepare(
					"SELECT attempt_id FROM handoff_attempts WHERE ticket_identity = ? AND resolved_at IS NULL LIMIT 1",
				)
				.get(identity) !== undefined
		);
	}

	private handoffFor(identity: string): Ticket["handoff"] {
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
		if (row === undefined) return null;
		const choice = jsonChoice(row.choice_json);
		if (choice === undefined) return null;
		return {
			agentType: choice.agentType,
			environment: choice.environment,
			taskType: choice.taskType,
			model: choice.model,
			thinking: choice.thinking,
			attemptId: row.attempt_id,
			paneId: row.pane_id,
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
		};
	}

	/** The total handoffs ever recorded for a ticket, across work cycles. */
	handoffCount(identity: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS count FROM handoffs WHERE ticket_identity = ?")
			.get(identity) as { count: number };
		return row.count;
	}

	/** The ticket's latest settled turn, or null when none settled yet. */
	lastCompletion(identity: string): Completion | null {
		const row = this.db
			.prepare(
				"SELECT task_type, agent_type, agent_name, completed_at, last_message, decision FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as
			| {
					task_type: string;
					agent_type: string;
					agent_name: string;
					completed_at: string;
					last_message: string;
					decision: string | null;
			  }
			| undefined;
		if (row === undefined) return null;
		return {
			taskType: row.task_type,
			agentType: row.agent_type,
			agentName: row.agent_name,
			completedAt: row.completed_at,
			message: row.last_message,
			decision: row.decision as CompletionDecision | null,
		};
	}

	/**
	 * The durable state of one ticket, or undefined when the ticket no
	 * longer exists. A queued handoff re-reads it before it runs: the
	 * projection filters visibility, but a handoff waits on the state.
	 */
	ticketState(identity: string): TicketState | undefined {
		const row = this.db.prepare("SELECT state FROM tickets WHERE identity = ?").get(identity) as
			| { state: TicketState }
			| undefined;
		return row?.state;
	}

	/**
	 * The name the factory started the ticket's agent with: derived from
	 * the ticket title by the same rule the handoff applies. The herdr
	 * list does not expose it, and its own agent field holds the kind.
	 */
	agentNameForTicket(identity: string): string {
		const row = this.db
			.prepare(
				"SELECT m.title FROM memberships m WHERE m.ticket_identity = ? AND m.active = 1 ORDER BY m.source_name LIMIT 1",
			)
			.get(identity) as { title: string } | undefined;
		return row === undefined ? "" : agentNameFor(row.title);
	}

	/**
	 * The environment handles of the ticket's latest handoff: what a Close
	 * cleanup closes. Null when the ticket never had a handoff.
	 */
	latestHandoff(identity: string): {
		environment: EnvironmentKind;
		tabId: string | null;
		workspaceId: string | null;
	} | null {
		const row = this.db
			.prepare(
				"SELECT choice_json, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as
			| { choice_json: string; tab_id: string | null; workspace_id: string | null }
			| undefined;
		if (row === undefined) return null;
		const choice = jsonChoice(row.choice_json);
		return {
			environment: choice?.environment ?? "worktree",
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
		};
	}

	/**
	 * Tickets in one of the given states, joined with their latest handoff's
	 * choices and herdr handles. The observation loop reads in-flight and
	 * awaiting tickets through this.
	 */
	ticketsByState(states: readonly TicketState[]): HandoffTicket[] {
		const clauses = states.map(() => "?").join(", ");
		const rows = this.db
			.prepare(
				`SELECT t.identity AS ticket_identity, t.work_cycle, h.attempt_id, h.choice_json, h.pane_id, h.tab_id, h.workspace_id
				FROM tickets t JOIN handoffs h ON h.attempt_id = (
					SELECT attempt_id FROM handoffs WHERE ticket_identity = t.identity
					ORDER BY started_at DESC, rowid DESC LIMIT 1
				) WHERE t.state IN (${clauses}) ORDER BY t.identity`,
			)
			.all(...states) as Array<{
			ticket_identity: string;
			work_cycle: number;
			attempt_id: string;
			choice_json: string;
			pane_id: string | null;
			tab_id: string | null;
			workspace_id: string | null;
		}>;
		const out: HandoffTicket[] = [];
		for (const row of rows) {
			const choice = jsonChoice(row.choice_json);
			if (choice === undefined) continue;
			out.push({
				ticketIdentity: row.ticket_identity,
				workCycle: row.work_cycle,
				taskType: choice.taskType,
				agentType: choice.agentType,
				environment: choice.environment,
				paneId: row.pane_id,
				tabId: row.tab_id,
				workspaceId: row.workspace_id,
				handoffAttemptId: row.attempt_id,
			});
		}
		return out;
	}

	/**
	 * An in-flight ticket whose agent reports working. A no-op when the
	 * ticket already runs; returns whether the state changed.
	 */
	markTicketRunning(identity: string): boolean {
		const result = this.db
			.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'handed-off'")
			.run(identity);
		return Number(result.changes) > 0;
	}

	/**
	 * Settle a turn: the ticket rests in awaiting, and its completion trace
	 * holds the captured message with a null decision until one is made.
	 *
	 * Settling the same handoff again updates its pending trace in place:
	 * the trace belongs to the handoff, and a second settle of the same
	 * turn is a refresh, not a new completion.
	 */
	settleTurn(input: SettleTurnInput): void {
		this.transaction(() => {
			this.db
				.prepare(
					"UPDATE tickets SET state = 'awaiting' WHERE identity = ? AND state IN ('handed-off', 'running', 'awaiting')",
				)
				.run(input.ticketIdentity);
			const handoff = this.db
				.prepare("SELECT work_cycle FROM handoffs WHERE attempt_id = ?")
				.get(input.handoffId) as { work_cycle: number } | undefined;
			const pending = this.db
				.prepare("SELECT id FROM completion_traces WHERE handoff_id = ? AND decision IS NULL")
				.get(input.handoffId) as { id: string } | undefined;
			if (handoff === undefined) return;
			if (pending !== undefined) {
				this.db
					.prepare("UPDATE completion_traces SET last_message = ?, completed_at = ? WHERE id = ?")
					.run(input.message, input.completedAt, pending.id);
			} else {
				this.db
					.prepare(
						"INSERT INTO completion_traces(id, handoff_id, ticket_identity, work_cycle, task_type, agent_type, agent_name, completed_at, last_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						randomUUID(),
						input.handoffId,
						input.ticketIdentity,
						handoff.work_cycle,
						input.taskType,
						input.agentType,
						this.agentNameForTicket(input.ticketIdentity),
						input.completedAt,
						input.message,
					);
			}
		});
	}

	/**
	 * Make the decision on one settled turn.
	 *
	 * `closed`, `auto-closed`, and `abandoned` end the work cycle: the
	 * ticket returns to open with the cycle incremented. `goto` refocuses
	 * the existing agent and moves an awaiting ticket back to running.
	 * A handoff decision leaves the state to the handoff that follows it.
	 *
	 * The decision lands on the handoff's pending trace row. When the turn
	 * never settled there is no pending row, and only `abandoned` and
	 * `goto` still write one - once per handoff - so an un-settled cycle
	 * leaves a complete trace. The ticket state moves only when this call
	 * wrote or updated the trace, so a double decision can never bump the
	 * cycle number twice. Returns whether the decision was applied.
	 */
	applyCompletionDecision(input: CompletionDecisionInput): boolean {
		return this.transaction(() => {
			const decided = this.db
				.prepare(
					"UPDATE completion_traces SET decision = ?, decided_at = ? WHERE handoff_id = ? AND decision IS NULL",
				)
				.run(input.decision, input.decidedAt, input.handoffId);
			if (Number(decided.changes) > 0) {
				this.applyDecisionStateChange(input);
				return true;
			}
			// No pending row: the turn never settled. Abandon and Goto record
			// their decision anyway, once per handoff, so the trace stays
			// complete and the cycle number moves exactly once.
			if (input.decision !== "abandoned" && input.decision !== "goto") return false;
			const existing = this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM completion_traces WHERE handoff_id = ? AND decision = ?",
				)
				.get(input.handoffId, input.decision) as { count: number };
			if (existing.count > 0) return false;
			const handoff = this.db
				.prepare("SELECT work_cycle, choice_json FROM handoffs WHERE attempt_id = ?")
				.get(input.handoffId) as { work_cycle: number; choice_json: string } | undefined;
			if (handoff === undefined) return false;
			const choice = jsonChoice(handoff.choice_json);
			this.db
				.prepare(
					"INSERT INTO completion_traces(id, handoff_id, ticket_identity, work_cycle, task_type, agent_type, agent_name, completed_at, last_message, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					randomUUID(),
					input.handoffId,
					input.ticketIdentity,
					handoff.work_cycle,
					choice?.taskType ?? "",
					choice?.agentType ?? "",
					this.agentNameForTicket(input.ticketIdentity),
					input.decidedAt,
					"",
					input.decision,
					input.decidedAt,
				);
			this.applyDecisionStateChange(input);
			return true;
		});
	}

	/** The ticket state move of a decision this call applied. */
	private applyDecisionStateChange(input: CompletionDecisionInput): void {
		if (input.decision === "goto") {
			this.db
				.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'awaiting'")
				.run(input.ticketIdentity);
		} else if (
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
		// handed-off and auto-handed-off: the handoff's settle moves the state.
	}

	/** Claim before the first external command. It rechecks all eligibility atomically. */
	claimHandoff(ticketIdentity: string, choice: HandoffChoice, origin: HandoffOrigin): ClaimOutcome {
		try {
			return this.transaction(() => {
				const ticket = this.db
					.prepare("SELECT state, work_cycle FROM tickets WHERE identity = ?")
					.get(ticketIdentity) as { state: TicketState; work_cycle: number } | undefined;
				if (ticket === undefined) return { ok: false, reason: "ticket no longer exists" };
				if (origin === "open") {
					if (ticket.state !== "open")
						return {
							ok: false,
							reason: `only open tickets can be handed off (this one is ${ticket.state})`,
						};
					const eligible = this.db
						.prepare(
							`SELECT 1 FROM memberships m JOIN source_health h ON h.source_name = m.source_name WHERE m.ticket_identity = ? AND m.active = 1 AND h.health = 'healthy' LIMIT 1`,
						)
						.get(ticketIdentity);
					if (eligible === undefined)
						return {
							ok: false,
							reason:
								"ticket is not actionable because all source memberships are stale, removed, or absent",
						};
				}
				if (origin === "workflow" && ticket.state !== "awaiting")
					return {
						ok: false,
						reason: `only awaiting tickets can be handed off along a workflow (this one is ${ticket.state})`,
					};
				if (origin === "restart" && ticket.state !== "handed-off" && ticket.state !== "running")
					return {
						ok: false,
						reason: `only in-flight tickets can be restarted (this one is ${ticket.state})`,
					};
				if (this.hasUnresolvedAttempt(ticketIdentity))
					return { ok: false, reason: "handoff recovery is required before another handoff" };
				const attemptId = randomUUID();
				this.db
					.prepare(
						"INSERT INTO handoff_attempts(attempt_id, ticket_identity, work_cycle, choice_json, stage, created_at) VALUES (?, ?, ?, ?, 'claimed', ?)",
					)
					.run(
						attemptId,
						ticketIdentity,
						ticket.work_cycle,
						JSON.stringify(choice),
						new Date().toISOString(),
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

	/**
	 * Settle known outcomes. An agent-started outcome advances factory state
	 * and records the herdr handles the handoff started.
	 */
	settleHandoff(
		attemptId: string,
		agentStarted: boolean,
		failureReason?: string,
		details?: HandoffDetails,
	): void {
		this.transaction(() => {
			const attempt = this.db
				.prepare(
					"SELECT ticket_identity, work_cycle, choice_json FROM handoff_attempts WHERE attempt_id = ? AND resolved_at IS NULL",
				)
				.get(attemptId) as
				| { ticket_identity: string; work_cycle: number; choice_json: string }
				| undefined;
			if (attempt === undefined) return;
			if (agentStarted) {
				this.db
					.prepare(
						"UPDATE tickets SET state = 'handed-off' WHERE identity = ? AND state IN ('open', 'awaiting')",
					)
					.run(attempt.ticket_identity);
				this.db
					.prepare(
						"INSERT OR REPLACE INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at, pane_id, tab_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						attemptId,
						attempt.ticket_identity,
						attempt.work_cycle,
						attempt.choice_json,
						new Date().toISOString(),
						details?.paneId ?? null,
						details?.tabId ?? null,
						details?.workspaceId ?? null,
					);
			}
			this.db
				.prepare(
					"UPDATE handoff_attempts SET stage = ?, resolved_at = ?, failure_reason = ? WHERE attempt_id = ?",
				)
				.run(
					agentStarted ? "agent-started" : "failed",
					new Date().toISOString(),
					failureReason ?? null,
					attemptId,
				);
		});
	}

	acquireLease(): void {
		const owner = randomUUID();
		const host = os.hostname();
		const now = Date.now();
		this.transaction(() => {
			const current = this.db
				.prepare("SELECT owner_token, pid, host FROM lease WHERE name = 'control-plane'")
				.get() as { owner_token: string; pid: number; host: string } | undefined;
			if (current !== undefined && !this.isDeadLocalOwner(current, host))
				throw new StateError(
					`state database is already in use by process ${current.pid} on ${current.host}`,
				);
			this.db
				.prepare(
					"INSERT OR REPLACE INTO lease(name, owner_token, pid, host, heartbeat_at) VALUES ('control-plane', ?, ?, ?, ?)",
				)
				.run(owner, process.pid, host, now);
		});
		this.leaseToken = owner;
	}

	private isDeadLocalOwner(current: { pid: number; host: string }, host: string): boolean {
		if (current.host !== host) return false;
		// PID liveness is the safe local reclaim signal. A PID can theoretically
		// be reused before this check, so the heartbeat remains diagnostic data,
		// not proof that a different process owns the lease.
		try {
			process.kill(current.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	}

	heartbeatLease(): void {
		if (this.leaseToken === undefined) return;
		this.db
			.prepare("UPDATE lease SET heartbeat_at = ? WHERE name = 'control-plane' AND owner_token = ?")
			.run(Date.now(), this.leaseToken);
	}
	releaseLease(): void {
		if (this.leaseToken === undefined) return;
		this.db
			.prepare("DELETE FROM lease WHERE name = 'control-plane' AND owner_token = ?")
			.run(this.leaseToken);
		this.leaseToken = undefined;
	}
	close(): void {
		this.releaseLease();
		this.db.close();
	}

	private transaction<T>(body: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}
}

function attentionGroup(ticket: Ticket): number {
	if (ticket.state === "awaiting") return 0;
	if (ticket.state === "running") return 1;
	if (ticket.state === "handed-off") return 2;
	if (ticket.state === "open" && ticket.actionable) return 3;
	if (ticket.state === "open") return 4;
	return 5;
}
function jsonStringArray(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
	} catch {
		return [];
	}
}
function jsonStringRecord(value: string): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Object.fromEntries(
					Object.entries(parsed).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
	} catch {
		return {};
	}
}
function jsonChoice(value: string): HandoffChoice | undefined {
	try {
		const parsed = JSON.parse(value) as Partial<HandoffChoice>;
		return typeof parsed.agentType === "string" &&
			(parsed.environment === "live-worktree" ||
				parsed.environment === "worktree" ||
				parsed.environment === "container") &&
			typeof parsed.taskType === "string" &&
			typeof parsed.model === "string" &&
			typeof parsed.thinking === "string"
			? (parsed as HandoffChoice)
			: undefined;
	} catch {
		return undefined;
	}
}
