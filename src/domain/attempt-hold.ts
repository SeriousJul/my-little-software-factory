/**
 * The blocked-and-unrefreshed rule one attempt hold reads (ADR 0077, ADR 0101).
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
 * "ran and never reached its work"; the decision is this module's (issue #202,
 * ADR 0095).
 *
 * The hold is a wait for a fact, not a timer. It stands while any of the
 * Ticket's active sources still has no read after the attempt's outcome, and it
 * releases only once every active source has read the Ticket after it. The
 * source half is a fact the caller supplies, answered by
 * `sourceFact.hasUnrefreshedActiveMembershipSince` - the same query the
 * cycle-end re-verify gate runs (ADR 0077) - so the time comparison, its
 * boundary, and its precision live in that one query and not here. This module
 * compares no times.
 *
 * Which failures set the hold (ADR 0101): the rule reads the Ticket's newest
 * attempt and its outcome, not who asked for that start. A failed automatic ask,
 * a failed operator confirm, a failed pickup of a row the operator staged, and a
 * failed force-dispatch all leave the same attempt row, and all hold the
 * automatic walks. The cause of a start that never reached its Agent - a
 * worktree path that stands, a name a stranger holds - says nothing about who
 * asked, so the automatic re-ask waits out the same refresh whatever the origin.
 * The hold never blocks a start: it gates the automatic adds only.
 */

/**
 * The outcome word that stands for an attempt that ran and never reached its
 * work: `failed` for a Handoff that started no Agent, `blocked` for a Plane
 * action the source refused.
 */
export type UnreachedOutcome = "failed" | "blocked";

/** The facts one attempt hold reads. */
export interface AttemptHoldFacts {
	/**
	 * The Ticket's newest attempt: the outcome word it landed with, and the time
	 * its record stands at. Null when the Ticket has no attempt at all, or when
	 * its newest attempt has no outcome yet - an attempt still in flight has
	 * nothing to wait out.
	 */
	latestAttempt: { outcome: string; at: string } | null;
	/** The outcome word that stands for this channel's start that never reached its work. */
	unreachedOutcome: UnreachedOutcome;
	/**
	 * Whether the Ticket still waits on a source read after `at`: any active
	 * source whose last read predates `at`, or that never read at all. The state
	 * module answers this with the cycle-end gate's own query, so the hold and
	 * that gate share one rule and one boundary: a read landing at `at` itself
	 * counts as the read after it.
	 */
	unrefreshedSince: (at: string) => boolean;
}

/**
 * Whether the Ticket's newest attempt holds the auto top-up's re-ask of that
 * Ticket: the newest attempt landed the unreached outcome, and the Ticket's
 * sources have not all re-read it since that outcome landed. A Ticket with no
 * active source holds nothing - no read can release it, and no automatic add
 * stands on it either - which the source fact answers the same way, since no
 * active source means no unrefreshed one.
 */
export function blockedUnrefreshedHold(facts: AttemptHoldFacts): boolean {
	const latest = facts.latestAttempt;
	if (latest === null || latest.outcome !== facts.unreachedOutcome) return false;
	return facts.unrefreshedSince(latest.at);
}
