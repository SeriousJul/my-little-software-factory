import type { Ticket } from "../src/domain/ticket.ts";

/** Deterministic tickets for legacy rendered-frame tests. */
function sample(
	externalKey: string,
	title: string,
	repository: string,
	state: Ticket["state"],
	description: string,
	handoff: Ticket["handoff"] = null,
	sourceState = "open",
): Ticket {
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
		description,
		sourceKind: "github-issue",
		externalKey,
		sourceState,
		url: `https://github.com/${repository}/issues/${externalKey.slice(1)}`,
		labels: [],
		externalUpdatedAt: "2026-01-01T00:00:00Z",
		memberships: [],
		suggestedTaskType: "implement",
		actionable: state === "open",
		handoffRecoveryRequired: false,
	};
}

export const SAMPLE_TICKETS: readonly Ticket[] = [
	sample(
		"#1",
		"Retry policy for webhooks",
		"acme/billing",
		"open",
		"Webhooks dropped during the outage were never redelivered. Add an exponential-backoff retry policy to the dispatcher, with a dead-letter queue for payloads that exhaust their retries.",
	),
	sample(
		"#2",
		"Fix pan drift in split panes",
		"acme/portal",
		"handed-off",
		"When the portal renders in a split terminal, the panes drift one row down after the first resize. Reproduce, find the off-by-one, and fix the layout math.",
		{ agentType: "codex", environment: "live-worktree", taskType: "implement" },
	),
	sample(
		"#3",
		"Migrate scheduler to clock",
		"acme/ingest",
		"running",
		"The cron-style scheduler still reads the wall clock directly. Migrate it to the injectable clock API so tests can freeze time and the scheduler becomes deterministic.",
		{ agentType: "pi", environment: "worktree", taskType: "fix" },
	),
	sample(
		"#4",
		"Drop the legacy auth shim",
		"acme/portal",
		"done",
		"The legacy auth shim that predated the token service has no remaining callers. Remove it and its feature flag.",
		{ agentType: "claude", environment: "live-worktree", taskType: "review" },
		"closed",
	),
	sample(
		"#5",
		"Observe the agent state",
		"acme/portal",
		"open",
		"The state line open to done moves only on its first step: the handoff steps an open ticket to handed-off. Observe the agent in herdr and step the ticket to running when the agent works and to done when it reports the work finished.",
	),
	sample(
		"#6",
		"Keep tickets across starts",
		"acme/billing",
		"open",
		"The tickets reset to the sample data on every start of the control plane. Persist the tickets and their states to a file so a restart finds the factory where it left it, and load the file in place of the sample data.",
	),
	sample(
		"#7",
		"Run the container environment",
		"acme/ingest",
		"open",
		"The container kind is known to the domain, but nothing can build one and the panel never offers it. Run a ticket in a disposable container with its image and its mounts, and offer the kind for a handoff.",
	),
	sample(
		"#8",
		"Put the ticket id in the name",
		"acme/portal",
		"open",
		"Two tickets whose titles share a long prefix get the same herdr agent name, and the second handoff fails on the taken name. Put a short ticket id into the name so a collision is not the discovery path.",
	),
];
