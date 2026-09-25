/**
 * Line helpers for multi-line text.
 *
 * Error output (a TOML parse failure, a command's stderr) comes in
 * multi-line. The control plane carries at most one line of it: the line that
 * states the failure, trimmed.
 */

/**
 * The first non-empty line of a multi-line text, trimmed.
 *
 * Whitespace-only lines are skipped. A text with no non-empty line (empty
 * or all whitespace) yields undefined, so the caller keeps its own fallback.
 */
export function firstNonEmptyLine(text: string): string | undefined {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
}

/** The marker a command writes in front of the line that states its failure. */
const FAILURE_MARKER = /^(?:fatal|error):/i;

/**
 * The one line of a failed command's output that states its failure.
 *
 * A command reports the work it is doing before it reports what went wrong:
 * the first line of a failed `git worktree add` is the progress line
 * `Preparing worktree (checking out 'branch')`, and the refusal the operator
 * can act on follows it as `fatal: ...`. The plane reads the refusal.
 *
 * The line a tool marks is the one that states the failure, so a line
 * starting with `fatal:` or `error:` wins wherever it sits. Output with no
 * marked line keeps its first line, which is the whole answer for a tool that
 * wrote one line, and the best read the plane can take for a prose error that
 * wrote none of these markers.
 */
export function failureLine(text: string): string | undefined {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return lines.find((line) => FAILURE_MARKER.test(line)) ?? lines[0];
}
