/** Ordered, provider-neutral state-based task selection (ADR 0027). */
import type { WorkflowState } from "./config.ts";
import type { SourceMembership } from "./domain/ticket.ts";

/**
 * The first State whose match holds on any membership, or null when none does.
 *
 * One walk names the ticket's position in the machine, so the Suggested task
 * type and the `position` grouping read the same match and cannot disagree.
 */
export function matchState(
	memberships: readonly SourceMembership[],
	states: readonly WorkflowState[],
): WorkflowState | null {
	for (const state of states) {
		if (memberships.some((membership) => membershipMatchesState(membership, state))) {
			return state;
		}
	}
	return null;
}

/**
 * The suggested task type of a ticket, or null when the machine offers none.
 *
 * The first state whose match holds on any current membership wins, and the
 * ticket takes the task that state offers. A state that offers no task is a
 * parking state: the plane suggests nothing and does nothing on the ticket,
 * so the result is null and only an external label write moves it. The
 * fallback task type stands when no state matches at all (ADR 0027).
 */
export function selectTaskType(
	memberships: readonly SourceMembership[],
	states: readonly WorkflowState[],
	fallback: string,
): string | null {
	return taskTypeOfMatch(matchState(memberships, states), fallback);
}

/**
 * The task one matched State offers: its own, or null for a parking State, or
 * the fallback when no State matched.
 *
 * The projection reads a match once and derives both facts from it, so the
 * Suggested task type and the `position` grouping always name the same State.
 */
export function taskTypeOfMatch(matched: WorkflowState | null, fallback: string): string | null {
	if (matched === null) return fallback;
	return matched.taskType ?? null;
}

/**
 * Whether one state's match holds on one membership. Every named condition
 * must hold; an omitted condition holds for anything, so a state whose match
 * names nothing matches every membership: a catch-all.
 */
export function membershipMatchesState(
	membership: SourceMembership,
	state: WorkflowState,
): boolean {
	const { match } = state;
	if (match.sourceName !== undefined && match.sourceName !== membership.sourceName) return false;
	if (match.sourceKind !== undefined && match.sourceKind !== membership.sourceKind) return false;
	// The repository identity is canonical lowercase and the match value is
	// the operator's string, so the condition reads case-insensitive.
	if (
		match.repository !== undefined &&
		match.repository.toLowerCase() !== membership.repository.identity.toLowerCase()
	)
		return false;
	const labels = new Set(membership.labels.map((label) => label.toLocaleLowerCase()));
	if (match.labelsAll?.some((label) => !labels.has(label.toLocaleLowerCase()))) return false;
	if (
		match.labelsAny !== undefined &&
		!match.labelsAny.some((label) => labels.has(label.toLocaleLowerCase()))
	)
		return false;
	if (match.labelsNone?.some((label) => labels.has(label.toLocaleLowerCase()))) return false;
	return true;
}

/**
 * The newest of the ticket's source memberships: the newest external
 * update first, the source name as the tiebreak. Undefined when the ticket
 * lists on no source. The transition fire and the ticket placement read
 * their write target through this one order, so the two can never disagree
 * about which listing is newest.
 */
export function newestMembership(
	memberships: readonly SourceMembership[],
): SourceMembership | undefined {
	return [...memberships].sort(
		(a, b) =>
			b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) ||
			a.sourceName.localeCompare(b.sourceName),
	)[0];
}
