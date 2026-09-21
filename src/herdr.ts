/**
 * The agent facts herdr reports, shared by every reader of an agent list:
 * the observation loop, the Consultation operations, the app's mode line,
 * and the Parallel limit seat count.
 */

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
	/** The agent kind herdr detected in the pane. */
	agent: string;
	status: string;
	/**
	 * The agent's session record path herdr reports, empty when herdr has
	 * none. The turn log is read from it on settle (ADR 0008).
	 */
	sessionId: string;
}
