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
import { MergedAgentReader } from "../src/observation.ts";
import type { FactoryState } from "../src/state.ts";
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
	signal?: number;
	pid?: number | null;
	reported?: boolean;
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
		...(record.signal !== undefined && { signal: record.signal }),
		...(record.pid !== undefined && { pid: record.pid }),
		...(record.reported !== undefined && { reported: record.reported }),
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
function handOut(state: FactoryState, id: string): void {
	const claim = state.handoff.claimHandoff(id, handoffChoice, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-implement",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
}

/**
 * One in-flight ticket on the herdr-core host: the seat is the terminal the
 * run's handoff named, and the name the handoff recorded is the terminal's
 * name (ADR 0141), so the cycle's own-Agent rule stands on the identity it
 * expects.
 */
function coreHandOut(state: FactoryState, id: string, terminalName: string): void {
	const claim = state.handoff.claimHandoff(id, { ...handoffChoice, host: "herdr-core" }, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: terminalName,
		tabId: terminalName,
		workspaceId: terminalName,
		agentName: terminalName,
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
			// A kept terminal whose program died by signal holds no program in
			// the wait for its replacement shell: the row drops, the way the
			// terminal's own loss drops (ADR 0163).
			{
				record: {
					address: "t-x",
					name: "x",
					state: "live",
					reason: "signaled",
					signal: 9,
					pid: null,
				},
				agent: "dropped",
			},
			// The shell the host spawns in place of the lost program reports no
			// status: the row stays dropped while the shell stands in it.
			{
				record: {
					address: "t-x",
					name: "x",
					state: "live",
					reason: "signaled",
					pid: 4242,
					reported: false,
				},
				agent: "dropped",
			},
			// A program the operator restarts in the terminal reports a status:
			// the row stands present on the report, the session's recovery.
			{
				record: {
					address: "t-x",
					name: "x",
					state: "live",
					reason: "signaled",
					status: "working",
					pid: 4242,
					reported: true,
				},
				agent: { host: "herdr-core", name: "x", status: "working" },
			},
			// A host that writes no `reported` fact holds the terminal's
			// standing past the plane's reach: the row stays present, and the
			// plane declares no loss it cannot read.
			{
				record: {
					address: "t-x",
					name: "x",
					state: "live",
					reason: "signaled",
					pid: 4242,
				},
				agent: { host: "herdr-core", name: "x", status: "unknown" },
			},
			// A reason the host uses for no loss: the spawn's pending standing
			// keeps the row present with an unknown status, the grace the
			// cycle holds on a just-started terminal.
			{
				record: {
					address: "t-x",
					name: "x",
					state: "live",
					reason: "spawn_pending",
					pid: null,
				},
				agent: { host: "herdr-core", name: "x", status: "unknown" },
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
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
		await fake.close();
	});

	test("a kept terminal whose program is lost reads Missing, and the status moves (ADR 0163)", async () => {
		const fake = rig({ config, agentHost: CORE_HOST, autoOn: true, startupGraceMs: 1000 });
		const name = fake.state.ticketWorkCycle.agentNameForTicket(identity);
		coreHandOut(fake.state, identity, name);
		coreSeat(fake.runner, name);
		const restarts = () => fake.intents.filter((intent) => intent.origin === "restart");
		// The working seat stands: the ticket runs on the record it reads,
		// and the status the plane keeps is the record's word.
		await fake.coordinator.tick();
		await fake.advance(1001);
		await fake.coordinator.tick();
		expect(restarts()).toHaveLength(0);
		expect(inFlight(fake.state)).toBe(true);
		// The operator kept the terminal the plane started without keep: the
		// program dies by signal, the host holds the terminal live with no
		// program in it, and the record's loss reason states the loss.
		fake.runner.set("hc", ["get", "--json", name], {
			stdout: coreRecordJson({
				address: name,
				name,
				state: "live",
				reason: "signaled",
				signal: 9,
				pid: null,
			}),
		});
		await fake.coordinator.tick();
		// The status updates in the control plane: the row reads Missing, and
		// the top-up's restart stands in for the lost session, the way it
		// stands in for the terminal's own loss.
		expect(restarts()).toEqual([
			expect.objectContaining({
				automatic: true,
				ticketIdentity: identity,
				choice: expect.objectContaining({ taskType: "implement", host: "herdr-core" }),
			}),
		]);
		fake.coordinator.stop();
		await fake.close();
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
		await fake.close();
	});
});

describe("the first probe held on the settled load (issue #431, ADR 0154)", () => {
	test("the first probe lands on the settle, and the correction lands on the probe that sees the agent", async () => {
		const world = new FakeSource(
			"issues",
			"github-issues",
			fetchSuccess([fetchedTicket({ identity })]),
		);
		const pulls = new FakeSource("pulls", "github-pull-request", fetchSuccess([]));
		const fake = rig({
			config,
			autoOn: true,
			startupGraceMs: 1000,
			pollIntervalMs: 2000,
			agents: [],
			refreshSources: [world, pulls],
			// The state's boot read stands the ticket in flight, the way the
			// run booted on the previous run's handoff: the just-started
			// agent the first probe's roster lacks.
			inFlightAtBoot: [identity],
		});
		const probeTimes = () => {
			const times: number[] = [];
			fake.runner.commands().forEach((command, index) => {
				if (command === "herdr agent list") times.push(fake.commandTimes[index]);
			});
			return times;
		};
		const restarts = () => fake.intents.filter((intent) => intent.origin === "restart");

		fake.coordinator.start();
		// The start runs the sources' boot reads: yield so the reads are in
		// flight before the test settles them.
		await fake.settle();
		// The load stands: both boot reads are in flight, and the coordinator
		// holds its first cycle on the load's fact. One source settles while
		// the load still stands: the result records, and the suppressed
		// per-settlement tick runs no probe and sends no report.
		pulls.settleCurrent();
		await fake.settle();
		expect(fake.runner.commands()).toHaveLength(0);
		expect(fake.reports).toHaveLength(0);
		// The last source settles: the load settles, and the first probe
		// runs on it, after the sources' boot reads.
		world.settleCurrent();
		await fake.settle();
		expect(probeTimes()).toEqual([epoch()]);
		expect(fake.reports).toHaveLength(1);
		// The first probe's roster lacks the just-started agent. Inside the
		// startup grace the row keeps its Starting face: no Missing marker,
		// no restart, the grace pins standing on the probe that met it.
		expect(restarts()).toHaveLength(0);
		// The next probe's roster sees the agent: the correction lands on
		// the probe that sees it, without a restart and without a reland.
		fake.setAgents([agent("pane-implement")]);
		await fake.advance(2001);
		expect(probeTimes()).toEqual([epoch(), epoch() + 2000]);
		expect(restarts()).toHaveLength(0);
		expect(inFlight(fake.state)).toBe(true);
		fake.coordinator.stop();
		await fake.close();
	});

	test("the settled fact stands until the last source's first fetch settles, on a set where one fails its first read", async () => {
		const world = new FakeSource(
			"issues",
			"github-issues",
			fetchSuccess([fetchedTicket({ identity })]),
		);
		const pulls = new FakeSource("pulls", "github-pull-request", {
			status: "failed",
			reason: "the source did not answer",
		});
		const fake = rig({ config, agents: [], refreshSources: [world, pulls] });
		const refresh = fake.refresh;
		if (refresh === undefined) throw new Error("the rig named its sources");
		// The pin of the fact at the coordinator's interface (story 20): it
		// stands while any source's first fetch stands, and it resolves
		// exactly when the last one settles.
		let settled = false;
		void refresh.initialLoadSettled.then(() => {
			settled = true;
		});
		fake.coordinator.start();
		// The start runs the sources' boot reads: yield so the reads are in
		// flight before the test settles them.
		await fake.settle();
		// One source's first fetch settles: the fact stands, the other
		// source's first read still in flight.
		world.settleCurrent();
		await fake.settle();
		expect(settled).toBe(false);
		// The failed source settles last: the failed first read settles the
		// load the way a successful one does, and the fact resolves on the
		// last settlement, exactly.
		pulls.settleCurrent();
		await fake.settle();
		expect(settled).toBe(true);
		fake.coordinator.stop();
		await fake.close();
	});

	test("a failed first fetch settles the load, so a bad source holds no probe open", async () => {
		const world = new FakeSource(
			"issues",
			"github-issues",
			fetchSuccess([fetchedTicket({ identity })]),
		);
		const pulls = new FakeSource("pulls", "github-pull-request", {
			status: "failed",
			reason: "the source did not answer",
		});
		const fake = rig({
			config,
			autoOn: true,
			pollIntervalMs: 2000,
			agents: [],
			refreshSources: [world, pulls],
		});
		fake.coordinator.start();
		// The start runs the sources' boot reads: yield so the reads are in
		// flight before the test settles them.
		await fake.settle();
		// The failed source settles first: its failed read records, and the
		// load advances, so the failed first fetch marks its source done.
		pulls.settleCurrent();
		await fake.settle();
		expect(fake.runner.commands()).toHaveLength(0);
		// The good source settles: the last to settle resolves the fact, and
		// the first probe runs on the load that settled, the failed source's
		// failure standing in the state it left.
		world.settleCurrent();
		await fake.settle();
		expect(fake.runner.commands().filter((command) => command === "herdr agent list")).toHaveLength(
			1,
		);
		fake.coordinator.stop();
		await fake.close();
	});

	test("a stop settles the load, so a shutdown does not wait on a load that will not finish", async () => {
		const world = new FakeSource(
			"issues",
			"github-issues",
			fetchSuccess([fetchedTicket({ identity })]),
		);
		const fake = rig({ config, agents: [], refreshSources: [world] });
		fake.coordinator.start();
		// The source will not answer: the load stands, and no probe runs.
		expect(fake.runner.commands()).toHaveLength(0);
		fake.coordinator.stop();
		const refresh = fake.refresh;
		if (refresh === undefined) throw new Error("the rig named its sources");
		refresh.stop();
		// The fact resolves on the stop: a held probe or a held list move
		// does not hold the shutdown open.
		await refresh.initialLoadSettled;
		expect(fake.runner.commands()).toHaveLength(0);
		await fake.close();
	});
});

describe("the held turn's recovery", () => {
	test("a recovered agent revives the awaiting ticket's turn, and the next settle refreshes it", async () => {
		const fake = rig({
			config,
			agentHost: CORE_HOST,
			autoOn: false,
			startupGraceMs: 1000,
			// The settled turn's log stands on the record the host derives:
			// the turn ends without completing, so its settle holds.
			turnLogs: async () => ({
				kind: "ended" as const,
				turnEnd: {
					log: [{ kind: "text" as const, text: "the turn held" }],
					cause: "aborted" as const,
					detail: "",
				},
			}),
			sessionRecord: () => ({ kind: "path" as const, path: "/fake/session.jsonl" }),
		});
		coreHandOut(fake.state, identity, "t2n");
		coreSeat(fake.runner, "t2n");
		// The agent works: the tick moves the handoff to running.
		await fake.coordinator.tick();
		expect(fake.state.ticketWorkCycle.ticketState(identity)).toBe("running");
		// The turn ends without completing: the settle holds it, and the
		// ticket rests at awaiting.
		fake.runner.set("hc", ["get", "--json", "t2n"], {
			stdout: coreRecordJson({ address: "t2n", name: "t2n", state: "live", status: "idle" }),
		});
		await fake.advance(1001);
		await fake.coordinator.tick();
		expect(fake.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
		// The operator re-prompts the Agent: it works again, and the next
		// cycle revives the ticket's turn, so the status moves.
		fake.runner.set("hc", ["get", "--json", "t2n"], {
			stdout: coreRecordJson({ address: "t2n", name: "t2n", state: "live", status: "working" }),
		});
		await fake.coordinator.tick();
		expect(fake.state.ticketWorkCycle.ticketState(identity)).toBe("running");
		// The recovered turn ends the same way: the ticket rests at awaiting
		// again, on the refreshed turn's facts.
		fake.runner.set("hc", ["get", "--json", "t2n"], {
			stdout: coreRecordJson({ address: "t2n", name: "t2n", state: "live", status: "idle" }),
		});
		await fake.coordinator.tick();
		expect(fake.state.ticketWorkCycle.ticketState(identity)).toBe("awaiting");
		fake.coordinator.stop();
		await fake.close();
	});
});
