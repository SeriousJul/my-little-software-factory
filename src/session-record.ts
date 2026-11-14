/**
 * The derived session record path on the host that reports none.
 *
 * ADR 0144 (issue #412): herdr-core's terminal record names no session file,
 * so on that host the plane derives the path of the record the Agent's
 * runtime wrote. The per-kind table stands beside the Agent type's other
 * per-kind knowledge (the Model list command map in src/runner.ts), keyed by
 * the same kind, and answers one path or the unavailable answer.
 *
 * A derivation is a lookup in the open, never a guess: it names a path only
 * when the file stands there and one record can be the Agent's. It is picked
 * by the Agent type, the checkout, and the earliest time the record can
 * exist: the host's terminal-creation time when the host reports it, the
 * start time the plane recorded otherwise. The host confirms a run's start
 * only after the record already exists, so the recorded start alone rejects
 * the run's own record on the host that names no record (ADR 0161). Two
 * candidates that both fit, an unreadable session home, or a kind with no
 * derivation all answer unavailable, and the settle takes the capture with
 * one line in the run's record. Unavailable is never `no-turn`: the record's
 * absence says nothing about whether the turn ran, the same fail-open
 * standing as the `unknown` cause (ADR 0017).
 *
 * The herdr host keeps its supplier: a host that names the record is never
 * overruled by the derivation. The derivation stands only for a local Agent:
 * the record is a file on the machine the Agent runs on.
 *
 * The derivation is bounded by construction: one directory read of one
 * session home, never a walk of the home tree, and it runs on the settle
 * path. The plane writes nothing into a runtime's session home and never
 * follows a name it has not seen. A runtime that moves its session home
 * answers unavailable, not a guess: the table is one place for that change.
 */
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The facts the plane already recorded about one Agent run. */
export interface SessionRecordFacts {
	/** The checkout the Agent runs in, or null when the host reports none. */
	readonly checkoutPath: string | null;
	/** The start time the plane recorded for the run, or null when it has none. */
	readonly startedAt: string | null;
	/**
	 * The earliest time the run's record can exist, in ms: the time the host
	 * created the run's terminal, or null when the host reports none. The
	 * record begins after its terminal exists, and the host's clock for that
	 * stands beside the record's stamp: it bounds the record earlier than
	 * the plane's recorded start can, because the host confirms the start
	 * only after the record exists (ADR 0161).
	 */
	readonly notBeforeMs?: number | null;
}

/** Why the derivation could not name the record's path. */
export type SessionRecordReason =
	| "no-derivation"
	| "no-checkout"
	| "no-start"
	| "no-home"
	| "no-candidate"
	| "ambiguous";

/** The derivation's answer: the record's path, or unavailable. */
export type SessionRecordAnswer =
	| { kind: "path"; path: string }
	| { kind: "unavailable"; reason: SessionRecordReason };

/** The lookup the cycle and the Session view consult when the host reports no record. */
export type SessionRecordLookup = (kind: string, facts: SessionRecordFacts) => SessionRecordAnswer;

/**
 * One Agent kind's session record layout: where the runtime keeps its
 * records, how the checkout's directory is named, what a record's file name
 * says, and what the record's header says.
 */
export interface SessionRecordLayout {
	/** The session home, under the user home on the machine the Agent runs on. */
	readonly home: string;
	/** The checkout's directory inside the session home, or null when the checkout cannot be named. */
	checkoutDirectory(checkoutPath: string): string | null;
	/** The start time a record's file name says, in ms, or null when the name says none. */
	startedAtMs(fileName: string): number | null;
	/** What the record's header names, or null when it names no checkout. */
	header(headerLine: string): { cwd: string | null; startedAtMs: number | null } | null;
}

/** pi's session home, under the user home (pi docs, session storage). */
const PI_SESSION_HOME = ".pi/agent/sessions";

/**
 * The pi session directory for one checkout.
 *
 * pi names the directory from the working directory: it drops the leading
 * path separator, replaces `/`, `\`, and `:` with dashes, and wraps the
 * result in dashes, so `/home/me/src` stands as `--home-me-src--`.
 */
function piCheckoutDirectory(checkoutPath: string): string | null {
	const body =
		checkoutPath.startsWith("/") || checkoutPath.startsWith("\\")
			? checkoutPath.slice(1)
			: checkoutPath;
	if (body === "") return null;
	const name = body.replaceAll("/", "-").replaceAll("\\", "-").replaceAll(":", "-");
	if (name === "") return null;
	return `--${name}--`;
}

/**
 * The start time a pi record's file name says.
 *
 * pi names the file `<timestamp>_<session-id>.jsonl`, the timestamp an ISO
 * stamp with the colons and the dot stood for dashes:
 * `2026-11-13T15-47-12-691Z_01a1d597-....jsonl`.
 */
const PI_FILE_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z_.*\.jsonl$/;

function piFileStampMs(fileName: string): number | null {
	const match = PI_FILE_STAMP.exec(fileName);
	if (match === null) return null;
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (month < 1 || month > 12) return null;
	if (day < 1 || day > 31) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	return Date.UTC(
		Number(match[1]),
		month - 1,
		day,
		hour,
		minute,
		second,
		match[7] === undefined ? 0 : Number(match[7]),
	);
}

/** What one pi record's header line says, or null when it says no session. */
function piHeader(headerLine: string): { cwd: string | null; startedAtMs: number | null } | null {
	let record: unknown;
	try {
		record = JSON.parse(headerLine);
	} catch {
		return null;
	}
	if (typeof record !== "object" || record === null) return null;
	const head = record as Record<string, unknown>;
	if (head.type !== "session") return null;
	const cwd = typeof head.cwd === "string" ? head.cwd : null;
	let startedAtMs: number | null = null;
	if (typeof head.timestamp === "string") {
		const parsed = Date.parse(head.timestamp);
		startedAtMs = Number.isNaN(parsed) ? null : parsed;
	}
	return { cwd, startedAtMs };
}

/**
 * The per-kind session record derivation (ADR 0144): one entry per kind whose
 * runtime keeps its records where the plane can read them. A kind outside
 * this table answers unavailable: the table is the one place a runtime that
 * moves its session home changes, and the answer is unavailable, not a guess.
 */
export const SESSION_RECORD_LAYOUTS: Readonly<Record<string, SessionRecordLayout>> = {
	pi: {
		home: PI_SESSION_HOME,
		checkoutDirectory: piCheckoutDirectory,
		startedAtMs: piFileStampMs,
		header: piHeader,
	},
};

/** The lookup the plane runs: the per-kind table under the machine's user home. */
export const realSessionRecordLookup: SessionRecordLookup = (kind, facts) =>
	resolveSessionRecord(kind, facts, homedir());

/** The lookup that answers unavailable for every kind: no derivation stands. */
export const UNAVAILABLE_SESSION_RECORD: SessionRecordLookup = (_kind, _facts) => ({
	kind: "unavailable",
	reason: "no-derivation",
});

/** The first line of one record, or null when the name does not give it. */
function firstLineOf(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const chunk = Buffer.alloc(64 * 1024);
		const parts: string[] = [];
		let readBytes = 0;
		while (readBytes < 1024 * 1024) {
			const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
			if (bytesRead === 0) return null;
			readBytes += bytesRead;
			const text = chunk.subarray(0, bytesRead).toString("utf8");
			const newline = text.indexOf("\n");
			if (newline !== -1) {
				parts.push(text.slice(0, newline));
				return parts.join("");
			}
			parts.push(text);
		}
		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * Whether one named record can be this run's: the stamp stands on or after
 * the earliest time the record can exist, the first line names the session,
 * and the header carries the checkout. That earliest time is the host's
 * terminal-creation time when the host reports one, the recorded start
 * otherwise: the host confirms the start only after the record exists,
 * so the recorded start alone rejects the run's own record (ADR 0161). A
 * name the plane has not seen is never followed.
 */
function canBeThisRun(
	name: string,
	context: {
		recordsDir: string;
		layout: SessionRecordLayout;
		checkoutPath: string;
		notBeforeMs: number;
	},
): boolean {
	const stampMs = context.layout.startedAtMs(name);
	if (stampMs === null || stampMs < context.notBeforeMs) return false; // the record began before this run
	const header = context.layout.header(firstLineOf(join(context.recordsDir, name)) ?? "");
	if (header === null) return false; // the name is not one the plane follows
	if (header.cwd !== context.checkoutPath) return false; // the directory name stands for another checkout
	if (header.startedAtMs !== null && header.startedAtMs < context.notBeforeMs) return false; // the header says the record began before this run
	return true;
}

/**
 * The derived session record path of one Agent run, or why it could not be
 * named.
 *
 * The answer is one path only when the file stands there and one record can
 * be the Agent's: picked by the Agent type's layout, the checkout, and the
 * start time. Everything else answers unavailable: the settle takes the
 * capture, one line in the run's record, and never fails the turn.
 */
export function resolveSessionRecord(
	kind: string,
	facts: SessionRecordFacts,
	home: string = homedir(),
): SessionRecordAnswer {
	const layout = Object.hasOwn(SESSION_RECORD_LAYOUTS, kind)
		? SESSION_RECORD_LAYOUTS[kind]
		: undefined;
	if (layout === undefined) return { kind: "unavailable", reason: "no-derivation" };
	const checkoutPath = facts.checkoutPath;
	if (checkoutPath === null || checkoutPath === "")
		return { kind: "unavailable", reason: "no-checkout" };
	if (facts.startedAt === null) return { kind: "unavailable", reason: "no-start" };
	const startedAtMs = Date.parse(facts.startedAt);
	if (Number.isNaN(startedAtMs)) return { kind: "unavailable", reason: "no-start" };
	const notBeforeMs =
		typeof facts.notBeforeMs === "number" && Number.isFinite(facts.notBeforeMs)
			? facts.notBeforeMs
			: startedAtMs;
	const directory = layout.checkoutDirectory(checkoutPath);
	if (directory === null) return { kind: "unavailable", reason: "no-checkout" };
	const recordsDir = join(home, layout.home, directory);
	let names: string[];
	try {
		// The one directory read: the checkout's directory inside the session
		// home. A home that is missing or unreadable names no record.
		names = readdirSync(recordsDir);
	} catch {
		return { kind: "unavailable", reason: "no-home" };
	}
	const matches: string[] = [];
	for (const name of names) {
		if (canBeThisRun(name, { recordsDir, layout, checkoutPath, notBeforeMs })) {
			matches.push(join(recordsDir, name));
		}
	}
	if (matches.length === 1) return { kind: "path", path: matches[0] };
	if (matches.length > 1) return { kind: "unavailable", reason: "ambiguous" };
	return { kind: "unavailable", reason: "no-candidate" };
}
