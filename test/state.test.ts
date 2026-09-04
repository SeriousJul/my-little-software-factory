import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import type { FetchedTicket } from "../src/domain/ticket.ts";
import { openFactoryState, SCHEMA_V1, StateError } from "../src/state.ts";
import type { TurnLogEntry } from "../src/turn-log.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function statePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "factory-state-"));
	paths.push(directory);
	return join(directory, "state.sqlite");
}

const sourceA = { name: "issues-a", kind: "github-issues" };
const sourceB = { name: "issues-b", kind: "github-issues" };
const choice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
};

/** A plain-text turn log for a settle fixture, one entry per line. */
function textLog(message: string): TurnLogEntry[] {
	return message.split("\n").map((text) => ({ kind: "text", text }));
}

/** A persisted settled trace that corrupt-cell tests can alter outside the store. */
function storedTrace(message = "fallback first\nfallback last"): {
	path: string;
	identity: string;
} {
	const path = statePath();
	const state = openFactoryState(path);
	state.initializeSources([sourceA]);
	state.applyFetch(sourceA, success([fetched()]));
	const [ticket] = state.visibleTickets([], "implement");
	const claim = state.claimHandoff(ticket.identity, choice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.settleHandoff(claim.claim.attemptId, true);
	state.settleTurn({
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

function replaceStoredLog(path: string, identity: string, cell: string | null): void {
	const db = new DatabaseSync(path);
	db.prepare("UPDATE completion_traces SET turn_log_json = ? WHERE ticket_identity = ?").run(
		cell,
		identity,
	);
	db.close();
}

function readStoredLog(path: string, identity: string): TurnLogEntry[] {
	const state = openFactoryState(path);
	try {
		const trace = state.lastCompletion(identity);
		if (trace === null) throw new Error("stored trace disappeared");
		return trace.turnLog;
	} finally {
		state.close();
	}
}

function fetched(identity = "github:github.com:I_5"): FetchedTicket {
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

function success(tickets: FetchedTicket[]) {
	return { status: "success" as const, fetchedAt: "2026-08-31T10:01:00Z", tickets };
}

describe("factory SQLite state", () => {
	test("keeps the prior complete snapshot after a source fails and blocks its handoff", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		expect(state.visibleTickets([], "implement")).toEqual([
			expect.objectContaining({ identity: "github:github.com:I_5", actionable: true }),
		]);

		state.applyFetch(sourceA, { status: "failed", reason: "GitHub rate limit exceeded" });
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(expect.objectContaining({ actionable: false }));
		expect(ticket.memberships?.[0]).toEqual(expect.objectContaining({ health: "stale" }));
		expect(state.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("not actionable") }),
		);
		state.close();
	});

	test("merges overlapping memberships, lets a healthy source act, and preserves durable handoff state", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA, sourceB]);
		state.applyFetch(sourceA, success([fetched()]));
		state.applyFetch(sourceB, success([fetched()]));
		state.applyFetch(sourceA, { status: "failed", reason: "network unavailable" });
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket.actionable).toBe(true);
		expect(ticket.memberships).toHaveLength(2);

		const claimed = state.claimHandoff(ticket.identity, choice, "open");
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		expect(state.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		state.settleHandoff(claimed.claim.attemptId, true);
		state.close();

		const reopened = openFactoryState(path);
		const [persisted] = reopened.visibleTickets([], "implement");
		expect(persisted).toEqual(
			expect.objectContaining({
				state: "handed-off",
				handoff: expect.objectContaining({
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
				}),
			}),
		);
		reopened.close();
	});

	test("settles a normal failed handoff so an operator can retry", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const first = state.claimHandoff(ticket.identity, choice, "open");
		if (!first.ok) throw new Error(first.reason);
		state.settleHandoff(first.claim.attemptId, false, "herdr is unavailable");
		expect(state.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: true }),
		);
		state.close();
	});

	test("keeps identity and state when a configured source is renamed", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		state.initializeSources([sourceB]);
		state.applyFetch(sourceB, success([fetched()]));
		const tickets = state.visibleTickets([], "implement");
		expect(tickets).toHaveLength(1);
		expect(tickets[0]).toEqual(
			expect.objectContaining({ identity: "github:github.com:I_5", state: "open" }),
		);
		state.close();
	});

	test("retains handed-off work after a source is removed and blocks pending handoff recovery", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const started = state.claimHandoff(ticket.identity, choice, "open");
		if (!started.ok) throw new Error(started.reason);
		state.settleHandoff(started.claim.attemptId, true);
		state.initializeSources([]);
		expect(state.visibleTickets([], "implement")).toEqual([
			expect.objectContaining({
				state: "handed-off",
				memberships: [expect.objectContaining({ health: "removed" })],
			}),
		]);
		state.close();

		const reopened = openFactoryState(path);
		const [persisted] = reopened.visibleTickets([], "implement");
		const pending = reopened.claimHandoff(persisted.identity, choice, "open");
		expect(pending).toEqual(expect.objectContaining({ ok: false }));
		reopened.close();
	});

	test("stops with a readable error for a database from a newer schema version", () => {
		const path = statePath();
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
		db.prepare("INSERT INTO schema_version(version) VALUES (4)").run();
		db.close();

		let error: unknown;
		try {
			openFactoryState(path);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(StateError);
		expect(String(error)).toContain("newer schema version 4");
		expect(String(error)).toContain(path);
	});

	test("stops on a damaged database without deleting the data", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		state.close();

		// Corrupt the header of the last page: the schema stays readable, but the
		// integrity check must fail on the damaged data.
		const buffer = readFileSync(path);
		buffer[(buffer.byteLength / 4096 - 1) * 4096] = 0;
		writeFileSync(path, buffer);

		let error: unknown;
		try {
			openFactoryState(path);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(StateError);
		expect(String(error)).toContain("integrity check failed");
		expect(String(error)).toContain(path);
		expect(statSync(path).size).toBeGreaterThan(0);
	});

	test("a settled turn rests in awaiting with a pending completion trace", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-7",
			tabId: "tab-7",
			workspaceId: "ws-7",
		});

		// The agent reports working, then settles the turn.
		expect(state.markTicketRunning(ticket.identity)).toBe(true);
		expect(state.markTicketRunning(ticket.identity)).toBe(false);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The work is done. Tests pass.",
			turnLog: textLog("The work is done. Tests pass."),
			completedAt: "2026-08-31T11:00:00Z",
		});

		const [rested] = state.visibleTickets([], "implement");
		expect(rested.state).toBe("awaiting");
		// The herdr handles the handoff started are stored on the ticket.
		expect(rested.handoff).toEqual(
			expect.objectContaining({
				agentType: "pi",
				environment: "worktree",
				taskType: "implement",
				paneId: "pane-7",
				tabId: "tab-7",
				workspaceId: "ws-7",
			}),
		);
		expect(rested.lastCompletion).toEqual(
			expect.objectContaining({
				taskType: "implement",
				agentType: "pi",
				message: "The work is done. Tests pass.",
				decision: null,
			}),
		);
		state.close();
	});

	test("a second settle of the same turn refreshes the trace instead of adding one", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "First capture.",
			turnLog: textLog("First capture."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Last capture.",
			turnLog: textLog("Last capture."),
			completedAt: "2026-08-31T11:05:00Z",
		});

		const [rested] = state.visibleTickets([], "implement");
		expect(rested.lastCompletion?.message).toBe("Last capture.");
		const traceCount = new DatabaseSync(path)
			.prepare("SELECT COUNT(*) AS n FROM completion_traces WHERE ticket_identity = ?")
			.get(ticket.identity) as { n: number };
		expect(traceCount.n).toBe(1);
		state.close();
	});

	test("a closed decision ends the work cycle: back to open with the cycle incremented", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		expect(state.visibleTickets([], "implement")[0].state).toBe("awaiting");

		// The decision records on the trace and ends the cycle.
		state.applyCompletionDecision({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		const [returned] = state.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		expect(returned.lastCompletion?.decision).toBe("closed");

		// The next handoff runs in work cycle 2.
		const second = state.claimHandoff(returned.identity, choice, "open");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		state.settleHandoff(second.claim.attemptId, true);
		const cycles = new DatabaseSync(path)
			.prepare("SELECT work_cycle FROM handoffs WHERE ticket_identity = ? ORDER BY work_cycle")
			.all(ticket.identity) as Array<{ work_cycle: number }>;
		expect(cycles).toEqual([{ work_cycle: 1 }, { work_cycle: 2 }]);
		state.close();
	});

	test("an abandoned decision ends the work cycle too", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Lost.",
			turnLog: textLog("Lost."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.applyCompletionDecision({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			decision: "abandoned",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		const [returned] = state.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		state.close();
	});

	test("a goto moves awaiting back to running and leaves the trace pending", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		expect(state.visibleTickets([], "implement")[0].state).toBe("awaiting");

		// Goto is a state move, not a completion decision: the ticket runs
		// again, and the settled turn stays pending on its trace.
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "goto",
				decidedAt: "2026-08-31T11:30:00Z",
			}),
		).toBe(true);
		const [running] = state.visibleTickets([], "implement");
		expect(running.state).toBe("running");
		expect(running.lastCompletion?.decision).toBeNull();
		expect(running.lastCompletion?.message).toBe("Done.");
		const db = new DatabaseSync(path, { readOnly: true });
		const traceCount = db
			.prepare("SELECT COUNT(*) AS n FROM completion_traces WHERE ticket_identity = ?")
			.get(ticket.identity) as { n: number };
		db.close();
		expect(traceCount.n).toBe(1);

		// A second goto moves nothing: the ticket already runs.
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "goto",
				decidedAt: "2026-08-31T11:31:00Z",
			}),
		).toBe(false);
		state.close();
	});

	test("a goto on a handoff that never settled writes no completion trace", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		// The ticket is in flight and its turn unsettled: the blocked agent's
		// goto focuses the pane without touching the trace or the state.
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "goto",
				decidedAt: "2026-08-31T11:30:00Z",
			}),
		).toBe(false);
		const [inFlight] = state.visibleTickets([], "implement");
		expect(inFlight.state).toBe("handed-off");
		expect(inFlight.lastCompletion).toBeNull();
		state.close();
	});

	test("a settled turn keeps the agent name after the ticket loses its active membership", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		// The agent closes its own source item before the turn settles: the
		// membership goes stale, but the title still names the agent.
		state.applyFetch(sourceA, success([]));
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		const [rested] = state.visibleTickets([], "implement");
		expect(rested.lastCompletion?.agentName).toBe("persist-source-facts");
		state.close();
	});

	test("a workflow claim needs awaiting, a restart claim needs in-flight", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});

		// Awaiting: a workflow handoff is allowed, an open claim is not.
		expect(state.claimHandoff(ticket.identity, choice, "workflow").ok).toBe(true);
		expect(state.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false }),
		);
		// A restart needs an in-flight ticket, and the open workflow claim
		// blocks every further claim until it resolves.
		expect(state.claimHandoff(ticket.identity, choice, "restart")).toEqual(
			expect.objectContaining({
				ok: false,
				reason: expect.stringContaining("in-flight"),
			}),
		);
		expect(state.claimHandoff(ticket.identity, choice, "workflow")).toEqual(
			expect.objectContaining({
				ok: false,
				reason: expect.stringContaining("recovery"),
			}),
		);
		state.close();
	});

	test("a v1 database migrates to v2: done becomes awaiting and the traces table appears", () => {
		const path = statePath();
		const db = new DatabaseSync(path);
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(SCHEMA_V1);
		db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
		db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
		db.prepare(
			"INSERT INTO source_health VALUES ('issues', 'github-issues', 'healthy', NULL, '2026-08-31T09:00:00Z')",
		).run();
		db.prepare("INSERT INTO tickets VALUES ('github:github.com:I_5', 'done', 1, 0)").run();
		db.prepare(
			"INSERT INTO memberships (" +
				"source_name, ticket_identity, active, source_kind, external_key, source_state, url, " +
				"title, description, labels_json, external_updated_at, repository_identity, " +
				"repository_display_name, repository_clone_url, attributes_json) " +
				"VALUES ('issues', 'github:github.com:I_5', 1, 'github-issue', '#5', 'open', " +
				"'https://github.com/acme/billing/issues/5', 'Persist source facts', 'Persist them.', " +
				"'[]', '2026-08-31T09:00:00Z', 'acme/billing', 'acme/billing', " +
				"'https://github.com/acme/billing.git', '{}')",
		).run();
		db.close();

		const state = openFactoryState(path);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(expect.objectContaining({ state: "awaiting" }));
		const tables = new DatabaseSync(path)
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>;
		expect(tables.map((t) => t.name)).toContain("completion_traces");
		state.close();
	});

	test("a v2 database migrates to v3: the trace degrades its log from the last message", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "line one\nline two",
			turnLog: textLog("line one\nline two"),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.close();

		// Downgrade the database to v2: a trace without the turn log column
		// and no later Consultation tables.
		const db = new DatabaseSync(path);
		db.exec(`
			DROP TABLE consultation_pending_responses;
			DROP TABLE consultation_remaining_resources;
			DROP TABLE consultation_resources;
			DROP TABLE consultation_snapshots;
			DROP TABLE consultation_turns;
			DROP TABLE consultations;
		`);
		db.prepare("ALTER TABLE completion_traces DROP COLUMN turn_log_json").run();
		// The leftover columns belong to v6: a v2 record never heard of them.
		db.exec(
			"ALTER TABLE handoffs DROP COLUMN leftover_reason;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_at;" +
				" ALTER TABLE handoffs DROP COLUMN leftover_cleared_at;" +
				" ALTER TABLE handoffs DROP COLUMN herdr_name;",
		);
		db.prepare("UPDATE schema_version SET version = 2").run();
		db.close();

		const reopened = openFactoryState(path);
		const [restored] = reopened.visibleTickets([], "implement");
		// The legacy trace reads a null log cell and degrades: its last
		// message, one line per entry, stands in for the log.
		expect(restored.lastCompletion).toEqual(
			expect.objectContaining({
				message: "line one\nline two",
				turnLog: [
					{ kind: "text", text: "line one" },
					{ kind: "text", text: "line two" },
				],
				decision: null,
			}),
		);
		reopened.close();
	});

	test("a settled turn stores its log and a re-settle refreshes it in place", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "first capture",
			turnLog: [{ kind: "text", text: "first capture" }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		// The agent works again and settles the same turn: the log refreshes.
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "final text",
			turnLog: [
				{ kind: "tool", name: "bash", target: "npm test", failed: false },
				{ kind: "text", text: "final text" },
			],
			completedAt: "2026-08-31T11:05:00Z",
		});
		expect(state.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({
				message: "final text",
				turnLog: [
					{ kind: "tool", name: "bash", target: "npm test", failed: false },
					{ kind: "text", text: "final text" },
				],
				decision: null,
			}),
		);
		state.close();
	});

	test("keeps an awaiting ticket visible while every source is gone", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});

		// The agent closes the external item while working: the ticket leaves
		// the source, but a pending decision keeps it visible.
		state.applyFetch(sourceA, success([]));
		const visible = state.visibleTickets([], "implement");
		expect(visible).toEqual([
			expect.objectContaining({ identity: ticket.identity, state: "awaiting" }),
		]);

		state.close();
	});

	test("reclaims a dead local owner's lease but never a lease from another host", () => {
		const path = statePath();
		const deadPid = spawnSync("true").pid;
		expect(deadPid).toBeGreaterThan(0);
		// Let the real migration create the schema first.
		const primed = openFactoryState(path);
		primed.close();
		const seedLease = (ownerPid: number, ownerHost: string) => {
			const db = new DatabaseSync(path);
			db.prepare(
				"INSERT OR REPLACE INTO lease(name, owner_token, pid, host, heartbeat_at) " +
					"VALUES ('control-plane', 'stale-owner', ?, ?, ?)",
			).run(ownerPid, ownerHost, Date.now());
			db.close();
		};

		// A dead local pid is a safe reclaim signal: that owner cannot be running.
		seedLease(deadPid, os.hostname());
		const first = openFactoryState(path);
		first.acquireLease();
		first.close();

		// A lease owned by another host is never reclaimed by local pid liveness.
		seedLease(process.pid, "other-host");
		const second = openFactoryState(path);
		expect(() => second.acquireLease()).toThrow("already in use");
		second.close();
	});

	test("opens in WAL mode with foreign keys enforced", () => {
		const path = statePath();
		const state = openFactoryState(path);
		// Read the two pragmas on the live connection the state uses.
		const db = (state as unknown as { db: DatabaseSync }).db;
		const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
		expect(journal.journal_mode).toBe("wal");
		expect(foreignKeys.foreign_keys).toBe(1);
		// WAL is a durable database property: a second connection, as the
		// agent's tooling would use, reads the same mode while the state is open.
		const other = new DatabaseSync(path);
		expect(
			(other.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
		).toBe("wal");
		other.close();
		state.close();
	});

	test("keeps an unresolved handoff attempt blocked after restart", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.close();
		const reopened = openFactoryState(path);
		const [persisted] = reopened.visibleTickets([], "implement");
		expect(persisted.handoffRecoveryRequired).toBe(true);
		expect(reopened.claimHandoff(persisted.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		reopened.close();
	});

	/** A ticket whose one work cycle ran, settled, and closed. */
	function closedCycle(
		state: ReturnType<typeof openFactoryState>,
		identity: string,
		handles: { paneId: string; tabId: string; workspaceId: string } = {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		},
	): string {
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, handles);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T10:02:00Z",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T10:03:00Z",
		});
		return claim.claim.attemptId;
	}

	test("a reclaim runs the ticket in a new handoff of its current cycle", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		closedCycle(state, identity);
		const claimed = state.reclaimHandoff(identity, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(claimed).toEqual({ attemptId: expect.any(String) });
		expect(state.ticketsByState(["running"])).toEqual([
			expect.objectContaining({
				ticketIdentity: identity,
				workCycle: 2,
				taskType: "implement",
				agentType: "pi",
				paneId: "pane-1",
				handoffAttemptId: claimed?.attemptId,
			}),
		]);
		// The reclaimed handoff copies the previous handoff's choices, and the
		// closed cycle keeps its handoff and its decided trace.
		expect(state.handoffCount(identity)).toBe(2);
		expect(state.visibleTickets([], "implement")[0]).toEqual(
			expect.objectContaining({
				state: "running",
				handoff: expect.objectContaining({ attemptId: claimed?.attemptId, taskType: "implement" }),
				lastCompletion: expect.objectContaining({
					decision: "closed",
					completedAt: "2026-08-31T10:02:00Z",
				}),
			}),
		);
		// The closed cycle's trace stays decided and is not rewritten.
		expect(state.lastCompletion(identity)).toEqual(
			expect.objectContaining({ decision: "closed", completedAt: "2026-08-31T10:02:00Z" }),
		);
		state.close();
	});

	test("a reclaim records no command and refuses a ticket that is not open", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched("github:github.com:I_6"), fetched()]));
		// A ticket with no handoff at all cannot be reclaimed.
		expect(
			state.reclaimHandoff("github:github.com:I_6", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			}),
		).toBe(null);
		const identity = "github:github.com:I_5";
		closedCycle(state, identity);
		const claim = state.claimHandoff("github:github.com:I_6", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, { paneId: "pane-6" });
		// A running ticket is already tracked: a late poll must not stack handoffs.
		expect(
			state.reclaimHandoff("github:github.com:I_6", {
				paneId: "pane-6",
				tabId: "tab-1",
				workspaceId: "ws-1",
			}),
		).toBe(null);
		// An unresolved attempt blocks the reclaim, exactly as it blocks a handoff.
		closedCycle(state, identity);
		const pending = state.claimHandoff(identity, choice, "open");
		if (!pending.ok) throw new Error(pending.reason);
		expect(
			state.reclaimHandoff(identity, { paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1" }),
		).toBe(null);
		expect(
			state.visibleTickets([], "implement").find((ticket) => ticket.identity === identity),
		).toEqual(expect.objectContaining({ state: "open", handoffCount: 2 }));
		state.close();
	});

	test("records a failed Close cleanup as a leftover environment of the handoff", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const handoffId = closedCycle(state, identity);

		expect(
			state.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId,
				reason:
					"fatal: the worktree contains modified or untracked files, use --force to delete it",
			}),
		).toEqual({
			handoffId,
			environment: "worktree",
			workspaceId: "ws-1",
			tabId: "tab-1",
			paneId: "pane-1",
			reason: "fatal: the worktree contains modified or untracked files, use --force to delete it",
			at: expect.any(String),
		});
		// The fact rides on the ticket, so the detail pane can name it.
		expect(state.visibleTickets([], "implement")[0]).toEqual(
			expect.objectContaining({
				state: "open",
				workCycle: 2,
				leftover: expect.objectContaining({ handoffId, workspaceId: "ws-1", paneId: "pane-1" }),
			}),
		);

		expect(state.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(1);
		expect(state.leftoverEnvironment(identity)).toBe(null);
		expect(state.visibleTickets([], "implement")[0].leftover).toBe(null);
		// The handoff row keeps why it was left over: the record survives the clear.
		expect(
			state.leftoverEnvironments(identity).every((leftover) => leftover.handoffId !== handoffId),
		).toBe(true);
		state.close();
	});

	test("a leftover named by a herdr collision lands on the handoff that holds the name", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		closedCycle(state, identity);
		// A second closed cycle: the ticket now holds two environments, and the
		// collision names the older one by its pane.
		closedCycle(state, identity);

		const recorded = state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			paneId: "pane-1",
			reason: "agent name persist-source-facts is already used",
		});
		expect(recorded?.paneId).toBe("pane-1");
		expect(state.leftoverEnvironments(identity)).toHaveLength(1);
		// A ticket with no handoff to carry the fact records nothing.
		expect(
			state.recordLeftoverEnvironment({
				ticketIdentity: "github:github.com:I_9",
				reason: "nothing",
			}),
		).toBe(null);
		// With no handle to go on, the ticket's latest handoff is the one whose
		// cycle closed.
		const latest = state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			reason: "the close cleanup did not run",
		});
		expect(latest?.paneId).toBe("pane-1");
		expect(state.handoffHandles(identity)).toEqual({
			paneIds: ["pane-1", "pane-1"],
			workspaceIds: ["ws-1", "ws-1"],
		});
		state.close();
	});

	test("a clearing names only the environment it ended", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const first = closedCycle(state, identity);
		// The second cycle lived in the same workspace on another tab: the
		// shape a reclaimed agent leaves, where one workspace holds the tabs of
		// several cycles (ADR 0011).
		const second = closedCycle(state, identity, {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-1",
		});
		const record = () => {
			state.recordLeftoverEnvironment({ ticketIdentity: identity, handoffId: first, reason: "a" });
			state.recordLeftoverEnvironment({ ticketIdentity: identity, handoffId: second, reason: "b" });
			expect(state.leftoverEnvironments(identity)).toHaveLength(2);
		};

		// A worktree removal closes the workspace, so it ends both facts: both
		// handoffs ran in the one workspace herdr could not remove.
		record();
		expect(state.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(2);
		expect(state.leftoverEnvironments(identity)).toEqual([]);

		// A tab close reaches one tab with the panes inside it, not the
		// workspace around it: the fact of the other tab stands.
		record();
		expect(state.clearLeftoverEnvironments(identity, { tabId: "tab-1" })).toBe(1);
		expect(state.leftoverEnvironments(identity)).toEqual([
			expect.objectContaining({ handoffId: second }),
		]);

		// A cleanup that ran no command ends nothing herdr can see, so it
		// resolves only the fact of its own handoff row.
		record();
		expect(state.clearLeftoverEnvironments(identity, { handoffId: first })).toBe(1);
		expect(state.leftoverEnvironments(identity)).toEqual([
			expect.objectContaining({ handoffId: second }),
		]);

		// A handle that names no fact clears nothing, so a stale answer cannot
		// resolve a leftover the operator still has to end.
		expect(state.clearLeftoverEnvironments(identity, { tabId: "tab-9" })).toBe(0);
		expect(state.clearLeftoverEnvironments(identity, { workspaceId: "ws-9" })).toBe(0);
		expect(state.leftoverEnvironments(identity)).toHaveLength(1);
		state.close();
	});

	test("a handoff records the herdr name its agent started under", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			// The stable name was still held by the ticket's own leftover agent.
			agentName: "persist-source-facts-c2",
		});
		// The completion trace of this handoff's turn names the agent herdr
		// actually runs, not the name the ticket would have wanted.
		expect(state.agentNameForTicket(identity)).toBe("persist-source-facts-c2");
		state.close();
	});

	test("a handoff that stored no herdr name reads the ticket's stable one", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, { paneId: "pane-1" });
		// A legacy row, and every clean handoff of a free name: the naming
		// rule gives the same answer herdr took.
		expect(state.agentNameForTicket(identity)).toBe("persist-source-facts");
		state.close();
	});

	test("a failed clear leaves the leftover standing with its new reason", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		const handoffId = claim.claim.attemptId;
		state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId,
			reason: "the worktree is dirty",
			at: "2026-09-02T10:00:00.000Z",
		});
		expect(state.clearLeftoverEnvironments(identity, { workspaceId: "ws-1" })).toBe(1);
		expect(state.leftoverEnvironment(identity)).toBe(null);
		// The clear's own cleanup failed: the fact the operator can act on
		// stands again, with the reason herdr gave this time.
		state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId,
			reason: "herdr refused the removal again",
			at: "2026-09-02T10:05:00.000Z",
		});
		expect(state.leftoverEnvironment(identity)).toEqual(
			expect.objectContaining({
				handoffId,
				reason: "herdr refused the removal again",
				at: "2026-09-02T10:05:00.000Z",
			}),
		);
		state.close();
	});

	test("permits only one live lease for a database", () => {
		const path = statePath();
		const first = openFactoryState(path);
		const second = openFactoryState(path);
		first.acquireLease();
		expect(() => second.acquireLease()).toThrow("already in use");
		first.close();
		second.acquireLease();
		second.close();
	});
});

describe("stored completion trace degradation", () => {
	const fallback = [
		{ kind: "text", text: "fallback first" },
		{ kind: "text", text: "fallback last" },
	];

	test("a null turn-log cell degrades to one entry per last-message line", () => {
		const trace = storedTrace();
		replaceStoredLog(trace.path, trace.identity, null);
		expect(readStoredLog(trace.path, trace.identity)).toEqual(fallback);
	});

	test("invalid turn-log JSON degrades to the last-message fallback", () => {
		const trace = storedTrace();
		replaceStoredLog(trace.path, trace.identity, "not json");
		expect(readStoredLog(trace.path, trace.identity)).toEqual(fallback);
	});

	test("a turn-log cell that parses to a non-list degrades to the fallback", () => {
		const trace = storedTrace();
		replaceStoredLog(trace.path, trace.identity, JSON.stringify({ kind: "text", text: "wrong" }));
		expect(readStoredLog(trace.path, trace.identity)).toEqual(fallback);
	});

	test("skips a non-record stored entry while keeping readable entries", () => {
		const trace = storedTrace();
		replaceStoredLog(
			trace.path,
			trace.identity,
			JSON.stringify(["bad", { kind: "text", text: "kept" }]),
		);
		expect(readStoredLog(trace.path, trace.identity)).toEqual([{ kind: "text", text: "kept" }]);
	});

	test("skips an unknown stored entry kind while keeping readable entries", () => {
		const trace = storedTrace();
		replaceStoredLog(
			trace.path,
			trace.identity,
			JSON.stringify([
				{ kind: "future", payload: "skip" },
				{ kind: "text", text: "kept" },
			]),
		);
		expect(readStoredLog(trace.path, trace.identity)).toEqual([{ kind: "text", text: "kept" }]);
	});

	test("skips a stored tool entry missing a required field", () => {
		const trace = storedTrace();
		replaceStoredLog(
			trace.path,
			trace.identity,
			JSON.stringify([
				{ kind: "tool", name: "bash", target: "npm test" },
				{ kind: "text", text: "kept" },
			]),
		);
		expect(readStoredLog(trace.path, trace.identity)).toEqual([{ kind: "text", text: "kept" }]);
	});

	test("a stored log without valid entries degrades to the last-message fallback", () => {
		const trace = storedTrace();
		replaceStoredLog(trace.path, trace.identity, JSON.stringify([null, { kind: "future" }]));
		expect(readStoredLog(trace.path, trace.identity)).toEqual(fallback);
	});

	test("a stored log with a valid entry wins over the last-message fallback", () => {
		const trace = storedTrace();
		replaceStoredLog(
			trace.path,
			trace.identity,
			JSON.stringify([{ kind: "text", text: "stored wins" }]),
		);
		expect(readStoredLog(trace.path, trace.identity)).toEqual([
			{ kind: "text", text: "stored wins" },
		]);
	});
});
