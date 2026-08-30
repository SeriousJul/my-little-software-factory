/**
 * Consumer-level tests for the domain and the built-in data.
 *
 * These assert what a consumer of the module can observe: the ticket state
 * machine's transitions and the shape of the sample ticket set.
 */
import { describe, expect, test } from "vitest";

import { SAMPLE_TICKETS } from "../src/data/sample-tickets.ts";
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
	test("the pipeline is open, handed-off, running, done", () => {
		expect(TICKET_STATES).toEqual(["open", "handed-off", "running", "done"]);
	});

	test("a ticket advances one step forward at a time", () => {
		let ticket = TICKET;
		ticket = advanceTicket(ticket);
		expect(ticket.state).toBe("handed-off");
		ticket = advanceTicket(ticket);
		expect(ticket.state).toBe("running");
		ticket = advanceTicket(ticket);
		expect(ticket.state).toBe("done");
	});

	test("advanceTicket does not mutate the input", () => {
		const moved = advanceTicket(TICKET);
		expect(moved).not.toBe(TICKET);
		expect(TICKET.state).toBe("open");
	});

	test("a done ticket cannot advance", () => {
		const done = { ...TICKET, state: "done" as const };
		expect(() => advanceTicket(done)).toThrow();
	});

	test("only forward steps are allowed", () => {
		expect(nextStateOf("open")).toBe("handed-off");
		expect(nextStateOf("handed-off")).toBe("running");
		expect(nextStateOf("running")).toBe("done");
		expect(nextStateOf("done")).toBeNull();

		expect(canTransition("open", "handed-off")).toBe(true);
		expect(canTransition("open", "running")).toBe(false);
		expect(canTransition("open", "open")).toBe(false);
		expect(canTransition("done", "open")).toBe(false);
	});
});

describe("the built-in sample tickets", () => {
	test("every sample ticket is a valid ticket", () => {
		expect(SAMPLE_TICKETS.length).toBeGreaterThanOrEqual(3);
		expect(SAMPLE_TICKETS.length).toBeLessThanOrEqual(5);
		for (const ticket of SAMPLE_TICKETS) {
			expect(TICKET_STATES).toContain(ticket.state);
			expect(ticket.id).toBeTruthy();
			expect(ticket.title).toBeTruthy();
			expect(ticket.repository).toMatch(/^[^/]+\/[^/]+$/);
		}
	});

	test("the samples span multiple repositories", () => {
		const repos = new Set(SAMPLE_TICKETS.map((t) => t.repository));
		expect(repos.size).toBeGreaterThanOrEqual(2);
		expect(repos.size).toBeLessThanOrEqual(3);
	});

	test("at least one ticket sits in each ticket state", () => {
		const states = new Set(SAMPLE_TICKETS.map((t) => t.state));
		for (const state of TICKET_STATES) {
			expect(states).toContain(state);
		}
	});

	test("at least one ticket carries the GitHub closed status", () => {
		expect(SAMPLE_TICKETS.some((t) => t.githubClosed)).toBe(true);
	});

	test("ticket state and GitHub status stay distinct", () => {
		// A closed GitHub issue is still a live ticket in the pipeline.
		const closed = SAMPLE_TICKETS.find((t) => t.githubClosed);
		expect(closed).toBeDefined();
		expect(closed?.state).toBe("done");
		// And an open ticket can exist while its issue is closed or open,
		// independently of state.
		expect(SAMPLE_TICKETS.some((t) => t.githubClosed === false && t.state !== "open")).toBe(true);
	});
});
