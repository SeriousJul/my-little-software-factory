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
 *    awaiting. A settle is trusted only when the turn demonstrably started,
 *    and the proof is the session record, not herdr's status (ADR 0017): a
 *    record that holds the turn's end settles at once, but a record without
 *    a turn - or one that cannot be read - waits out the startup grace, the
 *    window in which a booted agent reports idle before it picks up the
 *    prompt. A working report marks the ticket running, but it drops no
 *    grace. An awaiting ticket whose agent is working again reopens: its
 *    still-pending turn did not end, and the next settle refreshes the trace
 *    in place.
 * 3. A pane herdr no longer lists is missing, except for a started agent
 *    still inside the startup grace: it is booting, not missing. With
 *    auto-handoff on the loop abandons the cycle when the ticket has used
 *    up its handoffs, and the top-up restarts the missing agent once per
 *    episode as a Work queue item.
 * 4. With auto-handoff on, the automatic completion decisions resolve the
 *    awaiting tickets (ADR 0051): the completions the machine resolves
 *    close their cycle, and a completion that offers a continuation rests
 *    in awaiting for the top-up: a held turn, a transition whose label
 *    write failed, and a same-type hold park the ticket for the operator,
 *    and a routable ticket's route is the top-up's continuation item.
 * 5. The Work queue's pickup (ADR 0049): the items the free seats take, in
 *    queue order, run before the top-up. Every pickup ends in start or
 *    drop, so the queue never sits stuck.
 * 6. The auto top-up (ADR 0051): while Auto-handoff mode is on, the queue
 *    pause is down, the Dispatch pause is clear, and the queue is empty,
 *    the cycle adds exactly one item - a continuation first, then a
 *    restart, then a new open ticket, else nothing. A queue that holds even
 *    one item holds the automatic adds until it drains, so the queue never
 *    piles.
 *
 * When herdr cannot be listed at all, the loop pauses and holds: the last
 * known facts stay, and the UI warns. Nothing is re-run blindly on
 * recovery: a cycle that cannot see its agents does not settle, reclaim, or
 * restart anything.
 */

import type { FactoryConfig, TransitionOutcome } from "./config.ts";
import { type Completion, isHeldCompletion, type Ticket } from "./domain/ticket.ts";
import { baseChoice, resolveHandoffChoice } from "./handoff.ts";
import type { DispatchResult, HandoffIntent } from "./handoff-dispatch.ts";
import type { HerdrAgent } from "./herdr.ts";
import { identifyHandoffAgentName } from "./naming.ts";
import { type RefreshClock, SYSTEM_CLOCK } from "./refresh.ts";
import { type CommandRunner, commandFailureText } from "./runner.ts";
import type { Consultation, FactoryState, HandoffTicket } from "./state.ts";
import {
	isHeldCause,
	lastMessageFromLog,
	readSessionTurnEnd,
	type SessionTurnRead,
	type TurnEnd,
	type TurnEndCause,
	type TurnLogEntry,
	turnLogFromCapture,
} from "./turn-log.ts";
import type { RefiredSkip } from "./workflow.ts";

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
 * The settled turn, read from the agent's session record: its log, its end
 * cause, and the cause's detail, in one read (ADR 0015). The read answers
 * three ways (ADR 0017): the turn ended, the record holds no turn, or the
 * record is unavailable.
 *
 * The kind is the agent type's kind from the config, the sessionId the path
 * herdr reported, and startedAt the handoff's started time that feeds the
 * staleness guard. `no-turn` and `unavailable` both yield the terminal
 * capture fallback; only `ended` settles inside the startup grace. The real
 * source reads the file (ADR 0008); tests inject a fake.
 */
export interface TurnLogSource {
	read(kind: string, sessionId: string, startedAt: string | null): Promise<SessionTurnRead>;
}

/** The real turn source: the per-agent-type session record readers. */
export const SESSION_TURN_LOGS: TurnLogSource = {
	read: (kind, sessionId, startedAt) =>
		Promise.resolve(readSessionTurnEnd(kind, sessionId, startedAt)),
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
				...(typeof record.name === "string" && record.name !== "" ? { name: record.name } : {}),
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
		// The known pane matches. A Herdr version that omits the stable session
		// id cannot contradict the stored one, so the match stands at weaker
		// certainty: the caller keeps its stored id (issue #24).
		if (
			consultation.sessionId === null ||
			pane.stableSessionId === undefined ||
			pane.stableSessionId === consultation.sessionId
		)
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
 * The decision an awaiting ticket resolves to on a cycle (ADR 0051).
 *
 * - `close`: the machine resolves the completion and closes the cycle: a
 *   turn whose task type offers no continuation, a transition that advanced
 *   into a parking state, or a route degraded at the handoff limit.
 * - `route`: the fired transition auto-advances into a position the machine
 *   offers a task for: the top-up's continuation, enqueued while the queue
 *   is empty and the gates hold nothing.
 * - `park`: the ticket rests in awaiting for the operator: a transition
 *   whose label write failed, a held turn, or the same-type hold.
 */
export type AwaitingDecision = "close" | "route" | "park";

/**
 * A structured topic for an onStatus event. The UI reacts to the topic, never
 * to the human-facing text: the text may be reworded without breaking the
 * behavior that listens for it.
 */
export type ObservationStatusTopic = "herdr-recovered";

interface ObservationOptions {
	state: FactoryState;
	herdr: AgentReader;
	/** The config, read at each cycle: a runtime write-back stays visible. */
	config: () => FactoryConfig;
	/**
	 * The app's handoff path: claim, external work, settle, refresh. The
	 * returned result answers the claim; the intent's `onStarted` answers the
	 * start the claim only reserves.
	 */
	dispatch: (intent: HandoffIntent) => Promise<DispatchResult>;
	/**
	 * The Work queue's pickup (ADR 0034): the queue items the free seats take
	 * this cycle, run before auto-dispatch, in queue order. Returns the items
	 * that claimed a seat. Absent where the app has no Work queue.
	 */
	pickupWorkQueue?: () => Promise<number>;
	/**
	 * A cycle of this ticket ended: a close or abandon landed, and the ticket
	 * returned to open. The agent of the ended cycle may have changed the
	 * source item, so the app re-reads the ticket's sources now: the ticket
	 * stays unverified against new dispatches until the re-read lands.
	 */
	onCycleEnd?: (ticketIdentity: string) => void;
	/**
	 * The Close cleanup of an auto-ended cycle: the worktree workspace is
	 * removed or the live tab is closed. Returns a failure reason. The end
	 * tells the dispatch seam which completion path closed the cycle.
	 */
	cleanup: (handoff: HandoffTicket, end: "closed" | "abandoned") => Promise<string | undefined>;
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
	/** An operational message fact for the Message line. */
	onStatus: (
		kind: "info" | "warning" | "error",
		text: string,
		topic?: ObservationStatusTopic,
	) => void;
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
	/**
	 * The transition fire of a completed turn (ADR 0027): the app's seam
	 * writes the task type's label facts through the command runner and
	 * returns the outcome the completion decision reads. Omitted: the turn
	 * settles without a transition.
	 */
	fireCompleted?: (ticket: HandoffTicket) => Promise<TransitionOutcome | null>;
	/**
	 * The re-fire of the recorded skips (ADR 0042): the app's seam re-fires,
	 * through the command runner, the transition a refresh-time sweep found
	 * recorded as the skip on a ticket's newest completion trace, for a
	 * ticket that now stands an open fixing pull request. Returns the skips
	 * whose trace took the re-fired outcome. Omitted: no recorded skip
	 * re-fires, and the auto-advance of a closed cycle's skip never runs.
	 */
	refireRecordedSkips?: () => Promise<RefiredSkip[]>;
}

export class ObservationCoordinator {
	private readonly state: FactoryState;
	private readonly herdr: AgentReader;
	private readonly config: () => FactoryConfig;
	private readonly dispatch: (intent: HandoffIntent) => Promise<DispatchResult>;
	private readonly pickupWorkQueue?: () => Promise<number>;
	private readonly onCycleEnd?: (ticketIdentity: string) => void;
	private readonly cleanup: (
		handoff: HandoffTicket,
		end: "closed" | "abandoned",
	) => Promise<string | undefined>;
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
	private readonly onStatus: (
		kind: "info" | "warning" | "error",
		text: string,
		topic?: ObservationStatusTopic,
	) => void;
	private readonly clock: RefreshClock;
	private readonly turnLogs: TurnLogSource;
	private readonly fireCompleted?: (ticket: HandoffTicket) => Promise<TransitionOutcome | null>;
	private readonly refireRecordedSkips?: () => Promise<RefiredSkip[]>;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private cycleInFlight = false;
	private holdingHerdrError = false;
	/**
	 * Whether the Dispatch pause was active last cycle, so the Message line can
	 * report it when it trips and when it clears. The pause itself is derived
	 * each cycle and never stored (ADR 0016); this only remembers the last
	 * report.
	 */
	private pauseActive = false;
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
		this.pickupWorkQueue = options.pickupWorkQueue;
		this.onCycleEnd = options.onCycleEnd;
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
		this.fireCompleted = options.fireCompleted;
		this.refireRecordedSkips = options.refireRecordedSkips;
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
			this.onStatus("info", "herdr is reachable again; the observation resumed", "herdr-recovered");
			this.onChanged();
		}

		const autoOn = this.mode();
		const byPane = new Map<string, HerdrAgent>();
		for (const agent of probe.agents) byPane.set(agent.paneId, agent);

		// An agent can outlive the cycle that started it. Re-claim the live ones
		// before the parallel count is taken: a reclaimed agent is real work.
		const reclaimed = this.reclaimLiveAgents(byPane);
		if (this.stopped) return;

		const inFlight = this.state.ticketsByState(["handed-off", "running"]);
		// The cap the starts measure against (ADR 0049, ADR 0051): the shared
		// seat count of the poll - the in-flight tickets the poll lists or
		// still holds in their startup grace, every in-progress handoff, and
		// every Consultation in opening or working - the one source the mode
		// line reads too. The top-up adds against it, and a cap the item cannot
		// take yet is the wait the queue item holds.

		// An episode ends when its ticket leaves in-flight: restarts may resume.
		for (const identity of [...this.restarted]) {
			if (!inFlight.some((ticket) => ticket.ticketIdentity === identity))
				this.restarted.delete(identity);
		}

		let changed = reclaimed;
		for (const ticket of inFlight) {
			if (ticket.paneId === null) continue;
			const agent = byPane.get(ticket.paneId);
			// The pane id of a closed pane is handed out again: a live agent in
			// the ticket's pane that is not the ticket's own leaves the ticket's
			// agent missing, so the missing path runs instead of the settle.
			const foreign =
				agent !== undefined &&
				identifyHandoffAgentName(
					agent.name,
					this.state.agentNameForTicket(ticket.ticketIdentity),
				) === "foreign";
			if (agent === undefined || foreign) {
				if (autoOn) {
					changed = (await this.handleMissing(ticket)) || changed;
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
			if (status === "done" || status === "idle") {
				// One read serves the decision and the trace: the same session
				// read that settles the turn supplies its log, cause, and
				// detail (ADR 0015).
				const turnEnd = await this.maybeReadTurnEnd(ticket, agent);
				if (this.maybeSettles(ticket, turnEnd)) {
					changed = (await this.settle(ticket, agent, turnEnd)) || changed;
					if (this.stopped) return;
				}
			}
		}

		// An awaiting ticket that reports working again resumes its still-pending
		// turn. It holds a slot and its next settle refreshes the same trace.
		for (const ticket of this.state.ticketsByState(["awaiting"])) {
			if (ticket.paneId === null) continue;
			const agent = byPane.get(ticket.paneId);
			if (agent === undefined || normalizeAgentStatus(agent.status) !== "working") continue;
			// The same identity rule as the in-flight loop: a working agent in
			// the ticket's reused pane id that is not the ticket's own does not
			// resume the ticket's pending turn.
			if (
				identifyHandoffAgentName(
					agent.name,
					this.state.agentNameForTicket(ticket.ticketIdentity),
				) === "foreign"
			)
				continue;
			if (this.state.reopenTurn(ticket.ticketIdentity, ticket.handoffAttemptId)) {
				changed = true;
			}
		}

		// The re-fire of the recorded skips (ADR 0042): a refresh that found
		// the fixing pull request re-fires the transition the ticket's newest
		// completion trace recorded as the skip, and the trace takes the
		// re-fired outcome. The sweep runs after the settles, so a skip this
		// cycle settled re-fires in the same cycle the pull request already
		// lists, and before the top-up, so the re-fired skip's route is the
		// top-up's continuation candidate in this same cycle (ADR 0051).
		if (this.refireRecordedSkips !== undefined) {
			const refired = await this.refireRecordedSkips();
			if (this.stopped) return;
			if (refired.length > 0) {
				changed = true;
				for (const entry of refired) {
					if (entry.outcome.writeFailure === "") continue;
					// The failure stands on the trace, the way a settle-time
					// failure stands: the operator reads it beside the facts the
					// fire did write.
					this.onStatus(
						"warning",
						`the recorded skip of ticket ${entry.ticketIdentity} re-fired, and its label write failed: ${entry.outcome.writeFailure}`,
					);
				}
			}
		}

		// The awaiting walk resolves the completions the machine closes (ADR
		// 0051): a routable completion rests in awaiting, and its route is the
		// top-up's continuation.
		for (const ticket of this.state.ticketsByState(["awaiting"])) {
			changed = (await this.handleAwaiting(ticket, autoOn)) || changed;
			if (this.stopped) return;
		}

		// The Work queue's pickup runs before the top-up (ADR 0051): the items
		// the free seats take, in queue order. It runs in auto or manual mode
		// alike, and the queue pause holds it (ADR 0052).
		if (this.pickupWorkQueue !== undefined) {
			const picked = await this.pickupWorkQueue();
			if (this.stopped) return;
			if (picked > 0) changed = true;
		}

		// The auto top-up (ADR 0051): with Auto-handoff on, the queue empty,
		// the queue pause down, and the Dispatch pause clear, the cycle adds
		// exactly one item - a continuation first, then a restart, then a new
		// open ticket, else nothing.
		changed = (await this.topUpQueue(probe.agents)) || changed;
		if (this.stopped) return;

		// Tickets and Consultations share this one successful Herdr list poll.
		// A Consultation in `opening` or `working` already holds its seat in
		// the shared count above (ADR 0034).
		const consultationChanged = await this.observeConsultations(probe.agents);
		changed = consultationChanged || changed;
		// The Dispatch pause is derived from the traces each cycle and never
		// stored (ADR 0016). The Message line reports it when it trips and when
		// it clears, so the operator hears about the factory stopping and
		// resuming dispatch on the line it already watches, in any mode: the
		// pause holds the transition routes in manual mode too. The
		// mode line wears it `paused` in auto mode, the state it names.
		const effectivePause = this.state.dispatchPauseActive();
		if (effectivePause !== this.pauseActive) {
			this.pauseActive = effectivePause;
			this.onStatus(
				effectivePause ? "warning" : "info",
				effectivePause
					? "Dispatch pause: a held failed turn is blocking automatic dispatch"
					: "Dispatch pause cleared: automatic dispatch resumes",
			);
		}
		if (changed) this.onChanged();
		this.onAgents?.(probe.agents);
	}

	/**
	 * The settled turn, read once from the agent's session record.
	 *
	 * `unavailable` when herdr reports no session, the agent type has no
	 * known kind, or the reader cannot read the record: the settle then falls
	 * back to the terminal capture with an `unknown` cause.
	 */
	private async maybeReadTurnEnd(
		ticket: { ticketIdentity: string; agentType: string; startedAt: string },
		agent: HerdrAgent,
	): Promise<SessionTurnRead> {
		const kind = this.config().agents[ticket.agentType]?.kind;
		if (kind === undefined || agent.sessionId === "") return { kind: "unavailable" };
		return await this.turnLogs.read(kind, agent.sessionId, ticket.startedAt);
	}

	/** Whether a done or idle agent settles the ticket's turn now. */
	private maybeSettles(ticket: HandoffTicket, turnRead: SessionTurnRead): boolean {
		if (turnRead.kind === "ended") {
			// The record holds the turn's end, so the turn demonstrably
			// started: a turn that failed, aborted, or was truncated settles
			// at once (ADR 0016), and a turn that completed does too.
			return true;
		}
		// The record holds no turn, or it cannot be read. A working report
		// does not lift the grace (ADR 0017): herdr's view of the pane is not
		// evidence the turn ran, and a booted agent that flaps working while
		// it parks must not settle early. The grace, the clock, decides.
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
	 *
	 * The agent must also be the ticket's own, by the name: herdr hands the
	 * id of a closed pane out again, so the id a closed cycle's handoff
	 * recorded can name a pane a different agent owns - a Consultation's
	 * agent among them. The ticket's own agent runs under the name the
	 * ticket's handoff expects; any other name, or no name the reader can
	 * read, reclaims nothing. The recorded Reclaimed handoff stores the
	 * agent's name, so the next poll verifies the same identity.
	 *
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
			// The pane id of a closed pane is handed out again: a Consultation
			// or another ticket's agent can hold the id this ticket's last
			// handoff recorded. Only the agent that runs under the ticket's
			// own name is the ticket's own; anything else is not reclaimed.
			const name = agent.name;
			if (
				name === undefined ||
				identifyHandoffAgentName(name, this.state.agentNameForTicket(ticket.ticketIdentity)) !==
					"own"
			)
				continue;
			const claimed = this.state.reclaimHandoff(ticket.ticketIdentity, {
				paneId: agent.paneId,
				tabId: agent.tabId,
				workspaceId: agent.workspaceId,
				agentName: name,
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
			// The turn's end cause comes from the agent's session record, the
			// same reader the ticket settle uses (ADR 0015). The pending turn's
			// accepted time feeds the staleness guard.
			const kind = this.config().agents[consultation.agentType]?.kind;
			const pendingTurn = this.state
				.consultationTurns(consultation.id)
				.filter((turn) => turn.settledAt === null)
				.at(-1);
			// A record that holds no turn, or cannot be read, settles
			// `unknown`, the fail-open cause (ADR 0017): a Consultation
			// auto-decides nothing, and its operator is present at the screen
			// it settles on.
			const turnRead =
				kind !== undefined && match.sessionId !== ""
					? await this.turnLogs.read(kind, match.sessionId, pendingTurn?.acceptedAt ?? null)
					: ({ kind: "unavailable" } as SessionTurnRead);
			const turnEnd = turnRead.kind === "ended" ? turnRead.turnEnd : null;
			const endCause: TurnEndCause = turnEnd?.cause ?? "unknown";
			const endDetail: string = turnEnd?.detail ?? "";
			const settled = this.state.settleConsultationTurn(
				consultation.id,
				match.sequence ?? null,
				output,
				status,
				new Date(this.now()).toISOString(),
				endCause,
				endDetail,
			);
			if (!settled) continue;
			changed = true;
			this.onConsultationsChanged?.();
			if (!this.suppressConsultationAttention) this.onConsultationAttention?.(consultation.id);
			// A turn that failed or aborted is named on the Message line, so the
			// operator reads why it did not answer. Any other cause settles quiet.
			if (endCause === "failed" || endCause === "aborted")
				this.onStatus(
					"warning",
					`Consultation ${consultation.id.slice(0, 8)} turn ended ${endCause}${endDetail === "" ? "" : `: ${endDetail}`}`,
				);
			else this.onStatus("info", `Consultation ${consultation.id.slice(0, 8)} awaits a response`);
		}
		return changed;
	}

	/**
	 * A settled turn: store its log, cause, and detail, rest the ticket in
	 * awaiting.
	 *
	 * The log and the cause come from the session read that was made once
	 * before the settle was decided (ADR 0015, ADR 0017). The terminal
	 * capture stands in when the read is not `ended`: no session reported, the
	 * reader knows no such kind, the record is missing or unreadable
	 * (`unavailable`, cause `unknown`), or the record is readable and holds no
	 * turn (`no-turn`, cause `no-turn`, held). A record with no agent text but
	 * a cause keeps its cause - a failed turn with no words is still a failed
	 * turn - and the capture stands in for the display only.
	 */
	private async settle(
		ticket: HandoffTicket,
		agent: HerdrAgent,
		turnRead: SessionTurnRead,
	): Promise<boolean> {
		const turnEnd: TurnEnd | null = turnRead.kind === "ended" ? turnRead.turnEnd : null;
		let turnLog: TurnLogEntry[] = turnEnd?.log ?? [];
		const cause: TurnEndCause =
			turnEnd?.cause ?? (turnRead.kind === "no-turn" ? "no-turn" : "unknown");
		const detail: string = turnEnd?.detail ?? "";
		let message = lastMessageFromLog(turnLog);
		if (turnLog.length === 0) {
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
		// The transition fires on a `completed` settle, before the completion
		// decision, in manual mode and in auto mode alike (ADR 0027): it
		// writes the label facts and the trace stores its outcome, so the
		// decision the operator or the loop makes next reads the facts the
		// plane wrote, not a re-read of the source.
		let transition: TransitionOutcome | null;
		if (cause === "completed" && this.fireCompleted !== undefined) {
			transition = (await this.fireCompleted(ticket)) ?? null;
			if (this.stopped) return true;
		} else {
			transition = null;
		}
		this.state.settleTurn({
			ticketIdentity: ticket.ticketIdentity,
			handoffId: ticket.handoffAttemptId,
			taskType: ticket.taskType,
			agentType: ticket.agentType,
			message,
			turnLog,
			cause,
			detail,
			completedAt: new Date(this.now()).toISOString(),
			...(transition === null ? {} : { transition }),
		});
		// The Message line reports the hold at the moment it happens (user story
		// 29): a held settle is a warning that names the ticket and the cause,
		// with the detail truncated to the line and readable in full in the
		// detail pane. A completed or unknown settle stays the quiet info fact it
		// always was.
		if (isHeldCause(cause)) {
			this.onStatus(
				"warning",
				`ticket ${ticket.ticketIdentity} held (${cause})${detail === "" ? "" : `: ${detail}`}`,
			);
		} else {
			this.onStatus("info", `agent settled a turn on ticket ${ticket.ticketIdentity}`);
		}
		return true;
	}

	/**
	 * An in-flight ticket whose pane herdr no longer lists: missing, except a
	 * started agent still inside the startup grace: it is booting, and
	 * restarting it would double-start the turn.
	 *
	 * Auto mode restarts it in its workspace with a restart prompt carrying
	 * the last captured message; a ticket that has used up its handoffs is
	 * abandoned instead, with the Close cleanup. Manual mode leaves it for
	 * the operator's panel. A ticket already restarted this episode is not
	 * restarted again until the episode ends.
	 */
	/**
	 * The missing agent of an in-flight ticket, auto mode only (ADR 0051).
	 *
	 * The abandon at the handoff limit lands here, as a cycle end: the ticket
	 * has used up its handoffs, and the close ends the cycle. The restart is
	 * the top-up's: the missing agent waits for the top-up's one automatic
	 * add, as a Work queue item that takes its seat when one frees.
	 */
	private async handleMissing(ticket: HandoffTicket): Promise<boolean> {
		const config = this.config();
		if (this.now() - Date.parse(ticket.startedAt) < this.startupGraceMs) return false;
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
			this.onCycleEnd?.(ticket.ticketIdentity);
			const failure = await this.cleanup(ticket, "abandoned");
			if (this.stopped) return true;
			this.onStatus(
				failure === undefined ? "warning" : "error",
				failure === undefined
					? `ticket ${ticket.ticketIdentity} abandoned: its handoff limit is ${config.maxHandoffsPerTicket}`
					: `ticket ${ticket.ticketIdentity} abandoned; the close cleanup failed: ${failure}`,
			);
			return true;
		}
		// The restart is the top-up's add: it gates itself on the queue, the
		// pause, the episode, and the agent facts this walk already reads.
		return false;
	}

	/**
	 * Resolve an awaiting ticket by the automatic rule (ADR 0051). Returns
	 * whether the cycle changed factory state.
	 *
	 * Auto mode only: in manual mode a settled turn that offers a continuation
	 * rests in awaiting, and the operator's Decision screen routes it. The
	 * machine closes the completions it resolves - a turn whose task type
	 * offers no continuation, a transition into a parking state, a route
	 * degraded at the handoff limit - and parks the rest: a held turn, a
	 * transition whose label write failed, and a same-type hold. A routable
	 * completion decides nothing here: its route is the top-up's
	 * continuation, and the top-up's one item at a time is the wait the
	 * queue holds.
	 */
	private async handleAwaiting(ticket: HandoffTicket, autoOn: boolean): Promise<boolean> {
		if (!autoOn) return false;
		const completion = this.state.lastCompletion(ticket.ticketIdentity);
		const outcome = completion?.transition ?? null;
		// A decided turn decides nothing more: the route recorded its decision
		// when it started, the automatic rule cannot route the same turn twice,
		// and the routed turn rests in awaiting for the operator's close.
		if (completion !== null && completion.decision !== null) return false;
		// The held-turn gate (ADR 0016): a turn that failed, aborted, or was
		// truncated is held. No automatic decision runs on it; the operator's
		// explicit close or route still works. The ticket rests in awaiting
		// until then.
		if (isHeldCompletion(completion)) return false;
		const decision = this.decideAwaiting(this.state.handoffCount(ticket.ticketIdentity), outcome);
		// The one route rule, read at both walks (ADR 0051): this walk closes
		// what the machine resolves, and `continuationPosition` asks the same
		// answer for what it enqueues. A `route` rests for the top-up and a
		// `park` rests for the operator; neither closes here, and neither
		// re-derives the condition.
		if (decision !== "close") return false;
		const decidedAt = new Date(this.now()).toISOString();
		const applied = this.state.applyCompletionDecision({
			ticketIdentity: ticket.ticketIdentity,
			handoffId: ticket.handoffAttemptId,
			decision: "auto-closed",
			decidedAt,
		});
		if (!applied) return false;
		this.onCycleEnd?.(ticket.ticketIdentity);
		const failure = await this.cleanup(ticket, "closed");
		if (this.stopped) return true;
		this.onStatus(
			failure === undefined ? "info" : "error",
			failure === undefined
				? `ticket ${ticket.ticketIdentity} auto-closed`
				: `ticket ${ticket.ticketIdentity} auto-closed; the close cleanup failed: ${failure}`,
		);
		return true;
	}

	/**
	 * The automatic completion rule (ADR 0051). Auto mode only: the caller
	 * gates it, and a manual completion that is neither auto-advance nor
	 * auto-handoff rests in awaiting for the operator's decision.
	 *
	 * The machine acts only where it is sure: a turn whose task type offers no
	 * continuation closes its cycle, and a transition that advanced into a
	 * parking state closes it, leaving the ticket in the state where a human
	 * or an external tool drives. A route at the handoff limit degrades to
	 * close, as it did. A transition whose label write failed no longer
	 * closes: the plane does not route from labels it did not write, and the
	 * ticket rests in awaiting for the operator's Decision screen.
	 */
	decideAwaiting(handoffCount: number, outcome: TransitionOutcome | null): AwaitingDecision {
		if (outcome === null || outcome.fired !== true) return "close";
		// A label write the plane did not make holds the turn for the operator,
		// whether or not the transition would have advanced.
		if (outcome.writeFailure !== "") return "park";
		const autoAdvance = outcome.autoAdvance === true;
		if (autoAdvance && outcome.positionTaskType !== null) {
			if (handoffCount >= this.config().maxHandoffsPerTicket) return "close";
			return "route";
		}
		// No advance, or an advance into a parking state: the machine offers no
		// task, so the cycle ends.
		return "close";
	}

	/**
	 * The `{previous-message}` slot of the restart and route prompts.
	 *
	 * When a held turn leaves no agent text, the slot carries the cause and
	 * its detail instead, so the agent that takes over reads the wall it hit
	 * rather than an empty message (ADR 0015). A completed or unknown turn
	 * with no text leaves the slot empty, exactly as before.
	 */
	private promptPreviousMessage(completion: Completion | null): string {
		if (completion === null) return "";
		if (completion.message !== "") return completion.message;
		if (isHeldCause(completion.cause)) {
			return completion.detail === ""
				? `previous turn ended ${completion.cause}`
				: `previous turn ended ${completion.cause}: ${completion.detail}`;
		}
		return "";
	}

	/**
	 * The auto top-up (ADR 0051). While Auto-handoff mode is on, the queue
	 * pause is down, the Dispatch pause is clear, and the queue is empty, the
	 * cycle adds exactly one item - a continuation first, then a restart, then
	 * a new open ticket, else nothing. Every add takes the same path every
	 * other start takes: an enqueue, then the immediate pickup. A queue that
	 * holds even one item holds the adds until it drains, so the queue never
	 * piles. A seat the item cannot take yet is the wait the queue item
	 * holds: the item rests in the queue until a seat frees, and the top-up
	 * reconsiders every cycle the queue is empty.
	 */
	private async topUpQueue(agents: readonly HerdrAgent[]): Promise<boolean> {
		if (!this.mode()) return false;
		// The queue pause (ADR 0052): the brake holds the automatic adds; the
		// queue and the pickup stand still behind it.
		if (this.state.queuePaused()) return false;
		// The Dispatch pause (ADR 0016): a held failed turn stops new
		// automatic work from starting until it is decided or a turn
		// completes. It is checked once per cycle, so a held turn does not
		// spam the status line.
		if (this.state.dispatchPauseActive()) return false;
		// One item per cycle, and only into an empty queue: the queue's depth
		// is the top-up's pace.
		if (this.state.workQueue().length > 0) return false;
		const config = this.config();
		// 1. Continuation: the awaiting tickets whose latest settled turn
		// fired a transition that auto-advances into a position the machine
		// still offers a task for, in the ticket list's order.
		const tickets = this.state.visibleTickets(config.workflowStates, config.defaultTaskType);
		for (const ticket of tickets) {
			if (ticket.state !== "awaiting") continue;
			const position = this.continuationPosition(ticket);
			if (position === null) continue;
			const completion = this.state.lastCompletion(ticket.identity);
			const outcome = completion?.transition ?? null;
			const added = await this.topUpAsk(
				{
					origin: "workflow",
					automatic: true,
					ticketIdentity: position.identity,
					// The route continues this ticket's settled turn: its leftover
					// environment is the handoff's own, so a name that leftover
					// agent still holds falls to the cycle name instead of failing
					// as a stranger (ADR 0027).
					routeFromIdentity: ticket.identity,
					choice: resolveHandoffChoice(
						config,
						position.suggestedTaskType ?? config.defaultTaskType,
						{
							...(outcome === null || outcome.agent === undefined ? {} : { agent: outcome.agent }),
							...(outcome === null || outcome.environment === undefined
								? {}
								: { environment: outcome.environment }),
						},
					),
					previousMessage: this.promptPreviousMessage(completion),
				},
				`work queue top-up: routing ${this.ticketName(ticket.identity)} to ${position.suggestedTaskType}`,
				`work queue top-up could not route ${this.ticketName(ticket.identity)}`,
			);
			// One add per cycle: the walk stops at the first item the queue took,
			// and a refused ask moves on to the next candidate.
			if (added !== "refused") return true;
		}
		// 2. The re-fired skip's route (ADR 0042) is a continuation: the skip
		// closed its cycle and the ticket rests open behind it, so the awaiting
		// walk never covered it. It enqueues like the rest, and its guards
		// stand: the position still offers the task, and it holds no handoff,
		// no queue item, and no unfinished attempt.
		for (const ticket of tickets) {
			if (ticket.state !== "open") continue;
			const completion = this.state.lastCompletion(ticket.identity);
			const outcome = completion?.transition ?? null;
			if (
				outcome === null ||
				// The marker carries the shape: `refired` is set only on an
				// outcome that fired and derived a position, so a re-fired trace
				// with no position or no fire is not a state the plane writes.
				// These three tests hold the record against a damaged trace, and
				// no walk reaches them on its own; the marker, the fire, the
				// advance, and the write are the four this suite measures.
				outcome.refired !== true ||
				outcome.fired !== true ||
				outcome.autoAdvance !== true ||
				outcome.writeFailure !== "" ||
				outcome.positionTaskType === null ||
				outcome.positionTicketIdentity === null
			)
				continue;
			// The projection before the list rule (ADR 0042): the rule withholds
			// a covered ticket's row from the operator's list, and the add must
			// still reach the position it starts on.
			const position = this.state
				.projectedTickets(config.workflowStates, config.defaultTaskType)
				.find((candidate) => candidate.identity === outcome.positionTicketIdentity);
			if (position === undefined) continue;
			if (position.suggestedTaskType !== outcome.positionTaskType) continue;
			// One test of the position's standing. The projection builds
			// `actionable` from the open state, so it holds every position that
			// left the list - in flight, awaiting, or gone - as well as one the
			// source cannot read, and an open ticket with an unresolved attempt is
			// not actionable either. The queue's one-item-per-ticket rule is this
			// cycle's own gate above: the walk adds only into an empty queue
			// (ADR 0051).
			if (!position.actionable) continue;
			// The Same-type hold over the refresh lag: a position whose newest
			// closed cycle completed the task it still suggests by stale labels
			// has already run this route's task, and the add waits for the moved
			// labels to land instead of starting it twice.
			if (this.state.sameTypeHoldActive(position.identity, position.suggestedTaskType)) continue;
			if (position.handoffCount >= config.maxHandoffsPerTicket) continue;
			const added = await this.topUpAsk(
				{
					origin: "workflow",
					automatic: true,
					ticketIdentity: position.identity,
					routeFromIdentity: ticket.identity,
					choice: resolveHandoffChoice(config, outcome.positionTaskType, {
						...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
						...(outcome.environment === undefined ? {} : { environment: outcome.environment }),
					}),
					previousMessage: this.promptPreviousMessage(completion),
				},
				`work queue top-up: routing ${this.ticketName(ticket.identity)} to ${outcome.positionTaskType}`,
				`work queue top-up could not route ${this.ticketName(ticket.identity)}`,
			);
			if (added !== "refused") return true;
		}
		// 3. Restart: the in-flight ticket whose agent is missing past the
		// grace and whose handoffs stand below the limit - the abandon at the
		// limit landed in the in-flight walk already, above. One restart per
		// episode: the mark stands while the asked-for start holds its place in
		// the queue or runs, and a refused ask clears it again, so the next
		// empty-queue cycle reconsiders the restart the way ADR 0051 states.
		const byPane = new Map<string, HerdrAgent>();
		for (const agent of agents) byPane.set(agent.paneId, agent);
		for (const ticket of this.state.ticketsByState(["handed-off", "running"])) {
			if (this.now() - Date.parse(ticket.startedAt) < this.startupGraceMs) continue;
			if (ticket.paneId === null) continue;
			const agent = byPane.get(ticket.paneId);
			const foreign =
				agent !== undefined &&
				identifyHandoffAgentName(
					agent.name,
					this.state.agentNameForTicket(ticket.ticketIdentity),
				) === "foreign";
			if (agent !== undefined && !foreign) continue;
			if (this.state.handoffCount(ticket.ticketIdentity) >= config.maxHandoffsPerTicket) continue;
			if (this.state.hasWorkItem(ticket.ticketIdentity)) continue;
			if (this.restarted.has(ticket.ticketIdentity)) continue;
			this.restarted.add(ticket.ticketIdentity);
			const previous = this.state.lastCompletion(ticket.ticketIdentity);
			const added = await this.topUpAsk(
				{
					origin: "restart",
					automatic: true,
					ticketIdentity: ticket.ticketIdentity,
					// The episode mark stands only for a restart that holds its place
					// or runs. Every exit that ends the item without a start - the
					// pickup's drop, the operator's remove, a race cancel - clears the
					// mark through this answer, so the next empty-queue cycle asks
					// again. That is ADR 0051's re-entry rule read at the drop, and a
					// gate that still holds the ticket parks it again there: the
					// re-verify gate and the handoff limit stand in the claim, and the
					// dispatch's warning names them (ADR 0049).
					onStarted: (started) => {
						if (!started.ok) this.restarted.delete(ticket.ticketIdentity);
					},
					// The same choices the previous handoff ran with: the
					// operator's restart keeps the model, thinking level, and
					// context window, and the auto one matches it.
					choice: baseChoice(
						ticket.agentType,
						ticket.environment,
						ticket.taskType,
						ticket.model,
						ticket.thinking,
						ticket.contextWindow,
					),
					previousMessage: this.promptPreviousMessage(previous),
				},
				`work queue top-up: restarting ${this.ticketName(ticket.ticketIdentity)}`,
				`work queue top-up could not restart ${this.ticketName(ticket.ticketIdentity)}`,
			);
			if (added === "refused") {
				// The ask never took a queue row, so the episode mark leaves with it:
				// the ticket stays in-flight, and the next cycle asks again. A row
				// that did enter answers through its `onStarted` above.
				this.restarted.delete(ticket.ticketIdentity);
				continue;
			}
			return true;
		}
		// 4. A new open ticket: the first open ticket in the list's order that
		// every wait the auto-dispatch checked still passes - actionable, under
		// the handoff limit, re-verified since its last cycle ended, offering a
		// task, and past the Same-type hold. A full parallel seat is no longer
		// a hold here: the item rests in the queue until a seat frees.
		for (const ticket of tickets) {
			if (ticket.state !== "open" || !ticket.actionable) continue;
			if (ticket.handoffCount >= config.maxHandoffsPerTicket) continue;
			// The ticket's last cycle may have ended on a source change the agent
			// made (a merged pull request, a closed issue). Its membership still
			// reads active and healthy on the stale fetch, so the add waits for
			// the sources to re-read the ticket: a merged item leaves the list
			// and the ticket does not dispatch, an open one re-verifies and
			// dispatches. The gate holds the ticket, not a parallel slot.
			if (!this.state.sourceReverifiedSinceCycleEnd(ticket.identity)) continue;
			// The Same-type hold (ADR 0026): the ticket's newest closed cycle
			// completed a turn of the type the ticket now suggests. That work
			// finished; the item still lists it because no new signal landed.
			// A parking state offers no task: the plane does nothing on the
			// ticket, and an external label write is the only engine that moves
			// it (ADR 0027).
			if (ticket.suggestedTaskType === null) continue;
			if (this.state.sameTypeHoldActive(ticket.identity, ticket.suggestedTaskType)) continue;
			if (this.state.hasWorkItem(ticket.identity)) continue;
			// The configured settings of the ticket's task profile (ADR 0009): an
			// unattended handoff starts with the same resolution chain a manual
			// one sees in the panel, and the fit check guards what it starts with.
			const choice = resolveHandoffChoice(config, ticket.suggestedTaskType);
			const added = await this.topUpAsk(
				{
					origin: "open",
					automatic: true,
					ticketIdentity: ticket.identity,
					choice,
					previousMessage: "",
				},
				`work queue top-up: handing off ${this.ticketName(ticket.identity)}`,
				`work queue top-up could not hand off ${this.ticketName(ticket.identity)}`,
			);
			if (added !== "refused") return true;
		}
		return false;
	}

	/**
	 * The ticket the Message line names: the projection's title, the same words
	 * the Work queue's row shows. Every queue line in the plane reads the live
	 * projection this way (ADR 0049), and the projection, not the visible list,
	 * so a covered ticket is still named by its title.
	 */
	private ticketName(identity: string): string {
		const config = this.config();
		const title = this.state
			.projectedTickets(config.workflowStates, config.defaultTaskType)
			.find((candidate) => candidate.identity === identity)?.title;
		return title === undefined ? `ticket ${identity}` : `"${title}"`;
	}

	/**
	 * The top-up's one ask-and-report step (ADR 0051), shared by all four
	 * walks: the enqueue through the dispatch seam, the refusal warning on a
	 * rejected ask, and the add line on the Message when the item took its
	 * place. The answer says what the cycle does next: "added" ends it with
	 * its one item, "refused" lets the walk move to the next candidate, and
	 * "stopped" ends the run.
	 */
	private async topUpAsk(
		intent: HandoffIntent,
		addedLine: string,
		refusedPrefix: string,
	): Promise<"added" | "refused" | "stopped"> {
		const result = await this.dispatch(intent);
		if (this.stopped) return "stopped";
		if (!result.ok) {
			this.onStatus("warning", `${refusedPrefix}: ${result.reason}`);
			return "refused";
		}
		this.onStatus("info", addedLine);
		return "added";
	}

	/**
	 * The position a settled awaiting ticket's latest turn routes to, or null
	 * when no continuation stands: the automatic rule answers `route` for the
	 * turn (ADR 0051), the position the outcome names still offers the task it
	 * names - open or awaiting, actionable, wearing the labels, holding no
	 * handoff, no queue item, and no unfinished attempt, under its handoff
	 * limit, and past the Same-type hold.
	 *
	 * The route itself is never re-derived here. `decideAwaiting` is the one
	 * rule both walks read: the awaiting walk that closes what the machine
	 * resolves, and this walk that enqueues what it does not.
	 */
	private continuationPosition(ticket: Ticket): Ticket | null {
		const config = this.config();
		const completion = this.state.lastCompletion(ticket.identity);
		if (completion === null || completion.decision !== null) return null;
		if (isHeldCompletion(completion)) return null;
		const outcome = completion.transition ?? null;
		if (this.decideAwaiting(this.state.handoffCount(ticket.identity), outcome) !== "route")
			return null;
		// The rule says a position exists; only this walk needs its identity to
		// read the row, so the check stays here.
		if (outcome === null || outcome.positionTicketIdentity === null) return null;
		const position = this.state
			.projectedTickets(config.workflowStates, config.defaultTaskType)
			.find((candidate) => candidate.identity === outcome.positionTicketIdentity);
		if (position === undefined) return null;
		if (position.state !== "open" && position.state !== "awaiting") return null;
		if (position.suggestedTaskType !== outcome.positionTaskType) return null;
		// The actionable fact is the open position's: an awaiting position is
		// the ticket whose turn just settled, and the claim check owns its
		// standing, so the top-up does not demand the open ticket's health of
		// it.
		// The position's standing, in one test. An unfinished attempt is folded
		// into the open position's `actionable` by the projection, and an
		// awaiting position is the settled ticket's own row, whose attempt the
		// settle resolved - so the recovery fact never stands apart from this
		// one. The queue's one-item-per-ticket rule is this cycle's own gate
		// above: the walk adds only into an empty queue, and the claim check at
		// the ask refuses the same ledger a second time (ADR 0051).
		if (position.state === "open" && !position.actionable) return null;
		if (this.state.sameTypeHoldActive(position.identity, position.suggestedTaskType)) return null;
		if (position.handoffCount >= config.maxHandoffsPerTicket) return null;
		return position;
	}
}
