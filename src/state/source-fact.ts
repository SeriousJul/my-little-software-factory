/**
 * The source fact aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 */

import type { SourceMembership, TicketState } from "../domain/ticket.ts";
import type { FetchOutcome } from "../ticket-source.ts";
import type { StateGraph } from "./graph.ts";
import { jsonStringArray, jsonStringRecord } from "./json.ts";
import type { StateStore } from "./store.ts";

export type Health = SourceMembership["health"];
export interface SourceDefinition {
	name: string;
	kind: string;
}
export interface StoredMembership extends SourceMembership {
	active: boolean;
	/** The mute of the membership's source (ADR 0070), folded from the join. */
	sourceMuted: boolean;
	/** The moment the membership's source's mute was set, null while down. */
	sourceMutedAt: string | null;
}
export interface MembershipRow {
	source_name: string;
	health: Health;
	/** The source's mute flag (ADR 0070): the join reads it beside the health. */
	muted: number;
	/** The moment the source's mute was set, null while the flag is down. */
	muted_at: string | null;
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

export interface SourceFactAggregate {
	initializeSources(sources: readonly SourceDefinition[]): void;
	applyFetch(source: SourceDefinition, outcome: FetchOutcome): void;
	sourceHealths(): Array<{ name: string; kind: string; health: Health; error?: string }>;
	membershipsFor(identity: string, state: TicketState): StoredMembership[];
	retireTicket(ticketIdentity: string): boolean;
	stillListed(ticketIdentity: string): boolean;
	convergeMembershipLabels(ticketIdentity: string, labels: readonly string[]): void;
	membershipSourceNames(identity: string): string[];
	setSourceMuted(
		sourceName: string,
		muted: boolean,
	): { ok: true; removed: number } | { ok: false; reason: string };
	activeMembershipSourceNames(identity: string): string[];
	sourceLastSuccess(name: string): string | null;
	sourceMuted(name: string): boolean;
	hasUnrefreshedActiveMembershipSince(identity: string, since: string): boolean;
	ticketsWithMutedSource(): Set<string>;
	sourceHealthy(name: string): boolean;
	newestMembershipTitle(identity: string): string | null;
}

export class SourceFactModule implements SourceFactAggregate {
	readonly store: StateStore;
	readonly graph: StateGraph;
	constructor(store: StateStore, graph: StateGraph) {
		this.store = store;
		this.graph = graph;
	}
	initializeSources(sources: readonly SourceDefinition[]): void {
		this.store.transaction(() => {
			const names = new Set(sources.map((source) => source.name));
			for (const row of this.store.db
				.prepare("SELECT source_name FROM source_health")
				.all() as Array<{
				source_name: string;
			}>) {
				if (!names.has(row.source_name)) {
					// The removal wins over the mute (ADR 0070): the stronger act is a
					// statement to the config, and it clears the operator's judgment on
					// the source's row in the same pass, so a re-added source comes
					// back clean.
					this.store.db
						.prepare(
							"UPDATE source_health SET health = 'removed', error = 'source removed from config', muted = 0, muted_at = NULL WHERE source_name = ?",
						)
						.run(row.source_name);
					this.store.db
						.prepare("UPDATE memberships SET active = 0 WHERE source_name = ?")
						.run(row.source_name);
				}
			}
			for (const source of sources) {
				const exists = this.store.db
					.prepare("SELECT source_name FROM source_health WHERE source_name = ?")
					.get(source.name);
				if (exists == null) {
					this.store.db
						.prepare(
							"INSERT INTO source_health(source_name, kind, health, error, last_success) VALUES (?, ?, 'loading', NULL, NULL)",
						)
						.run(source.name, source.kind);
				} else {
					this.store.db
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
	applyFetch(source: SourceDefinition, outcome: FetchOutcome): void {
		this.store.transaction(() => {
			this.ensureSource(source);
			if (outcome.status === "failed") {
				this.store.db
					.prepare("UPDATE source_health SET health = 'stale', error = ? WHERE source_name = ?")
					.run(outcome.reason, source.name);
				return;
			}
			const returned = new Set(outcome.tickets.map((ticket) => ticket.identity));
			for (const ticket of outcome.tickets) {
				this.graph.ticketWorkCycle.openTicket(ticket.identity);
				this.store.db
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
			for (const row of this.store.db
				.prepare("SELECT ticket_identity FROM memberships WHERE source_name = ? AND active = 1")
				.all(source.name) as Array<{ ticket_identity: string }>) {
				if (!returned.has(row.ticket_identity))
					this.store.db
						.prepare(
							"UPDATE memberships SET active = 0 WHERE source_name = ? AND ticket_identity = ?",
						)
						.run(source.name, row.ticket_identity);
			}
			this.store.db
				.prepare(
					"UPDATE source_health SET health = 'healthy', error = NULL, last_success = ? WHERE source_name = ?",
				)
				.run(outcome.fetchedAt, source.name);
		});
	}
	private ensureSource(source: SourceDefinition): void {
		const row = this.store.db
			.prepare("SELECT source_name FROM source_health WHERE source_name = ?")
			.get(source.name);
		if (row == null)
			this.store.db
				.prepare("INSERT INTO source_health(source_name, kind, health) VALUES (?, ?, 'loading')")
				.run(source.name, source.kind);
	}
	sourceHealths(): Array<{ name: string; kind: string; health: Health; error?: string }> {
		return (
			this.store.db
				.prepare("SELECT source_name, kind, health, error FROM source_health ORDER BY source_name")
				.all() as Array<{ source_name: string; kind: string; health: Health; error: string | null }>
		).map((row) => ({
			name: row.source_name,
			kind: row.kind,
			health: row.health,
			...(row.error === null ? {} : { error: row.error }),
		}));
	}
	membershipsFor(identity: string, state: TicketState): StoredMembership[] {
		const where =
			state === "handed-off" || state === "running" || state === "awaiting"
				? ""
				: "AND m.active = 1";
		const rows = this.store.db
			.prepare(`
			SELECT m.*, h.health, h.muted, h.muted_at FROM memberships m JOIN source_health h ON h.source_name = m.source_name
			WHERE m.ticket_identity = ? ${where}
		`)
			.all(identity) as unknown as MembershipRow[];
		return rows.map((row) => ({
			active: row.active === 1,
			sourceName: row.source_name,
			health: row.health,
			sourceMuted: row.muted === 1,
			sourceMutedAt: row.muted_at,
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
	retireTicket(ticketIdentity: string): boolean {
		return this.store.transaction(() => {
			const result = this.store.db
				.prepare("UPDATE memberships SET active = 0 WHERE ticket_identity = ? AND active = 1")
				.run(ticketIdentity);
			return Number(result.changes) > 0;
		});
	}
	stillListed(ticketIdentity: string): boolean {
		const row = this.store.db
			.prepare("SELECT COUNT(*) AS count FROM memberships WHERE ticket_identity = ? AND active = 1")
			.get(ticketIdentity) as { count: number };
		return Number(row.count) > 0;
	}
	convergeMembershipLabels(ticketIdentity: string, labels: readonly string[]): void {
		this.store.transaction(() => {
			this.store.db
				.prepare(
					`UPDATE memberships SET labels_json = ? WHERE ticket_identity = ? AND source_name = (
						SELECT source_name FROM memberships
						WHERE ticket_identity = ? AND active = 1
						ORDER BY external_updated_at DESC, source_name ASC LIMIT 1)`,
				)
				.run(JSON.stringify(labels), ticketIdentity, ticketIdentity);
		});
	}
	membershipSourceNames(identity: string): string[] {
		const rows = this.store.db
			.prepare(
				"SELECT DISTINCT source_name FROM memberships WHERE ticket_identity = ? ORDER BY source_name",
			)
			.all(identity) as Array<{ source_name: string }>;
		return rows.map((row) => row.source_name);
	}
	setSourceMuted(
		sourceName: string,
		muted: boolean,
	): { ok: true; removed: number } | { ok: false; reason: string } {
		return this.store.transaction(() => {
			const row = this.store.db
				.prepare("SELECT 1 AS known FROM source_health WHERE source_name = ?")
				.get(sourceName) as { known: number } | null;
			if (row === null) {
				return { ok: false as const, reason: `the source ${sourceName} is not in the state file` };
			}
			const at = new Date(this.store.now()).toISOString();
			this.store.db
				.prepare("UPDATE source_health SET muted = ?, muted_at = ? WHERE source_name = ?")
				.run(muted ? 1 : 0, muted ? at : null, sourceName);
			if (!muted) return { ok: true as const, removed: 0 };

			// The settle the act causes: the source's tickets, their waiting
			// starts out of the queue. The routes the removed items carried keep
			// the decision the ask recorded, their wait standing on the item alone
			// (ADR 0072), and the machine's re-offer holds on the gate.
			const ticketIdentities = new Set(
				(
					this.store.db
						.prepare("SELECT DISTINCT ticket_identity FROM memberships WHERE source_name = ?")
						.all(sourceName) as Array<{ ticket_identity: string }>
				).map((row) => row.ticket_identity),
			);
			const removed = this.graph.workQueue.removeHandoffItemsForTickets([...ticketIdentities]);
			return { ok: true as const, removed };
		});
	}
	/** The waiting handoff starts of the tickets the caller names, out of the queue. */
	hasUnrefreshedActiveMembershipSince(identity: string, since: string): boolean {
		const unrefreshed = this.store.db
			.prepare(
				`SELECT 1 FROM memberships m JOIN source_health h ON h.source_name = m.source_name
				WHERE m.ticket_identity = ? AND m.active = 1 AND (h.last_success IS NULL OR h.last_success < ?) LIMIT 1`,
			)
			.get(identity, since) as { 1: number } | undefined;
		return unrefreshed !== null;
	}
	/** The tickets an active membership under a muted source still lists. */
	ticketsWithMutedSource(): Set<string> {
		const rows = this.store.db
			.prepare(
				"SELECT DISTINCT m.ticket_identity AS identity FROM memberships m JOIN source_health h ON h.source_name = m.source_name WHERE h.muted = 1",
			)
			.all() as Array<{ identity: string }>;
		return new Set(rows.map((row) => row.identity));
	}
	/** The sources that still actively list the ticket. */
	activeMembershipSourceNames(identity: string): string[] {
		const rows = this.store.db
			.prepare(
				"SELECT source_name FROM memberships WHERE ticket_identity = ? AND active = 1 ORDER BY source_name",
			)
			.all(identity) as Array<{ source_name: string }>;
		return rows.map((row) => row.source_name);
	}

	/** The time one source last read its list, or null when it never has. */
	sourceLastSuccess(name: string): string | null {
		const row = this.store.db
			.prepare("SELECT last_success FROM source_health WHERE source_name = ?")
			.get(name) as { last_success: string | null } | undefined;
		return row?.last_success ?? null;
	}

	/** Whether one source is muted. */
	sourceMuted(name: string): boolean {
		const row = this.store.db
			.prepare("SELECT muted FROM source_health WHERE source_name = ?")
			.get(name) as { muted: number } | undefined;
		return row?.muted === 1;
	}

	/** Whether one source last read its list cleanly. */
	sourceHealthy(name: string): boolean {
		const row = this.store.db
			.prepare("SELECT health FROM source_health WHERE source_name = ?")
			.get(name) as { health: string } | undefined;
		return row?.health === "healthy";
	}

	/** The title of the source that lists the ticket, newest active first. */
	newestMembershipTitle(identity: string): string | null {
		const row = this.store.db
			.prepare(
				"SELECT title FROM memberships WHERE ticket_identity = ? ORDER BY active DESC, source_name LIMIT 1",
			)
			.get(identity) as { title: string } | undefined;
		return row?.title ?? null;
	}
}
