/**
 * The consultation record aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 *
 * The methods on `ConsultationRecordAggregate` are the aggregate's interface: what a
 * caller outside the module may reach. The other public methods are the narrow
 * operations this aggregate publishes to the module for another aggregate to
 * call (issue #202, ADR 0095). No caller outside the module reaches them, and
 * the boundary check refuses one that does.
 */

import { randomUUID } from "node:crypto";
import {
	boundedReplacementInput,
	CONSULTATION_INPUT_LIMIT,
} from "../consultation/response-draft.ts";
import {
	isStaleAgentOutputWarning,
	isTurnEndWarning,
	STALE_AGENT_OUTPUT_WARNING,
	turnEndWarning,
} from "../consultation/warning-facts.ts";
import type { EnvironmentKind } from "../domain/ticket.ts";
import { utf8ByteLength, utf8Prefix, utf8Suffix } from "../text-bounds.ts";
import type { TurnEndCause } from "../turn-log.ts";
import type { StateGraph } from "./graph.ts";
import { turnEndCauseOf } from "./json.ts";
import type { StateScope, StateStore } from "./store.ts";
import { StateError } from "./store.ts";
import { TABLES_OWNED } from "./tables.ts";

export const CONSULTATION_STATES = [
	"queued",
	"unscheduled",
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
	/**
	 * The state the record holds from its first write (ADR 0034, issue #90).
	 * `opening` is the default for a start that runs at once; `queued` is the
	 * submit the full Parallel limit kept from starting, and it takes the
	 * record's Work queue item in the same write.
	 */
	initialState?: "opening" | "queued";
}
export interface ConsultationAgentDetails {
	paneId: string;
	tabId?: string | null;
	workspaceId?: string | null;
	sessionId?: string | null;
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
export function compareConsultations(left: Consultation, right: Consultation): number {
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
			// A `queued` record needs no operator: it waits for a seat, and it
			// sorts after the live records that hold their seats and before the
			// records that are closing (ADR 0034, issue #90).
			case "queued":
				return 5;
			// An `unscheduled` record needs the operator's decision - schedule,
			// start, or delete (issue #91) - so it stands beside the queue's
			// waiters and ahead of the closing records.
			case "unscheduled":
				return 6;
			case "closing":
				return 7;
			case "closed":
				return 8;
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
export const SNAPSHOT_LIMIT = 1024 * 1024;
export const SNAPSHOT_MARKER = "\n[…captured history truncated…]\n";
export function boundedSnapshot(value: string): { text: string; truncated: boolean } {
	if (utf8ByteLength(value) <= SNAPSHOT_LIMIT) return { text: value, truncated: false };
	const markerBytes = utf8ByteLength(SNAPSHOT_MARKER);
	return {
		text:
			markerBytes >= SNAPSHOT_LIMIT
				? utf8Prefix(SNAPSHOT_MARKER, SNAPSHOT_LIMIT)
				: `${SNAPSHOT_MARKER}${utf8Suffix(value, SNAPSHOT_LIMIT - markerBytes)}`,
		truncated: true,
	};
}

export interface ConsultationRecordAggregate {
	scheduleConsultation(consultationId: string): { ok: true } | { ok: false; reason: string };
	removeConsultationWorkItem(consultationId: string): boolean;
	createConsultation(input: CreateConsultationInput): Consultation;
	consultation(id: string): Consultation | undefined;
	consultations(filter?: "open" | "closed" | "all"): Consultation[];
	setConsultationRepositoryPath(id: string, path: string): void;
	confirmedCheckoutConflicts(checkoutPath: string): string[];
	recordCheckoutConflictConfirmation(checkoutPath: string, identities: readonly string[]): void;
	setConsultationAgent(id: string, details: ConsultationAgentDetails): void;
	canRecoverConsultationOpening(id: string): boolean;
	beginConsultationStart(id: string): boolean;
	updateConsultationTypeSettings(
		id: string,
		settings: {
			agentType: string;
			environment: EnvironmentKind;
			model: string;
			thinking: string;
			contextWindow: string;
			template: string;
			renderedOpeningPrompt: string;
		},
	): boolean;
	failConsultationOpening(id: string, reason: string, agentStarted?: boolean): void;
	setConsultationWarning(id: string, warning: string | null): void;
	recordConsultationAgentHandles(id: string, details: ConsultationAgentDetails): void;
	recordExternalConsultationTurn(id: string, sequence: number, acceptedAt?: string): boolean;
	setConsultationState(id: string, next: ConsultationState, detail?: string | null): boolean;
	setConsultationDraft(id: string, draft: string, old?: boolean): void;
	beginConsultationResponse(
		id: string,
		input: string,
		sequenceBaseline?: number | null,
	): ConsultationPendingResponse | undefined;
	acceptConsultationResponse(id: string, pendingId: string): ConsultationTurn | undefined;
	cancelConsultationResponse(id: string, pendingId: string): boolean;
	settleConsultationTurn(
		id: string,
		sequence: number | null,
		output: string | null,
		fields?: {
			settledStatus?: string;
			capturedAt?: string;
			cause?: TurnEndCause;
			detail?: string;
		},
	): boolean;
	captureConsultationPartial(id: string, output: string | null, capturedAt?: string): void;
	consultationTurns(id: string): ConsultationTurn[];
	consultationSnapshots(id: string): ConsultationSnapshot[];
	consultationNeedsSnapshot(id: string): boolean;
	recordConsultationResource(
		id: string,
		resource: Omit<ConsultationResource, "confirmedClosed"> & { confirmedClosed?: boolean },
	): void;
	markConsultationResourceShared(
		id: string,
		kind: string,
		resourceId: string,
		details?: string,
	): void;
	markConsultationResourceClosed(id: string, kind: string, resourceId: string): void;
	consultationRemainingResources(id: string): ConsultationResource[];
	beginConsultationClose(id: string): boolean;
	recordConsultationCloseFailure(id: string, reason: string): void;
	finishConsultationClose(id: string, result?: string, forced?: boolean): void;
	consultationResources(id: string): ConsultationResource[];
	replacementInput(id: string, limit?: number): string;
	deleteConsultation(id: string): boolean;
	consultationsByState(states: readonly ConsultationState[]): Consultation[];
	updateConsultationAgentHandles(id: string, details: ConsultationAgentDetails): void;
	fillConsultationSnapshot(id: string, output: string, capturedAt?: string): boolean;
}

export class ConsultationRecordModule implements ConsultationRecordAggregate {
	private readonly db: StateScope;
	readonly graph: () => StateGraph;
	constructor(store: StateStore, graph: () => StateGraph) {
		this.db = store.scopeOf("consultationRecord", TABLES_OWNED.consultationRecord);
		this.graph = graph;
	}
	scheduleConsultation(consultationId: string): { ok: true } | { ok: false; reason: string } {
		return this.db.transaction(() => {
			if (this.graph().workQueue.hasConsultationItem(consultationId))
				return {
					ok: false,
					reason: `consultation ${consultationId} already has a waiting queue item`,
				};
			const result = this.db
				.prepare(
					"UPDATE consultations SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'unscheduled'",
				)
				.run(new Date(this.db.now()).toISOString(), consultationId);
			if (Number(result.changes) === 0)
				return { ok: false, reason: "the Consultation is not unscheduled" };
			this.graph().workQueue.insertWorkQueueConsultationItem(
				consultationId,
				new Date(this.db.now()).toISOString(),
			);
			return { ok: true };
		});
	}
	removeConsultationWorkItem(consultationId: string): boolean {
		return this.db.transaction(() => {
			if (!this.graph().workQueue.dropConsultationWorkItem(consultationId)) return false;
			this.db
				.prepare(
					"UPDATE consultations SET state = 'unscheduled', updated_at = ? WHERE id = ? AND state = 'queued'",
				)
				.run(new Date(this.db.now()).toISOString(), consultationId);
			return true;
		});
	}
	createConsultation(input: CreateConsultationInput): Consultation {
		const id = input.id ?? randomUUID();
		const createdAt = input.createdAt ?? new Date().toISOString();
		// The state the record holds from its first write (ADR 0034, issue
		// #90). A record that cannot take a Parallel limit seat is born `queued`
		// with its Work queue item in the same write, so the record and the
		// pointer to it commit together and never exist apart from each other.
		const initialState = input.initialState ?? "opening";
		this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO consultations(
						id, type_name, agent_type, environment, model, thinking, context_window, template,
						initial_input, rendered_opening_prompt, repository_identity,
						repository_display_name, repository_clone_url, repository_path,
						state, created_at, updated_at, agent_name, draft, replacement_of,
						attention_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, NULL)`,
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
					initialState,
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
			if (initialState === "queued")
				this.graph().workQueue.insertWorkQueueConsultationItem(id, createdAt);
		});
		const consultation = this.consultation(id);
		if (consultation == null) throw new StateError(`consultation ${id} was not created`);
		return consultation;
	}
	consultation(id: string): Consultation | undefined {
		const row = this.db.prepare("SELECT * FROM consultations WHERE id = ?").get(id) as
			| ConsultationRow
			| undefined;
		return row == null ? undefined : this.consultationFromRow(row);
	}
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
	setConsultationRepositoryPath(id: string, path: string): void {
		this.db
			.prepare("UPDATE consultations SET repository_path = ?, updated_at = ? WHERE id = ?")
			.run(path, new Date().toISOString(), id);
	}
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
				new Date(this.db.now()).toISOString(),
			);
	}
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
	canRecoverConsultationOpening(id: string): boolean {
		const row = this.db.prepare("SELECT state FROM consultations WHERE id = ?").get(id) as
			| { state: ConsultationState }
			| undefined;
		return row?.state === "opening";
	}
	beginConsultationStart(id: string): boolean {
		return this.db.transaction(() => {
			const result = this.db
				.prepare(
					"UPDATE consultations SET state = 'opening', updated_at = ? WHERE id = ? AND state IN ('queued', 'unscheduled')",
				)
				.run(new Date(this.db.now()).toISOString(), id);
			if (Number(result.changes) === 0) return false;
			this.graph().workQueue.dropConsultationWorkItem(id);
			return true;
		});
	}
	updateConsultationTypeSettings(
		id: string,
		settings: {
			agentType: string;
			environment: EnvironmentKind;
			model: string;
			thinking: string;
			contextWindow: string;
			template: string;
			renderedOpeningPrompt: string;
		},
	): boolean {
		const result = this.db
			.prepare(
				`UPDATE consultations SET agent_type = ?, environment = ?, model = ?, thinking = ?,
					context_window = ?, template = ?, rendered_opening_prompt = ?, updated_at = ? WHERE id = ? AND state IN ('queued', 'unscheduled')`,
			)
			.run(
				settings.agentType,
				settings.environment,
				settings.model,
				settings.thinking,
				settings.contextWindow,
				settings.template,
				settings.renderedOpeningPrompt,
				new Date(this.db.now()).toISOString(),
				id,
			);
		return Number(result.changes) > 0;
	}
	failConsultationOpening(id: string, reason: string, agentStarted = false): void {
		this.db
			.prepare(
				agentStarted
					? "UPDATE consultations SET state = 'working', failure = ?, updated_at = ? WHERE id = ? AND state = 'opening'"
					: "UPDATE consultations SET state = 'failed', failure = ?, updated_at = ? WHERE id = ? AND state = 'opening'",
			)
			.run(reason, new Date().toISOString(), id);
	}
	setConsultationWarning(id: string, warning: string | null): void {
		this.db.prepare("UPDATE consultations SET warning = ? WHERE id = ?").run(warning, id);
	}
	recordConsultationAgentHandles(id: string, details: ConsultationAgentDetails): void {
		this.db
			.prepare(
				"UPDATE consultations SET pane_id = ?, tab_id = ?, workspace_id = ?, session_id = ? WHERE id = ? AND state = 'opening'",
			)
			.run(
				details.paneId,
				details.tabId ?? null,
				details.workspaceId ?? null,
				details.sessionId ?? null,
				id,
			);
	}
	recordExternalConsultationTurn(
		id: string,
		sequence: number,
		acceptedAt = new Date().toISOString(),
	): boolean {
		return this.db.transaction(() => {
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
	setConsultationDraft(id: string, draft: string, old = false): void {
		this.db
			.prepare(
				"UPDATE consultations SET draft = ?, draft_updated_at = ?, draft_old = ? WHERE id = ?",
			)
			.run(draft, new Date().toISOString(), old ? 1 : 0, id);
	}
	beginConsultationResponse(
		id: string,
		input: string,
		sequenceBaseline: number | null = null,
	): ConsultationPendingResponse | undefined {
		return this.db.transaction(() => {
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
	acceptConsultationResponse(id: string, pendingId: string): ConsultationTurn | undefined {
		return this.db.transaction(() => {
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
	cancelConsultationResponse(id: string, pendingId: string): boolean {
		const result = this.db
			.prepare("DELETE FROM consultation_pending_responses WHERE id = ? AND consultation_id = ?")
			.run(pendingId, id);
		return Number(result.changes) > 0;
	}
	private pendingConsultationResponse(id: string): ConsultationPendingResponse | null {
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
	settleConsultationTurn(
		id: string,
		sequence: number | null,
		output: string | null,
		fields?: {
			settledStatus?: string;
			capturedAt?: string;
			cause?: TurnEndCause;
			detail?: string;
		},
	): boolean {
		const {
			settledStatus = "idle",
			capturedAt = new Date().toISOString(),
			cause = "unknown",
			detail = "",
		} = fields ?? {};
		return this.db.transaction(() => {
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
			if (output !== null) this.storeSettledSnapshot(id, turn.id, output, capturedAt);
			const warning = this.settledWarning(consultation.warning, output, cause, detail);
			this.db
				.prepare(
					"UPDATE consultations SET state = 'awaiting-response', latest_sequence = ?, attention_at = ?, updated_at = ?, draft = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN '' ELSE draft END, draft_updated_at = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN NULL ELSE draft_updated_at END, draft_old = CASE WHEN draft = (SELECT input FROM consultation_turns WHERE id = ?) THEN 0 ELSE draft_old END, warning = ? WHERE id = ?",
				)
				.run(sequence, capturedAt, capturedAt, turn.id, turn.id, turn.id, warning, id);
			return true;
		});
	}
	/** The settled turn's output, stored and named on the turn. */
	private storeSettledSnapshot(
		id: string,
		turnId: string,
		output: string,
		capturedAt: string,
	): void {
		const bounded = boundedSnapshot(output);
		const snapshotId = randomUUID();
		this.db
			.prepare(
				"INSERT INTO consultation_snapshots(id, consultation_id, turn_id, text, captured_at, partial, truncated) VALUES (?, ?, ?, ?, ?, 0, ?)",
			)
			.run(snapshotId, id, turnId, bounded.text, capturedAt, bounded.truncated ? 1 : 0);
		this.db
			.prepare("UPDATE consultation_turns SET snapshot_id = ? WHERE id = ?")
			.run(snapshotId, turnId);
	}
	/** The warning the Consultation wears once its turn settles (ADR 0015). */
	private settledWarning(
		warning: string | null,
		output: string | null,
		cause: TurnEndCause,
		detail: string,
	): string | null {
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
				: isStaleAgentOutputWarning(warning)
					? null
					: warning;
		return endWarning !== null ? endWarning : isTurnEndWarning(baseWarning) ? null : baseWarning;
	}
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
	private consultationTurn(id: string): ConsultationTurn | undefined {
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
	consultationNeedsSnapshot(id: string): boolean {
		return (
			this.db
				.prepare(
					"SELECT 1 FROM consultation_turns WHERE consultation_id = ? AND settled_at IS NOT NULL AND snapshot_id IS NULL LIMIT 1",
				)
				.get(id) != null
		);
	}
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
	private recordRemainingConsultationResource(
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
	beginConsultationClose(id: string): boolean {
		// A close is the other way a `queued` record leaves its wait besides the
		// pickup (ADR 0034, issue #90): the operator abandoned the ask. Its
		// pointer leaves the shared order in the same write, so the queue never
		// holds an item whose record is closing behind a cap the pickup cannot
		// reach.
		return this.db.transaction(() => {
			if (!this.setConsultationState(id, "closing")) return false;
			this.graph().workQueue.dropConsultationWorkItem(id);
			return true;
		});
	}
	recordConsultationCloseFailure(id: string, reason: string): void {
		this.db
			.prepare(
				"UPDATE consultations SET warning = ?, close_result = ?, updated_at = ? WHERE id = ? AND state = 'closing'",
			)
			.run(`cleanup failed: ${reason}`, `cleanup failed: ${reason}`, new Date().toISOString(), id);
	}
	finishConsultationClose(id: string, result?: string, forced = false): void {
		this.db.transaction(() => {
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
	replacementInput(id: string, limit = CONSULTATION_INPUT_LIMIT): string {
		const consultation = this.consultation(id);
		if (consultation == null) return "";
		const turns = this.consultationTurns(id);
		const snapshots = this.consultationSnapshots(id);
		// This aggregate reads the record and its turns; the Response draft module
		// owns the join, the marker, and the bound the recovery text is built with.
		return boundedReplacementInput(
			consultation.initialInput,
			turns.map((turn) => {
				const snapshot = snapshots.find((item) => item.turnId === turn.id);
				return snapshot == null
					? { input: turn.input }
					: { input: turn.input, output: snapshot.text };
			}),
			limit,
		);
	}
	deleteConsultation(id: string): boolean {
		const row = this.db.prepare("SELECT state FROM consultations WHERE id = ?").get(id) as
			| { state: ConsultationState }
			| undefined;
		if (row?.state !== "closed" && row?.state !== "unscheduled") return false;
		this.db.transaction(() => {
			// The delete takes any pointer the record still leaves behind, so the
			// queue never lists an item that names no record (ADR 0034, issue #90).
			this.graph().workQueue.dropConsultationWorkItem(id);
			this.db.prepare("DELETE FROM consultations WHERE id = ?").run(id);
		});
		try {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {}
		return true;
	}
	consultationsByState(states: readonly ConsultationState[]): Consultation[] {
		const placeholders = states.map(() => "?").join(", ");
		return (
			this.db
				.prepare(`SELECT * FROM consultations WHERE state IN (${placeholders})`)
				.all(...states) as unknown as ConsultationRow[]
		).map((row) => this.consultationFromRow(row));
	}
	updateConsultationAgentHandles(id: string, details: ConsultationAgentDetails): void {
		this.db.transaction(() => {
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
			// Follow-up handle writes are bookkeeping and, like the launch's,
			// do not advance the record's activity time.
			this.db
				.prepare(
					"UPDATE consultations SET pane_id = ?, tab_id = ?, workspace_id = ?, session_id = ? WHERE id = ?",
				)
				.run(
					details.paneId,
					details.tabId ?? null,
					details.workspaceId ?? null,
					details.sessionId ?? current.sessionId,
					id,
				);
		});
	}
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
		this.db.transaction(() => {
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
}
