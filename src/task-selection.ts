/** Ordered, provider-neutral state-based task selection (ADR 0027). */
import type { WorkflowState } from "./config.ts";
import type { SourceMembership } from "./domain/ticket.ts";

/**
 * The suggested task type of a ticket. The first state whose match holds on
 * any current membership wins; the ticket takes the task that state offers,
 * and a state that offers no task is a parking state, so the ticket takes
 * the fallback task type.
 */
export function selectTaskType(
	memberships: readonly SourceMembership[],
	states: readonly WorkflowState[],
	fallback: string,
): string {
	for (const state of states) {
		if (memberships.some((membership) => membershipMatchesState(membership, state))) {
			return state.taskType ?? fallback;
		}
	}
	return fallback;
}

/**
 * Whether one state's match holds on one membership. Every named condition
 * must hold; an omitted condition holds for anything, so a state whose match
 * names nothing matches every membership: a catch-all.
 */
export function membershipMatchesState(membership: SourceMembership, state: WorkflowState): boolean {
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
