/**
 * The shared fixture of the observation suite (issue #429, ADR 0152).
 *
 * It wires the cycle the way the App does: the real Handoff dispatch module on
 * the fake Command runner, the real merged Agent reader, the real temp state
 * file, and the one pinned virtual clock the state file, the cycle, and the
 * runner's held commands all share. The cycle's timers stand on the virtual
 * clock, so a test that moves the clock moves the grid with it: the cycles
 * land where the grid names them, independent of the machine's pace.
 */

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHostResolution } from "../src/agent-host.ts";
import type { FactoryConfig } from "../src/config.ts";
import {
	createHandoffDispatch,
	type HandoffDispatch,
	type HandoffIntent,
	type PlaneActionIntent,
} from "../src/handoff-dispatch.ts";
import type { Logger } from "../src/logging.ts";
import {
	MergedAgentReader,
	ObservationCoordinator,
	type ObservationReport,
} from "../src/observation.ts";
import { TICKET_SEAT_STATES } from "../src/parallel.ts";
import type { RefreshClock } from "../src/refresh.ts";
import { RefreshCoordinator } from "../src/refresh.ts";
import type { CommandRunner } from "../src/runner.ts";
import { type SessionRecordLookup, UNAVAILABLE_SESSION_RECORD } from "../src/session-record.ts";
import type { HandoffTicket } from "../src/state/handoff.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { TicketSource } from "../src/ticket-source.ts";
import type { SessionTurnRead } from "../src/turn-log.ts";
import { fireTransition, type RefiredSkip, refireRecordedSkips } from "../src/workflow.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	fetchedTicket,
	fetchSuccess,
	RUN_AGENT_HOST,
	RUN_AGENT_HOST_MARKS,
} from "./fact-fixtures.ts";
import {
	agentListJson,
	FakeRunner,
	type ListedAgent,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
	worktreeListJson,
} from "./fake-runner.ts";
import { type RecordedLine, recordLogger } from "./record-logger.ts";

/**
 * The fixture's one time seam (issue #429, ADR 0152): the state file, the
 * cycle's grid, and the runner's held commands answer from this clock. Time
 * moves only when a test advances it.
 */
export class VirtualClock implements RefreshClock {
	/** The instant the fixture stands the run on. */
	static readonly epoch = Date.parse("2026-08-31T11:00:00Z");

	private current = VirtualClock.epoch;
	private seq = 0;
	private readonly live = new Map<
		object,
		{ handle: object; due: number; seq: number; timerIndex: number | null; cb: () => void }
	>();
	/**
	 * The timer history a test reads: every timer the cycle armed, the delay
	 * it stood on, and the instant it fired. A timer that ran past its due
	 * instant fires on the advance that reached it, so the fired instant is
	 * the moment the clock moved past it, not the due instant itself.
	 */
	readonly clockTimers: Array<{
		registeredAt: number;
		delay: number;
		due: number;
		firedAt: number | null;
	}> = [];
	/** The command holds the fake runner stood on this clock, the same shape. */
	readonly waits: Array<{
		registeredAt: number;
		delay: number;
		due: number;
		answeredAt: number | null;
	}> = [];

	now(): number {
		return this.current;
	}

	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
		const handle = {};
		const due = this.current + milliseconds;
		const index = this.clockTimers.length;
		this.clockTimers.push({ registeredAt: this.current, delay: milliseconds, due, firedAt: null });
		if (due <= this.current) {
			queueMicrotask(() => {
				this.clockTimers[index].firedAt = this.current;
				callback();
			});
			return handle as unknown as ReturnType<typeof setTimeout>;
		}
		this.live.set(handle, { handle, due, seq: this.seq++, timerIndex: index, cb: callback });
		return handle as unknown as ReturnType<typeof setTimeout>;
	}

	clearTimeout(handle: ReturnType<typeof setTimeout>): void {
		this.live.delete(handle as unknown as object);
	}

	/** A command hold the runner stands on this clock: it settles when the clock passes the deadline. */
	wait(milliseconds: number): Promise<void> {
		const deadline = this.current + milliseconds;
		if (deadline <= this.current) {
			return new Promise((resolve) => queueMicrotask(resolve));
		}
		const entry = {
			registeredAt: this.current,
			delay: milliseconds,
			due: deadline,
			answeredAt: null as number | null,
		};
		const index = this.waits.length;
		this.waits.push(entry);
		return new Promise((resolve) => {
			const handle = {};
			this.live.set(handle, {
				handle,
				due: deadline,
				seq: this.seq++,
				timerIndex: null,
				cb: () => {
					this.waits[index].answeredAt = this.current;
					resolve();
				},
			});
		});
	}

	/**
	 * Move the clock forward by milliseconds, firing every timer whose due
	 * instant the move reaches, in due order, at its due instant. The clock
	 * steps to each due instant before it fires, so a command a fired timer
	 * starts keeps its own virtual time, and a timer a fired callback arms
	 * that is already due fires within the same advance, the way a past-due
	 * timer fires at once.
	 */
	advance(milliseconds: number): void {
		const target = this.current + milliseconds;
		for (;;) {
			const due = [...this.live.values()]
				.filter((entry) => entry.due <= target)
				.sort((a, b) => a.due - b.due || a.seq - b.seq);
			if (due.length === 0) break;
			for (const entry of due) {
				if (entry.due > this.current) this.current = entry.due;
				this.live.delete(entry.handle);
				if (entry.timerIndex !== null) this.clockTimers[entry.timerIndex].firedAt = this.current;
				entry.cb();
			}
		}
		this.current = target;
	}
}

/**
 * The herdr stubs the default start needs: a live-worktree build at the
 * checkout the module's repository resolution lands on.
 */
function stubDefaultHerdr(runner: FakeRunner, checkout: string): void {
	runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["worktree", "list", "--cwd", checkout], { stdout: worktreeListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson("ws-fixture", "pane-root"),
	});
	runner.set(
		"herdr",
		["tab", "create", "--workspace", "ws-fixture", "--cwd", checkout, "--no-focus"],
		{
			stdout: tabCreateJson("pane-agent", "tab-agent"),
		},
	);
	// The answer any command without a named response gives: a quiet success.
	runner.setDefault({ code: 0, stdout: "" });
}

/** The handoff the in-flight seed settles: the ticket's pane, on the herdr host. */
const bootHandoffChoice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement" as const,
	host: "herdr" as const,
	model: "",
	thinking: "",
	contextWindow: "",
};

export interface RigOptions {
	/** The agents the herdr half lists; absent: the herdr half lists none. */
	agents?: ListedAgent[];
	/** The host the run resolved: the herdr host by default. */
	agentHost?: AgentHostResolution;
	/** The config over the base the suite builds. */
	config?: Partial<FactoryConfig>;
	/** The auto-handoff mode the state file starts with. */
	autoOn?: boolean;
	/** The startup grace a fresh handoff's idle agent waits out. */
	startupGraceMs?: number;
	/** The poll override the cycle derives its interval from; absent: the config. */
	pollIntervalMs?: number;
	/**
	 * The Parallel limit seats held now, as the module's pickup reads them.
	 * Absent: the cap itself, so the pickup takes no item and the queue
	 * holds, the way the suite's walks wait on a free seat.
	 */
	seatCount?: () => number;
	/** The settled turn's log reader; absent: no session to read. */
	turnLogs?: (
		kind: string,
		sessionId: string,
		startedAt: string | null,
	) => Promise<SessionTurnRead>;
	/**
	 * The derived session record lookup on the host that reports none (ADR
	 * 0144); absent: the unavailable lookup, so the fixture's settle never
	 * reads the operator's real session home.
	 */
	sessionRecord?: SessionRecordLookup;
	/** The cycle's record lines; absent: the fixture's own record. */
	log?: Logger;
	/** The transition fire the cycle settles a completed turn with; absent: the real fire. */
	fireCompleted?: (
		ticket: HandoffTicket,
	) => Promise<import("../src/config.ts").TransitionOutcome | null>;
	/** The recorded-skip re-fire the cycle sweeps; absent: the real sweep. */
	refireRecordedSkips?: () => Promise<RefiredSkip[]>;
	/** The cycle end the app re-reads the ticket's sources on; absent: none. */
	onCycleEnd?: (identity: string) => void;
	/** The completed cycle's report, the seam's one fact about the cycle. */
	onReport?: (report: ObservationReport) => void;
	/**
	 * The ticket sources the refresh coordinator feeds; absent: no
	 * coordinator, and the coordinator's start runs its first cycle at once.
	 * Present: the fixture starts the coordinator at boot, the way the shell
	 * does, and the coordinator holds its first cycle until every source's
	 * first fetch settles (issue #431, ADR 0154), the way the App holds it.
	 * Each settlement also ticks the coordinator, the way the shell's does.
	 */
	refreshSources?: readonly TicketSource[];
	/**
	 * The identities the state's boot read holds in flight, the way a run
	 * that booted on a previous run's handoff does (issue #431). The fixture
	 * settles the handoff before the refresh coordinator's first read resets
	 * the source facts, so the claim reads the boot read's source data.
	 */
	inFlightAtBoot?: string[];
	/** A Consultation the shared monitor names for attention. */
	onConsultationAttention?: (consultationId: string) => void;
	/** The loop's own calls and dispatches in order. */
	order?: string[];
	/** A pre-stubbed herdr; absent: the fixture's default stubs on a fresh runner. */
	runner?: FakeRunner;
	/** The home the fixture's checkout resolves to; absent: a fresh temp directory. */
	home?: string;
}

export interface Rig {
	/** The state file the run holds: a real temp file on the virtual clock. */
	state: FactoryState;
	/** The fake Command runner the module and the reader run their commands on. */
	runner: FakeRunner;
	/** The virtual clock the state file, the cycle, and the runner's holds share. */
	clock: VirtualClock;
	/** The real dispatch module the fixture wires the cycle to. */
	dispatch: HandoffDispatch;
	coordinator: ObservationCoordinator;
	/**
	 * The refresh coordinator the rig runs the load on, started at boot; absent
	 * when the rig names no sources.
	 */
	refresh: RefreshCoordinator | undefined;
	config: FactoryConfig;
	/** The home the fixture holds. */
	home: string;
	/**
	 * The checkout the module's repository resolution lands on: the clone
	 * path of the fixture's repository under the home's src directory.
	 */
	checkout: string;
	/** The Handoff asks the cycle crossed, in order. */
	intents: HandoffIntent[];
	/** The plane action asks the cycle crossed, in order. */
	planeAsks: PlaneActionIntent[];
	/** The Close cleanups the cycle asked for, in order. */
	cleanups: Array<{
		handoffId: string;
		tabId: string | null;
		workspaceId: string | null;
		end: "closed" | "abandoned";
	}>;
	/** The tickets a cycle ended, in order. */
	cycleEnds: string[];
	/**
	 * The reports the seam handed over, in order. The identity rule stands on
	 * the object itself (issue #422, ADR 0146): a quiet cycle lands the same
	 * object as the cycle before it, so the test compares the objects, not
	 * their copies.
	 */
	reports: ObservationReport[];
	/** The loop's own calls and dispatches in order. */
	order: string[];
	/** The Message line facts the module and the cycle report, in order. */
	statuses: Array<{ kind: "info" | "warning" | "error"; text: string }>;
	/** The cycle's record lines, on the log the test named or the fixture's. */
	lines: RecordedLine[];
	/** The module's record lines, on the fixture's own record. */
	moduleLines: RecordedLine[];
	/** The virtual instant each command the runner ran was asked, in ask order. */
	commandTimes: number[];
	/**
	 * Move the virtual clock forward by milliseconds, then wait until the
	 * module's in-flight work settles into the ledger. The background pickup
	 * pass an accepted ask fires runs on behind the ask, on the machine's own
	 * time, so the settle lands a few turns after the ask.
	 */
	advance: (ms: number) => Promise<void>;
	/** Move the auto-handoff mode the way the operator's key does. */
	setAutoMode: (next: boolean) => void;
	/** Move the agents the herdr half lists. */
	setAgents: (next: ListedAgent[]) => void;
	/** Wait until the module's in-flight work settles into the ledger. */
	settle: () => Promise<void>;
	/** Close the state file and take the temp directory with it. */
	close: () => Promise<void>;
}

/** The temp directories the open fixtures hold, cleaned when the run ends. */
const live: Set<string> = new Set();
function track(dir: string): void {
	live.add(dir);
}
function untrack(dir: string): void {
	live.delete(dir);
}
afterEach(() => {
	for (const dir of live) rmSync(dir, { recursive: true, force: true });
	live.clear();
});

/**
 * Wait until the module's in-flight work settles into the ledger. A held
 * command the runner holds forever - an Agent wait on an agent that keeps
 * working - settles nothing, so the settle stands on the commands asked,
 * the commands answered, and the ledger's open attempts, in one signature
 * that is stable when the work is done.
 */
async function drain(state: FactoryState, runner: FakeRunner): Promise<void> {
	const signature = (): string =>
		`${runner.calls.length}:${runner.settledCommands().length}:${
			state.handoff.openAttemptTickets().length
		}`;
	const end = Date.now() + 5_000;
	let last = "";
	for (;;) {
		// The first sleep flushes the continuations a clock move left queued:
		// a command that settled on the move answers its cycle's rest there.
		await new Promise((resolve) => setTimeout(resolve, 1));
		const next = signature();
		if (next === last) return;
		last = next;
		if (Date.now() > end) throw new Error("the fixture's work never settled");
	}
}

/**
 * Build one fixture: the real module, the real reader, the real state file,
 * on the shared base config the suite builds.
 */
/**
 * The ticket the previous run handed off: the state's boot read stands it
 * in flight, and the plane boots on that read.
 */
function seedInFlightOnBoot(state: FactoryState, identities: readonly string[]): void {
	for (const ticketIdentity of identities) {
		const claim = state.handoff.claimHandoff(ticketIdentity, bootHandoffChoice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-implement",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
	}
}

/**
 * The rig's settle stands on the module's work and the settlement ticks a
 * settlement fires: a tick's start settles into the ledger, and the settle
 * loops until neither stands work.
 */
async function settleSettlementTicks(
	drain: () => Promise<void>,
	ticks: ReadonlySet<Promise<void>>,
): Promise<void> {
	await drain();
	for (;;) {
		const pending = [...ticks];
		if (pending.length === 0) return;
		await Promise.allSettled(pending);
		await drain();
	}
}

/**
 * The per-settlement callback the shell fires: the rig owns the fire-and-
 * forget tick it starts, so the rig's settle and close stand on it settling,
 * the way they stand on the commands asked.
 */
function refreshTickCallback(
	coordinator: ObservationCoordinator,
	ticks: Set<Promise<void>>,
): () => void {
	return () => {
		const tick = coordinator.tick();
		ticks.add(tick);
		void tick.finally(() => ticks.delete(tick));
	};
}

/**
 * The tick the rig's coordinator answers: the tick's start settles into the
 * ledger before the tick's caller reads the state, and the starts a tick
 * fired settle there too, so the test stands on the work done.
 */
function wrapCoordinator(
	inner: ObservationCoordinator,
	state: FactoryState,
	runner: FakeRunner,
): ObservationCoordinator {
	return {
		tick: async (): Promise<void> => {
			const before = new Set(state.handoff.openAttemptTickets());
			await inner.tick();
			await drain(state, runner);
			const end = Date.now() + 5_000;
			for (;;) {
				const open = state.handoff.openAttemptTickets().filter((id) => !before.has(id));
				if (open.length === 0) return;
				if (Date.now() > end) throw new Error("the module's starts never settled");
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		},
		start: inner.start.bind(inner),
		stop: inner.stop.bind(inner),
		decideAwaiting: inner.decideAwaiting.bind(inner),
		lastAgents: inner.lastAgents.bind(inner),
	} as unknown as ObservationCoordinator;
}

/**
 * The refresh coordinator the fixture's plane runs, when the rig names its
 * sources: it starts on the build, the way the shell starts it.
 */
function startRefreshCoordinator(
	sources: readonly TicketSource[] | undefined,
	state: FactoryState,
	changed: () => void,
	clock: VirtualClock,
): RefreshCoordinator | undefined {
	if (sources === undefined) return undefined;
	const coordinator = new RefreshCoordinator(sources, state, changed, { clock });
	coordinator.start();
	return coordinator;
}

export function rig(options: RigOptions): Rig {
	const clock = new VirtualClock();
	const config: FactoryConfig = { ...BASE_CONFIG, ...options.config };
	const agentHost = options.agentHost ?? RUN_AGENT_HOST;
	const home = options.home ?? mkdtempSync(join(tmpdir(), "observation-fixture-"));
	// The config maps no repository, so the resolution lands on the clone
	// path of the fixture's own repository under the home's src directory.
	const checkout = join(home, "src", "factory");
	const runner = options.runner ?? new FakeRunner();
	if (options.runner === undefined) stubDefaultHerdr(runner, checkout);
	// Every command the run asks stands on the virtual clock, so a command a
	// test holds by a delay settles when the test moves the clock.
	runner.adoptVirtualClock(clock);
	// The time-tagged runner: every command a test sees, asked at the virtual
	// instant the runner took it. The reader, the dispatch, and the fire all
	// run through it, so the record is the run's one outside measure of when
	// each command was asked.
	const commandTimes: number[] = [];
	const timed: CommandRunner = {
		run: (command, args, runOptions) => {
			commandTimes.push(clock.now());
			return runner.run(command, args, runOptions);
		},
		listModels: (kind) => runner.listModels(kind),
	};
	const state = openFactoryState(join(home, "state.sqlite"), () => clock.now());
	state.handoff.setAutoHandoffMode(options.autoOn ?? false);
	// The fixture's default feed: the one open issue the tests fetch over.
	// A test that wants another feed applies its own fetch, the way a
	// refresh would.
	const issuesSource = { name: "issues", kind: "github-issues" as const };
	state.sourceFact.initializeSources([issuesSource]);
	state.sourceFact.applyFetch(
		issuesSource,
		fetchSuccess([fetchedTicket({ identity: "github:github.com:I_5" })]),
	);
	// The ticket the previous run handed off: the state's boot read stands
	// it in flight, and the plane boots on that read.
	if (options.inFlightAtBoot !== undefined) seedInFlightOnBoot(state, options.inFlightAtBoot);

	// The load's one fact the cycle waits on (issue #431, ADR 0154): the
	// refresh coordinator's initial-load-settled promise, wired the way the
	// App wires it, so the fixture's plane holds its first probe until every
	// source's first fetch settles. The per-settlement callback stands down
	// while the load stands, then ticks the coordinator on each settlement,
	// the way the shell's does.
	const refreshTicks = new Set<Promise<void>>();
	let refreshChanged: () => void = () => undefined;
	const refresh = startRefreshCoordinator(
		options.refreshSources,
		state,
		() => refreshChanged(),
		clock,
	);

	const intents: HandoffIntent[] = [];
	const planeAsks: PlaneActionIntent[] = [];
	const cleanups: Rig["cleanups"] = [];
	const cycleEnds: string[] = [];
	const reports: ObservationReport[] = [];
	const order = options.order ?? [];
	const statuses: Rig["statuses"] = [];
	const lines: RecordedLine[] = [];
	const moduleLines: RecordedLine[] = [];

	// The module's reports land on the fixture's Message record, beside the
	// cycle's: one order, the way the App holds it.
	const report = (kind: "info" | "warning" | "error") => (text: string) => {
		statuses.push({ kind, text });
	};

	const dispatch = createHandoffDispatch({
		state,
		runner: timed,
		config: () => config,
		seatCount: options.seatCount ?? (() => config.maxParallelAgents),
		home,
		agentHost,
		agentHostMarks: RUN_AGENT_HOST_MARKS,
		working: () => undefined,
		warning: report("warning"),
		error: report("error"),
		faultWarning: report("warning"),
		faultError: report("error"),
		notice: (text, severity) => {
			statuses.push({ kind: severity === "info" ? "info" : "warning", text });
		},
		clearWorking: () => undefined,
		refresh: () => undefined,
		starting: () => undefined,
		log: recordLogger(moduleLines),
	});

	// The names the plane's herdr-core Agents hold (issue #410, ADR 0142),
	// the bound the merged reader's batch stands on: the in-flight Tickets'
	// and Consultations' recorded names on the herdr-core host, the way the
	// App derives them.
	const coreTerminalNames = (): string[] => {
		const names: string[] = [];
		for (const ticket of state.ticketWorkCycle.ticketsByState(TICKET_SEAT_STATES))
			if (ticket.host === "herdr-core" && ticket.paneId !== null) names.push(ticket.paneId);
		for (const consultation of state.consultationRecord.consultationsByState([
			"opening",
			"working",
			"awaiting-response",
			"closing",
		]))
			if (consultation.host === "herdr-core" && consultation.paneId !== null)
				names.push(consultation.paneId);
		return names;
	};
	const reader = new MergedAgentReader({
		runner: timed,
		runHost: agentHost.host,
		coreNames: coreTerminalNames,
		hostOf: () => agentHost.host,
	});

	const innerCoordinator = new ObservationCoordinator({
		state,
		herdr: reader,
		config: () => config,
		agentHost,
		// The cycle crosses the module through the shared port; the fixture
		// records the asks it crosses, then lets the module run them.
		dispatch: {
			dispatch: async (intent: HandoffIntent) => {
				order.push(`dispatch:${intent.origin}`);
				intents.push(intent);
				return dispatch.dispatch(intent);
			},
			dispatchPlaneAction: async (intent: PlaneActionIntent) => {
				order.push(`dispatch-plane-action:${intent.origin}`);
				planeAsks.push(intent);
				return dispatch.dispatchPlaneAction(intent);
			},
			planeActionRunInFlight: (ticketIdentity) => dispatch.planeActionRunInFlight(ticketIdentity),
			pickupWorkQueue: async () => {
				order.push("pickup");
				return dispatch.pickupWorkQueue();
			},
			closeCleanup: async (identity, handoff, end) => {
				cleanups.push({
					handoffId: handoff.handoffId,
					tabId: handoff.tabId,
					workspaceId: handoff.workspaceId,
					end,
				});
				return dispatch.closeCleanup(identity, handoff, end);
			},
		},
		onCycleEnd: (identity) => {
			cycleEnds.push(identity);
			options.onCycleEnd?.(identity);
		},
		clock,
		pollIntervalMs: options.pollIntervalMs,
		startupGraceMs: options.startupGraceMs,
		initialLoadSettled: refresh?.initialLoadSettled,
		onReport: (report) => {
			reports.push(report);
			options.onReport?.(report);
		},
		onConsultationAttention: options.onConsultationAttention,
		log: options.log ?? recordLogger(lines),
		turnLogs: {
			read: options.turnLogs ?? (async () => ({ kind: "unavailable" })),
		},
		sessionRecord: options.sessionRecord ?? UNAVAILABLE_SESSION_RECORD,
		fireCompleted:
			options.fireCompleted ??
			((ticket) =>
				fireTransition({
					config,
					state,
					runner: timed,
					ticketIdentity: ticket.ticketIdentity,
					taskType: ticket.taskType,
				})),
		refireRecordedSkips:
			options.refireRecordedSkips ?? (() => refireRecordedSkips({ config, state, runner: timed })),
		onStatus: (kind, text) => {
			statuses.push({ kind, text });
		},
	});

	if (options.agents !== undefined) {
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson(options.agents) });
	}

	// The cycle's own tick, with the module's background pickup pass settled
	// before the tick answers: the pass an accepted ask fires runs on behind
	// the ask, on the machine's own time, so the settle lands a few turns
	// after the ask. The snapshot before the tick keeps the wait to the
	// starts the tick itself fired, so a claim a test planted stands for its
	// own scenario.
	const coordinator = wrapCoordinator(innerCoordinator, state, runner);

	if (refresh !== undefined) {
		refreshChanged = refreshTickCallback(coordinator, refreshTicks);
	}

	track(home);

	return {
		state,
		runner,
		clock,
		dispatch,
		coordinator,
		refresh,
		config,
		home,
		checkout,
		intents,
		planeAsks,
		cleanups,
		cycleEnds,
		reports,
		order,
		statuses,
		lines,
		moduleLines,
		commandTimes,
		advance: async (ms: number) => {
			clock.advance(ms);
			await settleSettlementTicks(() => drain(state, runner), refreshTicks);
		},
		setAutoMode: (next: boolean) => {
			state.handoff.setAutoHandoffMode(next);
		},
		setAgents: (next: ListedAgent[]) => {
			runner.set("herdr", ["agent", "list"], { stdout: agentListJson(next) });
		},
		settle: () => settleSettlementTicks(() => drain(state, runner), refreshTicks),
		close: () => {
			// A settlement tick that the test never settled stands down before
			// the state closes: it must not answer into the closed ledger.
			return Promise.allSettled([...refreshTicks]).then(() => {
				state.close();
				rmSync(home, { recursive: true, force: true });
				untrack(home);
			});
		},
	};
}
