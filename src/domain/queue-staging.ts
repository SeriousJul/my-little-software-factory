/**
 * The staging of a Work queue row (CONTEXT.md "Staging"): whose ask put the row
 * in the queue, and the fact every queue line's staging word names.
 *
 * The two rows read differently because they mean different things. An
 * `automatic` row is the factory's own ask - the continuation, the restart, or
 * the fresh open ticket the auto top-up added. An `operator-staged` row is a
 * start the operator asked for and left in the queue for a free seat. The
 * staging is not the origin: the operator's route and the factory's continuation
 * are both `workflow`, and the fresh open ticket and the operator's staged
 * ticket are both `open`. Only the staging tells a reviewer which of the two
 * stands (issue #223).
 *
 * The staging decides the row's place in the queue's order too: the automatic
 * Continuation enters ahead of every standing row, a row the operator staged
 * included (ADR 0094, ADR 0100).
 *
 * The fact stands outside the module that writes the queue lines, the way the
 * start mode does (ADR 0102): the queue's own `automatic` mark is a boolean on
 * the row, and the words the record reads for it live here.
 */
export type QueueStaging = "automatic" | "operator-staged";

/** The staging the row's `automatic` mark names. */
export function queueStagingOf(automatic: boolean): QueueStaging {
	return automatic ? "automatic" : "operator-staged";
}
