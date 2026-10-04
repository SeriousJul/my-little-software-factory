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
 */

import type { Logger } from "../src/logging.ts";

/** A Logger that appends every `info` and `warn` line to `lines`. */
export function recordLogger(lines: string[]): Logger {
	return {
		level: "info",
		debug: () => {},
		info: (message) => lines.push(message),
		warn: (message) => lines.push(message),
		error: () => {},
	};
}
