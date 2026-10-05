/**
 * The Agent name collision (issue #299, ADR 0107): the rule that comes to rest
 * in front of the operator when herdr will not hand a Ticket its own name.
 *
 * Every name one Ticket asks herdr for names that Ticket and no other (ADR
 * 0098), and a live Agent belongs to a Ticket by its name rather than by its
 * pane (ADR 0043). So when herdr refuses a start because the Ticket's stable
 * Agent name is held in a pane the plane cannot tie to that Ticket, the start
 * has nothing left to try: the refusal is not a transient answer, and the same
 * ask meets the same line every time. The development install measured one
 * security Ticket carry 1,772 attempts in three hours on 4 October, each
 * refused with the same line naming the pane and workspace that held the name.
 *
 * The rule already covers the case where the holder is the Ticket's own Leftover
 * environment: the Handoff takes the name of its work cycle instead (ADR 0098,
 * ADR 0012). It does not cover a holder the plane does not own, and the Attempt
 * hold and the Failed-start park only bound the loop - neither says what stands
 * in the way, and neither waits for the operator.
 *
 * This module owns the standing fact: it is recorded from the refusal, read by
 * the Top-up's gate, worn by the row, stated in the detail, and named in the
 * record in the voice the other walk holds wear. The rule is pure - it takes
 * whether the fact stands and whether the operator has answered it, and
 * answers. Every reader asks this one predicate, the way every reader of the
 * Handoff limit asks `handoffLimitReached` and every reader of the run of
 * failed starts asks `failedStartParkStands`.
 */
import type { AgentNameCollision } from "./ticket.ts";

/** The facts one Agent name collision reads. */
export interface NameCollisionFacts {
	/**
	 * Whether the Ticket carries a collision that has not been cleared: the
	 * durable record the refused start wrote, and no later start has taken the
	 * name since.
	 */
	held: boolean;
	/**
	 * Whether the operator has judged the Ticket out (ADR 0060, ADR 0070): its
	 * own ignore, or the mute of one of its sources. The act is the operator's
	 * answer to the refusal, so the fact leaves the row and the gate with it,
	 * the way the Failed-start park does.
	 */
	judgedOut: boolean;
}

/**
 * Whether the Agent name collision stands on the Ticket.
 *
 * While it stands the Top-up adds no automatic start for the Ticket: the ask
 * waits for the operator instead of repeating a refusal herdr has already
 * given. The operator's own Handoff passes the gate, and the start that takes
 * the name clears the fact, so the automatic adds resume on the same rule with
 * no second act.
 */
export function nameCollisionStands(facts: NameCollisionFacts): boolean {
	if (facts.judgedOut) return false;
	return facts.held;
}

/** The prefix the collision's Message-line fact wears. */
export const NAME_COLLISION_PREFIX = "agent name held:";

/**
 * Where the Ticket's Agent name is held, in the handles herdr named.
 *
 * The pane and the workspace are what the operator looks for in herdr: the
 * plane does not own that pane, so it can run no cleanup of its own and the
 * handles are the whole of the pointer (ADR 0098). herdr names no handles for
 * some refusals, and then the fact says so rather than inventing a place.
 */
export function nameCollisionHolder(collision: AgentNameCollision): string {
	const parts = [
		...(collision.holderPaneId === null ? [] : [`pane ${collision.holderPaneId}`]),
		...(collision.holderWorkspaceId === null ? [] : [`workspace ${collision.holderWorkspaceId}`]),
	];
	return parts.length === 0 ? "a pane herdr did not name" : parts.join(" in ");
}

/**
 * The one line the collision states on the Message line: the prefix, the
 * Ticket's name, and the name that is held where.
 *
 * It wears the shape every standing fact wears (issue #223, issue #298): the
 * prefix, the Ticket, and the fact in parentheses, and it is the standing
 * warning the Desktop notification carries (ADR 0080). The handles are the
 * sentence because the operator has to go find the pane; the attempt's full
 * refusal reaches the record, where the file can hold a long line.
 */
export function nameCollisionLine(ticketName: string, collision: AgentNameCollision): string {
	return (
		`${NAME_COLLISION_PREFIX} ${ticketName} ` +
		`(the herdr name ${collision.stableName} is held by ${nameCollisionHolder(collision)})`
	);
}
