/**
 * The reads the observation loop runs every cycle, measured by the statements
 * they prepare (issue #202, ADR 0095).
 *
 * A split that reads one Ticket at a time shows up here as a count that grows
 * with the Ticket count. These counts are the guard: a read the loop runs on
 * every cycle costs a number of statements that follows the chunk count, not
 * the number of Tickets the file holds.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { FetchedTicket } from "../../src/domain/ticket.ts";
import { openFactoryState } from "../../src/state.ts";
import { cleanup, sourceA, statePath, success } from "./harness.ts";

afterEach(cleanup);

/** Run the read and count the statements it prepares. */
function measured<T>(run: () => T): { value: T; statements: number } {
	type Prepare = typeof Database.prototype.prepare;
	const prepare = Database.prototype.prepare;
	let statements = 0;
	Database.prototype.prepare = function (this: Database, sql: string) {
		statements += 1;
		return prepare.call(this, sql) as ReturnType<Prepare>;
	} as Prepare;
	try {
		return { value: run(), statements };
	} finally {
		Database.prototype.prepare = prepare;
	}
}

/** A file holding the named number of Tickets, each with its own membership. */
function fileWithTickets(count: number) {
	const state = openFactoryState(statePath());
	const tickets: FetchedTicket[] = [];
	for (let index = 0; index < count; index++) {
		tickets.push({
			identity: `github:github.com:I_${index}`,
			sourceKind: "github-issue",
			externalKey: `#${index}`,
			sourceState: "open",
			url: `https://github.com/acme/factory/issues/${index}`,
			title: `Ticket ${index}`,
			description: "A ticket in the measured file.",
			labels: ["ready-for-agent"],
			externalUpdatedAt: "2026-08-31T10:00:00Z",
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: {},
		});
	}
	state.sourceFact.initializeSources([sourceA]);
	state.sourceFact.applyFetch(sourceA, success(tickets));
	return state;
}

/** Hand every Ticket the file holds off to an Agent, so the in-flight reads have rows. */
function handOffAll(
	state: ReturnType<typeof openFactoryState>,
	count: number,
	identityOf: (index: number) => string,
): void {
	for (let index = 0; index < count; index++) {
		const claim = state.handoff.claimHandoff(
			identityOf(index),
			{
				agentType: "pi",
				environment: "worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
	}
}

describe("the state module's batched reads", () => {
	test("the Ticket projection costs a constant number of statements, not one per Ticket", () => {
		const small = fileWithTickets(5);
		const large = fileWithTickets(300);
		const smallRead = measured(() => small.ticketWorkCycle.projectedTickets([], "implement"));
		const largeRead = measured(() => large.ticketWorkCycle.projectedTickets([], "implement"));
		expect(smallRead.value).toHaveLength(5);
		expect(largeRead.value).toHaveLength(300);
		// The same count for 5 Tickets and for 300: the read runs one statement
		// per fact, not one per Ticket.
		expect(largeRead.statements).toBe(smallRead.statements);
		expect(largeRead.statements).toBeLessThanOrEqual(10);
		small.close();
		large.close();
	});
	test("the in-flight Ticket read costs two statements whatever the Ticket count", () => {
		const state = fileWithTickets(300);
		handOffAll(state, 300, (index) => `github:github.com:I_${index}`);
		const read = measured(() => state.ticketWorkCycle.ticketsByState(["handed-off", "running"]));
		expect(read.value).toHaveLength(300);
		// One statement for the Tickets in the named states, one for their
		// newest handoffs.
		expect(read.statements).toBe(2);
		state.close();
	});
	test("a batched read answers the same facts the single Ticket read answers", () => {
		const state = fileWithTickets(40);
		handOffAll(state, 40, (index) => `github:github.com:I_${index}`);
		const projected = state.ticketWorkCycle.projectedTickets([], "implement");
		const inFlight = state.ticketWorkCycle.ticketsByState(["handed-off"]);
		expect(inFlight).toHaveLength(40);
		// Every row the batch read answers matches the row the projection
		// carries for the same Ticket, so the batch is the same read in a
		// different shape.
		for (const row of inFlight) {
			const ticket = projected.find((item) => item.identity === row.ticketIdentity);
			if (ticket === undefined) throw new Error(`${row.ticketIdentity} left the projection`);
			expect(row.workCycle).toBe(ticket.workCycle);
			expect(row.state).toBe(ticket.state);
			if (ticket.handoff === null) throw new Error(`${row.ticketIdentity} carries no handoff`);
			expect(row.taskType).toBe(ticket.handoff.taskType);
			expect(row.agentType).toBe(ticket.handoff.agentType);
			expect(row.handoffAttemptId).toBe(ticket.handoff.attemptId);
			expect(row.paneId).toBe(ticket.handoff.paneId);
		}
		state.close();
	});
	test("the seat count's Agent names cost one read per chunk, not two per Ticket", () => {
		// The Parallel limit count the mode line and every start gate run each
		// cycle reads the in-flight Tickets and each Ticket's Agent name (issue
		// #202, ADR 0095). The names arrive in the same batched shape as the rows.
		const small = fileWithTickets(5);
		const large = fileWithTickets(300);
		handOffAll(small, 5, (index) => `github:github.com:I_${index}`);
		handOffAll(large, 300, (index) => `github:github.com:I_${index}`);
		const readNames = (state: typeof small) =>
			measured(() =>
				state.ticketWorkCycle.agentNamesForTickets(
					state.ticketWorkCycle
						.ticketsByState(["handed-off", "running"])
						.map((ticket) => ticket.ticketIdentity),
				),
			);
		const smallNames = readNames(small);
		const largeNames = readNames(large);
		expect(smallNames.value.size).toBe(5);
		expect(largeNames.value.size).toBe(300);
		// The same statement count for 5 Tickets and for 300: two statements for
		// the in-flight rows and two for their names, whatever the Ticket count.
		// The per-Ticket read this replaces ran two statements for every row - ten
		// for the small file and six hundred for the large one.
		expect(largeNames.statements).toBe(smallNames.statements);
		expect(largeNames.statements).toBe(4);
		// The batch answers the same names the single Ticket read answers.
		for (const [identity, name] of largeNames.value) {
			expect(name).toBe(large.ticketWorkCycle.agentNameForTicket(identity));
		}
		small.close();
		large.close();
	});
	test("the start count a Ticket carries adds up both aggregates' starts", () => {
		const state = fileWithTickets(1);
		const [ticket] = state.ticketWorkCycle.projectedTickets([], "implement");
		const claim = state.handoff.claimHandoff(
			ticket.identity,
			{
				agentType: "pi",
				environment: "worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true);
		const [settled] = state.ticketWorkCycle.projectedTickets([], "implement");
		expect(settled.handoffCount).toBe(1);
		const [again] = state.ticketWorkCycle.projectedTickets([], "implement");
		expect(again.handoffCount).toBe(1);
		state.close();
	});
	test("the restart walk's facts cost a constant number of statements, not one per Ticket", () => {
		// The restart walk holds an identity, a pane, and a start time and no row of
		// its own, so the two facts its gate cannot read off a row - the Ticket's
		// start count, and whether the queue already holds an item for it - arrive as
		// one read for the whole in-flight list (issue #202 review). Asked of every
		// candidate they cost three statements per in-flight Ticket on every cycle the
		// walk ran: sixty for twenty Tickets, where the walk before the split paid
		// none for a Ticket its Agent still stood in.
		const small = fileWithTickets(5);
		const large = fileWithTickets(300);
		handOffAll(small, 5, (index) => `github:github.com:I_${index}`);
		handOffAll(large, 300, (index) => `github:github.com:I_${index}`);
		const walkReads = (state: typeof small) =>
			measured(() => {
				const inFlight = state.ticketWorkCycle.ticketsByState(["handed-off", "running"]);
				const identities = inFlight.map((ticket) => ticket.ticketIdentity);
				state.ticketWorkCycle.agentNamesForTickets(identities);
				state.handoff.handoffCountsFor(identities);
				state.workQueue.items();
				return inFlight.length;
			});
		const smallRead = walkReads(small);
		const largeRead = walkReads(large);
		expect(smallRead.value).toBe(5);
		expect(largeRead.value).toBe(300);
		// The same count for 5 in-flight Tickets and for 300: two for the rows, two
		// for their Agent names, two for the start counts, and one for the queue's
		// items the cycle gate reads for its depth as well.
		expect(largeRead.statements).toBe(smallRead.statements);
		expect(largeRead.statements).toBe(7);
		small.close();
		large.close();
	});
	test("the batched reads answer the facts the per-Ticket reads answered", () => {
		// A batch that answers something else is a new read, not the same read in a
		// batched shape (issue #202 review).
		const state = fileWithTickets(40);
		handOffAll(state, 40, (index) => `github:github.com:I_${index}`);
		const identities = state.ticketWorkCycle
			.ticketsByState(["handed-off", "running"])
			.map((ticket) => ticket.ticketIdentity);
		const counts = state.handoff.handoffCountsFor(identities);
		for (const identity of identities)
			expect(counts.get(identity)).toBe(state.handoff.handoffCount(identity));
		const standing = (source: typeof state): Set<string> =>
			new Set(
				source.workQueue
					.items()
					.filter((item) => item.kind !== "consultation")
					.map((item) => item.ticketIdentity),
			);
		for (const identity of identities) expect(standing(state).has(identity)).toBe(false);
		state.workQueue.enqueueWork({
			ticketIdentity: identities[0],
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
		});
		expect(standing(state).has(identities[0])).toBe(true);
		expect(standing(state).has(identities[1])).toBe(false);
		for (const identity of identities)
			expect(standing(state).has(identity)).toBe(state.workQueue.hasWorkItem(identity));
		state.close();
	});
});
