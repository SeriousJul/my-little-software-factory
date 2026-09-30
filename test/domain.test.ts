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
		muted: false,
		mutedAt: null,
		leftover: null,
		matchedStateName: null,
	};
}

describe("the ticket state machine", () => {
	test("the state line is open, handed-off, running, awaiting", () => {
		expect(TICKET_STATES).toEqual(["open", "handed-off", "running", "awaiting"]);
	});

	test("the route ask ends the source's cycle at the ask (ADR 0072)", () => {
		// The ask moves the source to open with the cycle incremented, and the
		// wait stands on the Work queue's item, not on a ticket state.
		expect(canTransition("awaiting", "open")).toBe(true);
		// The route's start is the ticket's next cycle, so it starts from open
		// the way any handoff does.
		expect(canTransition("open", "handed-off")).toBe(true);
		// The ask never waits on a run: it does not hold the source in a wait
		// state.
		expect(canTransition("open", "awaiting")).toBe(false);
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

	test("the attention band holds the in-flight band and the open band (ADR 0072)", () => {
		// The awaiting band holds only the turns that still owe a decision. A
		// routed ticket rests open behind the wait (ADR 0072), so it stands in
		// the open band with the rows it belongs to, not in the in-flight band.
		expect(attentionBand(ticket("awaiting"))).toBeLessThan(attentionBand(ticket("running")));
		expect(attentionBand(ticket("running"))).toBeLessThan(attentionBand(ticket("handed-off")));
		expect(attentionBand(ticket("handed-off"))).toBeLessThan(attentionBand(ticket("open")));
	});

	test("the list rank reads a routed ticket into the open band (ADR 0072)", () => {
		// The wait is the item's, not a ticket state, so the routed ticket ranks
		// among the open rows it belongs to, by the open band's external key
		// order, the way any open row does.
		expect(ticketListRank({ ...ticket("open"), externalKey: "#5" })).toBeLessThan(
			ticketListRank({ ...ticket("open"), externalKey: "#10" }),
		);
	});
});
