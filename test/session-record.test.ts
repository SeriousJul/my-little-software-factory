/**
 * The derived session record path on the host that reports none
 * (ADR 0144, issue #412): the per-kind table's lookup, the pi layout it
 * carries, and its unavailable answers.
 *
 * The fixture session homes stand in for the operator's: no test reads the
 * real session home. One test measures the derivation against the facts of
 * one real pi session, and the record names what that measurement covers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveSessionRecord,
	SESSION_RECORD_LAYOUTS,
	type SessionRecordFacts,
	UNAVAILABLE_SESSION_RECORD,
} from "../src/session-record.ts";

/** The checkout the fixture records stand under. */
const CHECKOUT = "/home/me/src/app";
/** The run's start time, the plane's own stamp. */
const STARTED_AT = "2026-11-13T15:47:12.691Z";
/** The stamp a record that began with the run carries in its name. */
const STAMP = "2026-11-13T15-47-12-691Z";
const RECORD_ID = "01a1d597-6ab3-70b0-a6d6-43ad8c68eeb8";

const homes: string[] = [];

/** One fixture session home, cleaned up with the suite. */
function fixtureHome(): string {
	const home = mkdtempSync(join(tmpdir(), "session-record-"));
	homes.push(home);
	return home;
}

afterAll(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/**
 * One pi session record under the fixture home: pi's checkout directory for
 * the checkout, the name the runtime gave the record, and the header pi
 * wrote it with.
 */
function putRecord(
	home: string,
	checkout: string,
	stamp: string,
	header: Record<string, unknown>,
): string {
	const directory = SESSION_RECORD_LAYOUTS.pi.checkoutDirectory(checkout);
	if (directory === null) throw new Error("the fixture checkout names no directory");
	const recordsDir = join(home, ".pi", "agent", "sessions", directory);
	mkdirSync(recordsDir, { recursive: true });
	const id = typeof header.id === "string" ? header.id : RECORD_ID;
	const path = join(recordsDir, `${stamp}_${id}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ type: "session", ...header })}\n`, "utf8");
	return path;
}

/** The header a record of this run carries: the checkout and the run's start. */
function headerOf(
	checkout: string,
	timestamp: string,
	id: string = RECORD_ID,
): Record<string, unknown> {
	return { id, cwd: checkout, timestamp };
}

/** The facts of the run the derivation picks by. */
function facts(overrides: Partial<SessionRecordFacts> = {}): SessionRecordFacts {
	return { checkoutPath: CHECKOUT, startedAt: STARTED_AT, ...overrides };
}

describe("the pi session home layout", () => {
	test("the checkout directory stands for the checkout under dashes", () => {
		const directory = SESSION_RECORD_LAYOUTS.pi.checkoutDirectory;
		expect(directory("/home/me/src/app")).toBe("--home-me-src-app--");
		expect(directory("/a/b/c:d")).toBe("--a-b-c-d--");
		expect(directory("relative/path")).toBe("--relative-path--");
		// The empty checkout names no directory: the answer is unavailable.
		expect(directory("")).toBeNull();
	});

	test("the record's name says its start time", () => {
		const startedAtMs = SESSION_RECORD_LAYOUTS.pi.startedAtMs;
		expect(startedAtMs(`${STAMP}_${RECORD_ID}.jsonl`)).toBe(Date.parse(STARTED_AT));
		// A name without the millisecond stands for the whole second.
		expect(startedAtMs("2026-11-13T15-47-12Z_abc.jsonl")).toBe(Date.parse("2026-11-13T15:47:12Z"));
		// A name that says no stamp is not a record the plane follows.
		expect(startedAtMs("session.jsonl")).toBeNull();
		// A stamp that is not a time says none.
		expect(startedAtMs("2026-13-01T00-00-00Z_abc.jsonl")).toBeNull();
	});

	test("the record's header says its checkout and its start", () => {
		const layout = SESSION_RECORD_LAYOUTS.pi;
		const header = layout.header(
			JSON.stringify({ type: "session", cwd: CHECKOUT, timestamp: STARTED_AT }),
		);
		expect(header).toEqual({ cwd: CHECKOUT, startedAtMs: Date.parse(STARTED_AT) });
		// A header that is not a session names no record.
		expect(layout.header(JSON.stringify({ type: "message", cwd: CHECKOUT }))).toBeNull();
		// A line that is not JSON names no record.
		expect(layout.header("not json")).toBeNull();
		// A session header without a timestamp says no start: the name's stamp
		// stands alone.
		expect(layout.header(JSON.stringify({ type: "session", cwd: CHECKOUT }))).toEqual({
			cwd: CHECKOUT,
			startedAtMs: null,
		});
	});
});

describe("the per-kind table", () => {
	test("pi stands, and no other kind does", () => {
		expect(Object.keys(SESSION_RECORD_LAYOUTS).sort()).toEqual(["pi"]);
	});

	test("a kind outside the table answers no-derivation", () => {
		expect(resolveSessionRecord("codex", facts(), fixtureHome())).toEqual({
			kind: "unavailable",
			reason: "no-derivation",
		});
	});

	test("the unavailable lookup answers no-derivation for every kind", () => {
		for (const kind of ["pi", "codex", "claude", ""])
			expect(UNAVAILABLE_SESSION_RECORD(kind, facts())).toEqual({
				kind: "unavailable",
				reason: "no-derivation",
			});
	});
});

describe("the derivation", () => {
	test("names the record the runtime began for this run", () => {
		const home = fixtureHome();
		const path = putRecord(home, CHECKOUT, STAMP, headerOf(CHECKOUT, STARTED_AT));
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({ kind: "path", path });
	});

	test("the same-millisecond record names: the runtime opens the file after the start is recorded", () => {
		const home = fixtureHome();
		const path = putRecord(home, CHECKOUT, STAMP, headerOf(CHECKOUT, STARTED_AT));
		// The record began at the very stamp the plane recorded: it fits.
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({ kind: "path", path });
	});

	test("a record that began before the run names no path", () => {
		const home = fixtureHome();
		putRecord(
			home,
			CHECKOUT,
			"2026-11-13T15-47-12-000Z",
			headerOf(CHECKOUT, "2026-11-13T15:47:12.000Z"),
		);
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "no-candidate",
		});
	});

	test("a record whose name fits but whose header began before the run names no path", () => {
		const home = fixtureHome();
		// The name says the run's stamp; the header says the record began
		// before the run: the header is the record's own word.
		putRecord(home, CHECKOUT, STAMP, headerOf(CHECKOUT, "2026-11-13T15:47:12.000Z"));
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "no-candidate",
		});
	});

	test("a record of another checkout names no path", () => {
		const home = fixtureHome();
		// The record stands in this checkout's directory, but its header
		// names another checkout: pi can carry such a record, and the
		// header is the checkout's own word.
		putRecord(home, CHECKOUT, STAMP, headerOf("/home/me/src/other", STARTED_AT));
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "no-candidate",
		});
	});

	test("two records that both fit answer ambiguous", () => {
		// The first-class answer (issue #412): two candidate records of this
		// checkout that both fit refuse the path rather than guess, and the
		// settle takes the capture. Two records pi itself can open in one
		// run: the record the runtime began, and a fork's record beside it.
		const home = fixtureHome();
		putRecord(home, CHECKOUT, STAMP, headerOf(CHECKOUT, STARTED_AT));
		putRecord(
			home,
			CHECKOUT,
			"2026-11-13T15-47-13-000Z",
			headerOf(CHECKOUT, "2026-11-13T15:47:13.000Z", "01a1d598-6ab3-70b0-a6d6-43ad8c68eeb9"),
		);
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "ambiguous",
		});
	});

	test("a home without the checkout's directory names no path", () => {
		expect(resolveSessionRecord("pi", facts(), fixtureHome())).toEqual({
			kind: "unavailable",
			reason: "no-home",
		});
	});

	test("a session home that is a file names no path", () => {
		const home = fixtureHome();
		// The session home's place is a file: the one directory read fails.
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "sessions"), "not a directory", "utf8");
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "no-home",
		});
	});

	test("a run without a checkout answers no-checkout", () => {
		expect(resolveSessionRecord("pi", facts({ checkoutPath: null }), fixtureHome())).toEqual({
			kind: "unavailable",
			reason: "no-checkout",
		});
		expect(resolveSessionRecord("pi", facts({ checkoutPath: "" }), fixtureHome())).toEqual({
			kind: "unavailable",
			reason: "no-checkout",
		});
	});

	test("a run without a start time answers no-start", () => {
		expect(resolveSessionRecord("pi", facts({ startedAt: null }), fixtureHome())).toEqual({
			kind: "unavailable",
			reason: "no-start",
		});
		expect(resolveSessionRecord("pi", facts({ startedAt: "not a time" }), fixtureHome())).toEqual({
			kind: "unavailable",
			reason: "no-start",
		});
	});

	test("a name the stamp cannot read names no path", () => {
		const home = fixtureHome();
		const directory = SESSION_RECORD_LAYOUTS.pi.checkoutDirectory(CHECKOUT);
		if (directory === null) throw new Error("the fixture checkout names no directory");
		const recordsDir = join(home, ".pi", "agent", "sessions", directory);
		mkdirSync(recordsDir, { recursive: true });
		writeFileSync(
			join(recordsDir, "session.jsonl"),
			`${JSON.stringify({ type: "session", ...headerOf(CHECKOUT, STARTED_AT) })}\n`,
			"utf8",
		);
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "no-candidate",
		});
	});

	test("a header that is not a session names no path", () => {
		const home = fixtureHome();
		const directory = SESSION_RECORD_LAYOUTS.pi.checkoutDirectory(CHECKOUT);
		if (directory === null) throw new Error("the fixture checkout names no directory");
		const recordsDir = join(home, ".pi", "agent", "sessions", directory);
		mkdirSync(recordsDir, { recursive: true });
		writeFileSync(
			join(recordsDir, `${STAMP}_${RECORD_ID}.jsonl`),
			`${JSON.stringify({ type: "message", cwd: CHECKOUT })}\n`,
			"utf8",
		);
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "no-candidate",
		});
	});

	test("a record whose first line is not JSON names no path", () => {
		const home = fixtureHome();
		const directory = SESSION_RECORD_LAYOUTS.pi.checkoutDirectory(CHECKOUT);
		if (directory === null) throw new Error("the fixture checkout names no directory");
		const recordsDir = join(home, ".pi", "agent", "sessions", directory);
		mkdirSync(recordsDir, { recursive: true });
		writeFileSync(join(recordsDir, `${STAMP}_${RECORD_ID}.jsonl`), "not json\n", "utf8");
		expect(resolveSessionRecord("pi", facts(), home)).toEqual({
			kind: "unavailable",
			reason: "no-candidate",
		});
	});
});

describe("the real-runtime measurement", () => {
	test("the pi session the herdr-core host measured derives", () => {
		// The measured stand (docs/verification/agent-host-herdr-core.md):
		// the checkout of this very ticket, the pi session its first Agent
		// opened for it, and the record the runtime named. The fixture home
		// stands in for the operator's session home, and the facts are the
		// measured ones: the directory name the runtime gave the checkout,
		// the name it gave the record, and the header the record carries.
		//
		// What the measurement covers: the pi session home layout, the
		// checkout's directory name, the record's file name, and its header,
		// as pi 1.5.2 writes them on this machine. What it does not cover:
		// a session a herdr-core-launched Agent opens, the run whose start
		// time the plane recorded, and any runtime but pi.
		const checkout =
			"/home/seriousjul/.herdr/worktrees/my-little-software-factory/factory-412-the-derived-agent-session-record-path-on-the-herdr-core-host";
		const home = fixtureHome();
		const path = putRecord(home, checkout, STAMP, headerOf(checkout, STARTED_AT));
		const answer = resolveSessionRecord(
			"pi",
			{ checkoutPath: checkout, startedAt: STARTED_AT },
			home,
		);
		expect(answer).toEqual({ kind: "path", path });
		expect(path).toBe(
			join(
				home,
				".pi",
				"agent",
				"sessions",
				"--home-seriousjul-.herdr-worktrees-my-little-software-factory-factory-412-the-derived-agent-session-record-path-on-the-herdr-core-host--",
				`${STAMP}_${RECORD_ID}.jsonl`,
			),
		);
	});
});
