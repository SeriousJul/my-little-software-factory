/**
 * The shared fixture of the observation suite (issue #364).
 *
 * It wires the cycle the way the App does: the real Handoff dispatch module on
 * a fake Command runner, a real temp state file, the one pinned clock the
 * state file and the cycle share, and the real transition fire and re-fire.
 * The mirrored production rules the suite's old rig held - the enqueue at the
 * ask, the claim, the start report, the refusal - are gone: the module owns
 * them, and the fixture only records the calls the cycle crosses and the
 * lines the module and the cycle leave.
 */
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "bun:test";
import type { FactoryConfig, TransitionOutcome } from "../src/config.ts";
import type { HandoffIntent, PlaneActionIntent } from "../src/handoff-dispatch.ts";
import { createHandoffDispatch, type HandoffDispatch } from "../src/handoff-dispatch.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import { NOOP_LOGGER, type Logger } from "../src/logging.ts";
import {
	type AgentReader,
	type AgentWaitResult,
	ObservationCoordinator,
	stripAnsi,
	type TurnLogSource,
} from "../src/observation.ts";
import type { HandoffTicket } from "../src/state/handoff.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { SessionTurnRead } from "../src/turn-log.ts";
import {
	type RefiredSkip,
	fireTransition,
	refireRecordedSkips,
} from "../src/workflow.ts";
import {
	FakeRunner,
	agentListJson,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
	worktreeListJson,
} from "./fake-runner.ts";
import type { RecordedLine } from "./record-logger.ts";
import { recordLogger } from "./record-logger.ts";

/** The fixture's one time seam: the state file and the cycle answer from it. */
const PINNED_EPOCH = Date.parse("2026-08-31T11:00:00Z");

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
	runner.set("herdr", ["tab", "create", "--workspace", "ws-fixture", "--cwd", checkout, "--no-focus"], {
		stdout: tabCreateJson("pane-agent", "tab-agent"),
	});
	// The answer any command without a named response gives: a quiet success.
	runner.setDefault({ code: 0, stdout: "" });
}

export interface RigOptions {
	/** The agents the probe lists, or a function that answers the probe itself. */
	agents?: HerdrAgent[] | (() => HerdrAgent[]);
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
	/** The pane output the reader answers, ANSI stripped. */
	readPane?: (paneId: string, lines: number) => Promise<string | null>;
	/** The wake wait the reader answers; absent: the poll-only standing. */
	waitAgent?: (target: string, budgetMs: number) => Promise<AgentWaitResult>;
	/** The settled turn's log reader; absent: no session to read. */
	turnLogs?: (kind: string, sessionId: string, startedAt: string | null) => Promise<SessionTurnRead>;
	/** The cycle's record lines; absent: the fixture's own record. */
	log?: Logger;
	/** The transition fire the cycle settles a completed turn with; absent: the real fire. */
	fireCompleted?: (ticket: HandoffTicket) => Promise<TransitionOutcome | null>;
	/** The recorded-skip re-fire the cycle sweeps; absent: the real sweep. */
	refireRecordedSkips?: () => Promise<RefiredSkip[]>;
	/** The cycle end the app re-reads the ticket's sources on; absent: none. */
	onCycleEnd?: (identity: string) => void;
	/** The agent list of a completed cycle, on every cycle. */
	onAgents?: (agents: readonly HerdrAgent[] | null) => void;
	/** A Consultation the shared monitor names for attention. */
	onConsultationAttention?: (consultationId: string) => void;
	/** The loop's own calls and dispatches in order. */
	order?: string[];
	/** A pre-stubbed herdr; absent: the fixture's default stubs on a fresh runner. */
	runner?: FakeRunner;
	/** The home the fixture's checkout resolves to; absent: a fresh temp directory. */
	home?: string;
}

/**
 * Wait until the module's in-flight work settles into the ledger. The
 * background pickup pass an accepted ask fires runs on behind the ask, and
 * the state file's sqlite yields to the loop, so the settle lands a few
 * turns after the ask. A test that reads the settled ledger waits here, on
 * real time and a bounded budget.
 */
export const settleFor = async (state: FactoryState): Promise<void> => {
	const end = Date.now() + 5_000;
	while (state.handoff.openAttemptTickets().length > 0) {
		if (Date.now() > end) throw new Error("the module's starts never settled");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
};

export interface Rig {
	/** The state file the run holds: a real temp file on the pinned clock. */
	state: FactoryState;
	/** The fake Command runner the module runs its commands on. */
	runner: FakeRunner;
	/** The real dispatch module the fixture wires the cycle to. */
	dispatch: HandoffDispatch;
	coordinator: ObservationCoordinator;
	config: FactoryConfig;
	/** The Home the fixture holds. */
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
	/** The loop's own calls and dispatches in order. */
	order: string[];
	/** The Message line facts the module and the cycle report, in order. */
	statuses: Array<{ kind: "info" | "warning" | "error"; text: string }>;
	/** The cycle's record lines, on the log the test named or the fixture's. */
	lines: RecordedLine[];
	/** The module's record lines, on the fixture's own record. */
	moduleLines: RecordedLine[];
	/** Move the pinned clock forward by milliseconds. */
	advance: (ms: number) => void;
	/** Move the auto-handoff mode the way the operator's key does. */
	setAutoMode: (next: boolean) => void;
	/** Move the agents the probe lists. */
	setAgents: (next: HerdrAgent[]) => void;
	/**
	 * Wait until the module's in-flight work settles into the ledger. The
	 * background pickup pass an accepted ask fires runs on behind the ask, and
	 * the state file's sqlite yields to the loop, so the settle lands a few
	 * turns after the ask. A test that reads the settled ledger waits here, on
	 * real time and a bounded budget.
	 */
	settle: () => Promise<void>;
	/** Close the state file and take the temp directory with it. */
	close: () => void;
}

/** Build one fixture: the real module, the real state file, the pinned clock. */
export function rig(
	options: RigOptions,
	baseConfig: FactoryConfig,
): Rig {
	const nowMs = { current: PINNED_EPOCH };
	const agents =
		typeof options.agents === "function" ? [] : [...(options.agents ?? [])];
	// A function form answers the probe itself, so a test can count its calls
	// the way the wake tests do.
	const agentsFn = typeof options.agents === "function" ? options.agents : null;
	const probeAgents = (): HerdrAgent[] => (agentsFn !== null ? agentsFn() : agents);
	const config: FactoryConfig = { ...baseConfig, ...options.config };
	const home = options.home ?? mkdtempSync(join(tmpdir(), "observation-fixture-"));
	// The config maps no repository, so the resolution lands on the clone
	// path of the fixture's own repository under the home's src directory.
	const checkout = join(home, "src", "factory");
	const state = openFactoryState(join(home, "state.sqlite"), () => nowMs.current);
	state.handoff.setAutoHandoffMode(options.autoOn ?? false);
	// The fixture's default feed: the one open issue the tests fetch over.
	// A test that wants another feed applies its own fetch, the way a
	// refresh would.
	const issuesSource = { name: "issues", kind: "github-issues" as const };
	state.sourceFact.initializeSources([issuesSource]);
	state.sourceFact.applyFetch(issuesSource, {
		status: "success",
		fetchedAt: "2026-08-31T10:01:00Z",
		tickets: [
			{
				identity: "github:github.com:I_5",
				sourceKind: "github-issue",
				externalKey: "#5",
				sourceState: "open",
				url: "https://github.com/acme/factory/issues/5",
				title: "Persist source facts",
				description: "Keep state independent from GitHub.",
				labels: ["ready-for-agent"],
				externalUpdatedAt: "2026-08-31T10:00:00Z",
				repository: {
					identity: "github.com/acme/factory",
					displayName: "acme/factory",
					cloneUrl: "https://github.com/acme/factory.git",
				},
				attributes: {},
			},
		],
	});
	const runner = options.runner ?? new FakeRunner();
	if (options.runner === undefined) stubDefaultHerdr(runner, checkout);

	const intents: HandoffIntent[] = [];
	const planeAsks: PlaneActionIntent[] = [];
	const cleanups: Rig["cleanups"] = [];
	const cycleEnds: string[] = [];
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
		runner,
		config: () => config,
		seatCount: options.seatCount ?? (() => config.maxParallelAgents),
		home,
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

	const reader: AgentReader = {
		listAgents: async () => ({ kind: "ok", agents: probeAgents() }),
		// The AgentReader contract: pane output comes back ANSI stripped.
		readPane:
			options.readPane ??
			(async (paneId) => stripAnsi(`\u001b[1mDone.\u001b[0m message of ${paneId}`)),
		// Absent by default: the loop the tests drive is the poll-only standing,
		// and the wake tests opt in with their own wait.
		...(options.waitAgent === undefined ? {} : { waitAgent: options.waitAgent }),
	};

	const innerCoordinator = new ObservationCoordinator({
		state,
		herdr: reader,
		config: () => config,
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
			planeActionRunInFlight: (ticketIdentity) =>
				dispatch.planeActionRunInFlight(ticketIdentity),
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
		clock: {
			now: () => nowMs.current,
			setTimeout,
			clearTimeout,
		},
		pollIntervalMs: options.pollIntervalMs,
		startupGraceMs: options.startupGraceMs,
		onChanged: () => undefined,
		onAgents: options.onAgents,
		onConsultationAttention: options.onConsultationAttention,
		log: options.log ?? recordLogger(lines),
		turnLogs: {
			read: options.turnLogs ?? (async () => ({ kind: "unavailable" })),
		},
		fireCompleted: options.fireCompleted ??
			((ticket) =>
				fireTransition({
					config,
					state,
					runner,
					ticketIdentity: ticket.ticketIdentity,
					taskType: ticket.taskType,
				})),
		refireRecordedSkips: options.refireRecordedSkips ??
			(() => refireRecordedSkips({ config, state, runner })),
		onStatus: (kind, text) => {
			statuses.push({ kind, text });
		},
	});

	// The cycle's own tick, with the module's background pickup pass settled
	// before the tick answers: the pass an accepted ask fires runs on behind
	// the ask, and the state file's sqlite yields to the loop, so the settle
	// lands a few turns after the ask. The snapshot before the tick keeps the
	// wait to the starts the tick itself fired, so a claim a test planted
	// stands for its own scenario.
	const coordinator = {
		tick: async (): Promise<void> => {
			const before = new Set(state.handoff.openAttemptTickets());
			await innerCoordinator.tick();
			const end = Date.now() + 5_000;
			for (;;) {
				const open = state.handoff
					.openAttemptTickets()
					.filter((id) => !before.has(id));
				if (open.length === 0) return;
				if (Date.now() > end) throw new Error("the module's starts never settled");
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		},
		start: innerCoordinator.start.bind(innerCoordinator),
		stop: innerCoordinator.stop.bind(innerCoordinator),
		decideAwaiting: innerCoordinator.decideAwaiting.bind(innerCoordinator),
		lastAgents: innerCoordinator.lastAgents.bind(innerCoordinator),
	} as unknown as ObservationCoordinator;

	track(home);

	return {
		state,
		runner,
		dispatch,
		coordinator,
		config,
		home,
		checkout,
		intents,
		planeAsks,
		cleanups,
		cycleEnds,
		order,
		statuses,
		lines,
		moduleLines,
		advance: (ms: number) => {
			nowMs.current += ms;
		},
		setAutoMode: (next: boolean) => {
			state.handoff.setAutoHandoffMode(next);
		},
		setAgents: (next: HerdrAgent[]) => {
			if (agentsFn === null) agents.splice(0, agents.length, ...next);
		},
		settle: () => settleFor(state),
		close: () => {
			state.close();
			rmSync(home, { recursive: true, force: true });
			untrack(home);
		},
	};
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
