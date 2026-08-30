/**
 * Consumer-level tests for the domain.
 *
 * These assert what a consumer of the module can observe: the ticket state
 * machine's transitions. The sample data contract is not tested here. It is
 * observed through the rendered terminal frame in the app tests, the same
 * way an operator would see it.
 */
import { describe, expect, test } from "vitest";

import {
	advanceTicket,
	canTransition,
	nextStateOf,
	TICKET_STATES,
	type Ticket,
} from "../src/domain/ticket.ts";

const TICKET: Ticket = {
	id: "1",
	title: "Sample",
	repository: "acme/one",
	state: "open",
	agent: null,
	githubClosed: false,
	description: "A sample ticket.",
};

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

	test("advanceTicket returns a new ticket in the next state", () => {
		const advanced = advanceTicket(TICKET);
		expect(advanced.state).toBe("handed-off");
		expect(advanced).not.toBe(TICKET);
		expect(TICKET.state).toBe("open");
	});

	test("advanceTicket refuses a done ticket", () => {
		expect(() => advanceTicket({ ...TICKET, state: "done" })).toThrow();
	});

	test("transitions only move forward one step", () => {
		expect(canTransition("open", "handed-off")).toBe(true);
		expect(canTransition("open", "running")).toBe(false);
		expect(canTransition("open", "open")).toBe(false);
		expect(canTransition("done", "open")).toBe(false);
	});
});
