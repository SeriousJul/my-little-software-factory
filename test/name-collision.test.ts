/**
 * The Agent name collision's rule (issue #299, ADR 0107).
 *
 * herdr refuses a Handoff start whose stable Agent name a pane the plane does
 * not own holds (ADR 0098, ADR 0043). The refusal is not transient: the same ask
 * meets the same line until the operator moves the pane, and the development
 * install asked one Ticket 1,772 times in three hours. The fact is the answer -
 * it stands on the Ticket, holds the Top-up's automatic adds, and names the pane
 * and workspace the operator has to go find. Each rule takes its facts and
 * answers, so the gate the walk runs, the marker the row wears, and the detail's
 * block are measured here without a cycle, an Agent, or a state file.
 */
import { describe, expect, test } from "bun:test";
import {
	NAME_COLLISION_PREFIX,
	type NameCollisionFacts,
	nameCollisionHolder,
	nameCollisionLine,
	nameCollisionStands,
} from "../src/domain/name-collision.ts";
import type { AgentNameCollision } from "../src/domain/ticket.ts";

/** The refusal herdr gave, with the handles it named. */
const HELD: AgentNameCollision = {
	stableName: "watch-agent-turns-1a2b3c4d",
	holderPaneId: "w13K:p1",
	holderWorkspaceId: "w13K",
	reason:
		"the herdr name watch-agent-turns-1a2b3c4d is held by pane w13K:p1 in workspace w13K, " +
		"which is no agent of this ticket: agent_name_taken",
	at: "2026-10-04T09:12:00Z",
};

/** The facts of a Ticket that carries a standing collision, unless told otherwise. */
function standing(over: Partial<NameCollisionFacts> = {}) {
	return nameCollisionStands({ held: true, judgedOut: false, ...over });
}

describe("the Agent name collision stands until the operator answers it (issue #299)", () => {
	test("the standing record is the fact: it holds while it stands", () => {
		expect(standing()).toBe(true);
	});

	test("no record, no fact", () => {
		// A Ticket no start was refused on carries nothing, and the automatic adds
		// run on it the way they always did.
		expect(standing({ held: false })).toBe(false);
	});

	test("the operator's own act answers the refusal and the fact leaves the row", () => {
		// The ignore and the source mute are the operator's answer, the way they are
		// the answer to a run of failed starts (ADR 0060, ADR 0070, ADR 0106).
		expect(standing({ judgedOut: true })).toBe(false);
	});
});

describe("where the name is held, in the handles herdr named", () => {
	test("the pane and the workspace, the way herdr named them", () => {
		// The plane owns no cleanup for a pane it never made, so the handles are the
		// whole of the pointer the operator gets.
		expect(nameCollisionHolder(HELD)).toBe("pane w13K:p1 in workspace w13K");
	});

	test("a half herdr did not name is left out rather than guessed", () => {
		expect(nameCollisionHolder({ ...HELD, holderWorkspaceId: null })).toBe("pane w13K:p1");
		expect(nameCollisionHolder({ ...HELD, holderPaneId: null })).toBe("workspace w13K");
		// herdr's own answer for some refusals names no candidate at all. The fact
		// says so; it does not invent a place for the operator to look.
		expect(nameCollisionHolder({ ...HELD, holderPaneId: null, holderWorkspaceId: null })).toBe(
			"a pane herdr did not name",
		);
	});
});

describe("the Agent name collision's line (issue #299)", () => {
	test("the line names the Ticket and the name that is held where", () => {
		// The shape every standing fact wears (issue #223, issue #298): the prefix,
		// the Ticket's name, and the fact in parentheses.
		expect(nameCollisionLine('"Watch agent turns"', HELD)).toBe(
			'agent name held: "Watch agent turns" (the herdr name watch-agent-turns-1a2b3c4d ' +
				"is held by pane w13K:p1 in workspace w13K)",
		);
	});

	test("the prefix keeps the collision apart from the park and the walk's other holds", () => {
		expect(NAME_COLLISION_PREFIX).toBe("agent name held:");
	});
});
