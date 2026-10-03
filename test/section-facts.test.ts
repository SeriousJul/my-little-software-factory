/**
 * The Section header's facts, tested at the fact module's interface (issue #201).
 *
 * The header takes its counts as values and paints them; it holds no rule of its
 * own. The counts come from the active view, so the operator's List filter never
 * moves them (ADR 0060). The bell rule is read here too: a rise rings it and
 * nothing else does.
 */
import { describe, expect, test } from "bun:test";
import { heldBellRang, type SectionFactInputs, sectionFacts } from "../src/domain/section-facts.ts";
import type { Completion, Ticket } from "../src/domain/ticket.ts";
import type { Consultation, ConsultationState, WorkQueueItem } from "../src/state.ts";

function ticket(state: Ticket["state"], over: Partial<Ticket> = {}): Ticket {
	return {
		identity: `github:github.com:I_${state}`,
		title: `the ${state} ticket`,
		repository: "acme/billing",
		repositoryRef: {
			identity: "github.com/acme/billing",
			displayName: "acme/billing",
			cloneUrl: "",
		},
		state,
		handoff: null,
		workCycle: 1,
		handoffCount: 0,
		lastCompletion: null,
		description: "",
		sourceKind: "github-issue",
		externalKey: `#${state}`,
		sourceState: "open",
		url: "",
		labels: [],
		externalUpdatedAt: "2026-01-01T00:00:00Z",
		memberships: [],
		suggestedTaskType: null,
		matchedStateName: null,
		actionable: state === "open",
		handoffRecoveryRequired: false,
		ignored: false,
		ignoredAt: null,
		muted: false,
		mutedAt: null,
		leftover: null,
		...over,
	};
}

/** An awaiting Ticket whose settled turn holds its decision. */
function heldTicket(): Ticket {
	const completion: Completion = {
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
		cause: "failed",
		detail: "",
		decision: null,
	};
	return ticket("awaiting", { lastCompletion: completion });
}

/** One Consultation record, with only the state the header counts. */
function consultation(state: ConsultationState): Consultation {
	return {
		id: `consultation-${state}`,
		typeName: "review",
		agentType: "pi",
		environment: "worktree",
		model: "",
		thinking: "",
		contextWindow: "",
		template: "",
		initialInput: "",
		renderedOpeningPrompt: "",
		repository: { identity: "", displayName: "", cloneUrl: "", path: "" },
		state,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		agentName: "",
		paneId: null,
		tabId: null,
		workspaceId: null,
		sessionId: null,
		latestSequence: null,
		draft: "",
		draftUpdatedAt: null,
		draftOld: false,
		failure: null,
		warning: null,
		replacementOf: null,
		closeResult: null,
		attentionAt: null,
		pendingResponse: null,
		resources: [],
	};
}

/** The section fact module's inputs, with nothing counted. */
function inputs(over: Partial<SectionFactInputs>): SectionFactInputs {
	return { tickets: [], consultations: [], queue: [], ignored: 0, muted: 0, ...over };
}

describe("the Ticket header's counts", () => {
	test("the steady pipeline counts name the active view's rows", () => {
		const facts = sectionFacts(
			inputs({
				tickets: [ticket("open"), ticket("handed-off"), ticket("running"), ticket("awaiting")],
			}),
		);
		expect(facts.ticket.open).toBe(1);
		expect(facts.ticket.inFlight).toBe(2);
		expect(facts.ticket.awaiting).toBe(1);
		expect(facts.ticket.held).toBe(0);
	});

	test("the held count names only the turns that hold their decision", () => {
		const facts = sectionFacts({
			tickets: [ticket("awaiting"), heldTicket()],
			consultations: [],
			queue: [],
			ignored: 0,
			muted: 0,
		});
		expect(facts.ticket.awaiting).toBe(2);
		expect(facts.ticket.held).toBe(1);
	});

	test("the ignored and muted counts are the list step's answers, passed through", () => {
		// The numbers name exactly the rows the `ignored` and `muted` views show:
		// no rule is re-applied here (ADR 0060, ADR 0070).
		const facts = sectionFacts({
			tickets: [ticket("open")],
			consultations: [],
			queue: [],
			ignored: 3,
			muted: 2,
		});
		expect(facts.ticket.ignored).toBe(3);
		expect(facts.ticket.muted).toBe(2);
	});
});

describe("the Consultation header's counts", () => {
	test("the awaiting response count names the records that wait for the operator", () => {
		const facts = sectionFacts(
			inputs({ consultations: [consultation("awaiting-response"), consultation("working")] }),
		);
		expect(facts.consultation.awaitingResponse).toBe(1);
		expect(facts.consultation.recovery).toBe(0);
	});

	test("the recovery count names every state that needs it", () => {
		const facts = sectionFacts(
			inputs({
				consultations: [
					consultation("missing"),
					consultation("failed"),
					consultation("opening"),
					consultation("closing"),
				],
			}),
		);
		expect(facts.consultation.recovery).toBe(4);
	});

	test("a closed Consultation stands in neither count", () => {
		const facts = sectionFacts(
			inputs({ consultations: [consultation("closed"), consultation("awaiting-response")] }),
		);
		expect(facts.consultation.awaitingResponse).toBe(1);
		expect(facts.consultation.recovery).toBe(0);
	});
});

describe("the Work header's depth", () => {
	test("the count names the items the queue holds", () => {
		const item: WorkQueueItem = {
			kind: "handoff",
			position: 1,
			ticketIdentity: "github:github.com:I_open",
			automatic: false,
			routeFromIdentity: null,
			origin: "open",
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
		};
		expect(sectionFacts(inputs({ queue: [item] })).work.waiting).toBe(1);
	});
});

describe("the held bell", () => {
	test("a rise rings the bell", () => {
		expect(heldBellRang(1, 2)).toBe(true);
	});

	test("a fall does not", () => {
		expect(heldBellRang(2, 1)).toBe(false);
	});

	test("a steady count does not", () => {
		expect(heldBellRang(2, 2)).toBe(false);
	});

	test("the first read compares nothing", () => {
		expect(heldBellRang(null, 3)).toBe(false);
	});
});
