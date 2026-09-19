import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

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
	contextWindow: "",
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
	const db = new Database(path);
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

	test("lists the live tickets with the labels of their newest membership (ADR 0023)", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA, sourceB]);
		state.applyFetch(sourceA, success([fetched()]));
		expect(state.liveTicketLabels()).toEqual([
			{ identity: "github:github.com:I_5", labels: ["ready-for-agent"] },
		]);
		// A second source lists the same ticket with other labels and a
		// newer update: the newest membership's labels win.
		state.applyFetch(
			sourceB,
			success([
				{
					...fetched(),
					labels: ["needs-work"],
					externalUpdatedAt: "2026-08-31T11:00:00Z",
				},
			]),
		);
		expect(state.liveTicketLabels()).toEqual([
			{ identity: "github:github.com:I_5", labels: ["needs-work"] },
		]);
		// A ticket that left one source stays live through the other. The
		// newest membership (the inactive one, matching the rank read's
		// rule) still supplies the labels.
		state.applyFetch(sourceB, success([]));
		expect(state.liveTicketLabels()).toEqual([
			{ identity: "github:github.com:I_5", labels: ["needs-work"] },
		]);
		// A ticket that leaves every source is no longer live.
		state.applyFetch(sourceA, success([]));
		expect(state.liveTicketLabels()).toEqual([]);
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
		const db = new Database(path);
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

		// Damage a b-tree page's cell count: the file still opens, but the
		// integrity check must fail on the out-of-range cell pointers. close()
		// folds the WAL into the main file, so the data pages live there.
		const buffer = readFileSync(path);
		const PAGE = 4096;
		let damaged = false;
		for (let page = 1; page * PAGE < buffer.byteLength; page += 1) {
			const type = buffer[page * PAGE];
			if (type === 0x02 || type === 0x05 || type === 0x0a || type === 0x0d) {
				buffer[page * PAGE + 3] = 0x0f;
				buffer[page * PAGE + 4] = 0xff;
				damaged = true;
				break;
			}
		}
		if (!damaged) throw new Error("no b-tree page to damage in the state file");
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

	test("records the model, thinking level, and context window of the settled handoff", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(
			ticket.identity,
			{ ...choice, model: "gpt-5.6", thinking: "high", contextWindow: "272000" },
			"open",
		);
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

		expect(state.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({
				model: "gpt-5.6",
				thinking: "high",
				contextWindow: "272000",
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
		const traceCount = new Database(path)
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

		// The cycle may have changed the source item, so the next handoff
		// waits for the source to re-read the ticket since the close.
		const gated = state.claimHandoff(returned.identity, choice, "open");
		expect(gated.ok).toBe(false);
		if (gated.ok) return;
		expect(gated.reason).toContain("re-read since its last cycle ended");

		// The re-read lands, and the next handoff runs in work cycle 2.
		state.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});
		const second = state.claimHandoff(returned.identity, choice, "open");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		state.settleHandoff(second.claim.attemptId, true);
		const cycles = new Database(path)
			.prepare("SELECT work_cycle FROM handoffs WHERE ticket_identity = ? ORDER BY work_cycle")
			.all(ticket.identity) as Array<{ work_cycle: number }>;
		expect(cycles).toEqual([{ work_cycle: 1 }, { work_cycle: 2 }]);
		state.close();
	});

	test("the re-verification reads the latest end decision against every listing source", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA, sourceB]);
		state.applyFetch(sourceA, success([fetched()]));
		state.applyFetch(sourceB, success([fetched()]));
		const identity = "github:github.com:I_5";
		// A ticket whose cycle has never ended is verified.
		expect(state.sourceReverifiedSinceCycleEnd(identity)).toBe(true);

		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "auto-closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		// The close outlives both sources' last reads: the ticket is not
		// verified, even though both sources still list it and are healthy.
		expect(state.sourceReverifiedSinceCycleEnd(identity)).toBe(false);

		// One source re-reads; the other's listing still stands on the stale
		// fetch, and the ticket is not verified on a mixed view.
		state.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});
		expect(state.sourceReverifiedSinceCycleEnd(identity)).toBe(false);

		// The second source re-reads, and the ticket is verified again.
		state.applyFetch(sourceB, {
			status: "success",
			fetchedAt: "2026-08-31T11:32:00Z",
			tickets: [fetched()],
		});
		expect(state.sourceReverifiedSinceCycleEnd(identity)).toBe(true);
		state.close();
	});

	test("the same-type hold reads the newest cycle end against the suggestion", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// A ticket whose cycle has never ended holds nothing.
		expect(state.sameTypeHoldActive(identity, "implement")).toBe(false);

		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "auto-closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		// The closed cycle completed implement, and the ticket still suggests
		// it: the hold is on.
		expect(state.sameTypeHoldActive(identity, "implement")).toBe(true);
		// The suggestion moved - the label flipped, a new kind of work - and
		// the hold is off.
		expect(state.sameTypeHoldActive(identity, "review")).toBe(false);

		// The hold gates the auto-handoff, not the operator: a manual claim
		// passes it while the hold is on.
		state.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});
		const manual = state.claimHandoff(identity, choice, "open");
		expect(manual.ok).toBe(true);
		if (!manual.ok) return;
		state.settleHandoff(manual.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: manual.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The agent stopped.",
			turnLog: textLog("The agent stopped."),
			completedAt: "2026-08-31T11:35:00Z",
			cause: "aborted",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: manual.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:40:00Z",
		});
		// The newest cycle end is a closed cycle after an aborted turn: the
		// work did not finish, and the hold is off for the same suggestion.
		expect(state.sameTypeHoldActive(identity, "implement")).toBe(false);

		// The newest cycle end wins: a later completed cycle re-arms the
		// hold over the aborted one it outlives.
		state.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:41:00Z",
			tickets: [fetched()],
		});
		const third = state.claimHandoff(identity, choice, "open");
		if (!third.ok) throw new Error(third.reason);
		state.settleHandoff(third.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: third.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done again.",
			turnLog: textLog("Done again."),
			completedAt: "2026-08-31T11:45:00Z",
			cause: "completed",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: third.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:50:00Z",
		});
		expect(state.sameTypeHoldActive(identity, "implement")).toBe(true);

		// An abandon whose turn never settled writes its own row without a
		// cause, and the newest cycle end holds nothing.
		state.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:51:00Z",
			tickets: [fetched()],
		});
		const fourth = state.claimHandoff(identity, choice, "open");
		if (!fourth.ok) throw new Error(fourth.reason);
		state.settleHandoff(fourth.claim.attemptId, true);
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: fourth.claim.attemptId,
			decision: "abandoned",
			decidedAt: "2026-08-31T11:55:00Z",
		});
		expect(state.sameTypeHoldActive(identity, "implement")).toBe(false);
		state.close();
	});

	test("an open claim waits for the source re-read after a cycle end", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		const gated = state.claimHandoff(identity, choice, "open");
		expect(gated.ok).toBe(false);
		if (gated.ok) return;
		expect(gated.reason).toBe(
			"the ticket's source has not been re-read since its last cycle ended; wait for the source refresh",
		);
		// A failed re-read leaves the membership stale: the claim refuses on
		// its own eligibility, and the gate holds either way.
		state.applyFetch(sourceA, { status: "failed", reason: "GitHub rate limit exceeded" });
		expect(state.claimHandoff(identity, choice, "open").ok).toBe(false);
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
		const db = new Database(path);
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
		const tables = new Database(path)
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

		// Downgrade the database to v2: a trace without the turn log column,
		// and none of the tables the later versions create.
		const db = new Database(path);
		db.exec(`
			DROP TABLE consultation_pending_responses;
			DROP TABLE consultation_remaining_resources;
			DROP TABLE consultation_resources;
			DROP TABLE consultation_snapshots;
			DROP TABLE consultation_turns;
			DROP TABLE consultations;
			DROP TABLE checkout_conflict_confirmations;
			DROP TABLE referenced_issues;
			DROP TABLE auto_handoff_mode;
			DROP TABLE work_queue;
		`);
		// The v9 columns belong to the run after this record: a v2 trace never
		// stored a cause, so the v9 step re-adds it.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN turn_log_json").run();
		// A v2 trace carries no model, thinking, or context window: the v7 and
		// v8 columns go with the v6 ones. The consultations table does not
		// exist at this version.
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
		// The v11 override belongs to the run after this record: a v2 ticket
		// never stored a Priority override.
		db.prepare("ALTER TABLE tickets DROP COLUMN priority_override").run();
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

	test("a v5 database migrates to v8: the handoff gains the leftover columns, the trace the settings", () => {
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
		state.close();

		// Downgrade the record to the v5 shape: drop the columns the v6, v7,
		// and v8 migrations add, and rewrite the stored choice without the key
		// the v8 step gives it. A v5 handoff row knows nothing of a leftover or
		// a herdr name, and a v5 trace carries no settings.
		const db = new Database(path);
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
		// The v9 columns belong to the run after this record: a v5 trace never
		// stored a cause, and neither did its consultation turns.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN cause").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN detail").run();
		// The v10 facts belong to the run after this record: a v5 database
		// never stored a checkout's confirmed conflict set, and its
		// Consultation never held the one-shot override column.
		db.prepare(
			"ALTER TABLE consultations ADD COLUMN live_conflict_override INTEGER NOT NULL DEFAULT 0",
		).run();
		db.exec("DROP TABLE checkout_conflict_confirmations;");
		// The v12 facts belong to the run after this record: the issue the
		// control plane read directly has no fact yet.
		db.exec("DROP TABLE referenced_issues;");
		// The v13 mode and the v14 queue belong to the run after this record: a
		// v5 file stored no Auto-handoff mode, and no Work queue.
		db.exec("DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v11 override belongs to the run after this record: a v5 ticket
		// never stored a Priority override.
		db.prepare("ALTER TABLE tickets DROP COLUMN priority_override").run();
		db.prepare("UPDATE schema_version SET version = 5").run();
		db.prepare(
			"UPDATE handoffs SET choice_json = json_remove(choice_json, '$.contextWindow')",
		).run();
		db.close();

		const reopened = openFactoryState(path);
		// The trace survives the two settings steps with their empty defaults:
		// no v5 handoff named a model, a level, or a count.
		expect(reopened.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({
				message: "Done.",
				model: "",
				thinking: "",
				contextWindow: "",
			}),
		);
		// The handoff carries no leftover fact, and its stored choice reads
		// back without the key a v5 row never held.
		expect(reopened.leftoverEnvironment(ticket.identity)).toBe(null);
		const [restored] = reopened.visibleTickets([], "implement");
		expect(restored.handoff).toEqual(
			expect.objectContaining({ model: "", thinking: "", contextWindow: "" }),
		);
		reopened.close();
	});

	test("a v7 database migrates to v8: the trace and a stored choice gain no context window", () => {
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
		state.close();

		// Downgrade the record to the v7 shape: drop the column the v8
		// migration adds, and rewrite a stored choice without the key, which
		// is exactly what a v7 handoff row holds.
		const db = new Database(path);
		db.prepare("ALTER TABLE completion_traces DROP COLUMN context_window").run();
		db.prepare("ALTER TABLE consultations DROP COLUMN context_window").run();
		// The v9 columns belong to the run after this record: a v7 trace never
		// stored a cause, and neither did its consultation turns.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN cause").run();
		db.prepare("ALTER TABLE completion_traces DROP COLUMN detail").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN cause").run();
		db.prepare("ALTER TABLE consultation_turns DROP COLUMN detail").run();
		// The v10 facts belong to the run after this record: a v7 database
		// never stored a checkout's confirmed conflict set, and its
		// Consultation never held the one-shot override column.
		db.prepare(
			"ALTER TABLE consultations ADD COLUMN live_conflict_override INTEGER NOT NULL DEFAULT 0",
		).run();
		db.exec("DROP TABLE checkout_conflict_confirmations;");
		// The v12 facts belong to the run after this record: the issue the
		// control plane read directly has no fact yet.
		db.exec("DROP TABLE referenced_issues;");
		// The v13 mode and the v14 queue belong to the run after this record: a
		// v7 file stored no Auto-handoff mode, and no Work queue.
		db.exec("DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v11 override belongs to the run after this record: a v7 ticket
		// never stored a Priority override.
		db.prepare("ALTER TABLE tickets DROP COLUMN priority_override").run();
		db.prepare("UPDATE schema_version SET version = 7").run();
		db.prepare(
			"UPDATE handoffs SET choice_json = json_remove(choice_json, '$.contextWindow')",
		).run();
		db.close();

		const reopened = openFactoryState(path);
		// The trace survives, and its context window reads as the empty one
		// the migration's default gives it: no v7 handoff named a count.
		expect(reopened.lastCompletion(ticket.identity)).toEqual(
			expect.objectContaining({ message: "Done.", contextWindow: "" }),
		);
		// A choice written before the key existed reads back with it empty, so
		// a Restart of a v7 handoff never carries a count it never chose.
		const [restored] = reopened.visibleTickets([], "implement");
		expect(restored.handoff).toEqual(expect.objectContaining({ contextWindow: "" }));
		reopened.close();
	});

	test("a fresh state file reads the Auto-handoff mode off (ADR 0036)", () => {
		const state = openFactoryState(":memory:");
		expect(state.autoHandoffMode()).toBe(false);
		state.close();
	});

	test("the Auto-handoff mode written to a file reads back on that file's reopen", () => {
		const path = statePath();
		const state = openFactoryState(path);
		expect(state.autoHandoffMode()).toBe(false);
		state.setAutoHandoffMode(true);
		expect(state.autoHandoffMode()).toBe(true);
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.autoHandoffMode()).toBe(true);
		reopened.setAutoHandoffMode(false);
		reopened.close();

		const reread = openFactoryState(path);
		expect(reread.autoHandoffMode()).toBe(false);
		reread.close();
	});

	test("two state files keep separate Auto-handoff modes", () => {
		const first = openFactoryState(statePath());
		const second = openFactoryState(statePath());
		first.setAutoHandoffMode(true);
		expect(first.autoHandoffMode()).toBe(true);
		expect(second.autoHandoffMode()).toBe(false);
		first.close();
		second.close();
	});

	test("a mode write to a state file that is gone reports the file it could not write", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.close();
		expect(() => state.setAutoHandoffMode(true)).toThrow(/Auto-handoff mode at .*state\.sqlite/);
	});

	test("a v12 database migrates to v13: the mode lands off on the existing file", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		state.close();

		// Downgrade the record to the v12 shape: the mode table and the Work
		// queue do not exist yet and the schema cell says twelve, which is
		// exactly what an upgrade from v12 finds.
		const db = new Database(path);
		db.exec("DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		db.prepare("UPDATE schema_version SET version = 12").run();
		db.close();

		const reopened = openFactoryState(path);
		// The migration lands the mode off, and the ticket the v12 file held
		// is untouched.
		expect(reopened.autoHandoffMode()).toBe(false);
		expect(reopened.visibleTickets([], "implement")).toEqual([
			expect.objectContaining({ identity: "github:github.com:I_5" }),
		]);
		reopened.setAutoHandoffMode(true);
		reopened.close();

		const reread = openFactoryState(path);
		expect(reread.autoHandoffMode()).toBe(true);
		reread.close();
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
			const db = new Database(path);
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
		const db = (state as unknown as { db: Database }).db;
		const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
		const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
		expect(journal.journal_mode).toBe("wal");
		expect(foreignKeys.foreign_keys).toBe(1);
		// WAL is a durable database property: a second connection, as the
		// agent's tooling would use, reads the same mode while the state is open.
		const other = new Database(path);
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

	/**
	 * A ticket whose one work cycle ran, settled, and closed. When `list` is
	 * passed, the source is re-read after the close with that list, the way
	 * the app re-reads a ticket's sources when its cycle ends.
	 */
	function closedCycle(
		state: ReturnType<typeof openFactoryState>,
		identity: string,
		handles: { paneId: string; tabId: string; workspaceId: string } = {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		},
		list?: FetchedTicket[],
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
		if (list !== undefined) {
			// The app re-reads the ticket's source when its cycle ends, after the
			// decision's time: the ticket is re-verified, and a later open claim
			// of it passes.
			state.applyFetch(sourceA, {
				status: "success",
				fetchedAt: "2026-08-31T10:04:00Z",
				tickets: list,
			});
		}
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
		// The close's re-read keeps every listed ticket, and clears the gate
		// before the ticket's next cycle claims.
		closedCycle(state, identity, undefined, [fetched("github:github.com:I_6"), fetched()]);
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
		// The close's re-read keeps the ticket listed, and clears the gate
		// before the next cycle claims.
		closedCycle(state, identity, undefined, [fetched()]);
		// A second closed cycle: the ticket now holds two environments, and the
		// collision names the older one by its pane.
		closedCycle(state, identity, undefined, [fetched()]);

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
		// The close's re-read keeps the ticket listed, and clears the gate
		// before the next cycle claims.
		const first = closedCycle(state, identity, undefined, [fetched()]);
		// The second cycle lived in the same workspace on another tab: the
		// shape a reclaimed agent leaves, where one workspace holds the tabs of
		// several cycles (ADR 0011).
		const second = closedCycle(
			state,
			identity,
			{ paneId: "pane-2", tabId: "tab-2", workspaceId: "ws-1" },
			[fetched()],
		);
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

	describe("the turn end cause and the Dispatch pause", () => {
		const t5 = "github:github.com:I_5";
		const t6 = "github:github.com:I_6";
		type State = ReturnType<typeof openFactoryState>;
		function twoTicketState(): State {
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched(t5), fetched(t6)]));
			return state;
		}
		// Hand a ticket out and settle its turn, returning the attempt id.
		function settleCause(
			state: State,
			identity: string,
			cause: "completed" | "failed" | "aborted" | "truncated" | "unknown",
			at: string,
			detail = "",
		): string {
			const claim = state.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true);
			state.settleTurn({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "settled",
				turnLog: textLog("settled"),
				completedAt: at,
				cause,
				detail,
			});
			return claim.claim.attemptId;
		}

		test("a settled turn stores its cause and detail", () => {
			const state = twoTicketState();
			settleCause(state, t5, "failed", "2026-08-31T11:00:00Z", "the context is too large");
			const completion = state.lastCompletion(t5);
			expect(completion?.cause).toBe("failed");
			expect(completion?.detail).toBe("the context is too large");
			state.close();
		});

		test("a settled turn without a cause reads back as unknown, which fails open", () => {
			const state = twoTicketState();
			const claim = state.claimHandoff(t5, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true);
			state.settleTurn({
				ticketIdentity: t5,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "settled",
				turnLog: textLog("settled"),
				completedAt: "2026-08-31T11:00:00Z",
			});
			const completion = state.lastCompletion(t5);
			expect(completion?.cause).toBe("unknown");
			expect(completion?.detail).toBe("");
			expect(state.dispatchPauseActive()).toBe(false);
			state.close();
		});

		test("a re-settle of the same pending turn overwrites its cause and detail", () => {
			const state = twoTicketState();
			const attempt = settleCause(state, t5, "failed", "2026-08-31T11:00:00Z", "first failure");
			state.settleTurn({
				ticketIdentity: t5,
				handoffId: attempt,
				taskType: "implement",
				agentType: "pi",
				message: "recovered",
				turnLog: textLog("recovered"),
				completedAt: "2026-08-31T11:02:00Z",
				cause: "completed",
				detail: "",
			});
			const completion = state.lastCompletion(t5);
			expect(completion?.cause).toBe("completed");
			expect(completion?.message).toBe("recovered");
			expect(state.dispatchPauseActive()).toBe(false);
			state.close();
		});

		test("a legacy trace whose cause cell is NULL reads back as unknown", () => {
			const path = statePath();
			const state = openFactoryState(path);
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched(t5)]));
			const claim = state.claimHandoff(t5, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true);
			state.settleTurn({
				ticketIdentity: t5,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "settled",
				turnLog: textLog("settled"),
				completedAt: "2026-08-31T11:00:00Z",
				cause: "failed",
			});
			state.close();
			// A pre-v9 trace: the cell the v9 step added is NULL, not a cause.
			const db = new Database(path);
			db.prepare("UPDATE completion_traces SET cause = NULL, detail = NULL").run();
			db.close();
			const reopened = openFactoryState(path);
			expect(reopened.lastCompletion(t5)?.cause).toBe("unknown");
			expect(reopened.lastCompletion(t5)?.detail).toBe("");
			expect(reopened.dispatchPauseActive()).toBe(false);
			reopened.close();
		});

		test("a held failed trace pauses dispatch", () => {
			const state = twoTicketState();
			expect(state.dispatchPauseActive()).toBe(false);
			settleCause(state, t5, "failed", "2026-08-31T11:00:00Z");
			expect(state.dispatchPauseActive()).toBe(true);
			state.close();
		});

		test("a completed settle after the held failed ends the pause", () => {
			const state = twoTicketState();
			settleCause(state, t5, "failed", "2026-08-31T11:00:00Z");
			expect(state.dispatchPauseActive()).toBe(true);
			settleCause(state, t6, "completed", "2026-08-31T11:05:00Z");
			expect(state.dispatchPauseActive()).toBe(false);
			state.close();
		});

		test("a held failed settle after a completed one keeps the pause", () => {
			const state = twoTicketState();
			settleCause(state, t5, "completed", "2026-08-31T11:00:00Z");
			expect(state.dispatchPauseActive()).toBe(false);
			settleCause(state, t6, "failed", "2026-08-31T11:05:00Z");
			expect(state.dispatchPauseActive()).toBe(true);
			state.close();
		});

		test("a decision on the held failed trace ends the pause", () => {
			const state = twoTicketState();
			const attempt = settleCause(state, t5, "failed", "2026-08-31T11:00:00Z");
			expect(state.dispatchPauseActive()).toBe(true);
			expect(
				state.applyCompletionDecision({
					ticketIdentity: t5,
					handoffId: attempt,
					decision: "closed",
					decidedAt: "2026-08-31T11:10:00Z",
				}),
			).toBe(true);
			expect(state.dispatchPauseActive()).toBe(false);
			state.close();
		});

		test("only a failed cause pauses: aborted and truncated hold but do not pause", () => {
			const state = twoTicketState();
			settleCause(state, t5, "aborted", "2026-08-31T11:00:00Z");
			expect(state.dispatchPauseActive()).toBe(false);
			settleCause(state, t6, "truncated", "2026-08-31T11:01:00Z");
			expect(state.dispatchPauseActive()).toBe(false);
			state.close();
		});
	});
});

describe("stored completion trace degradation", () => {
	const fallback: TurnLogEntry[] = [
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

describe("the work queue (ADR 0034)", () => {
	const enqueue = (state: ReturnType<typeof openFactoryState>, identity: string) => {
		const result = state.enqueueWork({
			ticketIdentity: identity,
			origin: "open",
			choice,
			previousMessage: "",
		});
		if (!result.ok) throw new Error(result.reason);
	};

	test("items enter in enqueue order, and the queue reports its depth and identities", () => {
		const state = openFactoryState(":memory:");
		expect(state.workQueueDepth()).toBe(0);
		expect(state.hasWorkItem("t1")).toBe(false);
		enqueue(state, "t1");
		enqueue(state, "t2");
		expect(state.workQueueDepth()).toBe(2);
		expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual(["t1", "t2"]);
		expect(state.workQueue().map((item) => item.position)).toEqual([0, 1]);
		expect(state.hasWorkItem("t2")).toBe(true);
	});

	test("a second enqueue for a waiting ticket is refused, and the first keeps its place", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		const refused = state.enqueueWork({
			ticketIdentity: "t1",
			origin: "restart",
			choice,
			previousMessage: "again",
		});
		expect(refused).toEqual({
			ok: false,
			reason: "ticket t1 already has a waiting queue item",
		});
		expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual(["t1"]);
	});

	test("u and d move one place, and an item at an edge moves nowhere", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		enqueue(state, "t2");
		enqueue(state, "t3");
		// The front item cannot move up, the back item cannot move down.
		expect(state.moveWorkItem("t1", "up")).toBe(false);
		expect(state.moveWorkItem("t3", "down")).toBe(false);
		// d takes the front item behind the middle one; the swap is atomic
		// on the queue's primary key, so no step of it shares a position.
		expect(state.moveWorkItem("t1", "down")).toBe(true);
		expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual(["t2", "t1", "t3"]);
		expect(state.moveWorkItem("t1", "up")).toBe(true);
		expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual(["t1", "t2", "t3"]);
		// An unknown identity moves nowhere.
		expect(state.moveWorkItem("t9", "up")).toBe(false);
	});

	test("removing an item keeps the rest in order, and the ticket is free to wait again", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		enqueue(state, "t2");
		expect(state.removeWorkItem("t1")).toBe(true);
		expect(state.removeWorkItem("t1")).toBe(false);
		// The places repack: the surviving item holds the front of the
		// queue, so the queue never shows a place it does not use.
		expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual(["t2"]);
		expect(state.workQueue().map((item) => item.position)).toEqual([0]);
		// The cancelled start may enqueue again for its ticket.
		enqueue(state, "t1");
		expect(state.workQueue().map((item) => item.ticketIdentity)).toEqual(["t2", "t1"]);
	});
});
