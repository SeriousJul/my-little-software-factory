/**
 * The start mode (GLOSSARY.md "Start mode"): the path that took the seat for a
 * start, and the fact every start line's `mode` field names.
 *
 * The mode is not the origin. The origin says where the ask came from (`open`,
 * `workflow`, `restart`); the mode says which path took the seat: the Work
 * queue's Pickup for a free seat, the operator's Force-dispatch over the
 * Parallel limit, or the immediate pass the operator's own ask ran for the item
 * it had just enqueued. Each value is one token, so the start line's `mode`
 * field reads as one word for a tool that parses it.
 *
 * The fact stands outside the modules that write the start lines (issue #220):
 * the Handoff dispatch names it for a Handoff and for a Plane action, and the
 * Consultation operations name it for a Consultation. Each module owns its own
 * start line, and both read this one name for the path.
 *
 * A Consultation's `force-dispatch` names the operator's key on the record,
 * not a crossing of the Parallel limit (ADR 0102): the Consultation section's
 * start now key names that mode whatever the seat count reads, so its start
 * line can read `mode force-dispatch` beside a count under the limit.
 */
export type StartMode = "pickup" | "force-dispatch" | "direct-ask";
