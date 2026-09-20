import { describe, expect, test } from "vitest";

import type { WorkflowState } from "../src/config.ts";
import type { SourceMembership } from "../src/domain/ticket.ts";
import { selectTaskType } from "../src/task-selection.ts";

/** The shipped order: the rework state before the review state. */
const STATES: WorkflowState[] = [
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

function membership(over: Partial<SourceMembership> = {}): SourceMembership {
	return {
		sourceName: "pulls",
		health: "healthy",
		identity: "github:github.com:P_5",
		sourceKind: "github-pull-request",
		externalKey: "#5",
		sourceState: "open",
		url: "https://github.com/acme/factory/pulls/5",
		title: "Add a webhook retry",
		description: "",
		labels: [],
		externalUpdatedAt: "2026-08-31T11:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
		...over,
	};
}

describe("state selection", () => {
	test("needs-work wins when both pull request labels are present", () => {
		expect(
			selectTaskType(
				[membership({ labels: ["needs-work", "ready-for-review"] })],
				STATES,
				"implement",
			),
		).toBe("rework");
	});

	test("ready-for-review alone selects review", () => {
		expect(
			selectTaskType([membership({ labels: ["ready-for-review"] })], STATES, "implement"),
		).toBe("review");
	});

	test("label comparison does not depend on case", () => {
		expect(selectTaskType([membership({ labels: ["Needs-Work"] })], STATES, "implement")).toBe(
			"rework",
		);
	});

	test("the first matching state wins, even when a later state also matches", () => {
		const states: WorkflowState[] = [
			{ name: "fix", taskType: "fix", match: { labelsAny: ["needs-work", "other-label"] } },
			{ name: "review", taskType: "review", match: { labelsAny: ["needs-work"] } },
		];
		expect(selectTaskType([membership({ labels: ["needs-work"] })], states, "implement")).toBe(
			"fix",
		);
	});

	test("a source-name condition selects only that source", () => {
		const states: WorkflowState[] = [
			{ name: "review", taskType: "review", match: { sourceName: "pulls" } },
		];
		expect(selectTaskType([membership({ sourceName: "issues" })], states, "implement")).toBe(
			"implement",
		);
		expect(selectTaskType([membership({ sourceName: "pulls" })], states, "implement")).toBe(
			"review",
		);
	});

	test("a repository condition matches the host-qualified identity", () => {
		const states: WorkflowState[] = [
			{ name: "review", taskType: "review", match: { repository: "gitlab.com/acme/billing" } },
		];
		expect(
			selectTaskType(
				[
					membership({
						repository: {
							identity: "github.com/acme/billing",
							displayName: "acme/billing",
							cloneUrl: "https://github.com/acme/billing.git",
						},
					}),
				],
				states,
				"implement",
			),
		).toBe("implement");
		expect(
			selectTaskType(
				[
					membership({
						repository: {
							identity: "gitlab.com/acme/billing",
							displayName: "acme/billing",
							cloneUrl: "https://gitlab.com/acme/billing.git",
						},
					}),
				],
				states,
				"implement",
			),
		).toBe("review");
	});

	test("labels-all requires every label and labels-none excludes", () => {
		const all: WorkflowState[] = [
			{ name: "review", taskType: "review", match: { labelsAll: ["needs-work", "draft"] } },
		];
		expect(selectTaskType([membership({ labels: ["needs-work"] })], all, "implement")).toBe(
			"implement",
		);
		expect(
			selectTaskType([membership({ labels: ["needs-work", "draft"] })], all, "implement"),
		).toBe("review");

		const none: WorkflowState[] = [
			{ name: "review", taskType: "review", match: { labelsNone: ["blocked"] } },
		];
		expect(selectTaskType([membership({ labels: ["blocked"] })], none, "implement")).toBe(
			"implement",
		);
		expect(selectTaskType([membership({ labels: ["ready-for-agent"] })], none, "implement")).toBe(
			"review",
		);
	});

	test("a state with no conditions matches every membership", () => {
		const states: WorkflowState[] = [{ name: "fix", taskType: "fix", match: {} }];
		expect(selectTaskType([membership()], states, "implement")).toBe("fix");
	});

	test("the fallback is used when no state matches", () => {
		expect(selectTaskType([membership({ labels: ["random-label"] })], STATES, "implement")).toBe(
			"implement",
		);
	});

	test("a parking state offers no task: the plane suggests nothing", () => {
		const states: WorkflowState[] = [{ name: "parked", match: { labelsAny: ["needs-work"] } }];
		// Null, not the fallback: the parking state matched, and the default
		// task type stands only when no state matches at all (ADR 0027).
		expect(
			selectTaskType([membership({ labels: ["needs-work"] })], states, "implement"),
		).toBeNull();
	});

	test("a matching membership from any source selects the state", () => {
		const states: WorkflowState[] = [
			{ name: "review", taskType: "review", match: { labelsAny: ["ready-for-review"] } },
		];
		expect(
			selectTaskType(
				[
					membership({ sourceName: "issues" }),
					membership({ sourceName: "pulls", labels: ["ready-for-review"] }),
				],
				states,
				"implement",
			),
		).toBe("review");
	});
});
