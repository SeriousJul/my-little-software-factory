import type { Ticket } from "../domain/ticket.ts";

/**
 * Built-in sample tickets.
 *
 * They span multiple repositories, cover every ticket state, and carry a
 * GitHub closed status as a source fact, so the control plane already shows
 * what real data will look like. Data resets on every start.
 */
export const SAMPLE_TICKETS: readonly Ticket[] = [
	{
		id: "1",
		title: "Retry policy for webhooks",
		repository: "acme/billing",
		state: "open",
		agent: null,
		githubClosed: false,
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
		agent: "codex",
		githubClosed: false,
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
		agent: "pi",
		githubClosed: false,
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
		agent: "claude-code",
		githubClosed: true,
		description:
			"The legacy auth shim that predated the token service has no remaining " +
			"callers. Remove it and its feature flag.",
	},
];
