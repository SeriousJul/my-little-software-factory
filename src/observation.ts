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
 * 1. An in-flight ticket whose agent reports working runs. One whose agent
 *    reports done or idle settles: the pane's last output is captured into
 *    a completion trace, capped at the configured line count, and the
 *    ticket rests in awaiting.
 * 2. A pane herdr no longer lists is missing. With auto-handoff on the
 *    loop restarts the agent once per episode, or abandons the cycle when
 *    the ticket has used up its handoffs.
 * 3. Automatic completion decisions apply to awaiting tickets whose task
 *    type is auto-close: exactly one outgoing edge routes (while the
 *    parallel limit has room), any other edge count closes, and a route
 *    at the handoff limit degrades to close. Every other awaiting ticket
 *    waits for the operator.
 * 4. With auto-handoff on, each eligible open ticket - actionable, under
 *    both limits - is handed off with the configured defaults. The
 *    parallel count is the in-flight tickets whose agent was alive in the
 *    latest poll: a blocked agent holds a slot, a missing one does not.
 *
 * When herdr cannot be listed at all, the loop pauses and holds: the last
 * known facts stay, and the UI warns. Nothing is re-run blindly on
 * recovery: a cycle that cannot see its agents does not settle or restart
 * anything.
 */

import type { FactoryConfig, WorkflowEdge } from "./config.ts";
import { baseChoice, type HandoffChoice } from "./handoff.ts";
import { commandFailureText } from "./repo.ts";
import type { CommandRunner } from "./runner.ts";
import type { FactoryState, HandoffOrigin, HandoffTicket } from "./state.ts";

/** One agent herdr reports for a pane. */
export interface HerdrAgent {
	paneId: string;
	tabId: string;
	workspaceId: string;
	/** The agent kind herdr detected in the pane. */
	agent: string;
	status: string;
}

/** The normalized states the factory reasons about. */
export type AgentStatus = "working" | "done" | "idle" | "blocked" | "error" | "unknown";

/** The result of asking herdr for its agents. */
export type HerdrProbe = { kind: "ok"; agents: HerdrAgent[] } | { kind: "error"; reason: string };

/** The read-side of herdr the loop uses. Tests inject a fake here. */
export interface AgentReader {
	listAgents(): Promise<HerdrProbe>;
	/** The pane's last output in text format, capped and ANSI stripped. Null when it cannot be read. */
	readPane(paneId: string, lines: number): Promise<string | null>;
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
			agents.push({
				paneId: record.pane_id,
				tabId: typeof record.tab_id === "string" ? record.tab_id : "",
				workspaceId: typeof record.workspace_id === "string" ? record.workspace_id : "",
				agent: record.agent,
				status: typeof record.agent_status === "string" ? record.agent_status : "unknown",
			});
		}
		return { kind: "ok", agents };
	}

	async readPane(paneId: string, lines: number): Promise<string | null> {
		const result = await this.runner.run("herdr", [
			"agent",
			"read",
			paneId,
			"--lines",
			String(lines),
			"--format",
			"text",
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
		// Cap the capture client-side as well: the stored message must not
		// exceed the configured line count whatever the CLI returns.
		return stripAnsi(output).split("\n").slice(0, lines).join("\n");
	}
}

/**
 * Map a herdr agent status onto the factory's vocabulary.
 *
 * The set herdr reports is an open set, so anything unrecognized maps to
 * `unknown`, which settles nothing and fails nothing.
 */
export function normalizeAgentStatus(raw: string): AgentStatus {
	const value = raw.trim().toLowerCase();
	if (value === "working" || value === "busy" || value === "running") return "working";
	if (value === "done" || value === "complete" || value === "completed") return "done";
	if (value === "idle") return "idle";
	if (value === "blocked") return "blocked";
	if (value === "error" || value === "failed") return "error";
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
 * - `close`: the factory closes the cycle now (auto-close type with zero
 *   or multiple outgoing edges, or a route degraded at the handoff limit).
 * - `route`: an auto-close type's one-and-only edge hands off, while the
 *   parallel limit has room.
 * - `wait`: the ticket rests in awaiting. A route waits for a free slot;
 *   a non-auto-close type waits for the operator's decision.
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
	private readonly onChanged: () => void;
	private readonly onAgents?: (agents: readonly HerdrAgent[] | null) => void;
	private readonly onStatus: (kind: "info" | "warning" | "error", text: string) => void;
	private timer: NodeJS.Timeout | null = null;
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
		this.onChanged = options.onChanged;
		this.onAgents = options.onAgents;
		this.onStatus = options.onStatus;
	}

	/** Begin polling. The first cycle runs immediately. */
	start(): void {
		if (this.timer !== null) return;
		void this.safeCycle();
		this.timer = setInterval(() => {
			void this.safeCycle();
		}, this.intervalMs);
	}

	/** Run one cycle when one is not already running. Returns when it is done. */
	async tick(): Promise<void> {
		await this.safeCycle();
	}

	/** Stop polling. Safe to call more than once. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== null) {
			clearInterval(this.timer);
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
		if (this.holdingHerdrError) {
			this.holdingHerdrError = false;
			this.onStatus("info", "herdr is reachable again; the observation resumed");
			this.onChanged();
		}

		const autoOn = this.mode();
		const byPane = new Map<string, HerdrAgent>();
		for (const agent of probe.agents) byPane.set(agent.paneId, agent);

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

		let changed = false;
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
			if (status === "working" && this.state.markTicketRunning(ticket.ticketIdentity)) {
				changed = true;
			}
			if (status === "done" || status === "idle") {
				changed = (await this.settle(ticket, agent)) || changed;
				if (this.stopped) return;
			}
		}

		for (const ticket of this.state.ticketsByState(["awaiting"])) {
			changed = (await this.handleAwaiting(ticket, liveCount)) || changed;
			if (this.stopped) return;
		}

		// The count is what this poll saw alive, before the settles above:
		// a ticket that settled this cycle still holds its seat here. The
		// next poll no longer sees it in flight and frees the seat.
		if (autoOn) {
			changed = this.dispatchOpen(liveCount) || changed;
		}

		if (changed) this.onChanged();
		this.onAgents?.(probe.agents);
	}

	/** A settled turn: capture the message, rest the ticket in awaiting. */
	private async settle(
		ticket: {
			ticketIdentity: string;
			handoffAttemptId: string;
			taskType: string;
			agentType: string;
		},
		agent: HerdrAgent,
	): Promise<boolean> {
		const message =
			(await this.herdr.readPane(agent.paneId, this.config().completionMessageLines)) ?? "";
		if (this.stopped) return true;
		this.state.settleTurn({
			ticketIdentity: ticket.ticketIdentity,
			handoffId: ticket.handoffAttemptId,
			taskType: ticket.taskType,
			agentType: ticket.agentType,
			message,
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
	 * The decision is recorded only after a successful claim: a route that
	 * cannot start leaves the pending trace for the next cycle instead of
	 * holding a decision the handoff never made.
	 */
	private async handleAwaiting(ticket: HandoffTicket, liveCount: number): Promise<boolean> {
		const config = this.config();
		const handoffCount = this.state.handoffCount(ticket.ticketIdentity);
		const decision = this.decideAwaiting(ticket.taskType, liveCount, handoffCount);
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
		const result = await this.dispatch({
			origin: "workflow",
			ticketIdentity: ticket.ticketIdentity,
			choice: baseChoice(
				edge.agent ?? config.defaultAgent,
				edge.environment ?? config.defaultEnvironment,
				edge.to[0],
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
	 * The automatic completion rule: it applies only to auto-close types.
	 *
	 * A route at the handoff limit degrades to close: the ticket returns
	 * to open wearing the handoff-limit marker, where the operator can
	 * still hand it off manually. Exactly one outgoing edge routes while
	 * the parallel limit has room; a full limit waits in awaiting until a
	 * slot frees. Any other edge count closes. A non-auto-close type
	 * always waits for the operator.
	 */
	decideAwaiting(taskType: string, liveCount: number, handoffCount: number): AwaitingDecision {
		const config = this.config();
		const task = config.taskTypes[taskType];
		if (task?.autoClose !== true) return "wait";
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
			const choice = baseChoice(
				config.defaultAgent,
				config.defaultEnvironment,
				ticket.suggestedTaskType,
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
