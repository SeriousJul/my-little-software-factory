/**
 * SQLite state ownership for the control plane.
 *
 * Source adapters only return external facts. This module owns work cycles,
 * memberships, source health, handoff claims, completion traces, and the
 * one-process lease.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskRule } from "./config.ts";
import type {
	Completion,
	CompletionDecision,
	EnvironmentKind,
	LeftoverEnvironment,
	SourceMembership,
	Ticket,
	TicketState,
} from "./domain/ticket.ts";
import type { HandoffChoice } from "./handoff.ts";
import { agentNameFor } from "./naming.ts";
import { selectTaskType } from "./task-selection.ts";
import type { FetchOutcome } from "./ticket-source.ts";
import { type TurnLogEntry, turnLogFromCapture } from "./turn-log.ts";

const SCHEMA_VERSION = 6;
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
	/** The agent's messages of the turn, in order, from its session record. */
	turnLog: TurnLogEntry[];
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
	/** The herdr name the agent started under. */
	agentName?: string | null;
}

export const CONSULTATION_STATES = [
	"opening",
	"working",
	"awaiting-response",
	"missing",
	"failed",
	"closing",
	"closed",
] as const;
export type ConsultationState = (typeof CONSULTATION_STATES)[number];

export interface ConsultationRepository {
	identity: string;
	displayName: string;
	cloneUrl: string;
	path: string;
}

/** The durable identity and current projection of one Consultation. */
export interface Consultation {
	id: string;
	typeName: string;
	agentType: string;
	environment: EnvironmentKind;
	model: string;
	thinking: string;
	template: string;
	initialInput: string;
	renderedOpeningPrompt: string;
	repository: ConsultationRepository;
	state: ConsultationState;
	createdAt: string;
	updatedAt: string;
	agentName: string;
	paneId: string | null;
	tabId: string | null;
	workspaceId: string | null;
	sessionId: string | null;
	latestSequence: number | null;
	draft: string;
	draftUpdatedAt: string | null;
	draftOld: boolean;
	failure: string | null;
	warning: string | null;
	replacementOf: string | null;
	closeResult: string | null;
	liveConflictOverride: boolean;
	attentionAt: string | null;
	pendingResponse: ConsultationPendingResponse | null;
	resources: ConsultationResource[];
}

export interface ConsultationResource {
	kind: string;
	resourceId: string;
	owned: boolean;
	confirmedClosed: boolean;
	details: string;
}

/** A response submitted to Herdr whose acceptance is not yet confirmed. */
export interface ConsultationPendingResponse {
	id: string;
	consultationId: string;
	input: string;
	sequenceBaseline: number | null;
	createdAt: string;
}

export interface ConsultationTurn {
	id: string;
	consultationId: string;
	input: string;
	acceptedAt: string;
	sequenceBaseline: number | null;
	settledAt: string | null;
	settledStatus: string | null;
	snapshotId: string | null;
}

export interface ConsultationSnapshot {
	id: string;
	consultationId: string;
	turnId: string | null;
	text: string;
	capturedAt: string;
	partial: boolean;
	truncated: boolean;
}

export interface CreateConsultationInput {
	id?: string;
	typeName: string;
	agentType: string;
	environment: EnvironmentKind;
	model?: string;
	thinking?: string;
	template: string;
	initialInput: string;
	renderedOpeningPrompt: string;
	repository: ConsultationRepository;
	agentName: string;
	replacementOf?: string | null;
	liveConflictOverride?: boolean;
	createdAt?: string;
}

export interface ConsultationAgentDetails {
	paneId: string;
	tabId?: string | null;
	workspaceId?: string | null;
	sessionId?: string | null;
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
	paneId: string | null;
	tabId: string | null;
	workspaceId: string | null;
	/** The attempt id of the latest handoff. */
	handoffAttemptId: string;
	/** When the handoff's agent started, in ISO time. */
	startedAt: string;
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

/**
 * The v3 step: the trace's turn log. The settled turn's messages, in order,
 * from the agent's session record (ADR 0008), as JSON. A legacy v2 trace
 * reads NULL here and degrades to a plain-text log of its last message on
 * read.
 */
const MIGRATION_V2_TO_V3 = "ALTER TABLE completion_traces ADD COLUMN turn_log_json TEXT;";

/**
 * The stored turn log of a trace, or its degraded form. A legacy trace
 * predates the column and reads NULL: its last message, one line per entry,
 * stands in for the log. Unreadable JSON degrades the same way, so a
 * corrupt cell never blanks the modal.
 */
function turnLogOf(json: string | null, lastMessage: string): TurnLogEntry[] {
	if (json === null) return turnLogFromCapture(lastMessage);
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return turnLogFromCapture(lastMessage);
	}
	if (!Array.isArray(parsed)) return turnLogFromCapture(lastMessage);
	const entries: TurnLogEntry[] = [];
	for (const value of parsed) {
		if (!isRecord(value)) continue;
		if (value.kind === "text" && typeof value.text === "string") {
			entries.push({ kind: "text", text: value.text });
		} else if (
			value.kind === "tool" &&
			typeof value.name === "string" &&
			typeof value.target === "string" &&
			typeof value.failed === "boolean"
		) {
			entries.push({ kind: "tool", name: value.name, target: value.target, failed: value.failed });
		}
	}
	return entries.length > 0 ? entries : turnLogFromCapture(lastMessage);
}

/** A record guard for the stored log's entries. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Durable Consultation state. This migration is additive and composes with v3. */
const MIGRATION_V3_TO_V4 = `
	CREATE TABLE consultations (
		id TEXT PRIMARY KEY, type_name TEXT NOT NULL, agent_type TEXT NOT NULL,
		environment TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT NOT NULL,
		template TEXT NOT NULL, initial_input TEXT NOT NULL, rendered_opening_prompt TEXT NOT NULL,
		repository_identity TEXT NOT NULL, repository_display_name TEXT NOT NULL,
		repository_clone_url TEXT NOT NULL, repository_path TEXT NOT NULL,
		state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		agent_name TEXT NOT NULL, pane_id TEXT, tab_id TEXT, workspace_id TEXT, session_id TEXT,
		latest_sequence INTEGER, draft TEXT NOT NULL DEFAULT '', draft_updated_at TEXT,
		draft_old INTEGER NOT NULL DEFAULT 0, failure TEXT, warning TEXT,
		replacement_of TEXT, close_result TEXT, live_conflict_override INTEGER NOT NULL DEFAULT 0,
		attention_at TEXT
	);
	CREATE TABLE consultation_turns (
		id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL, input TEXT NOT NULL,
		accepted_at TEXT NOT NULL, sequence_baseline INTEGER, settled_at TEXT,
		settled_status TEXT, snapshot_id TEXT,
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
	CREATE TABLE consultation_snapshots (
		id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL, turn_id TEXT,
		text TEXT NOT NULL, captured_at TEXT NOT NULL, partial INTEGER NOT NULL DEFAULT 0,
		truncated INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
		FOREIGN KEY (turn_id) REFERENCES consultation_turns(id) ON DELETE SET NULL
	);
	CREATE UNIQUE INDEX consultation_turn_snapshot ON consultation_snapshots(turn_id) WHERE turn_id IS NOT NULL AND partial = 0;
	CREATE TABLE consultation_resources (
		consultation_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
		owned INTEGER NOT NULL, confirmed_closed INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (consultation_id, kind, resource_id),
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
	CREATE TABLE consultation_remaining_resources (
		consultation_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
		details TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (consultation_id, kind, resource_id),
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
	CREATE INDEX consultations_state_attention ON consultations(state, attention_at, updated_at);
	CREATE INDEX consultation_turns_consultation ON consultation_turns(consultation_id, accepted_at);
	CREATE INDEX consultation_snapshots_consultation ON consultation_snapshots(consultation_id, captured_at);
`;

/** Pending prompt delivery is durable, but is not a turn until Herdr accepts it. */
const MIGRATION_V4_TO_V5 = `
	CREATE TABLE consultation_pending_responses (
		id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL UNIQUE, input TEXT NOT NULL,
		sequence_baseline INTEGER, created_at TEXT NOT NULL,
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
`;

/**
 * The v6 step: what a handoff left behind, and what herdr called its agent.
 *
 * The Close cleanup can fail: herdr refuses to remove a dirty checkout
 * without force, so the workspace, its pane, and the agent in it outlive the
 * work cycle that started them. The ticket's next handoff then needs the
 * herdr agent name that leftover agent still holds. Three columns make the
 * surviving environment a fact on the handoff it belongs to: why the control
 * plane knows it is alive, when it learned that, and when the operator
 * cleared it (null while the fact stands).
 *
 * The fourth column records the herdr name the agent started under. A handoff
 * normally asks for the ticket's stable name, which the naming rule can
 * re-derive from the title. It does not always get it: a leftover agent of
 * the ticket's own can still hold that name, and the handoff then starts
 * under its cycle name (ADR 0012). Herdr's answer is a fact of that handoff,
 * so the completion trace of its turn reads it here instead of guessing.
 */
const MIGRATION_V5_TO_V6 = `
	ALTER TABLE handoffs ADD COLUMN leftover_reason TEXT;
	ALTER TABLE handoffs ADD COLUMN leftover_at TEXT;
	ALTER TABLE handoffs ADD COLUMN leftover_cleared_at TEXT;
	ALTER TABLE handoffs ADD COLUMN herdr_name TEXT;
`;

/** Open state synchronously after creating its parent directory. */
export function openFactoryState(path: string, now?: () => number): FactoryState {
	try {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		if (path !== ":memory:") chmodSync(dirname(path), 0o700);
		return new FactoryState(path, now);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new StateError(`cannot open factory state at ${path}: ${message}`);
	}
}

export class FactoryState {
	private readonly db: DatabaseSync;
	private leaseToken: string | undefined;
	readonly path: string;
	/** The clock for internal timestamps. Tests pin it. */
	private readonly now: () => number;

	constructor(path: string, now: () => number = () => Date.now()) {
		this.path = path;
		this.now = now;
		this.db = new DatabaseSync(path);
		try {
			this.db.exec("PRAGMA foreign_keys = ON");
			this.db.exec("PRAGMA secure_delete = ON");
			this.verifyIntegrity();
			this.db.exec("PRAGMA journal_mode = WAL");
			if (path !== ":memory:") chmodSync(path, 0o600);
			this.migrate();
			if (path !== ":memory:") {
				// SQLite creates these sidecar files lazily. Keep every state file
				// owner-readable when they exist.
				for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
					try {
						chmodSync(sidecar, 0o600);
					} catch {}
				}
			}
		} catch (error) {
			this.db.close();
			if (error instanceof StateError) throw error;
			throw new StateError(
				`cannot prepare database ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Refuse a damaged state file before any write, including the journal mode
	 * switch. The check runs before migrate because a migration's DDL can touch
	 * a damaged page and mask the corruption with a generic "malformed" error.
	 */
	private verifyIntegrity(): void {
		try {
			const integrity = this.db.prepare("PRAGMA integrity_check").get() as
				| { integrity_check?: string }
				| undefined;
			if (integrity?.integrity_check !== "ok")
				throw new StateError(
					`database integrity check failed at ${this.path}: ${integrity?.integrity_check ?? "unknown result"}`,
				);
		} catch (error) {
			if (error instanceof StateError) throw error;
			throw new StateError(
				`database integrity check failed at ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private hasTable(name: string): boolean {
		return (
			this.db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(name) !== undefined
		);
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
			// A database which claims a known version but lacks that version's
			// core aggregate is not a valid state database. Treat it as newer.
			const coreTable = version >= 4 ? "consultations" : "tickets";
			if (version > 0 && !this.hasTable(coreTable))
				throw new StateError(`database ${this.path} uses newer schema version ${version}`);
			if (version < 1) this.db.exec(SCHEMA_V1);
			if (version < 2) {
				this.db.exec(MIGRATION_V1_TO_V2);
				// Legacy `done` means that the Agent settled. Preserve its work
				// cycle and expose the missing Completion decision.
				this.db.exec("UPDATE tickets SET state = 'awaiting' WHERE state = 'done'");
				// The absent flag only served the old done-cycle bump.
				this.db.exec("ALTER TABLE tickets DROP COLUMN absent");
			}
			if (version < 3) this.db.exec(MIGRATION_V2_TO_V3);
			if (version < 4) this.db.exec(MIGRATION_V3_TO_V4);
			if (version < 5) this.db.exec(MIGRATION_V4_TO_V5);
			if (version < 6) this.db.exec(MIGRATION_V5_TO_V6);
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
		const rows = this.db.prepare("SELECT identity, state, work_cycle FROM tickets").all() as Array<{
			identity: string;
			state: TicketState;
			work_cycle: number;
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
				workCycle: row.work_cycle,
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
				leftover: this.leftoverEnvironment(row.identity),
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
				"SELECT task_type, agent_type, agent_name, completed_at, last_message, turn_log_json, decision FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as
			| {
					task_type: string;
					agent_type: string;
					agent_name: string;
					completed_at: string;
					last_message: string;
					turn_log_json: string | null;
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
			turnLog: turnLogOf(row.turn_log_json, row.last_message),
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
	 *
	 * An active membership holds the current title. When the ticket lost
	 * every active membership (the agent closed its own source item, or the
	 * source was removed), the stale title still names the agent, so the
	 * lookup falls back to the ticket's remaining memberships.
	 */
	agentNameForTicket(identity: string): string {
		const started = this.db
			.prepare(
				"SELECT herdr_name FROM handoffs WHERE ticket_identity = ? AND herdr_name IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as { herdr_name: string | null } | undefined;
		if (started?.herdr_name !== undefined && started?.herdr_name !== null) {
			return started.herdr_name;
		}
		const row = this.db
			.prepare(
				"SELECT m.title FROM memberships m WHERE m.ticket_identity = ? ORDER BY m.active DESC, m.source_name LIMIT 1",
			)
			.get(identity) as { title: string } | undefined;
		return row === undefined ? "" : agentNameFor(row.title);
	}

	/**
	 * The environment handles of the ticket's latest handoff: what a Close
	 * cleanup closes. Null when the ticket never had a handoff.
	 */
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
		if (row === undefined) return null;
		const choice = jsonChoice(row.choice_json);
		return {
			handoffId: row.attempt_id,
			environment: choice?.environment ?? "worktree",
			paneId: row.pane_id,
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
		};
	}

	/**
	 * Record that the herdr environment of one of a ticket's handoffs is
	 * still alive after its work cycle closed.
	 *
	 * Two facts name the handoff: the Close cleanup of a known handoff
	 * carries its attempt id, and a handoff that found its agent name taken
	 * carries only the pane herdr named in the collision. With neither, the
	 * ticket's latest handoff is the one whose cycle closed. A fact that
	 * already stands on that handoff is refreshed, never duplicated.
	 *
	 * Returns the leftover environment, or null when the ticket holds no
	 * handoff to carry the fact.
	 */
	recordLeftoverEnvironment(input: {
		ticketIdentity: string;
		handoffId?: string | null;
		paneId?: string | null;
		reason: string;
		at?: string;
	}): LeftoverEnvironment | null {
		return this.transaction(() => {
			const row =
				input.handoffId !== undefined && input.handoffId !== null
					? (this.db
							.prepare(
								"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? AND attempt_id = ?",
							)
							.get(input.ticketIdentity, input.handoffId) as HandoffRow | undefined)
					: input.paneId !== undefined && input.paneId !== null
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
			if (row === undefined) return null;
			const at = input.at ?? new Date(this.now()).toISOString();
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

	/**
	 * The ticket's newest leftover environment that stands unresolved, or
	 * null when every environment its handoffs started is gone.
	 */
	leftoverEnvironment(identity: string): LeftoverEnvironment | null {
		const rows = this.leftoverEnvironments(identity);
		return rows.length === 0 ? null : rows[0];
	}

	/**
	 * Every unresolved leftover environment of a ticket, newest first.
	 *
	 * A ticket can hold more than one: a cycle can close twice over the same
	 * workspace herdr cannot remove, and a reused workspace carries the fact
	 * of each handoff that lived in it.
	 */
	leftoverEnvironments(identity: string): LeftoverEnvironment[] {
		const rows = this.db
			.prepare(
				"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id, leftover_reason, leftover_at FROM handoffs WHERE ticket_identity = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL ORDER BY started_at DESC, rowid DESC",
			)
			.all(identity) as unknown as Array<
			HandoffRow & { leftover_reason: string; leftover_at: string | null }
		>;
		const out: LeftoverEnvironment[] = [];
		for (const row of rows) {
			const choice = jsonChoice(row.choice_json);
			out.push({
				handoffId: row.attempt_id,
				environment: choice?.environment ?? "worktree",
				workspaceId: row.workspace_id,
				tabId: row.tab_id,
				paneId: row.pane_id,
				reason: row.leftover_reason,
				at: row.leftover_at ?? "",
			});
		}
		return out;
	}

	/**
	 * Mark a ticket's leftover environments cleared.
	 *
	 * A workspace id clears only the facts that name it: removing one
	 * workspace says nothing about another. A null workspace id answers a
	 * handoff row that recorded none: there is no workspace to name, so the
	 * close that ends it ends every environment the ticket could still hold.
	 * Returns how many facts were cleared.
	 */
	clearLeftoverEnvironments(identity: string, workspaceId: string | null): number {
		const at = new Date(this.now()).toISOString();
		const result =
			workspaceId === null
				? this.db
						.prepare(
							"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
						)
						.run(at, identity)
				: this.db
						.prepare(
							"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND workspace_id = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
						)
						.run(at, identity, workspaceId);
		return Number(result.changes);
	}

	/**
	 * The herdr handles every handoff of a ticket recorded.
	 *
	 * A handoff that finds its agent name taken uses these to tell its own
	 * leftover agent from another ticket's: herdr names the pane and the
	 * workspace that holds the name, and a handle this ticket recorded makes
	 * it the ticket's own.
	 */
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

	/**
	 * Tickets in one of the given states, joined with their latest handoff's
	 * choices and herdr handles. The observation loop reads in-flight and
	 * awaiting tickets through this.
	 */
	ticketsByState(states: readonly TicketState[]): HandoffTicket[] {
		const clauses = states.map(() => "?").join(", ");
		const rows = this.db
			.prepare(
				`SELECT t.identity AS ticket_identity, t.state, t.work_cycle, h.attempt_id, h.choice_json, h.started_at, h.pane_id, h.tab_id, h.workspace_id
				FROM tickets t JOIN handoffs h ON h.attempt_id = (
					SELECT attempt_id FROM handoffs WHERE ticket_identity = t.identity
					ORDER BY started_at DESC, rowid DESC LIMIT 1
				) WHERE t.state IN (${clauses}) ORDER BY t.identity`,
			)
			.all(...states) as Array<{
			ticket_identity: string;
			state: TicketState;
			work_cycle: number;
			started_at: string;
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
				state: row.state,
				workCycle: row.work_cycle,
				taskType: choice.taskType,
				agentType: choice.agentType,
				environment: choice.environment,
				model: choice.model,
				thinking: choice.thinking,
				paneId: row.pane_id,
				tabId: row.tab_id,
				workspaceId: row.workspace_id,
				handoffAttemptId: row.attempt_id,
				startedAt: row.started_at,
			});
		}
		return out;
	}

	/**
	 * The state correction the observation poll makes on read.
	 *
	 * The poll reads herdr, which owns the fact of whether the agent is
	 * working, and corrects a handed-off ticket to running to match that
	 * fact; the control plane never asks herdr to move a ticket. The
	 * correction is guarded on handed-off, so a settled, decided, or already
	 * running ticket is never moved by a late poll. Returns whether the
	 * state changed.
	 */
	markTicketRunning(identity: string): boolean {
		const result = this.db
			.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'handed-off'")
			.run(identity);
		return Number(result.changes) > 0;
	}

	/**
	 * The observation's correction for a turn that settled too early.
	 *
	 * An awaiting ticket whose herdr pane is working again goes back to
	 * running when its settled turn is still pending: the settle was
	 * premature (the agent was still starting) or the operator re-prompted
	 * the agent by hand, and the next settle refreshes the pending trace
	 * in place. A decided or missing trace keeps the ticket awaiting: the
	 * turn is over, and whatever the agent does now is not this turn.
	 * Returns whether the state changed.
	 */
	reopenTurn(identity: string, handoffId: string): boolean {
		return this.transaction(() => {
			const pending = this.db
				.prepare("SELECT id FROM completion_traces WHERE handoff_id = ? AND decision IS NULL")
				.get(handoffId) as { id: string } | undefined;
			if (pending === undefined) return false;
			const moved = this.db
				.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'awaiting'")
				.run(identity);
			return Number(moved.changes) > 0;
		});
	}

	/**
	 * The observation's correction for an agent that outlived its work cycle.
	 *
	 * A close ends a cycle and returns the ticket to open (ADR 0005), yet the
	 * agent that cycle started can keep working in the same herdr pane: the
	 * Close cleanup cannot remove a dirty checkout, and the operator can
	 * re-prompt a settled agent by hand. Herdr owns the fact that the agent
	 * works, so the poll records it as a Reclaimed handoff: a handoff in the
	 * ticket's current work cycle with the previous handoff's choices and the
	 * same herdr handles, and the ticket in `running`. It runs no command, and
	 * it rewrites nothing: the closed cycle keeps its handoff and its decided
	 * trace. The reclaim counts as a handoff, so the handoff limit bounds a
	 * close-and-reclaim loop.
	 *
	 * Returns the new attempt id, or null when the ticket is not open, holds no
	 * earlier handoff, or waits on an unresolved attempt.
	 */
	reclaimHandoff(
		identity: string,
		details: { paneId: string; tabId: string; workspaceId: string },
	): { attemptId: string } | null {
		return this.transaction(() => {
			const ticket = this.db
				.prepare("SELECT state, work_cycle FROM tickets WHERE identity = ?")
				.get(identity) as { state: TicketState; work_cycle: number } | undefined;
			if (ticket === undefined || ticket.state !== "open") return null;
			const previous = this.db
				.prepare(
					"SELECT choice_json FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
				)
				.get(identity) as { choice_json: string } | undefined;
			if (previous === undefined || jsonChoice(previous.choice_json) === undefined) return null;
			if (this.hasUnresolvedAttempt(identity)) return null;
			const moved = this.db
				.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'open'")
				.run(identity);
			if (Number(moved.changes) === 0) return null;
			const attemptId = randomUUID();
			const now = new Date(this.now()).toISOString();
			this.db
				.prepare(
					"INSERT INTO handoff_attempts(attempt_id, ticket_identity, work_cycle, choice_json, stage, created_at, resolved_at) VALUES (?, ?, ?, ?, 'reclaimed', ?, ?)",
				)
				.run(attemptId, identity, ticket.work_cycle, previous.choice_json, now, now);
			this.db
				.prepare(
					"INSERT INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at, pane_id, tab_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					attemptId,
					identity,
					ticket.work_cycle,
					previous.choice_json,
					now,
					details.paneId,
					details.tabId,
					details.workspaceId,
				);
			return { attemptId };
		});
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
					.prepare(
						"UPDATE completion_traces SET last_message = ?, turn_log_json = ?, completed_at = ? WHERE id = ?",
					)
					.run(input.message, JSON.stringify(input.turnLog), input.completedAt, pending.id);
			} else {
				this.db
					.prepare(
						"INSERT INTO completion_traces(id, handoff_id, ticket_identity, work_cycle, task_type, agent_type, agent_name, completed_at, last_message, turn_log_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
						JSON.stringify(input.turnLog),
					);
			}
		});
	}

	/**
	 * Make the decision on one settled turn.
	 *
	 * `closed`, `auto-closed`, and `abandoned` end the work cycle: the
	 * ticket returns to open with the cycle incremented. A handoff decision
	 * leaves the state to the handoff that follows it. `goto` is not a
	 * completion decision: it refocuses the existing agent and moves an
	 * awaiting ticket back to running, and the trace does not record it. The
	 * turn's pending trace stays pending, and the next settle refreshes it.
	 *
	 * A trace decision lands on the handoff's pending row. When the turn
	 * never settled there is no pending row, and only `abandoned` still
	 * writes one - once per handoff - so an un-settled cycle leaves a
	 * complete trace. The ticket state moves only when this call wrote or
	 * updated the trace (or, for `goto`, moved the state), so a double
	 * decision can never bump the cycle number twice. Returns whether the
	 * decision was applied.
	 */
	applyCompletionDecision(input: CompletionDecisionInput): boolean {
		return this.transaction(() => {
			if (input.decision === "goto") {
				// A state move only: the trace keeps recording the settled turn,
				// pending a real decision.
				const moved = this.db
					.prepare("UPDATE tickets SET state = 'running' WHERE identity = ? AND state = 'awaiting'")
					.run(input.ticketIdentity);
				return Number(moved.changes) > 0;
			}
			const decided = this.db
				.prepare(
					"UPDATE completion_traces SET decision = ?, decided_at = ? WHERE handoff_id = ? AND decision IS NULL",
				)
				.run(input.decision, input.decidedAt, input.handoffId);
			if (Number(decided.changes) > 0) {
				this.applyDecisionStateChange(input);
				return true;
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
						new Date(this.now()).toISOString(),
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
						"INSERT OR REPLACE INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at, pane_id, tab_id, workspace_id, herdr_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						attemptId,
						attempt.ticket_identity,
						attempt.work_cycle,
						attempt.choice_json,
						new Date(this.now()).toISOString(),
						details?.paneId ?? null,
						details?.tabId ?? null,
						details?.workspaceId ?? null,
						details?.agentName ?? null,
					);
			}
			this.db
				.prepare(
					"UPDATE handoff_attempts SET stage = ?, resolved_at = ?, failure_reason = ? WHERE attempt_id = ?",
				)
				.run(
					agentStarted ? "agent-started" : "failed",
					new Date(this.now()).toISOString(),
					failureReason ?? null,
					attemptId,
				);
		});
	}

	/** Create the Consultation record before any Herdr or git command runs. */
	createConsultation(input: CreateConsultationInput): Consultation {
		const id = input.id ?? randomUUID();
		const createdAt = input.createdAt ?? new Date().toISOString();
		this.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO consultations(
						id, type_name, agent_type, environment, model, thinking, template,
						initial_input, rendered_opening_prompt, repository_identity,
						repository_display_name, repository_clone_url, repository_path,
						state, created_at, updated_at, agent_name, draft, replacement_of,
						live_conflict_override, attention_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?, ?, ?, '', ?, ?, NULL)`,
				)
				.run(
					id,
					input.typeName,
					input.agentType,
					input.environment,
					input.model ?? "",
					input.thinking ?? "",
					input.template,
					input.initialInput,
					input.renderedOpeningPrompt,
					input.repository.identity,
					input.repository.displayName,
					input.repository.cloneUrl,
					input.repository.path,
					createdAt,
					createdAt,
					input.agentName,
					input.replacementOf ?? null,
					input.liveConflictOverride === true ? 1 : 0,
				);
			this.db
				.prepare(
					"INSERT INTO consultation_turns(id, consultation_id, input, accepted_at, sequence_baseline) VALUES (?, ?, ?, ?, NULL)",
				)
				.run(randomUUID(), id, input.initialInput, createdAt);
		});
		const consultation = this.consultation(id);
		if (consultation === undefined) throw new StateError(`consultation ${id} was not created`);
		return consultation;
	}

	/** Return one Consultation, including its current resource ownership. */
	consultation(id: string): Consultation | undefined {
		const row = this.db.prepare("SELECT * FROM consultations WHERE id = ?").get(id) as
			| ConsultationRow
			| undefined;
		return row === undefined ? undefined : this.consultationFromRow(row);
	}

	/** List Consultations by operator priority. Closed records are opt-in. */
	consultations(filter: "open" | "closed" | "all" = "open"): Consultation[] {
		const where =
			filter === "open"
				? "WHERE state <> 'closed'"
				: filter === "closed"
					? "WHERE state = 'closed'"
					: "";
		const rows = this.db
			.prepare(`SELECT * FROM consultations ${where}`)
			.all() as unknown as ConsultationRow[];
		return rows.map((row) => this.consultationFromRow(row)).sort(compareConsultations);
	}

	consultationCounts(): { awaitingResponse: number; recovery: number } {
		const rows = this.db
			.prepare(
				"SELECT state, COUNT(*) AS count FROM consultations WHERE state <> 'closed' GROUP BY state",
			)
			.all() as Array<{ state: ConsultationState; count: number }>;
		return {
			awaitingResponse: rows.find((row) => row.state === "awaiting-response")?.count ?? 0,
			recovery: rows
				.filter(
					(row) =>
						row.state === "missing" ||
						row.state === "failed" ||
						row.state === "closing" ||
						row.state === "opening",
				)
				.reduce((sum, row) => sum + row.count, 0),
		};
	}

	/** Persist the validated checkout selected during repository resolution. */
	setConsultationRepositoryPath(id: string, path: string): void {
		this.db
			.prepare("UPDATE consultations SET repository_path = ?, updated_at = ? WHERE id = ?")
			.run(path, new Date().toISOString(), id);
	}

	/** Record the one-shot operator approval for a live checkout conflict. */
	setConsultationLiveConflictOverride(id: string): void {
		this.db
			.prepare(
				"UPDATE consultations SET live_conflict_override = 1, updated_at = ? WHERE id = ? AND state = 'opening'",
			)
			.run(new Date().toISOString(), id);
	}

	/** Update the Herdr identity after the Agent has started. */
	setConsultationAgent(id: string, details: ConsultationAgentDetails): void {
		this.db
			.prepare(
				"UPDATE consultations SET pane_id = ?, tab_id = ?, workspace_id = ?, session_id = ?, state = 'working', updated_at = ?, failure = NULL WHERE id = ? AND state = 'opening'",
			)
			.run(
				details.paneId,
				details.tabId ?? null,
				details.workspaceId ?? null,
				details.sessionId ?? null,
				new Date().toISOString(),
				id,
			);
	}

	/** Whether an interrupted opening can be explicitly resumed by the operator. */
	canRecoverConsultationOpening(id: string): boolean {
		const row = this.db.prepare("SELECT state FROM consultations WHERE id = ?").get(id) as
			| { state: ConsultationState }
			| undefined;
		return row?.state === "opening";
	}

	/** Record an opening outcome. A pre-Agent failure is immutable. */
	failConsultationOpening(id: string, reason: string, agentStarted = false): void {
		this.db
			.prepare(
				agentStarted
					? "UPDATE consultations SET state = 'working', failure = ?, updated_at = ? WHERE id = ? AND state = 'opening'"
					: "UPDATE consultations SET state = 'failed', failure = ?, updated_at = ? WHERE id = ? AND state = 'opening'",
			)
			.run(reason, new Date().toISOString(), id);
	}

	/** Set a durable warning without changing the Consultation lifecycle. */
	setConsultationWarning(id: string, warning: string | null): void {
		this.db
			.prepare("UPDATE consultations SET warning = ?, updated_at = ? WHERE id = ?")
			.run(warning, new Date().toISOString(), id);
	}

	/** Save Agent handles before prompt delivery completes, for crash recovery. */
	recordConsultationAgentHandles(id: string, details: ConsultationAgentDetails): void {
		this.db
			.prepare(
				"UPDATE consultations SET pane_id = ?, tab_id = ?, workspace_id = ?, session_id = ?, updated_at = ? WHERE id = ? AND state = 'opening'",
			)
			.run(
				details.paneId,
				details.tabId ?? null,
				details.workspaceId ?? null,
				details.sessionId ?? null,
				new Date().toISOString(),
				id,
			);
	}

	/** Record a turn that began outside the control plane and mark a draft old. */
	recordExternalConsultationTurn(
		id: string,
		sequence: number,
		acceptedAt = new Date().toISOString(),
	): boolean {
		return this.transaction(() => {
			const row = this.db
				.prepare("SELECT state, latest_sequence, draft FROM consultations WHERE id = ?")
				.get(id) as
				| { state: ConsultationState; latest_sequence: number | null; draft: string }
				| undefined;
			if (row?.state !== "awaiting-response") return false;
			if (row.latest_sequence !== null && sequence <= row.latest_sequence) return false;
			const pending = this.pendingConsultationResponse(id);
			this.db
				.prepare(
					"INSERT INTO consultation_turns(id, consultation_id, input, accepted_at, sequence_baseline) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					randomUUID(),
					id,
					pending?.input ?? "[external Agent input not captured]",
					acceptedAt,
					pending?.sequenceBaseline ?? row.latest_sequence,
				);
			if (pending !== null)
				this.db.prepare("DELETE FROM consultation_pending_responses WHERE id = ?").run(pending.id);
			this.db
				.prepare(
					"UPDATE consultations SET state = 'working', latest_sequence = ?, draft_old = CASE WHEN draft <> '' THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?",
				)
				.run(sequence, acceptedAt, id);
			return true;
		});
	}

	/** Change a Consultation state, except that failed records cannot resume. */
	setConsultationState(id: string, next: ConsultationState, detail?: string | null): boolean {
		const result = this.db
			.prepare(
				"UPDATE consultations SET state = ?, updated_at = ?, failure = CASE WHEN ? IS NULL THEN failure ELSE ? END, warning = CASE WHEN ? IS NULL THEN warning ELSE ? END, close_result = CASE WHEN ? IS NULL THEN close_result ELSE ? END WHERE id = ? AND (state <> 'failed' OR ? IN ('closing', 'closed'))",
			)
			.run(
				next,
				new Date().toISOString(),
				next === "failed" ? (detail ?? null) : null,
				next === "failed" ? (detail ?? null) : null,
				next === "missing" ? (detail ?? null) : null,
				next === "missing" ? (detail ?? null) : null,
				next === "closed" ? (detail ?? null) : null,
				next === "closed" ? (detail ?? null) : null,
				id,
				next,
			);
		return Number(result.changes) > 0;
	}

	/** Save an unsent Response draft. It remains when the Agent rejects input. */
	setConsultationDraft(id: string, draft: string, old = false): void {
		this.db
			.prepare(
				"UPDATE consultations SET draft = ?, draft_updated_at = ?, draft_old = ?, updated_at = ? WHERE id = ?",
			)
			.run(draft, new Date().toISOString(), old ? 1 : 0, new Date().toISOString(), id);
	}

	/** Save a response delivery operation before asking Herdr to accept it. */
	beginConsultationResponse(
		id: string,
		input: string,
		sequenceBaseline: number | null = null,
	): ConsultationPendingResponse | undefined {
		return this.transaction(() => {
			const row = this.db.prepare("SELECT state FROM consultations WHERE id = ?").get(id) as
				| { state: ConsultationState }
				| undefined;
			if (row?.state !== "awaiting-response" || this.pendingConsultationResponse(id) !== null)
				return undefined;
			const pending: ConsultationPendingResponse = {
				id: randomUUID(),
				consultationId: id,
				input,
				sequenceBaseline,
				createdAt: new Date().toISOString(),
			};
			this.db
				.prepare(
					"INSERT INTO consultation_pending_responses(id, consultation_id, input, sequence_baseline, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(pending.id, id, input, sequenceBaseline, pending.createdAt);
			return pending;
		});
	}

	/** Commit a turn only after Herdr has accepted the pending prompt. */
	acceptConsultationResponse(id: string, pendingId: string): ConsultationTurn | undefined {
		return this.transaction(() => {
			const pending = this.pendingConsultationResponse(id);
			const row = this.db.prepare("SELECT state FROM consultations WHERE id = ?").get(id) as
				| { state: ConsultationState }
				| undefined;
			if (row?.state !== "awaiting-response" || pending?.id !== pendingId) return undefined;
			const turnId = randomUUID();
			const acceptedAt = new Date().toISOString();
			this.db
				.prepare(
					"INSERT INTO consultation_turns(id, consultation_id, input, accepted_at, sequence_baseline) VALUES (?, ?, ?, ?, ?)",
				)
				.run(turnId, id, pending.input, acceptedAt, pending.sequenceBaseline);
			this.db.prepare("DELETE FROM consultation_pending_responses WHERE id = ?").run(pendingId);
			this.db
				.prepare(
					"UPDATE consultations SET state = 'working', draft = '', draft_updated_at = NULL, draft_old = 0, updated_at = ? WHERE id = ?",
				)
				.run(acceptedAt, id);
			return this.consultationTurn(turnId);
		});
	}

	/** Discard a rejected pending delivery while preserving the durable draft. */
	cancelConsultationResponse(id: string, pendingId: string): boolean {
		const result = this.db
			.prepare("DELETE FROM consultation_pending_responses WHERE id = ? AND consultation_id = ?")
			.run(pendingId, id);
		return Number(result.changes) > 0;
	}

	pendingConsultationResponse(id: string): ConsultationPendingResponse | null {
		const row = this.db
			.prepare(
				"SELECT id, consultation_id, input, sequence_baseline, created_at FROM consultation_pending_responses WHERE consultation_id = ?",
			)
			.get(id) as
			| {
					id: string;
					consultation_id: string;
					input: string;
					sequence_baseline: number | null;
					created_at: string;
			  }
			| undefined;
		return row === undefined
			? null
			: {
					id: row.id,
					consultationId: row.consultation_id,
					input: row.input,
					sequenceBaseline: row.sequence_baseline,
					createdAt: row.created_at,
				};
	}

	/** Mark the first newer settled Agent observation and store its snapshot. */
	settleConsultationTurn(
		id: string,
		sequence: number | null,
		output: string | null,
		settledStatus = "idle",
		capturedAt = new Date().toISOString(),
	): boolean {
		return this.transaction(() => {
			const consultation = this.db
				.prepare("SELECT state FROM consultations WHERE id = ?")
				.get(id) as { state: ConsultationState } | undefined;
			if (
				consultation === undefined ||
				(consultation.state !== "working" && consultation.state !== "opening")
			)
				return false;
			const turn = this.db
				.prepare(
					"SELECT * FROM consultation_turns WHERE consultation_id = ? AND settled_at IS NULL ORDER BY accepted_at DESC LIMIT 1",
				)
				.get(id) as ConsultationTurnRow | undefined;
			if (turn === undefined) return false;
			// A null sequence is accepted for older Herdr versions. A known
			// sequence must be newer than the turn baseline.
			if (
				sequence !== null &&
				turn.sequence_baseline !== null &&
				sequence <= turn.sequence_baseline
			)
				return false;
			this.db
				.prepare(
					"UPDATE consultation_turns SET settled_at = ?, settled_status = ? WHERE id = ? AND settled_at IS NULL",
				)
				.run(capturedAt, settledStatus, turn.id);
			if (output !== null) {
				const bounded = boundedSnapshot(output);
				const snapshotId = randomUUID();
				this.db
					.prepare(
						"INSERT INTO consultation_snapshots(id, consultation_id, turn_id, text, captured_at, partial, truncated) VALUES (?, ?, ?, ?, ?, 0, ?)",
					)
					.run(snapshotId, id, turn.id, bounded.text, capturedAt, bounded.truncated ? 1 : 0);
				this.db
					.prepare("UPDATE consultation_turns SET snapshot_id = ? WHERE id = ?")
					.run(snapshotId, turn.id);
			}
			this.db
				.prepare(
					"UPDATE consultations SET state = 'awaiting-response', latest_sequence = ?, attention_at = ?, updated_at = ?, draft = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN '' ELSE draft END, draft_updated_at = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN NULL ELSE draft_updated_at END, draft_old = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN 0 ELSE draft_old END, warning = CASE WHEN ? IS NULL THEN 'Agent output is stale' WHEN warning = 'Agent output is stale' THEN NULL ELSE warning END WHERE id = ?",
				)
				.run(sequence, capturedAt, capturedAt, turn.id, turn.id, turn.id, output, id);
			return true;
		});
	}

	/** Add one best-effort partial output snapshot before close. */
	captureConsultationPartial(
		id: string,
		output: string | null,
		capturedAt = new Date().toISOString(),
	): void {
		if (output === null) return;
		const bounded = boundedSnapshot(output);
		this.db
			.prepare(
				"INSERT INTO consultation_snapshots(id, consultation_id, turn_id, text, captured_at, partial, truncated) VALUES (?, ?, NULL, ?, ?, 1, ?)",
			)
			.run(randomUUID(), id, bounded.text, capturedAt, bounded.truncated ? 1 : 0);
	}

	consultationTurn(id: string): ConsultationTurn | undefined {
		const row = this.db.prepare("SELECT * FROM consultation_turns WHERE id = ?").get(id) as
			| ConsultationTurnRow
			| undefined;
		return row === undefined ? undefined : turnFromRow(row);
	}

	consultationTurns(id: string): ConsultationTurn[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM consultation_turns WHERE consultation_id = ? ORDER BY accepted_at, rowid",
				)
				.all(id) as unknown as ConsultationTurnRow[]
		).map(turnFromRow);
	}

	consultationSnapshots(id: string): ConsultationSnapshot[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM consultation_snapshots WHERE consultation_id = ? ORDER BY captured_at, rowid",
				)
				.all(id) as unknown as ConsultationSnapshotRow[]
		).map(snapshotFromRow);
	}

	/** A settled turn that needs a later successful output read. */
	consultationNeedsSnapshot(id: string): boolean {
		return (
			this.db
				.prepare(
					"SELECT 1 FROM consultation_turns WHERE consultation_id = ? AND settled_at IS NOT NULL AND snapshot_id IS NULL LIMIT 1",
				)
				.get(id) !== undefined
		);
	}

	/** Store every Herdr resource created by the Consultation before continuing. */
	recordConsultationResource(
		id: string,
		resource: Omit<ConsultationResource, "confirmedClosed"> & { confirmedClosed?: boolean },
	): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO consultation_resources(consultation_id, kind, resource_id, owned, confirmed_closed, details) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				resource.kind,
				resource.resourceId,
				resource.owned ? 1 : 0,
				resource.confirmedClosed === true ? 1 : 0,
				resource.details,
			);
	}

	markConsultationResourceShared(
		id: string,
		kind: string,
		resourceId: string,
		details = "retained because the workspace is shared",
	): void {
		this.db
			.prepare(
				"UPDATE consultation_resources SET owned = 0, details = ? WHERE consultation_id = ? AND kind = ? AND resource_id = ?",
			)
			.run(details, id, kind, resourceId);
	}

	markConsultationResourceClosed(id: string, kind: string, resourceId: string): void {
		this.db
			.prepare(
				"UPDATE consultation_resources SET confirmed_closed = 1 WHERE consultation_id = ? AND kind = ? AND resource_id = ?",
			)
			.run(id, kind, resourceId);
	}

	recordRemainingConsultationResource(
		id: string,
		kind: string,
		resourceId: string,
		details = "",
	): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO consultation_remaining_resources(consultation_id, kind, resource_id, details) VALUES (?, ?, ?, ?)",
			)
			.run(id, kind, resourceId, details);
	}

	consultationRemainingResources(id: string): ConsultationResource[] {
		return (
			this.db
				.prepare(
					"SELECT kind, resource_id, 1 AS owned, 0 AS confirmed_closed, details FROM consultation_remaining_resources WHERE consultation_id = ?",
				)
				.all(id) as Array<{
				kind: string;
				resource_id: string;
				owned: number;
				confirmed_closed: number;
				details: string;
			}>
		).map((row) => ({
			kind: row.kind,
			resourceId: row.resource_id,
			owned: true,
			confirmedClosed: false,
			details: row.details,
		}));
	}

	/** Mark cleanup as started before issuing the first external close command. */
	beginConsultationClose(id: string): boolean {
		return this.setConsultationState(id, "closing");
	}

	/** Persist a cleanup failure while leaving the aggregate recoverable. */
	recordConsultationCloseFailure(id: string, reason: string): void {
		this.db
			.prepare(
				"UPDATE consultations SET warning = ?, close_result = ?, updated_at = ? WHERE id = ? AND state = 'closing'",
			)
			.run(`cleanup failed: ${reason}`, `cleanup failed: ${reason}`, new Date().toISOString(), id);
	}

	/** Finish cleanup, retaining a precise result for Force-close recovery. */
	finishConsultationClose(id: string, result?: string, forced = false): void {
		this.transaction(() => {
			if (forced) {
				for (const resource of this.consultationResources(id).filter(
					(item) => item.owned && !item.confirmedClosed,
				))
					this.recordRemainingConsultationResource(
						id,
						resource.kind,
						resource.resourceId,
						resource.details,
					);
			}
			this.db
				.prepare(
					"UPDATE consultations SET state = 'closed', warning = CASE WHEN warning LIKE 'cleanup failed:%' THEN NULL ELSE warning END, close_result = ?, updated_at = ? WHERE id = ? AND state = 'closing'",
				)
				.run(result ?? null, new Date().toISOString(), id);
		});
	}

	consultationResources(id: string): ConsultationResource[] {
		return (
			this.db
				.prepare(
					"SELECT kind, resource_id, owned, confirmed_closed, details FROM consultation_resources WHERE consultation_id = ?",
				)
				.all(id) as Array<{
				kind: string;
				resource_id: string;
				owned: number;
				confirmed_closed: number;
				details: string;
			}>
		).map((row) => ({
			kind: row.kind,
			resourceId: row.resource_id,
			owned: row.owned === 1,
			confirmedClosed: row.confirmed_closed === 1,
			details: row.details,
		}));
	}

	/** Recovery input is deterministic and never launched automatically. */
	replacementInput(id: string, limit = 64 * 1024): string {
		const consultation = this.consultation(id);
		if (consultation === undefined) return "";
		const parts = [`Original input:\n${consultation.initialInput}`];
		const turns = this.consultationTurns(id);
		const snapshots = this.consultationSnapshots(id);
		// The first turn is the opening input already included above.
		for (let index = turns.length - 1; index >= 1; index -= 1) {
			const turn = turns[index];
			const snapshot = snapshots.find((item) => item.turnId === turn.id);
			parts.push(
				`\nOperator response:\n${turn.input}${snapshot === undefined ? "" : `\nAgent output:\n${snapshot.text}`}`,
			);
		}
		return boundedInput(parts, limit);
	}

	/** Delete only closed local history, then reduce WAL remnants. */
	deleteConsultation(id: string): boolean {
		const row = this.db.prepare("SELECT state FROM consultations WHERE id = ?").get(id) as
			| { state: ConsultationState }
			| undefined;
		if (row?.state !== "closed") return false;
		this.transaction(() => {
			this.db.prepare("DELETE FROM consultations WHERE id = ?").run(id);
		});
		try {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {}
		return true;
	}

	/** Consultations the shared Agent monitor can reconcile. */
	consultationsByState(states: readonly ConsultationState[]): Consultation[] {
		const placeholders = states.map(() => "?").join(", ");
		return (
			this.db
				.prepare(`SELECT * FROM consultations WHERE state IN (${placeholders})`)
				.all(...states) as unknown as ConsultationRow[]
		).map((row) => this.consultationFromRow(row));
	}

	/**
	 * Follow a uniquely matched moved Agent and retarget every owned Herdr
	 * resource. Close then addresses the Agent's current pane and tab, never
	 * the pane from which it moved.
	 */
	updateConsultationAgentHandles(id: string, details: ConsultationAgentDetails): void {
		this.transaction(() => {
			const current = this.consultation(id);
			if (current === undefined) return;
			const moves: Array<[string, string | null, string | null]> = [
				["pane", current.paneId, details.paneId],
				["tab", current.tabId, details.tabId ?? null],
				["workspace", current.workspaceId, details.workspaceId ?? null],
			];
			for (const [kind, from, to] of moves) {
				if (from === null || to === null || from === to) continue;
				this.db
					.prepare(
						"UPDATE consultation_resources SET resource_id = ?, details = REPLACE(details, ?, ?) WHERE consultation_id = ? AND kind = ? AND resource_id = ? AND owned = 1 AND confirmed_closed = 0",
					)
					.run(to, from, to, id, kind, from);
			}
			if (current.paneId !== null && current.paneId !== details.paneId)
				this.db
					.prepare(
						"UPDATE consultation_resources SET details = REPLACE(details, ?, ?) WHERE consultation_id = ? AND kind = 'agent' AND owned = 1 AND confirmed_closed = 0",
					)
					.run(details.paneId, current.paneId, id);
			this.db
				.prepare(
					"UPDATE consultations SET pane_id = ?, tab_id = ?, workspace_id = ?, session_id = ?, updated_at = ? WHERE id = ?",
				)
				.run(
					details.paneId,
					details.tabId ?? null,
					details.workspaceId ?? null,
					details.sessionId ?? current.sessionId,
					new Date().toISOString(),
					id,
				);
		});
	}

	/** Mark a settled turn's snapshot when the first read was unavailable. */
	fillConsultationSnapshot(
		id: string,
		output: string,
		capturedAt = new Date().toISOString(),
	): boolean {
		const turn = this.db
			.prepare(
				"SELECT id FROM consultation_turns WHERE consultation_id = ? AND settled_at IS NOT NULL AND snapshot_id IS NULL ORDER BY settled_at DESC LIMIT 1",
			)
			.get(id) as { id: string } | undefined;
		if (turn === undefined) return false;
		const bounded = boundedSnapshot(output);
		const snapshotId = randomUUID();
		this.transaction(() => {
			this.db
				.prepare(
					"INSERT INTO consultation_snapshots(id, consultation_id, turn_id, text, captured_at, partial, truncated) VALUES (?, ?, ?, ?, ?, 0, ?)",
				)
				.run(snapshotId, id, turn.id, bounded.text, capturedAt, bounded.truncated ? 1 : 0);
			this.db
				.prepare(
					"UPDATE consultation_turns SET snapshot_id = ? WHERE id = ? AND snapshot_id IS NULL",
				)
				.run(snapshotId, turn.id);
		});
		return true;
	}

	private consultationFromRow(row: ConsultationRow): Consultation {
		return {
			id: row.id,
			typeName: row.type_name,
			agentType: row.agent_type,
			environment: row.environment as EnvironmentKind,
			model: row.model,
			thinking: row.thinking,
			template: row.template,
			initialInput: row.initial_input,
			renderedOpeningPrompt: row.rendered_opening_prompt,
			repository: {
				identity: row.repository_identity,
				displayName: row.repository_display_name,
				cloneUrl: row.repository_clone_url,
				path: row.repository_path,
			},
			state: row.state as ConsultationState,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			agentName: row.agent_name,
			paneId: row.pane_id,
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
			sessionId: row.session_id,
			latestSequence: row.latest_sequence,
			draft: row.draft,
			draftUpdatedAt: row.draft_updated_at,
			draftOld: row.draft_old === 1,
			failure: row.failure,
			warning: row.warning,
			replacementOf: row.replacement_of,
			closeResult: row.close_result,
			liveConflictOverride: row.live_conflict_override === 1,
			attentionAt: row.attention_at,
			pendingResponse: this.pendingConsultationResponse(row.id),
			resources: this.consultationResources(row.id),
		};
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

interface ConsultationRow {
	id: string;
	type_name: string;
	agent_type: string;
	environment: string;
	model: string;
	thinking: string;
	template: string;
	initial_input: string;
	rendered_opening_prompt: string;
	repository_identity: string;
	repository_display_name: string;
	repository_clone_url: string;
	repository_path: string;
	state: string;
	created_at: string;
	updated_at: string;
	agent_name: string;
	pane_id: string | null;
	tab_id: string | null;
	workspace_id: string | null;
	session_id: string | null;
	latest_sequence: number | null;
	draft: string;
	draft_updated_at: string | null;
	draft_old: number;
	failure: string | null;
	warning: string | null;
	replacement_of: string | null;
	close_result: string | null;
	live_conflict_override: number;
	attention_at: string | null;
}

interface ConsultationTurnRow {
	id: string;
	consultation_id: string;
	input: string;
	accepted_at: string;
	sequence_baseline: number | null;
	settled_at: string | null;
	settled_status: string | null;
	snapshot_id: string | null;
}

interface ConsultationSnapshotRow {
	id: string;
	consultation_id: string;
	turn_id: string | null;
	text: string;
	captured_at: string;
	partial: number;
	truncated: number;
}

function turnFromRow(row: ConsultationTurnRow): ConsultationTurn {
	return {
		id: row.id,
		consultationId: row.consultation_id,
		input: row.input,
		acceptedAt: row.accepted_at,
		sequenceBaseline: row.sequence_baseline,
		settledAt: row.settled_at,
		settledStatus: row.settled_status,
		snapshotId: row.snapshot_id,
	};
}

function snapshotFromRow(row: ConsultationSnapshotRow): ConsultationSnapshot {
	return {
		id: row.id,
		consultationId: row.consultation_id,
		turnId: row.turn_id,
		text: row.text,
		capturedAt: row.captured_at,
		partial: row.partial === 1,
		truncated: row.truncated === 1,
	};
}

function compareConsultations(left: Consultation, right: Consultation): number {
	const group = (state: ConsultationState): number => {
		switch (state) {
			case "awaiting-response":
				return 0;
			case "missing":
				return 1;
			case "failed":
				return 2;
			case "working":
				return 3;
			case "opening":
				return 4;
			case "closing":
				return 5;
			case "closed":
				return 6;
		}
	};
	const leftGroup = group(left.state);
	const rightGroup = group(right.state);
	return (
		leftGroup - rightGroup ||
		(leftGroup === 0
			? (left.attentionAt ?? left.updatedAt).localeCompare(right.attentionAt ?? right.updatedAt)
			: right.updatedAt.localeCompare(left.updatedAt)) ||
		left.id.localeCompare(right.id)
	);
}

const SNAPSHOT_LIMIT = 1024 * 1024;
const SNAPSHOT_MARKER = "\n[…captured history truncated…]\n";

function boundedSnapshot(value: string): { text: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= SNAPSHOT_LIMIT) return { text: value, truncated: false };
	const markerBytes = Buffer.byteLength(SNAPSHOT_MARKER, "utf8");
	return {
		text:
			markerBytes >= SNAPSHOT_LIMIT
				? utf8Prefix(SNAPSHOT_MARKER, SNAPSHOT_LIMIT)
				: `${SNAPSHOT_MARKER}${utf8Suffix(value, SNAPSHOT_LIMIT - markerBytes)}`,
		truncated: true,
	};
}

function boundedInput(parts: readonly string[], limit: number): string {
	const full = parts.join("\n");
	if (Buffer.byteLength(full, "utf8") <= limit) return full;
	const marker = "\n[recovery context omitted]\n";
	if (limit <= Buffer.byteLength(marker, "utf8")) return utf8Prefix(marker, limit);
	return `${utf8Prefix(full, limit - Buffer.byteLength(marker, "utf8"))}${marker}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let prefix = bytes.subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(prefix, "utf8") > maxBytes) prefix = prefix.slice(0, -1);
	return prefix;
}

function utf8Suffix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let suffix = bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
	while (Buffer.byteLength(suffix, "utf8") > maxBytes) suffix = suffix.slice(1);
	return suffix;
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

/** A stored handoff row, with the herdr handles it started. */
interface HandoffRow {
	attempt_id: string;
	choice_json: string;
	pane_id: string | null;
	tab_id: string | null;
	workspace_id: string | null;
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
