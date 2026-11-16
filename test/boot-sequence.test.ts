/**
 * The boot-sequence module's suite (ADR 0155, issue #432): the module's
 * interface pins the plane's boot order and the teardown that reverses it.
 * The Plane boot record and the loop policy go in; the ordered effects and
 * the one teardown come out. The suite reads the order as a value: no
 * process, no terminal, and no state file. The module runs the real refresh
 * coordinator and the real observation cycle, and they stand on the fake
 * state, the fake sources, the fake dispatch operations, and the virtual
 * clock the fields hand over, so a step that runs early, a stop that lands
 * out of order, and a policy arm that drifts from the owned sequence are all
 * caught at the seam.
 */
import { describe, expect, test } from "bun:test";
import { startBootSequence } from "../src/boot-sequence.ts";
import type { ConsultationCheckoutHold } from "../src/checkout-hold.ts";
import type { AppAggregates, AppProps } from "../src/components/app.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { ConsultationOperations } from "../src/consultation-operations.ts";
import { DEFAULT_GROUPING_AXIS } from "../src/domain/grouping.ts";
import type { AgentNameCollision } from "../src/domain/ticket.ts";
import type {
	CloseCycleOutcome,
	DispatchResult,
	HandoffDispatch,
} from "../src/handoff-dispatch.ts";
import { NOOP_LOGGER } from "../src/logging.ts";
import type { ConsultationRecordAggregate } from "../src/state/consultation-record.ts";
import type { GroupingAggregate } from "../src/state/grouping.ts";
import type { HandoffAggregate } from "../src/state/handoff.ts";
import type { PlaneActionAggregate } from "../src/state/plane-action.ts";
import type { RepositoryInitAggregate } from "../src/state/repository-init.ts";
import type { SourceFactAggregate } from "../src/state/source-fact.ts";
import type {
	ScopedTicketRead,
	TicketListViews,
	TicketProjection,
	TicketWorkCycleAggregate,
} from "../src/state/ticket-work-cycle.ts";
import type { WorkQueueAggregate } from "../src/state/work-queue.ts";
import type { FetchOutcome, TicketSource } from "../src/ticket-source.ts";
import { agentListJson, FakeRunner } from "./fake-runner.ts";

import { VirtualClock } from "./observation-fixture.ts";

/**
 * The clock the fields hand the module: the suite advances it, never waits.
 * It stands on the observation fixture's clock, so the suite's timers and the
 * fixture's timers are one shape: a handle the clock can clear, a due instant
 * the advance reaches, and a history a test reads.
 */
type Clock = VirtualClock;

/** The one microtask turn the promise chains of the coordinators settle on. */
async function settleTurns(): Promise<void> {
	for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

const successOutcome = (): FetchOutcome => ({
	status: "success",
	fetchedAt: "2026-01-01T00:00:00.000Z",
	tickets: [],
});

const failureOutcome = (reason: string): FetchOutcome => ({
	status: "failed",
	reason,
});

/**
 * The source the suite settles on demand: every `fetch` stands a waiter, and
 * `settle` answers the oldest waiter with the outcome the test names.
 */
class FakeSource implements TicketSource {
	readonly name: string;
	readonly kind = "fake";
	readonly refreshIntervalMs: number;
	readonly waiters: Array<(outcome: FetchOutcome) => void> = [];
	fetchCalls = 0;

	constructor(name: string, refreshIntervalMs: number) {
		this.name = name;
		this.refreshIntervalMs = refreshIntervalMs;
	}

	fetch(): Promise<FetchOutcome> {
		this.fetchCalls += 1;
		return new Promise<FetchOutcome>((resolve) => this.waiters.push(resolve));
	}

	settle(outcome: FetchOutcome = successOutcome()): void {
		const resolve = this.waiters.shift();
		if (resolve !== undefined) resolve(outcome);
	}
}

/**
 * The empty plane the cycle walks: every aggregate answers from a record
 * that holds nothing, so the cycle's reads run the real code over empty
 * piles and the dispatch operations the suite fakes receive no asks.
 */
function emptyPlaneState(events: string[]): AppAggregates {
	const projection: TicketProjection = {
		rows: [],
		rowFor: () => undefined,
	};
	const views: TicketListViews = {
		rows: [],
		active: [],
		ignored: [],
		muted: [],
		projection,
	};
	const scopedRead: ScopedTicketRead = {
		ticket: null,
		pullRequestLink: { fixing: [], opened: null },
	};
	const ticketWorkCycle: TicketWorkCycleAggregate = {
		projectedTickets: () => [],
		ticketProjection: () => projection,
		ticketOf: () => scopedRead,
		ticketListViews: () => views,
		lastCompletion: () => null,
		recordSkipRefire: () => false,
		recordedTransitionJson: () => null,
		recordRefiredOutcome: () => false,
		dispatchPauseActive: () => false,
		sourceReverifiedSinceCycleEnd: () => false,
		sameTypeHoldActive: () => false,
		ignoredTickets: () => new Set<string>(),
		setTicketIgnored: () => ({ ok: true }),
		ticketState: () => undefined,
		agentNameForTicket: () => "",
		agentNamesForTickets: () => new Map<string, string>(),
		automaticStartBlockedTickets: () => new Set<string>(),
		automaticStartBlockedTicket: () => false,
		ticketsByState: () => [],
		markTicketRunning: () => false,
		reopenTurn: () => false,
		settleTurn: () => {},
		applyCompletionDecision: () => false,
		closeWorkCycle: () => false,
	};
	const handoff: HandoffAggregate = {
		handoffInFlight: () => false,
		handoffCount: () => 0,
		handoffCountsFor: () => new Map<string, number>(),
		handoffBlockedUnrefreshed: () => false,
		failedStartStreaksFor: () => new Map<string, number>(),
		autoHandoffMode: () => false,
		setAutoHandoffMode: () => {},
		latestHandoff: () => null,
		handoffHandles: () => ({ paneIds: [], workspaceIds: [] }),
		openAttemptTickets: () => [],
		hasUnresolvedAttempt: () => false,
		reclaimHandoff: () => null,
		handoffClaimCheck: () => ({ ok: false, reason: "the suite dispatch claims nothing" }),
		claimHandoff: () => ({ ok: false, reason: "the suite dispatch claims nothing" }),
		advanceHandoffAttempt: () => {},
		settleHandoff: () => null,
		recoverUnsettledHandoffs: () => [],
		recordLeftoverEnvironment: () => null,
		leftoverEnvironment: () => null,
		leftoverEnvironmentsFor: () => new Map<string, never[]>(),
		clearLeftoverEnvironments: () => 0,
		recordNameCollision: () => null as unknown as AgentNameCollision,
		nameCollision: () => null,
		nameCollisionsFor: () => new Map<string, AgentNameCollision>(),
		clearNameCollision: () => false,
	};
	const consultationRecord: ConsultationRecordAggregate = {
		scheduleConsultation: () => ({ ok: false, reason: "the suite record holds nothing" }),
		removeConsultationWorkItem: () => false,
		createConsultation: () => {
			throw new Error("the suite record holds no Consultation");
		},
		consultation: () => undefined,
		consultations: () => [],
		setConsultationRepositoryPath: () => {},
		confirmedCheckoutConflicts: () => [],
		recordCheckoutConflictConfirmation: () => {},
		setConsultationAgent: () => {},
		canRecoverConsultationOpening: () => false,
		beginConsultationStart: () => false,
		updateConsultationTypeSettings: () => false,
		failConsultationOpening: () => {},
		setConsultationWarning: () => {},
		recordConsultationAgentHandles: () => {},
		recordExternalConsultationTurn: () => false,
		setConsultationState: () => false,
		setConsultationDraft: () => {},
		beginConsultationResponse: () => undefined,
		acceptConsultationResponse: () => undefined,
		cancelConsultationResponse: () => false,
		settleConsultationTurn: () => false,
		captureConsultationPartial: () => {},
		consultationTurns: () => [],
		consultationSnapshots: () => [],
		consultationNeedsSnapshot: () => false,
		recordConsultationResource: () => {},
		markConsultationResourceShared: () => {},
		markConsultationResourceClosed: () => {},
		consultationRemainingResources: () => [],
		beginConsultationClose: () => false,
		recordConsultationCloseFailure: () => {},
		finishConsultationClose: () => {},
		consultationResources: () => [],
		replacementInput: () => "",
		deleteConsultation: () => false,
		consultationsByState: () => [],
		updateConsultationAgentHandles: () => {},
		fillConsultationSnapshot: () => false,
	};
	const planeAction: PlaneActionAggregate = {
		recordPlaneActionAttempt: () => ({ id: "the suite records no attempt" }),
		recordPlaneActionAttemptOutcome: () => false,
		latestPlaneActionAttempt: () => null,
		planeActionAttemptCount: () => 0,
		planeActionBlockedUnrefreshed: () => false,
	};
	const workQueue: WorkQueueAggregate = {
		queuePaused: () => false,
		setQueuePaused: () => {},
		items: () => [],
		hasWorkItem: () => false,
		hasConsultationItem: () => false,
		enqueueWork: () => ({ ok: true }),
		enqueuePlaneActionWork: () => ({ ok: true }),
		removeWorkItem: () => false,
		cancelWorkItem: () => false,
		removeWorkflowRouteItem: () => 0,
		moveWorkItem: () => false,
	};
	const sourceFact: SourceFactAggregate = {
		initializeSources: (sources) => {
			events.push(`sources-initialized:${sources.map((s) => s.name).join(",")}`);
		},
		applyFetch: (source, outcome) => {
			events.push(`fetch-landed:${source.name}:${outcome.status}`);
		},
		sourceHealths: () => [],
		retireTicket: () => false,
		stillListed: () => true,
		convergeMembershipLabels: () => {},
		membershipSourceNames: () => [],
		setSourceMuted: () => ({ ok: true, removed: 0 }),
		openPullRequestLink: () => ({ pullRequestRows: [], opened: null }),
	};
	const grouping: GroupingAggregate = {
		groupingAxis: () => DEFAULT_GROUPING_AXIS,
		setGroupingAxis: () => {},
		groupOrder: () => [],
		setGroupOrder: () => {},
	};
	const repositoryInit: RepositoryInitAggregate = {
		repositoryInitFact: () => null,
		setRepositoryInitFact: () => {},
	};
	return {
		consultationRecord,
		grouping,
		handoff,
		planeAction,
		repositoryInit,
		sourceFact,
		ticketWorkCycle,
		workQueue,
		now: () => 0,
	};
}

/** The dispatch the suite stands in for the run's operations. */
function fakeHandoffDispatch(events: string[]): HandoffDispatch {
	const checkoutHold: ConsultationCheckoutHold = {
		cross: () => ({ ok: true, checkoutKey: null }),
		take: () => {},
		release: () => {},
	};
	const refusal: DispatchResult = { ok: false, reason: "the suite dispatch starts nothing" };
	return {
		dispatch: () => Promise.resolve(refusal),
		pickupWorkQueue: () => Promise.resolve(0),
		closeCleanup: () => Promise.resolve(undefined),
		dispatchPlaneAction: () => Promise.resolve(refusal),
		planeActionRunInFlight: () => false,
		forceDispatchWorkQueueItem: () => {},
		removeQueueItem: () => false,
		removeConsultationQueueItem: () => false,
		checkoutHold,
		closeWorkCycle: () =>
			Promise.resolve({
				ended: false,
				reason: "the suite cycle closed nothing",
			} satisfies CloseCycleOutcome),
		handoffActive: () => false,
		stop: () => {
			events.push("dispatch-stopped");
		},
	};
}

interface World {
	record: AppProps;
	sources: [FakeSource, FakeSource];
	clock: Clock;
	events: string[];
	runner: FakeRunner;
	start: () => ReturnType<typeof startBootSequence>;
	teardown: { ready: { stop: () => void } | null };
}

function makeWorld(loopPolicy: AppProps["loopPolicy"]): World {
	const events: string[] = [];
	const clock = new VirtualClock();
	const state = emptyPlaneState(events);
	const issues = new FakeSource("issues", 3_600_000);
	const pulls = new FakeSource("pulls", 3_600_000);
	const runner = new FakeRunner();
	runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
	const record: AppProps = {
		// The suite never reads the config: the policy names its interval, and
		// the cycle's rules stand behind the config the record holds.
		config: {} as FactoryConfig,
		runner,
		home: "/tmp/boot-sequence-suite",
		configPath: "/tmp/boot-sequence-suite/config.json",
		state,
		sources: [],
		logger: NOOP_LOGGER,
		agentHostResolution: { host: "herdr", fact: "default" },
		agentHostMarks: { herdrEnv: undefined, hcTerminalId: undefined },
		// The cycle asks the lookup for an Agent's session record; the suite's
		// roster holds no Agent, so the lookup never stands.
		sessionRecord: (() => ({ kind: "unavailable", reason: "no host" })) as never,
		loopPolicy,
		onReady: (ready) => {
			teardown.ready = ready;
		},
	};
	const teardown: World["teardown"] = { ready: null };
	const start = (): ReturnType<typeof startBootSequence> =>
		startBootSequence(record, {
			sources: [issues, pulls],
			clock,
			config: () => record.config,
			replaceTickets: () => {
				events.push("ticket-list");
			},
			replaceConsultations: () => {
				events.push("consultation-list");
			},
			setQueuePaused: (value) => {
				events.push(`queue-paused:${value}`);
			},
			setFaultWarningMessage: (warning) => {
				events.push(`fault-warning:${warning}`);
			},
			setStatus: (next) => {
				if (next !== null) events.push(`status:${next.kind}:${next.text}`);
			},
			clearOperationMessage: (owner) => {
				events.push(`operation-message-cleared:${owner}`);
			},
			clearWorkingMessage: (owner) => {
				events.push(`working-message-cleared:${owner}`);
			},
			setAgents: (agents) => {
				events.push(`agents:${agents === null ? "none" : String(agents.length)}`);
			},
			setBell: (value) => {
				events.push(`bell:${value}`);
			},
			attention: { ring: () => {} } as never,
			refreshTicketSources: (identity) => {
				events.push(`ticket-sources-refreshed:${identity}`);
			},
			closeCycleEndDraft: (identity) => {
				events.push(`cycle-end-draft-closed:${identity}`);
			},
			refreshPullRequestSources: () => {
				events.push("pull-sources-refreshed");
				return Promise.resolve();
			},
			manualRefreshPending: { current: new Set<string>() },
			handoffDispatch: fakeHandoffDispatch(events),
			// The module crosses only the operations' `stop`; the class's
			// private surface the suite does not stand is silenced by the
			// seam, the way the observation fixture silences its wrapped
			// dispatch.
			consultationOperations: {
				stop: () => {
					events.push("operations-stopped");
				},
			} as unknown as ConsultationOperations,
		});
	return { record, sources: [issues, pulls], clock, events, runner, start, teardown };
}

const probesOf = (world: World): number =>
	world.runner.commands().filter((command) => command === "herdr agent list").length;

describe("the boot-sequence module owns the plane's boot order and its teardown (issue #432, ADR 0155)", () => {
	test("the start runs the sequence: the boot read stands before the sources' first reads, the first cycle lands on the settle, and the polling schedule stands behind it", async () => {
		const world = makeWorld({ kind: "polled", intervalMs: 1_000 });
		world.start();
		await settleTurns();

		// The boot read stands first: the lists and the queue pause stand on
		// the state's boot read, before the module starts any read of the
		// sources.
		expect(world.events.slice(0, 4)).toEqual([
			"ticket-list",
			"consultation-list",
			"queue-paused:false",
			`sources-initialized:issues,pulls`,
		]);

		// The sources' first reads stand behind the boot read, and while the
		// load stands the plane probes no Agent: the first herdr probe is held
		// on the settle, not on the boot.
		expect(world.sources[0].fetchCalls).toBe(1);
		expect(world.sources[1].fetchCalls).toBe(1);
		expect(probesOf(world)).toBe(0);
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(1);
		expect(world.clock.clockTimers).toHaveLength(0);

		// One source settles: the load still stands on the last source's first
		// fetch, so the list stands and the plane still probes nothing.
		world.sources[0].settle();
		await settleTurns();
		expect(world.events).toContain("fetch-landed:issues:success");
		expect(probesOf(world)).toBe(0);
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(1);

		// The last source settles: the load settles, the list moves once, and
		// the first observation cycle runs on the settle.
		world.sources[1].settle();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(2);
		expect(probesOf(world)).toBe(1);
		expect(world.events).toContain("agents:0");

		// The polling schedule stands behind the first cycle: one interval
		// later the loop runs the cycle again.
		world.clock.advance(1_000);
		await settleTurns();
		expect(probesOf(world)).toBe(2);
	});

	test("the teardown reverses the start: the loops stop, the dispatch operations stop behind them, and a second stop changes nothing", async () => {
		const world = makeWorld({ kind: "polled", intervalMs: 1_000 });
		const sequence = world.start();
		await settleTurns();
		world.sources[0].settle();
		world.sources[1].settle();
		await settleTurns();
		expect(probesOf(world)).toBe(1);
		expect(world.teardown.ready).not.toBeNull();

		const before = [...world.events];
		sequence.stop();

		// The one handle the shell registered is the module's teardown.
		world.teardown.ready?.stop();

		// Both loops stand stopped before the dispatch operations stop: at the
		// moment the dispatch's stop lands, the clock holds no timer, so no
		// loop arms a cycle or a fetch behind the operations.
		const dispatchStop = world.events.indexOf("dispatch-stopped");
		expect(dispatchStop).toBeGreaterThan(-1);
		expect(world.events.indexOf("operations-stopped")).toBeGreaterThan(dispatchStop);
		const timersAtStop = world.clock.clockTimers.length;

		// A second stop changes nothing.
		const afterFirst = [...world.events];
		sequence.stop();
		sequence.stop();
		expect(world.events).toEqual(afterFirst);

		// Nothing runs behind the stop: no cycle and no fetch stand on the
		// clock any more.
		const probesAfterStop = probesOf(world);
		const fetchesAfterStop = world.sources.map((source) => source.fetchCalls);
		world.clock.advance(100_000);
		await settleTurns();
		expect(probesOf(world)).toBe(probesAfterStop);
		expect(world.sources.map((source) => source.fetchCalls)).toEqual(fetchesAfterStop);
		expect(world.clock.clockTimers).toHaveLength(timersAtStop);
		expect(world.events.slice(before.length)).toEqual(["dispatch-stopped", "operations-stopped"]);
	});

	test("the held policy runs the one-shot arm: no observation loop, one fetch per source, and the list settles on the last first fetch", async () => {
		const world = makeWorld({ kind: "held" });
		world.start();
		await settleTurns();

		// The one-shot arm reads every source once and starts no observation
		// loop: no probe lands, and no timer stands on the clock.
		expect(world.sources[0].fetchCalls).toBe(1);
		expect(world.sources[1].fetchCalls).toBe(1);
		expect(probesOf(world)).toBe(0);
		expect(world.clock.clockTimers).toHaveLength(0);

		// The load settles on the last source's first fetch, the way the
		// polled arm's does: the list stands on the boot read until then, and
		// moves once on the settle.
		world.sources[0].settle();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(1);
		world.sources[1].settle();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(2);

		// The held run stops without polling: no probe ever lands, even after
		// the clock moves.
		world.clock.advance(100_000);
		await settleTurns();
		expect(probesOf(world)).toBe(0);
	});

	test("a failed first fetch settles the load the way a success does", async () => {
		const world = makeWorld({ kind: "polled", intervalMs: 1_000 });
		world.start();
		await settleTurns();

		// The one source fails its first read: the settle still stands on the
		// load, the fault warning stands on it, and the list still moves once
		// on the settle, the way a successful fetch's does.
		world.sources[0].settle();
		world.sources[1].settle(failureOutcome("the suite's source read failed"));
		await settleTurns();
		expect(world.events).toContain("fetch-landed:pulls:failed");
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(2);
		expect(probesOf(world)).toBe(1);
	});

	test("a re-run of the shell's fields disposes the run, and the module re-arms the load and the first probe on the new run", async () => {
		const world = makeWorld({ kind: "polled", intervalMs: 1_000 });
		// Run one: the boot read, the sources' first reads, the settle, and the
		// first probe on the settle.
		const first = world.start();
		await settleTurns();
		world.sources[0].settle();
		world.sources[1].settle();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(2);
		expect(probesOf(world)).toBe(1);

		// The re-run: the shell disposes the run it replaces. The dispose stops
		// the run's loops and disposes the run's hold on the list, and it stands
		// the dispatch operations on, the way the run's own stop stands on them.
		first.dispose();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(2);

		// The module called again on the same record re-arms the load and the
		// first probe: the list re-stands on the new run's boot read, and the
		// new first probe holds on the new settle, so no probe lands while the
		// new load stands.
		world.start();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(3);
		expect(probesOf(world)).toBe(1);
		// The new run re-reads the sources on its own first reads.
		expect(world.sources.map((source) => source.fetchCalls)).toEqual([2, 2]);

		// The new run's load settles: the list moves once, and the first probe
		// re-arms and lands on the new settle, the way the first run's did.
		world.sources[0].settle();
		world.sources[1].settle();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(4);
		expect(probesOf(world)).toBe(2);

		// The re-run replaced the run's stop handle, and the dispatch operations
		// stood on through the dispose and the re-run alike.
		expect(world.teardown.ready).not.toBeNull();
		expect(world.events).not.toContain("dispatch-stopped");
		expect(world.events).not.toContain("operations-stopped");
	});

	test("a bare dispose stops the loops and holds the list, without stopping the dispatch operations", async () => {
		const world = makeWorld({ kind: "polled", intervalMs: 1_000 });
		const sequence = world.start();
		await settleTurns();
		// One source settles: the load still stands on the last source's first
		// fetch, so the list stands and the first probe holds on the settle.
		world.sources[0].settle();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(1);
		expect(probesOf(world)).toBe(0);

		// The bare dispose: the unmount path the run's own stop does not run. It
		// stops the run's loops and disposes the run's hold on the list, and it
		// stands the dispatch operations on.
		sequence.dispose();
		await settleTurns();

		// The source that settles after the dispose moves no list and probes no
		// Agent: the run's hold on the list is disposed, and the held first cycle
		// the run owed never runs on a stopped loop.
		world.sources[1].settle();
		await settleTurns();
		expect(world.events.filter((event) => event === "ticket-list")).toHaveLength(1);
		expect(probesOf(world)).toBe(0);
		// The dispatch operations stand on: the bare dispose stops the loops, not
		// the run's operations.
		expect(world.events).not.toContain("dispatch-stopped");
		expect(world.events).not.toContain("operations-stopped");

		// Nothing runs behind the dispose: advancing the clock arms no new cycle
		// and no new fetch, so the timer history the clock holds stands still.
		const timersAtDispose = world.clock.clockTimers.length;
		world.clock.advance(100_000);
		await settleTurns();
		expect(probesOf(world)).toBe(0);
		expect(world.sources.map((source) => source.fetchCalls)).toEqual([1, 1]);
		expect(world.clock.clockTimers).toHaveLength(timersAtDispose);

		// A second dispose changes nothing.
		const afterFirst = [...world.events];
		sequence.dispose();
		expect(world.events).toEqual(afterFirst);
	});
});
