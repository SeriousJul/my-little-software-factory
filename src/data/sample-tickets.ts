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
		title: "Show handoff facts in detail",
		repository: "acme/portal",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"The detail pane shows the repository and the state. Add the agent " +
			"type, the environment, and the task type of the last handoff, so the " +
			"operator sees who picked up the ticket without leaving the pane.",
	},
	{
		id: "6",
		title: "Read defaults from config",
		repository: "acme/billing",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"The defaults live in code. Read them from a TOML config file: the " +
			"shipped defaults when the file is missing, a readable error when the " +
			"file is invalid, and the defaults in one place for the operators.",
	},
	{
		id: "7",
		title: "Run handoff via one runner",
		repository: "acme/ingest",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"The handoff shells out to herdr and to git. Run every command through " +
			"one injected runner so the tests fake the egress and never touch a " +
			"real herdr session or a real repository.",
	},
	{
		id: "8",
		title: "Show handoff failures below",
		repository: "acme/portal",
		state: "open",
		githubClosed: false,
		handoff: null,
		description:
			"A failed handoff is silent today. Show the outcome in a status line " +
			"under the panes: the failure reason, or the warning a bent " +
			"resolution carries. The ticket stays open until the agent starts.",
	},
];
