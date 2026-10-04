/**
 * The blocked-and-unrefreshed rule one attempt hold reads (ADR 0077, ADR 0100).
 *
 * A start that ran and never reached its work leaves the Ticket where it stood:
 * the position still offers the same task, and every other top-up gate still
 * reads clear. Without this rule the auto top-up asks the same failing start on
 * every observation cycle (issue #217).
 *
 * The rule is the same for both start channels, so it lives here once: the
 * Handoff aggregate reads it over the Ticket's newest `handoff_attempts` row,
 * and the Plane action aggregate over its newest `plane_action_attempts` row.
 * Each aggregate supplies its own newest attempt and its own outcome word for
 * "ran and never reached its work"; the comparison, the source walk, and the
 * answer are this module's (issue #202, ADR 0095).
 *
 * The hold is a wait for a fact, not a timer: it stands until one of the
 * Ticket's active sources re-reads the Ticket after the attempt landed, the way
 * the cycle-end re-verify gate waits for the same read.
 */

/** The facts one attempt hold reads. */
export interface AttemptHoldFacts {
	/**
	 * The Ticket's newest attempt: the outcome word it landed with, and the time
	 * its record stands at. Null when the Ticket has no attempt at all.
	 */
	latestAttempt: { outcome: string; at: string } | null;
	/**
	 * The outcome word that stands for an attempt that ran and never reached its
	 * work: `failed` for a Handoff that started no Agent, `blocked` for a Plane
	 * action the source refused.
	 */
	unreachedOutcome: string;
	/** The names of the Ticket's active sources. */
	activeSourceNames: readonly string[];
	/** The time one source last read its list, or null when it never has. */
	lastSourceRead: (name: string) => string | null;
}

/**
 * Whether the Ticket's newest attempt holds the auto top-up's re-ask of that
 * Ticket: the newest attempt landed the unreached outcome, and no active source
 * has read the Ticket since the attempt landed. A Ticket with no active source
 * holds nothing - no read can ever release it, and no automatic add stands on
 * it either.
 */
export function blockedUnrefreshedHold(facts: AttemptHoldFacts): boolean {
	const latest = facts.latestAttempt;
	if (latest === null || latest.outcome !== facts.unreachedOutcome) return false;
	for (const name of facts.activeSourceNames) {
		const last = facts.lastSourceRead(name);
		if (last === null || last < latest.at) return true;
	}
	return false;
}
