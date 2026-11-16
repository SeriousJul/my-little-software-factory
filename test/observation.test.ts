/**
 * The observation suite (issue #429, ADR 0152).
 *
 * It drives the real coordinator end to end on the fixture's pinned virtual
 * clock: the state file, the cycle's grid, and the fake runner's held
 * commands all answer from one clock, so a test that moves the clock moves
 * the grid with it. The reader's commands run on the fake runner, which
 * records every command it is asked to run, in order, the order the commands
 * answered, and how many ran at once - the outside measurement of the batch
 * and of the grid.
 *
 * At the reader: one probe, asked of the merged reader on the herdr-core
 * host, answers the rows the sequential probe answered, in the roster's
 * order, and fails the way the sequential probe failed. At the coordinator:
 * the cycles land where the grid says they land, on the virtual clock.
 */
import { describe, expect, test } from "bun:test";

import type { AgentHost, AgentHostResolution } from "../src/agent-host.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { MergedAgentReader } from "../src/observation.ts";
import { RefreshCoordinator } from "../src/refresh.ts";
import type { FactoryState } from "../src/state.ts";
import { fireTransition, refireRecordedSkips } from "../src/workflow.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { fetchedTicket, fetchSuccess } from "./fact-fixtures.ts";
import { agentListJson, FakeRunner, type ListedAgent } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { type Rig, rig, VirtualClock } from "./observation-fixture.ts";

const identity = "github:github.com:I_5";

/** The instant the fixture stands the run on. */
const epoch = () => VirtualClock.epoch;

/** The herdr-core host's resolution. */
const CORE_HOST: AgentHostResolution = { host: "herdr-core", fact: "default" };

/**
 * The task types the awaiting rule reasons about (ADR 0027, ADR 0092):
 * implement and polish are the open dispatch's types, park carries the
 * Operator-decides flag, the rest close or route.
 */
const config: FactoryConfig = {
	...BASE_CONFIG,
	taskTypes: {
		implement: { template: "implement", thinking: "high" },
		review: { template: "review" },
		research: { template: "research" },
		route: { template: "route" },
		polish: { template: "polish" },
		park: { template: "park", operatorDecides: true },
	},
	maxParallelAgents: 2,
	maxHandoffsPerTicket: 2,
};

const handoffChoice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement" as const,
	host: "herdr" as const,
	model: "",
	thinking: "",
	contextWindow: "",
};

/** Yield to the microtask queue: the commands a clock move releases settle in the turns after it. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One herdr agent the host lists. */
function agent(paneId: string, fields: Partial<ListedAgent> = {}): ListedAgent {
	return {
		paneId,
		tabId: "tab-1",
		workspaceId: "ws-1",
		agent: "factory-implement-I_5",
		status: "working",
		...fields,
	};
}

/** The `hc ls` roster answer: the terminals in the order the host lists them. */
function coreRosterJson(
	rows: Array<{ address: string; name: string; state?: string; agent?: string }>,
): string {
	return JSON.stringify({
		terminals: rows.map((row) => ({
			address: row.address,
			name: row.name,
			state: row.state ?? "live",
			...(row.agent !== undefined && { agent: row.agent }),
		})),
	});
}

/** The `hc get` record answer of one terminal. */
function coreRecordJson(record: {
	address: string;
	name?: string | null;
	state: string;
	status?: string | { app: string; state: string };
	cwd?: string;
	createdMs?: number;
	reason?: string;
	exitCode?: number;
}): string {
	return JSON.stringify({
		address: record.address,
		name: record.name === undefined ? null : record.name,
		state: record.state,
		...(record.status !== undefined && { status: record.status }),
		...(record.cwd !== undefined && { cwd: record.cwd }),
		...(record.createdMs !== undefined && { created_ms: record.createdMs }),
		...(record.reason !== undefined && { reason: record.reason }),
		...(record.exitCode !== undefined && { exit_code: record.exitCode }),
	});
}

/** Whether the fixture's ticket still holds a seat. */
const inFlight = (state: FactoryState) =>
	state.ticketWorkCycle
		.ticketsByState(["handed-off", "running"])
		.some((t) => t.ticketIdentity === identity);

/**
 * One in-flight ticket on the herdr host: the handoff settles its seat on
 * the ticket's pane.
 */
/** The pull request ticket identities the fire's refresh tests stand on. */
const pullIdentity = "github:github.com:P_12";
const secondPullIdentity = "github:github.com:P_22";

/**
 * The sources the fire's refresh stands on: the ticket's own membership
 * sources, narrowed to the pull request kind (ADR 0153).
 */
const fireSources = [
	{ name: "issues", kind: "github-issues" as const },
	{ name: "pulls", kind: "github-pull-requests" as const },
];
const pullSourceNames = new Set(
	fireSources
		.filter((source) => source.kind === "github-pull-requests")
		.map((source) => source.name),
);

/**
 * The config the fire's walk reasons over: the implement turn fires to the
 * State the operator decides, so the position the fire lands holds the
 * ticket without starting a new handoff.
 */
const fireConfig: FactoryConfig = {
	...config,
	workflowStates: [
		{ name: "ready-for-review", taskType: "park", match: { labelsAny: ["ready-for-review"] } },
	],
	taskTypes: {
		...config.taskTypes,
		implement: {
			template: "implement",
			thinking: "high",
			transition: { ticketFacts: ["ready-for-review"], pullRequestFacts: [] },
		},
	},
};

/** The fetched pull request a fire refreshes over. */
function pulledPull(identity: string, number: string): FetchedTicket {
	return fetchedTicket({
		identity,
		sourceKind: "github-pull-request",
		externalKey: `#${number}`,
		url: `https://github.com/acme/factory/pull/${number}`,
		labels: ["queued"],
	});
}

interface FireRig {
	fake: Rig;
	pulls: FakeSource;
	/** Stop the fire's refresh coordinator, so a stop over a fetch closes it. */
	stopRefresh: () => void;
}

/**
 * A rig whose fires refresh the way the plane binds the refresh (ADR 0153):
 * the ticket's own pull request membership sources, through the refresh
 * coordinator's one fetch per source. The source's fetches hold until the
 * test settles them, so a test reads the fetch the fire asked for.
 */
function fireRig(options: { pullTickets: FetchedTicket[]; issueTicket?: boolean }): FireRig {
	const box: { fake?: Rig } = {};
	const pulls = new FakeSource("pulls", "github-pull-requests", fetchSuccess([]));
	let refreshCoordinator: RefreshCoordinator | undefined;
	const scopedRefresh = (ticketIdentity: string) => async () => {
		const fake = box.fake!;
		refreshCoordinator ??= new RefreshCoordinator([pulls], fake.state, () => undefined, {
			clock: fake.clock,
		});
		for (const name of fake.state.sourceFact.membershipSourceNames(ticketIdentity))
			if (pullSourceNames.has(name)) await refreshCoordinator.refreshAndWait(name);
	};
	const fake = rig({
		config: fireConfig,
		pollIntervalMs: 5000,
		startupGraceMs: 1000,
		// The settled turn's log: the settle the wake's cycle takes can read a
		// turn end, so the fire settles the turn to its standing.
		turnLogs: async () => ({
			kind: "ended" as const,
			turnEnd: {
				log: [{ kind: "text" as const, text: "settled the turn" }],
				cause: "completed" as const,
				detail: "",
			},
		}),
		fireCompleted: (ticket) =>
			fireTransition({
				config: box.fake!.config,
				state: box.fake!.state,
				runner: box.fake!.runner,
				ticketIdentity: ticket.ticketIdentity,
				taskType: ticket.taskType,
				refresh: scopedRefresh(ticket.ticketIdentity),
			}),
		refireRecordedSkips: () =>
			refireRecordedSkips({
				config: box.fake!.config,
				state: box.fake!.state,
				runner: box.fake!.runner,
				refresh: (ticketIdentity) => scopedRefresh(ticketIdentity)(),
			}),
	});
	box.fake = fake;
	// The sources the fire's refresh asks: the rig's issue source, plus the
	// pull request source the membership lists.
	fake.state.sourceFact.initializeSources(fireSources);
	fake.state.sourceFact.applyFetch(
		fireSources[0],
		fetchSuccess(options.issueTicket ? [fetchedTicket({ identity, labels: ["queued"] })] : []),
	);
	fake.state.sourceFact.applyFetch(fireSources[1], fetchSuccess(options.pullTickets));
	return { fake, pulls, stopRefresh: () => refreshCoordinator?.stop() };
}

/** Pin the agent's settle-state wait, and hold it on the clock for the named milliseconds. */
function pinWait(fake: Rig, name: string, holdMs: number): void {
	const args = ["agent", "wait", name, "--until", "idle", "--until", "done", "--until", "blocked"];
	fake.runner.set("herdr", args, { code: 0, stdout: "" });
	fake.runner.setDelay("herdr", args, holdMs);
}

function handOut(state: FactoryState, id: string, paneId = "pane-implement"): void {
	const claim = state.handoff.claimHandoff(id, handoffChoice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId,
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
}

/**
 * One in-flight ticket on the herdr-core host: the seat is the terminal the
 * run's handoff named, and the name is the terminal's name (ADR 0141).
 */
function coreHandOut(state: FactoryState, id: string, terminalName: string): void {
	const claim = state.handoff.claimHandoff(id, { ...handoffChoice, host: "herdr-core" }, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: terminalName,
		tabId: terminalName,
		workspaceId: terminalName,
	});
}

/** Hold the terminal's live working record in the herdr-core stubs. */
function coreSeat(runner: FakeRunner, name: string): void {
	runner.set("hc", ["ls", "--json", "--all"], {
		stdout: coreRosterJson([{ address: name, name, state: "live" }]),
	});
	runner.set("hc", ["get", "--json", name], {
		stdout: coreRecordJson({ address: name, name, state: "live", status: "working" }),
	});
}

/** The merged reader on a bare runner, the way the App wires it. */
function readerFor(
	runner: FakeRunner,
	runHost: AgentHost,
	coreNames: () => string[],
): MergedAgentReader {
	return new MergedAgentReader({
		runner,
		runHost,
		coreNames,
		hostOf: () => runHost,
	});
}

/** The virtual instants the probe's `herdr agent list` calls were asked. */
function probeTimes(fake: Rig): number[] {
	const times: number[] = [];
	fake.runner.calls.forEach((call, index) => {
		if (call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "list")
			times.push(fake.commandTimes[index]);
	});
	return times;
}

/** The `hc` commands one run asked, in ask order. */
function coreCommands(fake: Rig): string[] {
	return fake.runner.commands().filter((command) => command.startsWith("hc "));
}

describe("the merged agent reader's batch (ADR 0152)", () => {
	test("the probe reads the held terminal records as one concurrent batch", async () => {
		const clock = new VirtualClock();
		const runner = new FakeRunner();
		runner.adoptVirtualClock(clock);
		runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([
				{ address: "t-a", name: "a" },
				{ address: "t-b", name: "b" },
			]),
		});
		runner.setDelay("hc", ["ls", "--json", "--all"], 2000);
		runner.set("hc", ["get", "--json", "t-a"], {
			stdout: coreRecordJson({ address: "t-a", name: "a", state: "live", status: "working" }),
		});
		runner.set("hc", ["get", "--json", "t-b"], {
			stdout: coreRecordJson({ address: "t-b", name: "b", state: "live", status: "working" }),
		});
		runner.setDelay("hc", ["get", "--json", "t-a"], 1000);
		runner.setDelay("hc", ["get", "--json", "t-b"], 1000);

		const reader = readerFor(runner, "herdr-core", () => ["a", "b"]);
		const probe = reader.listAgents();

		// The roster holds: no record read is issued before it settles.
		expect(runner.commands()).toEqual(["hc ls --json --all"]);
		expect(runner.settledCommands()).toEqual([]);

		// The roster settles: the held record reads issue together, behind it,
		// before any of them answers - the batch, not one behind the next.
		clock.advance(2000);
		await tick();
		expect(runner.commands()).toEqual([
			"hc ls --json --all",
			"hc get --json t-a",
			"hc get --json t-b",
		]);
		expect(runner.settledCommands()).toEqual(["hc ls --json --all"]);
		expect(runner.peakConcurrency()).toBe(2);

		clock.advance(1000);
		await tick();
		const result = await probe;
		expect(result).toEqual({
			kind: "ok",
			agents: [
				expect.objectContaining({ host: "herdr-core", name: "a", status: "working" }),
				expect.objectContaining({ host: "herdr-core", name: "b", status: "working" }),
			],
		});
	});

	test("the rows come back in the roster's order", async () => {
		const runner = new FakeRunner();
		runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([
				{ address: "t-b", name: "b" },
				{ address: "t-a", name: "a" },
			]),
		});
		runner.set("hc", ["get", "--json", "t-b"], {
			stdout: coreRecordJson({ address: "t-b", name: "b", state: "live", status: "working" }),
		});
		runner.set("hc", ["get", "--json", "t-a"], {
			stdout: coreRecordJson({ address: "t-a", name: "a", state: "live", status: "idle" }),
		});

		const reader = readerFor(runner, "herdr-core", () => ["a", "b"]);
		const result = await reader.listAgents();
		// The host lists b before a, and the merged list carries that order.
		expect(result).toEqual({
			kind: "ok",
			agents: [
				expect.objectContaining({ name: "b", status: "working" }),
				expect.objectContaining({ name: "a", status: "idle" }),
			],
		});
	});

	test("the batch reads only the terminals the plane's in-flight work holds", async () => {
		const runner = new FakeRunner();
		runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([
				{ address: "t-held", name: "held" },
				{ address: "t-stranger", name: "stranger" },
			]),
		});
		runner.set("hc", ["get", "--json", "t-held"], {
			stdout: coreRecordJson({ address: "t-held", name: "held", state: "live", status: "working" }),
		});

		const reader = readerFor(runner, "herdr-core", () => ["held"]);
		const result = await reader.listAgents();
		// The roster lists every terminal on the machine; the batch reads only
		// the one the plane's in-flight work holds, so the poll never reads
		// every terminal on the machine.
		expect(runner.commands()).toEqual(["hc ls --json --all", "hc get --json t-held"]);
		expect(result).toEqual({
			kind: "ok",
			agents: [expect.objectContaining({ name: "held", status: "working" })],
		});
	});

	test("the record's words stand through the batch", async () => {
		const cases: Array<{
			record: Parameters<typeof coreRecordJson>[0];
			agent: Record<string, unknown> | "dropped";
		}> = [
			// A live record: the status word, the checkout, the creation time.
			{
				record: {
					address: "t-x",
					name: "x",
					state: "live",
					status: "working",
					cwd: "/checkout",
					createdMs: 1000,
				},
				agent: {
					host: "herdr-core",
					name: "x",
					paneId: "x",
					status: "working",
					checkoutPath: "/checkout",
					createdMs: 1000,
				},
			},
			// A status the host answers as an object reads its state word.
			{
				record: {
					address: "t-x",
					name: "x",
					state: "live",
					status: { app: "pi", state: "idle" },
				},
				agent: { host: "herdr-core", name: "x", status: "idle" },
			},
			// A blank status reads unknown: the terminal stands, its word does not.
			{
				record: { address: "t-x", name: "x", state: "live", status: "" },
				agent: { host: "herdr-core", name: "x", status: "unknown" },
			},
			// A finished record that exits with a code is done.
			{
				record: {
					address: "t-x",
					name: "x",
					state: "finished",
					reason: "exit",
					exitCode: 0,
				},
				agent: { host: "herdr-core", name: "x", status: "done" },
			},
			// A finished record with no exit code: the host lost the terminal,
			// so the row drops and the Missing marker reads it.
			{
				record: { address: "t-x", name: "x", state: "finished", reason: "killed" },
				agent: "dropped",
			},
		];
		for (const c of cases) {
			const runner = new FakeRunner();
			runner.set("hc", ["ls", "--json", "--all"], {
				stdout: coreRosterJson([{ address: "t-x", name: "x" }]),
			});
			runner.set("hc", ["get", "--json", "t-x"], { stdout: coreRecordJson(c.record) });
			const reader = readerFor(runner, "herdr-core", () => ["x"]);
			const result = await reader.listAgents();
			if (c.agent === "dropped") {
				// The dropped row leaves the merged list empty.
				expect(result).toEqual({ kind: "ok", agents: [] });
			} else {
				expect(result).toEqual({
					kind: "ok",
					agents: [expect.objectContaining(c.agent)],
				});
			}
			// The case's runner answers nothing else: a fresh runner per case
			// keeps the words of one record from standing beside another's.
			expect(runner.commands()).toHaveLength(2);
		}
	});

	test("a record that does not answer leaves the terminal present with an unknown status", async () => {
		const runner = new FakeRunner();
		runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([{ address: "t-x", name: "x" }]),
		});
		runner.set("hc", ["get", "--json", "t-x"], { code: 1, stderr: "hc: record not found" });
		const reader = readerFor(runner, "herdr-core", () => ["x"]);
		const result = await reader.listAgents();
		// The plane restarts no Agent it cannot read: the roster row stands,
		// the record's gap leaves the status unknown.
		expect(result).toEqual({
			kind: "ok",
			agents: [expect.objectContaining({ name: "x", status: "unknown" })],
		});
	});

	test("a roster the herdr-core host does not answer is the probe's error", async () => {
		const runner = new FakeRunner();
		runner.set("hc", ["ls", "--json", "--all"], { code: 1, stderr: "hc: no such server" });
		const reader = readerFor(runner, "herdr-core", () => ["x"]);
		const result = await reader.listAgents();
		expect(result).toEqual({ kind: "error", reason: "hc: no such server" });
	});

	test("a roster the herdr-core host cannot read is the probe's error", async () => {
		const runner = new FakeRunner();
		runner.set("hc", ["ls", "--json", "--all"], { code: 0, stdout: "not a roster" });
		const reader = readerFor(runner, "herdr-core", () => ["x"]);
		const result = await reader.listAgents();
		expect(result).toEqual({
			kind: "error",
			reason: "herdr-core did not return a readable terminal roster",
		});
	});

	test("on the herdr host the probe reads both halves, and the core failure stands beside the list", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([agent("pane-1", { status: "working" })]),
		});
		runner.set("hc", ["ls", "--json", "--all"], { code: 1, stderr: "hc: no such server" });
		const reader = readerFor(runner, "herdr", () => []);
		const result = await reader.listAgents();
		// The herdr half stands: the list keeps its agents, and the gap the
		// core failure states stands beside it.
		expect(result).toEqual({
			kind: "ok",
			agents: [expect.objectContaining({ host: "herdr", paneId: "pane-1", status: "working" })],
		});
		expect(reader.lastCoreFailure).toBe("hc: no such server");
		// The next probe the host answers clears the gap.
		runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([]),
		});
		const again = await reader.listAgents();
		expect(again.kind).toBe("ok");
		expect(reader.lastCoreFailure).toBeNull();
	});

	test("on the herdr host the herdr failure drops the list, and the core half never reads", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { code: 1, stderr: "herdr: not running" });
		const reader = readerFor(runner, "herdr", () => ["x"]);
		const result = await reader.listAgents();
		expect(result).toEqual({ kind: "error", reason: "herdr: not running" });
		// The probe fails on the herdr half: the core half stands unread.
		expect(runner.commands()).toEqual(["herdr agent list"]);
	});

	test("on the herdr host the probe is the herdr half's one list call beside the core half", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([agent("pane-1", { status: "working" })]),
		});
		runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([{ address: "t-held", name: "held" }]),
		});
		runner.set("hc", ["get", "--json", "t-held"], {
			stdout: coreRecordJson({ address: "t-held", name: "held", state: "live", status: "working" }),
		});
		const reader = readerFor(runner, "herdr", () => ["held"]);
		const result = await reader.listAgents();
		// One list call carries the herdr half's Agents; the core half reads
		// the terminals the run's own handoffs put on herdr-core.
		expect(runner.commands()).toEqual([
			"herdr agent list",
			"hc ls --json --all",
			"hc get --json t-held",
		]);
		expect(result).toEqual({
			kind: "ok",
			agents: [
				expect.objectContaining({ host: "herdr", paneId: "pane-1" }),
				expect.objectContaining({ host: "herdr-core", name: "held", status: "working" }),
			],
		});
	});
});

describe("the held terminals behind the cycle (ADR 0152)", () => {
	test("one probe on the herdr-core host issues the roster read and the held record reads as one batch", async () => {
		const fake = rig({ config, agentHost: CORE_HOST, pollIntervalMs: 5000 });
		const name = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		coreHandOut(fake.state, identity, name);
		fake.runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([
				{ address: "t-stranger", name: "stranger" },
				{ address: "t-held", name, agent: "pi" },
			]),
		});
		fake.runner.set("hc", ["get", "--json", "t-held"], {
			stdout: coreRecordJson({
				address: "t-held",
				name,
				state: "live",
				status: "working",
				cwd: fake.checkout,
			}),
		});
		fake.runner.setDelay("hc", ["ls", "--json", "--all"], 2000);
		fake.runner.setDelay("hc", ["get", "--json", "t-held"], 1000);

		fake.coordinator.start();
		await fake.advance(0);
		// The probe's roster read holds: the held record read is not issued
		// before the roster settles.
		expect(coreCommands(fake)).toEqual(["hc ls --json --all"]);

		await fake.advance(2000);
		// The roster settles: the held record read issues behind it. The
		// stranger's record is never read: the bound stands on the plane's
		// in-flight work.
		expect(coreCommands(fake)).toEqual(["hc ls --json --all", `hc get --json t-held`]);
		expect(fake.runner.settledCommands().filter((command) => command.startsWith("hc "))).toEqual([
			"hc ls --json --all",
		]);
		// The record read stands asked and unsettled behind the roster: the
		// batch asks its reads together and pays their answers on the clock.
		await fake.advance(1000);
		// The cycle's wake wait on the working terminal settles on the clock
		// beside the probe's reads, so the pin stands on the probe's own.
		const probeReads = (commands: string[]) =>
			commands.filter(
				(command) => command === "hc ls --json --all" || command.startsWith("hc get "),
			);
		expect(probeReads(fake.runner.settledCommands())).toEqual([
			"hc ls --json --all",
			`hc get --json t-held`,
		]);
		// The rows come back in the roster's order, the way the merged list
		// carries them.
		expect(fake.coordinator.lastAgents()).toEqual([
			expect.objectContaining({
				host: "herdr-core",
				name,
				paneId: name,
				status: "working",
				checkoutPath: fake.checkout,
			}),
		]);
		fake.coordinator.stop();
		fake.close();
	});

	test("the batch is a no-op where the probe is one list call", async () => {
		// On the herdr host with no handoff on herdr-core, one probe is the
		// herdr half's one list call: the batch reads nothing.
		const fake = rig({ config, pollIntervalMs: 5000 });
		fake.coordinator.start();
		await fake.advance(0);
		await fake.advance(5000);
		await fake.advance(5000);
		const lists = fake.runner.commands().filter((command) => command === "herdr agent list");
		const gets = fake.runner.commands().filter((command) => command.startsWith("hc get "));
		expect(lists).toHaveLength(3);
		expect(gets).toHaveLength(0);
		fake.coordinator.stop();
		fake.close();
	});

	test("a roster the host does not answer holds the observation on the herdr-core host", async () => {
		const fake = rig({ config, agentHost: CORE_HOST, pollIntervalMs: 5000 });
		fake.runner.set("hc", ["ls", "--json", "--all"], { code: 1, stderr: "hc: no such server" });
		fake.coordinator.start();
		await fake.advance(0);
		// The probe's error carries no list: the report hands its null roster
		// over, the way today's reader does.
		const report = fake.reports.at(-1);
		expect(report).not.toBeNull();
		expect(report?.agents).toBeNull();
		fake.coordinator.stop();
		fake.close();
	});
});

describe("the observation cycle's held period (ADR 0152)", () => {
	test("the boot runs the first cycle immediately, and the next stands at the boot's start plus the interval", async () => {
		const fake = rig({ config, pollIntervalMs: 5000 });
		fake.runner.setDelay("herdr", ["agent", "list"], 1000);
		fake.coordinator.start();
		await fake.advance(0);
		// The boot's probe is issued at the boot's start, whatever the cycle
		// costs.
		expect(fake.commandTimes[0]).toBe(epoch());
		// The boot's next landing stands at the boot's start plus the
		// interval, on the clock.
		expect(fake.clock.clockTimers).toEqual([
			{
				registeredAt: epoch(),
				delay: 5000,
				due: epoch() + 5000,
				firedAt: null,
			},
		]);

		await fake.advance(1000);
		// The boot cycle finishes inside its slot: it reschedules nothing,
		// and the grid's landing stands where the grid named it.
		expect(fake.clock.clockTimers.at(-1)?.firedAt).toBeNull();

		await fake.advance(4000);
		// The cycle lands at the boot's start plus the interval - not at the
		// boot's completion plus the interval, the standing it had before.
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 5000]);
		expect(fake.clock.clockTimers.at(-1)?.due).toBe(epoch() + 10000);

		await fake.advance(5000);
		// The grid stands on the start, not on the end: it drifts not at all.
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 5000, epoch() + 10000]);
		fake.coordinator.stop();
		fake.close();
	});

	test("a slow cycle runs the next at its completion, not at the completion plus the interval", async () => {
		const fake = rig({ config, pollIntervalMs: 5000 });
		fake.runner.setDelay("herdr", ["agent", "list"], 12000);
		fake.coordinator.start();
		await fake.advance(0);

		await fake.advance(5000);
		// The grid's fire meets the slow cycle in flight: it runs no cycle of
		// its own, so nothing lands at the interval.
		expect(probeTimes(fake)).toEqual([epoch()]);

		await fake.advance(7000);
		// The slow cycle completes at 12000, and the next runs at once, at
		// the completion: start plus the interval is in the past, so the clamp
		// to now stands.
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 12000]);

		await fake.advance(5000);
		await fake.advance(7000);
		// A run of slow cycles runs back to back at the pace the probe keeps:
		// the grid re-anchors on each run's own start, and the next lands at
		// that start's completion, never at the completion plus the interval.
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 12000, epoch() + 24000]);
		fake.coordinator.stop();
		fake.close();
	});

	test("a cycle that finishes inside its slot stands the next on the grid, and the period returns to the interval", async () => {
		const fake = rig({ config, pollIntervalMs: 5000 });
		// The probe runs long once, then recovers its pace.
		fake.runner.setDelaySequence("herdr", ["agent", "list"], [12000, 1000, 1000, 1000]);
		fake.coordinator.start();
		await fake.advance(0);

		await fake.advance(5000);
		// The fire meets the slow cycle in flight: nothing lands at 5000.
		expect(probeTimes(fake)).toEqual([epoch()]);

		await fake.advance(7000);
		// The slow cycle completes, the next runs at once on the re-anchored
		// grid.
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 12000]);

		await fake.advance(1000);
		// The next cycle finishes inside its slot: it reschedules nothing,
		// and the grid stands where the grid named it - 17000, not the
		// completion plus the interval.
		expect(fake.clock.clockTimers.at(-1)?.due).toBe(epoch() + 17000);

		await fake.advance(4000);
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 12000, epoch() + 17000]);

		await fake.advance(1000);
		await fake.advance(4000);
		// The period returns to exactly the interval: the grid stands.
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 12000, epoch() + 17000, epoch() + 22000]);
		fake.coordinator.stop();
		fake.close();
	});

	test("a timer fire that meets a wake in flight holds the wake's start as the grid anchor", async () => {
		const fake = rig({ config, pollIntervalMs: 5000 });
		fake.runner.setDelaySequence("herdr", ["agent", "list"], [1000, 3000, 1000, 1000]);
		fake.coordinator.start();
		await fake.advance(1000);
		// The boot cycle is done, and the grid stands at 5000.
		expect(probeTimes(fake)).toEqual([epoch()]);

		// A wake the refresh settles knocks beside the grid: the cycle runs
		// at once, on the wake's own start.
		void fake.coordinator.tick();
		await fake.advance(0);
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 1000]);

		await fake.advance(5000);
		// The grid's fire meets the wake in flight: it runs no cycle of its
		// own, and leaves the grid owed to the wake. On the wake's completion
		// the landing stands at the wake's start plus the interval, clamped to
		// now - which is now, so the grid runs at once at the pace the wake
		// keeps.
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 1000, epoch() + 6000]);
		// The grid re-anchors on that run's own start: the next stands at its
		// start plus the interval.
		expect(fake.clock.clockTimers.at(-1)?.due).toBe(epoch() + 11000);

		await fake.advance(1000);
		await fake.advance(4000);
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 1000, epoch() + 6000, epoch() + 11000]);
		fake.coordinator.stop();
		fake.close();
	});
});

describe("the agent's wake wait (ADR 0084)", () => {
	test("a settle state match runs a cycle now, so the turn settles without a poll", async () => {
		const fake = rig({
			config,
			pollIntervalMs: 5000,
			startupGraceMs: 1000,
			agents: [agent("pane-implement", { status: "working" })],
			// The settled turn's log: the settle the wake's cycle takes can
			// read a turn end, so the fire settles the turn to its standing.
			turnLogs: async () => ({
				kind: "ended" as const,
				turnEnd: {
					log: [{ kind: "text" as const, text: "settled the turn" }],
					cause: "completed" as const,
					detail: "",
				},
			}),
		});
		const name = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		handOut(fake.state, identity);
		fake.runner.set(
			"herdr",
			["agent", "wait", name, "--until", "idle", "--until", "done", "--until", "blocked"],
			{ code: 0, stdout: "" },
		);
		fake.runner.setDelay(
			"herdr",
			["agent", "wait", name, "--until", "idle", "--until", "done", "--until", "blocked"],
			3000,
		);
		fake.coordinator.start();
		await fake.advance(1000);
		// The cycle saw the working agent: the wait is armed on the agent's
		// name, the identity the live agent belongs to by, and it holds until
		// its state match.
		const waits = fake.runner
			.commands()
			.filter((command) => command.startsWith("herdr agent wait "));
		expect(waits).toEqual([`herdr agent wait ${name} --until idle --until done --until blocked`]);

		// The agent finishes its turn between polls, before the grid's next
		// landing. The wait arms on the boot probe's answer, so its match
		// stands on that answer plus the hold, ahead of the grid's landing.
		fake.setAgents([agent("pane-implement", { status: "idle" })]);
		await fake.advance(3000);
		// The turn settles on the wake, at the wait's answer - not on the
		// next grid landing: the ticket leaves its seat before the grid's
		// next probe stands.
		expect(inFlight(fake.state)).toBe(false);
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 4000]);
		// The wake reschedules nothing: the grid's landing still stands where
		// the grid named it, the poll the single source of truth.
		expect(fake.clock.clockTimers.at(-1)?.due).toBe(epoch() + 5000);
		expect(fake.clock.clockTimers.at(-1)?.firedAt).toBeNull();
		// The grid lands where it stood, behind the wake's cycle.
		await fake.advance(1000);
		expect(probeTimes(fake)).toEqual([epoch(), epoch() + 4000, epoch() + 5000]);
		fake.coordinator.stop();
		fake.close();
	});

	test("the wait arms on the working report only: a booted idle agent holds no wait", async () => {
		const fake = rig({
			config,
			startupGraceMs: 1000,
			agents: [agent("pane-implement", { status: "idle" })],
		});
		handOut(fake.state, identity);
		await fake.coordinator.tick();
		// An idle report inside the startup grace is a boot, not a settle:
		// arming on it would match at once, in a loop the poll never had.
		expect(
			fake.runner.commands().filter((command) => command.startsWith("herdr agent wait ")),
		).toHaveLength(0);
		fake.setAgents([agent("pane-implement", { status: "working" })]);
		await fake.advance(1001);
		await fake.coordinator.tick();
		expect(
			fake.runner.commands().filter((command) => command.startsWith("herdr agent wait ")),
		).toEqual([
			`herdr agent wait ${fake.state.ticketWorkCycle.agentNameForTicket(
				identity,
			)} --until idle --until done --until blocked`,
		]);
		fake.coordinator.stop();
		fake.close();
	});

	test("a missing agent holds no wait", async () => {
		const fake = rig({ config, startupGraceMs: 1000, agents: [] });
		handOut(fake.state, identity);
		await fake.advance(1001);
		await fake.coordinator.tick();
		expect(
			fake.runner.commands().filter((command) => command.startsWith("herdr agent wait ")),
		).toHaveLength(0);
		fake.coordinator.stop();
		fake.close();
	});

	test("one wait per agent across cycles, and a settled ticket drops its arm", async () => {
		const fake = rig({
			config,
			startupGraceMs: 1000,
			agents: [agent("pane-implement", { status: "working" })],
		});
		handOut(fake.state, identity);
		await fake.advance(1001);
		await fake.coordinator.tick();
		// The armed wait holds: the next cycle adds none.
		await fake.coordinator.tick();
		const waitCommands = () =>
			fake.runner.commands().filter((command) => command.startsWith("herdr agent wait "));
		expect(waitCommands()).toHaveLength(1);
		// The wait answers with the settle: the turn settles, the ticket rests
		// out of in-flight, and the next cycle arms nothing on it.
		fake.setAgents([agent("pane-implement", { status: "idle" })]);
		await fake.advance(4000);
		await fake.coordinator.tick();
		expect(waitCommands()).toHaveLength(1);
		fake.coordinator.stop();
		fake.close();
	});

	test("a failed wait wakes nothing, and the next cycle re-arms it", async () => {
		const fake = rig({
			config,
			startupGraceMs: 1000,
			agents: [agent("pane-implement", { status: "working" })],
		});
		const name = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		fake.runner.set(
			"herdr",
			["agent", "wait", name, "--until", "idle", "--until", "done", "--until", "blocked"],
			{ code: 1, stderr: "herdr: no such agent" },
		);
		handOut(fake.state, identity);
		await fake.advance(1001);
		await fake.coordinator.tick();
		// The wait answers a miss: it wakes nothing, and the ticket stays in
		// flight on the agent the poll still lists.
		expect(inFlight(fake.state)).toBe(true);
		const before = probeTimes(fake).length;
		await fake.coordinator.tick();
		// The next cycle re-arms the wait on the name it saw.
		expect(
			fake.runner.commands().filter((command) => command.startsWith("herdr agent wait ")),
		).toHaveLength(2);
		expect(probeTimes(fake).length).toBe(before + 1);
		fake.coordinator.stop();
		fake.close();
	});

	test("the herdr-core host's wait pins the budget, and the host's timeout answer wakes nothing", async () => {
		const fake = rig({ config, agentHost: CORE_HOST, startupGraceMs: 1000 });
		const name = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		coreHandOut(fake.state, identity, name);
		coreSeat(fake.runner, name);
		fake.runner.set("hc", ["wait", "--json", "--timeout", "900", name], {
			code: 0,
			stdout: '{"ended": false}',
		});
		await fake.advance(1001);
		await fake.coordinator.tick();
		// The wait runs through the command runner like every other herdr
		// exchange, on the host's own timeout: the seam's budget in whole
		// seconds.
		expect(fake.runner.commands()).toContain(`hc wait --json --timeout 900 ${name}`);
		// The host's timeout answer is no settle: it wakes nothing, and the
		// ticket stands in flight on the record the poll lists.
		expect(inFlight(fake.state)).toBe(true);
		fake.coordinator.stop();
		fake.close();
	});
});

describe("the Missing agent's flow (ADR 0152)", () => {
	test("the startup grace and the Missing marker read the herdr-core host record (issue #410)", async () => {
		const fake = rig({ config, agentHost: CORE_HOST, autoOn: true, startupGraceMs: 1000 });
		const name = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		coreHandOut(fake.state, identity, name);
		coreSeat(fake.runner, name);
		const restarts = () => fake.intents.filter((intent) => intent.origin === "restart");
		// Inside the startup grace the record reads booting, not missing, the
		// way the herdr record does: the read takes the host fact, and no
		// reader grows a host branch of its own.
		await fake.coordinator.tick();
		expect(restarts()).toHaveLength(0);
		// Past the grace, the listed record holds the ticket's seat, so the
		// Missing marker stays off for the host record it lists.
		await fake.advance(1001);
		await fake.coordinator.tick();
		expect(restarts()).toHaveLength(0);
		// The record drops out of the roster: the same read answers Missing
		// for the host record, and the auto restart stands in for the lost
		// terminal the way it stands in for the lost pane.
		fake.runner.set("hc", ["ls", "--json", "--all"], { stdout: coreRosterJson([]) });
		await fake.coordinator.tick();
		expect(restarts()).toEqual([
			expect.objectContaining({
				automatic: true,
				ticketIdentity: identity,
				choice: expect.objectContaining({
					taskType: "implement",
					host: "herdr-core",
				}),
			}),
		]);
		fake.coordinator.stop();
		fake.close();
	});

	test("auto mode restarts a missing herdr agent once per episode, on the probe that meets it", async () => {
		const fake = rig({ config, autoOn: true, startupGraceMs: 1000, agents: [] });
		handOut(fake.state, identity);
		const restarts = () => fake.intents.filter((intent) => intent.origin === "restart");
		// Inside the startup grace the lost agent reads booting, not missing.
		await fake.coordinator.tick();
		expect(restarts()).toHaveLength(0);
		// The agent ran past the startup grace: the correction lands on the
		// probe that meets it.
		await fake.advance(1001);
		await fake.coordinator.tick();
		expect(restarts()).toEqual([
			expect.objectContaining({
				automatic: true,
				ticketIdentity: identity,
				previousMessage: "",
				choice: expect.objectContaining({ taskType: "implement" }),
			}),
		]);
		// The second cycle of the same episode does not restart again.
		await fake.coordinator.tick();
		expect(restarts()).toHaveLength(1);
		fake.coordinator.stop();
		fake.close();
	});
});

describe("the settling tickets' fires (issue #430, ADR 0153)", () => {
	test("the settling tickets' fires start side by side over the held refresh", async () => {
		const { fake, pulls, stopRefresh } = fireRig({
			pullTickets: [pulledPull(pullIdentity, "12")],
			issueTicket: true,
		});
		const issueName = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		const pullName = fake.state.ticketWorkCycle.agentNameForTicket(pullIdentity);
		const working = [
			agent("pane-implement", { agent: issueName, sessionId: `${issueName}.jsonl` }),
			agent("pane-pull", { agent: pullName, sessionId: `${pullName}.jsonl` }),
		];
		const idle = [
			agent("pane-implement", {
				agent: issueName,
				status: "idle",
				sessionId: `${issueName}.jsonl`,
			}),
			agent("pane-pull", {
				agent: pullName,
				status: "idle",
				sessionId: `${pullName}.jsonl`,
			}),
		];
		fake.runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([
				{ address: issueName, name: issueName, state: "live" },
				{ address: pullName, name: pullName, state: "live" },
			]),
		});
		fake.setAgents(working);
		pinWait(fake, issueName, 3000);
		pinWait(fake, pullName, 3000);
		// The issue ticket's fire write holds on the clock: the walk that settles
		// ticket by ticket holds the ticket's chain until the write answers, so
		// the pull request ticket's refresh cannot start before it. The side by
		// side walk starts it beside the write.
		const issueWrite = [
			"issue",
			"edit",
			"#5",
			"--repo",
			"github.com/acme/factory",
			"--add-label",
			"ready-for-review",
		];
		fake.runner.set("gh", issueWrite, { code: 0, stdout: "" });
		fake.runner.setDelay("gh", issueWrite, 2000);
		fake.runner.set(
			"gh",
			["pr", "edit", "#12", "--repo", "github.com/acme/factory", "--add-label", "ready-for-review"],
			{ code: 0, stdout: "" },
		);
		handOut(fake.state, identity);
		handOut(fake.state, pullIdentity, "pane-pull");
		fake.coordinator.start();
		await fake.advance(1000);
		fake.setAgents(idle);
		await fake.advance(3000);
		// The wait answered: the wake's cycle settles both tickets in one walk.
		// The pull request ticket's own refresh is in flight beside the issue
		// ticket's fire, whose held write has not answered yet.
		expect(pulls.calls).toBe(1);
		expect(fake.runner.commands().some((c) => c.startsWith("gh issue edit #5"))).toBe(true);
		expect(fake.runner.settledCommands().some((c) => c.startsWith("gh issue edit #5"))).toBe(false);
		expect(fake.runner.commands().some((c) => c.startsWith("gh pr edit #12"))).toBe(false);
		// The write answers: the issue ticket's fire settles beside the pull
		// request ticket's still held refresh.
		await fake.advance(2000);
		pulls.settle(fetchSuccess([pulledPull(pullIdentity, "12")]));
		await tick();
		await tick();
		// Both fires settled, both tickets stand on the operator's position, and
		// the refresh paid for the source's one fetch.
		expect(fake.runner.settledCommands().some((c) => c.startsWith("gh pr edit #12"))).toBe(true);
		expect(pulls.calls).toBe(1);
		expect(fake.state.ticketWorkCycle.ticketsByState(["handed-off", "running"])).toHaveLength(0);
		stopRefresh();
		fake.coordinator.stop();
		fake.close();
	});

	test("two settling tickets sharing a pull request source pay for one fetch", async () => {
		const { fake, pulls, stopRefresh } = fireRig({
			pullTickets: [pulledPull(pullIdentity, "12"), pulledPull(secondPullIdentity, "22")],
		});
		const first = fake.state.ticketWorkCycle.agentNameForTicket(pullIdentity);
		const second = fake.state.ticketWorkCycle.agentNameForTicket(secondPullIdentity);
		const working = [
			agent("pane-pull", { agent: first, sessionId: `${first}.jsonl` }),
			agent("pane-pull2", { agent: second, sessionId: `${second}.jsonl` }),
		];
		const idle = [
			agent("pane-pull", { agent: first, status: "idle", sessionId: `${first}.jsonl` }),
			agent("pane-pull2", { agent: second, status: "idle", sessionId: `${second}.jsonl` }),
		];
		fake.runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([
				{ address: first, name: first, state: "live" },
				{ address: second, name: second, state: "live" },
			]),
		});
		fake.setAgents(working);
		pinWait(fake, first, 3000);
		pinWait(fake, second, 3000);
		for (const number of ["12", "22"]) {
			fake.runner.set(
				"gh",
				[
					"pr",
					"edit",
					`#${number}`,
					"--repo",
					"github.com/acme/factory",
					"--add-label",
					"ready-for-review",
				],
				{ code: 0, stdout: "" },
			);
		}
		handOut(fake.state, pullIdentity, "pane-pull");
		handOut(fake.state, secondPullIdentity, "pane-pull2");
		fake.coordinator.start();
		await fake.advance(1000);
		fake.setAgents(idle);
		await fake.advance(3000);
		// Both tickets settle in the same walk: the side by side walk joins both
		// fires to the one in flight fetch the shared source holds. The refresh
		// holds, so neither write has run.
		expect(pulls.calls).toBe(1);
		expect(fake.runner.commands().some((c) => c.startsWith("gh pr edit"))).toBe(false);
		// The fetch answers: the refresh coordinator's one fetch per source
		// settles both fires' refreshes in the same fetch.
		pulls.settle(
			fetchSuccess([pulledPull(pullIdentity, "12"), pulledPull(secondPullIdentity, "22")]),
		);
		await tick();
		await tick();
		const settled = fake.runner.settledCommands();
		expect(settled.some((c) => c.startsWith("gh pr edit #12"))).toBe(true);
		expect(settled.some((c) => c.startsWith("gh pr edit #22"))).toBe(true);
		expect(pulls.calls).toBe(1);
		expect(fake.state.ticketWorkCycle.ticketsByState(["handed-off", "running"])).toHaveLength(0);
		stopRefresh();
		fake.coordinator.stop();
		fake.close();
	});

	test("a quiet cycle takes no fire's refresh", async () => {
		const { fake, pulls, stopRefresh } = fireRig({ pullTickets: [], issueTicket: true });
		const name = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		fake.runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([{ address: name, name, state: "live" }]),
		});
		fake.setAgents([agent("pane-implement", { agent: name })]);
		pinWait(fake, name, 60_000);
		handOut(fake.state, identity);
		fake.coordinator.start();
		// The agent's turn stays open across the grid's landings: the cycles
		// meet the working agent, take no settle, and no fire runs.
		await fake.advance(5000);
		await fake.advance(5000);
		expect(pulls.calls).toBe(0);
		stopRefresh();
		fake.coordinator.stop();
		fake.close();
	});

	test("a stop over a settling fire closes the state behind it and writes nothing after", async () => {
		const { fake, pulls, stopRefresh } = fireRig({
			pullTickets: [pulledPull(pullIdentity, "12")],
		});
		const name = fake.state.ticketWorkCycle.agentNameForTicket(pullIdentity);
		fake.runner.set("hc", ["ls", "--json", "--all"], {
			stdout: coreRosterJson([{ address: name, name, state: "live" }]),
		});
		fake.setAgents([agent("pane-pull", { agent: name, sessionId: `${name}.jsonl` })]);
		pinWait(fake, name, 3000);
		fake.runner.set(
			"gh",
			["pr", "edit", "#12", "--repo", "github.com/acme/factory", "--add-label", "ready-for-review"],
			{ code: 0, stdout: "" },
		);
		handOut(fake.state, pullIdentity, "pane-pull");
		fake.coordinator.start();
		await fake.advance(1000);
		fake.setAgents([
			agent("pane-pull", { agent: name, status: "idle", sessionId: `${name}.jsonl` }),
		]);
		await fake.advance(3000);
		// The wake settled the turn: the fire's refresh is in flight, held by
		// the source, and the write has not run.
		expect(pulls.calls).toBe(1);
		expect(fake.runner.commands().some((c) => c.startsWith("gh pr edit #12"))).toBe(false);
		// The stop lands over the settling fire: it closes the state behind the
		// in flight fetch, and the fire reads nothing after.
		const afterStop = fake.runner.commands().length;
		fake.coordinator.stop();
		stopRefresh();
		fake.close();
		// The held fetch answers into the stop: the stopped refresh applies
		// nothing to the closed state, and the fire's read of it is the closed
		// database the stop closed.
		pulls.settle(fetchSuccess([pulledPull(pullIdentity, "12")]));
		await tick();
		await tick();
		expect(fake.runner.commands()).toHaveLength(afterStop);
		expect(fake.statuses.some((s) => s.text.startsWith("observation cycle failed"))).toBe(false);
	});
});
