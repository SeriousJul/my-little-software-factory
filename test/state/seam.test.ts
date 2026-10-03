/**
 * The seam aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { openStore, StateError } from "../../src/state/store.ts";
import { TABLES_OWNED, tablesNamed } from "../../src/state/tables.ts";
import { openFactoryState } from "../../src/state.ts";
import {
	cleanup,
	fallback,
	readStoredLog,
	replaceStoredLog,
	statePath,
	storedTrace,
} from "./harness.ts";

afterEach(cleanup);

describe("the seam aggregate", () => {
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
	test("two state files keep separate Auto-handoff modes", () => {
		const first = openFactoryState(statePath());
		const second = openFactoryState(statePath());
		first.handoff.setAutoHandoffMode(true);
		expect(first.handoff.autoHandoffMode()).toBe(true);
		expect(second.handoff.autoHandoffMode()).toBe(false);
		first.close();
		second.close();
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
		first.lease.acquireLease();
		first.close();

		// A lease owned by another host is never reclaimed by local pid liveness.
		seedLease(process.pid, "other-host");
		const second = openFactoryState(path);
		expect(() => second.lease.acquireLease()).toThrow("already in use");
		second.close();
	});
	test("opens in WAL mode with foreign keys enforced", () => {
		const path = statePath();
		// Read the two pragmas on the live connection the store seam opens.
		const store = openStore(path);
		const db = store.scopeOf("seam test", []);
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
		store.close();
	});
	test("refuses a statement that names a table the aggregate does not own", () => {
		// The boundary the architecture check reads off the source text stands at
		// runtime too (issue #202, ADR 0092): the scoped handle refuses when the
		// statement is prepared, so a statement built from a variable cannot slip
		// past it.
		const store = openStore(statePath());
		const tickets = store.scopeOf("ticketWorkCycle", TABLES_OWNED.ticketWorkCycle);
		// The aggregate's own table prepares, so the refusal is about the table.
		expect(
			tickets.prepare("SELECT identity FROM tickets WHERE identity = ?").get("no-such"),
		).toBeNull();

		let error: unknown;
		try {
			tickets.prepare("SELECT attempt_id FROM handoffs WHERE ticket_identity = ?");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(StateError);
		expect(String(error)).toContain(
			"the ticketWorkCycle aggregate may not reach the table handoffs",
		);
		expect(String(error)).toContain(store.path);

		// Either case: a statement written lower case reaches the same table.
		expect(() => tickets.prepare("select attempt_id from handoffs")).toThrow(
			"may not reach the table handoffs",
		);
		// The refusal stands for a write the handle would run.
		expect(() => tickets.exec("delete from handoffs")).toThrow("may not reach the table handoffs");
		// A join reaches the table on the far side of it.
		expect(() =>
			tickets.prepare(
				"select t.identity from tickets t join memberships m on m.ticket_identity = t.identity",
			),
		).toThrow("may not reach the table memberships");

		// A schema-qualified name is read as its table (issue #202): the refusal
		// names `handoffs`, the table the statement reaches, and not `main`, the
		// schema that holds it.
		expect(() => tickets.prepare("select attempt_id from main.handoffs")).toThrow(
			"may not reach the table handoffs",
		);
		expect(() => tickets.prepare("select identity from main.tickets")).not.toThrow();

		// A name the statement binds for itself is not a table it reaches: a CTE
		// and a subquery alias prepare against the aggregate's own rows.
		expect(() => tickets.prepare("with held as (select 1) select * from held")).not.toThrow();
		expect(() =>
			tickets.prepare("select * from (select identity from tickets) held"),
		).not.toThrow();
		// The reach inside an aliased subquery is still a reach.
		expect(() => tickets.prepare("select * from (select attempt_id from handoffs) held")).toThrow(
			"may not reach the table handoffs",
		);
		// The reach inside a CTE body is still a reach: the matcher reads the CTE's
		// own statement, whatever the CTE is called.
		expect(() =>
			tickets.prepare("with held as (select attempt_id from handoffs) select * from held"),
		).toThrow("may not reach the table handoffs");
		store.close();
	});
	test("a CTE named after a real table is closed by the engine, not by the matcher", () => {
		// The matcher cannot see this shape: every `handoffs` in the statement is a
		// name the statement bound for itself, so `tablesNamed` reports nothing and
		// the scoped handle lets the statement through (issue #202 review). SQLite
		// closes the useful form of it - a CTE that reads the table its own name
		// shadows is a circular reference - so the bypass reaches no rows. The test
		// states which guard holds: the engine, not the matcher.
		const store = openStore(statePath());
		const tickets = store.scopeOf("ticketWorkCycle", TABLES_OWNED.ticketWorkCycle);
		expect(tablesNamed("with handoffs as (select * from handoffs) select * from handoffs")).toEqual(
			[],
		);
		expect(() =>
			tickets.prepare("with handoffs as (select * from handoffs) select * from handoffs"),
		).toThrow("circular reference");
		store.close();
	});
	test("a failed rollback keeps the write's error as the cause", () => {
		// The body ends the file's transaction itself, so the store's own ROLLBACK
		// fails. The error the caller gets names both failures and carries the one
		// that started the rollback as its cause (issue #202 review).
		const store = openStore(statePath());
		const tickets = store.scopeOf("ticketWorkCycle", TABLES_OWNED.ticketWorkCycle);
		let error: unknown;
		try {
			tickets.transaction(() => {
				tickets.exec("rollback");
				throw new Error("the write failed");
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(StateError);
		expect(String(error)).toContain("the write failed");
		expect(String(error)).toContain("the rollback failed too");
		expect(String((error as Error).cause)).toBe("Error: the write failed");
		// The refusal clears the open write, so the file works on.
		expect(tickets.transaction(() => 3)).toBe(3);
		store.close();
	});
	test("holds one write transaction at a time and names the aggregate that asked for a second", () => {
		// The plane's atomic facts span aggregates, so an aggregate opens the
		// transaction and calls the other aggregates inside it. A published
		// operation that opened its own would fail here (issue #202, ADR 0092).
		const store = openStore(statePath());
		const tickets = store.scopeOf("ticketWorkCycle", TABLES_OWNED.ticketWorkCycle);
		expect(tickets.transaction(() => 7)).toBe(7);
		expect(() => tickets.transaction(() => tickets.transaction(() => 1))).toThrow(
			"may not open a transaction while the ticketWorkCycle aggregate holds one",
		);
		// The refusal rolls the open write back and clears it, so the file works on.
		expect(tickets.transaction(() => 8)).toBe(8);
		store.close();
	});
	test("permits only one live lease for a database", () => {
		const path = statePath();
		const first = openFactoryState(path);
		const second = openFactoryState(path);
		first.lease.acquireLease();
		expect(() => second.lease.acquireLease()).toThrow("already in use");
		first.close();
		second.lease.acquireLease();
		second.close();
	});
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
});
