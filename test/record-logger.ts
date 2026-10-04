/**
 * The shared fake logger the suite reads the plane's record lines back from.
 *
 * The plane's file logger is the seam every record line leaves through: a
 * `handoff started:` line, a `merge started:` line, a `consultation started:`
 * line, a queue line, and a refusal with its reason. A test that reads those
 * lines hands this double to the module's `log` seam and asserts against the
 * array it fills.
 *
 * Three suites needed it (issue #209, issue #220), and one copy per suite is
 * how a fake drifts from the seam it stands for, so the copy lives here.
 *
 * Each entry carries the level its line left through. The configuration
 * reference states a level for every record line - the hold lines, the mode
 * lines, and the queue lines are `info`, a refusal is `warn`, and so is the
 * session-only mode line - and `level = "warn"` keeps the refusals and drops
 * the holds. A fake that throws the level away cannot hold that claim: a start
 * line moved from `info` to `warn` would keep the suite green and make the
 * documented filter wrong (issue #223 review).
 */

import type { Logger } from "../src/logging.ts";

/** The two levels the plane's record lines leave through. */
export type RecordedLevel = "info" | "warn";

/** One line the plane wrote, with the level it left through. */
export interface RecordedLine {
	readonly level: RecordedLevel;
	readonly message: string;
}

/** A Logger that appends every `info` and `warn` line, with its level, to `lines`. */
export function recordLogger(lines: RecordedLine[]): Logger {
	return {
		level: "info",
		debug: () => {},
		info: (message) => lines.push({ level: "info", message }),
		warn: (message) => lines.push({ level: "warn", message }),
		error: () => {},
	};
}

/** One `info` line to assert against. */
export function infoLine(message: string): RecordedLine {
	return { level: "info", message };
}

/** One `warn` line to assert against. */
export function warnLine(message: string): RecordedLine {
	return { level: "warn", message };
}
