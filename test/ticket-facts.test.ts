/**
 * The screen's fact rules, tested at the fact module's interface (issue #201).
 *
 * One test per rule stands here. The frame tests keep the contract: they show
 * the row a fact paints. This file asks the module for the fact itself, so a
 * rule cannot be read two ways without a test going red.
 *
 * The module is pure: it holds no state, no renderer, and no palette. Every
 * test hands it inputs and reads its answer as a value.
 */
import { describe, expect, test } from "bun:test";
import { agentPoll } from "../src/domain/agent.ts";
import {
	failureMarker,
	inFlight,
	liveContextLine,
	queueWait,
	rowTaskType,
	startingWindow,
	ticketFactsFor,
	ticketRowFacts,
	turnTaskType,
} from "../src/domain/ticket-facts.ts";
import type { WorkQueueItem } from "../src/state/work-queue.ts";
import { agent, completion, factInputs, handoff, queueItem, ticket } from "./fact-fixtures.ts";

describe("the task type a row names", () => {
	test("an open Ticket names its suggestion", () => {
		expect(rowTaskType(ticket()).value).toBe("implement");
	});

	test("an open Ticket that suggests nothing names parked, and is not a missing value", () => {
		const fact = rowTaskType(ticket({ suggestedTaskType: null }));
		expect(fact.value).toBe("parked");
		expect(fact.unknown).toBe(false);
	});

	test("an open Ticket keeps its suggestion over a stale handoff record", () => {
		// The handoff record is the closed cycle's history: an open row names the
		// next handoff, so the suggestion stands (issue #201, story 18).
		const open = ticket({
			handoff: handoff({ taskType: "review" }),
			suggestedTaskType: "rework",
		});
		expect(rowTaskType(open).value).toBe("rework");
	});

	test("a Ticket that is not open names its handoff's task type", () => {
		expect(
			rowTaskType(ticket({ state: "running", handoff: handoff({ taskType: "fix" }) })).value,
		).toBe("fix");
	});

	test("a running Ticket names the handoff it is on, not the turn that settled", () => {
		// The frame contract: the row names the turn the Ticket is on. The
		// settled turn's task type is the context line's fact, not the row's.
		const running = ticket({
			state: "running",
			handoff: handoff({ taskType: "review" }),
			lastCompletion: completion({ taskType: "implement" }),
		});
		expect(rowTaskType(running).value).toBe("review");
	});

	test("a Ticket that is not open with no task type recorded names the warning", () => {
		const fact = rowTaskType(ticket({ state: "running", handoff: handoff({ taskType: "" }) }));
		expect(fact.value).toBe("unknown");
		expect(fact.unknown).toBe(true);
	});
});

describe("the task type the context lines name", () => {
	test("the settled turn's task type stands first", () => {
		const settled = ticket({
			state: "awaiting",
			handoff: handoff({ taskType: "review" }),
			lastCompletion: completion({ taskType: "implement" }),
		});
		expect(turnTaskType(settled, "implement")).toBe("implement");
	});

	test("with no settled turn the handoff's task type stands", () => {
		expect(turnTaskType(ticket({ handoff: handoff({ taskType: "review" }) }), "implement")).toBe(
			"review",
		);
	});

	test("with neither the suggestion stands", () => {
		expect(turnTaskType(ticket({ suggestedTaskType: "rework" }), "implement")).toBe("rework");
	});

	test("with nothing recorded the config's default stands", () => {
		const bare = ticket({ suggestedTaskType: null, handoff: null });
		expect(turnTaskType(bare, "default")).toBe("default");
	});
});

describe("the Missing agent rule", () => {
	const inFlightTicket = ticket({ state: "running", handoff: handoff() });

	test("a pane the poll does not report holds no Agent of the Ticket's own", () => {
		expect(failureMarker(inFlightTicket, agentPoll([agent({ paneId: "pane-2" })]))).toBe("missing");
	});

	test("a pane the poll reports under another Agent's name holds none of the Ticket's own", () => {
		expect(failureMarker(inFlightTicket, agentPoll([agent({ name: "another-agent" })]))).toBe(
			"missing",
		);
	});

	test("the Ticket's own Agent in its pane is not missing", () => {
		expect(failureMarker(inFlightTicket, agentPoll([agent()]))).toBeNull();
	});

	test("the Ticket's own Agent reporting a block wears the blocked badge", () => {
		expect(failureMarker(inFlightTicket, agentPoll([agent({ status: "Blocked" })]))).toBe(
			"blocked",
		);
	});

	test("no poll that has landed answers no badge", () => {
		// An unreadable herdr must not read as "every pane is missing".
		expect(failureMarker(inFlightTicket, null)).toBeNull();
	});

	test("a Ticket that is not in flight wears no failure badge", () => {
		const resting = ticket({ state: "awaiting", handoff: handoff() });
		expect(failureMarker(resting, agentPoll([agent()]))).toBeNull();
	});

	test("a handoff with no recorded pane answers no badge", () => {
		const legacy = ticket({ state: "running", handoff: handoff({ paneId: null }) });
		expect(failureMarker(legacy, agentPoll([agent()]))).toBeNull();
	});
});

describe("the Starting window", () => {
	test("the claim this run holds opens the window", () => {
		expect(startingWindow(ticket({ state: "running" }), true)).toBe(true);
	});

	test("a handed-off Ticket is inside the window without a claim", () => {
		expect(startingWindow(ticket({ state: "handed-off", handoff: handoff() }), false)).toBe(true);
	});

	test("a Ticket outside the window is not", () => {
		expect(startingWindow(ticket({ state: "running", handoff: handoff() }), false)).toBe(false);
	});

	test("a handoff that must be recovered is not inside the window", () => {
		expect(
			startingWindow(
				ticket({ state: "handed-off", handoff: handoff(), handoffRecoveryRequired: true }),
				false,
			),
		).toBe(false);
	});

	test("a failure badge rules the face out before the window is read", () => {
		// A dead or blocked Agent is never hidden behind the motion.
		const blocked = ticket({ state: "handed-off", handoff: handoff() });
		const facts = ticketFactsFor(
			blocked,
			factInputs({ poll: agentPoll([agent({ status: "blocked" })]), claims: new Set() }),
		);
		expect(facts.failure).toBe("blocked");
		expect(facts.starting).toBe(false);
	});
});

describe("the Queue wait", () => {
	test("an open-origin item holds its start while the Ticket rests open", () => {
		const open = ticket();
		expect(queueWait(open, [queueItem(open.identity, "open")])).toBe(true);
	});

	test("an open-origin item does not stand once the Ticket has left open", () => {
		const running = ticket({ state: "running", handoff: handoff() });
		expect(queueWait(running, [queueItem(running.identity, "open")])).toBe(false);
	});

	test("a route's item stands on its position Ticket, open or awaiting alike", () => {
		const awaiting = ticket({ state: "awaiting", handoff: handoff() });
		expect(queueWait(awaiting, [queueItem(awaiting.identity, "workflow")])).toBe(true);
	});

	test("an item for another Ticket is not this Ticket's wait", () => {
		expect(queueWait(ticket(), [queueItem("github:github.com:I_9", "open")])).toBe(false);
	});

	test("a Consultation item is not a Ticket's wait", () => {
		const item: WorkQueueItem = {
			kind: "consultation",
			position: 1,
			consultationId: "consultation-1",
			enqueuedAt: "2026-01-01T00:00:00Z",
		};
		expect(queueWait(ticket(), [item])).toBe(false);
	});
});

describe("the Handoff limit", () => {
	test("a Ticket under the limit wears no marker", () => {
		const fact = ticketFactsFor(
			ticket({ handoffCount: 2 }),
			factInputs({ maxHandoffsPerTicket: 10 }),
		);
		expect(fact.handoffLimit).toBe(false);
	});

	test("a Ticket at the limit wears its marker", () => {
		const fact = ticketFactsFor(
			ticket({ handoffCount: 10 }),
			factInputs({ maxHandoffsPerTicket: 10 }),
		);
		expect(fact.handoffLimit).toBe(true);
	});
});

describe("the Failed-start park (issue #298)", () => {
	test("a Ticket whose run of failed starts reaches half the limit wears its marker", () => {
		const fact = ticketFactsFor(
			ticket({ failedStartStreak: 5 }),
			factInputs({ maxHandoffsPerTicket: 10 }),
		);
		expect(fact.failedStartPark).toBe(true);
	});

	test("a run below the park's count wears none, and the Handoff limit marker stays separate", () => {
		const fact = ticketFactsFor(
			ticket({ failedStartStreak: 4, handoffCount: 4 }),
			factInputs({ maxHandoffsPerTicket: 10 }),
		);
		expect(fact.failedStartPark).toBe(false);
		expect(fact.handoffLimit).toBe(false);
	});

	test("the operator's own act takes the fact off the row", () => {
		// The ignore and the source mute answer the failing starts, so the row stops
		// naming a park the operator has already acted on (ADR 0060, ADR 0070).
		const inputs = factInputs({ maxHandoffsPerTicket: 10 });
		expect(
			ticketFactsFor(ticket({ failedStartStreak: 9, ignored: true }), inputs).failedStartPark,
		).toBe(false);
		expect(
			ticketFactsFor(ticket({ failedStartStreak: 9, muted: true }), inputs).failedStartPark,
		).toBe(false);
	});

	test("the park wears its marker beside the Handoff limit's", () => {
		// Both come from the same ledger and both stand at the row's end: the park
		// arrives first, and the limit keeps counting every attempt behind it.
		const fact = ticketFactsFor(
			ticket({ failedStartStreak: 10, handoffCount: 20 }),
			factInputs({ maxHandoffsPerTicket: 20 }),
		);
		expect(fact.failedStartPark).toBe(true);
		expect(fact.handoffLimit).toBe(true);
	});
});

describe("the in-flight fact", () => {
	test("a Ticket with an Agent working on it is in flight", () => {
		expect(inFlight(ticket({ state: "running", handoff: handoff() }))).toBe(true);
	});

	test("a Ticket whose start is pending is in flight", () => {
		expect(inFlight(ticket({ state: "handed-off", handoff: handoff() }))).toBe(true);
	});

	test("a resting Ticket is not in flight", () => {
		expect(inFlight(ticket({ state: "awaiting", handoff: handoff() }))).toBe(false);
	});
});

describe("the held turn", () => {
	test("an awaiting turn with no decision and a held cause holds its decision", () => {
		const held = ticket({
			state: "awaiting",
			handoff: handoff(),
			lastCompletion: completion({ decision: null, cause: "failed" }),
		});
		expect(ticketFactsFor(held, factInputs()).held).toBe(true);
	});

	test("a decided turn does not hold", () => {
		const decided = ticket({
			state: "awaiting",
			handoff: handoff(),
			lastCompletion: completion({ decision: "closed", cause: "failed" }),
		});
		expect(ticketFactsFor(decided, factInputs()).held).toBe(false);
	});

	test("a turn that ended on its own cause does not hold", () => {
		const settled = ticket({
			state: "awaiting",
			handoff: handoff(),
			lastCompletion: completion({ decision: null, cause: "completed" }),
		});
		expect(ticketFactsFor(settled, factInputs()).held).toBe(false);
	});

	test("a held turn on a Ticket that is not awaiting does not hold", () => {
		const running = ticket({
			state: "running",
			handoff: handoff(),
			lastCompletion: completion({ decision: null, cause: "failed" }),
		});
		expect(ticketFactsFor(running, factInputs()).held).toBe(false);
	});
});

describe("the one read", () => {
	test("the rows carry the same facts the single rules answer", () => {
		const running = ticket({
			state: "running",
			handoff: handoff({ taskType: "fix" }),
			handoffCount: 1,
		});
		const answer = ticketRowFacts(
			factInputs({
				poll: agentPoll([agent({ status: "blocked" })]),
				claims: new Set<string>(),
				// The start was picked up, so no wait stands on a running Ticket.
				queue: [queueItem(running.identity, "workflow")],
				maxHandoffsPerTicket: 1,
			}),
			[running],
		);
		const fact = answer[0];
		expect(fact.identity).toBe(running.identity);
		expect(fact.failure).toBe("blocked");
		expect(fact.starting).toBe(false);
		expect(fact.queueWait).toBe(false);
		expect(fact.handoffLimit).toBe(true);
		expect(fact.inFlight).toBe(true);
		expect(fact.held).toBe(false);
		expect(fact.taskType.value).toBe("fix");
	});

	test("the detail pane reads the same fact the row wears", () => {
		const running = ticket({ state: "running", handoff: handoff({ taskType: "fix" }) });
		const read = factInputs({ poll: agentPoll([agent()]) });
		expect(ticketRowFacts(read, [running])[0]).toEqual(ticketFactsFor(running, read));
	});

	test("the claim the run holds opens the face for the row it names", () => {
		const handedOff = ticket({ state: "handed-off", handoff: handoff() });
		const answer = ticketRowFacts(factInputs({ claims: new Set<string>([handedOff.identity]) }), [
			handedOff,
		]);
		expect(answer[0].starting).toBe(true);
	});
});

describe("the Live view's context line", () => {
	test("it names the repository, the turn's task type, and the agent, with no time", () => {
		const running = ticket({ state: "running", handoff: handoff({ taskType: "fix" }) });
		expect(liveContextLine(running, "implement")).toBe("acme/billing · fix · pi");
	});

	test("an agent that is not named keeps the placeholder", () => {
		expect(liveContextLine(ticket(), "implement")).toBe("acme/billing · implement · ?");
	});
});
