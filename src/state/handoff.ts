/**
 * The handoff aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 */

import { randomUUID } from "node:crypto";
import type {
	EnvironmentKind,
	LeftoverEnvironment,
	Ticket,
	TicketState,
} from "../domain/ticket.ts";
import type { HandoffChoice } from "../handoff.ts";
import { identifyHandoffAgentName } from "../naming.ts";
import type { StateGraph } from "./graph.ts";
import { jsonChoice } from "./json.ts";
import type { StateStore } from "./store.ts";
import { StateError } from "./store.ts";

export interface HandoffClaim {
	attemptId: string;
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
export interface HandoffRow {
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
	hasUnresolvedAttempt(identity: string): boolean;
	handoffInFlight(ticketIdentity: string): boolean;
	handoffFor(identity: string): Ticket["handoff"];
	handoffCount(identity: string): number;
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
	handoffGates(
		ticket: { state: TicketState; work_cycle: number } | undefined,
		ticketIdentity: string,
		origin: HandoffOrigin,
	): { ok: true; workCycle: number } | { ok: false; reason: string };
	handoffClaimCheck(
		ticketIdentity: string,
		origin: HandoffOrigin,
	): { ok: true } | { ok: false; reason: string };
	claimHandoff(ticketIdentity: string, choice: HandoffChoice, origin: HandoffOrigin): ClaimOutcome;
	advanceHandoffAttempt(attemptId: string, stage: string): void;
	settleHandoff(
		attemptId: string,
		agentStarted: boolean,
		failureReason?: string,
		details?: HandoffDetails,
	): void;
	recoverUnsettledHandoffs(): number;
	newestHandoffRow(identity: string): StoredHandoff | null;
	handoffRecord(handoffId: string): StoredHandoff | null;
	recordLeftoverEnvironment(input: {
		ticketIdentity: string;
		handoffId?: string | null;
		paneId?: string | null;
		reason: string;
		at?: string;
	}): LeftoverEnvironment | null;
	leftoverEnvironment(identity: string): LeftoverEnvironment | null;
	leftoverEnvironments(identity: string): LeftoverEnvironment[];
	clearLeftoverEnvironments(
		identity: string,
		ended: { workspaceId: string } | { tabId: string } | { handoffId: string },
	): number;
}

export class HandoffModule implements HandoffAggregate {
	readonly store: StateStore;
	readonly graph: StateGraph;
	constructor(store: StateStore, graph: StateGraph) {
		this.store = store;
		this.graph = graph;
	}
	hasUnresolvedAttempt(identity: string): boolean {
		return (
			this.store.db
				.prepare(
					"SELECT attempt_id FROM handoff_attempts WHERE ticket_identity = ? AND resolved_at IS NULL LIMIT 1",
				)
				.get(identity) != null
		);
	}
	handoffInFlight(ticketIdentity: string): boolean {
		return this.hasUnresolvedAttempt(ticketIdentity);
	}
	handoffFor(identity: string): Ticket["handoff"] {
		const row = this.newestHandoffRow(identity);
		if (row == null || row.choice == null) return null;
		return {
			agentType: row.choice.agentType,
			environment: row.choice.environment,
			taskType: row.choice.taskType,
			model: row.choice.model,
			thinking: row.choice.thinking,
			contextWindow: row.choice.contextWindow,
			attemptId: row.attemptId,
			paneId: row.paneId,
			tabId: row.tabId,
			workspaceId: row.workspaceId,
			herdrName: row.herdrName,
		};
	}
	handoffCount(identity: string): number {
		const row = this.store.db
			.prepare("SELECT COUNT(*) AS count FROM handoffs WHERE ticket_identity = ?")
			.get(identity) as { count: number };
		return Number(row.count) + this.graph.planeAction.planeActionAttemptCount(identity);
	}
	autoHandoffMode(): boolean {
		const row = this.store.db.prepare("SELECT enabled FROM auto_handoff_mode WHERE id = 1").get() as
			| { enabled: number }
			| undefined;
		return row?.enabled === 1;
	}
	setAutoHandoffMode(enabled: boolean): void {
		try {
			this.store.db
				.prepare(
					"INSERT INTO auto_handoff_mode(id, enabled) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled",
				)
				.run(enabled ? 1 : 0);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StateError(`cannot store the Auto-handoff mode at ${this.store.path}: ${message}`);
		}
	}
	latestHandoff(identity: string): {
		handoffId: string;
		environment: EnvironmentKind;
		paneId: string | null;
		tabId: string | null;
		workspaceId: string | null;
	} | null {
		const row = this.store.db
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
		const rows = this.store.db
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
			this.store.db
				.prepare("SELECT ticket_identity FROM handoff_attempts WHERE resolved_at IS NULL")
				.all() as Array<{ ticket_identity: string }>
		).map((row) => row.ticket_identity);
	}
	reclaimHandoff(
		identity: string,
		details: { paneId: string; tabId: string; workspaceId: string; agentName: string },
	): { attemptId: string } | null {
		return this.store.transaction(() => {
			const ticket = this.graph.ticketWorkCycle.ticketRow(identity);
			if (ticket == null || ticket.state !== "open") return null;
			// The pane id of a closed pane is handed out again, so the live
			// agent in the ticket's stale pane can run under another name. Only
			// the ticket's own agent is reclaimed; anything else is refused.
			if (
				identifyHandoffAgentName(
					details.agentName,
					this.graph.ticketWorkCycle.agentNameForTicket(identity),
				) !== "own"
			)
				return null;
			const previous = this.newestHandoffRow(identity);
			if (previous == null || previous.choice == null) return null;
			if (this.hasUnresolvedAttempt(identity)) return null;
			if (!this.graph.ticketWorkCycle.moveTicketState(identity, ["open"], "running")) return null;
			const attemptId = randomUUID();
			const now = new Date(this.store.now()).toISOString();
			this.store.db
				.prepare(
					"INSERT INTO handoff_attempts(attempt_id, ticket_identity, work_cycle, choice_json, stage, created_at, resolved_at) VALUES (?, ?, ?, ?, 'reclaimed', ?, ?)",
				)
				.run(attemptId, identity, ticket.work_cycle, JSON.stringify(previous.choice), now, now);
			this.store.db
				.prepare(
					"INSERT INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at, pane_id, tab_id, workspace_id, herdr_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					attemptId,
					identity,
					ticket.work_cycle,
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
	handoffGates(
		ticket: { state: TicketState; work_cycle: number } | undefined,
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
			const eligible = this.graph.sourceFact
				.activeMembershipSourceNames(ticketIdentity)
				.some((name) => this.graph.sourceFact.sourceHealthy(name));
			if (!eligible)
				return {
					ok: false,
					reason: "Ticket is not actionable because source data is stale, removed, or absent",
				};
			// The cycle the ticket just ended may have changed its source item
			// (the agent merged the pull request, or closed the issue). The start
			// waits for the sources to re-read it, so a handoff never starts on
			// facts the agent made stale.
			if (!this.graph.ticketWorkCycle.sourceReverifiedSinceCycleEnd(ticketIdentity))
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
		if (origin === "restart" && ticket.state !== "handed-off" && ticket.state !== "running")
			return {
				ok: false,
				reason: `only in-flight tickets can be restarted (this one is ${ticket.state})`,
			};
		if (this.hasUnresolvedAttempt(ticketIdentity))
			return { ok: false, reason: "handoff recovery is required before another handoff" };
		return { ok: true, workCycle: ticket.work_cycle };
	}
	handoffClaimCheck(
		ticketIdentity: string,
		origin: HandoffOrigin,
	): { ok: true } | { ok: false; reason: string } {
		const gates = this.handoffGates(
			this.graph.ticketWorkCycle.ticketRow(ticketIdentity),
			ticketIdentity,
			origin,
		);
		return gates.ok ? { ok: true } : gates;
	}
	claimHandoff(ticketIdentity: string, choice: HandoffChoice, origin: HandoffOrigin): ClaimOutcome {
		try {
			return this.store.transaction(() => {
				const gates = this.handoffGates(
					this.graph.ticketWorkCycle.ticketRow(ticketIdentity),
					ticketIdentity,
					origin,
				);
				if (!gates.ok) return gates;
				const attemptId = randomUUID();
				this.store.db
					.prepare(
						"INSERT INTO handoff_attempts(attempt_id, ticket_identity, work_cycle, choice_json, stage, created_at) VALUES (?, ?, ?, ?, 'claimed', ?)",
					)
					.run(
						attemptId,
						ticketIdentity,
						gates.workCycle,
						JSON.stringify(choice),
						new Date(this.store.now()).toISOString(),
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
		this.store.db
			.prepare("UPDATE handoff_attempts SET stage = ? WHERE attempt_id = ? AND resolved_at IS NULL")
			.run(stage, attemptId);
	}
	settleHandoff(
		attemptId: string,
		agentStarted: boolean,
		failureReason?: string,
		details?: HandoffDetails,
	): void {
		this.store.transaction(() => {
			const attempt = this.store.db
				.prepare(
					"SELECT ticket_identity, work_cycle, choice_json FROM handoff_attempts WHERE attempt_id = ? AND resolved_at IS NULL",
				)
				.get(attemptId) as
				| { ticket_identity: string; work_cycle: number; choice_json: string }
				| undefined;
			if (attempt == null) return;
			if (agentStarted) {
				this.graph.ticketWorkCycle.moveTicketState(
					attempt.ticket_identity,
					["open", "awaiting"],
					"handed-off",
				);
				// The route's source ended its cycle at the ask (ADR 0072), so the
				// start moves the started ticket alone: the source rests open
				// behind the wait, and the wait is the item's, not a ticket state.
				this.store.db
					.prepare(
						"INSERT OR REPLACE INTO handoffs(attempt_id, ticket_identity, work_cycle, choice_json, started_at, pane_id, tab_id, workspace_id, herdr_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						attemptId,
						attempt.ticket_identity,
						attempt.work_cycle,
						attempt.choice_json,
						new Date(this.store.now()).toISOString(),
						details?.paneId ?? null,
						details?.tabId ?? null,
						details?.workspaceId ?? null,
						details?.agentName ?? null,
					);
			}
			this.store.db
				.prepare(
					"UPDATE handoff_attempts SET stage = ?, resolved_at = ?, failure_reason = ? WHERE attempt_id = ?",
				)
				.run(
					agentStarted ? "agent-started" : "failed",
					new Date(this.store.now()).toISOString(),
					failureReason ?? null,
					attemptId,
				);
		});
	}
	recoverUnsettledHandoffs(): number {
		return this.store.transaction(() => {
			const now = new Date(this.store.now()).toISOString();
			const settled = this.store.db
				.prepare(
					"UPDATE handoff_attempts SET stage = 'failed', resolved_at = ?, failure_reason = ? WHERE resolved_at IS NULL",
				)
				.run(now, "the run that claimed this handoff ended before it settled it");
			return Number(settled.changes);
		});
	}
	/** The stored Handoff row the ticket's newest Handoff stands on. */
	newestHandoffRow(identity: string): StoredHandoff | null {
		const row = this.store.db
			.prepare(
				"SELECT attempt_id, work_cycle, started_at, choice_json, pane_id, tab_id, workspace_id, herdr_name FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
			)
			.get(identity) as
			| {
					attempt_id: string;
					work_cycle: number;
					started_at: string;
					choice_json: string;
					pane_id: string | null;
					tab_id: string | null;
					workspace_id: string | null;
					herdr_name: string | null;
			  }
			| undefined;
		if (row == null) return null;
		return {
			attemptId: row.attempt_id,
			workCycle: row.work_cycle,
			startedAt: row.started_at,
			choice: jsonChoice(row.choice_json),
			paneId: row.pane_id,
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
			herdrName: row.herdr_name,
		};
	}

	/** The stored Handoff row one attempt stands on. */
	handoffRecord(handoffId: string): StoredHandoff | null {
		const row = this.store.db
			.prepare(
				"SELECT attempt_id, work_cycle, choice_json, pane_id, tab_id, workspace_id, herdr_name FROM handoffs WHERE attempt_id = ?",
			)
			.get(handoffId) as
			| {
					attempt_id: string;
					work_cycle: number;
					choice_json: string;
					pane_id: string | null;
					tab_id: string | null;
					workspace_id: string | null;
					herdr_name: string | null;
			  }
			| undefined;
		if (row == null) return null;
		return {
			attemptId: row.attempt_id,
			workCycle: row.work_cycle,
			startedAt: "",
			choice: jsonChoice(row.choice_json),
			paneId: row.pane_id,
			tabId: row.tab_id,
			workspaceId: row.workspace_id,
			herdrName: row.herdr_name,
		};
	}
	recordLeftoverEnvironment(input: {
		ticketIdentity: string;
		handoffId?: string | null;
		paneId?: string | null;
		reason: string;
		at?: string;
	}): LeftoverEnvironment | null {
		return this.store.transaction(() => {
			const row =
				input.handoffId != null
					? (this.store.db
							.prepare(
								"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? AND attempt_id = ?",
							)
							.get(input.ticketIdentity, input.handoffId) as HandoffRow | undefined)
					: input.paneId != null
						? (this.store.db
								.prepare(
									"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? AND pane_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
								)
								.get(input.ticketIdentity, input.paneId) as HandoffRow | undefined)
						: (this.store.db
								.prepare(
									"SELECT attempt_id, choice_json, pane_id, tab_id, workspace_id FROM handoffs WHERE ticket_identity = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
								)
								.get(input.ticketIdentity) as HandoffRow | undefined);
			if (row == null) return null;
			const at = input.at ?? new Date(this.store.now()).toISOString();
			const choice = jsonChoice(row.choice_json);
			// A fact that already stood on this handoff is refreshed: the clear
			// that ended it belongs to an attempt that did not end the
			// environment after all, so the new reason stands again.
			this.store.db
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
	leftoverEnvironments(identity: string): LeftoverEnvironment[] {
		const rows = this.store.db
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
	clearLeftoverEnvironments(
		identity: string,
		ended: { workspaceId: string } | { tabId: string } | { handoffId: string },
	): number {
		const at = new Date(this.store.now()).toISOString();
		const cleared =
			"workspaceId" in ended
				? this.store.db
						.prepare(
							"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND workspace_id = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
						)
						.run(at, identity, ended.workspaceId)
				: "tabId" in ended
					? this.store.db
							.prepare(
								"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND tab_id = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
							)
							.run(at, identity, ended.tabId)
					: this.store.db
							.prepare(
								"UPDATE handoffs SET leftover_cleared_at = ? WHERE ticket_identity = ? AND attempt_id = ? AND leftover_reason IS NOT NULL AND leftover_cleared_at IS NULL",
							)
							.run(at, identity, ended.handoffId);
		return Number(cleared.changes);
	}
}
