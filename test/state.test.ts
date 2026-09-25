import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

import type { TransitionOutcome } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { withIssueReferences } from "../src/domain/ticket.ts";
import {
	type FactoryState,
	openFactoryState,
	SCHEMA_V1,
	SCHEMA_VERSION,
	StateError,
	workQueueIdentityOf,
} from "../src/state.ts";
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

// The States one projection read matches a ticket against: the first match
// wins, a State with no task is a parking State, and no match at all leaves the
// ticket on the fallback task type. The `position` grouping reads the matched
// State's name, which the projection derives on every read and never stores
// (issue #159).
const POSITION_STATES = [
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

describe("the projection's matched Workflow state (issue #159)", () => {
	/** One ticket with the labels the machine reads, listed on one source. */
	function labeled(labels: string[], identity = "github:github.com:I_5"): FetchedTicket {
		return { ...fetched(identity), labels };
	}

	test("the read names the State it matched, beside the task it suggests", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([labeled(["ready-for-agent"])]));
		expect(state.visibleTickets(POSITION_STATES, "implement")[0]).toEqual(
			expect.objectContaining({
				suggestedTaskType: "implement",
				matchedStateName: "ready-for-agent",
			}),
		);
		state.close();
	});

	test("a ticket no State matches names no State, and keeps the fallback task", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([labeled(["something-else"])]));
		expect(state.visibleTickets(POSITION_STATES, "implement")[0]).toEqual(
			expect.objectContaining({ suggestedTaskType: "implement", matchedStateName: null }),
		);
		state.close();
	});

	test("a parking State names itself and suggests no task", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([labeled(["hold"])]));
		expect(state.visibleTickets(POSITION_STATES, "implement")[0]).toEqual(
			expect.objectContaining({ suggestedTaskType: null, matchedStateName: "on-hold" }),
		);
		state.close();
	});

	test("an in-flight ticket keeps its own matched State from the source facts", () => {
		// The Handoff records the task it started with, and the position is
		// still what the labels say: the two facts stand apart, and the
		// grouping reads the State the machine matched now.
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([labeled(["needs-review"])]));
		const [open] = state.visibleTickets(POSITION_STATES, "implement");
		expect(open.matchedStateName).toBe("needs-review");
		const claim = state.claimHandoff(open.identity, { ...choice, taskType: "implement" }, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		const [flight] = state.visibleTickets(POSITION_STATES, "implement");
		expect(flight).toEqual(
			expect.objectContaining({
				state: "handed-off",
				handoff: expect.objectContaining({ taskType: "implement" }),
				matchedStateName: "needs-review",
			}),
		);
		state.close();
	});

	test("the name is derived on every read, never stored", () => {
		// The same file, two configs: the State's name follows the machine the
		// operator configured, so no stored row can drift from it.
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([labeled(["hold"])]));
		expect(state.visibleTickets(POSITION_STATES, "implement")[0].matchedStateName).toBe("on-hold");
		state.close();

		const reopened = openFactoryState(path);
		expect(
			reopened.visibleTickets(
				[{ name: "parked-elsewhere", match: { labelsAny: ["hold"] } }],
				"implement",
			)[0].matchedStateName,
		).toBe("parked-elsewhere");
		reopened.close();
	});

	test("no gate, count, or queue order reads the matched State's name", () => {
		// The field exists for the list's grouping alone. Two machines that
		// differ only in the names they give the same match order the list and
		// the queue identically, and hold the same counts.
		const named = (name: string) => [
			{ name, match: { sourceKind: "github-issue" as const, labelsAny: ["ready-for-agent"] } },
		];
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(
			sourceA,
			success([
				labeled(["ready-for-agent"]),
				{
					...labeled(["ready-for-agent"], "github:github.com:I_9"),
					externalUpdatedAt: "2026-08-30T10:00:00Z",
				},
			]),
		);
		const first = state.visibleTickets(named("one-name"), "implement");
		// The queue holds the first ticket's waiting start, so its order is the
		// operator's, and a name change cannot move it.
		const claimed = state.enqueueWork({
			ticketIdentity: first[0].identity,
			origin: "open",
			choice,
			previousMessage: "",
		});
		if (!claimed.ok) throw new Error(claimed.reason);
		const queueBefore = state.workQueue().map((item) => workQueueIdentityOf(item));
		const second = state.visibleTickets(named("other-name"), "implement");
		expect(second.map((ticket) => ticket.identity)).toEqual(first.map((ticket) => ticket.identity));
		expect(second.map((ticket) => ticket.actionable)).toEqual(
			first.map((ticket) => ticket.actionable),
		);
		expect(state.workQueue().map((item) => workQueueIdentityOf(item))).toEqual(queueBefore);
		expect(state.consultationCounts()).toEqual(state.consultationCounts());
		state.close();
	});
});

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

	test("settles a claim a dead run left unsettled and frees the ticket to hand off again", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		// The run dies here: the claim stays unsettled.
		state.close();

		const reopened = openFactoryState(path);
		// The remnant blocks a new handoff until the recovery runs.
		expect(reopened.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		expect(reopened.recoverUnsettledHandoffs()).toBe(1);
		expect(reopened.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: true }),
		);
		reopened.close();
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

	test("the transition outcome the fire wrote is stored on the trace and reads back", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		const written: TransitionOutcome = {
			fired: true,
			when: "score-above-threshold",
			reason: "",
			ticketFacts: [],
			pullRequestFacts: ["ready-to-ship"],
			autoAdvance: true,
			agent: "codex",
			environment: "worktree",
			ticketWrite: null,
			pullRequestWrite: { added: ["ready-to-ship"], removed: ["ready-for-review"] },
			pullRequestIdentity: ticket.identity,
			pullRequestKey: "#5",
			writeFailure: "",
			positionTaskType: "merge",
			positionTicketIdentity: ticket.identity,
		};
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "- **Score:** 95 / 100",
			turnLog: textLog("- **Score:** 95 / 100"),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
			transition: written,
		});

		// The decision modal and the automatic decision read the facts the
		// plane wrote, not a re-read of the source (ADR 0027).
		expect(state.lastCompletion(ticket.identity)?.transition).toEqual(written);

		// A turn that settled with no fire stores null, and a stored record
		// that no longer parses fails open the same way a broken cause does.
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "second",
			turnLog: textLog("second"),
			completedAt: "2026-08-31T12:00:00Z",
		});
		expect(state.lastCompletion(ticket.identity)?.transition).toBeNull();
		state.close();
	});

	test("the manual re-fire swaps its outcome onto the trace it acted on (ADR 0054)", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		const claim = state.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		const recorded: TransitionOutcome = {
			fired: false,
			when: null,
			reason: "the pull request carries no review score",
			ticketFacts: [],
			pullRequestFacts: ["ready-to-ship"],
			autoAdvance: true,
			agent: undefined,
			environment: undefined,
			ticketWrite: null,
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: null,
			positionTicketIdentity: null,
		};
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "- **Score:** 97 / 100",
			turnLog: textLog("- **Score:** 97 / 100"),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
			transition: recorded,
		});

		// The stored text the swap conditions on is the outcome's own bytes.
		const recordedJson = state.recordedTransitionJson(ticket.identity);
		expect(recordedJson).toBe(JSON.stringify(recorded));

		// The re-fired outcome lands in place of the recorded one.
		const refired: TransitionOutcome = { ...recorded, fired: true, reason: "", writeFailure: "" };
		expect(state.recordRefiredOutcome(ticket.identity, recordedJson ?? "", refired)).toBe(true);
		expect(state.lastCompletion(ticket.identity)?.transition).toEqual(refired);

		// The swap declines once the trace stands on other text: a second
		// re-fire on the moved record, and a trace a new settle moved.
		expect(state.recordRefiredOutcome(ticket.identity, recordedJson ?? "", recorded)).toBe(false);
		expect(state.lastCompletion(ticket.identity)?.transition).toEqual(refired);
		state.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "a later turn",
			turnLog: textLog("a later turn"),
			completedAt: "2026-08-31T12:00:00Z",
		});
		expect(state.recordRefiredOutcome(ticket.identity, recordedJson ?? "", refired)).toBe(false);

		// A ticket whose newest trace records no outcome reads null, and no
		// swap stands on it.
		expect(state.recordedTransitionJson(ticket.identity)).toBeNull();
		expect(state.recordRefiredOutcome(ticket.identity, recordedJson ?? "", refired)).toBe(false);
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

	test("a close on a turn the route decided ends the cycle, and the decision stands", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		if (ticket === undefined) throw new Error("the fixture holds no ticket");
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
		// The route decides the turn when the routed handoff starts...
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(state.visibleTickets([], "implement")[0].state).toBe("awaiting");
		// ...and the operator's close ends the cycle the turn routed from: the
		// recorded decision is not rewritten, and the cycle still ends.
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:30:00Z",
			}),
		).toBe(true);
		const [returned] = state.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		expect(returned.workCycle).toBe(2);
		expect(returned.lastCompletion?.decision).toBe("handed-off");
		// A repeated close changes nothing: the ticket left awaiting, so the
		// cycle number moves exactly once for the one end.
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:31:00Z",
			}),
		).toBe(false);
		expect(state.visibleTickets([], "implement")[0].workCycle).toBe(2);
		state.close();
	});

	test("the automatic close on a decided turn ends the cycle too", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		if (ticket === undefined) throw new Error("the fixture holds no ticket");
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
		// The automatic route at the handoff limit degrades to the close after
		// the auto route has recorded its decision: the end still runs.
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "auto-handed-off",
				decidedAt: "2026-08-31T11:10:00Z",
			}),
		).toBe(true);
		expect(
			state.applyCompletionDecision({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				decision: "auto-closed",
				decidedAt: "2026-08-31T11:30:00Z",
			}),
		).toBe(true);
		const [returned] = state.visibleTickets([], "implement");
		expect(returned.state).toBe("open");
		expect(returned.workCycle).toBe(2);
		expect(returned.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});

	test("an in-flight close ends the cycle and writes no completion trace (ADR 0031)", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true);
		expect(state.ticketState(identity)).toBe("handed-off");

		expect(state.closeWorkCycle(identity)).toBe(true);
		expect(state.ticketState(identity)).toBe("open");
		const [ticket] = state.visibleTickets([], "implement");
		// The cycle the close ended counts like any other cycle end.
		expect(ticket.workCycle).toBe(2);
		expect(ticket.handoffCount).toBe(1);
		// And no completion trace exists: the turn never settled, so the handoff
		// row is the only record the closed cycle leaves.
		expect(state.lastCompletion(identity)).toBe(null);
		state.close();
		const stored = new Database(path)
			.prepare("SELECT COUNT(*) AS count FROM completion_traces")
			.get() as { count: number };
		expect(stored).toEqual({ count: 0 });
	});

	test("an in-flight close moves nothing on an open or awaiting ticket", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// An open ticket holds no work to close.
		expect(state.closeWorkCycle(identity)).toBe(false);
		expect(state.ticketState(identity)).toBe("open");

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
		// A settled turn closes through its decision, not through this move.
		expect(state.closeWorkCycle(identity)).toBe(false);
		expect(state.ticketState(identity)).toBe("awaiting");
		expect(state.visibleTickets([], "implement")[0].workCycle).toBe(1);
		state.close();
	});

	test("only a cycle end moves the work cycle, the fact the gates count on (ADR 0031)", () => {
		// `lastCycleEnd` reads the end row of `work_cycle - 1`, so the two gates
		// name the newest ended cycle exactly. That holds only while nothing else
		// moves the number: a migration or an import path that raised a ticket's
		// `work_cycle` would silently point both gates at the wrong row, and no
		// other check reads this file's SQL. The check is on the statements, so a
		// new move must be a cycle end or must answer here first.
		//
		// The read takes each statement's own quoted text, never the whole line
		// that holds it. A tool that rewrites the source around a literal - the
		// mutation runner's instrumentation wraps an expression in a call, and
		// the suite runs under that instrumented copy - must not change what the
		// file states.
		const statements = [
			...readFileSync("src/state.ts", "utf8").matchAll(
				/"UPDATE tickets SET[^"]*work_cycle[^"]*"/gu,
			),
		].map((match) => match[0]);
		// The ends: the decided close of a settled turn, the in-flight Close
		// that writes no trace, and the close of a turn the route decided -
		// the last runs only from awaiting, so it too moves the number on an
		// end, exactly once.
		expect([...new Set(statements)].sort()).toEqual([
			"\"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ? AND state = 'awaiting'\"",
			"\"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE identity = ?\"",
		]);
		expect(statements.length).toBe(3);
		// A cycle's moves that end nothing hold the number: the handoff that starts
		// a cycle, the running mark, a settled turn, and a reclaimed handoff.
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		const cycleOf = () => state.visibleTickets([], "implement")[0].workCycle;
		expect(cycleOf()).toBe(1);
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			agentName: "agent-one",
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		expect(state.markTicketRunning(identity)).toBe(true);
		expect(cycleOf()).toBe(1);
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
		expect(cycleOf()).toBe(1);
		// A reclaim of the same agent holds the number too: the cycle it lands in
		// is the one it works in.
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		expect(cycleOf()).toBe(2);
		const reclaimed = state.reclaimHandoff(identity, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			// The same agent the handoff started, still under the name it runs.
			agentName: "agent-one",
		});
		expect(reclaimed).not.toBeNull();
		expect(cycleOf()).toBe(2);
		state.close();
	});

	test("the cycle-end gates read an in-flight close as holding nothing (ADR 0031)", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		// Cycle 1: a completed turn, closed by decision. That end arms the
		// re-verify gate and the Same-type hold for the suggestion.
		const first = state.claimHandoff(identity, choice, "open");
		if (!first.ok) throw new Error(first.reason);
		state.settleHandoff(first.claim.attemptId, true);
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:30:00Z",
		});
		expect(state.sourceReverifiedSinceCycleEnd(identity)).toBe(false);
		expect(state.sameTypeHoldActive(identity, "implement")).toBe(true);
		state.applyFetch(sourceA, {
			status: "success",
			fetchedAt: "2026-08-31T11:31:00Z",
			tickets: [fetched()],
		});

		// Cycle 2: the agent never settles, and the operator closes it over key
		// `w`. That end writes no row, so it holds nothing and re-verifies
		// nothing: neither gate falls back to cycle 1's finished turn.
		const second = state.claimHandoff(identity, choice, "open");
		if (!second.ok) throw new Error(second.reason);
		state.settleHandoff(second.claim.attemptId, true);
		expect(state.closeWorkCycle(identity)).toBe(true);
		expect(state.sourceReverifiedSinceCycleEnd(identity)).toBe(true);
		expect(state.sameTypeHoldActive(identity, "implement")).toBe(false);
		// A manual handoff passes both gates either way, and the next cycle
		// starts on the fact the in-flight close left: none.
		const third = state.claimHandoff(identity, choice, "open");
		expect(third.ok).toBe(true);
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
			DROP TABLE queue_pause;
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
		// The v13 fact belongs to the run after this record: a v2 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
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
		// The v13 mode, the v14 queue, and the v19 queue pause belong to the run
		// after this record: a v5 file stored no Auto-handoff mode, no Work
		// queue, and no queue pause.
		db.exec("DROP TABLE queue_pause; DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v13 fact belongs to the run after this record: a v5 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
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
		// The v13 mode, the v14 queue, and the v19 queue pause belong to the run
		// after this record: a v7 file stored no Auto-handoff mode, no Work
		// queue, and no queue pause.
		db.exec("DROP TABLE queue_pause; DROP TABLE auto_handoff_mode; DROP TABLE work_queue;");
		// The v13 fact belongs to the run after this record: a v7 trace never
		// stored the transition outcome.
		db.prepare("ALTER TABLE completion_traces DROP COLUMN transition_json").run();
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

	/** Rewrite the queue's shape to the one the first Work queue migration wrote. */
	function downgradeQueueToTheAbandonedShape(path: string): void {
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

	test("a v14 file with the abandoned Work queue shape migrates to v15: the queue reads again", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		if (!ticket) throw new Error("the fixture holds no ticket");
		state.close();

		downgradeQueueToTheAbandonedShape(path);

		// Before the repair this open throws SQLiteError: no such column: position
		// from the Work queue projection, and the app dies while it mounts.
		const reopened = openFactoryState(path);
		expect(reopened.workQueue()).toEqual([]);
		expect(
			reopened.enqueueWork({
				ticketIdentity: ticket.identity,
				origin: "open",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		expect(reopened.workQueue()).toEqual([
			expect.objectContaining({ position: 0, ticketIdentity: ticket.identity }),
		]);
		reopened.close();

		const db = new Database(path, { readonly: true });
		expect(
			(db.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		db.close();
	});

	test("a v14 file with a stale queue row opens to an empty queue", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		if (!ticket) throw new Error("the fixture holds no ticket");
		state.close();

		downgradeQueueToTheAbandonedShape(path);
		const db = new Database(path);
		db.prepare(
			"INSERT INTO work_queue(id, kind, ticket_identity, origin, choice_json, queue_order, created_at) " +
				"VALUES ('abandoned-1', 'handoff', ?, 'open', '{}', 0, '2026-09-20T10:00:00Z')",
		).run(ticket.identity);
		db.close();

		const reopened = openFactoryState(path);
		// The abandoned row is not readable by the shipped queue: it is dropped,
		// and the operator re-queues the start with the same key.
		expect(reopened.workQueue()).toEqual([]);
		expect(reopened.hasWorkItem(ticket.identity)).toBe(false);
		reopened.close();
	});

	test("a v14 file with a sound queue keeps its waiting item", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		if (!ticket) throw new Error("the fixture holds no ticket");
		expect(
			state.enqueueWork({
				ticketIdentity: ticket.identity,
				origin: "open",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		state.close();

		// A file the shipping migration wrote claims 14 with the sound shape.
		const db = new Database(path);
		db.prepare("UPDATE schema_version SET version = 14").run();
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.workQueue()).toEqual([
			expect.objectContaining({ position: 0, ticketIdentity: ticket.identity }),
		]);
		reopened.close();
	});

	test("a v19 file migrates to v20: the queue pause lands and the retired facts drop", () => {
		// The queue pause's fact stands before the v19 file: the v19 code held
		// no priority or referenced-issues facts of its own, so the file a
		// re-labeled v19 build left behind still carries the retired column and
		// table. The open asks the file, not the stamp.
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		state.close();

		const db = new Database(path);
		db.exec(
			"ALTER TABLE tickets ADD COLUMN priority_override TEXT; CREATE TABLE referenced_issues (id INTEGER PRIMARY KEY);",
		);
		db.prepare("UPDATE schema_version SET version = 19").run();
		db.close();

		const reopened = openFactoryState(path);
		// The pause lands unpaused on the existing file, and the retired
		// facts are gone from the file.
		expect(reopened.queuePaused()).toBe(false);
		const check = new Database(path, { readonly: true });
		const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
			name: string;
		}[];
		const tableNames = tables.map((row) => row.name);
		expect(tableNames).toContain("queue_pause");
		expect(tableNames).not.toContain("referenced_issues");
		const columns = (check.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(
			(row) => row.name,
		);
		expect(columns).not.toContain("priority_override");
		// The stamp stands at the target on the healed file.
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
		reopened.close();
	});

	test("a v17 file migrates to v18: the queue row gains the route's settled ticket", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.visibleTickets([], "implement");
		if (!ticket) throw new Error("the fixture holds no ticket");
		expect(
			state.enqueueWork({
				ticketIdentity: ticket.identity,
				routeFromIdentity: "issue-1",
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		state.close();

		// A file the previous step wrote claims 17 without the column.
		const db = new Database(path);
		db.exec("ALTER TABLE work_queue DROP COLUMN route_from_identity");
		db.prepare("UPDATE schema_version SET version = 17").run();
		db.close();

		const reopened = openFactoryState(path);
		// The row the v17 file waited with reads back with no settled ticket.
		expect(reopened.workQueue()).toEqual([
			expect.objectContaining({
				position: 0,
				ticketIdentity: ticket.identity,
				routeFromIdentity: null,
			}),
		]);
		expect(
			reopened.enqueueWork({
				ticketIdentity: "pr-2",
				routeFromIdentity: "issue-1",
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		expect(reopened.workQueue()).toEqual([
			expect.objectContaining({
				position: 0,
				ticketIdentity: ticket.identity,
				routeFromIdentity: null,
			}),
			expect.objectContaining({
				position: 1,
				ticketIdentity: "pr-2",
				routeFromIdentity: "issue-1",
			}),
		]);
		reopened.close();

		const check = new Database(path, { readonly: true });
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
	});

	test("a file stamped at the target without the column heals on open", () => {
		// The live incident: a build that stamped the file before its migration
		// step ran left a queue the new code cannot read. The stamp alone does
		// not describe the file, so the open asks the file and adds the column
		// instead of trusting the stamp.
		const path = statePath();
		const state = openFactoryState(path);
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		state.close();

		const db = new Database(path);
		db.exec("ALTER TABLE work_queue DROP COLUMN route_from_identity");
		db.close();

		const reopened = openFactoryState(path);
		expect(
			reopened.enqueueWork({
				ticketIdentity: "pr-2",
				routeFromIdentity: "issue-1",
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		expect(reopened.workQueue()).toEqual([
			expect.objectContaining({ ticketIdentity: "pr-2", routeFromIdentity: "issue-1" }),
		]);
		reopened.close();

		const check = new Database(path, { readonly: true });
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
	});

	describe("the queue pause (ADR 0052)", () => {
		test("the write is durable: a fresh open of the same file reads it back", () => {
			const path = statePath();
			const state = openFactoryState(path);
			expect(state.queuePaused()).toBe(false);
			state.setQueuePaused(true);
			expect(state.queuePaused()).toBe(true);
			state.close();

			const reopened = openFactoryState(path);
			expect(reopened.queuePaused()).toBe(true);
			// The pause is the file's own fact: the toggle writes it back off,
			// and a third open reads the off.
			reopened.setQueuePaused(false);
			expect(reopened.queuePaused()).toBe(false);
			reopened.close();
			const third = openFactoryState(path);
			expect(third.queuePaused()).toBe(false);
			third.close();
		});
	});

	describe("the ignored ticket (ADR 0060)", () => {
		test("the flag and its moment are durable factory state on the ticket row", () => {
			const path = statePath();
			const state = openFactoryState(path, () => Date.parse("2026-09-24T10:00:00Z"));
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched()]));
			const [ticket] = state.visibleTickets([], "implement");
			expect(ticket.ignored).toBe(false);
			expect(ticket.ignoredAt).toBeNull();

			expect(state.setTicketIgnored(ticket.identity, true, null)).toEqual({ ok: true });
			expect(state.ignoredTickets().has(ticket.identity)).toBe(true);
			state.close();

			// A second plane on the same file - another operator, or a restart -
			// reads the same answer, and the row's projection carries it.
			const reopened = openFactoryState(path);
			expect(reopened.ignoredTickets().has(ticket.identity)).toBe(true);
			expect(reopened.visibleTickets([], "implement")).toEqual([]);
			expect(reopened.projectedTickets([], "implement")).toEqual([
				expect.objectContaining({
					identity: ticket.identity,
					ignored: true,
					ignoredAt: "2026-09-24T10:00:00.000Z",
				}),
			]);
			// The clear costs the same effort as the set, and the moment leaves
			// with the flag.
			expect(reopened.setTicketIgnored(ticket.identity, false, null)).toEqual({ ok: true });
			expect(reopened.projectedTickets([], "implement")[0]).toEqual(
				expect.objectContaining({ ignored: false, ignoredAt: null }),
			);
			reopened.close();
		});

		test("the flag follows the Ticket across a source that drops it and brings it back", () => {
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched()]));
			const [ticket] = state.visibleTickets([], "implement");
			expect(state.setTicketIgnored(ticket.identity, true, null).ok).toBe(true);
			// The source stops listing the item: the membership goes inactive,
			// and the ticket row stays with its flag.
			state.applyFetch(sourceA, success([]));
			expect(state.ignoredTickets().has(ticket.identity)).toBe(true);
			// The item returns to the source: the same identity reads ignored, and
			// the active view holds it out again.
			state.applyFetch(sourceA, success([fetched()]));
			expect(state.ignoredTickets().has(ticket.identity)).toBe(true);
			expect(state.visibleTickets([], "implement")).toEqual([]);
			expect(state.visibleTickets([], "implement", "ignored").map((row) => row.identity)).toEqual([
				ticket.identity,
			]);
			state.close();
		});

		test("the write refuses a Ticket that owes a decision, in the obligation's words", () => {
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched()]));
			const [ticket] = state.visibleTickets([], "implement");
			// An open ticket owes nothing: the act runs.
			expect(state.setTicketIgnored(ticket.identity, true, null)).toEqual({ ok: true });
			expect(state.setTicketIgnored(ticket.identity, false, null)).toEqual({ ok: true });
			// A settled turn rests on the operator's decision.
			const claim = state.claimHandoff(ticket.identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true);
			state.settleTurn({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "the turn is done",
				turnLog: textLog("the turn is done"),
				completedAt: "2026-08-31T11:00:00Z",
			});
			expect(state.ticketObligation(ticket.identity, null)).toBe("awaiting");
			expect(state.setTicketIgnored(ticket.identity, true, null)).toEqual({
				ok: false,
				reason: "the selected Ticket cannot be ignored: it awaits a decision",
			});
			// A held turn names its own fact.
			state.settleTurn({
				ticketIdentity: ticket.identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "the turn failed",
				turnLog: textLog("the turn failed"),
				completedAt: "2026-08-31T11:05:00Z",
				cause: "failed",
			});
			expect(state.ticketObligation(ticket.identity, null)).toBe("held");
			expect(state.setTicketIgnored(ticket.identity, true, null)).toEqual({
				ok: false,
				reason: "the selected Ticket cannot be ignored: its held turn awaits a decision",
			});
			state.close();
		});

		test("a missing Agent refuses the ignore, and the flag never leaves by itself", () => {
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched()]));
			const [ticket] = state.visibleTickets([], "implement");
			const claim = state.claimHandoff(ticket.identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			// The agent works: no obligation, and the key runs.
			expect(state.setTicketIgnored(ticket.identity, true, null)).toEqual({ ok: true });
			expect(state.setTicketIgnored(ticket.identity, false, null)).toEqual({ ok: true });
			// The poll's marker says the Agent is gone: the write refuses it, and
			// only for the Ticket the marker stands on.
			expect(state.setTicketIgnored(ticket.identity, true, "missing")).toEqual({
				ok: false,
				reason: "the selected Ticket cannot be ignored: its Agent is missing",
			});
			expect(state.setTicketIgnored(ticket.identity, true, "blocked").ok).toBe(true);
			// ADR 0060: nothing but the operator's own key clears the flag. The row's
			// face is what the list rule reads, so a live or awaiting Ticket keeps its
			// row while the flag stands, and a resting one loses it again.
			expect(state.ignoredTickets().has(ticket.identity)).toBe(true);
			expect(state.visibleTickets([], "implement").map((row) => row.identity)).toEqual([
				ticket.identity,
			]);
			state.closeWorkCycle(ticket.identity);
			expect(state.ignoredTickets().has(ticket.identity)).toBe(true);
			expect(state.visibleTickets([], "implement")).toEqual([]);
			// Taking the Ticket back is never refused, and it costs the flag.
			expect(state.setTicketIgnored(ticket.identity, false, "missing")).toEqual({ ok: true });
			expect(state.visibleTickets([], "implement").map((row) => row.identity)).toEqual([
				ticket.identity,
			]);
			state.close();
		});

		/**
		 * ADR 0060: the ignore hides a resting Ticket and never live work or a
		 * decision owed, so no obligation is ever out of the list the counts, the
		 * bell, and the Decision surface read. The pile the `ignored` view shows is
		 * every row the flag stands on.
		 */
		test("the ignore withholds a resting row and reveals a live or awaiting one", () => {
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			const rest = fetched();
			const live = fetched("github:github.com:I_6");
			state.applyFetch(sourceA, success([rest, live]));
			expect(state.setTicketIgnored(rest.identity, true, null).ok).toBe(true);
			const claim = state.claimHandoff(live.identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			expect(state.setTicketIgnored(live.identity, true, null).ok).toBe(true);
			const identities = (filter: "active" | "ignored" | "all") =>
				state.visibleTickets([], "implement", filter).map((ticket) => ticket.identity);
			// The resting row leaves the active view; the live one stays for its work.
			expect(identities("active")).toEqual([live.identity]);
			// The pile names both: the ledger of what the operator put away.
			expect(identities("ignored")).toEqual([live.identity, rest.identity]);
			expect(identities("all")).toEqual([live.identity, rest.identity]);
			// Settle the live turn: awaiting owes a decision, so its row stays in the
			// active view, and the flag still stands on it.
			state.settleTurn({
				ticketIdentity: live.identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "the turn is done",
				turnLog: textLog("the turn is done"),
				completedAt: "2026-08-31T11:00:00Z",
			});
			expect(identities("active")).toEqual([live.identity]);
			expect(state.ticketObligation(live.identity, null)).toBe("awaiting");
			expect(state.ignoredTickets().has(live.identity)).toBe(true);
			// Close its cycle: the Ticket rests, and the same flag takes the row back.
			state.applyCompletionDecision({
				ticketIdentity: live.identity,
				handoffId: claim.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:30:00Z",
			});
			expect(identities("active")).toEqual([]);
			// Both rest, and the pile keeps the list's own order: the attention group,
			// then the newest external update (ADR 0050).
			expect(identities("ignored")).toEqual([rest.identity, live.identity]);
			state.close();
		});

		test("the projection's three filter states hold the covered rule beside them", () => {
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			const issue = fetched();
			const pull = {
				...fetched("github:github.com:P_7"),
				sourceKind: "github-pull-request",
				externalKey: "#7",
				title: "Pull 7",
				attributes: withIssueReferences({}, [
					{ identity: null, number: 5, repository: "acme/factory" },
				]),
			};
			state.applyFetch(sourceA, success([issue, pull]));
			const identities = (filter: "active" | "ignored" | "all") =>
				state.visibleTickets([], "implement", filter).map((ticket) => ticket.identity);
			// The covered issue leaves the active view beside its pull request.
			expect(identities("active")).toEqual(["github:github.com:P_7"]);
			expect(state.setTicketIgnored("github:github.com:P_7", true, null).ok).toBe(true);
			// The ignored view holds the ignored row, the active view holds the
			// rest, and `all` holds both - and the covered issue is in none of
			// them, because the covered rule says nothing about the ignore.
			expect(identities("ignored")).toEqual(["github:github.com:P_7"]);
			expect(identities("all")).toEqual(["github:github.com:P_7"]);
			expect(identities("active")).toEqual([]);
			// The empty active view is the filtered list, not an idle factory:
			// the rows the ignore took away are the pile `f` shows.
			state.close();
		});

		test("the pile holds a Ticket that is both ignored and covered", () => {
			// ADR 0060: the pile is the ledger of what the operator put away, so
			// every row the flag stands on stands in it. The two causes are not
			// symmetric: the covered rule takes a row out of the list, and the
			// ignore is the operator's own act, recorded. A Ticket that is both
			// must stay reachable, because the only key that clears the flag is the
			// one on its row (user story 6).
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			const coveredIssue = fetched();
			const pull = {
				...fetched("github:github.com:P_7"),
				sourceKind: "github-pull-request",
				externalKey: "#7",
				title: "Pull 7",
				attributes: withIssueReferences({}, [
					{ identity: null, number: 5, repository: "acme/factory" },
				]),
			};
			state.applyFetch(sourceA, success([coveredIssue, pull]));
			// Rest first: the issue is covered, so it is out of the list before the
			// operator ever touches it, and a fixing pull request appearing after an
			// ignore reaches the same state by the ordinary refresh path.
			expect(
				state.visibleTickets([], "implement", "active").map((ticket) => ticket.identity),
			).toEqual(["github:github.com:P_7"]);
			expect(state.setTicketIgnored(coveredIssue.identity, true, null).ok).toBe(true);
			const identities = (filter: "active" | "ignored" | "all") =>
				state
					.visibleTickets([], "implement", filter)
					.map((ticket) => ticket.identity)
					.sort();
			// Neither the active view nor the `all` list shows it: the covered rule
			// still holds the list (ADR 0042), and the ignore never reaches it.
			expect(identities("active")).toEqual(["github:github.com:P_7"]);
			expect(identities("all")).toEqual(["github:github.com:P_7"]);
			// The pile shows it, and it stands nowhere else: `f` is the only way to
			// reach the row, and the row is the only place the `i` key runs.
			expect(identities("ignored")).toEqual([coveredIssue.identity]);
			// The gate reads the flag, so the machine holds the Ticket out either way.
			expect(state.ignoredTickets().has(coveredIssue.identity)).toBe(true);
			expect(
				state.ticketListViews([], "implement", "ignored").ignored.map((ticket) => ticket.identity),
			).toEqual(expect.arrayContaining([coveredIssue.identity]));
			expect(state.setTicketIgnored(coveredIssue.identity, false, null).ok).toBe(true);
			expect(identities("ignored")).toEqual([]);
			state.close();
		});

		test("the ignored view keeps the attention bands and the newest-external-update order", () => {
			const state = openFactoryState(":memory:");
			state.initializeSources([sourceA]);
			// Three open Tickets with three external update times: the pile reads
			// by the attention band first and the newest update after, the order
			// the active list holds (ADR 0059's one rule for the ignored view).
			const dated = (identity: string, at: string): FetchedTicket => ({
				...fetched(identity),
				externalUpdatedAt: at,
			});
			state.applyFetch(
				sourceA,
				success([
					dated("github:github.com:I_5", "2026-08-31T09:00:00Z"),
					dated("github:github.com:I_6", "2026-08-31T12:00:00Z"),
					dated("github:github.com:I_7", "2026-08-31T10:00:00Z"),
				]),
			);
			for (const identity of [
				"github:github.com:I_5",
				"github:github.com:I_6",
				"github:github.com:I_7",
			]) {
				expect(state.setTicketIgnored(identity, true, null).ok).toBe(true);
			}
			// I_5 runs an Agent, so it leads the pile; the rest read by the newest
			// external update, exactly as the active list sorts them.
			const running = state.claimHandoff("github:github.com:I_5", choice, "open");
			if (!running.ok) throw new Error(running.reason);
			state.settleHandoff(running.claim.attemptId, true);
			expect(
				state
					.visibleTickets([], "implement", "ignored")
					.map((ticket) => [ticket.identity, ticket.state]),
			).toEqual([
				["github:github.com:I_5", "handed-off"],
				["github:github.com:I_6", "open"],
				["github:github.com:I_7", "open"],
			]);
			state.close();
		});

		test("a v21 file migrates to v22: the flag lands off, and the rows keep their state", () => {
			const path = statePath();
			const state = openFactoryState(path);
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched()]));
			const claim = state.claimHandoff("github:github.com:I_5", choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true);
			state.close();

			// The older file: the stamp at 21, and no flag column at all.
			const db = new Database(path);
			db.exec("ALTER TABLE tickets DROP COLUMN ignored");
			db.exec("ALTER TABLE tickets DROP COLUMN ignored_at");
			db.prepare("UPDATE schema_version SET version = 21").run();
			db.close();

			const reopened = openFactoryState(path);
			expect(reopened.ignoredTickets().has("github:github.com:I_5")).toBe(false);
			expect(reopened.projectedTickets([], "implement")).toEqual([
				expect.objectContaining({ identity: "github:github.com:I_5", ignored: false }),
			]);
			expect(reopened.setTicketIgnored("github:github.com:I_5", true, null).ok).toBe(true);
			reopened.close();

			const check = new Database(path, { readonly: true });
			expect(
				(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
			).toBe(SCHEMA_VERSION);
			check.close();
		});

		test("a file stamped at the target without the column heals on open", () => {
			// The standing rule the queue's own columns carry: ask the file, not
			// the stamp. A build that stamped v22 before its step ran left a file
			// the stamp does not describe, and the missing column is the file's
			// own confession.
			const path = statePath();
			const state = openFactoryState(path);
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched()]));
			state.close();

			const db = new Database(path);
			db.exec("ALTER TABLE tickets DROP COLUMN ignored");
			db.close();

			const reopened = openFactoryState(path);
			expect(reopened.ignoredTickets().has("github:github.com:I_5")).toBe(false);
			expect(reopened.setTicketIgnored("github:github.com:I_5", true, null).ok).toBe(true);
			reopened.close();
		});
	});

	// ADR 0058, issue #159: the Grouping axis is factory state on the state
	// file, the way the Auto-handoff mode and the queue pause are. Which Groups
	// stand folded is not: no table holds a fold, and a restart opens them all.
	describe("the grouping axis (ADR 0058)", () => {
		test("the write is durable: a fresh open of the same file reads it back", () => {
			const path = statePath();
			const state = openFactoryState(path);
			// A fresh state file starts at `none`: no plane comes up grouped
			// before the operator asks (user story 52).
			expect(state.groupingAxis("tickets")).toBe("none");
			state.setGroupingAxis("tickets", "repository");
			expect(state.groupingAxis("tickets")).toBe("repository");
			state.close();

			const reopened = openFactoryState(path);
			expect(reopened.groupingAxis("tickets")).toBe("repository");
			reopened.setGroupingAxis("tickets", "position");
			expect(reopened.groupingAxis("tickets")).toBe("position");
			reopened.close();
			const third = openFactoryState(path);
			expect(third.groupingAxis("tickets")).toBe("position");
			third.close();
		});

		test("the record is keyed by section, not by one section", () => {
			// A second list that takes grouping later writes its own row and
			// needs no new schema version (user story 51). The row the plane
			// writes today stands beside a row it does not know yet, and each
			// reads its own answer.
			const path = statePath();
			const state = openFactoryState(path);
			state.setGroupingAxis("tickets", "task");
			state.close();

			const db = new Database(path);
			db.prepare(
				"INSERT INTO grouping_axis(section, axis) VALUES ('consultations', 'state')",
			).run();
			db.close();

			const reopened = openFactoryState(path);
			expect(reopened.groupingAxis("tickets")).toBe("task");
			const check = new Database(path, { readonly: true });
			expect(
				check.prepare("SELECT section, axis FROM grouping_axis ORDER BY section").all() as {
					section: string;
					axis: string;
				}[],
			).toEqual([
				{ section: "consultations", axis: "state" },
				{ section: "tickets", axis: "task" },
			]);
			check.close();
			reopened.close();
		});

		test("a value the plane does not name reads back as the default", () => {
			// The file is the operator's data, not the plane's code: a hand-edited
			// or future value must open the flat list instead of failing startup.
			const path = statePath();
			const state = openFactoryState(path);
			state.close();
			const db = new Database(path);
			db.prepare("UPDATE grouping_axis SET axis = 'sideways' WHERE section = 'tickets'").run();
			db.close();

			const reopened = openFactoryState(path);
			expect(reopened.groupingAxis("tickets")).toBe("none");
			reopened.close();
		});

		test("a v20 file migrates to v21: the axis lands at its default", () => {
			// Story 57: an upgrade never fails startup over a missing row. The
			// step seeds the default beside the work the file already carried.
			const path = statePath();
			const state = openFactoryState(path);
			state.initializeSources([sourceA]);
			state.applyFetch(sourceA, success([fetched()]));
			state.setGroupingAxis("tickets", "source");
			state.close();

			const db = new Database(path);
			db.exec("DROP TABLE grouping_axis");
			db.prepare("UPDATE schema_version SET version = 20").run();
			db.close();

			const reopened = openFactoryState(path);
			expect(reopened.groupingAxis("tickets")).toBe("none");
			// The work the v20 file held still reads: the migration added a row
			// and moved nothing else.
			expect(reopened.visibleTickets([], "implement")[0].sourceKind).toBe("github-issue");
			const check = new Database(path, { readonly: true });
			expect(
				(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
			).toBe(SCHEMA_VERSION);
			check.close();
			reopened.close();
		});

		test("no fold stands on the state file", () => {
			// ADR 0058 holds the folds in memory: the file gains the axis table
			// and no table that could carry a collapsed Group, so a restart can
			// never bring back a fold that hides a decision the operator owes.
			const path = statePath();
			openFactoryState(path).close();
			const check = new Database(path, { readonly: true });
			const tables = (
				check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
					name: string;
				}[]
			).map((row) => row.name);
			check.close();
			expect(tables).toContain("grouping_axis");
			expect(tables.filter((name) => /fold|collaps/i.test(name))).toEqual([]);
		});
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
			agentName: "persist-source-facts",
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
				agentName: "persist-source-facts",
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
				agentName: "persist-source-facts",
			}),
		).toBe(null);
		// An unresolved attempt blocks the reclaim, exactly as it blocks a handoff.
		closedCycle(state, identity);
		const pending = state.claimHandoff(identity, choice, "open");
		if (!pending.ok) throw new Error(pending.reason);
		expect(
			state.reclaimHandoff(identity, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				agentName: "persist-source-facts",
			}),
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

	test("a reclaim refuses an agent that is not the ticket's own", () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([sourceA]);
		state.applyFetch(sourceA, success([fetched()]));
		const identity = "github:github.com:I_5";
		closedCycle(state, identity);
		// Herdr handed the closed pane's id out again: a different agent works
		// in it now. The reclaim refuses it, and the ticket stays open.
		expect(
			state.reclaimHandoff(identity, {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				agentName: "consultation-01234567",
			}),
		).toBe(null);
		expect(state.ticketsByState(["open"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity }),
		]);
		// The ticket's own agent in the pane is still reclaimed, and the new
		// handoff records its name.
		const claimed = state.reclaimHandoff(identity, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			agentName: "persist-source-facts",
		});
		expect(claimed).toEqual({ attemptId: expect.any(String) });
		const ticket = state.visibleTickets([], "implement").find((t) => t.identity === identity);
		expect(ticket?.handoff?.herdrName).toBe("persist-source-facts");
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

	test("closing twice is not an error", () => {
		const path = statePath();
		// The shutdown signals and the process exit hook both close the state, so
		// a run reaches close() more than once. The second close does nothing
		// rather than reporting a connection it already dropped.
		const state = openFactoryState(path);
		state.acquireLease();
		state.close();
		expect(() => state.close()).not.toThrow();
		// The lease is gone and the file is usable again.
		const next = openFactoryState(path);
		next.acquireLease();
		next.close();
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
		// The depth is the projection's row count, the same number the Work
		// section's header carries: a second count read off the table could
		// disagree with the rows an operator sees when a damaged row drops out.
		expect(state.workQueue()).toHaveLength(0);
		expect(state.hasWorkItem("t1")).toBe(false);
		enqueue(state, "t1");
		enqueue(state, "t2");
		expect(state.workQueue()).toHaveLength(2);
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["t1", "t2"]);
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
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["t1"]);
	});

	test("a route row names the settled ticket it continues, and a same-ticket route names none", () => {
		const state = openFactoryState(":memory:");
		// The route crosses to the position's own ticket: the row holds both
		// identities, where the handoff starts and whose turn it decides.
		expect(
			state.enqueueWork({
				ticketIdentity: "pr-2",
				routeFromIdentity: "issue-1",
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		// A route that stays on its own ticket names no second ticket.
		expect(
			state.enqueueWork({
				ticketIdentity: "issue-3",
				routeFromIdentity: "issue-3",
				origin: "workflow",
				choice,
				previousMessage: "the same-ticket route",
			}),
		).toEqual({ ok: true });
		// A start that is no route names none.
		enqueue(state, "issue-4");
		expect(state.workQueue()).toEqual([
			expect.objectContaining({ ticketIdentity: "pr-2", routeFromIdentity: "issue-1" }),
			expect.objectContaining({ ticketIdentity: "issue-3", routeFromIdentity: null }),
			expect.objectContaining({ ticketIdentity: "issue-4", routeFromIdentity: null }),
		]);
	});

	test("+ and - move one place, and an item at an edge moves nowhere", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		enqueue(state, "t2");
		enqueue(state, "t3");
		// The front item cannot move up, the back item cannot move down.
		expect(state.moveWorkItem("t1", "up")).toBe(false);
		expect(state.moveWorkItem("t3", "down")).toBe(false);
		// `-` takes the front item behind the middle one; the swap is atomic
		// on the queue's primary key, so no step of it shares a position.
		expect(state.moveWorkItem("t1", "down")).toBe(true);
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["t2", "t1", "t3"]);
		expect(state.moveWorkItem("t1", "up")).toBe(true);
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["t1", "t2", "t3"]);
		// An unknown identity moves nowhere.
		expect(state.moveWorkItem("t9", "up")).toBe(false);
	});

	test("the queue and its order survive the state file being closed and reopened", () => {
		// The durability claim of #88 is a file-backed fact: an in-memory
		// database cannot show it, so this walk closes the state and opens the
		// same file again the way the next control-plane run does.
		const path = statePath();
		const state = openFactoryState(path);
		for (const identity of ["t1", "t2", "t3"]) enqueue(state, identity);
		// The operator puts the last ask at the front before the plane closes.
		expect(state.moveWorkItem("t3", "up")).toBe(true);
		expect(state.moveWorkItem("t3", "up")).toBe(true);
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["t3", "t1", "t2"]);
		state.close();

		const reopened = openFactoryState(path);
		const items = reopened.workQueue();
		expect(items.map(workQueueIdentityOf)).toEqual(["t3", "t1", "t2"]);
		expect(items.map((item) => item.position)).toEqual([0, 1, 2]);
		// Every fact the waiting start carried comes back: the origin the pickup
		// re-checks, the choice the operator captured, and the message it routes.
		expect(items[0]).toEqual(
			expect.objectContaining({
				ticketIdentity: "t3",
				origin: "open",
				choice,
				previousMessage: "",
			}),
		);
		expect(reopened.workQueue()).toHaveLength(3);
		expect(reopened.hasWorkItem("t1")).toBe(true);
		// The reopened queue still moves and still answers a cancel.
		expect(reopened.moveWorkItem("t3", "down")).toBe(true);
		expect(reopened.workQueue().map(workQueueIdentityOf)).toEqual(["t1", "t3", "t2"]);
		reopened.close();
	});

	test("removing an item keeps the rest in order, and the ticket is free to wait again", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "t1");
		enqueue(state, "t2");
		expect(state.removeWorkItem("t1")).toBe(true);
		expect(state.removeWorkItem("t1")).toBe(false);
		// The places repack: the surviving item holds the front of the
		// queue, so the queue never shows a place it does not use.
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["t2"]);
		expect(state.workQueue().map((item) => item.position)).toEqual([0]);
		// The cancelled start may enqueue again for its ticket.
		enqueue(state, "t1");
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["t2", "t1"]);
	});
});

describe("the Work queue's Consultation items (ADR 0034, issue #90)", () => {
	const uid = (lead: string) => `${lead.repeat(8)}-1111-4111-8111-111111111111`;
	const repository = {
		identity: "github.com/acme/factory",
		displayName: "acme/factory",
		cloneUrl: "https://github.com/acme/factory.git",
		path: "/tmp/factory",
	};

	/** A `queued` Consultation, born with its Work queue item. */
	function queuedConsultation(state: FactoryState, id: string, createdAt?: string) {
		return state.createConsultation({
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
	const enqueue = (state: FactoryState, identity: string) => {
		const result = state.enqueueWork({
			ticketIdentity: identity,
			origin: "open",
			choice,
			previousMessage: "",
		});
		if (!result.ok) throw new Error(result.reason);
	};

	test("a queued Consultation is born with its queue item, and an opening one without", () => {
		const state = openFactoryState(":memory:");
		const queued = queuedConsultation(state, uid("q"));
		const opening = state.createConsultation({
			id: uid("o"),
			typeName: "grill",
			agentType: "pi",
			environment: "worktree",
			template: "/grill {input}",
			initialInput: "review auth",
			renderedOpeningPrompt: "/grill review auth",
			repository,
			agentName: "consultation-o",
			createdAt: "2026-09-19T23:01:00.000Z",
		});
		expect(queued.state).toBe("queued");
		expect(opening.state).toBe("opening");
		// The record and the pointer commit together: the one item the queue
		// holds is the one the queued record owns.
		expect(state.workQueue()).toHaveLength(1);
		expect(state.workQueue()[0]).toEqual(
			expect.objectContaining({ kind: "consultation", consultationId: queued.id }),
		);
	});

	test("the handoff and Consultation items share one order, and the reorder crosses kinds", () => {
		const state = openFactoryState(":memory:");
		enqueue(state, "github:github.com:I_6");
		const consultation = queuedConsultation(state, uid("q"));
		// The handoff item was enqueued first, so it leads: the Consultation
		// item lands behind it in the same order.
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual([
			"github:github.com:I_6",
			consultation.id,
		]);
		// The reorder crosses kinds: the Consultation item moves ahead of the
		// handoff item, and the swap is the shared order's one rule.
		expect(state.moveWorkItem(consultation.id, "up")).toBe(true);
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual([
			consultation.id,
			"github:github.com:I_6",
		]);
		expect(state.moveWorkItem(consultation.id, "down")).toBe(true);
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual([
			"github:github.com:I_6",
			consultation.id,
		]);
	});

	test("one Consultation item per waiting record: the second add is refused", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		const first = state.workQueue().map(workQueueIdentityOf);
		expect(first).toHaveLength(1);
		expect(state.enqueueConsultationWork(consultation.id)).toEqual({
			ok: false,
			reason: `consultation ${consultation.id} already has a waiting queue item`,
		});
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(first);
	});

	test("a row with no identity or with both identities cannot commit", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.close();
		// The CHECK holds every row to exactly one identity: a row with neither
		// names no start, and one with both is not a row the plane can read, so
		// the constraint keeps either from ever committing.
		const db = new Database(path);
		expect(() =>
			db
				.prepare(
					"INSERT INTO work_queue(position, ticket_identity, consultation_id, origin, choice_json, previous_message, enqueued_at) VALUES (-1, NULL, NULL, NULL, NULL, '', '2026-09-19T23:03:00.000Z')",
				)
				.run(),
		).toThrow();
		expect(() =>
			db
				.prepare(
					"INSERT INTO work_queue(position, ticket_identity, consultation_id, origin, choice_json, previous_message, enqueued_at) VALUES (-2, 'both', 'also-both', 'open', '{}', '', '2026-09-19T23:03:00.000Z')",
				)
				.run(),
		).toThrow();
		db.close();
	});

	test("beginConsultationStart moves a queued record to opening, and nothing else", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		expect(state.beginConsultationStart(consultation.id)).toBe(true);
		expect(state.consultation(consultation.id)?.state).toBe("opening");
		// The claim took the pointer in the same write: the queue is empty, and
		// the move ran once - a second pickup of the same record is refused, so
		// two loops cannot start one Consultation twice.
		expect(state.workQueue()).toHaveLength(0);
		expect(state.beginConsultationStart(consultation.id)).toBe(false);
		expect(state.consultation(consultation.id)?.state).toBe("opening");
		// A record that left the queue's wait before the pickup ran starts
		// nothing.
		const opening = state.createConsultation({
			id: uid("o"),
			typeName: "grill",
			agentType: "pi",
			environment: "worktree",
			template: "/grill {input}",
			initialInput: "review auth",
			renderedOpeningPrompt: "/grill review auth",
			repository,
			agentName: "consultation-o",
			createdAt: "2026-09-19T23:02:00.000Z",
		});
		expect(state.beginConsultationStart(opening.id)).toBe(false);
	});

	test("updateConsultationTypeSettings re-reads the type, and the input never changes", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		expect(
			state.updateConsultationTypeSettings(consultation.id, {
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
			}),
		).toBe(true);
		const updated = state.consultation(consultation.id);
		expect(updated).toEqual(
			expect.objectContaining({
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
				initialInput: "review auth",
				state: "queued",
			}),
		);
	});

	test("updateConsultationTypeSettings touches a queued record only", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		// The record left the wait before the pickup's write reached it: a
		// close or a claim that won the race keeps its settings untouched.
		expect(state.beginConsultationStart(consultation.id)).toBe(true);
		const opening = state.consultation(consultation.id);
		expect(
			state.updateConsultationTypeSettings(consultation.id, {
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
			}),
		).toBe(false);
		expect(state.consultation(consultation.id)).toEqual(opening);
	});

	test("every write that ends a record's wait takes its pointer out of the queue", () => {
		const state = openFactoryState(":memory:");
		const claimed = queuedConsultation(state, uid("a"));
		const closed = queuedConsultation(state, uid("b"));
		const deleted = queuedConsultation(state, uid("c"));
		expect(state.workQueue()).toHaveLength(3);
		// The pickup's seat: the claim and the pointer's removal are one write,
		// so no cycle that dies between them leaves an item behind.
		expect(state.beginConsultationStart(claimed.id)).toBe(true);
		// The close: the operator abandoned the ask, so its item goes with it.
		expect(state.beginConsultationClose(closed.id)).toBe(true);
		state.finishConsultationClose(closed.id);
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual([deleted.id]);
		// The delete of a record whose pointer outlived it takes that pointer
		// too: the queue never lists an item that names no record.
		expect(state.beginConsultationClose(deleted.id)).toBe(true);
		state.finishConsultationClose(deleted.id);
		expect(state.deleteConsultation(deleted.id)).toBe(true);
		expect(state.workQueue()).toHaveLength(0);
	});

	test("removing the queue item unschedules the record, and the other record's item stands across a restart", () => {
		const path = statePath();
		const state = openFactoryState(path);
		const consultation = queuedConsultation(state, uid("q"));
		expect(state.removeConsultationWorkItem(consultation.id)).toBe(true);
		// The item goes, and the still-`queued` record moves to `unscheduled`
		// in the same write: the ask stands behind the pointer it loses, listed
		// in the Consultation section with its type, repository, and input.
		expect(state.consultation(consultation.id)?.state).toBe("unscheduled");
		expect(state.removeConsultationWorkItem(consultation.id)).toBe(false);
		const second = queuedConsultation(state, uid("s"));
		state.close();

		const again = openFactoryState(path);
		expect(again.workQueue()).toHaveLength(1);
		expect(again.workQueue()[0]).toEqual(
			expect.objectContaining({ kind: "consultation", consultationId: second.id }),
		);
		expect(again.consultation(second.id)?.state).toBe("queued");
		expect(again.consultation(consultation.id)?.state).toBe("unscheduled");
		again.close();
	});

	test("a removal through the pickup's seam never unschedules a record that left the wait", () => {
		const state = openFactoryState(":memory:");
		const claimed = queuedConsultation(state, uid("a"));
		// The pickup won the race: the record is opening, so the item removal
		// that follows the answer takes the pointer only and leaves the
		// record's state standing.
		expect(state.beginConsultationStart(claimed.id)).toBe(true);
		expect(state.removeConsultationWorkItem(claimed.id)).toBe(false);
		expect(state.consultation(claimed.id)?.state).toBe("opening");
	});

	test("scheduling an unscheduled Consultation puts it back at the queue's tail", () => {
		const state = openFactoryState(":memory:");
		const waiting = queuedConsultation(state, uid("w"));
		// The record leaves the queue first: the item is gone, the record is
		// unscheduled, and a handoff item holds the front of the queue.
		expect(state.removeConsultationWorkItem(waiting.id)).toBe(true);
		const unscheduled = state.consultation(waiting.id);
		expect(unscheduled?.state).toBe("unscheduled");
		expect(unscheduled).toBeDefined();
		enqueue(state, "github:github.com:I_s");
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual(["github:github.com:I_s"]);
		// The schedule returns the record to `queued` with its item at the
		// tail, behind the handoff item, in one write.
		expect(state.scheduleConsultation(waiting.id)).toEqual({ ok: true });
		expect(state.consultation(waiting.id)?.state).toBe("queued");
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual([
			"github:github.com:I_s",
			waiting.id,
		]);
	});

	test("the schedule reaches an unscheduled record only", () => {
		const state = openFactoryState(":memory:");
		const queued = queuedConsultation(state, uid("q"));
		expect(state.scheduleConsultation(queued.id)).toEqual({
			ok: false,
			reason: `consultation ${queued.id} already has a waiting queue item`,
		});
		expect(state.workQueue().map(workQueueIdentityOf)).toEqual([queued.id]);
		expect(state.consultation(queued.id)?.state).toBe("queued");
		// A record that was never unscheduled has nothing to schedule either.
		expect(state.scheduleConsultation("unknown")).toEqual({
			ok: false,
			reason: "the Consultation is not unscheduled",
		});
		expect(state.workQueue()).toHaveLength(1);
	});

	test("an unscheduled Consultation takes its seat in the atomic start, without a queue item", () => {
		const state = openFactoryState(":memory:");
		const consultation = queuedConsultation(state, uid("q"));
		expect(state.removeConsultationWorkItem(consultation.id)).toBe(true);
		// The start-now over the cap runs the same claim as the pickup: the
		// move to `opening` reaches the `unscheduled` record, and the second
		// start of the same record is refused.
		expect(state.beginConsultationStart(consultation.id)).toBe(true);
		expect(state.consultation(consultation.id)?.state).toBe("opening");
		expect(state.workQueue()).toHaveLength(0);
		expect(state.beginConsultationStart(consultation.id)).toBe(false);
		// The settings re-read reaches the `unscheduled` record the same way.
		const again = queuedConsultation(state, uid("u"));
		expect(state.removeConsultationWorkItem(again.id)).toBe(true);
		expect(
			state.updateConsultationTypeSettings(again.id, {
				agentType: "codex",
				environment: "live-worktree",
				model: "review-model",
				thinking: "low",
				contextWindow: "200000",
				template: "/re-grill {input}",
				renderedOpeningPrompt: "/re-grill review auth",
			}),
		).toBe(true);
	});
});
