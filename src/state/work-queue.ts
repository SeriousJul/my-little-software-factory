/**
 * The work queue aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 */

import type { HandoffChoice } from "../handoff.ts";
import type { StateGraph } from "./graph.ts";
import type { HandoffOrigin } from "./handoff.ts";
import { jsonChoice } from "./json.ts";
import type { StateStore } from "./store.ts";
import { StateError } from "./store.ts";

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
		ticketIdentity: string /** The ticket the route's handoff continues; null for a start that is no route. */;
		routeFromIdentity?: string | null;
		origin: HandoffOrigin;
		choice: HandoffChoice;
		previousMessage: string /** True for the automatic add the top-up makes (ADR 0051). */;
		automatic?: boolean;
	}): { ok: true } | { ok: false; reason: string };
	enqueuePlaneActionWork(entry: {
		ticketIdentity: string /** The ticket the route's action continues; null for a start that is no route. */;
		routeFromIdentity?: string | null;
		origin: HandoffOrigin /** The task type whose action form the pickup runs. */;
		taskType: string /** True for the automatic add the top-up makes. */;
		automatic?: boolean;
	}): { ok: true } | { ok: false; reason: string };
	enqueueConsultationWork(consultationId: string): { ok: true } | { ok: false; reason: string };
	removeWorkItem(ticketIdentity: string): boolean;
	cancelWorkItem(ticketIdentity: string): boolean;
	removeWorkflowRouteItem(ticketIdentity: string): number;
	dropConsultationWorkItem(consultationId: string): boolean;
	repackWorkQueuePositions(): void;
	moveWorkItem(identity: string, direction: "up" | "down"): boolean;
	insertWorkQueueConsultationItem(consultationId: string, createdAt: string): void;
	removeItemsForTickets(identities: readonly string[]): number;
	removeHandoffItemsForTickets(identities: readonly string[]): number;
	hasConsultationItem(consultationId: string): boolean;
}

export class WorkQueueModule implements WorkQueueAggregate {
	readonly store: StateStore;
	readonly graph: StateGraph;
	constructor(store: StateStore, graph: StateGraph) {
		this.store = store;
		this.graph = graph;
	}
	queuePaused(): boolean {
		const row = this.store.db.prepare("SELECT paused FROM queue_pause WHERE id = 1").get() as
			| { paused: number }
			| undefined;
		return row?.paused === 1;
	}
	setQueuePaused(paused: boolean): void {
		try {
			this.store.db
				.prepare(
					"INSERT INTO queue_pause(id, paused) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused",
				)
				.run(paused ? 1 : 0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StateError(`cannot store the queue pause at ${this.store.path}: ${message}`);
		}
	}
	items(): WorkQueueItem[] {
		const rows = this.store.db
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
			this.store.db
				.prepare("SELECT 1 FROM work_queue WHERE ticket_identity = ?")
				.get(ticketIdentity) != null
		);
	}
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
			return this.store.transaction(() => {
				const existing = this.store.db
					.prepare("SELECT 1 FROM work_queue WHERE ticket_identity = ?")
					.get(entry.ticketIdentity);
				if (existing !== null && existing !== undefined)
					return {
						ok: false,
						reason: `ticket ${entry.ticketIdentity} already has a waiting queue item`,
					};
				this.store.db
					.prepare(
						"INSERT INTO work_queue(position, ticket_identity, route_from_identity, origin, choice_json, previous_message, enqueued_at, is_automatic) VALUES (COALESCE((SELECT MAX(position) FROM work_queue), -1) + 1, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						entry.ticketIdentity,
						normalizeRouteFromIdentity(entry.ticketIdentity, entry.routeFromIdentity),
						entry.origin,
						JSON.stringify(entry.choice),
						entry.previousMessage,
						new Date(this.store.now()).toISOString(),
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
			return this.store.transaction(() => {
				const existing = this.store.db
					.prepare("SELECT 1 FROM work_queue WHERE ticket_identity = ?")
					.get(entry.ticketIdentity);
				if (existing !== null && existing !== undefined)
					return {
						ok: false,
						reason: `ticket ${entry.ticketIdentity} already has a waiting queue item`,
					};
				this.store.db
					.prepare(
						"INSERT INTO work_queue(position, ticket_identity, route_from_identity, origin, choice_json, previous_message, enqueued_at, is_automatic, action_task_type) VALUES (COALESCE((SELECT MAX(position) FROM work_queue), -1) + 1, ?, ?, ?, NULL, '', ?, ?, ?)",
					)
					.run(
						entry.ticketIdentity,
						normalizeRouteFromIdentity(entry.ticketIdentity, entry.routeFromIdentity),
						entry.origin,
						new Date(this.store.now()).toISOString(),
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
	enqueueConsultationWork(consultationId: string): { ok: true } | { ok: false; reason: string } {
		try {
			return this.store.transaction(() => {
				const existing = this.store.db
					.prepare("SELECT 1 FROM work_queue WHERE consultation_id = ?")
					.get(consultationId);
				if (existing !== null && existing !== undefined)
					return {
						ok: false,
						reason: `consultation ${consultationId} already has a waiting queue item`,
					};
				this.store.db
					.prepare(
						"INSERT INTO work_queue(position, ticket_identity, consultation_id, origin, choice_json, previous_message, enqueued_at) VALUES (COALESCE((SELECT MAX(position) FROM work_queue), -1) + 1, NULL, ?, NULL, NULL, '', ?)",
					)
					.run(consultationId, new Date(this.store.now()).toISOString());
				return { ok: true };
			});
		} catch (error) {
			return {
				ok: false,
				reason: `cannot enqueue the Consultation: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	removeWorkItem(ticketIdentity: string): boolean {
		return this.store.transaction(() => {
			const result = this.store.db
				.prepare("DELETE FROM work_queue WHERE ticket_identity = ?")
				.run(ticketIdentity);
			if (result.changes === 0) return false;
			this.repackWorkQueuePositions();
			return true;
		});
	}
	cancelWorkItem(ticketIdentity: string): boolean {
		return this.store.transaction(() => {
			const row = this.store.db
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
			this.store.db.prepare("DELETE FROM work_queue WHERE ticket_identity = ?").run(ticketIdentity);
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
				this.graph.ticketWorkCycle.recordRouteRemovedMark(source, decision);
			}
			return true;
		});
	}
	removeWorkflowRouteItem(ticketIdentity: string): number {
		return this.store.transaction(() => {
			const result = this.store.db
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
		const result = this.store.db
			.prepare("DELETE FROM work_queue WHERE consultation_id = ?")
			.run(consultationId);
		this.repackWorkQueuePositions();
		return Number(result.changes) > 0;
	}
	repackWorkQueuePositions(): void {
		const remaining = this.store.db
			.prepare("SELECT position FROM work_queue ORDER BY position ASC")
			.all() as Array<{ position: number }>;
		const set = this.store.db.prepare("UPDATE work_queue SET position = ? WHERE position = ?");
		remaining.forEach((row, index) => {
			if (row.position !== index) set.run(index, row.position);
		});
	}
	moveWorkItem(identity: string, direction: "up" | "down"): boolean {
		return this.store.transaction(() => {
			const items = this.items();
			const index = items.findIndex((item) => workQueueIdentityOf(item) === identity);
			const target = index + (direction === "up" ? -1 : 1);
			if (index < 0 || target < 0 || target >= items.length) return false;
			// The swap goes through a spare position: the column is the
			// queue's primary key, and the two rows may not share either
			// place for a step of the swap.
			const swap = this.store.db.prepare(
				`UPDATE work_queue SET position = ? WHERE ${identityColumn(items[index])} = ?`,
			);
			const swapTarget = this.store.db.prepare(
				`UPDATE work_queue SET position = ? WHERE ${identityColumn(items[target])} = ?`,
			);
			swap.run(-1, identity);
			swapTarget.run(items[index].position, workQueueIdentityOf(items[target]));
			swap.run(items[target].position, identity);
			return true;
		});
	}
	insertWorkQueueConsultationItem(consultationId: string, createdAt: string): void {
		this.store.db
			.prepare(
				"INSERT INTO work_queue(position, ticket_identity, consultation_id, origin, choice_json, previous_message, enqueued_at) VALUES (COALESCE((SELECT MAX(position) FROM work_queue), -1) + 1, NULL, ?, NULL, NULL, '', ?)",
			)
			.run(consultationId, createdAt);
	}
	/** Take the waiting starts of the tickets the caller names out of the queue. */
	removeItemsForTickets(identities: readonly string[]): number {
		const deleteItem = this.store.db.prepare("DELETE FROM work_queue WHERE ticket_identity = ?");
		let removed = 0;
		for (const identity of identities) removed += Number(deleteItem.run(identity).changes);
		if (removed > 0) this.repackWorkQueuePositions();
		return removed;
	}

	/** The waiting handoff starts of the tickets the caller names, out of the queue. */
	removeHandoffItemsForTickets(identities: readonly string[]): number {
		const deleteItem = this.store.db.prepare(
			"DELETE FROM work_queue WHERE ticket_identity = ? AND action_task_type IS NULL",
		);
		let removed = 0;
		for (const identity of identities) removed += Number(deleteItem.run(identity).changes);
		if (removed > 0) this.repackWorkQueuePositions();
		return removed;
	}

	/** Whether the consultation already has a waiting Work queue item. */
	hasConsultationItem(consultationId: string): boolean {
		const row = this.store.db
			.prepare("SELECT 1 FROM work_queue WHERE consultation_id = ? LIMIT 1")
			.get(consultationId);
		return row !== null;
	}
}
