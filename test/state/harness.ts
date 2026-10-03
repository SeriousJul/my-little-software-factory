/**
 * The state aggregate suites' shared fixture (issue #202): a real temporary
 * SQLite file, the sample source facts, and the helpers the aggregate tests
 * share. Each suite registers `cleanup` as its own afterEach.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchedTicket } from "../../src/domain/ticket.ts";
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
	const path = statePath();
	const state = openFactoryState(path);
	state.sourceFact.initializeSources([sourceA]);
	state.sourceFact.applyFetch(sourceA, success([fetched()]));
	const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
	const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true);
	state.ticketWorkCycle.settleTurn({
		ticketIdentity: ticket.identity,
		handoffId: claim.claim.attemptId,
		taskType: "implement",
		agentType: "pi",
		message,
		turnLog: [{ kind: "text", text: "stored valid entry" }],
		completedAt: "2026-08-31T11:00:00Z",
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
	const claim = state.handoff.claimHandoff(identity, choice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, handles);
	state.ticketWorkCycle.settleTurn({
		ticketIdentity: identity,
		handoffId: claim.claim.attemptId,
		taskType: "implement",
		agentType: "pi",
		message: "the turn is over",
		turnLog: [{ kind: "text", text: "the turn is over" }],
		completedAt: "2026-08-31T10:02:00Z",
	});
	state.ticketWorkCycle.applyCompletionDecision({
		ticketIdentity: identity,
		handoffId: claim.claim.attemptId,
		decision: "closed",
		decidedAt: "2026-08-31T10:03:00Z",
	});
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
	return claim.claim.attemptId;
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
