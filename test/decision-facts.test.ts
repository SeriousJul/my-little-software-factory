/**
 * The Decision region's facts, tested at the fact module's interface (issue #201).
 *
 * The modal keeps its rows, its region, and its focus; the lines it states are
 * the fact module's answer. One test per rule stands here, so a change to one
 * rule shows up in one file.
 */
import { describe, expect, test } from "bun:test";
import type { TransitionOutcome } from "../src/config.ts";
import {
	type DecisionFactInputs,
	type DecisionFacts,
	type DecisionOffer,
	type DecisionPosition,
	decisionFacts,
	routeStandingLine,
	transitionFactLine,
} from "../src/domain/decision-facts.ts";
import type { PlaneActionAttempt } from "../src/state/plane-action.ts";
import type { WorkQueueItem } from "../src/state/work-queue.ts";
import { completion, handoff, queueItem, ticket } from "./fact-fixtures.ts";

const outcome = (over: Partial<TransitionOutcome> = {}): TransitionOutcome => ({
	fired: true,
	when: null,
	reason: "",
	ticketFacts: ["ready-for-review"],
	pullRequestFacts: [],
	ticketWrite: { added: ["ready-for-review"], removed: ["ready-for-agent"] },
	pullRequestWrite: null,
	pullRequestIdentity: null,
	pullRequestKey: null,
	writeFailure: "",
	positionTaskType: "review",
	positionTicketIdentity: "github:github.com:I_1",
	...over,
});

/** The transition's position record as the screen hands it: nothing stands on it. */
const positionOn = (over: Partial<DecisionPosition> = {}): DecisionPosition => ({
	ticket: undefined,
	stillListed: true,
	isPlaneAction: false,
	latestAttempt: null,
	...over,
});

const decisionInputs = (over: Partial<DecisionFactInputs> = {}): DecisionFactInputs => ({
	ticket: ticket({
		state: "awaiting",
		handoff: handoff({ taskType: "review" }),
		lastCompletion: completion({ taskType: "review", transition: outcome() }),
	}),
	queue: [],
	claims: new Set<string>(),
	position: {
		ticket: undefined,
		stillListed: true,
		isPlaneAction: false,
		latestAttempt: null,
	},
	nextStepGate: null,
	defaultTaskType: "implement",
	...over,
});

describe("the Decision region's facts", () => {
	test("the context line names the repository, the turn's task type, the agent, and the time", () => {
		const facts = decisionFacts(decisionInputs());
		expect(facts.contextLine).toBe("acme/billing · review · pi · 2026-01-01 12:00");
	});

	test("the fact lines state what the fire wrote", () => {
		const facts = decisionFacts(decisionInputs());
		expect(facts.factLines).toEqual(["ticket · added ready-for-review · removed ready-for-agent"]);
		expect(facts.offer).toEqual({ kind: "handoff", taskType: "review" });
	});

	test("a route that waits in the Work queue states where it stands and offers no row", () => {
		const settled = decisionInputs();
		const facts = decisionFacts({
			...settled,
			queue: [queueItem(settled.ticket.identity, "workflow")],
		});
		expect(facts.factLines).toContain("the route is waiting in the Work queue");
		expect(facts.offer).toBeNull();
	});

	test("a route that is starting states its fact line", () => {
		const settled = decisionInputs();
		const facts = decisionFacts({ ...settled, claims: new Set<string>([settled.ticket.identity]) });
		expect(facts.factLines).toContain("the route is starting");
		expect(facts.offer).toBeNull();
	});

	test("a route running on its position Ticket states its fact line", () => {
		const position = ticket({
			identity: "github:github.com:I_2",
			state: "running",
			handoff: handoff(),
		});
		const facts = decisionFacts({
			...decisionInputs(),
			position: { ...positionOn(), ticket: position },
		});
		expect(facts.factLines).toContain("the route is running on its position ticket");
		expect(facts.offer).toBeNull();
	});

	test("a dead route on a position that still stands keeps its row", () => {
		const facts = decisionFacts(decisionInputs());
		expect(facts.offer).toEqual({ kind: "handoff", taskType: "review" });
	});

	test("a position that left its source withdraws the row and says so", () => {
		const facts = decisionFacts({
			...decisionInputs(),
			position: { ...positionOn(), stillListed: false },
		});
		expect(facts.offer).toBeNull();
		expect(facts.factLines).toContain("the position's ticket left its source; no handoff stands");
	});

	test("a plane action position asks for the merge, not for a handoff", () => {
		const facts = decisionFacts({
			...decisionInputs(),
			position: { ...positionOn(), isPlaneAction: true },
		});
		expect(facts.offer).toEqual({ kind: "merge", taskType: "review" });
	});

	test("the screen holds one record, and the row it offers is one of two kinds (issue #301)", () => {
		// The App reads this record off `decisionFacts` and never names the type, so
		// the record and its offer row are stated at the seam: the modal gets one
		// record, and the row it offers is a handoff or a merge, never a third thing.
		const facts: DecisionFacts = decisionFacts(decisionInputs());
		expect(Object.keys(facts)).toEqual(["contextLine", "factLines", "offer"]);
		const handoffOffer: DecisionOffer | null = facts.offer;
		expect(handoffOffer).toEqual({ kind: "handoff", taskType: "review" });
		const merged: DecisionOffer | null = decisionFacts({
			...decisionInputs(),
			position: { ...positionOn(), isPlaneAction: true },
		}).offer;
		expect(merged).toEqual({ kind: "merge", taskType: "review" });
	});

	test("a blocked merge stands where the row stood", () => {
		const settled = decisionInputs();
		const attempt: PlaneActionAttempt = {
			id: "attempt-1",
			ticketIdentity: settled.ticket.identity,
			taskType: "review",
			decision: "merged",
			outcome: "blocked",
			reason: "the pull request has open comments",
			transition: null,
			at: "2026-01-02T00:00:00Z",
		};
		const facts = decisionFacts({
			...settled,
			position: { ...positionOn(), latestAttempt: attempt },
		});
		expect(facts.factLines).toContain("the merge was blocked: the pull request has open comments");
		expect(facts.offer).toBeNull();
	});

	test("an outcome that wrote nothing states only the reason", () => {
		const facts = decisionFacts(
			decisionInputs({
				ticket: ticket({
					state: "awaiting",
					handoff: handoff(),
					lastCompletion: completion({
						transition: outcome({
							fired: false,
							reason: "no label matched",
							ticketWrite: null,
							positionTaskType: null,
						}),
					}),
				}),
			}),
		);
		expect(facts.factLines).toEqual(["no transition branch held: no label matched"]);
		expect(facts.offer).toBeNull();
	});

	test("a Next step the machine will not take on its own is stated beside the row", () => {
		// ADR 0092: the operator's own key passes the gates, so the row stands and
		// the fact line says why the factory holds the step.
		const facts = decisionFacts({ ...decisionInputs(), nextStepGate: "same-type-hold" });
		expect(facts.offer).toEqual({ kind: "handoff", taskType: "review" });
		expect(facts.factLines).toContain(
			"the Next step is held: the Same-type hold stands on the position",
		);
	});

	test("a held Next step states no line where the route still stands", () => {
		const settled = decisionInputs();
		const facts = decisionFacts({
			...settled,
			nextStepGate: "handoff-limit",
			queue: [queueItem(settled.ticket.identity, "workflow")],
		});
		expect(facts.factLines).toContain("the route is waiting in the Work queue");
		expect(facts.factLines.some((line) => line.startsWith("the Next step is held"))).toBe(false);
	});
});

describe("the route's standing line", () => {
	// The rule the fact lines above read: where a living route stands, or null
	// while the route is dead and the decision row stands again.
	const settled = decisionInputs();

	test("a merge route stands in the Work queue's row", () => {
		const item: WorkQueueItem = {
			kind: "plane-action",
			position: 1,
			ticketIdentity: settled.ticket.identity,
			automatic: true,
			routeFromIdentity: null,
			origin: "workflow",
			taskType: "review",
			enqueuedAt: "2026-01-01T00:00:00Z",
		};
		expect(routeStandingLine(settled.ticket, outcome(), true, { ...settled, queue: [item] })).toBe(
			"the merge is waiting in the Work queue",
		);
	});

	test("a merge route with no item is dead", () => {
		expect(routeStandingLine(settled.ticket, outcome(), true, settled)).toBeNull();
	});

	test("a route whose position holds a handoff stands as running", () => {
		const position = ticket({
			identity: "github:github.com:I_2",
			state: "running",
			handoff: handoff(),
		});
		expect(
			routeStandingLine(settled.ticket, outcome(), false, {
				...settled,
				position: { ...positionOn(), ticket: position },
			}),
		).toBe("the route is running on its position ticket");
	});

	test("a route with no item, no claim, and no handoff on its position is dead", () => {
		expect(routeStandingLine(settled.ticket, outcome(), false, settled)).toBeNull();
	});
});

describe("one surface's label write as a fact line", () => {
	test("it names the surface, then what the write added and removed", () => {
		expect(transitionFactLine("ticket", { added: ["ready-for-review"], removed: [] })).toBe(
			"ticket · added ready-for-review",
		);
		expect(
			transitionFactLine("pull request 12", {
				added: ["merged"],
				removed: ["ready-for-review"],
			}),
		).toBe("pull request 12 · added merged · removed ready-for-review");
	});

	test("a write that changed nothing states only the surface", () => {
		expect(transitionFactLine("ticket", { added: [], removed: [] })).toBe("ticket");
	});
});
