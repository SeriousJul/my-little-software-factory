/**
 * Consumer-level tests for the domain.
 *
 * These assert what a consumer of the module can observe: the ticket state
 * machine's transitions. The sample data contract is not tested here. It is
 * observed through the rendered terminal frame in the app tests, the same
 * way an operator would see it.
 */
import { describe, expect, test } from "bun:test";
import type { Ticket, TicketState } from "../src/domain/ticket.ts";
import {
	attentionBand,
	canTransition,
	TICKET_STATES,
	ticketListRank,
} from "../src/domain/ticket.ts";

/** The list rank's one input besides the state: the external update. */
function ticket(state: TicketState, externalUpdatedAt = "2026-01-01T00:00:00Z"): Ticket {
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
		externalUpdatedAt,
		memberships: [],
		suggestedTaskType: "implement",
		actionable: state === "open",
		handoffRecoveryRequired: false,
		ignored: false,
		ignoredAt: null,
		leftover: null,
		matchedStateName: null,
	};
}

describe("the ticket state machine", () => {
	test("the state line is open, handed-off, running, awaiting, queued", () => {
		expect(TICKET_STATES).toEqual(["open", "handed-off", "running", "awaiting", "queued"]);
	});

	test("the route ask moves a settled ticket to queued (ADR 0067)", () => {
		expect(canTransition("awaiting", "queued")).toBe(true);
	});

	test("the pickup's start settles a queued ticket (ADR 0067)", () => {
		// The same-position route hands the ticket off in its own cycle.
		expect(canTransition("queued", "handed-off")).toBe(true);
		// The cross-position route ends the cycle and returns the ticket to
		// open, and the close does the same.
		expect(canTransition("queued", "open")).toBe(true);
	});

	test("a queued ticket rests: nothing else moves it", () => {
		expect(canTransition("queued", "awaiting")).toBe(false);
		expect(canTransition("queued", "running")).toBe(false);
		expect(canTransition("open", "queued")).toBe(false);
	});

	test("a work cycle walks open to handed-off to running to awaiting", () => {
		expect(canTransition("open", "handed-off")).toBe(true);
		expect(canTransition("handed-off", "running")).toBe(true);
		expect(canTransition("running", "awaiting")).toBe(true);
	});

	test("a settle may land directly from handed-off", () => {
		expect(canTransition("handed-off", "awaiting")).toBe(true);
	});

	test("close ends the work cycle back at open", () => {
		expect(canTransition("awaiting", "open")).toBe(true);
	});

	test("key w closes a cycle whose turn never settled (ADR 0031)", () => {
		expect(canTransition("handed-off", "open")).toBe(true);
		expect(canTransition("running", "open")).toBe(true);
	});

	test("a workflow handoff or restart continues the cycle from awaiting", () => {
		expect(canTransition("awaiting", "handed-off")).toBe(true);
	});

	test("the poll can move an awaiting ticket back to running", () => {
		// The agent works again on its still-pending turn: the poll reopens it
		// (ADR 0033 left the move to the poll, since Goto is navigation).
		expect(canTransition("awaiting", "running")).toBe(true);
	});

	test("transitions never move backward in the cycle", () => {
		expect(canTransition("open", "running")).toBe(false);
		expect(canTransition("open", "awaiting")).toBe(false);
		expect(canTransition("running", "handed-off")).toBe(false);
	});

	test("a state is not its own transition", () => {
		for (const state of TICKET_STATES) expect(canTransition(state, state)).toBe(false);
	});

	test("the attention band rides the queued wait into the in-flight band (ADR 0067)", () => {
		// The wait reads as the earliest stage of in-flight work: the awaiting
		// band holds only the turns that still owe a decision, and the queued
		// ticket stands before the running turn and the handoff that started
		// it.
		expect(attentionBand(ticket("awaiting"))).toBeLessThan(attentionBand(ticket("queued")));
		expect(attentionBand(ticket("queued"))).toBeLessThan(attentionBand(ticket("running")));
		expect(attentionBand(ticket("running"))).toBeLessThan(attentionBand(ticket("handed-off")));
		expect(attentionBand(ticket("handed-off"))).toBeLessThan(attentionBand(ticket("open")));
	});

	test("the list rank reads a queued ticket into the live band (ADR 0067)", () => {
		// The live ranks are negative and the open ranks non-negative, and the
		// newest external update is the smallest rank, so the queued ticket
		// ranks among the in-flight rows it belongs to.
		expect(ticketListRank(ticket("queued"))).toBeLessThan(0);
		const newer = ticket("queued", "2026-02-01T00:00:00Z");
		const older = ticket("queued", "2026-01-01T00:00:00Z");
		expect(ticketListRank(newer)).toBeLessThan(ticketListRank(older));
	});
});
