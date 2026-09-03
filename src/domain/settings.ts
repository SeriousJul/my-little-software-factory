/**
 * The rules a handoff setting carries with it, apart from the config that
 * states them and the handoff that runs with them.
 *
 * The control plane holds no model catalog and no agent capability list
 * (ADR 0009), so a setting's own shape is the only thing it can check. It
 * checks that shape once, here, so the operator who types a value and the
 * operator who writes one in a file are held to the same rule.
 */

/** How an error line names the shape of a context window. */
export const TOKEN_COUNT_RULE = "a positive whole number of tokens in digits";

/**
 * Whether `value` is a context window the control plane can pass on.
 *
 * Plain digits only: the value becomes one argv element, so a space, a
 * separator, a suffix (`200k`), or a hex spelling can never reach an agent.
 * Zero and an all-zero count are refused because they ask for no context at
 * all, and a count past the safe integer range is refused because the control
 * plane cannot state it without rounding it.
 */
export function isTokenCount(value: string): boolean {
	if (!/^[0-9]+$/.test(value)) return false;
	const count = Number(value);
	return Number.isSafeInteger(count) && count > 0;
}

/**
 * The one spelling of a count: the plain digits of `value`, or `value` as it
 * is when it is no count at all.
 *
 * `007` and `7` are the same count, and the config parser and the panel both
 * fold a count to its plain digits, so one count never reaches an agent in two
 * spellings. A value that is no count keeps what the operator typed: the row
 * shows it, warns on it, and the handoff refuses it.
 */
export function tokenCountDigits(value: string): string {
	return isTokenCount(value) ? String(Number(value)) : value;
}
