/**
 * The plane action aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 *
 * The methods on `PlaneActionAggregate` are the aggregate's interface: what a
 * caller outside the module may reach. The other public methods are the narrow
 * operations this aggregate publishes to the module for another aggregate to
 * call (issue #202, ADR 0095). No caller outside the module reaches them, and
 * the boundary check refuses one that does.
 */

import { randomUUID } from "node:crypto";
import type { TransitionOutcome } from "../config.ts";
import type { CompletionDecision } from "../domain/ticket.ts";
import { identityChunks, placeholders } from "./batch.ts";
import type { StateGraph } from "./graph.ts";
import { transitionOf } from "./json.ts";
import type { StateScope, StateStore } from "./store.ts";
import { TABLES_OWNED } from "./tables.ts";

export type PlaneActionOutcome = "merged" | "blocked";
export interface PlaneActionAttempt {
	id: string;
	ticketIdentity: string;
	taskType: string;
	decision: CompletionDecision;
	outcome: PlaneActionOutcome;
	/** The reason the source gave for the block; empty when the merge landed. */
	reason: string;
	/** The transition fact the outcome's fire wrote; null until it lands. */
	transition: TransitionOutcome | null;
	at: string;
}
export interface PlaneActionAttemptRow {
	id: string;
	ticket_identity: string;
	task_type: string;
	decision: string;
	outcome: string;
	reason: string;
	transition_json: string | null;
	at: string;
}
export function planeActionAttemptOf(row: PlaneActionAttemptRow): PlaneActionAttempt {
	const decision: CompletionDecision =
		row.decision === "merged" || row.decision === "auto-merged" ? row.decision : "merged";
	return {
		id: row.id,
		ticketIdentity: row.ticket_identity,
		taskType: row.task_type,
		decision,
		outcome: row.outcome === "blocked" ? "blocked" : "merged",
		reason: row.reason,
		transition: transitionOf(row.transition_json),
		at: row.at,
	};
}

export interface PlaneActionAggregate {
	recordPlaneActionAttempt(input: {
		ticketIdentity: string;
		taskType: string;
		decision: CompletionDecision;
		outcome: "merged" | "blocked";
		reason: string;
		at: string;
	}): { id: string };
	recordPlaneActionAttemptOutcome(attemptId: string, outcome: TransitionOutcome): boolean;
	latestPlaneActionAttempt(identity: string): PlaneActionAttempt | null;
	planeActionAttemptCount(identity: string): number;
	planeActionBlockedUnrefreshed(identity: string): boolean;
}

export class PlaneActionModule implements PlaneActionAggregate {
	readonly db: StateScope;
	readonly graph: () => StateGraph;
	constructor(store: StateStore, graph: () => StateGraph) {
		this.db = store.scopeOf("planeAction", TABLES_OWNED.planeAction);
		this.graph = graph;
	}
	recordPlaneActionAttempt(input: {
		ticketIdentity: string;
		taskType: string;
		decision: CompletionDecision;
		outcome: "merged" | "blocked";
		reason: string;
		at: string;
	}): { id: string } {
		const id = randomUUID();
		this.db.transaction(() => {
			this.db
				.prepare(
					"INSERT INTO plane_action_attempts (id, ticket_identity, task_type, decision, outcome, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					input.ticketIdentity,
					input.taskType,
					input.decision,
					input.outcome,
					input.reason,
					input.at,
				);
		});
		return { id };
	}
	recordPlaneActionAttemptOutcome(attemptId: string, outcome: TransitionOutcome): boolean {
		return this.db.transaction(() => {
			const result = this.db
				.prepare(
					"UPDATE plane_action_attempts SET transition_json = ? WHERE id = ? AND transition_json IS NULL",
				)
				.run(JSON.stringify(outcome), attemptId);
			return Number(result.changes) > 0;
		});
	}
	latestPlaneActionAttempt(identity: string): PlaneActionAttempt | null {
		const rows = this.db
			.prepare(
				"SELECT id, ticket_identity, task_type, decision, outcome, reason, transition_json, at FROM plane_action_attempts WHERE ticket_identity = ? ORDER BY at DESC, rowid DESC LIMIT 1",
			)
			.all(identity) as Array<PlaneActionAttemptRow>;
		return rows.length === 0 ? null : planeActionAttemptOf(rows[0]);
	}
	planeActionAttemptCount(identity: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS count FROM plane_action_attempts WHERE ticket_identity = ?")
			.get(identity) as { count: number };
		return row.count;
	}
	/** The plane action start count of every Ticket in the list, in one grouped statement. */
	planeActionAttemptCountsFor(identities: readonly string[]): Map<string, number> {
		const counts = new Map<string, number>();
		for (const identity of identities) counts.set(identity, 0);
		for (const chunk of identityChunks(identities)) {
			const rows = this.db
				.prepare(
					`SELECT ticket_identity, COUNT(*) AS count FROM plane_action_attempts WHERE ticket_identity IN (${placeholders(chunk.length)}) GROUP BY ticket_identity`,
				)
				.all(...chunk) as Array<{ ticket_identity: string; count: number }>;
			for (const row of rows) counts.set(row.ticket_identity, Number(row.count));
		}
		return counts;
	}
	planeActionBlockedUnrefreshed(identity: string): boolean {
		const latest = this.latestPlaneActionAttemptRow(identity);
		if (latest === null || latest.outcome !== "blocked") return false;
		for (const name of this.graph().sourceFact.activeMembershipSourceNames(identity)) {
			const last = this.graph().sourceFact.sourceLastSuccess(name);
			if (last === null || last < latest.at) return true;
		}
		return false;
	}

	/** The newest attempt row: its outcome and the time it ran. */
	private latestPlaneActionAttemptRow(identity: string): { outcome: string; at: string } | null {
		const row = this.db
			.prepare(
				"SELECT outcome, at FROM plane_action_attempts WHERE ticket_identity = ? ORDER BY at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as { outcome: string; at: string } | null;
		return row;
	}
}
