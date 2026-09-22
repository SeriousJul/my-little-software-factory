/**
 * The Placement module on its own (ADR 0045).
 *
 * The module answers, for a ticket and a chosen task type, whether the
 * manual handoff must write the ticket's labels before it starts, what the
 * write adds and removes, and why the placement cannot stand. It stores
 * nothing and takes no egress: the state walk it shares with the task type
 * detection is the test's way of proving the placement and the suggestion
 * never disagree about where a label set stands.
 */
import { describe, expect, test } from "bun:test";

import type { WorkflowState } from "../src/config.ts";
import type { SourceMembership } from "../src/domain/ticket.ts";
import {
	evaluatePlacement,
	type PlacementEvaluation,
	placementLabelSet,
} from "../src/placement.ts";
import { BASE_CONFIG } from "./base-config.ts";

/** The task type the ticket takes when no state matches. */
const FALLBACK = BASE_CONFIG.defaultTaskType;

/** The shipped machine: the two pull request states, in machine order. */
const PR_STATES: WorkflowState[] = [
	{
		name: "needs-work",
		taskType: "rework",
		match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
	},
	{
		name: "ready-for-review",
		taskType: "review",
		match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
	},
];

/** An issue membership with the labels and the update time the test names. */
function issue(over: Partial<SourceMembership> = {}): SourceMembership {
	return {
		sourceName: "issues",
		health: "healthy",
		identity: "github:github.com:I_5",
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/issues/5",
		title: "Persist source facts",
		description: "",
		labels: [],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

/** A pull request membership with the labels and the update time the test names. */
function pull(over: Partial<SourceMembership> = {}): SourceMembership {
	return {
		sourceName: "pulls",
		health: "healthy",
		identity: "github:github.com:P_5",
		sourceKind: "github-pull-request",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/pulls/5",
		title: "Persist source facts",
		description: "",
		labels: [],
		externalUpdatedAt: "2026-08-31T12:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

function evaluate(
	states: readonly WorkflowState[],
	memberships: readonly SourceMembership[],
	chosen: string,
): PlacementEvaluation {
	return evaluatePlacement({
		states,
		fallbackTaskType: FALLBACK,
		memberships,
		chosenTaskType: chosen,
	});
}

describe("the placement label set", () => {
	test("the set names every label of the machine's all and any sets, lowercased", () => {
		const states: WorkflowState[] = [
			{
				name: "first",
				taskType: "implement",
				match: { labelsAll: ["Pull-Request"], labelsAny: ["Needs-Work"] },
			},
			{ name: "second", taskType: "review", match: { labelsAny: ["ready-for-review"] } },
		];
		const owned = placementLabelSet(states);
		expect(owned.has("pull-request")).toBe(true);
		expect(owned.has("needs-work")).toBe(true);
		expect(owned.has("ready-for-review")).toBe(true);
		expect(owned.size).toBe(3);
	});

	test("a label that stands only in a none set is no placement label", () => {
		const states: WorkflowState[] = [
			{ name: "wip", match: { labelsNone: ["wip"] } },
			{ name: "ready", taskType: "implement", match: { labelsAny: ["ready"] } },
		];
		const owned = placementLabelSet(states);
		expect(owned.has("wip")).toBe(false);
		expect(owned.has("ready")).toBe(true);
	});
});

describe("the no-placement faces", () => {
	test("the chosen task is the ticket's current suggestion", () => {
		const evaluation = evaluate(PR_STATES, [pull({ labels: ["ready-for-review"] })], "review");
		expect(evaluation).toEqual({ kind: "none" });
	});

	test("the default handoff of a ticket no state matches never differs from the suggestion", () => {
		const evaluation = evaluate(PR_STATES, [issue()], "implement");
		expect(evaluation).toEqual({ kind: "none" });
	});

	test("the default handoff of a ticket a parking state holds never differs from the suggestion", () => {
		const states: WorkflowState[] = [{ name: "held", match: { sourceKind: "github-issue" } }];
		const evaluation = evaluate(states, [issue({ labels: ["anything"] })], "implement");
		expect(evaluation).toEqual({ kind: "none" });
	});

	test("another task on a ticket no state matches is not a no-placement", () => {
		const evaluation = evaluate(PR_STATES, [issue()], "rework");
		expect(evaluation.kind).toBe("infeasible");
	});
});

describe("the write the start runs", () => {
	test("a pull request moves from needs-work to ready-for-review", () => {
		const evaluation = evaluate(PR_STATES, [pull({ labels: ["needs-work"] })], "review");
		expect(evaluation).toEqual({
			kind: "placement",
			state: PR_STATES[1],
			membership: expect.objectContaining({ identity: "github:github.com:P_5" }),
			added: ["ready-for-review"],
			removed: ["needs-work"],
			postLabels: ["ready-for-review"],
		});
	});

	test("a parked ticket places into the machine on a task a state offers", () => {
		// The ticket stands on the parking state: it matches, and the state
		// offers no task. The target choice reads the non-label conditions
		// only, so the parking match does not bar the placement.
		const states: WorkflowState[] = [
			{ name: "held", match: { sourceKind: "github-issue", labelsAny: ["held"] } },
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-review"] },
			},
		];
		const evaluation = evaluate(states, [issue({ labels: ["held"] })], "review");
		expect(evaluation).toEqual({
			kind: "placement",
			state: states[1],
			membership: expect.objectContaining({ identity: "github:github.com:I_5" }),
			added: ["ready-for-review"],
			removed: ["held"],
			postLabels: ["ready-for-review"],
		});
	});

	test("the severity and the priority labels stand through the write", () => {
		const evaluation = evaluate(
			PR_STATES,
			[pull({ labels: ["needs-work", "severity/high", "priority/1"] })],
			"review",
		);
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.removed).toEqual(["needs-work"]);
		expect(evaluation.postLabels).toEqual(["severity/high", "priority/1", "ready-for-review"]);
	});

	test("the write adds in the state's configured spelling, and skips a label the ticket already wears", () => {
		const states: WorkflowState[] = [
			{
				name: "needs-work",
				taskType: "rework",
				match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAny: ["Ready-For-Review"] },
			},
		];
		const evaluation = evaluate(
			states,
			[pull({ labels: ["needs-work", "ready-for-review"] })],
			"review",
		);
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.added).toEqual([]);
		expect(evaluation.removed).toEqual(["needs-work"]);
		expect(evaluation.postLabels).toEqual(["ready-for-review"]);
	});

	test("a state that names only all labels takes the ticket to the full set", () => {
		const states: WorkflowState[] = [
			{
				name: "done",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAll: ["approved", "merged"] },
			},
		];
		const placed = evaluate(states, [pull({ labels: [] })], "review");
		expect(placed.kind).toBe("placement");
		if (placed.kind !== "placement") return;
		expect(placed.added).toEqual(["approved", "merged"]);
		expect(placed.postLabels).toEqual(["approved", "merged"]);
	});

	test("the gate every state names stands through the write", () => {
		const states: WorkflowState[] = [
			{
				name: "needs-work",
				taskType: "rework",
				match: {
					sourceKind: "github-pull-request",
					labelsAll: ["pull-request"],
					labelsAny: ["needs-work"],
				},
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: {
					sourceKind: "github-pull-request",
					labelsAll: ["pull-request"],
					labelsAny: ["ready-for-review"],
				},
			},
		];
		const evaluation = evaluate(
			states,
			[pull({ labels: ["pull-request", "needs-work"] })],
			"review",
		);
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.removed).toEqual(["needs-work"]);
		expect(evaluation.postLabels).toEqual(["pull-request", "ready-for-review"]);
	});

	test("the gate one state names goes with the state the ticket leaves", () => {
		const states: WorkflowState[] = [
			{
				name: "needs-work",
				taskType: "rework",
				match: {
					sourceKind: "github-pull-request",
					labelsAll: ["pull-request"],
					labelsAny: ["needs-work"],
				},
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
			},
		];
		const evaluation = evaluate(
			states,
			[pull({ labels: ["pull-request", "needs-work"] })],
			"review",
		);
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.removed).toEqual(["pull-request", "needs-work"]);
		expect(evaluation.postLabels).toEqual(["ready-for-review"]);
	});

	test("the write runs on the newest membership the target state matches", () => {
		const states: WorkflowState[] = [
			{
				name: "needs-work",
				taskType: "rework",
				match: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] },
			},
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
			},
		];
		const older = pull({
			sourceName: "pulls",
			identity: "github:github.com:P_5",
			labels: [],
			externalUpdatedAt: "2026-08-31T10:00:00Z",
		});
		const newer = pull({
			sourceName: "pulls-b",
			identity: "github:github.com:P_6",
			labels: ["needs-work"],
			externalUpdatedAt: "2026-08-31T12:00:00Z",
		});
		const evaluation = evaluate(states, [issue(), older, newer], "review");
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.membership.identity).toBe("github:github.com:P_6");
		expect(evaluation.removed).toEqual(["needs-work"]);
		expect(evaluation.postLabels).toEqual(["ready-for-review"]);
	});

	test("the label comparison does not depend on case", () => {
		const evaluation = evaluate(PR_STATES, [pull({ labels: ["Needs-Work"] })], "review");
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.added).toEqual(["ready-for-review"]);
		expect(evaluation.removed).toEqual(["Needs-Work"]);
		expect(evaluation.postLabels).toEqual(["ready-for-review"]);
	});

	test("a repository condition reads the stored identity case-insensitive", () => {
		// The match value is the operator's string; the membership's identity
		// is canonical lowercase. The condition still holds on the target
		// walk, and the placement stands.
		const states: WorkflowState[] = [
			{
				name: "ready-for-review",
				taskType: "review",
				match: {
					sourceKind: "github-pull-request",
					repository: "github.com/Acme/Factory",
					labelsAny: ["ready-for-review"],
				},
			},
		];
		const evaluation = evaluate(
			states,
			[
				pull({
					repository: {
						identity: "github.com/acme/factory",
						displayName: "acme/factory",
						cloneUrl: "https://github.com/acme/factory.git",
					},
				}),
			],
			"review",
		);
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.added).toEqual(["ready-for-review"]);
		// A different repository still refuses the condition, whatever the
		// casing either side wears.
		const other = evaluate(
			states,
			[
				pull({
					repository: {
						identity: "github.com/acme/billing",
						displayName: "acme/billing",
						cloneUrl: "https://github.com/acme/billing.git",
					},
				}),
			],
			"review",
		);
		expect(other.kind).toBe("infeasible");
	});
});

describe("the idempotent rule", () => {
	test("a label set that already matches its spec takes no write", () => {
		const ticket = pull({ labels: ["needs-work"] });
		const first = evaluate(PR_STATES, [ticket], "review");
		expect(first.kind).toBe("placement");
		if (first.kind !== "placement") return;
		// The write lands: the source re-lists the ticket with the written
		// labels, and the rule re-run on the fresh snapshot takes no egress.
		const after = evaluate(PR_STATES, [pull({ ...ticket, labels: first.postLabels })], "review");
		expect(after).toEqual({ kind: "none" });
	});
});

describe("the infeasible faces", () => {
	test("a task type no matching state offers names the ticket's kind", () => {
		const evaluation = evaluate(PR_STATES, [issue({ labels: ["ready-for-agent"] })], "review");
		expect(evaluation).toEqual({
			kind: "infeasible",
			reason: "task type review is not offered by any state that matches a github-issue ticket",
		});
	});

	test("a task type no state offers at all refuses the same way", () => {
		const evaluation = evaluate(PR_STATES, [issue()], "fix");
		expect(evaluation).toEqual({
			kind: "infeasible",
			reason: "task type fix is not offered by any state that matches a github-issue ticket",
		});
	});

	test("a label the target state excludes stands on the ticket", () => {
		const states: WorkflowState[] = [
			{
				name: "ready-for-review",
				taskType: "review",
				match: {
					sourceKind: "github-pull-request",
					labelsAny: ["ready-for-review"],
					labelsNone: ["wip"],
				},
			},
		];
		const evaluation = evaluate(states, [pull({ labels: ["wip", "stale"] })], "review");
		expect(evaluation).toEqual({
			kind: "infeasible",
			reason: "state ready-for-review excludes label wip, and the ticket carries it",
		});
	});

	test("an earlier state that still matches and offers a different task names the state and the task", () => {
		const states: WorkflowState[] = [
			{ name: "intake", taskType: "triage", match: { sourceKind: "github-issue" } },
			{
				name: "ready",
				taskType: "fix",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
			},
		];
		const evaluation = evaluate(states, [issue({ labels: [] })], "fix");
		expect(evaluation).toEqual({
			kind: "infeasible",
			reason: "state intake still matches the ticket after the placement and offers task triage",
		});
	});

	test("an earlier state that still matches and offers no task names the state", () => {
		const states: WorkflowState[] = [
			{ name: "intake", match: { sourceKind: "github-issue" } },
			{
				name: "ready",
				taskType: "fix",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
			},
		];
		const evaluation = evaluate(states, [issue({ labels: [] })], "fix");
		expect(evaluation).toEqual({
			kind: "infeasible",
			reason: "state intake still matches the ticket after the placement and offers no task",
		});
	});

	test("two states that claim one label name both", () => {
		const states: WorkflowState[] = [
			{
				name: "first",
				taskType: "triage",
				match: { sourceKind: "github-issue", labelsAny: ["shared"] },
			},
			{
				name: "second",
				taskType: "implement",
				match: {
					sourceKind: "github-issue",
					labelsAll: ["shared"],
					labelsAny: ["ready-for-agent"],
				},
			},
		];
		const evaluation = evaluate(states, [issue({ labels: ["shared"] })], "implement");
		expect(evaluation).toEqual({
			kind: "infeasible",
			reason: "states first and second both claim label shared",
		});
	});

	test("an earlier state the write unmatches lets the placement stand", () => {
		const states: WorkflowState[] = [
			{
				name: "needs-triage",
				taskType: "triage",
				match: { sourceKind: "github-issue", labelsAny: ["needs-triage"] },
			},
			{
				name: "ready",
				taskType: "implement",
				match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
			},
		];
		const evaluation = evaluate(states, [issue({ labels: ["needs-triage"] })], "implement");
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		expect(evaluation.added).toEqual(["ready-for-agent"]);
		expect(evaluation.removed).toEqual(["needs-triage"]);
		expect(evaluation.postLabels).toEqual(["ready-for-agent"]);
	});

	test("a ticket listed on no source cannot be placed", () => {
		const evaluation = evaluate(PR_STATES, [], "review");
		expect(evaluation).toEqual({
			kind: "infeasible",
			reason: "the ticket lists on no source",
		});
	});
});

describe("the shared walk", () => {
	test("the placement's suggestion and the detection's suggestion never disagree", () => {
		const ticket = pull({ labels: ["needs-work"] });
		const evaluation = evaluate(PR_STATES, [ticket], "review");
		expect(evaluation.kind).toBe("placement");
		if (evaluation.kind !== "placement") return;
		// The state the placement names is the state the detection reads off
		// the written label set: the walk the fire uses, over the same
		// membership, lands where the placement says it will.
		expect(evaluation.state.name).toBe("ready-for-review");
		expect(evaluation.state.taskType).toBe("review");
	});
});
