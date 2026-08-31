import { describe, expect, test } from "vitest";

import type { TaskRule } from "../src/config.ts";
import type { SourceMembership } from "../src/domain/ticket.ts";
import { selectTaskType } from "../src/task-selection.ts";

/** The shipped order: rework rules before review rules. */
const RULES: TaskRule[] = [
	{ taskType: "rework", when: { sourceKind: "github-pull-request", labelsAny: ["needs-work"] } },
	{
		taskType: "review",
		when: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
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

describe("task rule selection", () => {
	test("needs-work wins when both pull request labels are present", () => {
		expect(
			selectTaskType(
				[membership({ labels: ["needs-work", "ready-for-review"] })],
				RULES,
				"implement",
			),
		).toBe("rework");
	});

	test("ready-for-review alone selects review", () => {
		expect(selectTaskType([membership({ labels: ["ready-for-review"] })], RULES, "implement")).toBe(
			"review",
		);
	});

	test("label comparison does not depend on case", () => {
		expect(selectTaskType([membership({ labels: ["Needs-Work"] })], RULES, "implement")).toBe(
			"rework",
		);
	});

	test("the first matching rule wins, even when a later rule also matches", () => {
		const rules: TaskRule[] = [
			{ taskType: "fix", when: { labelsAny: ["needs-work", "other-label"] } },
			{ taskType: "review", when: { labelsAny: ["needs-work"] } },
		];
		expect(selectTaskType([membership({ labels: ["needs-work"] })], rules, "implement")).toBe(
			"fix",
		);
	});

	test("a source-name condition selects only that source", () => {
		const rules: TaskRule[] = [{ taskType: "review", when: { sourceName: "pulls" } }];
		expect(selectTaskType([membership({ sourceName: "issues" })], rules, "implement")).toBe(
			"implement",
		);
		expect(selectTaskType([membership({ sourceName: "pulls" })], rules, "implement")).toBe(
			"review",
		);
	});

	test("a repository condition matches the host-qualified identity", () => {
		const rules: TaskRule[] = [
			{ taskType: "review", when: { repository: "gitlab.com/acme/billing" } },
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
				rules,
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
				rules,
				"implement",
			),
		).toBe("review");
	});

	test("labels-all requires every label and labels-none excludes", () => {
		const all: TaskRule[] = [{ taskType: "review", when: { labelsAll: ["needs-work", "draft"] } }];
		expect(selectTaskType([membership({ labels: ["needs-work"] })], all, "implement")).toBe(
			"implement",
		);
		expect(
			selectTaskType([membership({ labels: ["needs-work", "draft"] })], all, "implement"),
		).toBe("review");

		const none: TaskRule[] = [{ taskType: "review", when: { labelsNone: ["blocked"] } }];
		expect(selectTaskType([membership({ labels: ["blocked"] })], none, "implement")).toBe(
			"implement",
		);
		expect(selectTaskType([membership({ labels: ["ready-for-agent"] })], none, "implement")).toBe(
			"review",
		);
	});

	test("a rule with no conditions matches every membership", () => {
		const rules: TaskRule[] = [{ taskType: "fix", when: {} }];
		expect(selectTaskType([membership()], rules, "implement")).toBe("fix");
	});

	test("the fallback is used when no rule matches", () => {
		expect(selectTaskType([membership({ labels: ["random-label"] })], RULES, "implement")).toBe(
			"implement",
		);
	});

	test("a matching membership from any source selects the rule", () => {
		const rules: TaskRule[] = [{ taskType: "review", when: { labelsAny: ["ready-for-review"] } }];
		expect(
			selectTaskType(
				[
					membership({ sourceName: "issues" }),
					membership({ sourceName: "pulls", labels: ["ready-for-review"] }),
				],
				rules,
				"implement",
			),
		).toBe("review");
	});
});
