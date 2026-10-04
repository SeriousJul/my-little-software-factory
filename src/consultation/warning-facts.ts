/**
 * The Consultation warning facts module: the warnings a Consultation record
 * carries, and the reads that recognize them.
 *
 * The Stale Agent output warning, with the older spelling a durable record can
 * still hold, and the warning a turn that ended failed or aborted leaves on the
 * record, have one owner here. The refresh that records a failed read, the
 * observation that settles a turn without output, the state aggregate that
 * clears a warning on a later settled turn, and the operations that set and
 * clear the fact all ask this module (issue #203).
 */
import type { TurnEndCause } from "../turn-log.ts";

/**
 * The Stale Agent output warning: the glossary's name for the condition
 * where the latest read of an Agent terminal failed.
 *
 * One owner spells it here, so the refresh that records a failed read and
 * the observation that settles a turn without output leave the same fact on
 * the record, and one clear path removes it.
 */
export const STALE_AGENT_OUTPUT_WARNING = "Stale Agent output";

/** The same fact as an older control plane wrote it, still held by a durable record. */
const LEGACY_STALE_AGENT_OUTPUT_WARNING = "Agent output is stale";

/** Whether a warning is the Stale Agent output fact, in either spelling. */
export function isStaleAgentOutputWarning(warning: string | null | undefined): boolean {
	return warning === STALE_AGENT_OUTPUT_WARNING || warning === LEGACY_STALE_AGENT_OUTPUT_WARNING;
}

/**
 * The warning a Consultation carries after a turn that ended failed or
 * aborted: the cause and the agent's own words, so the record names why the
 * turn did not answer instead of resting silently. Any other cause - the
 * turn answered - carries none.
 */
export function turnEndWarning(cause: TurnEndCause, detail: string): string | null {
	if (cause !== "failed" && cause !== "aborted") return null;
	const bounded = detail === "" ? "" : `: ${detail.slice(0, 200)}`;
	return `Turn ended ${cause}${bounded}`;
}

/** Whether a warning is the turn-end fact, so a later settled turn can clear it. */
export function isTurnEndWarning(warning: string | null | undefined): boolean {
	return typeof warning === "string" && warning.startsWith("Turn ended ");
}
