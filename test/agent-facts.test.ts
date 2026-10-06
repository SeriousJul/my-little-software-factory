/**
 * The Agent-side domain facts, tested at the module's interface (issue #201).
 *
 * The Missing agent rule has one home (GLOSSARY.md): every reader of the fact -
 * the row's failure badge, the in-flight pass, the Restart walk, the Parallel
 * limit seat count, and the observation cycle's reads - calls `agentInPane`.
 * These tests stand at that interface so the rule cannot be read two ways
 * without a test going red.
 */
import { describe, expect, test } from "bun:test";
import {
	type AgentStatus,
	agentInPane,
	agentPoll,
	normalizeAgentStatus,
	ticketAgentName,
} from "../src/domain/agent.ts";
import { agent, handoff, OWN_NAME, STABLE_NAME, ticket } from "./fact-fixtures.ts";

/** One Ticket with an Agent working in its recorded pane. */
const inFlightTicket = ticket({ state: "running", handoff: handoff() });

describe("normalizeAgentStatus", () => {
	test("maps the closed herdr 0.8.2 status set and falls back to unknown", () => {
		expect(normalizeAgentStatus("working")).toBe("working");
		expect(normalizeAgentStatus("Done")).toBe("done");
		expect(normalizeAgentStatus("idle")).toBe("idle");
		expect(normalizeAgentStatus("blocked")).toBe("blocked");
		expect(normalizeAgentStatus("unknown")).toBe("unknown");
		expect(normalizeAgentStatus("meditating")).toBe("unknown");
	});

	test("the status set the plane holds is closed, and no two words answer alike (issue #301)", () => {
		// The observation loop and the App hold this shape through the answer of
		// `normalizeAgentStatus` and never name the type, so the set the plane holds
		// is written down here: the words the poll can answer, and no two of them
		// land on one answer. Each word's own mapping, and the fallback for a word
		// outside the set, stand in the test above and are not restated.
		const statuses: readonly AgentStatus[] = ["working", "done", "idle", "blocked", "unknown"];
		expect(new Set(statuses.map((status) => normalizeAgentStatus(status))).size).toBe(
			statuses.length,
		);
	});
});

describe("the Missing agent rule", () => {
	test("the pane the poll no longer reports holds no Agent", () => {
		const poll = agentPoll([agent({ paneId: "pane-2" })]);
		expect(agentInPane(poll, "pane-1", OWN_NAME)).toBeNull();
	});

	test("a pane herdr handed out again under another Agent's name holds no Agent of this Ticket's own", () => {
		const poll = agentPoll([agent({ name: "another-agent" })]);
		expect(agentInPane(poll, "pane-1", OWN_NAME)).toBeNull();
	});

	test("the Ticket's own Agent in the stored pane answers with the Agent", () => {
		const live = agent();
		expect(agentInPane(agentPoll([live]), "pane-1", OWN_NAME)).toBe(live);
	});

	test("a Ticket with no stored pane holds no Agent", () => {
		expect(agentInPane(agentPoll([agent()]), null, OWN_NAME)).toBeNull();
	});

	test("the name the rule checks is the handoff's recorded name", () => {
		expect(ticketAgentName(inFlightTicket)).toBe(OWN_NAME);
	});

	test("a handoff that recorded no name falls back to the Ticket's stable Agent name", () => {
		expect(ticketAgentName(ticket({ state: "running", handoff: handoff({ herdrName: "" }) }))).toBe(
			STABLE_NAME,
		);
	});
});
