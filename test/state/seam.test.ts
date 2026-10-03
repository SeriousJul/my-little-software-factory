/**
 * The seam aggregate's own tests (issue #202): the facts it answers and
 * the operations it runs, read through its interface.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { openStore, StateError } from "../../src/state/store.ts";
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
