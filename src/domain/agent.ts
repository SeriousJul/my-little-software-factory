/**
 * The agent-side domain facts the control plane shares across every Agent
 * type.
 *
 * The Thinking level set is one standard set (ADR 0010): the union of the
 * levels the supported agent runtimes accept. An Agent type declares the
 * subset it maps, so the override panel and the startup check always have a
 * list to work with, and a config never depends on an agent's own spelling of
 * a level.
 *
 * The Missing agent rule stands here too (CONTEXT.md): the stored pane is gone
 * or holds no Agent. One function owns it, and every reader of the fact calls
 * it - the row's failure badge, the in-flight pass, the Restart walk, the
 * Parallel limit seat count, and the observation cycle's reads - so the six
 * cannot drift apart about the same pane.
 */

import { type HerdrAgent, ownAgentInPane } from "../herdr.ts";
import { agentNameFor, type HandoffAgentIdentity, identifyHandoffAgentName } from "../naming.ts";
import type { Ticket } from "./ticket.ts";

/** The standard Thinking levels, from no reasoning to the deepest. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One Thinking level of the standard set. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const LEVELS: readonly string[] = THINKING_LEVELS;

/** The standard levels, in one readable list, for an error message. */
export function thinkingLevelList(): string {
	return LEVELS.join(", ");
}

/** True when a config value names a standard Thinking level. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && LEVELS.includes(value);
}

/** What one poll says about an agent's state. */
export type AgentStatus = "working" | "done" | "idle" | "blocked" | "unknown";

/** One poll's agent list, read by pane: the fact the plane holds. */
export type AgentPoll = ReadonlyMap<string, HerdrAgent>;

/** The Agent list as the fact the plane reads it: one entry per pane. */
export function agentPoll(agents: readonly HerdrAgent[] | null): AgentPoll | null {
	if (agents === null) return null;
	const byPane = new Map<string, HerdrAgent>();
	for (const agent of agents) byPane.set(agent.paneId, agent);
	return byPane;
}

/** The status a poll reports, in the plane's own words. */
export function normalizeAgentStatus(raw: string): AgentStatus {
	const value = raw.trim().toLowerCase();
	if (value === "working") return "working";
	if (value === "done") return "done";
	if (value === "idle") return "idle";
	if (value === "blocked") return "blocked";
	return "unknown";
}

/**
 * The Missing agent rule (CONTEXT.md): the stored pane is gone or holds no
 * Agent of the Ticket's own.
 *
 * Herdr hands the id of a closed pane out again, so a pane the poll reports
 * under another Agent's name holds no Agent of this Ticket's own, the way an
 * empty one does. The name is the Ticket's stable Agent name, and the poll is
 * the last one that landed. Every reader of the fact calls this one function:
 * the row's failure badge, the in-flight pass, the Restart walk, the Parallel
 * limit seat count, and the observation cycle's reads. The Startup grace is
 * read beside it, never redefined here.
 */
export function agentInPane(
	poll: AgentPoll,
	paneId: string | null,
	agentName: string,
): HerdrAgent | null {
	if (paneId === null) return null;
	return ownAgentInPane(poll.get(paneId), agentName);
}

/** Whether the pane holds no Agent of the Ticket's own: the Missing agent fact. */
export function agentMissing(poll: AgentPoll, paneId: string | null, agentName: string): boolean {
	return agentInPane(poll, paneId, agentName) === null;
}

/**
 * The name a Ticket's own Agent runs under: the handoff's recorded name, or the
 * stable name the handoff asked for first. Herdr hands the id of a closed pane
 * out again, so this is the name the pane's agent is checked against.
 */
export function ticketAgentName(ticket: Ticket): string {
	const recorded = ticket.handoff?.herdrName ?? null;
	return recorded !== null && recorded !== "" ? recorded : agentNameFor(ticket.title);
}

/**
 * The identity of the live agent in the Ticket's handoff pane, from the names
 * alone (ADR 0043).
 */
export function ticketAgentIdentity(ticket: Ticket, agent: HerdrAgent): HandoffAgentIdentity {
	return identifyHandoffAgentName(agent.name, ticketAgentName(ticket));
}
