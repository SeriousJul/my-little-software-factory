/**
 * The fixtures the fact tests build their inputs from (issue #201).
 *
 * The fact modules are pure, so a test hands them a record and reads the
 * answer. These builders state one Ticket's facts the way the projection would,
 * and every fact test takes the same record, so a rule cannot pass on a fixture
 * no other reader would build.
 */
import type { Completion, Handoff, Ticket } from "../src/domain/ticket.ts";
import type { TicketFactInputs } from "../src/domain/ticket-facts.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import type { WorkQueueHandoffItem, WorkQueueItem } from "../src/state/work-queue.ts";

/** The name the sample handoff's Agent started under. */
export const OWN_NAME = "sample-agent";

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
		...over,
	};
}

export function completion(over: Partial<Completion> = {}): Completion {
	return {
		taskType: "review",
		transition: null,
		agentType: "pi",
		agentName: "factory-review-I_1",
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

/** One Ticket: open, with a suggestion, and nothing else. */
export function ticket(over: Partial<Ticket> = {}): Ticket {
	return {
		identity: "github:github.com:I_1",
		title: "Retry policy for webhooks",
		repository: "acme/billing",
		repositoryRef: {
			identity: "github.com/acme/billing",
			displayName: "acme/billing",
			cloneUrl: "",
		},
		state: "open",
		handoff: null,
		workCycle: 1,
		handoffCount: 0,
		lastCompletion: null,
		description: "",
		sourceKind: "github-issue",
		externalKey: "#1",
		sourceState: "open",
		url: "",
		labels: [],
		externalUpdatedAt: "2026-01-01T00:00:00Z",
		memberships: [],
		suggestedTaskType: "implement",
		matchedStateName: null,
		actionable: true,
		handoffRecoveryRequired: false,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
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

/** The Ticket fact module's inputs, with nothing held. */
export function factInputs(over: Partial<TicketFactInputs> = {}): TicketFactInputs {
	return {
		maxHandoffsPerTicket: 10,
		poll: null,
		claims: new Set<string>(),
		queue: [],
		tickets: [],
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
		choice: {
			agentType: "pi",
			environment: "worktree",
			taskType: "implement",
			model: "",
			thinking: "",
			contextWindow: "",
		},
		previousMessage: "",
		enqueuedAt: "2026-01-01T00:00:00Z",
		...over,
	};
}
