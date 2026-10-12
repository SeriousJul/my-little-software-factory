/**
 * The shared fact module (issue #362): the one place the suite's facts stand.
 *
 * The Seeded plane, the state aggregate suites, and the fact tests all read
 * their default facts from here: one default Ticket, one identity, one
 * repository, one derived herdr Agent name, one fetch outcome, one Handoff
 * choice, one set of workflow States. A rule cannot pass on a fixture no
 * other reader builds, because every reader builds the same record.
 */

import type { WorkflowState } from "../src/config.ts";
import type {
	Completion,
	FetchedTicket,
	Handoff,
	RepositoryRef,
	Ticket,
} from "../src/domain/ticket.ts";
import type { TicketFactInputs } from "../src/domain/ticket-facts.ts";
import type { HandoffChoice } from "../src/handoff.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import { agentNameFor } from "../src/naming.ts";
import { STARTUP_GRACE_MS } from "../src/observation.ts";
import type { WorkQueueHandoffItem, WorkQueueItem } from "../src/state/work-queue.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";

// ---------------------------------------------------------------------------
// The default Ticket: one identity, one title, one repository.
// ---------------------------------------------------------------------------

/** The default Ticket's identity. */
export const DEFAULT_IDENTITY = "github:github.com:I_9";

/** The default Ticket's title. */
export const DEFAULT_TICKET_TITLE = "Persist source facts";

/** The default Ticket's description. */
/**
 * The default Ticket's description.
 *
 * The frame suites read this text in the Ticket detail, where it must overflow
 * the pane at the frame sizes they pick, so it carries the weight a real
 * Ticket's body has: a few wrapped lines, and a final line the tests anchor
 * on their way to the pane's bottom.
 */
export const DEFAULT_TICKET_DESCRIPTION =
	"The control plane stores the source facts it fetches and keeps that store across starts and across handoffs, so a restart finds the plane where it left it, independent from GitHub.";

/** The default Ticket's labels. */
export const DEFAULT_TICKET_LABELS: readonly string[] = ["ready-for-agent"];

/** The default Ticket's repository, as the source records it. */
export const DEFAULT_REPOSITORY: RepositoryRef = {
	identity: "github.com/acme/factory",
	displayName: "acme/factory",
	cloneUrl: "https://github.com/acme/factory.git",
};

/**
 * One fetched Ticket: the default Ticket, with the caller's facts over it.
 *
 * The issue's number is the one its identity carries: a ticket I_6 is issue
 * #6, so the key and the number a rule reads off the key agree.
 */
export function fetchedTicket(over: Partial<FetchedTicket> = {}): FetchedTicket {
	const identity = over.identity ?? DEFAULT_IDENTITY;
	const number = /I_(\d+)$/.exec(identity)?.[1] ?? "5";
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${number}`,
		title: DEFAULT_TICKET_TITLE,
		description: DEFAULT_TICKET_DESCRIPTION,
		labels: [...DEFAULT_TICKET_LABELS],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: DEFAULT_REPOSITORY,
		attributes: {},
		...over,
	};
}

/**
 * One fetched issue on the shared sample repository.
 *
 * The issue's number is the one its identity carries: a ticket I_6 is
 * issue #6, so the key and the number a rule reads off the key agree.
 * The identity is a parameter of the builder, not the default Ticket's:
 * the default Ticket is `fetchedTicket`'s own standing, beside it.
 */
export function issueTicket(
	identity = "github:github.com:I_5",
	over: Partial<FetchedTicket> = {},
): FetchedTicket {
	const number = /I_(\d+)$/.exec(identity)?.[1] ?? "5";
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${number}`,
		title: "Add a webhook retry policy",
		description: "Webhooks dropped during the outage were never redelivered.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: DEFAULT_REPOSITORY,
		attributes: {},
		...over,
	};
}

/**
 * One fetched row as the resting Ticket row it stands for: the open state, no
 * Handoff, and the list facts the open row wears. A standing that wants a
 * live row names the handoff and the state beside it.
 */
export function ticketOf(fetched: FetchedTicket, over: Partial<Ticket> = {}): Ticket {
	return {
		identity: fetched.identity,
		title: fetched.title,
		repository: fetched.repository.displayName,
		repositoryRef: fetched.repository,
		state: "open",
		handoff: null,
		workCycle: 1,
		description: fetched.description,
		sourceKind: fetched.sourceKind,
		externalKey: fetched.externalKey,
		sourceState: fetched.sourceState,
		url: fetched.url,
		labels: [...fetched.labels],
		externalUpdatedAt: fetched.externalUpdatedAt,
		memberships: [],
		suggestedTaskType: "implement",
		matchedStateName: null,
		actionable: true,
		listActionable: true,
		handoffRecoveryRequired: false,
		handoffCount: 0,
		failedStartStreak: 0,
		lastCompletion: null,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
		nameCollision: null,
		...over,
	};
}

/**
 * The herdr name the naming rule gives the issue Ticket (ADR 0098): the agent
 * the plane's standing registers for the ticket a case seeds with it.
 */
export const DEFAULT_AGENT_NAME = agentNameFor(issueTicket());

// ---------------------------------------------------------------------------
// The fetch outcomes.
// ---------------------------------------------------------------------------

/** A success fetch at the shared time, listing the given tickets. */
export const fetchSuccess = (tickets: readonly FetchedTicket[]): FetchOutcome => ({
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [...tickets],
});

/** The failed fetch the suites share: the source's rate limit. */
export const fetchRateLimited: FetchOutcome = {
	status: "failed",
	reason: "GitHub rate limit exceeded",
};

// ---------------------------------------------------------------------------
// The Handoff choice and the workflow States.
// ---------------------------------------------------------------------------

/** The six-field Handoff choice the suites seed with, with the caller's over it. */
export function handoffChoice(over: Partial<HandoffChoice> = {}): HandoffChoice {
	return {
		agentType: "pi",
		environment: "live-worktree",
		taskType: "implement",
		model: "",
		thinking: "",
		contextWindow: "",
		...over,
	};
}

/**
 * The workflow States one projection read matches a ticket against: the
 * first match wins, a State with no task is a parking State, and no match at
 * all leaves the ticket on the fallback task type. The `position` grouping
 * reads the matched State's name, which the projection derives on every read
 * and never stores (issue #159).
 */
export const WORKFLOW_STATES: readonly WorkflowState[] = [
	{
		name: "ready-for-agent",
		taskType: "implement",
		match: { sourceKind: "github-issue", labelsAll: ["ready-for-agent"] },
	},
	{
		name: "needs-review",
		taskType: "review",
		match: { sourceKind: "github-issue", labelsAny: ["needs-review"] },
	},
	// A parking State: the plane suggests nothing and starts nothing on its own.
	{ name: "on-hold", match: { sourceKind: "github-issue", labelsAny: ["hold"] } },
];

// ---------------------------------------------------------------------------
// The domain records the fact tests build their inputs from.
// ---------------------------------------------------------------------------

/** The name the sample handoff's Agent started under. */
export const OWN_NAME = "sample-agent";

/**
 * The stable herdr name the naming rule gives the default Ticket (ADR 0098):
 * its title slug with its own identity tag.
 */
export const STABLE_NAME = agentNameFor({
	identity: DEFAULT_IDENTITY,
	title: DEFAULT_TICKET_TITLE,
});

/** The fixture's now, in milliseconds: twelve hours after the fixture's start. */
export const FACT_NOW = Date.parse("2026-01-01T12:00:00Z");

/** The fixture's start time, twelve hours before the fixture's now. */
export const FACT_STARTED_AT = "2026-01-01T00:00:00Z";

export function handoff(over: Partial<Handoff> = {}): Handoff {
	return {
		agentType: "pi",
		environment: "worktree",
		taskType: "implement",
		model: "",
		thinking: "",
		contextWindow: "",
		attemptId: "attempt-1",
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
		herdrName: OWN_NAME,
		startedAt: FACT_STARTED_AT,
		...over,
	};
}

export function completion(over: Partial<Completion> = {}): Completion {
	return {
		taskType: "review",
		transition: null,
		agentType: "pi",
		agentName: "factory-review-I_5",
		model: "",
		thinking: "",
		contextWindow: "",
		completedAt: "2026-01-01T12:00:00Z",
		message: "",
		turnLog: [],
		cause: "completed",
		detail: "",
		decision: null,
		...over,
	};
}

/** One domain Ticket: the default Ticket, open, with a suggestion, and nothing else. */
export function ticket(over: Partial<Ticket> = {}): Ticket {
	return {
		identity: DEFAULT_IDENTITY,
		title: DEFAULT_TICKET_TITLE,
		repository: DEFAULT_REPOSITORY.displayName,
		repositoryRef: DEFAULT_REPOSITORY,
		state: "open",
		handoff: null,
		workCycle: 1,
		handoffCount: 0,
		failedStartStreak: 0,
		lastCompletion: null,
		description: DEFAULT_TICKET_DESCRIPTION,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/5`,
		labels: [...DEFAULT_TICKET_LABELS],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		memberships: [],
		suggestedTaskType: "implement",
		matchedStateName: null,
		actionable: true,
		listActionable: true,
		handoffRecoveryRequired: false,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
		nameCollision: null,
		...over,
	};
}

/** One agent as a poll reports it. */
export function agent(over: Partial<HerdrAgent> = {}): HerdrAgent {
	return {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
		name: OWN_NAME,
		agent: "pi",
		status: "working",
		sessionId: "",
		...over,
	};
}

/** The Ticket fact module's environment, with nothing held. */
export function factInputs(over: Partial<TicketFactInputs> = {}): TicketFactInputs {
	return {
		maxHandoffsPerTicket: 10,
		poll: null,
		claims: new Set<string>(),
		queue: [],
		now: FACT_NOW,
		startupGraceMs: STARTUP_GRACE_MS,
		...over,
	};
}

/** One Work queue item that holds a start for one Ticket. */
export function queueItem(
	ticketIdentity: string,
	origin: "open" | "workflow",
	over: Partial<WorkQueueHandoffItem> = {},
): WorkQueueItem {
	return {
		kind: "handoff",
		position: 1,
		ticketIdentity,
		automatic: origin === "workflow",
		routeFromIdentity: origin === "workflow" ? ticketIdentity : null,
		origin,
		choice: handoffChoice({ environment: "worktree" }),
		previousMessage: "",
		enqueuedAt: "2026-01-01T00:00:00Z",
		...over,
	};
}

// ---------------------------------------------------------------------------
// The sample sequence the frame tests read: one sample Ticket per state of
// the list, the rows they scroll, select, and filter.
// ---------------------------------------------------------------------------

/** One sample row's stored handoff, in the sample's own words. */
function sampleHandoff(
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

/** One sample Ticket row, standing beside the state the row names. */
function sampleTicket(fields: {
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
	sampleTicket({
		externalKey: "#1",
		title: "Retry policy for webhooks",
		repository: "acme/billing",
		state: "open",
		description:
			"Webhooks dropped during the outage were never redelivered. Add an exponential-backoff retry policy to the dispatcher, with a dead-letter queue for payloads that exhaust their retries.",
	}),
	sampleTicket({
		externalKey: "#2",
		title: "Fix pan drift in split panes",
		repository: "acme/portal",
		state: "handed-off",
		description:
			"When the portal renders in a split terminal, the panes drift one row down after the first resize. Reproduce, find the off-by-one, and fix the layout math.",
		handoff: sampleHandoff("codex", "live-worktree", "implement"),
		sourceState: "open",
		handoffCount: 1,
	}),
	sampleTicket({
		externalKey: "#3",
		title: "Migrate scheduler to clock",
		repository: "acme/ingest",
		state: "running",
		description:
			"The cron-style scheduler still reads the wall clock directly. Migrate it to the injectable clock API so tests can freeze time and the scheduler becomes deterministic.",
		handoff: sampleHandoff("pi", "worktree", "fix"),
		sourceState: "open",
		handoffCount: 2,
	}),
	sampleTicket({
		externalKey: "#4",
		title: "Drop the legacy auth shim",
		repository: "acme/portal",
		state: "awaiting",
		description:
			"The legacy auth shim that predated the token service has no remaining callers. Remove it and its feature flag.",
		handoff: sampleHandoff("claude", "live-worktree", "review"),
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
	sampleTicket({
		externalKey: "#5",
		title: "Observe the agent state",
		repository: "acme/portal",
		state: "open",
		description:
			"The state line open to awaiting moves only on its first step: the handoff steps an open ticket to handed-off. Observe the agent in herdr and step the ticket to running when the agent works and to awaiting when it reports the work finished.",
	}),
	sampleTicket({
		externalKey: "#6",
		title: "Keep tickets across starts",
		repository: "acme/billing",
		state: "open",
		description:
			"The tickets reset to the sample data on every start of the control plane. Persist the tickets and their states to a file so a restart finds the factory where it left it, and load the file in place of the sample data.",
	}),
	sampleTicket({
		externalKey: "#7",
		title: "Run the container env",
		repository: "acme/ingest",
		state: "open",
		description:
			"The container kind is known to the domain, but nothing can build one and the panel never offers it. Run a ticket in a disposable container with its image and its mounts, and offer the kind for a handoff.",
	}),
	sampleTicket({
		externalKey: "#8",
		title: "Ticket id in the agent name",
		repository: "acme/portal",
		state: "open",
		description:
			"Two tickets whose titles share a long prefix get the same herdr agent name, and the second handoff fails on the taken name. Put a short ticket id into the name so a collision is not the discovery path.",
	}),
];
