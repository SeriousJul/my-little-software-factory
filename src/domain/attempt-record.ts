/**
 * The record line a Handoff start leaves when its attempt settles `failed`
 * (issue #295).
 *
 * A start that began and reached no Agent has always left its reason in the
 * attempt's own row and on the Message line. The file held the `handoff
 * started:` line and nothing after it, so a reviewer reading the plane's log
 * could not tell that the factory had tried at all, let alone why the attempt
 * ended. This module owns the one sentence that fact states in, so both
 * channels that settle a failed start state it the same way: the Handoff
 * dispatch's own starts, and the boot's recovery of the claims a previous run
 * left unsettled (ADR 0041).
 *
 * The line wears the shape every record refusal wears (issue #223) - the
 * prefix, the Ticket's name, and the fact in parentheses - so one rule reads
 * them all. It is not a refusal, and the two lines never stand for one
 * another: `handoff refused:` answers a hard gate before the start began, so
 * no attempt row stands under it, while this line answers a start that passed
 * every gate, claimed its seat, and settled `failed` in the attempt ledger.
 *
 * The reason is the attempt's record's own. Every caller passes the reason its
 * settle wrote and reads it back out of the settle's answer, so the file and
 * the ledger cannot state two different endings for one start.
 */

/** The prefix the failed-start line wears. */
export const HANDOFF_START_FAILED_PREFIX = "handoff start failed:";

/** The words the line states when the attempt's row stores no reason at all. */
export const NO_FAILURE_RECORDED_FACT = "the attempt recorded no reason";

/**
 * The one line one failed Handoff start leaves: the prefix, the Ticket the
 * attempt names, and the reason that attempt's row stores.
 *
 * `ticketName` is the caller's own name read - the live projection's title in
 * quotes, the way every other record line names a Ticket. `failureReason` is
 * the reason the attempt's record holds, and `null` is a settle that stored
 * none.
 */
export function handoffStartFailedLine(ticketName: string, failureReason: string | null): string {
	return `${HANDOFF_START_FAILED_PREFIX} ${ticketName} (${failureReason ?? NO_FAILURE_RECORDED_FACT})`;
}
