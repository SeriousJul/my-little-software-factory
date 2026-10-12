/**
 * The state aggregate suites' shared fixture (issue #202): a real temporary
 * SQLite file, the sample source facts, and the helpers the aggregate tests
 * share. Each suite registers `cleanup` as its own afterEach.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowState } from "../../src/config.ts";
import type { FetchedTicket, Ticket } from "../../src/domain/ticket.ts";
import type { HandoffChoice } from "../../src/handoff.ts";
import { agentNameFor } from "../../src/naming.ts";
import type { HandoffDetails } from "../../src/state/handoff.ts";
import type { SourceDefinition } from "../../src/state/source-fact.ts";
import type {
	CompletionDecisionInput,
	SettleTurnInput,
} from "../../src/state/ticket-work-cycle.ts";
import type { FactoryState } from "../../src/state.ts";
import { openFactoryState } from "../../src/state.ts";
import type { TurnLogEntry } from "../../src/turn-log.ts";

const paths: string[] = [];

/** Remove every directory `statePath` created. */
export function cleanup(): void {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
}

export function statePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "factory-state-"));
	paths.push(directory);
	return join(directory, "state.sqlite");
}

export const sourceA = { name: "issues-a", kind: "github-issues" };
export const sourceB = { name: "issues-b", kind: "github-issues" };
export const choice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};

/** A plain-text turn log for a settle fixture, one entry per line. */
export function textLog(message: string): TurnLogEntry[] {
	return message.split("\n").map((text) => ({ kind: "text", text }));
}

/** The last-message fallback the corrupt-cell tests expect. */
export const fallback: TurnLogEntry[] = [
	{ kind: "text", text: "fallback first" },
	{ kind: "text", text: "fallback last" },
];

/** A fetched ticket with the labels the caller names. */
export function labeled(labels: string[], identity = "github:github.com:I_5"): FetchedTicket {
	return { ...fetched(identity), labels };
}

/** A persisted settled trace that corrupt-cell tests can alter outside the store. */
export function storedTrace(message = "fallback first\nfallback last"): {
	path: string;
	identity: string;
} {
	const { state, path, rows } = seeded({ file: true });
	const [ticket] = rows;
	const attemptId = settle(state, ticket.identity);
	turn(state, ticket.identity, attemptId, {
		message,
		turnLog: [{ kind: "text", text: "stored valid entry" }],
	});
	state.close();
	return { path, identity: ticket.identity };
}

export function replaceStoredLog(path: string, identity: string, cell: string | null): void {
	const db = new Database(path);
	db.prepare("UPDATE completion_traces SET turn_log_json = ? WHERE ticket_identity = ?").run(
		cell,
		identity,
	);
	db.close();
}

export function readStoredLog(path: string, identity: string): TurnLogEntry[] {
	const state = openFactoryState(path);
	try {
		const trace = state.ticketWorkCycle.lastCompletion(identity);
		if (trace === null) throw new Error("stored trace disappeared");
		return trace.turnLog;
	} finally {
		state.close();
	}
}

/**
 * The herdr Agent name the naming rule gives the harness Ticket (ADR 0098):
 * its title slug with its own identity tag.
 */
export const HARNESS_AGENT_NAME = agentNameFor({
	identity: "github:github.com:I_5",
	title: "Persist source facts",
});

export function fetched(identity = "github:github.com:I_5"): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/5",
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

export function success(tickets: FetchedTicket[]) {
	return { status: "success" as const, fetchedAt: "2026-08-31T10:01:00Z", tickets };
}

/**
 * The standing state the state cases seed: the named source is initialized,
 * the success fetch lands its rows, and the rows are the read the case names.
 * The file is in-memory unless the case names the path, the shape the
 * downgrade and re-read tools work on.
 */
export interface SeededStateOptions {
	/** A real file, for the cases that downgrade it or re-read it. */
	file?: boolean;
	/** The source the rows fetch from. Default: `sourceA`. */
	source?: SourceDefinition;
	/** The rows the source lists. Default: the harness's own ticket. */
	tickets?: FetchedTicket[];
	/** The workflow States the standing read matches. Default: none, the flat read. */
	states?: readonly WorkflowState[];
	/** The fallback task type of the standing read. Default: `implement`. */
	taskType?: string;
	/** The clock the state reads for attempt times. Default: the state module's own. */
	now?: () => number;
}

export function seeded(over: { file: true } & SeededStateOptions): {
	state: FactoryState;
	path: string;
	rows: readonly Ticket[];
};
export function seeded(over?: SeededStateOptions): {
	state: FactoryState;
	path: string | null;
	rows: readonly Ticket[];
};
export function seeded(over: SeededStateOptions = {}): {
	state: FactoryState;
	path: string | null;
	rows: readonly Ticket[];
} {
	const path = over.file ? statePath() : null;
	const state = openFactoryState(path ?? ":memory:", over.now);
	const source = over.source ?? sourceA;
	state.sourceFact.initializeSources([source]);
	state.sourceFact.applyFetch(source, success(over.tickets ?? [fetched()]));
	const rows = state.ticketWorkCycle.ticketListViews(
		over.states ?? [],
		over.taskType ?? "implement",
	).rows;
	return { state, path, rows };
}

/** Claim the identity's next cycle, or throw on the state module's own refusal. */
export function claim(
	state: FactoryState,
	identity: string,
	over: { choice?: HandoffChoice; origin?: "open" | "workflow" | "restart" } = {},
): string {
	const result = state.handoff.claimHandoff(
		identity,
		over.choice ?? (choice as HandoffChoice),
		over.origin ?? "open",
	);
	if (!result.ok) throw new Error(result.reason);
	return result.claim.attemptId;
}

/**
 * Claim and settle the identity's next cycle. The settled attempt stands on
 * the named handles, and a refused settle carries its own reason.
 */
/**
 * Settle one attempt that already stands, without a new claim. A refused
 * settle carries its own reason, and a start that reached its Agent stands on
 * the named handles.
 */
export function settleAttempt(
	state: FactoryState,
	attemptId: string,
	over: { ok?: boolean; reason?: string; handles?: HandoffDetails } = {},
): void {
	state.handoff.settleHandoff(attemptId, over.ok ?? true, over.reason, over.handles);
}

export function settle(
	state: FactoryState,
	identity: string,
	over: {
		ok?: boolean;
		reason?: string;
		handles?: HandoffDetails;
		choice?: HandoffChoice;
		origin?: "open" | "workflow" | "restart";
	} = {},
): string {
	const attemptId = claim(state, identity, over);
	settleAttempt(state, attemptId, over);
	return attemptId;
}

/**
 * Settle the attempt's turn. The defaults stand the harness turn: the
 * implement task under the pi Agent, the message as its own text log, at the
 * harness's completed time.
 */
export function turn(
	state: FactoryState,
	identity: string,
	handoffId: string,
	over: Partial<SettleTurnInput> = {},
): void {
	const message = over.message ?? "Done.";
	state.ticketWorkCycle.settleTurn({
		ticketIdentity: identity,
		handoffId,
		taskType: "implement",
		agentType: "pi",
		message,
		turnLog: over.turnLog ?? textLog(message),
		completedAt: "2026-08-31T11:00:00Z",
		...over,
	});
}

/** Apply the completion decision on the attempt's trace. */
export function decide(
	state: FactoryState,
	identity: string,
	handoffId: string,
	over: Partial<Omit<CompletionDecisionInput, "ticketIdentity" | "handoffId">> = {},
): void {
	state.ticketWorkCycle.applyCompletionDecision({
		ticketIdentity: identity,
		handoffId,
		decision: "closed",
		decidedAt: "2026-08-31T11:30:00Z",
		...over,
	});
}

// The States one projection read matches a ticket against: the first match
// wins, a State with no task is a parking State, and no match at all leaves the
// ticket on the fallback task type. The `position` grouping reads the matched
// State's name, which the projection derives on every read and never stores
// (issue #159).
export const POSITION_STATES = [
	{
		name: "ready-for-agent",
		taskType: "implement",
		match: { sourceKind: "github-issue" as const, labelsAll: ["ready-for-agent"] },
	},
	{
		name: "needs-review",
		taskType: "review",
		match: { sourceKind: "github-issue" as const, labelsAny: ["needs-review"] },
	},
	// A parking State: the plane suggests nothing and starts nothing on its own.
	{ name: "on-hold", match: { sourceKind: "github-issue" as const, labelsAny: ["hold"] } },
];

/** The v4 and later columns and tables a pre-v5 record never stored. */
function dropPostV4(db: Database): void {
	// A pre-v5 record has no leftover fact, no trace settings, and no context
	// window anywhere.
	db.exec(
		"ALTER TABLE handoffs DROP COLUMN leftover_reason;" +
			" ALTER TABLE handoffs DROP COLUMN leftover_at;" +
			" ALTER TABLE handoffs DROP COLUMN leftover_cleared_at;" +
			" ALTER TABLE handoffs DROP COLUMN herdr_name;",
	);
	db.prepare("ALTER TABLE completion_traces DROP COLUMN model").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN thinking").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
	db.prepare("ALTER TABLE consultations DROP COLUMN context_window").run();
	// The v9 columns belong to the run after this record: a pre-v5 trace
	// never stored a cause, and neither did its consultation turns.
	db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
	db.prepare("ALTER TABLE consultation_turns DROP COLUMN cause").run();
	db.prepare("ALTER TABLE consultation_turns DROP COLUMN detail").run();
	dropPostV10(db);
}

/** The v10 and later facts and tables a record before this version never held. */
function dropPostV10(db: Database): void {
	// The v10 facts belong to the run after this record: a pre-v10 database
	// never stored a checkout's confirmed conflict set, and its Consultation
	// never held the one-shot override column.
	db.prepare(
		"ALTER TABLE consultations ADD COLUMN live_conflict_override INTEGER NOT NULL DEFAULT 0",
	).run();
	db.exec("DROP TABLE checkout_conflict_confirmations;");
	// The v13 mode, the v14 queue, and the v19 queue pause belong to the run
	// after this record: a pre-v13 file stored no Auto-handoff mode, no Work
	// queue, and no queue pause.
	db.exec("DROP TABLE queue_pause; DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
	// The v13 fact belongs to the run after this record: a pre-v13 trace never
	// stored the transition outcome.
	db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
}

/** The schema's indexes or tables and the stamp the file wears. */
export function schemaObjects(
	path: string,
	kind: "index" | "table",
): { names: string[]; version: number } {
	const check = new Database(path, { readonly: true });
	const names = (
		check.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(kind) as Array<{
			name: string;
		}>
	).map((row) => row.name);
	const version = (check.prepare("SELECT version FROM schema_version").get() as { version: number })
		.version;
	check.close();
	return { names, version };
}

/** Downgrade the state file to the shape a v2 record held. */
export function downgradeToV2(path: string): void {
	const db = new Database(path);
	// A v2 record knows none of the tables the later versions create.
	db.exec(
		"DROP TABLE consultation_pending_responses;" +
			" DROP TABLE consultation_remaining_resources;" +
			" DROP TABLE consultation_resources;" +
			" DROP TABLE consultation_snapshots;" +
			" DROP TABLE consultation_turns;" +
			" DROP TABLE consultations;" +
			" DROP TABLE checkout_conflict_confirmations;" +
			" DROP TABLE queue_pause;" +
			" DROP TABLE auto_handoff_mode;" +
			" DROP TABLE work_queue;",
	);
	db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN turn_log_json").run();
	// A v2 trace carries no model, thinking, or context window: the v7 and
	// v8 columns go with the v6 ones. The consultations table does not exist
	// at this version.
	db.prepare("ALTER TABLE completion_traces DROP COLUMN model").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN thinking").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
	// The leftover columns belong to v6: a v2 record never heard of them.
	db.exec(
		"ALTER TABLE handoffs DROP COLUMN leftover_reason;" +
			" ALTER TABLE handoffs DROP COLUMN leftover_at;" +
			" ALTER TABLE handoffs DROP COLUMN leftover_cleared_at;" +
			" ALTER TABLE handoffs DROP COLUMN herdr_name;",
	);
	db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
	db.prepare("UPDATE schema_version SET version = 2").run();
	db.close();
}

/** Downgrade the state file to the shape a v4 record held. */
export function downgradeToV4(path: string): void {
	const db = new Database(path);
	db.exec("DROP TABLE consultation_pending_responses");
	dropPostV4(db);
	db.prepare("UPDATE schema_version SET version = 4").run();
	db.close();
}

/**
 * Downgrade the state file to the shape a v5 record held: the v4 shape plus
 * the stored choice rewritten without the key the v8 step gives it.
 */
export function downgradeToV5(path: string): void {
	const db = new Database(path);
	dropPostV4(db);
	db.prepare("UPDATE schema_version SET version = 5").run();
	db.prepare("UPDATE handoffs SET choice_json = json_remove(choice_json, '$.contextWindow')").run();
	db.close();
}

/**
 * Downgrade the state file to the shape a v7 record held: the v5 shape with
 * the v6 settings columns kept, since v6 added the model and the level.
 */
export function downgradeToV7(path: string): void {
	const db = new Database(path);
	db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
	db.prepare("ALTER TABLE consultations DROP COLUMN context_window").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
	db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
	db.prepare("ALTER TABLE consultation_turns DROP COLUMN cause").run();
	db.prepare("ALTER TABLE consultation_turns DROP COLUMN detail").run();
	dropPostV10(db);
	db.prepare("UPDATE schema_version SET version = 7").run();
	db.prepare("UPDATE handoffs SET choice_json = json_remove(choice_json, '$.contextWindow')").run();
	db.close();
}

/** A Work queue row in the shape the retired step wrote, on a v14 file. */
export function downgradeQueueToTheAbandonedShape(path: string): void {
	const db = new Database(path);
	// The step that landed the queue (issue #88, commit 604d803) keyed the row
	// by a random id and ordered it by `queue_order`, and it stamped the file
	// version 14. The step that ships now writes a `position` keyed table under
	// the same number, so a file this record made claims 14 with that shape.
	db.exec(`
		DROP TABLE work_queue;
		CREATE TABLE work_queue (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			ticket_identity TEXT,
			origin TEXT,
			choice_json TEXT,
			queue_order INTEGER NOT NULL,
			created_at TEXT NOT NULL
		);
		UPDATE schema_version SET version = 14;
	`);
	db.close();
}

/** Run the ticket through a handoff, a settled turn, and a closed decision. */
export function closedCycle(
	state: FactoryState,
	identity: string,
	handles: { paneId: string; tabId: string; workspaceId: string } = {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	},
	list?: FetchedTicket[],
): string {
	const attemptId = settle(state, identity, { handles });
	// The helper's own clock: the turn and the decision stand a minute apart
	// before the re-read, so the re-read's time passes the refresh gate.
	turn(state, identity, attemptId, {
		message: "the turn is over",
		completedAt: "2026-08-31T10:02:00Z",
	});
	decide(state, identity, attemptId, { decidedAt: "2026-08-31T10:03:00Z" });
	if (list !== undefined) {
		// The app re-reads the ticket's source when its cycle ends, after the
		// decision's time: the ticket is re-verified, and a later open claim
		// of it passes.
		state.sourceFact.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T10:04:00Z",
			tickets: list,
		});
	}
	return attemptId;
}

export const uid = (lead: string) => `${lead.repeat(8)}-1111-4111-8111-111111111111`;

export const repository = {
	identity: "github.com/acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
	path: "/tmp/factory",
};

/** A `queued` Consultation, born with its Work queue item. */
export function queuedConsultation(state: FactoryState, id: string, createdAt?: string) {
	return state.consultationRecord.createConsultation({
		id,
		typeName: "grill",
		agentType: "pi",
		environment: "worktree",
		template: "/grill {input}",
		initialInput: "review auth",
		renderedOpeningPrompt: "/grill review auth",
		repository,
		agentName: `consultation-${id.slice(0, 8)}`,
		createdAt: createdAt ?? "2026-09-19T23:00:00.000Z",
		initialState: "queued",
	});
}

/** Enqueue one handoff item the way the operator's start does. */
export const enqueue = (state: FactoryState, identity: string) => {
	const result = state.workQueue.enqueueWork({
		ticketIdentity: identity,
		origin: "open",
		choice,
		previousMessage: "",
	});
	if (!result.ok) throw new Error(result.reason);
};
