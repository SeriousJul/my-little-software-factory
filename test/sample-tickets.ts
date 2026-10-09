import type { Completion, Handoff, Ticket } from "../src/domain/ticket.ts";

function handoff(
	agentType: string,
	environment: Handoff["environment"],
	taskType: string,
): Handoff {
	return {
		agentType,
		environment,
		taskType,
		model: "",
		thinking: "",
		contextWindow: "",
		attemptId: `attempt-${taskType}`,
		paneId: `pane-${taskType}`,
		tabId: `tab-${taskType}`,
		workspaceId: `workspace-${taskType}`,
		herdrName: "sample-agent",
	};
}

/** Deterministic tickets for the rendered-frame tests. */
function sample(fields: {
	externalKey: string;
	title: string;
	repository: string;
	state: Ticket["state"];
	description: string;
	handoff?: Handoff | null;
	sourceState?: string;
	handoffCount?: number;
	lastCompletion?: Completion | null;
	failedStartStreak?: number;
}): Ticket {
	const {
		externalKey,
		title,
		repository,
		state,
		description,
		handoff = null,
		sourceState = "open",
		handoffCount = 0,
		lastCompletion = null,
		failedStartStreak = 0,
	} = fields;
	return {
		identity: `github:github.com:I_${externalKey.slice(1)}`,
		title,
		repository,
		repositoryRef: {
			identity: `github.com/${repository}`,
			displayName: repository,
			cloneUrl: `https://github.com/${repository}.git`,
		},
		state,
		handoff,
		workCycle: handoff === null ? 1 : 2,
		description,
		sourceKind: "github-issue",
		externalKey,
		sourceState,
		url: `https://github.com/${repository}/issues/${externalKey.slice(1)}`,
		labels: [],
		externalUpdatedAt: "2026-01-01T00:00:00Z",
		memberships: [],
		suggestedTaskType: "implement",
		matchedStateName: null,
		actionable: state === "open",
		listActionable: state === "open",
		handoffRecoveryRequired: false,
		handoffCount,
		failedStartStreak,
		lastCompletion,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
		nameCollision: null,
	};
}

export const SAMPLE_TICKETS: readonly Ticket[] = [
	sample({
		externalKey: "#1",
		title: "Retry policy for webhooks",
		repository: "acme/billing",
		state: "open",
		description:
			"Webhooks dropped during the outage were never redelivered. Add an exponential-backoff retry policy to the dispatcher, with a dead-letter queue for payloads that exhaust their retries.",
	}),
	sample({
		externalKey: "#2",
		title: "Fix pan drift in split panes",
		repository: "acme/portal",
		state: "handed-off",
		description:
			"When the portal renders in a split terminal, the panes drift one row down after the first resize. Reproduce, find the off-by-one, and fix the layout math.",
		handoff: handoff("codex", "live-worktree", "implement"),
		sourceState: "open",
		handoffCount: 1,
	}),
	sample({
		externalKey: "#3",
		title: "Migrate scheduler to clock",
		repository: "acme/ingest",
		state: "running",
		description:
			"The cron-style scheduler still reads the wall clock directly. Migrate it to the injectable clock API so tests can freeze time and the scheduler becomes deterministic.",
		handoff: handoff("pi", "worktree", "fix"),
		sourceState: "open",
		handoffCount: 2,
	}),
	sample({
		externalKey: "#4",
		title: "Drop the legacy auth shim",
		repository: "acme/portal",
		state: "awaiting",
		description:
			"The legacy auth shim that predated the token service has no remaining callers. Remove it and its feature flag.",
		handoff: handoff("claude", "live-worktree", "review"),
		sourceState: "closed",
		handoffCount: 1,
		lastCompletion: {
			taskType: "review",
			agentName: "factory-review-I_4",
			agentType: "claude",
			model: "",
			thinking: "",
			contextWindow: "",
			message:
				"The auth shim and its flag are removed.\nAll 142 tests pass. I left the migration note in docs/auth.md.",
			turnLog: [
				{ kind: "text", text: "I removed the legacy auth shim and its feature flag." },
				{ kind: "tool", name: "bash", target: "rg -n auth_shim src", failed: false },
				{
					kind: "text",
					text: "The auth shim and its flag are removed.\nAll 142 tests pass. I left the migration note in docs/auth.md.",
				},
			],
			decision: null,
			transition: null,
			completedAt: "2026-01-01T12:00:00Z",
			cause: "completed",
			detail: "",
		},
	}),
	sample({
		externalKey: "#5",
		title: "Observe the agent state",
		repository: "acme/portal",
		state: "open",
		description:
			"The state line open to awaiting moves only on its first step: the handoff steps an open ticket to handed-off. Observe the agent in herdr and step the ticket to running when the agent works and to awaiting when it reports the work finished.",
	}),
	sample({
		externalKey: "#6",
		title: "Keep tickets across starts",
		repository: "acme/billing",
		state: "open",
		description:
			"The tickets reset to the sample data on every start of the control plane. Persist the tickets and their states to a file so a restart finds the factory where it left it, and load the file in place of the sample data.",
	}),
	sample({
		externalKey: "#7",
		title: "Run the container env",
		repository: "acme/ingest",
		state: "open",
		description:
			"The container kind is known to the domain, but nothing can build one and the panel never offers it. Run a ticket in a disposable container with its image and its mounts, and offer the kind for a handoff.",
	}),
	sample({
		externalKey: "#8",
		title: "Ticket id in the agent name",
		repository: "acme/portal",
		state: "open",
		description:
			"Two tickets whose titles share a long prefix get the same herdr agent name, and the second handoff fails on the taken name. Put a short ticket id into the name so a collision is not the discovery path.",
	}),
];
