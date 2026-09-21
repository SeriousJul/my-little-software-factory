/**
 * The base config the app-level suites spread and override.
 *
 * It is test data, not a product default: the control plane carries no
 * in-code config object. The shipped Default configuration is the TOML at
 * config/default.toml, which seeds a missing Config file at the config load
 * seam, and it is pinned by test/config.test.ts.
 */
import type { FactoryConfig } from "../src/config.ts";

export const BASE_CONFIG: FactoryConfig = {
	defaultAgent: "pi",
	defaultEnvironment: "live-worktree",
	defaultTaskType: "implement",
	agents: {
		pi: {
			kind: "pi",
			model: "--model {value}",
			thinking: "--thinking {value}",
			thinkingValues: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		},
		codex: {
			kind: "codex",
			model: "--model {value}",
			thinking: "-c model_reasoning_effort={value}",
			thinkingValues: ["minimal", "low", "medium", "high"],
		},
		claude: {
			kind: "claude",
			model: "--model {value}",
			thinking: "--effort {value}",
			thinkingValues: ["low", "medium", "high", "xhigh", "max"],
		},
	},
	consultationTypes: {},
	attentionBell: true,
	interactionExitKey: "f12",
	taskTypes: {
		implement: {
			template:
				"Implement the following {source-kind}.\n\nRepository: {repository}\n\n" +
				"{external-key}: {title}\n\nURL: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
		fix: {
			template:
				"Fix the following {source-kind}.\n\nRepository: {repository}\n\n" +
				"{external-key}: {title}\n\nURL: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
		review: {
			template:
				"Review pull request {external-key}: {title}.\n\nRepository: {repository}\n" +
				"Pull request: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
		rework: {
			template:
				"Rework pull request {external-key}: {title}.\n\nRepository: {repository}\n" +
				"Pull request: {source-url}\n\nLabels: {labels}\n\nDescription:\n{description}",
		},
	},
	maxParallelAgents: 2,
	agentPollIntervalSeconds: 5,
	completionMessageLines: 200,
	maxHandoffsPerTicket: 10,
	scroll: { speed: 1, acceleration: 0.8, maximumSpeed: 6 },
	repos: {},
	sources: [],
	workflowStates: [
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
	],
};
