import type { Ticket } from "../domain/ticket.ts";

/**
 * Built-in sample tickets.
 *
 * They span multiple repositories, cover every ticket state, carry a
 * GitHub closed status as a source fact, and carry the facts of their last
 * handoff: the agent type, the environment, and the task type used. The
 * open ones are not handed off yet. Data resets on every start.
 */
export const SAMPLE_TICKETS: readonly Ticket[] = [
	{
		id: "1",
		title: "Retry policy for webhooks",
		repository: "acme/billing",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"Webhooks dropped during the outage were never redelivered. Add an " +
			"exponential-backoff retry policy to the dispatcher, with a dead-letter " +
			"queue for payloads that exhaust their retries.",
	},
	{
		id: "2",
		title: "Fix pan drift in split panes",
		repository: "acme/portal",
		state: "handed-off",
		githubClosed: false,
		handoff: { agentType: "codex", environment: "live-worktree", taskType: "implement" },
		description:
			"When the portal renders in a split terminal, the panes drift one row " +
			"down after the first resize. Reproduce, find the off-by-one, and fix " +
			"the layout math.",
	},
	{
		id: "3",
		title: "Migrate scheduler to clock",
		repository: "acme/ingest",
		state: "running",
		githubClosed: false,
		handoff: { agentType: "pi", environment: "worktree", taskType: "fix" },
		description:
			"The cron-style scheduler still reads the wall clock directly. Migrate " +
			"it to the injectable clock API so tests can freeze time and the " +
			"scheduler becomes deterministic.",
	},
	{
		id: "4",
		title: "Drop the legacy auth shim",
		repository: "acme/portal",
		state: "done",
		githubClosed: true,
		handoff: { agentType: "claude", environment: "live-worktree", taskType: "review" },
		description:
			"The legacy auth shim that predated the token service has no remaining " +
			"callers. Remove it and its feature flag.",
	},
	{
		id: "5",
		title: "Observe the agent state",
		repository: "acme/portal",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"The state line open to done moves only on its first step: the handoff " +
			"steps an open ticket to handed-off. Observe the agent in herdr and " +
			"step the ticket to running when the agent works and to done when it " +
			"reports the work finished.",
	},
	{
		id: "6",
		title: "Keep tickets across starts",
		repository: "acme/billing",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"The tickets reset to the sample data on every start of the control " +
			"plane. Persist the tickets and their states to a file so a restart " +
			"finds the factory where it left it, and load the file in place of " +
			"the sample data.",
	},
	{
		id: "7",
		title: "Run the container environment",
		repository: "acme/ingest",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"The container kind is known to the domain, but nothing can build one " +
			"and the panel never offers it. Run a ticket in a disposable " +
			"container with its image and its mounts, and offer the kind for a " +
			"handoff.",
	},
	{
		id: "8",
		title: "Put the ticket id in the name",
		repository: "acme/portal",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"Two tickets whose titles share a long prefix get the same herdr agent " +
			"name, and the second handoff fails on the taken name. Put a short " +
			"ticket id into the name so a collision is not the discovery path.",
	},
];
