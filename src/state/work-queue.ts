/**
 * The work queue aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 *
 * The methods on `WorkQueueAggregate` are the aggregate's interface: what a
 * caller outside the module may reach. The other public methods are the narrow
 * operations this aggregate publishes to the module for another aggregate to
 * call (issue #202, ADR 0095). No caller outside the module reaches them, and
 * the boundary check refuses one that does.
 */

import type { HandoffChoice } from "../handoff.ts";
import type { StateGraph } from "./graph.ts";
import type { HandoffOrigin } from "./handoff.ts";
import { jsonChoice } from "./json.ts";
import type { StateScope, StateStore } from "./store.ts";
import { StateError } from "./store.ts";
import { TABLES_OWNED } from "./tables.ts";

export interface WorkQueueHandoffItem {
	kind: "handoff";
	position: number;
	ticketIdentity: string;
	/**
	 * True for the automatic adds the top-up makes (ADR 0051): the route the
	 * settled turn offers, the restart, the new open ticket. The pickup of an
	 * automatic item skips the placement a manual start crosses and lands the
	 * route's decision the automatic way, the way the direct starts did.
	 */
	automatic: boolean;
	/**
	 * The ticket the route's handoff continues (ADR 0027): its settled turn
	 * awaits the decision this item is the handoff of. Null for a start that is
	 * no route - an open start, a restart - and for the rows a pre-v18 file
	 * waits with.
	 */
	routeFromIdentity: string | null;
	origin: HandoffOrigin;
	choice: HandoffChoice;
	previousMessage: string;
	enqueuedAt: string;
}
export interface WorkQueueConsultationItem {
	kind: "consultation";
	position: number;
	consultationId: string;
	enqueuedAt: string;
}
export interface WorkQueuePlaneActionItem {
	kind: "plane-action";
	position: number;
	ticketIdentity: string;
	routeFromIdentity: string | null;
	/** True for the automatic adds the top-up makes. */
	automatic: boolean;
	origin: HandoffOrigin;
	/** The task type whose action form the pickup runs. */
	taskType: string;
	enqueuedAt: string;
}
export type WorkQueueItem =
	| WorkQueueHandoffItem
	| WorkQueueConsultationItem
	| WorkQueuePlaneActionItem;
export function workQueueIdentityOf(item: WorkQueueItem): string {
	return item.kind === "consultation" ? item.consultationId : item.ticketIdentity;
}
export function identityColumn(item: WorkQueueItem): string {
	return item.kind === "consultation" ? "consultation_id" : "ticket_identity";
}
export function normalizeRouteFromIdentity(
	ticketIdentity: string,
	routeFromIdentity: string | null | undefined,
): string | null {
	if (routeFromIdentity === undefined || routeFromIdentity === null || routeFromIdentity === "")
		return null;
	return routeFromIdentity === ticketIdentity ? null : routeFromIdentity;
}

export interface WorkQueueAggregate {
	queuePaused(): boolean;
	setQueuePaused(paused: boolean): void;
	items(): WorkQueueItem[];
	hasWorkItem(ticketIdentity: string): boolean;
	enqueueWork(entry: {
		ticketIdentity: string;
		/** The ticket the route's handoff continues; null for a start that is no route. */
		routeFromIdentity?: string | null;
		origin: HandoffOrigin;
		choice: HandoffChoice;
		previousMessage: string;
		/** True for the automatic add the top-up makes (ADR 0051). */
		automatic?: boolean;
	}): { ok: true } | { ok: false; reason: string };
	enqueuePlaneActionWork(entry: {
		ticketIdentity: string;
		/** The ticket the route's action continues; null for a start that is no route. */
		routeFromIdentity?: string | null;
		origin: HandoffOrigin;
		/** The task type whose action form the pickup runs. */
		taskType: string;
		/** True for the automatic add the top-up makes. */
		automatic?: boolean;
	}): { ok: true } | { ok: false; reason: string };
	removeWorkItem(ticketIdentity: string): boolean;
	cancelWorkItem(ticketIdentity: string): boolean;
	removeWorkflowRouteItem(ticketIdentity: string): number;
	moveWorkItem(identity: string, direction: "up" | "down"): boolean;
}

export class WorkQueueModule implements WorkQueueAggregate {
	private readonly db: StateScope;
	readonly graph: () => StateGraph;
	constructor(store: StateStore, graph: () => StateGraph) {
		this.db = store.scopeOf("workQueue", TABLES_OWNED.workQueue);
		this.graph = graph;
	}
	queuePaused(): boolean {
		const row = this.db.prepare("SELECT paused FROM queue_pause WHERE id = 1").get() as
			| { paused: number }
			| undefined;
		return row?.paused === 1;
	}
	setQueuePaused(paused: boolean): void {
		try {
			this.db
				.prepare(
					"INSERT INTO queue_pause(id, paused) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused",
				)
				.run(paused ? 1 : 0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StateError(`cannot store the queue pause at ${this.db.path}: ${message}`);
		}
	}
	items(): WorkQueueItem[] {
		const rows = this.db
			.prepare(
				"SELECT position, ticket_identity, consultation_id, origin, choice_json, previous_message, enqueued_at, route_from_identity, is_automatic, action_task_type FROM work_queue ORDER BY position ASC",
			)
			.all() as Array<{
			position: number;
			ticket_identity: string | null;
			consultation_id: string | null;
			origin: string | null;
			choice_json: string | null;
			previous_message: string;
			enqueued_at: string;
			route_from_identity: string | null;
			is_automatic: number;
			action_task_type: string | null;
		}>;
		const items: WorkQueueItem[] = [];
		for (const row of rows) {
			if (row.ticket_identity !== null) {
				const origin =
					row.origin === "open" || row.origin === "workflow" || row.origin === "restart"
						? (row.origin as HandoffOrigin)
						: undefined;
				// The action cell stands for the plane action's row (ADR 0068):
				// the task type whose action form the pickup runs, and no choice
				// to lose, so a row the reader cannot read as one is a row the
				// schema never committed.
				if (row.action_task_type !== null) {
					if (origin === undefined) continue;
					items.push({
						kind: "plane-action",
						position: row.position,
						ticketIdentity: row.ticket_identity,
						routeFromIdentity: row.route_from_identity,
						automatic: row.is_automatic === 1,
						origin,
						taskType: row.action_task_type,
						enqueuedAt: row.enqueued_at,
					});
					continue;
				}
				const choice = row.choice_json === null ? undefined : jsonChoice(row.choice_json);
				if (origin === undefined || choice === undefined) continue;
				items.push({
					kind: "handoff",
					position: row.position,
					ticketIdentity: row.ticket_identity,
					routeFromIdentity: row.route_from_identity,
					automatic: row.is_automatic === 1,
					origin,
					choice,
					previousMessage: row.previous_message,
					enqueuedAt: row.enqueued_at,
				});
				continue;
			}
			if (row.consultation_id !== null) {
				items.push({
					kind: "consultation",
					position: row.position,
					consultationId: row.consultation_id,
					enqueuedAt: row.enqueued_at,
				});
				continue;
			}
			// The CHECK holds every row to one identity, so this arm stands for a
			// row the constraint cannot name: refuse to read it rather than guess
			// what it asks for.
			throw new StateError("the Work queue holds a row with no identity");
		}
		return items;
	}
	hasWorkItem(ticketIdentity: string): boolean {
		return (
			this.db.prepare("SELECT 1 FROM work_queue WHERE ticket_identity = ?").get(ticketIdentity) !=
			null
		);
	}
	/**
	 * The position a new row takes in the queue's order (ADR 0049, ADR 0094,
	 * ADR 0100).
	 *
	 * Every row but one enters at the end of the queue, the way it always did.
	 * The exception is the automatic continuation - the route item the top-up asks
	 * for a settled turn. It enters at the place of the first row that is no
	 * continuation, because the seat a settling turn freed belongs to that turn's
	 * own next step: the row outranks a fresh-work row (ADR 0094) and a row the
	 * operator staged (ADR 0100) alike. A continuation already standing keeps its
	 * place at the head, and no row the queue already holds moves relative to any
	 * other.
	 *
	 * Rows from that place up move one place later, highest first, so no two rows
	 * ever share a position.
	 *
	 * The automatic restart is the second row that does not enter at the tail
	 * (ADR 0108): the seat a Missing Agent left is reserved for that ticket's own
	 * restart row, so the row enters behind every owed continuation and ahead of
	 * the standing rows the reserved seat must not be spent on.
	 */
	private workQueuePosition(automatic: boolean, origin: HandoffOrigin): number {
		const rows = this.db
			.prepare("SELECT position, origin, is_automatic FROM work_queue ORDER BY position")
			.all() as { position: number; origin: string | null; is_automatic: number }[];
		const last = rows.length === 0 ? -1 : (rows[rows.length - 1] as { position: number }).position;
		let position = last + 1;
		if (automatic && origin === "workflow") {
			const firstStandingWork = rows.find((row) => row.origin !== "workflow");
			if (firstStandingWork !== undefined) position = firstStandingWork.position;
		}
		if (automatic && origin === "restart") {
			// The owed continuation keeps its rank over the restart (ADR 0100), so
			// the restart takes the place of the first row that is no continuation.
			const first = rows.find((row) => !(row.origin === "workflow" && row.is_automatic === 1));
			if (first !== undefined) position = first.position;
		}
		for (const row of rows.reverse()) {
			if (row.position < position) break;
			this.db
				.prepare("UPDATE work_queue SET position = ? WHERE position = ?")
				.run(row.position + 1, row.position);
		}
		return position;
	}
	/**
	 * Add the start to the queue (ADR 0049, ADR 0094): the row takes its place in
	 * the queue's order, the one `workQueuePosition` works out. The queue holds at
	 * most one item per ticket: a second add for a ticket that already waits is
	 * refused, and the first item keeps its place. `automatic` marks the top-up's
	 * adds (ADR 0051): the pickup skips their placement and lands their route's
	 * decision the automatic way.
	 */
	enqueueWork(entry: {
		ticketIdentity: string;
		/** The ticket the route's handoff continues; null for a start that is no route. */
		routeFromIdentity?: string | null;
		origin: HandoffOrigin;
		choice: HandoffChoice;
		previousMessage: string;
		/** True for the automatic add the top-up makes (ADR 0051). */
		automatic?: boolean;
	}): { ok: true } | { ok: false; reason: string } {
		try {
			return this.db.transaction(() => {
				const existing = this.db
					.prepare("SELECT 1 FROM work_queue WHERE ticket_identity = ?")
					.get(entry.ticketIdentity);
				if (existing !== null && existing !== undefined)
					return {
						ok: false,
						reason: `ticket ${entry.ticketIdentity} already has a waiting queue item`,
					};
				const position = this.workQueuePosition(entry.automatic === true, entry.origin);
				this.db
					.prepare(
						"INSERT INTO work_queue(position, ticket_identity, route_from_identity, origin, choice_json, previous_message, enqueued_at, is_automatic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						position,
						entry.ticketIdentity,
						normalizeRouteFromIdentity(entry.ticketIdentity, entry.routeFromIdentity),
						entry.origin,
						JSON.stringify(entry.choice),
						entry.previousMessage,
						new Date(this.db.now()).toISOString(),
						entry.automatic === true ? 1 : 0,
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
	enqueuePlaneActionWork(entry: {
		ticketIdentity: string;
		/** The ticket the route's action continues; null for a start that is no route. */
		routeFromIdentity?: string | null;
		origin: HandoffOrigin;
		/** The task type whose action form the pickup runs. */
		taskType: string;
		/** True for the automatic add the top-up makes. */
		automatic?: boolean;
	}): { ok: true } | { ok: false; reason: string } {
		try {
			return this.db.transaction(() => {
				const existing = this.db
					.prepare("SELECT 1 FROM work_queue WHERE ticket_identity = ?")
					.get(entry.ticketIdentity);
				if (existing !== null && existing !== undefined)
					return {
						ok: false,
						reason: `ticket ${entry.ticketIdentity} already has a waiting queue item`,
					};
				const position = this.workQueuePosition(entry.automatic === true, entry.origin);
				this.db
					.prepare(
						"INSERT INTO work_queue(position, ticket_identity, route_from_identity, origin, choice_json, previous_message, enqueued_at, is_automatic, action_task_type) VALUES (?, ?, ?, ?, NULL, '', ?, ?, ?)",
					)
					.run(
						position,
						entry.ticketIdentity,
						normalizeRouteFromIdentity(entry.ticketIdentity, entry.routeFromIdentity),
						entry.origin,
						new Date(this.db.now()).toISOString(),
						entry.automatic === true ? 1 : 0,
						entry.taskType,
					);
				return { ok: true };
			});
		} catch (error) {
			return {
				ok: false,
				reason: `cannot enqueue the plane action: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	removeWorkItem(ticketIdentity: string): boolean {
		return this.db.transaction(() => {
			const result = this.db
				.prepare("DELETE FROM work_queue WHERE ticket_identity = ?")
				.run(ticketIdentity);
			if (result.changes === 0) return false;
			this.repackWorkQueuePositions();
			return true;
		});
	}
	cancelWorkItem(ticketIdentity: string): boolean {
		return this.db.transaction(() => {
			const row = this.db
				.prepare(
					"SELECT origin, route_from_identity, is_automatic, action_task_type FROM work_queue WHERE ticket_identity = ?",
				)
				.get(ticketIdentity) as {
				origin: string | null;
				route_from_identity: string | null;
				is_automatic: number;
				action_task_type: string | null;
			} | null;
			if (row === null) return false;
			this.db.prepare("DELETE FROM work_queue WHERE ticket_identity = ?").run(ticketIdentity);
			this.repackWorkQueuePositions();
			if (row.origin === "workflow") {
				// The source the route routed from: the item's route from, or the
				// item's own ticket for a route onto the ticket's own position.
				const source = row.route_from_identity ?? ticketIdentity;
				// The decision word the item's ask landed on its trace (ADR 0064):
				// the mark answers the same decision, so a turn that settled
				// behind the wait takes no mark from the removal.
				const decision =
					row.action_task_type !== null
						? row.is_automatic === 1
							? "auto-merged"
							: "merged"
						: row.is_automatic === 1
							? "auto-handed-off"
							: "handed-off";
				this.graph().ticketWorkCycle.recordRouteRemovedMark(source, decision);
			}
			return true;
		});
	}
	removeWorkflowRouteItem(ticketIdentity: string): number {
		return this.db.transaction(() => {
			const result = this.db
				.prepare(
					`DELETE FROM work_queue
					WHERE origin = 'workflow'
						AND (ticket_identity = ? OR route_from_identity = ?)`,
				)
				.run(ticketIdentity, ticketIdentity);
			if (result.changes > 0) this.repackWorkQueuePositions();
			return result.changes;
		});
	}
	dropConsultationWorkItem(consultationId: string): boolean {
		const result = this.db
			.prepare("DELETE FROM work_queue WHERE consultation_id = ?")
			.run(consultationId);
		this.repackWorkQueuePositions();
		return Number(result.changes) > 0;
	}
	private repackWorkQueuePositions(): void {
		const remaining = this.db
			.prepare("SELECT position FROM work_queue ORDER BY position ASC")
			.all() as Array<{ position: number }>;
		const set = this.db.prepare("UPDATE work_queue SET position = ? WHERE position = ?");
		remaining.forEach((row, index) => {
			if (row.position !== index) set.run(index, row.position);
		});
	}
	moveWorkItem(identity: string, direction: "up" | "down"): boolean {
		return this.db.transaction(() => {
			const items = this.items();
			const index = items.findIndex((item) => workQueueIdentityOf(item) === identity);
			const target = index + (direction === "up" ? -1 : 1);
			if (index < 0 || target < 0 || target >= items.length) return false;
			// The swap goes through a spare position: the column is the
			// queue's primary key, and the two rows may not share either
			// place for a step of the swap.
			const swap = this.db.prepare(
				`UPDATE work_queue SET position = ? WHERE ${identityColumn(items[index])} = ?`,
			);
			const swapTarget = this.db.prepare(
				`UPDATE work_queue SET position = ? WHERE ${identityColumn(items[target])} = ?`,
			);
			swap.run(-1, identity);
			swapTarget.run(items[index].position, workQueueIdentityOf(items[target]));
			swap.run(items[target].position, identity);
			return true;
		});
	}
	/**
	 * The Consultation enqueue path the queue owns (issue #202 review). The
	 * Consultation record calls both halves inside its own write, so neither
	 * opens a transaction of its own, and the check is what lets the record
	 * refuse its schedule with its own sentence.
	 */
	insertWorkQueueConsultationItem(consultationId: string, createdAt: string): void {
		this.db
			.prepare(
				"INSERT INTO work_queue(position, ticket_identity, consultation_id, origin, choice_json, previous_message, enqueued_at) VALUES (COALESCE((SELECT MAX(position) FROM work_queue), -1) + 1, NULL, ?, NULL, NULL, '', ?)",
			)
			.run(consultationId, createdAt);
	}
	/** Whether the Consultation already has a waiting Work queue item. */
	hasConsultationItem(consultationId: string): boolean {
		const row = this.db
			.prepare("SELECT 1 FROM work_queue WHERE consultation_id = ? LIMIT 1")
			.get(consultationId);
		return row !== null;
	}
	/** The waiting handoff starts of the tickets the caller names, out of the queue. */
	removeHandoffItemsForTickets(identities: readonly string[]): number {
		const deleteItem = this.db.prepare(
			"DELETE FROM work_queue WHERE ticket_identity = ? AND action_task_type IS NULL",
		);
		let removed = 0;
		for (const identity of identities) removed += Number(deleteItem.run(identity).changes);
		if (removed > 0) this.repackWorkQueuePositions();
		return removed;
	}
}
