/**
 * SQLite state ownership for the control plane.
 *
 * Source adapters only return external facts. This module owns work cycles,
 * memberships, source health, handoff claims, completion traces, and the
 * one-process lease.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import type { TaskRule } from "./config.ts";
import {
	isStaleAgentOutputWarning,
	isTurnEndWarning,
	STALE_AGENT_OUTPUT_WARNING,
	turnEndWarning,
} from "./consultation.ts";
import {
	type Completion,
	type CompletionDecision,
	type EnvironmentKind,
	type IssueReference,
	issueReferencesOf,
	type LeftoverEnvironment,
	type SourceMembership,
	type Ticket,
	type TicketState,
} from "./domain/ticket.ts";
import type { HandoffChoice } from "./handoff.ts";
import { agentNameFor } from "./naming.ts";
import {
	compareTicketPriority,
	effectivePullRequestPriority,
	type ReferencedIssueRank,
} from "./priority.ts";
import { selectTaskType } from "./task-selection.ts";
import type { FetchOutcome } from "./ticket-source.ts";
import {
	TURN_END_CAUSES,
	type TurnEndCause,
	type TurnLogEntry,
	turnLogFromCapture,
} from "./turn-log.ts";

const SCHEMA_VERSION = 13;
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

/**
 * One item of the Work queue (ADR 0034): a manual start that waited for a
 * Parallel limit seat. The choice is the one the operator captured when the
 * start was asked, and the origin says what the pickup re-checks when a seat
 * frees.
 */
export interface WorkQueueItem {
	position: number;
	ticketIdentity: string;
	origin: HandoffOrigin;
	choice: HandoffChoice;
	previousMessage: string;
	enqueuedAt: string;
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
	/**
	 * Why the turn ended, from its session record. Omitted when the settler
	 * has no record to read, and stored as `unknown`: a settle without a cause
	 * fails open, so it neither holds nor pauses.
	 */
	cause?: TurnEndCause;
	/** The agent's or the provider's own text for the cause; empty when none. */
	detail?: string;
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
	/** The context window in digits; empty leaves the room to the agent. */
	contextWindow: string;
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
	/** Why the turn ended, the same vocabulary as the ticket trace. */
	cause: TurnEndCause;
	/** The agent's or the provider's own text for the cause; empty when none. */
	detail: string;
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
	/** The context window in digits; empty leaves the room to the agent. */
	contextWindow?: string;
	template: string;
	initialInput: string;
	renderedOpeningPrompt: string;
	repository: ConsultationRepository;
	agentName: string;
	replacementOf?: string | null;
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

/**
 * The stored turn end cause, read back. A legacy trace predates the cell and
 * reads NULL, which is `unknown`: the upgrade holds no ticket and freezes
 * nothing. An unrecognized value degrades to `unknown` the same way.
 */
function turnEndCauseOf(stored: string | null): TurnEndCause {
	if (stored === null) return "unknown";
	return (TURN_END_CAUSES as readonly string[]).includes(stored)
		? (stored as TurnEndCause)
		: "unknown";
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

/** The v7 trace records the Model and Thinking level that the turn ran on. */
const MIGRATION_V6_TO_V7 = `
	ALTER TABLE completion_traces ADD COLUMN model TEXT NOT NULL DEFAULT '';
	ALTER TABLE completion_traces ADD COLUMN thinking TEXT NOT NULL DEFAULT '';
`;

/**
 * The v8 records carry the maximum context window the turn or Consultation
 * ran with, as plain digits; empty leaves the room to the Agent.
 */
const MIGRATION_V7_TO_V8 = `
	ALTER TABLE completion_traces ADD COLUMN context_window TEXT NOT NULL DEFAULT '';
	ALTER TABLE consultations ADD COLUMN context_window TEXT NOT NULL DEFAULT '';
`;

/**
 * The v9 traces carry the turn end cause and its detail, the agent's fact of
 * why the settled turn ended (ADR 0015). Both cells are nullable: a legacy
 * trace predates them and reads NULL, which is `unknown`, so an upgrade holds
 * no ticket and freezes nothing. The Consultation turn record stores the same
 * two facts, so one reader serves both surfaces.
 */
const MIGRATION_V8_TO_V9 = `
	ALTER TABLE completion_traces ADD COLUMN cause TEXT;
	ALTER TABLE completion_traces ADD COLUMN detail TEXT;
	ALTER TABLE consultation_turns ADD COLUMN cause TEXT;
	ALTER TABLE consultation_turns ADD COLUMN detail TEXT;
`;

/**
 * The v10 step: the live checkout safety confirmation belongs to the checkout,
 * not to the opening Consultation.
 *
 * The per-Consultation one-shot override column is dropped. In its place, the
 * checkout's confirmed set of conflict identities is stored per resolved,
 * realpath-normalized checkout path: a launch asks again only when a conflict
 * identity appears that is not in that set, and a restarted control plane
 * reads the same fact back. Each checkout keeps its own set, so one checkout's
 * confirmation never silences another's.
 */
const MIGRATION_V9_TO_V10 = `
	ALTER TABLE consultations DROP COLUMN live_conflict_override;
	CREATE TABLE checkout_conflict_confirmations (
		checkout_path TEXT PRIMARY KEY,
		identities_json TEXT NOT NULL,
		confirmed_at TEXT NOT NULL
	);
`;

/**
 * The v11 step: the Priority override (ADR 0022).
 *
 * The override belongs to the ticket, not to the work cycle: a closed cycle
 * keeps it, and a restart reads it back. Null is the default (no override),
 * a label name is a rank from the config's Priority list, and `off` forces
 * the ticket unranked.
 */
const MIGRATION_V10_TO_V11 = `ALTER TABLE tickets ADD COLUMN priority_override TEXT;`;

/**
 * The v12 step: the Referenced issue facts (ADR 0023).
 *
 * The labels and fetch time the control plane reads directly for an issue no
 * ticket source lists, keyed by the issue's identity. A fact is not a
 * ticket: it takes no row in the Main view and is never handed off. A fact
 * persists until overwritten; an orphaned fact is kept and never cleaned up.
 */
const MIGRATION_V11_TO_V12 = `
	CREATE TABLE referenced_issues (
		identity TEXT PRIMARY KEY,
		labels_json TEXT NOT NULL,
		fetched_at TEXT NOT NULL
	);
`;

/**
 * The v13 step: the Work queue (ADR 0034).
 *
 * The durable, ordered list of manual starts waiting for a Parallel limit
 * seat. The position is the queue order and the ticket identity is unique in
 * the table: the queue holds at most one item per ticket, and a second
 * enqueue for a ticket with a waiting item is refused by the state.
 */
const MIGRATION_V12_TO_V13 = `
	CREATE TABLE work_queue (
		position INTEGER PRIMARY KEY,
		ticket_identity TEXT NOT NULL UNIQUE,
		origin TEXT NOT NULL,
		choice_json TEXT NOT NULL,
		previous_message TEXT NOT NULL,
		enqueued_at TEXT NOT NULL
	);
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
	private readonly db: Database;
	private leaseToken: string | undefined;
	readonly path: string;
	/** The clock for internal timestamps. Tests pin it. */
	readonly now: () => number;

	constructor(path: string, now: () => number = () => Date.now()) {
		this.path = path;
		this.now = now;
		this.db = new Database(path);
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
				.get(name) != null
		);
	}

	private migrate(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
			const row = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
				version: number;
			} | null;
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
			if (version < 7) this.db.exec(MIGRATION_V6_TO_V7);
			if (version < 8) this.db.exec(MIGRATION_V7_TO_V8);
			if (version < 9) this.db.exec(MIGRATION_V8_TO_V9);
			if (version < 10) this.db.exec(MIGRATION_V9_TO_V10);
			if (version < 11) this.db.exec(MIGRATION_V10_TO_V11);
			if (version < 12) this.db.exec(MIGRATION_V11_TO_V12);
			if (version < 13) this.db.exec(MIGRATION_V12_TO_V13);
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
				if (exists == null) {
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
			// The Referenced issue facts covered by the refresh (ADR 0023): each
			// overwrites the fact it keys, and an orphaned fact - a reference
			// the refresh no longer carries - is kept and never cleaned up.
			if (outcome.referencedIssueFacts != null) {
				for (const fact of outcome.referencedIssueFacts) {
					this.db
						.prepare(`
							INSERT INTO referenced_issues(identity, labels_json, fetched_at)
							VALUES (?, ?, ?)
							ON CONFLICT(identity) DO UPDATE SET
								labels_json = excluded.labels_json,
								fetched_at = excluded.fetched_at
						`)
						.run(fact.identity, JSON.stringify(fact.labels), fact.fetchedAt);
				}
			}
			this.db
				.prepare(
					"UPDATE source_health SET health = 'healthy', error = NULL, last_success = ? WHERE source_name = ?",
				)
				.run(outcome.fetchedAt, source.name);
		});
	}

	/**
	 * The live tickets and the labels of their newest membership (ADR 0023):
	 * the facts a pull request source covers its Issue references against.
	 * A ticket is live when a current source snapshot still lists it; a
	 * ticket that left every source keeps its row but is no longer live, so
	 * a pull request's reference to it is read directly. The newest
	 * membership rule matches the rank read, so a kept reference's fact
	 * refreshes to the labels the rank reads on its ticket.
	 */
	liveTicketLabels(): Array<{ identity: string; labels: string[] }> {
		const rows = this.db
			.prepare(
				`SELECT m.ticket_identity AS identity, m.labels_json AS labels_json
				FROM memberships m
				WHERE EXISTS (
					SELECT 1
					FROM memberships live JOIN source_health h ON h.source_name = live.source_name
					WHERE live.ticket_identity = m.ticket_identity
						AND live.active = 1 AND h.health != 'removed'
				)
				ORDER BY m.external_updated_at DESC, m.source_name ASC`,
			)
			.all() as Array<{ identity: string; labels_json: string }>;
		const newestFirst = new Map<string, string[]>();
		for (const row of rows) {
			if (newestFirst.has(row.identity)) continue;
			newestFirst.set(row.identity, jsonStringArray(row.labels_json));
		}
		return [...newestFirst].map(([identity, labels]) => ({ identity, labels }));
	}

	/**
	 * The rank the ticket's Issue references carry (ADR 0023).
	 *
	 * Each reference resolves by the issue's own chain: its Priority
	 * override, then its labels. The labels come from the issue's snapshot -
	 * a live or last known ticket - when it is one, else from its Referenced
	 * issue fact. A snapshot always beats a fact.
	 */
	issueReferenceRanks(
		memberships: readonly { attributes: Record<string, string> }[],
	): ReferencedIssueRank[] {
		const references: IssueReference[] = [];
		const seen = new Set<string>();
		for (const membership of memberships) {
			for (const reference of issueReferencesOf(membership.attributes)) {
				const key = reference.identity ?? `number:${reference.number}`;
				if (seen.has(key)) continue;
				seen.add(key);
				references.push(reference);
			}
		}
		const ranks: ReferencedIssueRank[] = [];
		for (const reference of references) {
			if (reference.identity === null) {
				ranks.push({ number: reference.number, labels: [], override: null });
				continue;
			}
			const ticket = this.db
				.prepare("SELECT priority_override FROM tickets WHERE identity = ?")
				.get(reference.identity) as { priority_override: string | null } | undefined;
			if (ticket != null) {
				const fact = this.db
					.prepare(
						"SELECT labels_json FROM memberships WHERE ticket_identity = ? ORDER BY external_updated_at DESC, source_name LIMIT 1",
					)
					.get(reference.identity) as { labels_json: string } | undefined;
				ranks.push({
					number: reference.number,
					labels: jsonStringArray(fact?.labels_json ?? "[]"),
					override: ticket.priority_override,
				});
				continue;
			}
			const stored = this.db
				.prepare("SELECT labels_json FROM referenced_issues WHERE identity = ?")
				.get(reference.identity) as { labels_json: string } | undefined;
			ranks.push({
				number: reference.number,
				labels: jsonStringArray(stored?.labels_json ?? "[]"),
				override: null,
			});
		}
		return ranks;
	}

	private ensureSource(source: SourceDefinition): void {
		const row = this.db
			.prepare("SELECT source_name FROM source_health WHERE source_name = ?")
			.get(source.name);
		if (row == null)
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
	 *
	 * Within its attention group, a ticket's rank orders it: ranked before
	 * unranked, better rank first, then the newest external update (ADR
	 * 0022). The group stays ahead, so an awaiting decision never waits
	 * behind ranked work.
	 */
	visibleTickets(
		rules: readonly TaskRule[],
		fallbackTaskType: string,
		priorityLabels: readonly string[] = [],
	): Ticket[] {
		const rows = this.db
			.prepare("SELECT identity, state, work_cycle, priority_override FROM tickets")
			.all() as Array<{
			identity: string;
			state: TicketState;
			work_cycle: number;
			priority_override: string | null;
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
			if (facts == null) continue;
			const handoff = this.handoffFor(row.identity);
			// The pull request's own facts beat the rank its Issue references
			// carry; an issue ticket, which closes nothing, reads its own chain
			// (ADR 0023).
			const priority = effectivePullRequestPriority(
				priorityLabels,
				row.priority_override,
				facts.labels,
				this.issueReferenceRanks(storedMemberships),
			);
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
				priority,
			});
		}
		return tickets.sort(
			(left, right) =>
				attentionGroup(left) - attentionGroup(right) || compareTicketPriority(left, right),
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
				.get(identity) != null
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
		if (row == null) return null;
		const choice = jsonChoice(row.choice_json);
		if (choice == null) return null;
		return {
			agentType: choice.agentType,
			environment: choice.environment,
			taskType: choice.taskType,
			model: choice.model,
			thinking: choice.thinking,
			contextWindow: choice.contextWindow,
			attemptId: row.attempt_id,
			paneId: row.pane_id,
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
		};
	}

	/**
	 * The ticket's Priority override: a rank label name, `off`, or null for
	 * the default (ADR 0022).
	 */
	priorityOverride(identity: string): string | null {
		const row = this.db
			.prepare("SELECT priority_override FROM tickets WHERE identity = ?")
			.get(identity) as { priority_override: string | null } | undefined;
		return row?.priority_override ?? null;
	}

	/**
	 * Store the ticket's Priority override, or clear it to the default with
	 * null. The value is the operator's fact on the ticket: the config's
	 * list owns the scale, and a value that names no rank ranks nothing.
	 */
	setPriorityOverride(identity: string, value: string | null): boolean {
		const result = this.db
			.prepare("UPDATE tickets SET priority_override = ? WHERE identity = ?")
			.run(value, identity);
		return result.changes > 0;
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
				"SELECT task_type, agent_type, agent_name, model, thinking, context_window, completed_at, last_message, turn_log_json, cause, detail, decision FROM completion_traces WHERE ticket_identity = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as
			| {
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
			  }
			| undefined;
		if (row == null) return null;
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
		};
	}

	/**
	 * The Dispatch pause, derived from the completion traces (ADR 0016).
	 *
	 * It is on when a held trace - a turn that settled `failed` and that no
	 * decision has landed on - has no `completed` trace after it. It is never
	 * stored, so it survives a control-plane restart and cannot drift from the
	 * record it describes. It ends at the next `completed` settle, or the
	 * moment the operator decides the held turn that started it. Only
	 * `failed` pauses: `truncated` and `aborted` are one agent's own pressure
	 * and a local event, and neither stops unrelated work. Consultations never
	 * contribute: the pause reads only the ticket completion traces.
	 */
	dispatchPauseActive(): boolean {
		const held = this.db
			.prepare(
				"SELECT completed_at, rowid FROM completion_traces WHERE cause = 'failed' AND decision IS NULL ORDER BY completed_at DESC, rowid DESC LIMIT 1",
			)
			.get() as { completed_at: string; rowid: number } | null;
		if (held == null) return false;
		const after = this.db
			.prepare(
				"SELECT 1 FROM completion_traces WHERE cause = 'completed' AND (completed_at > ? OR (completed_at = ? AND rowid > ?)) LIMIT 1",
			)
			.get(held.completed_at, held.completed_at, held.rowid) as { 1: number } | null;
		return after == null;
	}

	/**
	 * Whether the ticket's source facts postdate its last ended cycle.
	 *
	 * A close, auto-close, or abandon returns the ticket to open, and the
	 * agent of the ended cycle may have changed the source item in the
	 * meantime: it merged the pull request, or closed the issue. The sources'
	 * last successful reads are the only thing that can say, so the ticket
	 * stays unverified until every source that still actively lists it has
	 * re-read since the latest end decision. A ticket whose cycle has never
	 * ended is verified, and a failed re-read needs no help here: it leaves
	 * the membership stale, which already makes the ticket unactionable.
	 */
	sourceReverifiedSinceCycleEnd(identity: string): boolean {
		const ended = this.db
			.prepare(
				"SELECT MAX(decided_at) AS ended_at FROM completion_traces WHERE ticket_identity = ? AND decision IN ('closed', 'auto-closed', 'abandoned') AND decided_at IS NOT NULL",
			)
			.get(identity) as { ended_at: string | null } | undefined;
		if (ended?.ended_at == null || ended.ended_at === null) return true;
		const unrefreshed = this.db
			.prepare(
				`SELECT 1 FROM memberships m JOIN source_health h ON h.source_name = m.source_name
				WHERE m.ticket_identity = ? AND m.active = 1 AND (h.last_success IS NULL OR h.last_success < ?) LIMIT 1`,
			)
			.get(identity, ended.ended_at) as { 1: number } | undefined;
		return unrefreshed == null;
	}

	/**
	 * The Same-type hold (ADR 0026): the open auto-handoff does not repeat
	 * completed work. The ticket's newest closed cycle settled a `completed`
	 * turn of exactly the task type the ticket now suggests: the agent
	 * finished that kind of work, and the item still lists it because no new
	 * signal landed - a label flip, an item removal. The check takes the
	 * suggestion the caller already derived and reads the newest cycle-end
	 * row, the same row the re-verify gate reads. A cycle closed after an `aborted` or `failed` turn holds
	 * nothing: that work did not finish, and a retry is the next move. A
	 * cycle whose turn never settled holds nothing: its row carries no
	 * cause. It gates the open auto-handoff only; a manual handoff passes.
	 */
	sameTypeHoldActive(identity: string, suggestedTaskType: string): boolean {
		const ended = this.db
			.prepare(
				"SELECT task_type, cause FROM completion_traces WHERE ticket_identity = ? AND decision IN ('closed', 'auto-closed', 'abandoned') AND decided_at IS NOT NULL ORDER BY decided_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as { task_type: string; cause: string | null } | undefined;
		if (ended == null) return false;
		return ended.cause === "completed" && ended.task_type === suggestedTaskType;
	}

	/**
	 * The names of the sources that hold a membership of one ticket, active
	 * or not: the list a cycle-end refresh re-reads. A source that has already
	 * dropped the ticket is on this list, because that is the source whose
	 * re-read confirms the drop.
	 */
	membershipSourceNames(identity: string): string[] {
		const rows = this.db
			.prepare(
				"SELECT DISTINCT source_name FROM memberships WHERE ticket_identity = ? ORDER BY source_name",
			)
			.all(identity) as Array<{ source_name: string }>;
		return rows.map((row) => row.source_name);
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
		if (started?.herdr_name != null) {
			return started.herdr_name;
		}
		const row = this.db
			.prepare(
				"SELECT m.title FROM memberships m WHERE m.ticket_identity = ? ORDER BY m.active DESC, m.source_name LIMIT 1",
			)
			.get(identity) as { title: string } | undefined;
		return row == null ? "" : agentNameFor(row.title);
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
	 * Mark the leftover environments a successful Close cleanup ended.
	 *
	 * The handle says how far that cleanup reached, and only the facts inside
	 * the reach end with it: a workspace removal closes every environment that
	 * named that workspace, and a close that reached one tab or ran no command
	 * at all ends only the environments its own row named. Facts outside the
	 * reach stand, because one row's close says nothing about another row's
	 * environment. Returns how many facts were cleared.
	 */
	clearLeftoverEnvironments(
		identity: string,
		ended: { workspaceId: string } | { tabId: string } | { handoffId: string },
	): number {
		const at = new Date(this.now()).toISOString();
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
	/**
	 * The tickets with an unresolved handoff claim: a handoff is in progress,
	 * from the claim until the agent starts or the start fails.
	 */
	openAttemptTickets(): string[] {
		return (
			this.db
				.prepare("SELECT ticket_identity FROM handoff_attempts WHERE resolved_at IS NULL")
				.all() as Array<{ ticket_identity: string }>
		).map((row) => row.ticket_identity);
	}

	/**
	 * The Work queue (ADR 0034), in queue order: the manual starts waiting
	 * for a Parallel limit seat. Rows that cannot be read back are dropped
	 * from the projection, exactly as a broken choice_json is elsewhere.
	 */
	workQueue(): WorkQueueItem[] {
		const rows = this.db
			.prepare(
				"SELECT position, ticket_identity, origin, choice_json, previous_message, enqueued_at FROM work_queue ORDER BY position ASC",
			)
			.all() as Array<{
				position: number;
				ticket_identity: string;
				origin: string;
				choice_json: string;
				previous_message: string;
				enqueued_at: string;
			}>;
		const items: WorkQueueItem[] = [];
		for (const row of rows) {
			const origin =
				row.origin === "open" || row.origin === "workflow" || row.origin === "restart"
					? (row.origin as HandoffOrigin)
					: undefined;
			const choice = jsonChoice(row.choice_json);
			if (origin === undefined || choice === undefined) continue;
			items.push({
				position: row.position,
				ticketIdentity: row.ticket_identity,
				origin,
				choice,
				previousMessage: row.previous_message,
				enqueuedAt: row.enqueued_at,
			});
		}
		return items;
	}

	/** The queue's depth: the row count the queue Section's header carries. */
	workQueueDepth(): number {
		return (
			(this.db.prepare("SELECT COUNT(*) AS count FROM work_queue").get() as
				| { count: number }
				| undefined)?.count ?? 0
		);
	}

	/** The identity of the ticket the queue already waits for, or null. */
	workQueueIdentity(ticketIdentity: string): string | null {
		return (
			(this.db
				.prepare("SELECT ticket_identity FROM work_queue WHERE ticket_identity = ?")
				.get(ticketIdentity) as { ticket_identity: string } | undefined)?.ticket_identity ?? null
		);
	}

	/**
	 * Add the start to the end of the queue. The queue holds at most one item
	 * per ticket: a second add for a ticket that already waits is refused, and
	 * the first item keeps its place.
	 */
	enqueueWork(
		entry: {
			ticketIdentity: string;
			origin: HandoffOrigin;
			choice: HandoffChoice;
			previousMessage: string;
		},
	): { ok: true } | { ok: false; reason: string } {
		try {
			return this.transaction(() => {
				const existing = this.db
					.prepare("SELECT 1 FROM work_queue WHERE ticket_identity = ?")
					.get(entry.ticketIdentity);
				if (existing !== null && existing !== undefined)
					return {
						ok: false,
						reason: `ticket ${entry.ticketIdentity} already has a waiting queue item`,
					};
				this.db
					.prepare(
						"INSERT INTO work_queue(position, ticket_identity, origin, choice_json, previous_message, enqueued_at) VALUES (COALESCE((SELECT MAX(position) FROM work_queue), -1) + 1, ?, ?, ?, ?, ?)",
					)
					.run(
						entry.ticketIdentity,
						entry.origin,
						JSON.stringify(entry.choice),
						entry.previousMessage,
						new Date(this.now()).toISOString(),
					);
				return { ok: true };
			});
		} catch (error) {
			return {
				ok: false,
				reason: `cannot enqueue the handoff: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/** Cancel the ticket's waiting item. The ticket keeps its state. */
	removeWorkItem(ticketIdentity: string): boolean {
		return (
			this.db
				.prepare("DELETE FROM work_queue WHERE ticket_identity = ?")
				.run(ticketIdentity).changes > 0
		);
	}

	/**
	 * Move the ticket's item one place within the shared queue order, toward
	 * the front (`up`) or the back (`down`). An item at an edge moves nowhere.
	 */
	moveWorkItem(ticketIdentity: string, direction: "up" | "down"): boolean {
		return this.transaction(() => {
			const items = this.workQueue();
			const index = items.findIndex((item) => item.ticketIdentity === ticketIdentity);
			const target = index + (direction === "up" ? -1 : 1);
			if (index < 0 || target < 0 || target >= items.length) return false;
			const swap = this.db.prepare("UPDATE work_queue SET position = ? WHERE ticket_identity = ?");
			swap.run(items[target].position, ticketIdentity);
			swap.run(items[index].position, items[target].ticketIdentity);
			return true;
		});
	}

	/**
	 * The Consultation side of the Parallel limit (ADR 0034): a Consultation
	 * in `opening` or `working` holds one seat beside the ticket seats; the
	 * other states hold none.
	 */
	consultationSeatCount(): number {
		return (
			(this.db
				.prepare(
					"SELECT COUNT(*) AS count FROM consultations WHERE state IN ('opening', 'working')",
				)
				.get() as { count: number } | undefined)?.count ?? 0
		);
	}

	/**
	 * The tickets in the given states, with their latest handoff.
	 *
	 * When a Priority label list is given, the tickets come back in the
	 * priority order (ADR 0022): ranked before unranked, better rank first,
	 * then the newest external update. That order is what lets one freed
	 * parallel slot go to the highest-ranked waiting route.
	 */
	ticketsByState(
		states: readonly TicketState[],
		priorityLabels: readonly string[] = [],
	): HandoffTicket[] {
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
		// The rank pass is a query per ticket, and a missing list is the common
		// case: with no Priority labels the order is the stored one, so the
		// observation tick skips the pass instead of paying it per ticket.
		const ranked = priorityLabels.length > 0;
		const rankOf: Array<{
			priority: ReturnType<typeof effectivePullRequestPriority>;
			externalUpdatedAt: string;
			identity: string;
		}> = [];
		for (const row of rows) {
			const choice = jsonChoice(row.choice_json);
			if (choice == null) continue;
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
				paneId: row.pane_id,
				tabId: row.tab_id,
				workspaceId: row.workspace_id,
				handoffAttemptId: row.attempt_id,
				startedAt: row.started_at,
			});
			if (!ranked) continue;
			const memberships = this.membershipsFor(row.ticket_identity, row.state);
			const facts = [...memberships].sort(
				(a, b) =>
					b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
					a.sourceName.localeCompare(b.sourceName),
			)[0];
			rankOf.push({
				// The pull request's own facts beat the rank its Issue
				// references carry (ADR 0023).
				priority: effectivePullRequestPriority(
					priorityLabels,
					this.priorityOverride(row.ticket_identity),
					facts?.labels ?? [],
					this.issueReferenceRanks(memberships),
				),
				externalUpdatedAt: facts?.externalUpdatedAt ?? "",
				identity: row.ticket_identity,
			});
		}
		if (!ranked) return out;
		return out
			.map((ticket, index) => ({ ticket, order: rankOf[index] }))
			.sort((left, right) => compareTicketPriority(left.order, right.order))
			.map((entry) => entry.ticket);
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
			if (pending == null) return false;
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
			if (ticket == null || ticket.state !== "open") return null;
			const previous = this.db
				.prepare(
					"SELECT choice_json FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
				)
				.get(identity) as { choice_json: string } | undefined;
			if (previous == null || jsonChoice(previous.choice_json) == null) return null;
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
			// A settle without a read cause is stored as `unknown`, the fail-open
			// cause: it neither holds a turn nor pauses dispatch.
			const cause = input.cause ?? "unknown";
			const detail = input.detail ?? "";
			this.db
				.prepare(
					"UPDATE tickets SET state = 'awaiting' WHERE identity = ? AND state IN ('handed-off', 'running', 'awaiting')",
				)
				.run(input.ticketIdentity);
			const handoff = this.db
				.prepare("SELECT work_cycle, choice_json FROM handoffs WHERE attempt_id = ?")
				.get(input.handoffId) as { work_cycle: number; choice_json: string } | undefined;
			const pending = this.db
				.prepare("SELECT id FROM completion_traces WHERE handoff_id = ? AND decision IS NULL")
				.get(input.handoffId) as { id: string } | undefined;
			if (handoff == null) return;
			const choice = jsonChoice(handoff.choice_json);
			if (pending != null) {
				// A reopened turn settles again: the same trace is refreshed, its
				// cause and detail overwritten, so a recovered turn reads as the
				// turn it became.
				this.db
					.prepare(
						"UPDATE completion_traces SET last_message = ?, turn_log_json = ?, completed_at = ?, cause = ?, detail = ? WHERE id = ?",
					)
					.run(
						input.message,
						JSON.stringify(input.turnLog),
						input.completedAt,
						cause,
						detail,
						pending.id,
					);
			} else {
				this.db
					.prepare(
						"INSERT INTO completion_traces(id, handoff_id, ticket_identity, work_cycle, task_type, agent_type, agent_name, model, thinking, context_window, completed_at, last_message, turn_log_json, cause, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						randomUUID(),
						input.handoffId,
						input.ticketIdentity,
						handoff.work_cycle,
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
			if (handoff == null) return false;
			const choice = jsonChoice(handoff.choice_json);
			this.db
				.prepare(
					"INSERT INTO completion_traces(id, handoff_id, ticket_identity, work_cycle, task_type, agent_type, agent_name, model, thinking, context_window, completed_at, last_message, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					randomUUID(),
					input.handoffId,
					input.ticketIdentity,
					handoff.work_cycle,
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
				if (ticket == null) return { ok: false, reason: "ticket no longer exists" };
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
					if (eligible == null)
						return {
							ok: false,
							reason:
								"ticket is not actionable because all source memberships are stale, removed, or absent",
						};
					// The cycle the ticket just ended may have changed its source
					// item (the agent merged the pull request, or closed the
					// issue). The claim waits for the sources to re-read it, so
					// the handoff never starts on facts the agent made stale.
					if (!this.sourceReverifiedSinceCycleEnd(ticketIdentity))
						return {
							ok: false,
							reason:
								"the ticket's source has not been re-read since its last cycle ended; wait for the source refresh",
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
			if (attempt == null) return;
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
						id, type_name, agent_type, environment, model, thinking, context_window, template,
						initial_input, rendered_opening_prompt, repository_identity,
						repository_display_name, repository_clone_url, repository_path,
						state, created_at, updated_at, agent_name, draft, replacement_of,
						attention_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?, ?, ?, '', ?, NULL)`,
				)
				.run(
					id,
					input.typeName,
					input.agentType,
					input.environment,
					input.model ?? "",
					input.thinking ?? "",
					input.contextWindow ?? "",
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
				);
			this.db
				.prepare(
					"INSERT INTO consultation_turns(id, consultation_id, input, accepted_at, sequence_baseline) VALUES (?, ?, ?, ?, NULL)",
				)
				.run(randomUUID(), id, input.initialInput, createdAt);
		});
		const consultation = this.consultation(id);
		if (consultation == null) throw new StateError(`consultation ${id} was not created`);
		return consultation;
	}

	/** Return one Consultation, including its current resource ownership. */
	consultation(id: string): Consultation | undefined {
		const row = this.db.prepare("SELECT * FROM consultations WHERE id = ?").get(id) as
			| ConsultationRow
			| undefined;
		return row == null ? undefined : this.consultationFromRow(row);
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

	/**
	 * The conflict identities the operator confirmed for this checkout's live
	 * launch. The set is empty when the checkout holds no confirmation, and a
	 * corrupt cell reads empty, so a damaged fact re-asks instead of sharing.
	 */
	confirmedCheckoutConflicts(checkoutPath: string): string[] {
		const row = this.db
			.prepare(
				"SELECT identities_json FROM checkout_conflict_confirmations WHERE checkout_path = ?",
			)
			.get(checkoutPath) as { identities_json: string } | undefined;
		if (row == null) return [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.identities_json);
		} catch {
			return [];
		}
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is string => typeof value === "string");
	}

	/** Store the confirmed conflict set of one checkout, with the confirmation time. */
	recordCheckoutConflictConfirmation(checkoutPath: string, identities: readonly string[]): void {
		this.db
			.prepare(
				`INSERT INTO checkout_conflict_confirmations(checkout_path, identities_json, confirmed_at)
					VALUES (?, ?, ?)
					ON CONFLICT(checkout_path) DO UPDATE SET
						identities_json = excluded.identities_json,
						confirmed_at = excluded.confirmed_at`,
			)
			.run(
				checkoutPath,
				JSON.stringify([...new Set(identities)]),
				new Date(this.now()).toISOString(),
			);
	}

	/** Update the Herdr identity after the Agent has started. */
	setConsultationAgent(id: string, details: ConsultationAgentDetails): void {
		// The opening's Agent warning is spent now: the Agent is verified and
		// connected, so clear only the "Opening Agent ..." fact. Any other
		// warning, such as the live checkout's uncommitted-changes note, stays.
		this.db
			.prepare(
				"UPDATE consultations SET pane_id = ?, tab_id = ?, workspace_id = ?, session_id = ?, state = 'working', updated_at = ?, failure = NULL, warning = CASE WHEN warning LIKE 'Opening Agent %' THEN NULL ELSE warning END WHERE id = ? AND state = 'opening'",
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
			// Check `row` for existence before the state, so a missing
			// consultation cannot reach the next line's dereference.
			if (row == null || row.state !== "awaiting-response") return false;
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
		return row == null
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
		cause: TurnEndCause = "unknown",
		detail = "",
	): boolean {
		return this.transaction(() => {
			const consultation = this.db
				.prepare("SELECT state, warning FROM consultations WHERE id = ?")
				.get(id) as { state: ConsultationState; warning: string | null } | undefined;
			if (
				consultation == null ||
				(consultation.state !== "working" && consultation.state !== "opening")
			)
				return false;
			const turn = this.db
				.prepare(
					"SELECT * FROM consultation_turns WHERE consultation_id = ? AND settled_at IS NULL ORDER BY accepted_at DESC LIMIT 1",
				)
				.get(id) as ConsultationTurnRow | undefined;
			if (turn == null) return false;
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
					"UPDATE consultation_turns SET settled_at = ?, settled_status = ?, cause = ?, detail = ? WHERE id = ? AND settled_at IS NULL",
				)
				.run(capturedAt, settledStatus, cause, detail, turn.id);
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
			// A turn the Agent settled rests the Consultation in awaiting-response
			// whatever the cause: the Agent is alive and has answered its turn, so a
			// response, the Agent terminal, Goto, and close all stand. A turn that
			// ended failed or aborted is not a normal answer, so it names itself on
			// the record - the operator reads the cause and the agent's own words
			// instead of finding it silently waiting (ADR 0015).
			const endWarning = turnEndWarning(cause, detail);
			// A turn that settled without its output read leaves the Stale Agent
			// output warning; a turn that settled with output clears only that
			// warning. A settled turn also clears the turn-end warning a previous
			// failed or aborted turn left, so a later answer is quiet again.
			const baseWarning =
				output === null
					? STALE_AGENT_OUTPUT_WARNING
					: isStaleAgentOutputWarning(consultation.warning)
						? null
						: consultation.warning;
			const warning =
				endWarning !== null ? endWarning : isTurnEndWarning(baseWarning) ? null : baseWarning;
			this.db
				.prepare(
					"UPDATE consultations SET state = 'awaiting-response', latest_sequence = ?, attention_at = ?, updated_at = ?, draft = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN '' ELSE draft END, draft_updated_at = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN NULL ELSE draft_updated_at END, draft_old = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN 0 ELSE draft_old END, warning = ? WHERE id = ?",
				)
				.run(sequence, capturedAt, capturedAt, turn.id, turn.id, turn.id, warning, id);
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
		return row == null ? undefined : turnFromRow(row);
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
				.get(id) != null
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
		if (consultation == null) return "";
		const parts = [`Original input:\n${consultation.initialInput}`];
		const turns = this.consultationTurns(id);
		const snapshots = this.consultationSnapshots(id);
		// The first turn is the opening input already included above.
		for (let index = turns.length - 1; index >= 1; index -= 1) {
			const turn = turns[index];
			const snapshot = snapshots.find((item) => item.turnId === turn.id);
			parts.push(
				`\nOperator response:\n${turn.input}${snapshot == null ? "" : `\nAgent output:\n${snapshot.text}`}`,
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
			if (current == null) return;
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
		if (turn == null) return false;
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
			contextWindow: row.context_window,
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
				.get() as { owner_token: string; pid: number; host: string } | null;
			if (current != null && !this.isDeadLocalOwner(current, host))
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
		if (this.leaseToken == null) return;
		this.db
			.prepare("UPDATE lease SET heartbeat_at = ? WHERE name = 'control-plane' AND owner_token = ?")
			.run(Date.now(), this.leaseToken);
	}
	releaseLease(): void {
		if (this.leaseToken == null) return;
		this.db
			.prepare("DELETE FROM lease WHERE name = 'control-plane' AND owner_token = ?")
			.run(this.leaseToken);
		this.leaseToken = undefined;
	}
	close(): void {
		this.releaseLease();
		// Fold the WAL into the main file so a closed state file is complete on
		// its own: Bun's close does not checkpoint the way a final SQLite close
		// does, and the data otherwise stays in the -wal sidecar.
		try {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {}
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
	context_window: string;
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
	cause: string | null;
	detail: string | null;
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
		cause: turnEndCauseOf(row.cause),
		detail: row.detail ?? "",
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
			? {
					...(parsed as HandoffChoice),
					// A choice stored before the context window existed carries
					// none: an empty value leaves the room to the agent, the same
					// meaning it has everywhere else.
					contextWindow: typeof parsed.contextWindow === "string" ? parsed.contextWindow : "",
				}
			: undefined;
	} catch {
		return undefined;
	}
}
