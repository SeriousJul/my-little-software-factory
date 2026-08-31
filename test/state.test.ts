import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { FetchedTicket } from "../src/domain/ticket.ts";
import { openFactoryState } from "../src/state.ts";

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
