/**
 * The Decision region's facts (issue #201): the lines the modal states above
 * its rows, and the context row under its border (ADR 0027).
 *
 * The modal keeps its rows, its Decision region, and its focus. The words the
 * settled turn's transition wrote, the route's standing line, and the turn's
 * outcome are facts the control plane owns, so they are answered here and
 * handed to the surface as values. The module reads the task type the settled
 * turn names from the Ticket fact module, so the modal, the Live view, and the
 * Work queue's row cannot state three different task types for one Ticket.
 *
 * The module is pure. It reads no state file, mounts no renderer, and holds no
 * palette: a fact here is a string a surface can paint, and the color comes
 * from the shared paint layer (ADR 0024).
 */
import type { TransitionOutcome } from "../config.ts";
import type { PlaneActionAttempt, WorkQueueItem } from "../state.ts";
import type { Ticket } from "./ticket.ts";
import { inFlight, turnTaskType } from "./ticket-facts.ts";

/** The inputs the Decision fact module reads for one settled turn. */
export interface DecisionFactInputs {
	/** The Ticket the decision is about. */
	ticket: Ticket;
	/** The Work queue items. */
	queue: readonly WorkQueueItem[];
	/** The claims this run holds: the Starting window's set. */
	claims: ReadonlySet<string>;
	/** The Ticket the transition's position stands on, or undefined when none does. */
	positionTicket: Ticket | undefined;
	/** Whether the position's Ticket still stands in a source. */
	positionStillListed: boolean;
	/** Whether the position's task type carries the plane action form. */
	positionIsPlaneAction: boolean;
	/** The newest plane-action attempt the state read for this Ticket, or null. */
	latestPlaneActionAttempt: PlaneActionAttempt | null;
	/** The task type the resolved config falls back to. */
	defaultTaskType: string;
}

/** The row the settled turn's transition offers, as the fact the modal reads. */
export type DecisionOffer =
	| { kind: "merge"; taskType: string }
	| { kind: "handoff"; taskType: string };

/** The Decision region's facts for one settled turn. */
export interface DecisionFacts {
	/** One context row under the border: repository, task type, agent, time. */
	contextLine: string;
	/** The fact lines the modal states above its rows. */
	factLines: readonly string[];
	/** The row the transition offers, or null when none stands. */
	offer: DecisionOffer | null;
}

/** One surface's label write as the decision's fact line. */
export function transitionFactLine(
	surface: string,
	write: { added: string[]; removed: string[] },
): string {
	const parts = [surface];
	if (write.added.length > 0) parts.push(`added ${write.added.join(", ")}`);
	if (write.removed.length > 0) parts.push(`removed ${write.removed.join(", ")}`);
	return parts.join(" · ");
}

/**
 * Where a living route stands (ADR 0064), or null while the route is dead: no
 * queue item waits for it, and its position holds no handoff.
 *
 * The decision row reads the answer as the fact line it names - waiting in the
 * Work queue, starting, or running on its position Ticket - and the live route
 * row stands again the moment the route dies.
 */
export function routeStandingLine(
	ticket: Ticket,
	outcome: TransitionOutcome,
	mergeRoute: boolean,
	inputs: DecisionFactInputs,
): string | null {
	const positionIdentity = outcome.positionTicketIdentity ?? ticket.identity;
	if (mergeRoute) {
		// The merge's route stands in the Work queue's row (ADR 0068): the item
		// takes no seat, so the pickup's walk runs it when it reaches it.
		const waiting = inputs.queue.some(
			(item) => item.kind === "plane-action" && item.ticketIdentity === positionIdentity,
		);
		return waiting ? "the merge is waiting in the Work queue" : null;
	}
	const waiting = inputs.queue.some(
		(item) =>
			item.kind === "handoff" &&
			item.origin === "workflow" &&
			item.routeFromIdentity === ticket.identity,
	);
	if (waiting) return "the route is waiting in the Work queue";
	if (inputs.claims.has(positionIdentity)) return "the route is starting";
	if (inputs.positionTicket !== undefined && inFlight(inputs.positionTicket))
		return "the route is running on its position ticket";
	return null;
}

/** The Decision region's facts for one settled turn, read once. */
export function decisionFacts(inputs: DecisionFactInputs): DecisionFacts {
	const ticket = inputs.ticket;
	const completion = ticket.lastCompletion;
	const time = completion === null ? "" : completion.completedAt.slice(0, 16).replace("T", " ");
	const contextLine = [
		ticket.repository,
		turnTaskType(ticket, inputs.defaultTaskType),
		completion?.agentType ?? "?",
		time,
	]
		.filter((part) => part !== "")
		.join(" · ");

	const factLines: string[] = [];
	const outcome = completion?.transition ?? null;
	if (outcome === null) return { contextLine, factLines, offer: null };

	// The reason is a visible fact either way: the branch that did not hold, or
	// the pull-request fact the fire skipped because no linked pull request was
	// found (ADR 0027).
	if (outcome.reason !== "") {
		factLines.push(outcome.fired ? outcome.reason : `no transition branch held: ${outcome.reason}`);
	}
	if (outcome.ticketWrite !== null)
		factLines.push(transitionFactLine("ticket", outcome.ticketWrite));
	if (outcome.pullRequestWrite !== null && outcome.pullRequestIdentity !== null) {
		const surface =
			outcome.pullRequestKey !== null ? `pull request ${outcome.pullRequestKey}` : "pull request";
		factLines.push(transitionFactLine(surface, outcome.pullRequestWrite));
	}
	if (outcome.writeFailure !== "") factLines.push(`label write failed: ${outcome.writeFailure}`);

	let offer: DecisionOffer | null = null;
	if (outcome.positionTaskType !== null) {
		// The merged position the transition offers (ADR 0068): the task type
		// resolves on the plane action, so the row asks for the merge, not for a
		// handoff. While the route is alive the row reads as the fact line that
		// names where it stands, and takes no key (ADR 0064). The record settles
		// only the turn that ran it: it stands while it postdates the turn's
		// completion, so a blocked merge never hides the re-merge the following
		// review asks for.
		const attempt = inputs.latestPlaneActionAttempt;
		const attemptStands = attempt !== null && attempt.at >= (completion?.completedAt ?? "");
		const standing = routeStandingLine(ticket, outcome, inputs.positionIsPlaneAction, inputs);
		if (standing !== null) {
			factLines.push(standing);
		} else if (attemptStands && attempt !== null) {
			// The outcome stands where the row stood (ADR 0068).
			factLines.push(
				attempt.outcome === "merged"
					? `the merge ${attempt.decision === "auto-merged" ? "ran" : "landed"}`
					: `the merge was blocked: ${attempt.reason}`,
			);
			if (attempt.transition !== null && attempt.transition.pullRequestWrite !== null) {
				factLines.push(transitionFactLine("pull request", attempt.transition.pullRequestWrite));
			}
		} else if (inputs.positionStillListed) {
			// The position is derived, never stored (ADR 0027): the Ticket it
			// sits on can leave its source between the fire and the decision. No
			// list holds such a Ticket, and no task can host on it, so the offer
			// stands withdrawn.
			offer = inputs.positionIsPlaneAction
				? { kind: "merge", taskType: outcome.positionTaskType }
				: { kind: "handoff", taskType: outcome.positionTaskType };
		} else {
			factLines.push(
				inputs.positionIsPlaneAction
					? "the position's ticket left its source; no merge stands"
					: "the position's ticket left its source; no handoff stands",
			);
		}
	}

	// The re-fire row stands on an outcome the fire did not complete (ADR 0054):
	// no branch held, or the label write failed. A complete outcome states no
	// fact line here.
	return { contextLine, factLines, offer };
}
