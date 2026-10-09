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
import type { PlaneActionAttempt } from "../state/plane-action.ts";
import type { WorkQueueItem } from "../state/work-queue.ts";
import type { NextStepGate } from "../workflow.ts";
import { NEXT_STEP_GATE_LINES } from "../workflow.ts";
import type { Completion, Ticket } from "./ticket.ts";
import { inFlight, turnTaskType } from "./ticket-facts.ts";

/**
 * The transition's position, resolved by the screen.
 *
 * The position is derived, never stored (ADR 0027), so the screen resolves it -
 * the Ticket it stands on, whether a source still lists it, the form its task
 * type carries, and the attempt the state recorded for it - and hands the four
 * answers as one record.
 */
export interface DecisionPosition {
	/** The Ticket the position stands on, or undefined when none does. */
	ticket: Ticket | undefined;
	/** Whether the position's Ticket still stands in a source. */
	stillListed: boolean;
	/** Whether the position's task type carries the plane action form. */
	isPlaneAction: boolean;
	/** The newest plane-action attempt the state read for the position, or null. */
	latestAttempt: PlaneActionAttempt | null;
}

/** The inputs the Decision fact module reads for one settled turn. */
export interface DecisionFactInputs {
	/** The Ticket the decision is about. */
	ticket: Ticket;
	/** The Work queue items. */
	queue: readonly WorkQueueItem[];
	/** The claims this run holds: the Starting window's set. */
	claims: ReadonlySet<string>;
	/** The transition's position, resolved by the screen. */
	position: DecisionPosition;
	/**
	 * The gate that holds the settled turn's derived Next step (ADR 0092), or
	 * null when the step stands or the turn derives none. The screen derives the
	 * step from the state; the words that state a gate belong here.
	 */
	nextStepGate: NextStepGate | null;
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
	if (inputs.position.ticket !== undefined && inFlight(inputs.position.ticket))
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

	factLines.push(...outcomeFactLines(outcome));
	// The merged position the transition offers (ADR 0068): the task type
	// resolves on the plane action, so the row asks for the merge, not for a
	// handoff. While the route is alive the row reads as the fact line that
	// names where it stands, and takes no key (ADR 0064). The record settles
	// only the turn that ran it: it stands while it postdates the turn's
	// completion, so a blocked merge never hides the re-merge the following
	// review asks for.
	const position = positionOutcomeFacts({ ticket, completion, outcome, inputs });
	if (position !== null) factLines.push(...position.lines);

	// The re-fire row stands on an outcome the fire did not complete (ADR 0054):
	// no branch held, or the label write failed. A complete outcome states no
	// fact line here.
	return { contextLine, factLines, offer: position?.offer ?? null };
}

/** The fact lines one settled outcome states before the position offer. */
function outcomeFactLines(outcome: TransitionOutcome): string[] {
	const lines: string[] = [];
	// The reason is a visible fact either way: the branch that did not hold, or
	// the pull-request fact the fire skipped because no linked pull request was
	// found (ADR 0027).
	if (outcome.reason !== "") {
		lines.push(outcome.fired ? outcome.reason : `no transition branch held: ${outcome.reason}`);
	}
	if (outcome.ticketWrite !== null) lines.push(transitionFactLine("ticket", outcome.ticketWrite));
	if (outcome.pullRequestWrite !== null && outcome.pullRequestIdentity !== null) {
		const surface =
			outcome.pullRequestKey !== null ? `pull request ${outcome.pullRequestKey}` : "pull request";
		lines.push(transitionFactLine(surface, outcome.pullRequestWrite));
	}
	if (outcome.writeFailure !== "") lines.push(`label write failed: ${outcome.writeFailure}`);
	return lines;
}

/** The fact lines and offer one position task type's outcome stands as. */
function positionOutcomeFacts(fields: {
	ticket: Ticket;
	completion: Completion | null;
	outcome: TransitionOutcome;
	inputs: DecisionFactInputs;
}): { lines: string[]; offer: DecisionOffer | null } | null {
	const { ticket, completion, outcome, inputs } = fields;
	const taskType = outcome.positionTaskType;
	if (taskType === null) return null;
	const lines: string[] = [];
	const attempt = inputs.position.latestAttempt;
	const attemptStands = attempt !== null && attempt.at >= (completion?.completedAt ?? "");
	const standing = routeStandingLine(ticket, outcome, inputs.position.isPlaneAction, inputs);
	if (standing !== null) {
		lines.push(standing);
		return { lines, offer: null };
	}
	if (attemptStands && attempt !== null) {
		// The outcome stands where the row stood (ADR 0068).
		lines.push(mergeAttemptLine(attempt));
		if (attempt.transition !== null && attempt.transition.pullRequestWrite !== null) {
			lines.push(transitionFactLine("pull request", attempt.transition.pullRequestWrite));
		}
		return { lines, offer: null };
	}
	if (inputs.position.stillListed) {
		// The position is derived, never stored (ADR 0027): the Ticket it
		// sits on can leave its source between the fire and the decision. No
		// list holds such a Ticket, and no task can host on it, so the offer
		// stands withdrawn.
		const offer: DecisionOffer = inputs.position.isPlaneAction
			? { kind: "merge", taskType }
			: { kind: "handoff", taskType };
		// The hold on the machine's own step, stated beside the key the
		// operator still holds (ADR 0092). The operator's own key passes the
		// gates, so the row stands and the fact line says what the factory
		// will not take on its own.
		if (inputs.nextStepGate !== null) {
			lines.push(`the Next step is held: ${NEXT_STEP_GATE_LINES[inputs.nextStepGate]}`);
		}
		return { lines, offer };
	}
	lines.push(
		inputs.position.isPlaneAction
			? "the position's ticket left its source; no merge stands"
			: "the position's ticket left its source; no handoff stands",
	);
	return { lines, offer: null };
}

/** The one line one merged position attempt states. */
function mergeAttemptLine(attempt: PlaneActionAttempt): string {
	return attempt.outcome === "merged"
		? `the merge ${attempt.decision === "auto-merged" ? "ran" : "landed"}`
		: `the merge was blocked: ${attempt.reason}`;
}
