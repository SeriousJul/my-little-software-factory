import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import type { FetchedTicket } from "../src/domain/ticket.ts";
import { openFactoryState, StateError } from "../src/state.ts";

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
		expect(state.claimHandoff(ticket.identity, choice)).toEqual(
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

		const claimed = state.claimHandoff(ticket.identity, choice);
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		expect(state.claimHandoff(ticket.identity, choice)).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		state.settleHandoff(claimed.claim.attemptId, true);
		state.close();

		const reopened = openFactoryState(path);
		const [persisted] = reopened.visibleTickets([], "implement");
		expect(persisted).toEqual(
			expect.objectContaining({
				state: "handed-off",
				handoff: { agentType: "pi", environment: "worktree", taskType: "implement" },
			}),
		);
		reopened.close();
	});

	test("settles a normal failed handoff so an operator can retry", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const first = state.claimHandoff(ticket.identity, choice);
		if (!first.ok) throw new Error(first.reason);
		state.settleHandoff(first.claim.attemptId, false, "herdr is unavailable");
		expect(state.claimHandoff(ticket.identity, choice)).toEqual(
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
		const started = state.claimHandoff(ticket.identity, choice);
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
		const pending = reopened.claimHandoff(persisted.identity, choice);
		expect(pending).toEqual(expect.objectContaining({ ok: false }));
		reopened.close();
	});

	test("stops with a readable error for a database from a newer schema version", () => {
		const path = statePath();
		const db = new DatabaseSync(path);
		db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
		db.prepare("INSERT INTO schema_version(version) VALUES (2)").run();
		db.close();

		let error: unknown;
		try {
			openFactoryState(path);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(StateError);
		expect(String(error)).toContain("newer schema version 2");
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

	test("starts a new work cycle only when a done ticket leaves every source and returns", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));

		// No agent API exists to finish a ticket yet, so the completion is
		// recorded the way the agent will record it: a state row update.
		const markDone = () => {
			const db = new DatabaseSync(path);
			db.prepare("UPDATE tickets SET state = 'done' WHERE identity = ?").run(
				"github:github.com:I_5",
			);
			db.close();
		};
		const workCycle = () => {
			const db = new DatabaseSync(path);
			const row = db
				.prepare("SELECT state, work_cycle FROM tickets WHERE identity = ?")
				.get("github:github.com:I_5") as { state: string; work_cycle: number };
			db.close();
			return row;
		};

		markDone();
		// A continuously matching done ticket stays done in the same work cycle.
		state.applyFetch(sourceA, success([fetched()]));
		expect(workCycle()).toEqual({ state: "done", work_cycle: 1 });

		// The ticket leaves every source and later returns: a new work cycle starts.
		state.applyFetch(sourceA, success([]));
		state.applyFetch(sourceA, success([fetched()]));
		expect(workCycle()).toEqual({ state: "open", work_cycle: 2 });

		state.close();
	});

	test("keeps prior work cycles and their handoffs in history", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [first] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(first.identity, choice);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);

		// The cycle completes, the ticket leaves every source and returns.
		const db = new DatabaseSync(path);
		db.prepare("UPDATE tickets SET state = 'done' WHERE identity = ?").run(first.identity);
		db.close();
		state.applyFetch(sourceA, success([]));
		state.applyFetch(sourceA, success([fetched()]));
		const [second] = state.visibleTickets([], "implement");
		const secondClaim = state.claimHandoff(second.identity, choice);
		if (!secondClaim.ok) throw new Error(secondClaim.reason);
		state.settleHandoff(secondClaim.claim.attemptId, true);

		const history = new DatabaseSync(path)
			.prepare("SELECT work_cycle FROM handoffs WHERE ticket_identity = ? ORDER BY work_cycle")
			.all(first.identity) as Array<{ work_cycle: number }>;
		expect(history).toEqual([{ work_cycle: 1 }, { work_cycle: 2 }]);

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

	test("keeps an unresolved handoff attempt blocked after restart", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice);
		if (!claim.ok) throw new Error(claim.reason);
		state.close();
		const reopened = openFactoryState(path);
		const [persisted] = reopened.visibleTickets([], "implement");
		expect(persisted.handoffRecoveryRequired).toBe(true);
		expect(reopened.claimHandoff(persisted.identity, choice)).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		reopened.close();
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
