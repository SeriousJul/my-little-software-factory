/**
 * The state-backed app fixture: a real temporary SQLite state, a fake ticket
 * source, and the source config the frame suites share.
 *
 * Every app that boots against this fixture settles its fetches itself: no
 * test in the suite can race a source clock through it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import { sleep } from "./app-harness.ts";
import type { FakeSource } from "./fake-source.ts";

const paths: string[] = [];

/** Open a fresh state database, registered for cleanup by `cleanupStateFixtures`. */
export function freshState(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-fixture-state-"));
	paths.push(dir);
	return openFactoryState(join(dir, "state.sqlite"));
}

/** Remove every state directory opened by `freshState`. */
export function cleanupStateFixtures(): void {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
}

/** The config with one issue source named `issues`. */
export const issuesConfig: FactoryConfig = {
	...DEFAULT_CONFIG,
	sources: [
		{
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
};

/** One fetched issue on the shared sample repository. */
export function issueTicket(
	identity = "github:github.com:I_5",
	over: Partial<FetchedTicket> = {},
): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/5",
		title: "Add a webhook retry policy",
		description: "Webhooks dropped during the outage were never redelivered.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

export const success = (tickets: FetchedTicket[]): FetchOutcome => ({
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets,
});

export const RATE_LIMITED: FetchOutcome = {
	status: "failed",
	reason: "GitHub rate limit exceeded",
};

/**
 * Move the fixture Ticket through a clean Handoff and store its herdr handles.
 *
 * The row is in flight with a Pane behind it, which is what the missing modal
 * answers to once the observation finds no Agent in that Pane. The caller owns
 * the state and closes it.
 */
export function seedInFlightTurn(
	state: FactoryState,
	outcome: FetchOutcome,
	identity = "github:github.com:I_5",
): string {
	const source = { name: "issues", kind: "github-issues" };
	state.initializeSources([source]);
	state.applyFetch(source, outcome);
	const claim = state.claimHandoff(
		identity,
		{
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			model: "",
			thinking: "",
		},
		"open",
	);
	if (!claim.ok) throw new Error(claim.reason);
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	return claim.claim.attemptId;
}

/**
 * Move the fixture Ticket through a clean Handoff and a settled turn.
 *
 * The row ends awaiting its decision with the herdr handles stored, which is
 * what the decision modal and the observation loop read.
 */
export function seedAwaitingTurn(
	state: FactoryState,
	outcome: FetchOutcome,
	identity = "github:github.com:I_5",
): string {
	const attemptId = seedInFlightTurn(state, outcome, identity);
	state.settleTurn({
		ticketIdentity: identity,
		handoffId: attemptId,
		taskType: "implement",
		agentType: "pi",
		message: "The turn is done.",
		turnLog: [{ kind: "text", text: "The turn is done." }],
		completedAt: "2026-08-31T11:00:00Z",
	});
	return attemptId;
}

/**
 * Wait until the source has started its `calls`-th fetch.
 *
 * A key press is dispatched on the next frame, so a test must not settle
 * before the refresh it started has actually called the source: an early
 * settle has no in-flight fetch to resolve and the refresh hangs forever.
 */
export async function callsReached(source: FakeSource, calls: number): Promise<void> {
	const deadline = Date.now() + 2000;
	for (;;) {
		if (source.calls >= calls) return;
		if (Date.now() >= deadline)
			throw new Error(`the source was called ${source.calls} times, wanted ${calls}`);
		await sleep(5);
	}
}
