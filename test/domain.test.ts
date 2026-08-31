/**
 * Consumer-level tests for the domain.
 *
 * These assert what a consumer of the module can observe: the ticket state
 * machine's transitions. The sample data contract is not tested here. It is
 * observed through the rendered terminal frame in the app tests, the same
 * way an operator would see it.
 */
import { describe, expect, test } from "vitest";

import { canTransition, TICKET_STATES } from "../src/domain/ticket.ts";

describe("the ticket state machine", () => {
	test("the state line is open, handed-off, running, awaiting", () => {
		expect(TICKET_STATES).toEqual(["open", "handed-off", "running", "awaiting"]);
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

	test("a workflow handoff or restart continues the cycle from awaiting", () => {
		expect(canTransition("awaiting", "handed-off")).toBe(true);
	});

	test("goto refocuses the existing agent", () => {
		expect(canTransition("awaiting", "running")).toBe(true);
	});

	test("transitions never move backward in the cycle", () => {
		expect(canTransition("open", "running")).toBe(false);
		expect(canTransition("open", "awaiting")).toBe(false);
		expect(canTransition("handed-off", "open")).toBe(false);
		expect(canTransition("running", "open")).toBe(false);
		expect(canTransition("running", "handed-off")).toBe(false);
	});

	test("a state is not its own transition", () => {
		for (const state of TICKET_STATES) expect(canTransition(state, state)).toBe(false);
	});
});
