/**
 * The Failed-start park (issue #298, ADR 0106): the rule that comes to rest in
 * front of the operator when one Ticket's Handoff starts keep failing.
 *
 * The Attempt hold (ADR 0077 as extended by ADR 0101) already holds the re-ask
 * after one failed start until the Ticket's active sources re-read it. That hold
 * is the right answer to one failure and the wrong answer to a cause outside the
 * Ticket: a source read lands on every refresh and says nothing about the
 * failure, so the hold is one refresh of delay, and the loop runs one failed
 * start per refresh until the Handoff limit stops the Top-up and leaves the
 * Ticket open with no fact saying why. The development run measured 20 attempts
 * per Ticket inside 98 minutes on three Tickets, and single Tickets have carried
 * 9,356 failed starts in about a day.
 *
 * The park is the second brake, and it is a fact rather than a count of the
 * cycle: the Ticket's newest Handoff attempts, in one unbroken run, all settled
 * `failed`. A run that reaches the park's count stands on the Ticket, its row
 * and detail name it, and the Top-up adds no automatic start for it. The park
 * arrives before the Handoff limit, so the operator meets the loop while the cap
 * that ends a work cycle still stands behind it.
 *
 * The rule is pure: it takes the run the Handoff aggregate reads, the cap the
 * config resolved, and the operator's own act on the Ticket, and answers. Every
 * reader - the Top-up's gate, the row's marker, the detail's line - asks this
 * one predicate over the facts it already holds, the way every reader of the
 * Handoff limit asks `handoffLimitReached`.
 */

/**
 * The count of consecutive failed starts the park stands on.
 *
 * It is half the Handoff limit, so the park always arrives before the limit that
 * ends a work cycle, and the cap stays the one knob: a second number the operator
 * sets would be a second brake to keep in step with the first. A limit below two
 * parks at one failed start, the earliest the fact can say anything.
 */
export function failedStartParkAttempts(handoffLimit: number): number {
	return Math.max(1, Math.floor(handoffLimit / 2));
}

/** The facts one Failed-start park reads. */
export interface FailedStartParkFacts {
	/**
	 * The length of the run of the Ticket's newest Handoff attempts that settled
	 * `failed` - the starts that claimed and ran and started no Agent. Any attempt
	 * that settled otherwise, or that has not settled yet, ends the run.
	 */
	failedStartStreak: number;
	/** The Handoff limit the resolved config names. */
	handoffLimit: number;
	/**
	 * Whether the operator has judged the Ticket out (ADR 0060, ADR 0070): its own
	 * ignore, or the mute of one of its sources. The act is the operator's answer to
	 * the failure, so the park leaves with it, and the machine's own gate already
	 * holds a judged-out Ticket out of every automatic walk.
	 */
	judgedOut: boolean;
}

/**
 * Whether the Failed-start park stands on the Ticket.
 *
 * The run reaches the park's count, and no operator act has answered it. A manual
 * Handoff that reaches its Agent lands an attempt that settled otherwise and ends
 * the run, so the automatic adds resume on the same rule; a manual Handoff that
 * fails extends the run, because the refusal it met is the refusal the park names.
 */
export function failedStartParkStands(facts: FailedStartParkFacts): boolean {
	if (facts.judgedOut) return false;
	return facts.failedStartStreak >= failedStartParkAttempts(facts.handoffLimit);
}

/** The prefix the park's Message-line fact wears. */
export const FAILED_START_PARK_PREFIX = "handoff failure park:";

/**
 * The one line the park states on the Message line: the prefix, the Ticket's
 * name, and the run it stands on.
 *
 * The line is the standing warning the Desktop notification carries (ADR 0080),
 * so it states the count the operator needs to weigh - how many starts the
 * factory has already burned - and not only that a hold happened. It wears the
 * shape every record refusal wears (issue #223): the prefix, the Ticket's name,
 * and the fact in parentheses.
 */
export function failedStartParkLine(ticketName: string, failedStartStreak: number): string {
	return (
		`${FAILED_START_PARK_PREFIX} ${ticketName} ` +
		`(${failedStartStreak} Handoff starts in a row never reached an Agent)`
	);
}
