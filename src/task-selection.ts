/** Ordered, provider-neutral state-based task selection (ADR 0027). */
import type { WorkflowState } from "./config.ts";
import type { SourceMembership } from "./domain/ticket.ts";

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
	for (const state of states) {
		if (memberships.some((membership) => membershipMatchesState(membership, state))) {
			return state.taskType ?? null;
		}
	}
	return fallback;
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
	if (match.repository !== undefined && match.repository !== membership.repository.identity)
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
