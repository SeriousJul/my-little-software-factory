/**
 * The sourceFact aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { SCHEMA_VERSION } from "../../src/state/schema.ts";
import { StateError } from "../../src/state/store.ts";
import { openFactoryState } from "../../src/state.ts";
import {
	choice,
	cleanup,
	downgradeQueueToTheAbandonedShape,
	fetched,
	labeled,
	POSITION_STATES,
	sourceA,
	sourceB,
	statePath,
	success,
	textLog,
} from "./harness.ts";

afterEach(cleanup);

describe("the sourceFact aggregate", () => {
	test("the read names the State it matched, beside the task it suggests", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([labeled(["ready-for-agent"])]));
		expect(state.ticketWorkCycle.visibleTickets(POSITION_STATES, "implement")[0]).toEqual(
			expect.objectContaining({
				suggestedTaskType: "implement",
				matchedStateName: "ready-for-agent",
			}),
		);
		state.close();
	});
	test("a ticket no State matches names no State, and keeps the fallback task", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([labeled(["something-else"])]));
		expect(state.ticketWorkCycle.visibleTickets(POSITION_STATES, "implement")[0]).toEqual(
			expect.objectContaining({ suggestedTaskType: "implement", matchedStateName: null }),
		);
		state.close();
	});
	test("a parking State names itself and suggests no task", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([labeled(["hold"])]));
		expect(state.ticketWorkCycle.visibleTickets(POSITION_STATES, "implement")[0]).toEqual(
			expect.objectContaining({ suggestedTaskType: null, matchedStateName: "on-hold" }),
		);
		state.close();
	});
	test("the name is derived on every read, never stored", () => {
		// The same file, two configs: the State's name follows the machine the
		// operator configured, so no stored row can drift from it.
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([labeled(["hold"])]));
		expect(
			state.ticketWorkCycle.visibleTickets(POSITION_STATES, "implement")[0].matchedStateName,
		).toBe("on-hold");
		state.close();

		const reopened = openFactoryState(path);
		expect(
			reopened.ticketWorkCycle.visibleTickets(
				[{ name: "parked-elsewhere", match: { labelsAny: ["hold"] } }],
				"implement",
			)[0].matchedStateName,
		).toBe("parked-elsewhere");
		reopened.close();
	});
	test("keeps the prior complete snapshot after a source fails and blocks its handoff", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		expect(state.ticketWorkCycle.visibleTickets([], "implement")).toEqual([
			expect.objectContaining({ identity: "github:github.com:I_5", actionable: true }),
		]);

		state.sourceFact.applyFetch(sourceA, {
			status: "failed",
			reason: "GitHub rate limit exceeded",
		});
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(ticket).toEqual(expect.objectContaining({ actionable: false }));
		expect(ticket.memberships?.[0]).toEqual(expect.objectContaining({ health: "stale" }));
		expect(state.handoff.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("not actionable") }),
		);
		state.close();
	});
	test("merges overlapping memberships, lets a healthy source act, and preserves durable handoff state", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA, sourceB]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.sourceFact.applyFetch(sourceB, success([fetched()]));
		state.sourceFact.applyFetch(sourceA, { status: "failed", reason: "network unavailable" });
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(ticket.actionable).toBe(true);
		expect(ticket.memberships).toHaveLength(2);

		const claimed = state.handoff.claimHandoff(ticket.identity, choice, "open");
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		expect(state.handoff.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		state.handoff.settleHandoff(claimed.claim.attemptId, true);
		state.close();

		const reopened = openFactoryState(path);
		const [persisted] = reopened.ticketWorkCycle.visibleTickets([], "implement");
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
	test("settles a claim a dead run left unsettled and frees the ticket to hand off again", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		// The run dies here: the claim stays unsettled.
		state.close();

		const reopened = openFactoryState(path);
		// The remnant blocks a new handoff until the recovery runs.
		expect(reopened.handoff.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		expect(reopened.handoff.recoverUnsettledHandoffs()).toBe(1);
		expect(reopened.handoff.claimHandoff(ticket.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: true }),
		);
		reopened.close();
	});
	test("keeps identity and state when a configured source is renamed", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.sourceFact.initializeSources([sourceB]);
		state.sourceFact.applyFetch(sourceB, success([fetched()]));
		const tickets = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(tickets).toHaveLength(1);
		expect(tickets[0]).toEqual(
			expect.objectContaining({ identity: "github:github.com:I_5", state: "open" }),
		);
		state.close();
	});
	test("retains handed-off work after a source is removed and blocks pending handoff recovery", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const started = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!started.ok) throw new Error(started.reason);
		state.handoff.settleHandoff(started.claim.attemptId, true);
		state.sourceFact.initializeSources([]);
		expect(state.ticketWorkCycle.visibleTickets([], "implement")).toEqual([
			expect.objectContaining({
				state: "handed-off",
				memberships: [expect.objectContaining({ health: "removed" })],
			}),
		]);
		state.close();

		const reopened = openFactoryState(path);
		const [persisted] = reopened.ticketWorkCycle.visibleTickets([], "implement");
		const pending = reopened.handoff.claimHandoff(persisted.identity, choice, "open");
		expect(pending).toEqual(expect.objectContaining({ ok: false }));
		reopened.close();
	});
	test("stops on a damaged database without deleting the data", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
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
	test("a settled turn keeps the agent name after the ticket loses its active membership", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		// The agent closes its own source item before the turn settles: the
		// membership goes stale, but the title still names the agent.
		state.sourceFact.applyFetch(sourceA, success([]));
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "Done.",
			turnLog: textLog("Done."),
			completedAt: "2026-08-31T11:00:00Z",
		});
		const [rested] = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(rested.lastCompletion?.agentName).toBe("persist-source-facts");
		state.close();
	});
	test("a v12 database migrates to v13: the mode lands off on the existing file", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
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
		expect(reopened.handoff.autoHandoffMode()).toBe(false);
		expect(reopened.ticketWorkCycle.visibleTickets([], "implement")).toEqual([
			expect.objectContaining({ identity: "github:github.com:I_5" }),
		]);
		reopened.handoff.setAutoHandoffMode(true);
		reopened.close();

		const reread = openFactoryState(path);
		expect(reread.handoff.autoHandoffMode()).toBe(true);
		reread.close();
	});
	test("a v14 file with the abandoned Work queue shape migrates to v15: the queue reads again", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		if (!ticket) throw new Error("the fixture holds no ticket");
		state.close();

		downgradeQueueToTheAbandonedShape(path);

		// Before the repair this open throws SQLiteError: no such column: position
		// from the Work queue projection, and the app dies while it mounts.
		const reopened = openFactoryState(path);
		expect(reopened.workQueue.items()).toEqual([]);
		expect(
			reopened.workQueue.enqueueWork({
				ticketIdentity: ticket.identity,
				origin: "open",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		expect(reopened.workQueue.items()).toEqual([
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
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
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
		expect(reopened.workQueue.items()).toEqual([]);
		expect(reopened.workQueue.hasWorkItem(ticket.identity)).toBe(false);
		reopened.close();
	});
	test("a v14 file with a sound queue keeps its waiting item", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		if (!ticket) throw new Error("the fixture holds no ticket");
		expect(
			state.workQueue.enqueueWork({
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
		expect(reopened.workQueue.items()).toEqual([
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
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
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
		expect(reopened.workQueue.queuePaused()).toBe(false);
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
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		if (!ticket) throw new Error("the fixture holds no ticket");
		expect(
			state.workQueue.enqueueWork({
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
		expect(reopened.workQueue.items()).toEqual([
			expect.objectContaining({
				position: 0,
				ticketIdentity: ticket.identity,
				routeFromIdentity: null,
			}),
		]);
		expect(
			reopened.workQueue.enqueueWork({
				ticketIdentity: "pr-2",
				routeFromIdentity: "issue-1",
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		expect(reopened.workQueue.items()).toEqual([
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
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.close();

		const db = new Database(path);
		db.exec("ALTER TABLE work_queue DROP COLUMN route_from_identity");
		db.close();

		const reopened = openFactoryState(path);
		expect(
			reopened.workQueue.enqueueWork({
				ticketIdentity: "pr-2",
				routeFromIdentity: "issue-1",
				origin: "workflow",
				choice,
				previousMessage: "the route",
			}),
		).toEqual({ ok: true });
		expect(reopened.workQueue.items()).toEqual([
			expect.objectContaining({ ticketIdentity: "pr-2", routeFromIdentity: "issue-1" }),
		]);
		reopened.close();

		const check = new Database(path, { readonly: true });
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
	});
	test("the heal on open ends the cycle of a ticket the file still holds queued (ADR 0072)", () => {
		// The retired wait stood in the ticket's state before this rule: a file
		// the old rule wrote may still hold a ticket in it. The open heals
		// those cycles the way a close ends one - the ticket rests open with
		// the cycle counted once - in one state write, the way the legacy
		// `done` heal ran. The state is unreachable now, so the step is a no-op
		// on a file the new rule wrote.
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched(), fetched("github:github.com:I_6")]));
		state.close();

		// The file the old rule wrote: the routed ticket stands in the retired
		// wait, beside a ticket that stands open.
		const db = new Database(path);
		db.prepare("UPDATE tickets SET state = 'queued' WHERE identity = ?").run(
			"github:github.com:I_6",
		);
		db.close();

		const reopened = openFactoryState(path);
		// The heal moves the ticket to open with the cycle counted once, the
		// way a close ends the cycle, and the ticket the file held open keeps
		// the cycle it wore.
		expect(reopened.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("open");
		const healed = reopened.ticketWorkCycle
			.visibleTickets([], "implement")
			.find((candidate) => candidate.identity === "github:github.com:I_6");
		expect(healed?.workCycle).toBe(2);
		const resting = reopened.ticketWorkCycle
			.visibleTickets([], "implement")
			.find((candidate) => candidate.identity === "github:github.com:I_5");
		expect(resting?.state).toBe("open");
		expect(resting?.workCycle).toBe(1);
		reopened.close();
	});
	test("keeps an awaiting ticket visible while every source is gone", () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		state.ticketWorkCycle.settleTurn({
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
		state.sourceFact.applyFetch(sourceA, success([]));
		const visible = state.ticketWorkCycle.visibleTickets([], "implement");
		expect(visible).toEqual([
			expect.objectContaining({ identity: ticket.identity, state: "awaiting" }),
		]);

		state.close();
	});
	test("keeps an unresolved handoff attempt blocked after restart", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		const [ticket] = state.ticketWorkCycle.visibleTickets([], "implement");
		const claim = state.handoff.claimHandoff(ticket.identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.close();
		const reopened = openFactoryState(path);
		const [persisted] = reopened.ticketWorkCycle.visibleTickets([], "implement");
		expect(persisted.handoffRecoveryRequired).toBe(true);
		expect(reopened.handoff.claimHandoff(persisted.identity, choice, "open")).toEqual(
			expect.objectContaining({ ok: false, reason: expect.stringContaining("recovery") }),
		);
		reopened.close();
	});
});
