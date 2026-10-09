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
 *    awaiting tickets (ADR 0051, ADR 0092): the machine decides each settled
 *    turn from one fact, the Next step its Transition derived. A turn with no
 *    Next step closes its cycle, and a turn with one rests in awaiting for the
 *    top-up: a held turn, a transition whose label write failed, and a turn of
 *    an Operator-decides type park the ticket for the operator (ADR 0085), and
 *    a routable turn's step is the top-up's continuation item.
 * 5. The Work queue's pickup (ADR 0049): the items the free seats take, in
 *    queue order, run before the top-up. Every pickup ends in start or
 *    drop, so the queue never sits stuck.
 * 6. The auto top-up (ADR 0051, ADR 0060, ADR 0088): while Auto-handoff
 *    mode is on, the queue pause is down, the Dispatch pause is clear, and
 *    the queue is empty, the cycle adds exactly one item - a continuation
 *    first, then a restart, then an open pull request ticket, then a fresh
 *    open ticket, else nothing. A queue that holds even
 *    one item holds the automatic adds until it drains, so the queue never
 *    piles. A flagged ticket (ADR 0060, widened by ADR 0070) is out of every
 *    one of those walks, its own flag or its source's mute, and it stays out
 *    while its row shows again for live work or a decision owed: the flag
 *    holds the machine out, and only the operator's own key clears it. Each
 *    hold these gates take - the mode, the queue pause, the Dispatch pause, a
 *    continuation already standing, a row the operator staged, a row already in
 *    the queue - states itself in the plane's record, once for as long as the
 *    fact stands, so the run never shows only the start that never came
 *    (issue #223).
 * 7. The wake (ADR 0084): an in-flight agent the probe shows working arms
 *    a blocking `herdr agent wait` on the agent's name, and the wait's
 *    state match runs a cycle now instead of at the next poll, so a
 *    finished turn settles without waiting out the interval. A failed
 *    wait wakes nothing: the poll stands as it always did.
 *
 * When herdr cannot be listed at all, the loop pauses and holds: the last
 * known facts stay, and the UI warns. Nothing is re-run blindly on
 * recovery: a cycle that cannot see its agents does not settle, reclaim, or
 * restart anything.
 */

import type { FactoryConfig, TransitionOutcome } from "./config.ts";
// The normalized states and the words for them are the domain's, beside the
// Missing agent rule the observation cycle reads (issue #201). The observation
// module re-states them for its existing readers.
import { agentInPane, normalizeAgentStatus } from "./domain/agent.ts";
import {
	type FailedStartParkFacts,
	failedStartParkLine,
	failedStartParkStands,
} from "./domain/failed-start-park.ts";
import {
	type NameCollisionFacts,
	nameCollisionLine,
	nameCollisionStands,
} from "./domain/name-collision.ts";
import { recordTicketName } from "./domain/record-name.ts";
import {
	type AgentNameCollision,
	automaticStartBlocked,
	type Completion,
	handoffLimitReached,
	isHeldCompletion,
	operatorDecidesType,
	type Ticket,
} from "./domain/ticket.ts";
import {
	type AutomaticCandidateHold,
	type AutomaticHold,
	type AutomaticNextStepHold,
	automaticAddsHold,
	automaticHoldKey,
	automaticHoldLine,
	continuationHold,
	freshWorkHold,
	openTicketRowGate,
	openTicketWaitsHold,
	restartCandidateGate,
	type TopUpCycleFacts,
} from "./domain/top-up.ts";
import { baseChoice, resolveHandoffChoice } from "./handoff.ts";
import {
	type DispatchResult,
	type HandoffIntent,
	type PlaneActionIntent,
	STOPPED_DISPATCH_REASON,
	type StandingWorkFact,
} from "./handoff-dispatch.ts";
import type { HerdrAgent } from "./herdr.ts";
import { type Logger, NOOP_LOGGER } from "./logging.ts";
import { identifyHandoffAgentName } from "./naming.ts";
import { isPlaneActionTaskType } from "./plane-action-registry.ts";
import { type RefreshClock, SYSTEM_CLOCK } from "./refresh.ts";
import { type CommandRunner, commandFailureText } from "./runner.ts";
import type { Consultation, ConsultationRecordAggregate } from "./state/consultation-record.ts";
import type { HandoffAggregate, HandoffTicket } from "./state/handoff.ts";
import type { PlaneActionAggregate } from "./state/plane-action.ts";
import type {
	TicketListViews,
	TicketProjection,
	TicketWorkCycleAggregate,
} from "./state/ticket-work-cycle.ts";
import type { WorkQueueAggregate } from "./state/work-queue.ts";
import { workQueueIdentityOf } from "./state/work-queue.ts";
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
import {
	deriveNextStep,
	NEXT_STEP_GATE_LINES,
	type NextStep,
	type RefiredSkip,
} from "./workflow.ts";

/**
 * The startup grace a handoff's agent gets before an idle or done report
 * settles its turn.
 */
export const STARTUP_GRACE_MS = 30_000;

/**
 * The command budget of one agent wake wait (ADR 0084).
 *
 * `herdr agent wait` exits on a state match or on its own error, so the
 * budget only bounds a wait that runs on after its ticket leaves in-flight
 * or the plane stops: a bounded orphan. A budget that runs out mid-turn is
 * an unmatched wait: the next successful cycle re-arms the still-working
 * agent, so a long turn loses no wake.
 */
export const AGENT_WAIT_BUDGET_MS = 15 * 60 * 1000;

/** The result of asking herdr for its agents. */
export type HerdrProbe = { kind: "ok"; agents: HerdrAgent[] } | { kind: "error"; reason: string };

/** The answer of one agent wake wait (ADR 0084). */
export type AgentWaitResult = { matched: boolean };

/** The read-side of herdr the loop uses. Tests inject a fake here. */
export interface AgentReader {
	listAgents(): Promise<HerdrProbe>;
	/** The pane's recent output in text format, unwrapped, capped and ANSI stripped. Null when it cannot be read. */
	readPane(paneId: string, lines: number): Promise<string | null>;
	/**
	 * Wait until the agent named `target` reaches a settle state, or the
	 * budget runs out. `matched` is true only when the wait answered with a
	 * state match: a missing agent, a herdr failure, and a budget timeout
	 * are all unmatched. Optional: a reader without it leaves the loop
	 * poll-only, the ADR 0006 standing (ADR 0084).
	 */
	waitAgent?(target: string, budgetMs: number): Promise<AgentWaitResult>;
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

/**
 * The one item of the herdr agent list, or null when the item names no pane
 * and no agent the plane can hold.
 */
function herdrAgentOf(item: unknown): HerdrAgent | null {
	const record = item as Record<string, unknown>;
	if (typeof record.pane_id !== "string" || record.pane_id === "") return null;
	if (typeof record.agent !== "string" || record.agent === "") return null;
	const session = isRecord(record.agent_session) ? record.agent_session : undefined;
	const sequence = firstNumberField(record, [
		"sequence",
		"seq",
		"state_change_sequence",
		"state_change_seq",
	]);
	const checkoutPath = firstStringField(record, ["checkout_path", "cwd", "working_directory"]);
	const stableSessionId = firstStringField(record, ["session_id", "agent_session_id"]);
	const name = typeof record.name === "string" && record.name !== "" ? record.name : undefined;
	return {
		paneId: record.pane_id,
		tabId: typeof record.tab_id === "string" ? record.tab_id : "",
		workspaceId: typeof record.workspace_id === "string" ? record.workspace_id : "",
		...(sequence === undefined ? {} : { sequence }),
		agent: record.agent,
		...(checkoutPath === undefined ? {} : { checkoutPath }),
		...(stableSessionId === undefined ? {} : { stableSessionId }),
		...(name === undefined ? {} : { name }),
		status: typeof record.agent_status === "string" ? record.agent_status : "unknown",
		sessionId: sessionPathValue(session),
	};
}

/** The first numeric field a record holds under one of the keys, in key order. */
function firstNumberField(
	record: Record<string, unknown>,
	keys: readonly string[],
): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number") return value;
	}
	return undefined;
}

/** The first string field a record holds under one of the keys, in key order. */
function firstStringField(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** The session path a path-shaped agent session record carries, or no session. */
function sessionPathValue(session: Record<string, unknown> | undefined): string {
	return session !== undefined && session.kind === "path" && typeof session.value === "string"
		? session.value
		: "";
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
			const agent = herdrAgentOf(item);
			if (agent !== null) agents.push(agent);
		}
		return { kind: "ok", agents };
	}

	async readPane(paneId: string, lines: number): Promise<string | null> {
		return this.readPaneFormat(paneId, lines, "recent-unwrapped", "text");
	}

	/**
	 * The wake wait (ADR 0084): block until the agent named `target` reaches
	 * one of the settle states. The until set is pinned, not left to herdr's
	 * default, so a herdr version that changes its default cannot change the
	 * plane's wake standing.
	 */
	async waitAgent(target: string, budgetMs: number): Promise<AgentWaitResult> {
		const result = await this.runner.run(
			"herdr",
			["agent", "wait", target, "--until", "idle", "--until", "done", "--until", "blocked"],
			{ timeoutMs: budgetMs },
		);
		return { matched: result.code === 0 };
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
 * The decision an awaiting ticket resolves to on a cycle (ADR 0051, ADR 0092).
 *
 * - `close`: the machine resolves the completion and closes the cycle: a turn
 *   with no Next step - no transition, a fire that did not run, a fire that
 *   landed on a parking state - or a Next step the Handoff limit holds.
 * - `route`: the settled turn has a Next step no gate holds: the top-up's
 *   continuation, enqueued while the queue is empty.
 * - `hold`: the turn has a Next step, and a gate holds it - the position offers
 *   no task, the position is not actionable, or the Same-type hold stands. The
 *   machine will not take the step, so the ticket rests in awaiting, the
 *   Message line states the held step and its gate once per settled turn, and
 *   the Decision screen states the gate beside the row the operator can confirm.
 * - `park`: the ticket rests in awaiting for the operator: a transition whose
 *   label write failed, a held turn, or a turn of an Operator-decides type.
 *
 * `hold` and `park` move the ticket the same way, and the words name which fact
 * stopped the machine: a gate held the step, or an operator's brake parked the
 * turn. Each has its own reader and its own surface: the automatic rule branches
 * on `hold` to state the held step, and a parked turn is already loud on the
 * surface that produced it - the held turn's cause, the failed write's settle
 * line, and the Operator-decides row the operator decides by hand.
 */
export type AwaitingDecision = "close" | "route" | "hold" | "park";

/**
 * The automatic rule's answer for one settled turn (ADR 0092): what the
 * machine does with it, and the Next step the turn's Transition derived.
 * The step is null when the machine has none to take, and a step a gate holds
 * carries its gate so the reader can state the reason.
 */
export interface AwaitingRule {
	decision: AwaitingDecision;
	step: NextStep | null;
}

/**
 * A structured topic for an onStatus event. The UI reacts to the topic, never
 * to the human-facing text: the text may be reworded without breaking the
 * behavior that listens for it.
 */
export type ObservationStatusTopic = "herdr-recovered";

/**
 * The aggregates the observation cycle reads, as a list (issue #202).
 */
export interface ObservationAggregates {
	consultationRecord: ConsultationRecordAggregate;
	handoff: HandoffAggregate;
	planeAction: PlaneActionAggregate;
	ticketWorkCycle: TicketWorkCycleAggregate;
	workQueue: WorkQueueAggregate;
}

interface ObservationOptions {
	state: ObservationAggregates;
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
	 * The app's plane action path (ADR 0068): the merge of the ticket's pull
	 * request, entered in the Work queue like every other start. The top-up's
	 * walks cross it for the positions their task type resolves on the plane
	 * action instead of an agent.
	 */
	dispatchPlaneAction: (intent: PlaneActionIntent) => Promise<DispatchResult>;
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
	/**
	 * The plane's file logger, the same seam the Handoff dispatch takes.
	 *
	 * The Message line is gone by the time anyone reads the file, so the facts
	 * the cycle acts on that reach no start line leave their record here: each
	 * hold the automatic walks take, stated once while the fact stands
	 * (issue #223). Defaults to NOOP_LOGGER: a cycle with no file to write.
	 */
	log?: Logger;
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
	 * re-fires, and the Next step of a closed cycle's skip never runs.
	 */
	refireRecordedSkips?: () => Promise<RefiredSkip[]>;
}

/** The restart walk's fields: the walk's read, its batched start counts, and its gates. */
type RestartWalkFields = {
	config: FactoryConfig;
	agents: readonly HerdrAgent[];
	blocked: ReadonlySet<string>;
	queuedTickets: ReadonlySet<string>;
	restartTickets: readonly HandoffTicket[];
	restartStartCounts: ReadonlyMap<string, number>;
};

export class ObservationCoordinator {
	private readonly state: ObservationAggregates;
	private readonly herdr: AgentReader;
	private readonly config: () => FactoryConfig;
	private readonly dispatch: (intent: HandoffIntent) => Promise<DispatchResult>;
	private readonly dispatchPlaneAction: (intent: PlaneActionIntent) => Promise<DispatchResult>;
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
	private readonly log: Logger;
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
	 * The held Next step each awaiting ticket last had stated on the Message line,
	 * keyed on the ticket identity (ADR 0092). The hold is derived every cycle and
	 * never stored; this only remembers the last report, the way the Dispatch
	 * pause line does, so one held turn states itself once and not once per poll.
	 * The entry leaves when the ticket leaves awaiting.
	 *
	 * The stored value is `automaticHoldKey` of the hold, the same fact the
	 * record outlet keys on (issue #232): each outlet states the fact once while
	 * it stands and again when it changes, and the key that names the fact lives
	 * in the module that owns the gates for both outlets alike.
	 */
	private readonly holdReports = new Map<string, string>();
	/**
	 * The automatic-walk holds this cycle noted, and the holds the last cycle stated
	 * (issue #223). The holds are derived every cycle and never stored; these two
	 * only tell a standing fact from a new one, the way the Dispatch pause line and
	 * the held Next step line remember their last report, so a hold states itself
	 * once while it stands and not once per poll. The key is the fact and the row it
	 * names (`automaticHoldKey`), so a hold behind a different row is a new fact.
	 */
	private automaticHolds = new Map<string, AutomaticHold>();
	/**
	 * The holds the last cycle stated (issue #223). A cycle that ran no fresh-work
	 * walk keeps that walk's facts standing here: the skip is the cycle's own
	 * choice, not the fact leaving, so a row that stood the whole time is not
	 * stated twice. The entry is the hold, not only its key, so the carry-over can
	 * ask which walk owns the fact.
	 */
	private automaticHoldsReported = new Map<string, AutomaticHold>();
	/**
	 * The Tickets the Failed-start park stood on when this run last stated it
	 * (issue #298, ADR 0106). The park is derived on the ask and never stored; this
	 * only remembers the last report, the way the held Next step's line does, so one
	 * parked Ticket states its hold and its warning once while it stands and not once
	 * per poll. A cycle retires the entry when it reads the Ticket and finds the park
	 * gone - a start that reached its Agent, or the operator's own act - so the next
	 * run of failures states itself again.
	 *
	 * The key is `automaticHoldKey` of the hold the walk took - the key the walk-hold
	 * memory already uses - so the park is one standing fact in one memory. A key of
	 * the identity alone would hold a second candidate-hold reason on the same Ticket
	 * silent behind this one.
	 */
	private readonly parkReports = new Map<string, AutomaticCandidateHold>();
	/**
	 * The candidates the fresh-work walk read this cycle (issue #231). The cycle
	 * resets it before the walk, and the report reads it: a per-candidate fact
	 * the walk did not re-read keeps standing the way a skipped walk's row does -
	 * the skip is the cycle's own choice, not the fact leaving - and a candidate
	 * the walk read retires its last-stated facts and stands whatever the gate
	 * answers now.
	 */
	private freshWorkCandidatesRead = new Set<string>();
	/**
	 * The Agent name collisions this run has stated (issue #299, ADR 0107), held
	 * the same way the parks are: one standing fact states its record line and its
	 * Message warning once, and a cycle that reads the Ticket and finds the fact
	 * gone retires the memory, so the next refusal states itself again. The key is
	 * `automaticHoldKey` of the hold, shared with the park's memory, so one fact
	 * has one key wherever it is stated.
	 */
	private readonly collisionReports = new Map<string, AutomaticCandidateHold>();
	/**
	 * The agents of the last successful list, for the UI's markers. Null
	 * until the first success: an unreadable herdr must not read as "every
	 * pane is missing".
	 */
	private lastAgentsList: readonly HerdrAgent[] | null = null;
	/** In-flight tickets the loop already restarted this episode. */
	private readonly restarted = new Set<string>();
	/**
	 * The armed wake waits, keyed on the agent's name (ADR 0084). A name in
	 * the set holds a `herdr agent wait`; the entry leaves when the wait
	 * answers, whatever it answered.
	 */
	private readonly agentWaits = new Map<string, Promise<void>>();

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
		this.dispatchPlaneAction = options.dispatchPlaneAction;
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
		this.log = options.log ?? NOOP_LOGGER;
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

	/**
	 * The Agent name of every Ticket in the list, in one batched read (issue #202,
	 * ADR 0095). Each walk below reads the name per Ticket, so the name comes from
	 * `agentNamesForTickets` and the read costs one statement per chunk of Tickets
	 * instead of two per Ticket.
	 */
	private agentNames(tickets: readonly HandoffTicket[]): Map<string, string> {
		return this.state.ticketWorkCycle.agentNamesForTickets(
			tickets.map((ticket) => ticket.ticketIdentity),
		);
	}

	/** The walk over the in-flight tickets: the missing path, the correction, the settle. */
	private async walkInFlight(
		byPane: Map<string, HerdrAgent>,
		inFlightNames: Map<string, string>,
		autoOn: boolean,
	): Promise<boolean> {
		let changed = false;
		const inFlight = this.state.ticketWorkCycle.ticketsByState(["handed-off", "running"]);
		for (const ticket of inFlight) {
			if (ticket.paneId === null) continue;
			// The one missing-Agent rule: the id of a closed pane is handed out
			// again, so a live agent in the ticket's pane that is not the ticket's
			// own leaves the ticket's agent missing, and the missing path runs
			// instead of the settle.
			const own = agentInPane(
				byPane,
				ticket.paneId,
				inFlightNames.get(ticket.ticketIdentity) ?? "",
			);
			if (own === null) {
				// The missing path is the auto mode's: manual mode leaves the
				// missing ticket for the operator's panel.
				if (autoOn) {
					changed = (await this.handleMissing(ticket)) || changed;
				}
			} else {
				changed = (await this.settlePhase(ticket, own)) || changed;
			}
			if (this.stopped) return changed;
		}
		return changed;
	}

	/**
	 * The settle phase of one in-flight ticket: the state correction on read,
	 * and the settle when the agent's report settles the turn.
	 *
	 * A state correction on read: herdr owns the fact of whether the agent is
	 * working, so the poll corrects the stored state to match it, and the list
	 * shows reality without the control plane ever writing to herdr.
	 */
	private async settlePhase(ticket: HandoffTicket, own: HerdrAgent): Promise<boolean> {
		const status = normalizeAgentStatus(own.status);
		if (status === "working") {
			return this.state.ticketWorkCycle.markTicketRunning(ticket.ticketIdentity);
		}
		if (status !== "done" && status !== "idle") return false;
		// One read serves the decision and the trace: the same session read
		// that settles the turn supplies its log, cause, and detail (ADR 0015).
		const turnEnd = await this.maybeReadTurnEnd(ticket, own);
		if (!this.maybeSettles(ticket, turnEnd)) return false;
		return await this.settle(ticket, own, turnEnd);
	}

	/** The walk over the awaiting tickets: a working Agent resumes the pending turn. */
	private async resumeAwaitingTurns(byPane: Map<string, HerdrAgent>): Promise<boolean> {
		let changed = false;
		const awaiting = this.state.ticketWorkCycle.ticketsByState(["awaiting"]);
		const awaitingNames = this.agentNames(awaiting);
		for (const ticket of awaiting) {
			if (ticket.paneId === null) continue;
			// The same identity rule as the in-flight loop: a working agent in
			// the ticket's reused pane id that is not the ticket's own does not
			// resume the ticket's pending turn.
			const own = agentInPane(
				byPane,
				ticket.paneId,
				awaitingNames.get(ticket.ticketIdentity) ?? "",
			);
			if (own === null || normalizeAgentStatus(own.status) !== "working") continue;
			if (this.state.ticketWorkCycle.reopenTurn(ticket.ticketIdentity, ticket.handoffAttemptId)) {
				changed = true;
			}
		}
		return changed;
	}

	/** The re-fire of the recorded skips (ADR 0042), with the failures it names. */
	private async refireSkips(): Promise<boolean> {
		if (this.refireRecordedSkips === undefined) return false;
		const refired = await this.refireRecordedSkips();
		if (this.stopped) return false;
		if (refired.length === 0) return false;
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
		return true;
	}

	/** The awaiting walk: the machine's closings, one projection read at a time. */
	private async walkAwaitingRows(autoOn: boolean): Promise<boolean> {
		let changed = false;
		const awaitingRows = this.state.ticketWorkCycle.ticketsByState(["awaiting"]);
		// A hold states itself once per settled turn (ADR 0092): the report map is
		// pruned to this cycle's awaiting rows, so a ticket the machine decided,
		// closed, or routed states a later hold again.
		for (const identity of [...this.holdReports.keys()]) {
			if (!awaitingRows.some((ticket) => ticket.ticketIdentity === identity))
				this.holdReports.delete(identity);
		}
		if (!autoOn || awaitingRows.length === 0) return false;
		const readProjection = (): TicketProjection =>
			this.state.ticketWorkCycle.ticketProjection(
				this.config().workflowStates,
				this.config().defaultTaskType,
			);
		let awaitingProjection = readProjection();
		for (const ticket of awaitingRows) {
			const moved = await this.handleAwaiting(ticket, awaitingProjection);
			changed = moved || changed;
			if (this.stopped) return changed;
			if (moved) awaitingProjection = readProjection();
		}
		return changed;
	}

	/**
	 * One observation cycle.
	 *
	 * A cycle notes the holds its walks take and states them when its walks
	 * are done; a cycle that never reached that point keeps no note, and the
	 * facts it acted on state themselves next cycle as new ones.
	 */
	private async cycle(): Promise<void> {
		this.automaticHolds = new Map();
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

		const inFlight = this.state.ticketWorkCycle.ticketsByState(["handed-off", "running"]);
		const inFlightNames = this.agentNames(inFlight);
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
		changed = await this.runCycleStep(changed, () =>
			this.walkInFlight(byPane, inFlightNames, autoOn),
		);

		// An awaiting ticket that reports working again resumes its still-pending
		// turn. It holds a slot and its next settle refreshes the same trace.
		changed = await this.runCycleStep(changed, () => this.resumeAwaitingTurns(byPane));

		// The re-fire of the recorded skips (ADR 0042): a refresh that found
		// the fixing pull request re-fires the transition the ticket's newest
		// completion trace recorded as the skip, and the trace takes the
		// re-fired outcome. The sweep runs after the settles, so a skip this
		// cycle settled re-fires in the same cycle the pull request already
		// lists, and before the top-up, so the re-fired skip's route is the
		// top-up's continuation candidate in this same cycle (ADR 0051).
		changed = await this.runCycleStep(changed, () => this.refireSkips());

		// The awaiting walk resolves the completions the machine closes (ADR
		// 0051): a routable completion rests in awaiting, and its route is the
		// top-up's continuation. One projection read serves the walk's Next step
		// derivations (ADR 0092): the walk reads the pile once, and re-reads it
		// only after a close moved a row another turn's derivation reads. Manual
		// mode runs no automatic rule, so it reads no pile for one.
		changed = await this.runCycleStep(changed, () => this.walkAwaitingRows(autoOn));

		await this.finishCycle(probe.agents, byPane, changed);
	}

	/**
	 * One step of the cycle: the step's change joins the cycle's, and a stop
	 * during the step ends the cycle before the next step touches state.
	 */
	private async runCycleStep(changed: boolean, step: () => Promise<boolean>): Promise<boolean> {
		const moved = await step();
		if (this.stopped) return changed;
		return moved || changed;
	}

	/**
	 * The tail of the cycle: the continuation, the pickup, the fresh work,
	 * the holds it reports, and the Dispatch pause it reads.
	 */
	private async finishCycle(
		agents: readonly HerdrAgent[],
		byPane: Map<string, HerdrAgent>,
		changed: boolean,
	): Promise<void> {
		// The continuation the machine owes runs before the Work queue's pickup
		// (ADR 0094): the item a settled turn earns is in the queue when the free
		// seats are handed out, so the seat that turn freed goes to that turn's own
		// next step. One item per cycle still holds (ADR 0051): the cycle that asked
		// a continuation asks no fresh work.
		const continued = await this.askContinuations();
		let walked = continued || changed;
		if (this.stopped) return;

		// The Work queue's pickup (ADR 0051): the items the free seats take, in
		// queue order. It runs in auto or manual mode alike, and the queue pause
		// holds it (ADR 0052).
		if (this.pickupWorkQueue !== undefined) {
			const picked = await this.pickupWorkQueue();
			if (this.stopped) return;
			if (picked > 0) walked = true;
		}

		// The fresh-work adds (ADR 0051): with Auto-handoff on, the queue empty,
		// the queue pause down, and the Dispatch pause clear, the cycle adds one
		// item - a restart, then a new open ticket, else nothing.
		const freshWorkWalkRan = !continued;
		// The per-candidate facts the fresh-work walk read reset with the walk
		// (issue #231): a walk that runs none reads no candidate.
		this.freshWorkCandidatesRead = new Set();
		if (freshWorkWalkRan) walked = (await this.topUpFreshWork(agents)) || walked;
		if (this.stopped) return;
		// The holds the walks took, stated once each for as long as they stand.
		this.reportAutomaticHolds(freshWorkWalkRan, this.mode());
		// The Failed-start parks that no longer stand, retired from the report so the
		// next run of failures states itself again (issue #298, ADR 0106).
		this.retireFailedStartParks();
		// The Agent name collisions the same way (issue #299, ADR 0107): the operator's
		// own Handoff that takes the name, or the ignore that answers the refusal,
		// retires the memory, so the next refusal states itself again.
		this.retireNameCollisions();

		// Tickets and Consultations share this one successful Herdr list poll.
		// A Consultation in `opening` or `working` already holds its seat in
		// the shared count above (ADR 0034).
		const consultationChanged = await this.observeConsultations(agents);
		walked = consultationChanged || walked;

		// The wake arm (ADR 0084): every working agent the probe shows on an
		// in-flight ticket or a working Consultation holds a `herdr agent
		// wait` on its name, and the wait's match runs a cycle now, so a
		// finished turn settles without waiting out the interval. The poll
		// keeps its standing: a wake only runs the same cycle on the same facts.
		this.armAgentWaits(byPane);
		this.reportDispatchPause();
		if (walked) this.onChanged();
		this.onAgents?.(agents);
	}

	/**
	 * The Dispatch pause is derived from the traces each cycle and never
	 * stored (ADR 0016). The Message line reports it when it trips and when
	 * it clears, so the operator hears about the factory stopping and
	 * resuming dispatch on the line it already watches, in any mode: the
	 * pause holds the transition routes in manual mode too. The mode cell
	 * wears it `paused` in auto mode, the state it names.
	 */
	private reportDispatchPause(): void {
		const effectivePause = this.state.ticketWorkCycle.dispatchPauseActive();
		if (effectivePause === this.pauseActive) return;
		this.pauseActive = effectivePause;
		this.onStatus(
			effectivePause ? "warning" : "info",
			effectivePause
				? "Dispatch pause: a held failed turn is blocking automatic dispatch"
				: "Dispatch pause cleared: automatic dispatch resumes",
		);
	}

	/**
	 * The wake arm of a successful cycle (ADR 0084): hold a `herdr agent
	 * wait` on the agent's name until the wait answers, for every in-flight
	 * ticket and every working Consultation whose own agent the probe shows
	 * working.
	 *
	 * The arm is on the working report, not on the in-flight state: a
	 * booted agent reports idle before it picks up the prompt, and a wait
	 * on such an agent answers at once, so an arm on the state would run a
	 * cycle at once, in a loop the poll interval never had. A working
	 * agent stays working until the turn ends, so the wait held from the
	 * working report blocks exactly until the settle.
	 *
	 * The wait targets the agent's name, the identity a live agent belongs
	 * to by (ADR 0043 for the Ticket, the recorded name for the
	 * Consultation): a pane id is not an identity, herdr hands closed ids
	 * out again. A missing agent is an unmatched wait: it wakes nothing,
	 * and the missing path keeps the poll's own pace.
	 */
	private armAgentWaits(byPane: Map<string, HerdrAgent>): void {
		if (this.herdr.waitAgent === undefined || this.stopped) return;
		const workingTickets = this.state.ticketWorkCycle.ticketsByState(["handed-off", "running"]);
		const workingNames = this.agentNames(workingTickets);
		for (const ticket of workingTickets) {
			if (ticket.paneId === null) continue;
			const name = workingNames.get(ticket.ticketIdentity) ?? "";
			if (name === "") continue;
			const own = agentInPane(byPane, ticket.paneId, name);
			if (own === null || normalizeAgentStatus(own.status) !== "working") continue;
			this.armAgentWait(name);
		}
		this.armConsultationWaits(byPane);
	}

	/** The wake arm over the working Consultations, the ticket arm's sibling. */
	private armConsultationWaits(byPane: Map<string, HerdrAgent>): void {
		for (const consultation of this.state.consultationRecord.consultationsByState(["working"])) {
			const name = consultation.agentName;
			if (name === "") continue;
			const match = matchConsultationAgent(consultation, [...byPane.values()]);
			if (match === undefined || match === "ambiguous") continue;
			if (normalizeAgentStatus(match.status) !== "working") continue;
			this.armAgentWait(name);
		}
	}

	/**
	 * One armed wake (ADR 0084): the wait answers, and only a state match
	 * runs the cycle. A missing agent, a herdr failure, and a budget timeout
	 * carry no news, and a wake on none of them would run a cycle that
	 * re-arms the same failed wait, in a loop.
	 */
	private armAgentWait(name: string): void {
		if (this.herdr.waitAgent === undefined || this.stopped || this.agentWaits.has(name)) return;
		const entry = (async () => {
			try {
				// The optional call keeps the reader as the receiver: the
				// reader is a class, and the method reads its runner through
				// the receiver.
				const result = await this.herdr.waitAgent?.(name, AGENT_WAIT_BUDGET_MS);
				if (result?.matched === true && !this.stopped) await this.safeCycle();
			} finally {
				this.agentWaits.delete(name);
			}
		})();
		this.agentWaits.set(name, entry);
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
		const held = this.heldPanesOf();
		let changed = false;
		const restingTickets = this.state.ticketWorkCycle.ticketsByState(["open"]);
		const restingNames = this.agentNames(restingTickets);
		for (const ticket of restingTickets) {
			if (this.stopped) return changed;
			if (ticket.paneId === null || held.has(ticket.paneId)) continue;
			const agent = byPane.get(ticket.paneId);
			if (agent === undefined) continue;
			const name = this.reclaimNameOf(ticket, agent, restingNames);
			if (name === null) continue;
			const claimed = this.state.handoff.reclaimHandoff(ticket.ticketIdentity, {
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

	/**
	 * The panes the reclaim walk leaves alone.
	 *
	 * A routed open ticket's recorded pane is held the way any non-open
	 * ticket's is (ADR 0072): the ticket still names the handoff that ran
	 * its settled turn, and the pane is not handed to a stranger while the
	 * route stands on its Work queue's item.
	 */
	private heldPanesOf(): Set<string> {
		const held = new Set<string>();
		for (const ticket of this.state.ticketWorkCycle.ticketsByState([
			"handed-off",
			"running",
			"awaiting",
		])) {
			if (ticket.paneId !== null) held.add(ticket.paneId);
		}
		const routedDecisions = ["handed-off", "auto-handed-off", "merged", "auto-merged"];
		for (const ticket of this.state.ticketWorkCycle.ticketsByState(["open"])) {
			if (ticket.paneId === null) continue;
			const decision =
				this.state.ticketWorkCycle.lastCompletion(ticket.ticketIdentity)?.decision ?? null;
			if (decision !== null && routedDecisions.includes(decision)) held.add(ticket.paneId);
		}
		return held;
	}

	/**
	 * The name the live agent holds when the resting ticket reclaims it.
	 *
	 * Only a working or blocked agent is reclaimed: an idle, done, or unknown
	 * report says nothing about live work. The pane id of a closed pane is
	 * handed out again: a Consultation or another ticket's agent can hold the
	 * id this ticket's last handoff recorded. Only the agent that runs under
	 * the ticket's own name is the ticket's own; anything else is not
	 * reclaimed.
	 */
	private reclaimNameOf(
		ticket: HandoffTicket,
		agent: HerdrAgent,
		restingNames: Map<string, string>,
	): string | null {
		const status = normalizeAgentStatus(agent.status);
		if (status !== "working" && status !== "blocked") return null;
		const name = agent.name;
		if (name === undefined) return null;
		const own = identifyHandoffAgentName(name, restingNames.get(ticket.ticketIdentity) ?? "");
		return own === "own" ? name : null;
	}

	/** Reconcile durable Consultations from the same Agent list as Tickets. */
	private async observeConsultations(agents: readonly HerdrAgent[]): Promise<boolean> {
		let changed = false;
		const consultations = this.state.consultationRecord.consultationsByState([
			"opening",
			"working",
			"awaiting-response",
		]);
		for (const consultation of consultations) {
			if (this.stopped) return changed;
			changed = (await this.observeOneConsultation(consultation, agents)) || changed;
		}
		return changed;
	}

	/**
	 * The one durable Consultation the poll reconciles: its match, its handles,
	 * its status, and its working turn.
	 */
	private async observeOneConsultation(
		consultation: Consultation,
		agents: readonly HerdrAgent[],
	): Promise<boolean> {
		const match = matchConsultationAgent(consultation, agents);
		if (match === "ambiguous" || match === undefined) {
			return this.consultationUnmatched(consultation, match);
		}
		if (consultation.state === "opening") {
			return this.consultationOpening(consultation, match);
		}
		let moved = this.refreshConsultationHandles(consultation, match);
		const status = normalizeAgentStatus(match.status);
		if (status === "unknown") {
			return this.consultUnknownStatus(consultation) || moved;
		}
		if (consultation.warning === "Agent status is unknown") {
			this.state.consultationRecord.setConsultationWarning(consultation.id, null);
			moved = true;
		}
		return (await this.consultWorkingTurn(consultation, match, status)) || moved;
	}

	/**
	 * The durable handles a verified Agent carries when they differ from the
	 * record's: the write is the change the reconciler reports.
	 */
	private refreshConsultationHandles(consultation: Consultation, match: HerdrAgent): boolean {
		if (
			consultation.paneId === match.paneId &&
			consultation.tabId === match.tabId &&
			consultation.workspaceId === match.workspaceId
		) {
			return false;
		}
		this.state.consultationRecord.updateConsultationAgentHandles(consultation.id, {
			paneId: match.paneId,
			tabId: match.tabId,
			workspaceId: match.workspaceId,
			sessionId: match.stableSessionId ?? consultation.sessionId,
		});
		return true;
	}

	/** The warning one Consultation takes when its Agent's status is unknown. */
	private consultUnknownStatus(consultation: Consultation): boolean {
		if (consultation.warning === "Agent status is unknown") return false;
		this.state.consultationRecord.setConsultationWarning(
			consultation.id,
			"Agent status is unknown",
		);
		this.onStatus(
			"warning",
			`Agent status is unknown for Consultation ${consultation.id.slice(0, 8)}`,
		);
		return true;
	}

	/** The working Consultation's external turn, and its settle when the turn ends. */
	private async consultWorkingTurn(
		consultation: Consultation,
		match: HerdrAgent,
		status: string,
	): Promise<boolean> {
		const moved = await this.consultationExternalTurn(consultation, match);
		const current = this.state.consultationRecord.consultation(consultation.id);
		if (current?.state !== "working" || status === "working") return moved;
		return (await this.settleWorkingConsultation(consultation, match, status)) || moved;
	}

	/**
	 * The unmatched Consultation: no Agent, or an Agent whose identity the poll
	 * cannot tell apart from another's.
	 */
	private consultationUnmatched(
		consultation: Consultation,
		match: HerdrAgent | "ambiguous" | undefined,
	): boolean {
		if (consultation.state === "opening") {
			// A restart can interrupt launch between durable steps. The
			// operator, not the poll, decides whether recovery continues.
			const warning =
				match === "ambiguous"
					? "Opening Agent match is ambiguous; explicit recovery is required"
					: "Opening Agent is not visible; explicit recovery is required";
			if (consultation.warning === warning) return false;
			this.state.consultationRecord.setConsultationWarning(consultation.id, warning);
			this.onStatus("warning", `Consultation ${consultation.id.slice(0, 8)} needs recovery`);
			return true;
		}
		const reason = match === "ambiguous" ? "Agent session match is ambiguous" : "Agent is missing";
		const moved = this.state.consultationRecord.setConsultationState(
			consultation.id,
			"missing",
			reason,
		);
		if (moved)
			this.onStatus("warning", `${reason} for Consultation ${consultation.id.slice(0, 8)}`);
		return moved;
	}

	/** The opening Consultation: its verified Agent refreshes its durable handles. */
	private consultationOpening(consultation: Consultation, match: HerdrAgent): boolean {
		// A uniquely verified Agent may refresh its durable handles, but
		// remains opening until the operator chooses recovery.
		this.state.consultationRecord.recordConsultationAgentHandles(consultation.id, {
			paneId: match.paneId,
			tabId: match.tabId,
			workspaceId: match.workspaceId,
			sessionId: match.stableSessionId ?? consultation.sessionId,
		});
		const warning =
			normalizeAgentStatus(match.status) === "unknown"
				? "Agent status is unknown"
				: "Opening Agent verified; explicit recovery is required";
		if (consultation.warning === warning) return false;
		this.state.consultationRecord.setConsultationWarning(consultation.id, warning);
		return true;
	}

	/** The external turn an awaiting Consultation's Agent sends, and its snapshot. */
	private async consultationExternalTurn(
		consultation: Consultation,
		match: HerdrAgent,
	): Promise<boolean> {
		let changed = false;
		if (
			consultation.state === "awaiting-response" &&
			match.sequence !== undefined &&
			(consultation.latestSequence === null || match.sequence > consultation.latestSequence)
		)
			changed =
				this.state.consultationRecord.recordExternalConsultationTurn(
					consultation.id,
					match.sequence,
					new Date(this.now()).toISOString(),
				) || changed;
		const before = this.state.consultationRecord.consultation(consultation.id);
		if (
			before?.state === "awaiting-response" &&
			this.state.consultationRecord.consultationNeedsSnapshot(consultation.id)
		) {
			const output = await this.herdr.readPane(match.paneId, this.config().completionMessageLines);
			if (this.stopped) return changed;
			if (
				output !== null &&
				this.state.consultationRecord.fillConsultationSnapshot(consultation.id, output)
			) {
				changed = true;
				this.onConsultationsChanged?.();
			}
		}
		return changed;
	}

	/** The settle of a working Consultation whose Agent reports done or idle. */
	private async settleWorkingConsultation(
		consultation: Consultation,
		match: HerdrAgent,
		status: string,
	): Promise<boolean> {
		const output = await this.herdr.readPane(match.paneId, this.config().completionMessageLines);
		if (this.stopped) return false;
		// The turn's end cause comes from the agent's session record, the
		// same reader the ticket settle uses (ADR 0015). The pending turn's
		// accepted time feeds the staleness guard.
		const kind = this.config().agents[consultation.agentType]?.kind;
		const pendingTurn = this.state.consultationRecord
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
		const settled = this.state.consultationRecord.settleConsultationTurn(
			consultation.id,
			match.sequence ?? null,
			output,
			{
				settledStatus: status,
				capturedAt: new Date(this.now()).toISOString(),
				cause: endCause,
				detail: endDetail,
			},
		);
		if (!settled) return false;
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
		return true;
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
		const cause: TurnEndCause =
			turnEnd?.cause ?? (turnRead.kind === "no-turn" ? "no-turn" : "unknown");
		const detail: string = turnEnd?.detail ?? "";
		const resolved = await this.settleMessage(turnEnd?.log ?? [], agent);
		if (this.stopped) return true;
		// The transition fires on a `completed` settle, before the completion
		// decision, in manual mode and in auto mode alike (ADR 0027): it
		// writes the label facts and the trace stores its outcome, so the
		// decision the operator or the loop makes next reads the facts the
		// plane wrote, not a re-read of the source.
		let transition: TransitionOutcome | null = null;
		if (cause === "completed" && this.fireCompleted !== undefined) {
			transition = (await this.fireCompleted(ticket)) ?? null;
			if (this.stopped) return true;
		}
		this.state.ticketWorkCycle.settleTurn({
			ticketIdentity: ticket.ticketIdentity,
			handoffId: ticket.handoffAttemptId,
			taskType: ticket.taskType,
			agentType: ticket.agentType,
			message: resolved.message,
			turnLog: resolved.turnLog,
			cause,
			detail,
			completedAt: new Date(this.now()).toISOString(),
			...(transition === null ? {} : { transition }),
		});
		this.reportSettleStatus(ticket, cause, detail, transition);
		return true;
	}

	/**
	 * The settle's message and its log: the session log when it holds a final
	 * text, the terminal capture when it does not.
	 *
	 * The log holds no final text: the capture stands in for the
	 * message, the session log stays.
	 */
	private async settleMessage(
		turnLog: TurnLogEntry[],
		agent: HerdrAgent,
	): Promise<{ turnLog: TurnLogEntry[]; message: string }> {
		const message = lastMessageFromLog(turnLog);
		if (turnLog.length === 0) {
			const capture =
				(await this.herdr.readPane(agent.paneId, this.config().completionMessageLines)) ?? "";
			return { turnLog: turnLogFromCapture(capture), message: capture };
		}
		if (message !== "") return { turnLog, message };
		const capture =
			(await this.herdr.readPane(agent.paneId, this.config().completionMessageLines)) ?? "";
		return { turnLog, message: capture };
	}

	/** The settle's facts on the Message line, held or settled, and the label failure. */
	private reportSettleStatus(
		ticket: HandoffTicket,
		cause: TurnEndCause,
		detail: string,
		transition: TransitionOutcome | null,
	): void {
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
			return;
		}
		this.onStatus("info", `agent settled a turn on ticket ${ticket.ticketIdentity}`);
		// The failed label write is loud on the line the operator already watches
		// (ADR 0092): the turn parks for the operator, the machine routes nothing
		// from labels it did not write, and the reason stands on the cycle that
		// produced it. The Decision screen states the same fact as its fact line,
		// and the re-fire of a recorded skip states it again when the write fails
		// a second time.
		if (transition !== null && transition.writeFailure !== "") {
			this.onStatus(
				"warning",
				`ticket ${ticket.ticketIdentity} settled, and its label write failed: ${transition.writeFailure}`,
			);
		}
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
		const handoffCount = this.state.handoff.handoffCount(ticket.ticketIdentity);
		if (handoffLimitReached(handoffCount, config.maxHandoffsPerTicket)) {
			const applied = this.state.ticketWorkCycle.applyCompletionDecision({
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
	 * Resolve an awaiting ticket by the automatic rule (ADR 0051, ADR 0092).
	 * Returns whether the cycle changed factory state.
	 *
	 * Auto mode only: the walk above gates it, because in manual mode a settled
	 * turn rests in awaiting for the operator's Decision screen. The machine closes
	 * the cycles it resolves - a turn with no Next step, a Next step the Handoff
	 * limit holds - and rests the rest in awaiting: a held turn, a transition whose
	 * label write failed, a turn of an Operator-decides type (ADR 0085, renamed by
	 * ADR 0092), and a Next step another gate holds. A step the machine takes
	 * decides nothing here: it is the top-up's continuation, and the top-up's one
	 * item at a time is the wait the queue holds.
	 *
	 * `projection` is the cycle's one projection read, before the list rule: the
	 * Next step derivation reads the position's row, so the walk shares one read
	 * instead of paying a scan for every awaiting ticket.
	 */
	private async handleAwaiting(
		ticket: HandoffTicket,
		projection: TicketProjection,
	): Promise<boolean> {
		const completion = this.state.ticketWorkCycle.lastCompletion(ticket.ticketIdentity);
		// A decided turn decides nothing more: the route recorded its decision
		// when it started, the automatic rule cannot route the same turn twice,
		// and the routed turn rests in awaiting for the operator's close.
		if (completion !== null && completion.decision !== null) return false;
		// The one route rule, read at both walks (ADR 0051, ADR 0092): this walk
		// closes what the machine resolves, and `continuationTarget` asks the
		// same answer for what it enqueues. A `route` rests for the top-up, and a
		// `hold` or a `park` rests in awaiting; none closes here, and none
		// re-derives the condition.
		const rule = this.decideAwaiting(completion, projection);
		if (rule.decision === "hold" && rule.step !== null) {
			// The mode that produces the hold is the mode that owes the operator a
			// word about it (ADR 0092): the Decision screen never opens on this turn,
			// so the Message line is where the held step and its gate stand.
			this.reportHeldNextStep(ticket, rule.step);
			return false;
		}
		if (rule.decision !== "close") return false;
		const decidedAt = new Date(this.now()).toISOString();
		const applied = this.state.ticketWorkCycle.applyCompletionDecision({
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
	 * The Message line for a Next step a gate holds (ADR 0092), beside the settle
	 * that produces it.
	 *
	 * In Auto-handoff mode the Decision screen never opens on a settled turn, so
	 * this line is where a held step stands while the mode runs. It names the step
	 * the machine will not take, the position it stands on when that is not the
	 * settled ticket, and the gate that holds it - the same gate sentence the
	 * Decision screen states in manual mode. One line per settled turn: the hold is
	 * re-derived every cycle, and the line stands only when the fact the last line
	 * stated has changed.
	 *
	 * The line is news, not a warning. A hold is often the transient gap between the
	 * labels the fire wrote and the refresh that re-reads them, and the cycle that
	 * closes the gap states its own routing line over this one; a standing warning
	 * would pin the Message line and ring the desktop for a condition the machine
	 * resolves on its own.
	 *
	 * The same fact leaves one line in the plane's record (issue #223), and the
	 * record outlet runs the pattern the cycle's other standing holds use (issue
	 * #232): the fact is noted beside them and states itself when the cycle's walks
	 * are done (`reportAutomaticHolds`), so the module that owns the gates owns the
	 * words, the key, and the repeat rule for this hold as for theirs. The Message
	 * outlet keeps its own per-turn map, keyed on the same `automaticHoldKey`, so
	 * each outlet states the fact once while it stands and again when it changes.
	 */
	private reportHeldNextStep(ticket: HandoffTicket, step: NextStep): void {
		if (step.gate === null) return;
		const hold: AutomaticNextStepHold = {
			reason: "next-step-held",
			ticket: ticket.ticketIdentity,
			step: step.taskType,
			...(step.ticketIdentity === ticket.ticketIdentity ? {} : { position: step.ticketIdentity }),
			gate: step.gate,
		};
		// The record outlet: noted beside the walks' holds, and stated with them
		// when the cycle's walks are done (issue #232).
		this.noteAutomaticHold(hold);
		// The Message outlet: one line per settled turn, keyed on the same fact
		// the record keys on.
		const key = automaticHoldKey(hold);
		if (this.holdReports.get(ticket.ticketIdentity) === key) return;
		this.holdReports.set(ticket.ticketIdentity, key);
		const where = step.ticketIdentity === ticket.ticketIdentity ? "" : ` on ${step.ticketIdentity}`;
		this.onStatus(
			"info",
			`ticket ${ticket.ticketIdentity} holds its Next step ${step.taskType}${where}: ${NEXT_STEP_GATE_LINES[step.gate]}`,
		);
	}

	/**
	 * The automatic Completion rule (ADR 0051, ADR 0092). Auto mode only: the
	 * caller gates it, and the rule is one fact - the settled turn's Next step.
	 * Auto-handoff mode takes the step on its own, and closes the cycle when
	 * the turn has none.
	 *
	 * Three facts park the turn for the operator ahead of the step: a held
	 * turn (ADR 0016), a transition whose label write failed - the plane does
	 * not route from labels it did not write - and a turn of a task type that
	 * carries Operator-decides (ADR 0085, renamed by ADR 0092), the only
	 * per-task-type brake the mode carries.
	 *
	 * A Next step the Handoff limit holds degrades to close, the way a route at
	 * the limit did. A step another gate holds rests in awaiting: the top-up
	 * will not take it, and the Decision screen states the hold.
	 *
	 * `projection` is the projection read the caller already holds, before the
	 * list rule: the derivation reads the position's row out of it, and no caller
	 * pays for a scan of its own.
	 */
	decideAwaiting(completion: Completion | null, projection: TicketProjection): AwaitingRule {
		const outcome = completion?.transition ?? null;
		// The held-turn gate (ADR 0016): a turn that failed, aborted, or was
		// truncated is held. No automatic decision runs on it; the operator's
		// explicit close or route still works.
		if (isHeldCompletion(completion)) return { decision: "park", step: null };
		// The Operator-decides brake (ADR 0085, ADR 0092) stands ahead of every
		// outcome check: a live session the parked turn holds stays untouched,
		// and the operator's close is the gate from its turn to whatever the
		// ticket's new position offers next.
		if (completion !== null && operatorDecidesType(this.config().taskTypes, completion.taskType))
			return { decision: "park", step: null };
		if (outcome === null || outcome.fired !== true) return { decision: "close", step: null };
		if (outcome.writeFailure !== "") return { decision: "park", step: null };
		const step = deriveNextStep(this.config(), this.state.ticketWorkCycle, outcome, projection);
		// No Next step: the facts landed on a parking state, or on no position at
		// all, so the cycle ends where the machine put the ticket.
		if (step === null) return { decision: "close", step: null };
		if (step.gate === "handoff-limit") return { decision: "close", step };
		if (step.gate !== null) return { decision: "hold", step };
		return { decision: "route", step };
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
	 * The continuation asks the cycle owes (ADR 0051's walks 1 and 2, moved ahead
	 * of the Work queue's pickup by ADR 0094): the settled turn's Next step, and
	 * the re-fired skip's route.
	 *
	 * They run first so the item a settling turn earns is already in the queue
	 * when the free seats are handed out, and the seat a settling turn freed goes
	 * to that turn's own next step instead of to a fresh ticket.
	 *
	 * The queue gate narrows here to the one row this add must not jump: a Workflow
	 * route row the queue already holds. A standing fresh-work row - an open ticket's
	 * item or a restart - does not hold a continuation: ADR 0051 ranks the
	 * continuation above them, and ADR 0094 reads that rank across cycles instead of
	 * inside one top-up call. A row the operator staged does hold it: ADR 0100's rank
	 * is the owed row's place in the queue's order, and a row that already stands is
	 * never overtaken (issue #230). The hold line names which of the two stands,
	 * because the origin names both `workflow` (issue #223).
	 */
	private async askContinuations(): Promise<boolean> {
		// The queue's rows, read once for the whole walk (issue #202, ADR 0092):
		// the gate below reads them, and no walk asks the queue for one Ticket's
		// fact of its own.
		const queueItems = this.state.workQueue.items();
		const gate = automaticAddsHold(this.cycleFacts());
		if (gate !== null) {
			this.noteAutomaticHold(gate);
			return false;
		}
		// The row this add waits behind: a Workflow route row the queue already
		// holds. The hold names that row's staging, because the origin cannot tell
		// the two apart - the operator's route and the factory's continuation are
		// both `workflow` (issue #223) - and names the row itself, so the record says
		// which owed start the hold blocked (issue #223 review).
		const held = continuationHold(
			queueItems.map((item) => ({
				identity: workQueueIdentityOf(item),
				continuation: item.kind !== "consultation" && item.origin === "workflow",
				automatic: item.kind !== "consultation" && item.automatic,
			})),
		);
		if (held !== null) {
			this.noteAutomaticHold(held);
			return false;
		}
		const config = this.config();
		// The list, in one read. These walks take the active view: the rows the
		// whole list rule leaves.
		const list = this.state.ticketWorkCycle.ticketListViews(
			config.workflowStates,
			config.defaultTaskType,
			"all",
		);
		const tickets = list.active;
		// The same read's projection before the list rule (ADR 0042): the covered
		// ticket's row is withheld from the operator's list, and a route must still
		// reach the position it starts on. Both continuation walks, and the Next
		// step derivation each of them reads, take this one array.
		const projection = list.projection;
		// 1. Continuation: the awaiting ticket whose turn the machine routes, and
		// the open ticket whose newest settled turn recorded an automatic route -
		// the route's ask ended the cycle at the ask (ADR 0072), and a drop or
		// the operator's removal left the route unrun while the decision stands
		// on the trace. In the ticket list's order, in one read.
		for (const ticket of tickets) {
			if (await this.askContinuationTicket(config, projection, ticket)) return true;
		}
		// 2. The re-fired skip's route (ADR 0042) is a continuation: the skip
		// closed its cycle and the ticket rests open behind it, so the awaiting
		// walk never covered it. It enqueues like the rest, on the same Next step
		// derivation and the same gates the continuation walk reads.
		for (const ticket of tickets) {
			if (await this.askRefiredSkipTicket(config, projection, ticket)) return true;
		}
		return false;
	}

	/** The continuation walk's add for one row: the gates, the step, and the ask. */
	private async askContinuationTicket(
		config: FactoryConfig,
		projection: TicketProjection,
		ticket: Ticket,
	): Promise<boolean> {
		if (ticket.state !== "awaiting" && ticket.state !== "open") return false;
		// The ignore gate (ADR 0060): an ignored Ticket is no automatic start.
		// The row is here in the active view the whole time its Agent works or
		// its decision stays owed, so this test - not the filter - is what holds
		// the machine out, and it is the one gate predicate on the row's flag.
		if (automaticStartBlocked(ticket)) return false;
		const target = this.continuationTarget(ticket, projection);
		if (target === null) return false;
		const { position, step } = target;
		// The merged position the turn routes to (ADR 0068): the Next step
		// resolves on the plane action, so the top-up asks for the merge, not
		// for a handoff, and the item takes no seat when it runs.
		if (step.kind === "plane-action")
			return (await this.askPlaneActionAdd(position, ticket.identity, step.taskType)) !== "refused";
		const completion = this.state.ticketWorkCycle.lastCompletion(ticket.identity);
		const outcome = completion?.transition ?? null;
		const added = await this.topUpAsk(
			this.continuationAskFields({ config, step, ticket, position, outcome, completion }),
			`work queue top-up: routing ${this.ticketName(ticket.identity)} to ${step.taskType}`,
			`work queue top-up could not route ${this.ticketName(ticket.identity)}`,
		);
		// One add per cycle: the walk stops at the first item the queue took,
		// and a refused ask moves on to the next candidate.
		return added !== "refused";
	}

	/** The continuation ask's fields, the route's choice among them. */
	private continuationAskFields(fields: {
		config: FactoryConfig;
		step: NextStep;
		ticket: Ticket;
		position: { identity: string };
		outcome: TransitionOutcome | null;
		completion: Completion | null;
	}): HandoffIntent {
		const { config, step, ticket, position, outcome, completion } = fields;
		return {
			origin: "workflow",
			automatic: true,
			ticketIdentity: position.identity,
			// The route continues this ticket's settled turn: its leftover
			// environment is the handoff's own, so a name that leftover
			// agent still holds falls to the cycle name instead of failing
			// as a stranger (ADR 0027).
			routeFromIdentity: ticket.identity,
			choice: resolveHandoffChoice(config, step.taskType, {
				...(outcome === null || outcome.agent === undefined ? {} : { agent: outcome.agent }),
				...(outcome === null || outcome.environment === undefined
					? {}
					: { environment: outcome.environment }),
			}),
			previousMessage: this.promptPreviousMessage(completion),
		};
	}

	/** The re-fired skip's add for one row: the marker, the step, and the ask. */
	private async askRefiredSkipTicket(
		config: FactoryConfig,
		projection: TicketProjection,
		ticket: Ticket,
	): Promise<boolean> {
		if (ticket.state !== "open") return false;
		const completion = this.state.ticketWorkCycle.lastCompletion(ticket.identity);
		const outcome = completion?.transition ?? null;
		// The marker carries the shape: `refired` is set only on an outcome
		// that fired and derived a position, so a re-fired trace with no fire
		// is not a state the plane writes. The marker holds the record against
		// a damaged trace; no walk reaches it on its own.
		if (outcome === null || outcome.refired !== true) return false;
		const step = deriveNextStep(config, this.state.ticketWorkCycle, outcome, projection);
		if (step === null || step.gate !== null) return false;
		// The projection before the list rule (ADR 0042): the rule withholds
		// a covered ticket's row from the operator's list, and the add must
		// still reach the position it starts on.
		const position = projection.rowFor(step.ticketIdentity);
		if (position === undefined) return false;
		// The ignore gate (ADR 0060): this walk reads the projection before the
		// list rule on purpose, because ADR 0042's route must reach its position
		// even when the row is withheld, and a resting ignored position is
		// withheld while a live one is listed. Either way the one gate predicate on
		// the row the walk holds is what answers.
		if (automaticStartBlocked(position)) return false;
		// The merged position the skip routes to (ADR 0068): the plane
		// action's merge stands for the handoff the skip would start, and the
		// standing, hold, and limit guards the derivation ran hold the add the
		// way the handoff's add held: an automatic merge add holds wherever the
		// handoff's add would have held.
		if (step.kind === "plane-action")
			return (await this.askPlaneActionAdd(position, ticket.identity, step.taskType)) !== "refused";
		const added = await this.topUpAsk(
			{
				origin: "workflow",
				automatic: true,
				ticketIdentity: position.identity,
				routeFromIdentity: ticket.identity,
				choice: resolveHandoffChoice(config, step.taskType, {
					...(outcome.agent === undefined ? {} : { agent: outcome.agent }),
					...(outcome.environment === undefined ? {} : { environment: outcome.environment }),
				}),
				previousMessage: this.promptPreviousMessage(completion),
			},
			`work queue top-up: routing ${this.ticketName(ticket.identity)} to ${step.taskType}`,
			`work queue top-up could not route ${this.ticketName(ticket.identity)}`,
		);
		return added !== "refused";
	}

	/** The plane action's merge add, in the top-up's words. */
	private askPlaneActionAdd(
		position: { identity: string },
		routeFrom: string,
		taskType: string,
	): Promise<"added" | "refused" | "stopped"> {
		return this.topUpPlaneActionAsk(
			{
				origin: "workflow",
				automatic: true,
				ticketIdentity: position.identity,
				routeFromIdentity: routeFrom,
				taskType,
			},
			`work queue top-up: merging ${this.ticketName(position.identity)}`,
			`work queue top-up could not merge ${this.ticketName(position.identity)}`,
		);
	}

	/**
	 * The cycle's standing gate facts (ADR 0051, ADR 0052, ADR 0016): the mode, the
	 * queue's brake, and the Dispatch pause. The automatic walks read these before
	 * they read any candidate.
	 */
	private cycleFacts(): Omit<TopUpCycleFacts, "queueDepth"> {
		return {
			modeOn: this.mode(),
			queuePaused: this.state.workQueue.queuePaused(),
			dispatchPauseActive: this.state.ticketWorkCycle.dispatchPauseActive(),
		};
	}

	/**
	 * The hold one automatic walk took (issue #223).
	 *
	 * The walk keeps its own gate; this only collects the fact it acted on. The
	 * cycle states the facts it collected when its walks are done
	 * (`reportAutomaticHolds`), so a cycle that holds at two gates at once states
	 * each of them once, and not twice per poll.
	 */
	private noteAutomaticHold(hold: AutomaticHold): void {
		this.automaticHolds.set(automaticHoldKey(hold), hold);
	}

	/**
	 * The record lines for the holds this cycle's automatic walks took (issue #223).
	 *
	 * Every one of these holds returns before the walk asks anything, so the run
	 * shows the start that never came and nothing about why. The line names the
	 * fact the cycle acted on - the mode, the queue pause, the Dispatch pause, a
	 * continuation already standing, a row the operator staged, or a row already in
	 * the queue - in the words the gate rule owns, so a reviewer can tell a correct
	 * hold from a broken one. A hold that waits behind a standing row names that
	 * row, so the record answers which owed start the hold blocked and not only
	 * that a hold happened.
	 *
	 * One line per standing fact: the holds are re-derived on every poll, and a
	 * fact that stood last cycle too says nothing again. A fact that left and came
	 * back, a new fact the cycle reached, or the same fact behind a different row
	 * states itself once more. The held Next step rides this same rule (issue
	 * #232): the awaiting walk notes it beside the walks' holds, and the fact is
	 * the ticket, the step, the position, and the gate, so a hold that changes its
	 * gate or its position is a new fact the record states again.
	 *
	 * A walk the cycle did not run states nothing new and clears nothing. The cycle
	 * that asks a continuation asks no fresh work (ADR 0051), so the row that
	 * fresh-work walk waits behind is never read in that cycle: the row stands the
	 * whole time, and its line stays silent rather than stating itself again on the
	 * next poll (issue #223 review). Only a cycle that reads the fact and finds it
	 * gone retires it, so the row that really leaves the queue is stated again when
	 * a row comes back.
	 *
	 * The walk's per-candidate facts (issue #231) clear and carry per candidate,
	 * not per walk. The walk reads a candidate when its gate holds it, and the
	 * candidate's facts then stand only on what the gate answered this cycle: a
	 * fact that changed is a new fact and states itself again, and a fact the gate
	 * no longer answers retires. A candidate the walk stopped before is never
	 * read, and its last-stated facts keep standing the same way a skipped walk's
	 * row does.
	 *
	 * The name read for a standing row runs here and not where the walk noted the
	 * hold, so a fact that stands across a hundred polls costs no read at the poll's
	 * cadence. A cycle that throws between its walks and this report keeps no note:
	 * its holds state themselves on the next cycle that reaches here.
	 */
	private reportAutomaticHolds(freshWorkWalkRan: boolean, modeOn: boolean): void {
		for (const [key, hold] of this.automaticHolds) {
			if (this.automaticHoldsReported.has(key)) continue;
			this.log.info(automaticHoldLine(hold, (identity) => this.ticketName(identity)));
		}
		const reported = new Map(this.automaticHolds);
		// `queue-row-standing` is the fact only the fresh-work walk states: the
		// continuation walk answers its own queue rule (ADR 0094), and the mode,
		// the pause, and the Dispatch pause are noted by both walks. So the carry-
		// over names one reason, and it is the one the skipped walk owns.
		if (!freshWorkWalkRan) this.carryReasonHolds(reported, "queue-row-standing");
		// `next-step-held` is the fact only the awaiting walk states (ADR 0092),
		// and the walk reads no held step while the mode is off: the skip is the
		// cycle's own choice, not the fact leaving, so a hold that stood through
		// the toggle is carried the way the skipped walk's row is, and the mode
		// returning to a still-standing hold is not a new fact (issue #232).
		if (!modeOn) this.carryReasonHolds(reported, "next-step-held");
		this.carryCandidateHolds(reported);
		this.automaticHoldsReported = reported;
		this.automaticHolds = new Map();
	}

	/**
	 * The reported hold that carries one reason forward, when that walk skipped.
	 *
	 * The hold the skipped walk owns keeps standing: the skip is the cycle's
	 * own choice, not the fact leaving.
	 */
	private carryReasonHolds(reported: Map<string, AutomaticHold>, reason: string): void {
		for (const [key, hold] of this.automaticHoldsReported)
			if (hold.reason === reason) reported.set(key, hold);
	}

	/**
	 * The fresh-work walk's per-candidate facts (issue #231), carried per
	 * candidate, not per walk: the walk read the candidates its gate left
	 * standing, and the ones it stopped before keep the facts the last line
	 * stated - the stop is the cycle's own choice, not the fact leaving. A
	 * candidate the walk read retires every fact it stands on and stands
	 * whatever the gate answers now.
	 */
	private carryCandidateHolds(reported: Map<string, AutomaticHold>): void {
		for (const [key, hold] of this.automaticHoldsReported) {
			if (hold.candidate === undefined) continue;
			if (!this.freshWorkCandidatesRead.has(hold.candidate)) reported.set(key, hold);
		}
	}

	/**
	 * The fresh-work adds (ADR 0051's walks 3 and 4): a restart, then an open
	 * pull request ticket, then a fresh open ticket. They keep the top-up's
	 * empty-queue gate, so the queue never piles and the operator's staging always
	 * starts before the factory's. A seat the item cannot take yet is the wait the
	 * queue item holds: the item rests in the queue until a seat frees, and the add
	 * reconsiders every cycle the queue is empty.
	 */
	private async topUpFreshWork(agents: readonly HerdrAgent[]): Promise<boolean> {
		// The queue's rows, read once for the whole walk (issue #202, ADR 0092):
		// the pace gate needs the depth, and every walk needs the fact of whether
		// an item already stands for the candidate it holds.
		const queueItems = this.state.workQueue.items();
		const hold = freshWorkHold({ ...this.cycleFacts(), queueDepth: queueItems.length });
		// The Missing Agent's restart is the one fresh-work add a standing queue row
		// does not hold (ADR 0108): the seat that Agent left is reserved for its own
		// restart row, and the row enters ahead of the standing rows the way the owed
		// continuation does (ADR 0100). Every other fresh-work add keeps ADR 0051's
		// empty-queue rule, and the hold states itself as it always did.
		const standingRowHold =
			hold !== null &&
			hold.reason === "queue-row-standing" &&
			automaticAddsHold(this.cycleFacts()) === null
				? hold
				: null;
		if (hold !== null && standingRowHold === null) {
			this.noteAutomaticHold(hold);
			return false;
		}
		const queuedTickets = new Set(
			queueItems.filter((item) => item.kind !== "consultation").map((item) => item.ticketIdentity),
		);
		const config = this.config();
		// The pile, in one read for the walk that holds an identity and no row
		// (ADR 0060, widened by ADR 0070): the in-flight tickets the Restart walk
		// reads carry no facts of their own, and the flag may be the ticket's own
		// or its source's, so one read answers the whole cycle in place of one query
		// per candidate. The open-ticket walk asks `automaticStartBlocked` of the row
		// it holds, and the row's facts fold the same flag.
		const blocked = this.state.ticketWorkCycle.automaticStartBlockedTickets();
		// The open-ticket add takes the `all` view - every row the covered rule
		// leaves, the ignore aside - and gates the flag on its own, so the gate is
		// the walk's own test and not an accident of which view it happens to read.
		const list = this.state.ticketWorkCycle.ticketListViews(
			config.workflowStates,
			config.defaultTaskType,
			"all",
		);
		// 3. Restart: the in-flight ticket whose agent is missing past the
		// grace and whose handoffs stand below the limit - the abandon at the
		// limit landed in the in-flight walk already, above. One restart per
		// episode: the mark stands while the asked-for start holds its place in
		// the queue or runs, and a refused ask clears it again, so the next
		// empty-queue cycle reconsiders the restart the way ADR 0051 states.
		const restartTickets = this.state.ticketWorkCycle.ticketsByState(["handed-off", "running"]);
		// The start count each candidate needs arrives as one batched read for the
		// in-flight list, the same shape the projection pays (issue #202, ADR 0095).
		// Asked per candidate it cost two statements for every in-flight Ticket on
		// every cycle the walk ran.
		const restartStartCounts = this.state.handoff.handoffCountsFor(
			restartTickets.map((ticket) => ticket.ticketIdentity),
		);
		if (
			await this.topUpRestartAdds({
				config,
				agents,
				blocked,
				queuedTickets,
				restartTickets,
				restartStartCounts,
			})
		)
			return true;
		// The standing row the restart walked past is the open-ticket add's hold
		// (ADR 0051, ADR 0108): the restart asked above, and the queue keeps its
		// one-item pace for every other fresh-work add.
		if (standingRowHold !== null) {
			this.noteAutomaticHold(standingRowHold);
			return false;
		}
		// 4. A new open ticket (ADR 0051, ADR 0088): the first open ticket in
		// the list's order that every wait the auto-dispatch checked still
		// passes - actionable, under the handoff limit, re-verified since its
		// last cycle ended, offering a task, and past the Same-type hold. The
		// open pull request tickets stand in their own group ahead of the
		// rest: the work the machine has started on a pull request - the
		// review, the rework, the merge - moves to the end before the machine
		// starts work on a ticket it has not started. The list's order holds
		// inside each group, and a gate that holds one ticket holds that
		// ticket only: the walk falls to the next candidate, as before. A
		// full parallel seat is no longer a hold here: the item rests in the
		// queue until a seat frees.
		return await this.topUpOpenTicketGroups(config, list, queuedTickets);
	}

	/** The restart walk: the in-flight tickets whose Agent is missing past grace. */
	private async topUpRestartAdds(fields: RestartWalkFields): Promise<boolean> {
		const { config, agents, blocked, queuedTickets, restartTickets, restartStartCounts } = fields;
		const byPane = new Map<string, HerdrAgent>();
		for (const agent of agents) byPane.set(agent.paneId, agent);
		const restartNames = this.agentNames(restartTickets);
		for (const ticket of restartTickets) {
			// The gate (ADR 0060, widened by ADR 0070): this walk reads the
			// in-flight tickets directly, not the list, and a flagged Ticket whose
			// Agent is missing is listed all the same because its work is live - so
			// without the test the plane would start an Agent on work the operator
			// judged out, and it would keep starting it for as long as the flag
			// stood. The identity is all this walk holds, so it asks the cycle's
			// own read of the pile, the ticket's flag or its source's.
			// The candidate the walk reads, the way the open walk's candidates are
			// named: its per-candidate facts retire and stand on the read (issue #231).
			this.freshWorkCandidatesRead.add(ticket.ticketIdentity);
			// The restart candidate's gate (ADR 0051, ADR 0060, ADR 0070): the flag,
			// the startup grace, the missing Agent, the loop guard, and the marks
			// that already stand for this ticket. The rule decides, and it answers
			// the fact the hold states, the first gate that stands (issue #231).
			const gate = restartCandidateGate({
				ignoreBlocked: blocked.has(ticket.ticketIdentity),
				// The Operator-decides brake (ADR 0117): the restart repeats the
				// interrupted handoff's start, and a start the machine makes alone
				// of a type the operator owns is the fault the flag exists to keep
				// out. The Missing modal stands, and the operator's Restart or
				// abandon answers. The brake is the designed silence: the gate holds
				// without stating a fact.
				operatorDecides: operatorDecidesType(config.taskTypes, ticket.taskType),
				pastStartupGrace: this.now() - Date.parse(ticket.startedAt) >= this.startupGraceMs,
				hasPane: ticket.paneId !== null,
				// The one missing-Agent rule, read the way the in-flight pass reads it.
				agentMissing:
					agentInPane(byPane, ticket.paneId, restartNames.get(ticket.ticketIdentity) ?? "") ===
					null,
				handoffCount: restartStartCounts.get(ticket.ticketIdentity) ?? 0,
				handoffLimit: config.maxHandoffsPerTicket,
				queueItemStands: queuedTickets.has(ticket.ticketIdentity),
				restartMarkStands: this.restarted.has(ticket.ticketIdentity),
			});
			if (gate.holds) {
				if (gate.reason !== null)
					this.noteAutomaticHold({
						reason: gate.reason,
						candidate: ticket.ticketIdentity,
					});
				continue;
			}
			this.restarted.add(ticket.ticketIdentity);
			const previous = this.state.ticketWorkCycle.lastCompletion(ticket.ticketIdentity);
			const added = await this.topUpAsk(
				this.restartAskIntent(ticket, previous),
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
		return false;
	}

	/** The restart ask's intent: the mark's exits, the previous handoff's choices. */
	private restartAskIntent(ticket: HandoffTicket, previous: Completion | null): HandoffIntent {
		return {
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
			choice: baseChoice(ticket.agentType, ticket.environment, ticket.taskType, {
				model: ticket.model,
				thinking: ticket.thinking,
				contextWindow: ticket.contextWindow,
			}),
			previousMessage: this.promptPreviousMessage(previous),
		};
	}

	/** The open-ticket walk: the pull request group first, the rest behind it. */
	private async topUpOpenTicketGroups(
		config: FactoryConfig,
		list: TicketListViews,
		queuedTickets: ReadonlySet<string>,
	): Promise<boolean> {
		for (const group of [
			list.rows.filter((ticket) => ticket.sourceKind === "github-pull-request"),
			list.rows.filter((ticket) => ticket.sourceKind !== "github-pull-request"),
		]) {
			for (const ticket of group) {
				// The candidate the walk reads: its per-candidate facts retire and
				// stand on the read (issue #231).
				this.freshWorkCandidatesRead.add(ticket.identity);
				if (await this.topUpOpenTicket(config, ticket, queuedTickets)) return true;
			}
		}
		return false;
	}

	/**
	 * The top-up's open-ticket add for one row (ADR 0051, ADR 0088): the
	 * waits the walk checked, on the row the walk holds, and the ask the
	 * row's task resolves on: the merge ask of the ready position, or the
	 * handoff ask of the task profile. It answers whether the queue took the
	 * item: a taken item ends the walk, and a held or refused row moves the
	 * walk on to the next candidate, the way the walk did before the split.
	 */
	private async topUpOpenTicket(
		config: FactoryConfig,
		ticket: Ticket,
		queuedTickets: ReadonlySet<string>,
	): Promise<boolean> {
		// The row gate (ADR 0051, ADR 0060, ADR 0027): the row's own facts, the
		// ignore flag read on this walk's own view - the `all` view holds every row
		// the covered rule leaves, so a resting ignored row stands here and the flag
		// on the row is what holds it out, never the filter that drew it - and the
		// task the row offers. A parking state offers none: the plane does nothing on
		// the ticket, and an external label write is the only engine that moves it.
		const row = openTicketRowGate({
			state: ticket.state,
			actionable: ticket.actionable,
			ignoreBlocked: automaticStartBlocked(ticket),
			handoffCount: ticket.handoffCount,
			handoffLimit: config.maxHandoffsPerTicket,
			taskType: ticket.suggestedTaskType,
			// The Operator-decides brake (ADR 0117): the row gate holds the Ticket
			// whose position offers a flagged type, silently, and the walk falls to
			// the next candidate.
			operatorDecides: operatorDecidesType(config.taskTypes, ticket.suggestedTaskType),
		});
		if (!row.stands) {
			// The fact the row gate acted on names itself in the record (issue #231);
			// the Operator-decides brake is the designed silence that states none
			// (ADR 0117).
			if (row.hold !== null)
				this.noteAutomaticHold({ reason: row.hold, candidate: ticket.identity });
			return false;
		}
		const taskType = row.taskType;
		// The waits the row's own facts cannot answer (ADR 0051, ADR 0026): the
		// ticket's last cycle may have ended on a source change the agent made, so
		// the sources must have re-read it; and the Same-type hold must be clear.
		// The gate holds the ticket, not a parallel slot, and it answers the fact
		// the hold states, the first wait that stands (issue #231).
		const wait = openTicketWaitsHold({
			sourceReverified: this.state.ticketWorkCycle.sourceReverifiedSinceCycleEnd(ticket.identity),
			sameTypeHoldActive: this.state.ticketWorkCycle.sameTypeHoldActive(ticket.identity, taskType),
			queueItemStands: queuedTickets.has(ticket.identity),
		});
		if (wait !== null) {
			this.noteAutomaticHold({ reason: wait, candidate: ticket.identity });
			return false;
		}
		// The ready position the list offers (ADR 0068): the task type
		// resolves on the plane action, so the top-up asks for the merge,
		// not for a handoff. The guards the handoff's add ran still ran
		// above, and the item takes no seat when it runs.
		if (isPlaneActionTaskType(config.taskTypes, taskType)) {
			const added = await this.topUpPlaneActionAsk(
				{
					origin: "open",
					automatic: true,
					ticketIdentity: ticket.identity,
					taskType,
				},
				`work queue top-up: merging ${this.ticketName(ticket.identity)}`,
				`work queue top-up could not merge ${this.ticketName(ticket.identity)}`,
			);
			return added !== "refused";
		}
		// The configured settings of the ticket's task profile (ADR 0009): an
		// unattended handoff starts with the same resolution chain a manual
		// one sees in the panel, and the fit check guards what it starts with.
		const choice = resolveHandoffChoice(config, taskType);
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
		return added !== "refused";
	}

	/**
	 * The ticket the Message line names: the projection's title, the same words
	 * the Work queue's row shows. Every queue line in the plane reads the live
	 * projection this way (ADR 0049), and the projection, not the visible list,
	 * so a covered ticket is still named by its title. The rule is the shared one
	 * the dispatch and the boot read, so one Ticket wears one name across the
	 * record (issue #295 review).
	 */
	private ticketName(identity: string): string {
		const config = this.config();
		return recordTicketName(
			this.state.ticketWorkCycle.ticketProjection(config.workflowStates, config.defaultTaskType),
			identity,
		);
	}

	/**
	 * The top-up's one ask-and-report step (ADR 0051), shared by all four
	 * walks: the failed start's hold (ADR 0077 as extended by ADR 0101), the
	 * enqueue through the dispatch seam, the refusal warning on a rejected ask,
	 * and the add line on the Message when the item took its place. The answer
	 * says what the cycle does next: "added" ends it with its one item,
	 * "refused" lets the walk move to the next candidate, and "stopped" ends the
	 * run.
	 */
	private async topUpAsk(
		intent: HandoffIntent,
		addedLine: string,
		refusedPrefix: string,
	): Promise<"added" | "refused" | "stopped"> {
		// The failed start's hold (ADR 0077 as extended by ADR 0101, issue #217):
		// the ticket's newest Handoff attempt settled `failed` - it started no
		// Agent - and not every active source has re-read the ticket since it
		// landed. The start changed nothing on the source, so the position still
		// offers the task the failed start already tried, and every other gate still
		// reads clear; without this hold the next empty-queue cycle asks the same
		// failing start again, for as long as the ticket stands. The re-ask waits for
		// the read that carries the ticket's current facts, the same wait the plane
		// action's hold keeps, and it waits on the slowest active source: one stale
		// source out of several keeps the hold. The hold is silent: the re-ask on the
		// refresh is the expected path, not a refusal to report, and the walk moves on
		// to its next candidate. It gates the automatic adds only - the operator's own
		// confirm reaches the dispatch past it, the way it passes the Handoff limit.
		if (this.state.handoff.handoffBlockedUnrefreshed(intent.ticketIdentity)) return "refused";
		// The Agent name collision (issue #299, ADR 0107): herdr holds the Ticket's
		// stable Agent name in a pane the plane cannot tie to that Ticket, and the
		// start that asked for it settled `failed` on that refusal. The two brakes
		// above bound the loop; neither waits for the operator or says what stands in
		// the way, and this refusal does not clear itself on a source read - the same
		// ask meets the same line until the operator moves the pane. So the walk stops
		// asking and the fact says why: the record names the hold once, in the voice
		// the other walk holds wear, and carries the refusal the attempt stored.
		const collision = this.nameCollisionFacts(intent.ticketIdentity);
		if (collision.collision !== null && nameCollisionStands(collision.facts)) {
			this.reportNameCollision(
				{
					reason: "agent-name-held",
					candidate: intent.ticketIdentity,
					detail: collision.collision.reason,
				},
				collision.collision,
			);
			return "refused";
		}
		// The Failed-start park (issue #298, ADR 0106): the Ticket's Handoff starts
		// keep failing, and the Top-up adds no automatic start for it. The hold above
		// waits out one failure for the source read that carries the Ticket's current
		// facts; this one stands when the re-ask on that refresh keeps failing, so the
		// loop that burned one failed start per refresh stops at half the Handoff limit
		// instead of running to the limit and parking the Ticket in silence. The park
		// is a standing fact, not a silent skip: the record names the hold once in the
		// voice the other walk holds wear, and the Message line states it as the
		// warning the Desktop notification carries (ADR 0080). It gates the automatic
		// adds only - the operator's own confirm reaches the dispatch past it, the way
		// it passes the Handoff limit, and the act that reaches an Agent ends the run.
		const park = this.failedStartParkFacts(intent.ticketIdentity);
		if (park.failedStartStreak !== 0 && failedStartParkStands(park)) {
			this.reportFailedStartPark(
				{ reason: "handoff-failure-park", candidate: intent.ticketIdentity },
				park.failedStartStreak,
			);
			return "refused";
		}
		const result = await this.dispatch(intent);
		if (this.stopped) return "stopped";
		if (!result.ok) {
			// The stopped dispatch is the teardown's fact, not a handoff
			// refusal (ADR 0051): the answer ends the walk without a line.
			if (result.reason === STOPPED_DISPATCH_REASON) return "stopped";
			// The standing-work refusal is a gate that stands, not a start that
			// could not run (issue #327): the row the walk asked for is already in
			// the queue. It is held, not warned.
			if (result.stands !== undefined) {
				this.noteStandingWorkHold(result.stands, intent.ticketIdentity);
				return "refused";
			}
			this.onStatus("warning", `${refusedPrefix}: ${result.reason}`);
			return "refused";
		}
		this.onStatus("info", addedLine);
		return "added";
	}

	/**
	 * The hold the walks take for a refusal that stands for work the plane
	 * already holds (issue #327).
	 *
	 * `queue-row` is the Work queue's one-item-per-ticket rule (ADR 0049) and
	 * `merge-run` the Plane action's run mark (ADR 0104): either way the start
	 * the walk wanted is entered, so the walk holds the way it holds at every
	 * other standing gate. The record states the fact once while it stands, in
	 * the holds' own voice, and the Message line stays clear: a warning there
	 * reads as a merge that failed, over a merge that is landing.
	 */
	private noteStandingWorkHold(stands: StandingWorkFact, ticketIdentity: string): void {
		this.noteAutomaticHold({
			reason: stands === "merge-run" ? "merge-run-standing" : "queue-item-standing",
			candidate: ticketIdentity,
		});
	}

	/**
	 * The Failed-start park's facts for one Ticket (issue #298, ADR 0106): the run
	 * the attempt ledger answers, the cap the config resolved, and whether the
	 * operator has already answered the failure.
	 *
	 * The one place the park's facts are built, so the ask that holds the automatic
	 * adds and the cycle that retires the report cannot state the fact differently.
	 * The run read is the one the ask takes for the single candidate it reached, the
	 * way the Attempt hold reads that candidate's newest attempt; the projection
	 * carries the same run for every row the list rule leaves, and the row's marker
	 * reads it from there.
	 */
	private failedStartParkFacts(ticketIdentity: string): FailedStartParkFacts {
		return {
			failedStartStreak:
				this.state.handoff.failedStartStreaksFor([ticketIdentity]).get(ticketIdentity) ?? 0,
			handoffLimit: this.config().maxHandoffsPerTicket,
			// A guard, not a path the walks reach: every walk drops a judged-out Ticket
			// before it reaches the ask, and the open-ticket walk already holds the flag
			// as its own row gate. The rule still reads it, so a Ticket the operator has
			// answered never parks here whichever walk reached its ask.
			judgedOut: this.state.ticketWorkCycle.automaticStartBlockedTicket(ticketIdentity),
		};
	}

	/**
	 * The Failed-start park's report, stated once for as long as it stands
	 * (issue #298, ADR 0106).
	 *
	 * Two channels carry the one fact. The record names the hold in the voice the
	 * automatic walks' holds wear (`automaticHoldLine`), because a run that adds no
	 * item leaves the file with no trace of the start that never came; the Message
	 * line states the standing warning the Desktop notification carries (ADR 0080),
	 * because the operator has to learn the loop stopped without reading the file.
	 *
	 * The park is derived on every ask and never stored, so this only remembers the
	 * last report, the way the held Next step's line does (`reportHeldNextStep`):
	 * one parked Ticket states itself once, and a cycle that reads the Ticket and
	 * finds the park gone (`retireFailedStartParks`) lets the next run state itself
	 * again. The memory is keyed by `automaticHoldKey` of the hold, the same key the
	 * walk-hold memory uses, so one standing fact has one key wherever it is stated.
	 */
	private reportFailedStartPark(hold: AutomaticCandidateHold, failedStartStreak: number): void {
		const key = automaticHoldKey(hold);
		if (this.parkReports.has(key)) return;
		this.parkReports.set(key, hold);
		this.log.info(automaticHoldLine(hold, (identity) => this.ticketName(identity)));
		this.onStatus(
			"warning",
			failedStartParkLine(this.ticketName(hold.candidate), failedStartStreak),
		);
	}

	/**
	 * The parks this run has stated that no longer stand (issue #298, ADR 0106).
	 *
	 * A park clears when a start reaches an Agent and ends the run, or when the
	 * operator judges the Ticket out. Neither act runs a walk that reaches the
	 * Ticket's ask, so nothing else retires the report: without this, the next run of
	 * failures would stay silent. The read runs only over the Tickets already
	 * reported, which is the parked Tickets and no others.
	 */
	private retireFailedStartParks(): void {
		if (this.parkReports.size === 0) return;
		for (const [key, hold] of this.parkReports)
			if (!failedStartParkStands(this.failedStartParkFacts(hold.candidate)))
				this.parkReports.delete(key);
	}

	/**
	 * The Agent name collision's facts for one Ticket (issue #299, ADR 0107): the
	 * standing record the refused start wrote, and whether the operator has
	 * already answered it.
	 *
	 * The one place the facts are built, so the ask that holds the automatic adds
	 * and the cycle that retires the report cannot state the fact differently. The
	 * read is the one the ask takes for the single candidate it reached, the way
	 * the Attempt hold reads that candidate's newest attempt; the projection
	 * carries the same fact for every row the list rule leaves.
	 */
	private nameCollisionFacts(ticketIdentity: string): {
		facts: NameCollisionFacts;
		collision: AgentNameCollision | null;
	} {
		const collision = this.state.handoff.nameCollision(ticketIdentity);
		return {
			collision,
			facts: {
				held: collision !== null,
				judgedOut: this.state.ticketWorkCycle.automaticStartBlockedTicket(ticketIdentity),
			},
		};
	}

	/**
	 * The Agent name collision's report, stated once for as long as it stands
	 * (issue #299, ADR 0107).
	 *
	 * Two channels carry the one fact, the way the park does. The record names the
	 * hold in the voice the automatic walks' holds wear and states the refusal the
	 * attempt's own row stores, so the file answers which Ticket the walk left
	 * resting and what stood in its way; the Message line states the standing
	 * warning the Desktop notification carries (ADR 0080) with the handles the
	 * operator has to go find, because the plane owns no cleanup for a pane it
	 * never made.
	 */
	private reportNameCollision(hold: AutomaticCandidateHold, collision: AgentNameCollision): void {
		const key = automaticHoldKey(hold);
		if (this.collisionReports.has(key)) return;
		this.collisionReports.set(key, hold);
		this.log.info(automaticHoldLine(hold, (identity) => this.ticketName(identity)));
		this.onStatus("warning", nameCollisionLine(this.ticketName(hold.candidate), collision));
	}

	/**
	 * The Agent name collisions this run has stated that no longer stand (issue
	 * #299, ADR 0107).
	 *
	 * The fact clears when the operator's own Handoff takes the name, and the
	 * ignore or a source mute answers the refusal. Neither runs a walk that reaches
	 * the Ticket's ask, so without this the next refusal would stay silent. The
	 * read runs only over the Tickets already reported.
	 */
	private retireNameCollisions(): void {
		if (this.collisionReports.size === 0) return;
		for (const [key, hold] of this.collisionReports)
			if (!nameCollisionStands(this.nameCollisionFacts(hold.candidate).facts))
				this.collisionReports.delete(key);
	}

	/**
	 * The top-up's plane action ask-and-report step (ADR 0068), the same step
	 * the handoff's ask runs on the merge seam: the enqueue through the
	 * dispatch, the refusal warning on a rejected ask, and the add line on the
	 * Message when the item took its place. The answer says what the cycle
	 * does next, the way the handoff's answer does.
	 */
	private async topUpPlaneActionAsk(
		intent: PlaneActionIntent,
		addedLine: string,
		refusedPrefix: string,
	): Promise<"added" | "refused" | "stopped"> {
		// The blocked attempt's hold (ADR 0077): the ticket's newest plane
		// action attempt blocked, and not every active source has re-read the
		// ticket since the attempt ran. The attempt's fire wrote the block's labels on
		// the source, and the position the projection derives stands on the
		// read the source last landed - the one the written labels outran - so
		// the position still offers the task the block already moved off. The
		// re-ask waits for the refresh that carries the written labels, the
		// same wait the cycle-end re-verify gate keeps. The hold is silent:
		// the re-ask on the refresh is the expected path, not a refusal to
		// report, and the walk moves on to its next candidate.
		if (this.state.planeAction.planeActionBlockedUnrefreshed(intent.ticketIdentity))
			return "refused";
		const result = await this.dispatchPlaneAction(intent);
		if (this.stopped) return "stopped";
		if (!result.ok) {
			// The stopped dispatch is the teardown's fact, not a merge refusal
			// (ADR 0051): the answer ends the walk without a line.
			if (result.reason === STOPPED_DISPATCH_REASON) return "stopped";
			// The standing-work refusal is a gate that stands, not a start that
			// could not run (issue #327): the merge the walk asked for is the one
			// already queued or already landing. It is held, not warned.
			if (result.stands !== undefined) {
				this.noteStandingWorkHold(result.stands, intent.ticketIdentity);
				return "refused";
			}
			this.onStatus("warning", `${refusedPrefix}: ${result.reason}`);
			return "refused";
		}
		this.onStatus("info", addedLine);
		return "added";
	}

	/**
	 * The position a settled turn's Next step stands on, with that step, or null
	 * when no continuation stands: the automatic rule answers `route` for the
	 * turn and names an unheld step (ADR 0051, ADR 0092), the step's ticket is
	 * still in the projection, and the operator has not judged the position out.
	 *
	 * The position may be open or awaiting (ADR 0072): a route onto the
	 * ticket's own new position finds its ticket open behind the wait the ask
	 * left it, and a cross-position route finds the position it names.
	 *
	 * The route itself is never re-derived here. `decideAwaiting` is the one
	 * rule both walks read, and `deriveNextStep` is the one derivation of its
	 * gates and of the channel the step runs on: the awaiting walk that closes
	 * what the machine resolves, and this walk that enqueues what it does not.
	 * The walk reads the step, never the row's own Suggested task type, so the
	 * two walks cannot disagree about whether the step is a Handoff or a Plane
	 * action.
	 *
	 * `projection` is the cycle's projection read, before the list rule.
	 */
	private continuationTarget(
		ticket: Ticket,
		projection: TicketProjection,
	): { position: Ticket; step: NextStep } | null {
		const completion = this.state.ticketWorkCycle.lastCompletion(ticket.identity);
		if (completion === null) return null;
		const outcome = completion.transition ?? null;
		// The decision on the turn decides whether the walk re-offers the route
		// it answers (ADR 0064, ADR 0072): an awaiting ticket's turn is
		// undecided, and an open ticket's newest settled turn records the
		// automatic route its ask ran - the decision stands at the ask, and a
		// drop or the operator's removal left the route unrun, so the walk
		// re-offers the same turn while the trace carries no removal mark and the
		// step's gates answer the rest. Every other decision holds the turn: the
		// route's position is in flight, and its state and handoff checks hold it
		// out. A marked trace is not re-offered.
		if (
			completion.decision !== null &&
			completion.decision !== "auto-handed-off" &&
			completion.decision !== "auto-merged"
		) {
			return null;
		}
		if (completion.decision !== null && outcome?.routeRemoved === true) return null;
		// The cycle's one projection read serves the rule and this walk's row:
		// the list rule withholds a covered ticket from the operator's view
		// (ADR 0042), and the add must still reach the position it starts on.
		const { decision, step } = this.decideAwaiting(completion, projection);
		if (decision !== "route" || step === null) return null;
		const position = projection.rowFor(step.ticketIdentity);
		if (position === undefined) return null;
		// The ignore gate (ADR 0060): the route starts an Agent on the position,
		// and the position is read from the projection before the list rule, so the
		// one gate predicate on the row this walk holds is what answers.
		if (automaticStartBlocked(position)) return null;
		// The queue's one-item-per-ticket rule is this cycle's own gate above:
		// the walk adds only into an empty queue, and the claim check at the ask
		// refuses the same ledger a second time (ADR 0051).
		return { position, step };
	}
}
