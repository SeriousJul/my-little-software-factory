/**
 * The agent facts herdr reports, shared by every reader of an agent list:
 * the observation loop, the Consultation operations, the app's mode line,
 * and the Parallel limit seat count.
 */
import { identifyHandoffAgentName } from "./naming.ts";

/** One agent herdr reports for a pane. */
export interface HerdrAgent {
	paneId: string;
	tabId: string;
	workspaceId: string;
	/** Stable Agent session identity when this Herdr version exposes one. */
	stableSessionId?: string;
	/** The checkout or working directory when this Herdr version reports it. */
	checkoutPath?: string;
	/** Herdr's monotonic state-change sequence when available. */
	sequence?: number;
	/**
	 * The name the agent started under, when this Herdr version reports it.
	 * The name is the agent's identity: herdr refuses to start a second
	 * agent under a name a live agent holds.
	 */
	name?: string;
	/** The agent kind herdr detected in the pane. */
	agent: string;
	status: string;
	/**
	 * The agent's session record path herdr reports, empty when herdr has
	 * none. The turn log is read from it on settle (ADR 0008).
	 */
	sessionId: string;
}

/**
 * The Ticket's own Agent in the pane its handoff records, as one poll's agent
 * list reports it, or null when the pane holds none of its own (ADR 0043).
 *
 * Herdr hands the id of a closed pane out again: a pane the list does not
 * report, or reports under another Agent's name, holds no Agent of the
 * Ticket's own, the way an empty one does. A name the reader cannot read keeps
 * the pane the reader has always trusted. This is the one rule behind the
 * observation cycle's in-flight pass, the Top-up's Restart walk, the Parallel
 * limit seat count, and the list's failure badge, so the four cannot drift
 * apart about the same pane (ADR 0060).
 */
export function ownAgentInPane(
	agent: HerdrAgent | undefined,
	expectedName: string,
): HerdrAgent | null {
	if (agent === undefined) return null;
	return identifyHandoffAgentName(agent.name, expectedName) === "foreign" ? null : agent;
}
