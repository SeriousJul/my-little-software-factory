/**
 * Ticket placement on the chosen task's state (ADR 0045).
 *
 * When a manual handoff's final task type differs from the ticket's current
 * suggestion, the control plane writes the ticket's labels before the agent
 * starts, so the ticket's derived position offers the chosen task. This
 * module is that answer's pure core: it reads the state machine and the
 * ticket's source memberships, and answers where the ticket stands after the
 * write and what the write adds and removes.
 *
 * The module shares the state walk and the match test with the task type
 * detection: the suggestion comes from `selectTaskType`, and the post-write
 * feasibility check walks `membershipMatchesState`. The placement and the
 * detection can therefore never disagree about where a label set stands.
 *
 * The module stores nothing: placement is derived, re-derived like the
 * position, and takes its ticket labels from the source's current snapshot.
 * It has no egress: it answers the write, and the handoff dispatch runs it
 * the way the fire runs its label facts.
 */
import type { WorkflowState } from "./config.ts";
import type { SourceMembership } from "./domain/ticket.ts";
import { membershipMatchesState, newestMembership, selectTaskType } from "./task-selection.ts";

/** The inputs a placement evaluation reads. */
export interface PlacementInput {
	/** The state machine in machine order: the walk's priority. */
	states: readonly WorkflowState[];
	/** The task the ticket takes when no state matches: the fallback. */
	fallbackTaskType: string;
	/** The ticket's source memberships, with the labels the sources list. */
	memberships: readonly SourceMembership[];
	/** The task type the manual handoff will run. */
	chosenTaskType: string;
}

/** The three faces of a placement evaluation (ADR 0045). */
export type PlacementEvaluation =
	| {
			/**
			 * No placement runs: the chosen task is the ticket's current
			 * suggestion, or the ticket is parked and the chosen task is the
			 * default handoff.
			 */
			kind: "none";
	  }
	| {
			/**
			 * The placement the write makes: the state the ticket stands on
			 * after the write, the membership the write runs on, and the
			 * label diff.
			 */
			kind: "placement";
			/** The state the ticket stands on after the write. */
			state: WorkflowState;
			/**
			 * The membership the write runs on: the newest one the target
			 * state's non-label conditions hold on.
			 */
			membership: SourceMembership;
			/**
			 * The labels the write adds, in the target state's configured
			 * spelling, each one the ticket does not already wear.
			 */
			added: string[];
			/** The labels the write removes, as the ticket wears them now. */
			removed: string[];
			/** The membership's labels after the write. */
			postLabels: string[];
	  }
	| {
			/**
			 * The placement cannot stand: no state that matches the ticket
			 * offers the chosen task, the ticket carries a label the target
			 * state excludes, or the post-write label set stands where the
			 * chosen task is not offered.
			 */
			kind: "infeasible";
			/** The reason in the operator's words, stated on the row and the Message line. */
			reason: string;
	  };

/**
 * The placement label set (ADR 0045): every label named in any state's all
 * or any match set, lowercased. A state's none set names exclusion, not
 * ownership, so a label that stands only in a none set is no placement label
 * and the placement never strips it.
 */
export function placementLabelSet(states: readonly WorkflowState[]): ReadonlySet<string> {
	const owned = new Set<string>();
	for (const state of states) {
		for (const label of state.match.labelsAll ?? []) owned.add(label.toLocaleLowerCase());
		for (const label of state.match.labelsAny ?? []) owned.add(label.toLocaleLowerCase());
	}
	return owned;
}

/** Whether a state's non-label conditions hold on one membership. */
function nonLabelConditionsHold(membership: SourceMembership, state: WorkflowState): boolean {
	const match = state.match;
	if (match.sourceName !== undefined && match.sourceName !== membership.sourceName) return false;
	if (match.sourceKind !== undefined && match.sourceKind !== membership.sourceKind) return false;
	// The repository identity is canonical lowercase and the match value is
	// the operator's string, so the condition reads case-insensitive.
	if (
		match.repository !== undefined &&
		match.repository.toLowerCase() !== membership.repository.identity.toLowerCase()
	)
		return false;
	return true;
}

/**
 * The placement the chosen task type takes on the ticket (ADR 0045).
 *
 * The answer is one of three faces. When the chosen task is the ticket's
 * current suggestion, or the default handoff of a parked ticket, no
 * placement runs. When the chosen task is offered by a state the ticket
 * matches, the answer names the state the ticket stands on after the write
 * and the labels the write adds and removes, and the placement is idempotent:
 * a label set that already matches its spec adds nothing and removes nothing,
 * so the write the dispatch runs takes no egress. When no placement can
 * stand, the answer is the infeasibility with its named reason: a task type
 * no matching state offers, a label the target state excludes, or a post-
 * write label set that stands where the chosen task is not offered.
 */
export function evaluatePlacement(input: PlacementInput): PlacementEvaluation {
	const { states, fallbackTaskType, memberships, chosenTaskType } = input;

	// Face 1: no placement runs. The chosen task is the ticket's current
	// suggestion, or the ticket is parked and the chosen task is the default
	// handoff.
	const suggestion = selectTaskType(memberships, states, fallbackTaskType);
	if (suggestion === chosenTaskType) return { kind: "none" };
	if (suggestion === null && chosenTaskType === fallbackTaskType) return { kind: "none" };

	const newest = newestMembership(memberships);
	if (newest === undefined) return { kind: "infeasible", reason: "the ticket lists on no source" };

	// The target: the first state in machine order that offers the chosen
	// task and whose non-label conditions hold on the ticket.
	let target: WorkflowState | undefined;
	for (const state of states) {
		if (state.taskType !== chosenTaskType) continue;
		if (memberships.some((membership) => nonLabelConditionsHold(membership, state))) {
			target = state;
			break;
		}
	}
	if (target === undefined) {
		return {
			kind: "infeasible",
			reason: `task type ${chosenTaskType} is not offered by any state that matches a ${newest.sourceKind} ticket`,
		};
	}

	// The write runs on the newest membership the target's non-label
	// conditions hold on.
	const writeTarget = newestMembership(
		memberships.filter((membership) => nonLabelConditionsHold(membership, target)),
	);
	if (writeTarget === undefined)
		return {
			kind: "infeasible",
			reason: `state ${target.name} matches no source of the ticket`,
		};

	// Face 2: a label the target state excludes stands on the ticket.
	for (const excluded of target.match.labelsNone ?? []) {
		if (
			writeTarget.labels.some((label) => label.toLocaleLowerCase() === excluded.toLocaleLowerCase())
		)
			return {
				kind: "infeasible",
				reason: `state ${target.name} excludes label ${excluded}, and the ticket carries it`,
			};
	}

	// The post-write set: the ticket's labels minus the labels the machine
	// owns, plus the target state's all and any labels, each in the
	// configured spelling the ticket does not already wear.
	const owned = placementLabelSet(states);
	const named = new Set<string>();
	const added: string[] = [];
	const have = new Set(writeTarget.labels.map((label) => label.toLocaleLowerCase()));
	for (const label of [...(target.match.labelsAll ?? []), ...(target.match.labelsAny ?? [])]) {
		const key = label.toLocaleLowerCase();
		named.add(key);
		if (!added.some((existing) => existing.toLocaleLowerCase() === key)) added.push(label);
	}
	const toAdd = added.filter((label) => !have.has(label.toLocaleLowerCase()));
	const toRemove = writeTarget.labels.filter((label) => {
		const key = label.toLocaleLowerCase();
		return owned.has(key) && !named.has(key);
	});
	const removedSet = new Set(toRemove.map((label) => label.toLocaleLowerCase()));
	const postLabels = [
		...writeTarget.labels.filter((label) => !removedSet.has(label.toLocaleLowerCase())),
		...toAdd,
	];

	// Face 3: feasibility. The walk is the fire's walk: the first state that
	// matches the post-write label set, over the ticket's memberships, must
	// offer the chosen task.
	const effective = memberships.map((membership) =>
		membership === writeTarget ? { ...membership, labels: postLabels } : membership,
	);
	let firstMatch: WorkflowState | undefined;
	for (const state of states) {
		if (effective.some((membership) => membershipMatchesState(membership, state))) {
			firstMatch = state;
			break;
		}
	}
	if (firstMatch === undefined)
		return {
			kind: "infeasible",
			reason: "no state matches the ticket's labels after the placement",
		};
	if (firstMatch.name === target.name)
		return {
			kind: "placement",
			state: target,
			membership: writeTarget,
			added: toAdd,
			removed: toRemove,
			postLabels,
		};

	// An earlier state still matches the post-write set. When it claims one
	// of the labels the placement stands on, the machine's flaw stands in the
	// reason, with both states named.
	const claimed = sharedClaimLabel(firstMatch, target, postLabels);
	if (claimed !== null)
		return {
			kind: "infeasible",
			reason: `states ${firstMatch.name} and ${target.name} both claim label ${claimed}`,
		};
	return {
		kind: "infeasible",
		reason:
			firstMatch.taskType === undefined
				? `state ${firstMatch.name} still matches the ticket after the placement and offers no task`
				: `state ${firstMatch.name} still matches the ticket after the placement and offers task ${firstMatch.taskType}`,
	};
}

/**
 * A label both states claim in their all or any sets and that stands on the
 * post-write set, in the earlier state's configured spelling. Null when the
 * two states claim nothing together.
 */
function sharedClaimLabel(
	earlier: WorkflowState,
	target: WorkflowState,
	postLabels: readonly string[],
): string | null {
	const targetClaims = new Set<string>(
		[...(target.match.labelsAll ?? []), ...(target.match.labelsAny ?? [])].map((label) =>
			label.toLocaleLowerCase(),
		),
	);
	const present = new Set(postLabels.map((label) => label.toLocaleLowerCase()));
	for (const label of [...(earlier.match.labelsAll ?? []), ...(earlier.match.labelsAny ?? [])]) {
		const key = label.toLocaleLowerCase();
		if (targetClaims.has(key) && present.has(key)) return label;
	}
	return null;
}
