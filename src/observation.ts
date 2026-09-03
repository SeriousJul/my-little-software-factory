/**
 * The herdr observation loop: the control plane's eyes on the agents.
 *
 * ADR 0006: herdr owns the agent UI and its agent detection; the control
 * plane asks herdr for the facts. The loop polls `herdr agent list` on the
 * configured interval and keys each in-flight ticket's agent lookup on the
 * pane id the handoff recorded, so it is the agent the handoff started, not
 * any agent in the pane.
 *
 * Each cycle:
 *
 * 1. An open ticket whose last closed handoff still holds a working or
 *    blocked agent is reclaimed (ADR 0011): the loop records a handoff in the
 *    ticket's current cycle with that handoff's choices and the same herdr
 *    handles, and the ticket runs again. A close ends a cycle, but the agent
 *    it started can outlive it: the Close cleanup cannot remove a dirty
 *    checkout, and the operator can re-prompt a settled agent in herdr. The
 *    list never reads `open` over an agent that works.
 * 2. An in-flight ticket whose agent reports working runs. One whose agent
 *    reports done or idle settles: the turn's log is read from the agent's
 *    session record (ADR 0008), falling back to the pane's recent output
 *    when herdr reports no session, and stored in a completion trace with
 *    the agent's final text as its last message. The ticket rests in
 *    awaiting. A settle is trusted only when the turn demonstrably started:
 *    a running ticket settles at once, but a handed-off ticket that never
 *    showed working waits out its startup grace, the window in which a
 *    booted agent reports idle before it picks up the prompt. An awaiting
 *    ticket whose agent is working again reopens: its still-pending turn
 *    did not end, and the next settle refreshes the trace in place.
 * 3. A pane herdr no longer lists is missing. With auto-handoff on the
 *    loop restarts the agent once per episode, or abandons the cycle when
 *    the ticket has used up its handoffs.
 * 4. Automatic completion decisions resolve the awaiting tickets: every
 *    one with auto-handoff on, the auto-close types alone without it.
 *    Exactly one outgoing edge routes (while the parallel limit has room),
 *    any other edge count closes, and a route at the handoff limit
 *    degrades to close. A full parallel limit leaves a route awaiting
 *    until a slot frees, and the rest wait for the operator.
 * 5. With auto-handoff on, each eligible open ticket - actionable, under
 *    both limits - is handed off on its task profile's configured settings.
 *    The parallel count is the in-flight tickets whose agent was alive in
 *    the latest poll: a blocked agent holds a slot, a missing one does not.
 *
 * When herdr cannot be listed at all, the loop pauses and holds: the last
 * known facts stay, and the UI warns. Nothing is re-run blindly on
 * recovery: a cycle that cannot see its agents does not settle, reclaim, or
 * restart anything.
 */

import type { FactoryConfig, WorkflowEdge } from "./config.ts";
import { baseChoice, type HandoffChoice } from "./handoff.ts";
import { type RefreshClock, SYSTEM_CLOCK } from "./refresh.ts";
import { type CommandRunner, commandFailureText } from "./runner.ts";
import { resolveEnvironment, resolveSettings } from "./setting-resolution.ts";
import type { Consultation, FactoryState, HandoffOrigin, HandoffTicket } from "./state.ts";
import {
	lastMessageFromLog,
	readSessionTurnLog,
	type TurnLogEntry,
	turnLogFromCapture,
} from "./turn-log.ts";

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

/** The normalized states the factory reasons about. */
export type AgentStatus = "working" | "done" | "idle" | "blocked" | "unknown";

/**
 * The startup grace a handoff's agent gets before an idle or done report
 * settles its turn.
 */
export const STARTUP_GRACE_MS = 30_000;

/** The result of asking herdr for its agents. */
export type HerdrProbe = { kind: "ok"; agents: HerdrAgent[] } | { kind: "error"; reason: string };

/** The read-side of herdr the loop uses. Tests inject a fake here. */
export interface AgentReader {
	listAgents(): Promise<HerdrProbe>;
	/** The pane's recent output in text format, unwrapped, capped and ANSI stripped. Null when it cannot be read. */
	readPane(paneId: string, lines: number): Promise<string | null>;
}

/**
 * The settled turn's log, read from the agent's session record.
 *
 * The kind is the agent type's kind from the config, the sessionId the path
 * herdr reported. Null yields the terminal capture fallback. The real
 * source reads the file (ADR 0008); tests inject a fake.
 */
export interface TurnLogSource {
	read(kind: string, sessionId: string): Promise<TurnLogEntry[] | null>;
}

/** The real turn log source: the per-agent-type session record readers. */
export const SESSION_TURN_LOGS: TurnLogSource = {
	read: (kind, sessionId) => Promise.resolve(readSessionTurnLog(kind, sessionId)),
};

/** A record guard for the herdr agent list items. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A reader that runs the pinned herdr commands through the command runner. */
export class HerdrAgentReader implements AgentReader {
	private readonly runner: CommandRunner;

	constructor(runner: CommandRunner) {
		this.runner = runner;
	}

	async listAgents(): Promise<HerdrProbe> {
		const result = await this.runner.run("herdr", ["agent", "list"]);
		if (result.code !== 0) {
			return { kind: "error", reason: commandFailureText(result) };
		}
		let data: unknown;
		try {
			data = JSON.parse(result.stdout);
		} catch {
			return { kind: "error", reason: "herdr agent list did not return a readable agent list" };
		}
		const result_ = (data as { result?: { agents?: unknown } }).result;
		const raw = Array.isArray(result_?.agents) ? (result_?.agents as unknown[]) : [];
		const agents: HerdrAgent[] = [];
		for (const item of raw) {
			const record = item as Record<string, unknown>;
			if (typeof record.pane_id !== "string" || record.pane_id === "") continue;
			if (typeof record.agent !== "string" || record.agent === "") continue;
			const session = isRecord(record.agent_session) ? record.agent_session : undefined;
			agents.push({
				paneId: record.pane_id,
				tabId: typeof record.tab_id === "string" ? record.tab_id : "",
				workspaceId: typeof record.workspace_id === "string" ? record.workspace_id : "",
				...(typeof record.sequence === "number"
					? { sequence: record.sequence }
					: typeof record.seq === "number"
						? { sequence: record.seq }
						: typeof record.state_change_sequence === "number"
							? { sequence: record.state_change_sequence }
							: typeof record.state_change_seq === "number"
								? { sequence: record.state_change_seq }
								: {}),
				agent: record.agent,
				...(typeof record.checkout_path === "string"
					? { checkoutPath: record.checkout_path }
					: typeof record.cwd === "string"
						? { checkoutPath: record.cwd }
						: typeof record.working_directory === "string"
							? { checkoutPath: record.working_directory }
							: {}),
				...(typeof record.session_id === "string"
					? { stableSessionId: record.session_id }
					: typeof record.agent_session_id === "string"
						? { stableSessionId: record.agent_session_id }
						: {}),
				status: typeof record.agent_status === "string" ? record.agent_status : "unknown",
				sessionId:
					session !== undefined && session.kind === "path" && typeof session.value === "string"
						? session.value
						: "",
			});
		}
		return { kind: "ok", agents };
	}

	async readPane(paneId: string, lines: number): Promise<string | null> {
		return this.readPaneFormat(paneId, lines, "recent-unwrapped", "text");
	}

	/** Read the visible ANSI terminal for Agent interaction mode. */
	async readPaneAnsi(paneId: string, lines: number): Promise<string | null> {
		return this.readPaneFormat(paneId, lines, "visible", "ansi");
	}

	private async readPaneFormat(
		paneId: string,
		lines: number,
		source: "visible" | "recent-unwrapped",
		format: "text" | "ansi",
	): Promise<string | null> {
		const result = await this.runner.run("herdr", [
			"agent",
			"read",
			paneId,
			"--lines",
			String(lines),
			"--source",
			source,
			"--format",
			format,
		]);
		if (result.code !== 0) return null;
		let output: string | null = null;
		try {
			const data = JSON.parse(result.stdout) as { result?: { output?: unknown } };
			if (typeof data.result?.output === "string") output = data.result.output;
		} catch {
			// Not JSON: the text format is the raw output.
			output = result.stdout;
		}
		if (output === null) return null;
		// ANSI output is interpreted by the isolated cell renderer. Never strip
		// it here: cursor movement and SGR state are part of its visible layout.
		if (format === "ansi") return output;
		// Cap stored plain-text captures client-side as well.
		return stripAnsi(output).split("\n").slice(0, lines).join("\n");
	}
}

export function matchConsultationAgent(
	consultation: Consultation,
	agents: readonly HerdrAgent[],
): HerdrAgent | "ambiguous" | undefined {
	const pane =
		consultation.paneId === null
			? undefined
			: agents.find((agent) => agent.paneId === consultation.paneId);
	if (pane !== undefined) {
		if (consultation.sessionId === null || pane.stableSessionId === consultation.sessionId)
			return pane;
		return "ambiguous";
	}
	if (consultation.sessionId === null) return undefined;
	const matches = agents.filter((agent) => agent.stableSessionId === consultation.sessionId);
	return matches.length === 1 ? matches[0] : matches.length > 1 ? "ambiguous" : undefined;
}

export function normalizeAgentStatus(raw: string): AgentStatus {
	const value = raw.trim().toLowerCase();
	if (value === "working") return "working";
	if (value === "done") return "done";
	if (value === "idle") return "idle";
	if (value === "blocked") return "blocked";
	return "unknown";
}

/** Strip ANSI escape sequences and stray control characters. */
export function stripAnsi(text: string): string {
	return (
		text
			// biome-ignore lint/suspicious/noControlCharactersInRegex: CSI sequences start with an escape
			.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences carry a BEL or ST terminator
			.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: two-letter escapes
			.replace(/\u001b[@-Z\\-_]/g, "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stray control characters
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
	);
}

/**
 * The decision an awaiting ticket resolves to on a cycle.
 *
 * - `close`: the factory closes the cycle now (zero or multiple outgoing
 *   edges, or a route degraded at the handoff limit).
 * - `route`: the task type's one-and-only edge hands off, while the
 *   parallel limit has room.
 * - `wait`: the ticket rests in awaiting. A route waits for a free slot;
 *   in manual mode a non-auto-close type waits for the operator's
 *   decision.
 */
export type AwaitingDecision = "close" | "route" | "wait";

/** The handoff the loop starts on the app's behalf. */
export interface HandoffIntent {
	origin: HandoffOrigin;
	ticketIdentity: string;
	choice: HandoffChoice;
	previousMessage: string;
}

/**
 * Whether the app accepted the intent: it claimed the handoff and will run
 * it, now or behind the handoff already in flight. A refused claim leaves
 * the ticket where it was and says why.
 */
export type DispatchResult = { ok: true } | { ok: false; reason: string };

interface ObservationOptions {
	state: FactoryState;
	herdr: AgentReader;
	/** The config, read at each cycle: a runtime write-back stays visible. */
	config: () => FactoryConfig;
	/** The app's handoff path: claim, external work, settle, refresh. */
	dispatch: (intent: HandoffIntent) => Promise<DispatchResult>;
	/**
	 * The Close cleanup of an auto-ended cycle: the worktree workspace is
	 * removed or the live tab is closed. Returns a failure reason.
	 */
	cleanup: (handoff: HandoffTicket) => Promise<string | undefined>;
	now: () => number;
	/** The auto-handoff mode, read at the start of each cycle. */
	mode: () => boolean;
	intervalMs: number;
	/** The startup grace a fresh handoff's idle agent waits out. */
	startupGraceMs?: number;
	/** One UI frame changed. */
	onChanged: () => void;
	/**
	 * The agent list of a completed cycle: the probe's list on success, null
	 * while the probe is failing. Fires on every cycle, not only on state
	 * changes, so a failure marker can appear without any state change.
	 */
	onAgents?: (agents: readonly HerdrAgent[] | null) => void;
	/** A message for the status line. */
	onStatus: (kind: "info" | "warning" | "error", text: string) => void;
	/** Optional Consultation side of the shared monitor. */
	onConsultationAttention?: (consultationId: string) => void;
	onConsultationsChanged?: () => void;
	/** Suppress attention bells while startup reconciliation is running. */
	reconcileOnly?: boolean;
	/**
	 * The scheduling clock, the same injectable interface the refresh
	 * coordinator takes. Defaults to the system clock.
	 */
	clock?: RefreshClock;
	/**
	 * The settled turn's log, from the agent's session record. Defaults to
	 * the real reader.
	 */
	turnLogs?: TurnLogSource;
}

export class ObservationCoordinator {
	private readonly state: FactoryState;
	private readonly herdr: AgentReader;
	private readonly config: () => FactoryConfig;
	private readonly dispatch: (intent: HandoffIntent) => Promise<DispatchResult>;
	private readonly cleanup: (handoff: HandoffTicket) => Promise<string | undefined>;
	private readonly now: () => number;
	private readonly mode: () => boolean;
	private readonly intervalMs: number;
	private readonly startupGraceMs: number;
	private readonly onChanged: () => void;
	private readonly onAgents?: (agents: readonly HerdrAgent[] | null) => void;
	private readonly onConsultationAttention?: (consultationId: string) => void;
	private readonly onConsultationsChanged?: () => void;
	private readonly reconcileOnly: boolean;
	private startupReconciliation = true;
	private suppressConsultationAttention = false;
	private readonly onStatus: (kind: "info" | "warning" | "error", text: string) => void;
	private readonly clock: RefreshClock;
	private readonly turnLogs: TurnLogSource;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private cycleInFlight = false;
	private holdingHerdrError = false;
	/**
	 * The agents of the last successful list, for the UI's markers. Null
	 * until the first success: an unreadable herdr must not read as "every
	 * pane is missing".
	 */
	private lastAgentsList: readonly HerdrAgent[] | null = null;
	/** In-flight tickets the loop already restarted this episode. */
	private readonly restarted = new Set<string>();

	/**
	 * The agents of the last successful `agent list`, or null before the
	 * first success.
	 */
	lastAgents(): readonly HerdrAgent[] | null {
		return this.lastAgentsList;
	}

	constructor(options: ObservationOptions) {
		this.state = options.state;
		this.herdr = options.herdr;
		this.config = options.config;
		this.dispatch = options.dispatch;
		this.cleanup = options.cleanup;
		this.now = options.now;
		this.mode = options.mode;
		this.intervalMs = options.intervalMs;
		this.startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS;
		this.onChanged = options.onChanged;
		this.onAgents = options.onAgents;
		this.onConsultationAttention = options.onConsultationAttention;
		this.onConsultationsChanged = options.onConsultationsChanged;
		this.reconcileOnly = options.reconcileOnly ?? false;
		this.onStatus = options.onStatus;
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.turnLogs = options.turnLogs ?? SESSION_TURN_LOGS;
	}

	/** Begin polling. The first cycle runs immediately. */
	start(): void {
		if (this.timer !== null || this.stopped) return;
		void this.safeCycle();
		this.scheduleNext();
	}

	/** Schedule the next cycle on the clock; a stopped loop schedules none. */
	private scheduleNext(): void {
		if (this.stopped || this.timer !== null) return;
		this.timer = this.clock.setTimeout(this.nextCycle, this.intervalMs);
	}

	private nextCycle = (): void => {
		this.timer = null;
		void this.safeCycle().finally(() => this.scheduleNext());
	};

	/** Run one cycle when one is not already running. Returns when it is done. */
	async tick(): Promise<void> {
		await this.safeCycle();
	}

	/** Stop polling. Safe to call more than once. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) {
			this.clock.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private async safeCycle(): Promise<void> {
		if (this.stopped || this.cycleInFlight) return;
		this.cycleInFlight = true;
		try {
			await this.cycle();
		} catch (error) {
			// The app can stop mid-cycle: a stopped loop must not touch the
			// state or the UI anymore.
			if (this.stopped) return;
			this.onStatus(
				"warning",
				`observation cycle failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.onChanged();
		} finally {
			this.cycleInFlight = false;
		}
	}

	private async cycle(): Promise<void> {
		const probe = await this.herdr.listAgents();
		// The probe can outlive the app: stop() during it must not touch the
		// state or the UI anymore.
		if (this.stopped) return;
		if (probe.kind === "error") {
			// A failed probe carries no list: drop the markers until it holds.
			this.onAgents?.(null);
			if (!this.holdingHerdrError) {
				this.holdingHerdrError = true;
				this.onStatus(
					"warning",
					`herdr is unreachable: ${probe.reason}; the observation is holding`,
				);
				this.onChanged();
			}
			return;
		}
		this.lastAgentsList = probe.agents;
		this.suppressConsultationAttention = this.reconcileOnly && this.startupReconciliation;
		this.startupReconciliation = false;
		if (this.holdingHerdrError) {
			this.holdingHerdrError = false;
			this.onStatus("info", "herdr is reachable again; the observation resumed");
			this.onChanged();
		}

		const autoOn = this.mode();
		const byPane = new Map<string, HerdrAgent>();
		for (const agent of probe.agents) byPane.set(agent.paneId, agent);

		// An agent can outlive the cycle that started it. Re-claim the live ones
		// before the parallel count is taken: a reclaimed agent is real work.
		const reclaimed = this.reclaimLiveAgents(byPane);
		if (this.stopped) return;

		// The parallel count is the in-flight tickets whose agent was alive
		// in this poll: a blocked agent still holds a slot, a missing one
		// does not.
		const inFlight = this.state.ticketsByState(["handed-off", "running"]);
		let liveCount = 0;
		for (const ticket of inFlight) {
			if (ticket.paneId !== null && byPane.has(ticket.paneId)) liveCount += 1;
		}

		// An episode ends when its ticket leaves in-flight: restarts may resume.
		for (const identity of [...this.restarted]) {
			if (!inFlight.some((ticket) => ticket.ticketIdentity === identity))
				this.restarted.delete(identity);
		}

		let changed = reclaimed;
		for (const ticket of inFlight) {
			if (ticket.paneId === null) continue;
			const agent = byPane.get(ticket.paneId);
			if (agent === undefined) {
				if (autoOn) {
					changed = (await this.handleMissing(ticket, liveCount)) || changed;
					if (this.stopped) return;
				}
				continue;
			}
			const status = normalizeAgentStatus(agent.status);
			// A state correction on read: herdr owns the fact of whether the
			// agent is working, so the poll corrects the stored state to
			// match it, and the list shows reality without the control plane
			// ever writing to herdr.
			if (status === "working" && this.state.markTicketRunning(ticket.ticketIdentity)) {
				changed = true;
			}
			if ((status === "done" || status === "idle") && this.turnSettles(ticket)) {
				changed = (await this.settle(ticket, agent)) || changed;
				if (this.stopped) return;
			}
		}

		// An awaiting ticket that reports working again resumes its still-pending
		// turn. It holds a slot and its next settle refreshes the same trace.
		for (const ticket of this.state.ticketsByState(["awaiting"])) {
			if (ticket.paneId === null) continue;
			const agent = byPane.get(ticket.paneId);
			if (agent === undefined || normalizeAgentStatus(agent.status) !== "working") continue;
			if (this.state.reopenTurn(ticket.ticketIdentity, ticket.handoffAttemptId)) {
				changed = true;
				liveCount += 1;
			}
		}

		for (const ticket of this.state.ticketsByState(["awaiting"])) {
			changed = (await this.handleAwaiting(ticket, liveCount, autoOn)) || changed;
			if (this.stopped) return;
		}

		// The count is what this poll saw alive, before the settles above:
		// a ticket that settled this cycle still holds its seat here. The
		// next poll no longer sees it in flight and frees the seat.
		if (autoOn) {
			changed = this.dispatchOpen(liveCount) || changed;
		}

		// Tickets and Consultations share this one successful Herdr list poll.
		// A Consultation never enters the Ticket parallel count above.
		const consultationChanged = await this.observeConsultations(probe.agents);
		changed = consultationChanged || changed;
		if (changed) this.onChanged();
		this.onAgents?.(probe.agents);
	}

	/** Whether a done or idle agent settles the ticket's turn. */
	private turnSettles(ticket: HandoffTicket): boolean {
		if (ticket.state === "running") return true;
		return this.now() - Date.parse(ticket.startedAt) >= this.startupGraceMs;
	}

	/**
	 * Re-claim every live agent whose work cycle has closed.
	 *
	 * A close ends a cycle and returns the ticket to open (ADR 0005). The
	 * agent that cycle started can keep working in the same pane: the Close
	 * cleanup leaves the workspace open when it cannot remove the checkout,
	 * and the operator can re-prompt a settled agent in herdr. The loop would
	 * stop looking at that pane, so the list would read `open` while the
	 * agent works, and the next handoff of that ticket would fail on the
	 * herdr agent name the live agent still holds. Herdr owns the fact that
	 * the agent works, so the poll records it as a Reclaimed handoff, exactly
	 * as it corrects a ticket still in flight to `running`.
	 *
	 * Only a working or blocked agent is reclaimed: an idle, done, or unknown
	 * report says nothing about live work. A pane another ticket already
	 * holds is left alone, and a closed cycle keeps its own decided trace.
	 * Returns whether the factory state changed.
	 */
	private reclaimLiveAgents(byPane: ReadonlyMap<string, HerdrAgent>): boolean {
		const held = new Set<string>();
		for (const ticket of this.state.ticketsByState(["handed-off", "running", "awaiting"])) {
			if (ticket.paneId !== null) held.add(ticket.paneId);
		}
		let changed = false;
		for (const ticket of this.state.ticketsByState(["open"])) {
			if (this.stopped) return changed;
			if (ticket.paneId === null || held.has(ticket.paneId)) continue;
			const agent = byPane.get(ticket.paneId);
			if (agent === undefined) continue;
			const status = normalizeAgentStatus(agent.status);
			if (status !== "working" && status !== "blocked") continue;
			const claimed = this.state.reclaimHandoff(ticket.ticketIdentity, {
				paneId: agent.paneId,
				tabId: agent.tabId,
				workspaceId: agent.workspaceId,
			});
			if (claimed === null) continue;
			held.add(agent.paneId);
			changed = true;
			this.onStatus(
				"warning",
				`agent still works on ticket ${ticket.ticketIdentity} after its cycle closed; the ticket runs again`,
			);
		}
		return changed;
	}

	/** Reconcile durable Consultations from the same Agent list as Tickets. */
	private async observeConsultations(agents: readonly HerdrAgent[]): Promise<boolean> {
		const consultations = this.state.consultationsByState([
			"opening",
			"working",
			"awaiting-response",
		]);
		let changed = false;
		for (const consultation of consultations) {
			if (this.stopped) return changed;
			const match = matchConsultationAgent(consultation, agents);
			if (match === "ambiguous" || match === undefined) {
				if (consultation.state === "opening") {
					// A restart can interrupt launch between durable steps. The
					// operator, not the poll, decides whether recovery continues.
					const warning =
						match === "ambiguous"
							? "Opening Agent match is ambiguous; explicit recovery is required"
							: "Opening Agent is not visible; explicit recovery is required";
					if (consultation.warning !== warning) {
						this.state.setConsultationWarning(consultation.id, warning);
						changed = true;
						this.onStatus("warning", `Consultation ${consultation.id.slice(0, 8)} needs recovery`);
					}
					continue;
				}
				const reason =
					match === "ambiguous" ? "Agent session match is ambiguous" : "Agent is missing";
				const moved = this.state.setConsultationState(consultation.id, "missing", reason);
				changed = moved || changed;
				if (moved)
					this.onStatus("warning", `${reason} for Consultation ${consultation.id.slice(0, 8)}`);
				continue;
			}
			if (consultation.state === "opening") {
				// A uniquely verified Agent may refresh its durable handles, but
				// remains opening until the operator chooses recovery.
				this.state.recordConsultationAgentHandles(consultation.id, {
					paneId: match.paneId,
					tabId: match.tabId,
					workspaceId: match.workspaceId,
					sessionId: match.stableSessionId ?? consultation.sessionId,
				});
				const warning =
					normalizeAgentStatus(match.status) === "unknown"
						? "Agent status is unknown"
						: "Opening Agent verified; explicit recovery is required";
				if (consultation.warning !== warning) {
					this.state.setConsultationWarning(consultation.id, warning);
					changed = true;
				}
				continue;
			}
			if (
				consultation.paneId !== match.paneId ||
				consultation.tabId !== match.tabId ||
				consultation.workspaceId !== match.workspaceId
			) {
				this.state.updateConsultationAgentHandles(consultation.id, {
					paneId: match.paneId,
					tabId: match.tabId,
					workspaceId: match.workspaceId,
					sessionId: match.stableSessionId ?? consultation.sessionId,
				});
				changed = true;
			}
			const status = normalizeAgentStatus(match.status);
			if (status === "unknown") {
				if (consultation.warning !== "Agent status is unknown") {
					this.state.setConsultationWarning(consultation.id, "Agent status is unknown");
					this.onStatus(
						"warning",
						`Agent status is unknown for Consultation ${consultation.id.slice(0, 8)}`,
					);
					changed = true;
				}
				continue;
			}
			if (consultation.warning === "Agent status is unknown") {
				this.state.setConsultationWarning(consultation.id, null);
				changed = true;
			}
			if (
				consultation.state === "awaiting-response" &&
				match.sequence !== undefined &&
				(consultation.latestSequence === null || match.sequence > consultation.latestSequence)
			)
				changed =
					this.state.recordExternalConsultationTurn(
						consultation.id,
						match.sequence,
						new Date(this.now()).toISOString(),
					) || changed;
			const before = this.state.consultation(consultation.id);
			if (
				before?.state === "awaiting-response" &&
				this.state.consultationNeedsSnapshot(consultation.id)
			) {
				const output = await this.herdr.readPane(
					match.paneId,
					this.config().completionMessageLines,
				);
				if (this.stopped) return changed;
				if (output !== null && this.state.fillConsultationSnapshot(consultation.id, output)) {
					changed = true;
					this.onConsultationsChanged?.();
				}
			}
			const current = this.state.consultation(consultation.id);
			if (current?.state !== "working" || status === "working") continue;
			const output = await this.herdr.readPane(match.paneId, this.config().completionMessageLines);
			if (this.stopped) return changed;
			const settled = this.state.settleConsultationTurn(
				consultation.id,
				match.sequence ?? null,
				output,
				status,
				new Date(this.now()).toISOString(),
			);
			if (!settled) continue;
			changed = true;
			this.onConsultationsChanged?.();
			if (!this.suppressConsultationAttention) this.onConsultationAttention?.(consultation.id);
			this.onStatus("info", `Consultation ${consultation.id.slice(0, 8)} awaits a response`);
		}
		return changed;
	}

	/** A settled turn: read the log, rest the ticket in awaiting. */
	private async settle(
		ticket: {
			ticketIdentity: string;
			handoffAttemptId: string;
			taskType: string;
			agentType: string;
		},
		agent: HerdrAgent,
	): Promise<boolean> {
		// The log comes from the session record first (ADR 0008). The
		// terminal capture is the fallback: no session reported, the reader
		// knows no such kind, or the record is missing or unreadable.
		const kind = this.config().agents[ticket.agentType]?.kind;
		let turnLog: TurnLogEntry[] | null =
			kind !== undefined && agent.sessionId !== ""
				? await this.turnLogs.read(kind, agent.sessionId)
				: null;
		let message = turnLog !== null ? lastMessageFromLog(turnLog) : "";
		if (turnLog === null || turnLog.length === 0) {
			const capture =
				(await this.herdr.readPane(agent.paneId, this.config().completionMessageLines)) ?? "";
			turnLog = turnLogFromCapture(capture);
			message = capture;
		} else if (message === "") {
			// The log holds no final text: the capture stands in for the
			// message, the session log stays.
			message =
				(await this.herdr.readPane(agent.paneId, this.config().completionMessageLines)) ?? "";
		}
		if (this.stopped) return true;
		this.state.settleTurn({
			ticketIdentity: ticket.ticketIdentity,
			handoffId: ticket.handoffAttemptId,
			taskType: ticket.taskType,
			agentType: ticket.agentType,
			message,
			turnLog,
			completedAt: new Date(this.now()).toISOString(),
		});
		this.onStatus("info", `agent settled a turn on ticket ${ticket.ticketIdentity}`);
		return true;
	}

	/**
	 * An in-flight ticket whose pane herdr no longer lists: missing.
	 *
	 * Auto mode restarts it in its workspace with a restart prompt carrying
	 * the last captured message; a ticket that has used up its handoffs is
	 * abandoned instead, with the Close cleanup. Manual mode leaves it for
	 * the operator's panel. A ticket already restarted this episode is not
	 * restarted again until the episode ends.
	 */
	private async handleMissing(ticket: HandoffTicket, liveCount: number): Promise<boolean> {
		const config = this.config();
		const handoffCount = this.state.handoffCount(ticket.ticketIdentity);
		if (handoffCount >= config.maxHandoffsPerTicket) {
			const applied = this.state.applyCompletionDecision({
				ticketIdentity: ticket.ticketIdentity,
				handoffId: ticket.handoffAttemptId,
				decision: "abandoned",
				decidedAt: new Date(this.now()).toISOString(),
			});
			this.restarted.delete(ticket.ticketIdentity);
			if (!applied) return false;
			const failure = await this.cleanup(ticket);
			if (this.stopped) return true;
			this.onStatus(
				failure === undefined ? "warning" : "error",
				failure === undefined
					? `ticket ${ticket.ticketIdentity} abandoned: its handoff limit is ${config.maxHandoffsPerTicket}`
					: `ticket ${ticket.ticketIdentity} abandoned; the close cleanup failed: ${failure}`,
			);
			return true;
		}
		// The missing agent holds no slot, so liveCount already excludes it.
		if (config.maxParallelAgents > 0 && liveCount >= config.maxParallelAgents) {
			return false;
		}
		if (this.restarted.has(ticket.ticketIdentity)) return false;
		this.restarted.add(ticket.ticketIdentity);
		const previousMessage = this.state.lastCompletion(ticket.ticketIdentity)?.message ?? "";
		// The same choices the previous handoff ran with: the operator's
		// restart keeps the model and thinking, and the auto one matches it.
		const result = await this.dispatch({
			origin: "restart",
			ticketIdentity: ticket.ticketIdentity,
			choice: baseChoice(
				ticket.agentType,
				ticket.environment,
				ticket.taskType,
				ticket.model,
				ticket.thinking,
			),
			previousMessage,
		});
		if (this.stopped) return true;
		if (!result.ok) {
			this.onStatus(
				"warning",
				`restart of ticket ${ticket.ticketIdentity} failed: ${result.reason}`,
			);
			return false;
		}
		this.onStatus("warning", `agent missing on ticket ${ticket.ticketIdentity}; restarting`);
		return true;
	}

	/**
	 * Resolve an awaiting ticket by the automatic rule. Returns whether the
	 * cycle changed factory state.
	 *
	 * The rule applies to every ticket with auto-handoff on, and to the
	 * auto-close types without it. The decision is recorded only after a
	 * successful claim: a route that cannot start leaves the pending trace
	 * for the next cycle instead of holding a decision the handoff never
	 * made.
	 */
	private async handleAwaiting(
		ticket: HandoffTicket,
		liveCount: number,
		autoOn: boolean,
	): Promise<boolean> {
		const config = this.config();
		const handoffCount = this.state.handoffCount(ticket.ticketIdentity);
		const decision = this.decideAwaiting(ticket.taskType, liveCount, handoffCount, autoOn);
		if (decision === "wait") return false;
		const decidedAt = new Date(this.now()).toISOString();
		if (decision === "close") {
			const applied = this.state.applyCompletionDecision({
				ticketIdentity: ticket.ticketIdentity,
				handoffId: ticket.handoffAttemptId,
				decision: "auto-closed",
				decidedAt,
			});
			if (!applied) return false;
			const failure = await this.cleanup(ticket);
			if (this.stopped) return true;
			this.onStatus(
				failure === undefined ? "info" : "error",
				failure === undefined
					? `ticket ${ticket.ticketIdentity} auto-closed`
					: `ticket ${ticket.ticketIdentity} auto-closed; the close cleanup failed: ${failure}`,
			);
			return true;
		}
		// `route` is only returned with exactly one edge and one target.
		const edge = this.singleEdge(ticket.taskType);
		if (edge === undefined || edge.to.length !== 1) return false;
		const previousMessage = this.state.lastCompletion(ticket.ticketIdentity)?.message ?? "";
		// A Workflow Handoff never inherits the previous Handoff's Model or
		// Thinking: the routed handoff resolves agent, model, and thinking
		// through the target task profile's chain, with the edge's own pin above
		// the profile (ADR 0009).
		const routed = resolveSettings({
			config,
			taskType: edge.to[0],
			edgeAgent: edge.agent,
		});
		const result = await this.dispatch({
			origin: "workflow",
			ticketIdentity: ticket.ticketIdentity,
			choice: baseChoice(
				routed.agentType,
				resolveEnvironment(config, edge.environment),
				edge.to[0],
				routed.model,
				routed.thinking,
			),
			previousMessage,
		});
		if (this.stopped) return true;
		if (!result.ok) {
			this.onStatus(
				"warning",
				`automatic route for ticket ${ticket.ticketIdentity} failed: ${result.reason}`,
			);
			return false;
		}
		const applied = this.state.applyCompletionDecision({
			ticketIdentity: ticket.ticketIdentity,
			handoffId: ticket.handoffAttemptId,
			decision: "auto-handed-off",
			decidedAt,
		});
		if (applied) this.onStatus("info", `ticket ${ticket.ticketIdentity} routed to ${edge.to[0]}`);
		return applied;
	}

	/**
	 * The automatic completion rule: it applies to every task type with
	 * auto-handoff on, and to the auto-close types without it.
	 *
	 * A route at the handoff limit degrades to close: the ticket returns
	 * to open wearing the handoff-limit marker, where the operator can
	 * still hand it off manually. Exactly one outgoing edge routes while
	 * the parallel limit has room; a full limit waits in awaiting until a
	 * slot frees. Any other edge count closes. In manual mode a
	 * non-auto-close type waits for the operator.
	 */
	decideAwaiting(
		taskType: string,
		liveCount: number,
		handoffCount: number,
		autoOn: boolean,
	): AwaitingDecision {
		const config = this.config();
		if (!autoOn && config.taskTypes[taskType]?.autoClose !== true) return "wait";
		if (handoffCount >= config.maxHandoffsPerTicket) return "close";
		const edge = this.singleEdge(taskType);
		if (edge !== undefined && edge.to.length === 1) {
			if (config.maxParallelAgents > 0 && liveCount >= config.maxParallelAgents) return "wait";
			return "route";
		}
		return "close";
	}

	private singleEdge(taskType: string): WorkflowEdge | undefined {
		const edges = this.config().workflows.filter((edge) => edge.from === taskType);
		return edges.length === 1 ? edges[0] : undefined;
	}

	/**
	 * With auto-handoff on, hand off each eligible open ticket: actionable,
	 * under the parallel limit, and under the handoff limit.
	 */
	private dispatchOpen(liveCount: number): boolean {
		const config = this.config();
		const limit = config.maxParallelAgents;
		const tickets = this.state.visibleTickets(config.taskRules, config.defaultTaskType);
		let count = liveCount;
		let any = false;
		for (const ticket of tickets) {
			if (ticket.state !== "open" || !ticket.actionable) continue;
			if (ticket.handoffCount >= config.maxHandoffsPerTicket) continue;
			if (limit > 0 && count >= limit) break;
			count += 1;
			// The configured settings of the ticket's task profile (ADR 0009): an
			// unattended handoff starts with the same resolution chain a manual
			// one sees in the panel, and the fit check guards what it starts with.
			const resolved = resolveSettings({
				config,
				taskType: ticket.suggestedTaskType,
			});
			const choice = baseChoice(
				resolved.agentType,
				config.defaultEnvironment,
				ticket.suggestedTaskType,
				resolved.model,
				resolved.thinking,
			);
			void this.dispatch({
				origin: "open",
				ticketIdentity: ticket.identity,
				choice,
				previousMessage: "",
			}).then((result) => {
				if (!result.ok)
					this.onStatus(
						"warning",
						`auto-handoff for ticket ${ticket.identity} failed: ${result.reason}`,
					);
			});
			this.onStatus("info", `auto-handoff: handing off ticket ${ticket.identity}`);
			any = true;
		}
		return any;
	}
}
