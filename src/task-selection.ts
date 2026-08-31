/** Ordered, provider-neutral task rule selection. */
import type { TaskRule } from "./config.ts";
import type { SourceMembership } from "./domain/ticket.ts";

/** The first rule that matches any current membership wins. */
export function selectTaskType(
	memberships: readonly SourceMembership[],
	rules: readonly TaskRule[],
	fallback: string,
): string {
	for (const rule of rules) {
		if (memberships.some((membership) => membershipMatches(membership, rule))) return rule.taskType;
	}
	return fallback;
}

function membershipMatches(membership: SourceMembership, rule: TaskRule): boolean {
	const { when } = rule;
	if (when.sourceName !== undefined && when.sourceName !== membership.sourceName) return false;
	if (when.sourceKind !== undefined && when.sourceKind !== membership.sourceKind) return false;
	if (when.repository !== undefined && when.repository !== membership.repository.identity)
		return false;
	const labels = new Set(membership.labels.map((label) => label.toLocaleLowerCase()));
	if (when.labelsAll?.some((label) => !labels.has(label.toLocaleLowerCase()))) return false;
	if (
		when.labelsAny !== undefined &&
		!when.labelsAny.some((label) => labels.has(label.toLocaleLowerCase()))
	)
		return false;
	if (when.labelsNone?.some((label) => labels.has(label.toLocaleLowerCase()))) return false;
	return true;
}
