/**
 * SQLite state ownership for the control plane.
 *
 * Source adapters only return external facts. This module owns work cycles,
 * memberships, source health, handoff claims, and the one-process lease.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskRule } from "./config.ts";
import type { SourceMembership, Ticket, TicketState } from "./domain/ticket.ts";
import type { HandoffChoice } from "./handoff.ts";
import { selectTaskType } from "./task-selection.ts";
import type { FetchOutcome } from "./ticket-source.ts";

const SCHEMA_VERSION = 1;
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
			if (version < 1) {
				this.db.exec(`
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
				`);
				this.db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
			}
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
				this.restoreOrCreateTicket(ticket.identity);
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
			this.markAbsentTickets();
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

	/** A done ticket returns as new work only after no source had it. */
	private restoreOrCreateTicket(identity: string): void {
		const ticket = this.db
			.prepare("SELECT state, absent FROM tickets WHERE identity = ?")
			.get(identity) as { state: TicketState; absent: number } | undefined;
		if (ticket === undefined) {
			this.db
				.prepare(
					"INSERT INTO tickets(identity, state, work_cycle, absent) VALUES (?, 'open', 1, 0)",
				)
				.run(identity);
			return;
		}
		if (ticket.state === "done" && ticket.absent === 1)
			this.db
				.prepare(
					"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1, absent = 0 WHERE identity = ?",
				)
				.run(identity);
	}

	private markAbsentTickets(): void {
		this.db.exec(
			"UPDATE tickets SET absent = CASE WHEN EXISTS (SELECT 1 FROM memberships WHERE memberships.ticket_identity = tickets.identity AND memberships.active = 1) THEN 0 ELSE 1 END",
		);
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

	/** Current visible ticket projection, ordered for operator attention. */
	visibleTickets(rules: readonly TaskRule[], fallbackTaskType: string): Ticket[] {
		const rows = this.db.prepare("SELECT identity, state FROM tickets").all() as Array<{
			identity: string;
			state: TicketState;
		}>;
		const tickets: Ticket[] = [];
		for (const row of rows) {
			const memberships = this.membershipsFor(row.identity, row.state);
			const active = memberships.filter(
				(membership) =>
					membership.health !== "removed" && this.membershipActive(membership, row.identity),
			);
			const pending = this.hasUnresolvedAttempt(row.identity);
			const actionable =
				row.state === "open" &&
				!pending &&
				active.some((membership) => membership.health === "healthy");
			if (memberships.length === 0 && row.state !== "handed-off" && row.state !== "running")
				continue;
			const facts = [...memberships].sort(
				(a, b) =>
					b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
					a.sourceName.localeCompare(b.sourceName),
			)[0];
			if (facts === undefined) continue;
			const handoff = this.handoffFor(row.identity);
			tickets.push({
				id: row.identity,
				identity: row.identity,
				title: facts.title,
				repository: facts.repository.displayName,
				state: row.state,
				handoff,
				githubClosed: facts.sourceState === "closed" || facts.sourceState === "merged",
				description: facts.description,
				sourceKind: facts.sourceKind,
				externalKey: facts.externalKey,
				sourceState: facts.sourceState,
				url: facts.url,
				labels: facts.labels,
				externalUpdatedAt: facts.externalUpdatedAt,
				repositoryRef: facts.repository,
				memberships,
				suggestedTaskType: selectTaskType(
					memberships.filter((membership) => this.membershipActive(membership, row.identity)),
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
				(right.externalUpdatedAt ?? "").localeCompare(left.externalUpdatedAt ?? "") ||
				left.id.localeCompare(right.id),
		);
	}

	private membershipsFor(identity: string, state: TicketState): SourceMembership[] {
		const where = state === "handed-off" || state === "running" ? "" : "AND m.active = 1";
		const rows = this.db
			.prepare(`
			SELECT m.*, h.health FROM memberships m JOIN source_health h ON h.source_name = m.source_name
			WHERE m.ticket_identity = ? ${where}
		`)
			.all(identity) as unknown as MembershipRow[];
		return rows.map((row) => ({
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

	private membershipActive(membership: SourceMembership, identity: string): boolean {
		const row = this.db
			.prepare("SELECT active FROM memberships WHERE source_name = ? AND ticket_identity = ?")
			.get(membership.sourceName, identity) as { active: number } | undefined;
		return row?.active === 1;
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
				"SELECT choice_json FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC LIMIT 1",
			)
			.get(identity) as { choice_json: string } | undefined;
		if (row === undefined) return null;
		const choice = jsonChoice(row.choice_json);
		return choice === undefined
			? null
			: { agentType: choice.agentType, environment: choice.environment, taskType: choice.taskType };
	}

	/** Claim before the first external command. It rechecks all eligibility atomically. */
	claimHandoff(ticketIdentity: string, choice: HandoffChoice): ClaimOutcome {
		try {
			return this.transaction(() => {
				const ticket = this.db
					.prepare("SELECT state, work_cycle FROM tickets WHERE identity = ?")
					.get(ticketIdentity) as { state: TicketState; work_cycle: number } | undefined;
				if (ticket === undefined) return { ok: false, reason: "ticket no longer exists" };
				if (ticket.state !== "open")
					return {
						ok: false,
						reason: `only open tickets can be handed off (this one is ${ticket.state})`,
					};
				if (this.hasUnresolvedAttempt(ticketIdentity))
					return { ok: false, reason: "handoff recovery is required before another handoff" };
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

	/** Settle known outcomes. An agent-started outcome advances factory state. */
	settleHandoff(attemptId: string, agentStarted: boolean, failureReason?: string): void {
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
					.prepare("UPDATE tickets SET state = 'handed-off' WHERE identity = ? AND state = 'open'")
					.run(attempt.ticket_identity);
				this.db
					.prepare(
						"INSERT OR REPLACE INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at) VALUES (?, ?, ?, ?, ?)",
					)
					.run(
						attemptId,
						attempt.ticket_identity,
						attempt.work_cycle,
						attempt.choice_json,
						new Date().toISOString(),
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
	if (ticket.state === "running") return 0;
	if (ticket.state === "handed-off") return 1;
	if (ticket.state === "open" && ticket.actionable) return 2;
	if (ticket.state === "open") return 3;
	return 4;
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
