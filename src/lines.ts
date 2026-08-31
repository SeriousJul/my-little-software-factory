/**
 * Line helpers for multi-line text.
 *
 * Error output (a TOML parse failure, a command's stderr) comes in
 * multi-line. The control plane carries at most one line of it: the first
 * line that holds a message, trimmed.
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
