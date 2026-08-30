/**
 * Consumer-level tests for the domain.
 *
 * These assert what a consumer of the module can observe: the ticket state
 * machine's transitions. The sample data contract is not tested here. It is
 * observed through the rendered terminal frame in the app tests, the same
 * way an operator would see it.
 */
import { describe, expect, test } from "vitest";

import { canTransition, nextStateOf, TICKET_STATES } from "../src/domain/ticket.ts";

describe("the ticket state machine", () => {
	test("the state line is open, handed-off, running, done", () => {
		expect(TICKET_STATES).toEqual(["open", "handed-off", "running", "done"]);
	});

	test("a ticket advances through the state line in order", () => {
		expect(nextStateOf("open")).toBe("handed-off");
		expect(nextStateOf("handed-off")).toBe("running");
		expect(nextStateOf("running")).toBe("done");
	});

	test("a done ticket has no next state", () => {
		expect(nextStateOf("done")).toBeNull();
	});

	test("transitions only move forward one step", () => {
		expect(canTransition("open", "handed-off")).toBe(true);
		expect(canTransition("open", "running")).toBe(false);
		expect(canTransition("open", "open")).toBe(false);
		expect(canTransition("done", "open")).toBe(false);
	});
});
