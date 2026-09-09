/**
 * The Handoff dispatch module tests: the seat, the queues, the durable settle,
 * the Close cleanup, the Clear action, and the name fact, all through the
 * module interface.
 *
 * Every test drives `createHandoffDispatch` with the fake runner, an in-memory
 * state database, and a gate that holds one herdr command until the test lets
 * it go, so the seat holds while the next work queues behind it. No test mounts
 * a terminal or reads a frame. The assertions read the facts that stand outside
 * the seam: what the module reported and returned, and what the durable state
 * holds afterwards.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { baseChoice, type HandoffChoice, type NameCollision } from "../src/handoff.ts";
import type { HandoffDispatchOptions } from "../src/handoff-dispatch.ts";
import {
	createHandoffDispatch,
	type DispatchResult,
	type HandoffDispatch,
	type HandoffDispatchReports,
	reportHandoffOutcome,
	type StoredHandoffFacts,
} from "../src/handoff-dispatch.ts";
import type { CommandRunner } from "../src/runner.ts";
import { FactoryState, type HandoffOrigin } from "../src/state.ts";
import {
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
	worktreeOpenJson,
} from "./fake-runner.ts";
import { gatedRunner } from "./gated-runner.ts";

const source = { name: "issues", kind: "github-issues" } as const;

/** One ticket, its stable herdr agent name, and the handles of its own cycle. */
interface Seed {
	identity: string;
	title: string;
	/** The stable herdr name a handoff of this ticket asks for first. */
	name: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
}

const FIRST: Seed = {
	identity: "github:github.com:I_5",
	title: "Add a webhook retry policy",
	name: "add-a-webhook-retry-policy",
	paneId: "pane-1",
	tabId: "tab-1",
	workspaceId: "ws-1",
};

const SECOND: Seed = {
	identity: "github:github.com:I_6",
	title: "Close the stale deploy branch",
	name: "close-the-stale-deploy-branch",
	paneId: "pane-2",
	tabId: "tab-2",
	workspaceId: "ws-2",
};

const THIRD: Seed = {
	identity: "github:github.com:I_7",
	title: "Reconcile the source list",
	name: "reconcile-the-source-list",
	paneId: "pane-3",
	tabId: "tab-3",
	workspaceId: "ws-3",
};

/** The Agent, environment, and Task profile every handoff in this file starts. */
const liveChoice: HandoffChoice = baseChoice("pi", "live-worktree", "implement");
const worktreeChoice: HandoffChoice = baseChoice("pi", "worktree", "implement");

function issueTicket(seed: Seed): FetchedTicket {
	return {
		identity: seed.identity,
		sourceKind: "github-issue",
		externalKey: `#${seed.identity.slice(-1)}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${seed.identity.slice(-1)}`,
		title: seed.title,
		description: "The body the agent reads.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

interface Rig {
	state: FactoryState;
	/** The herdr and git answers the module's work meets. */
	runner: FakeRunner;
	dispatch: HandoffDispatch;
	config: FactoryConfig;
	home: string;
	checkout: string;
	/** Every Message-line and projection fact the module reported, in order. */
	events: string[];
	/** Hold every command that starts with one of these prefixes, until released. */
	hold: (...prefixes: string[]) => void;
	/** Let the oldest held command answer herdr. */
	release: () => void;
	/** True while at least one command waits inside the gate. */
	busy: () => boolean;
	/** How many commands the gate has held so far. */
	arrivals: () => number;
	/** Resolve when at least this many commands have reached the gate. */
	waitForArrivals: (count: number) => Promise<void>;
	/** The commands the gate held, in arrival order. */
	held: () => string[];
	/** Every command the fake answered, in order. */
	commands: () => string[];
	/** Record and await the start report for a ticket. */
	reportStarted: (identity: string, result: DispatchResult) => void;
	waitForStarted: (identity: string) => Promise<DispatchResult>;
}

function recorder(events: string[]): HandoffDispatchReports {
	return {
		working: (text) => events.push(`working:${text}`),
		warning: (text) => events.push(`warning:${text}`),
		error: (text) => events.push(`error:${text}`),
		clearWorking: () => events.push("clear-working"),
		refresh: () => events.push("refresh"),
	};
}

const openStates: FactoryState[] = [];
const homes: string[] = [];

afterEach(() => {
	for (const state of openStates.splice(0)) state.close();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/**
 * One module, one in-memory state, and the tickets named in `seeds`.
 *
 * The runner answers a live-worktree handoff out of the box: no workspace holds
 * the checkout yet, so the handoff builds one and adds a tab inside it. The
 * agent start and the prompt answer with the fake's clean default, and the
 * gate holds nothing until a test asks for a command by prefix.
 */
function rig(seeds: readonly Seed[] = [FIRST]): Rig {
	const home = mkdtempSync(join(tmpdir(), "factory-handoff-dispatch-"));
	homes.push(home);
	const checkout = join(home, "src", "factory");
	mkdirSync(checkout, { recursive: true });
	const runner = new FakeRunner();
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
	runner.set("git", ["-C", checkout, "rev-parse", "HEAD"], { stdout: "abcdef\n" });
	const config: FactoryConfig = {
		...DEFAULT_CONFIG,
		sources: [
			{
				name: "issues",
				kind: "github-issues",
				refreshIntervalSeconds: 60,
				repositories: ["acme/factory"],
				host: "github.com",
			},
		],
		repos: { "github.com/acme/factory": checkout },
	};
	const state = new FactoryState(":memory:");
	openStates.push(state);
	state.initializeSources([source]);
	state.applyFetch(source, {
		status: "success",
		fetchedAt: "2026-09-01T00:00:00Z",
		tickets: seeds.map(issueTicket),
	});
	const events: string[] = [];
	const prefixes: string[] = [];
	const startedResults = new Map<string, DispatchResult[]>();
	const startedWaiters = new Map<string, Array<(result: DispatchResult) => void>>();
	const reportStarted = (identity: string, result: DispatchResult): void => {
		const waiter = startedWaiters.get(identity)?.shift();
		if (waiter !== undefined) waiter(result);
		else startedResults.set(identity, [...(startedResults.get(identity) ?? []), result]);
	};
	const waitForStarted = (identity: string): Promise<DispatchResult> => {
		const result = startedResults.get(identity)?.shift();
		if (result !== undefined) return Promise.resolve(result);
		return new Promise<DispatchResult>((resolve) =>
			startedWaiters.set(identity, [...(startedWaiters.get(identity) ?? []), resolve]),
		);
	};
	const gate = gatedRunner(runner, (command) =>
		prefixes.some((prefix) => command.startsWith(prefix)),
	);
	const dispatch = createHandoffDispatch({
		state,
		runner: gate.runner,
		config: () => config,
		home,
		...recorder(events),
	});
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson(FIRST.workspaceId, "pane-root"),
	});
	runner.set(
		"herdr",
		["tab", "create", "--workspace", FIRST.workspaceId, "--cwd", checkout, "--no-focus"],
		{ stdout: tabCreateJson("pane-agent", "tab-agent") },
	);
	return {
		state,
		runner,
		dispatch,
		config,
		home,
		checkout,
		events,
		hold: (...newPrefixes: string[]) => prefixes.push(...newPrefixes),
		release: gate.release,
		busy: gate.busy,
		arrivals: gate.arrivals,
		waitForArrivals: gate.waitForArrivals,
		held: gate.heldCommands,
		commands: () => runner.commands(),
		reportStarted,
		waitForStarted,
	};
}

/**
 * A module over the same state and Message recorder, with the runner and the
 * report hooks a test needs to break.
 */
function withRunner(
	rig: Rig,
	runner: CommandRunner,
	overrides: Partial<HandoffDispatchOptions> = {},
): HandoffDispatch {
	return createHandoffDispatch({
		state: rig.state,
		runner,
		config: () => rig.config,
		home: rig.home,
		...recorder(rig.events),
		...overrides,
	});
}

/** The dispatch of one intent, with the claim's answer awaited. */
function start(
	rig: Rig,
	seed: Seed,
	origin: HandoffOrigin = "open",
	onStarted?: (started: DispatchResult) => void,
	choice: HandoffChoice = liveChoice,
): Promise<DispatchResult> {
	return rig.dispatch.dispatch({
		origin,
		ticketIdentity: seed.identity,
		choice,
		previousMessage: origin === "open" ? "" : "the last message",
		onStarted: (result) => {
			rig.reportStarted(seed.identity, result);
			onStarted?.(result);
		},
	});
}

/** Let the `held`-th command the gate is holding answer. */
async function releaseHeld(rig: Rig, held: number): Promise<void> {
	await rig.waitForArrivals(held);
	rig.release();
}

/** Let cleanup and its recursive drain finish their microtasks. */
async function seatReleased(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/** A clean live-worktree handoff, awaited to the settle that moved the ticket. */
async function handOff(rig: Rig, seed: Seed): Promise<StoredHandoffFacts> {
	await expect(start(rig, seed, "open")).resolves.toEqual({ ok: true });
	await rig.waitForStarted(seed.identity);
	const stored = rig.state.latestHandoff(seed.identity);
	if (stored === null) throw new Error("the handoff left no record");
	return stored;
}

/**
 * A handoff record the test wrote straight into the state: the handles of a
 * cycle of its own, so a cleanup or a clear names an environment the test
 * chose. A ticket can hold several: every claim after the first restarts the
 * cycle that is already in flight.
 */
function seedHandoff(
	rig: Rig,
	seed: Seed,
	choice: HandoffChoice = liveChoice,
	over: Partial<StoredHandoffFacts & { paneId: string | null }> = {},
): StoredHandoffFacts {
	const origin: HandoffOrigin =
		rig.state.ticketState(seed.identity) === "open" ? "open" : "restart";
	const handles = {
		environment: choice.environment,
		paneId: seed.paneId as string | null,
		tabId: seed.tabId as string | null,
		workspaceId: seed.workspaceId as string | null,
		...over,
	};
	const claim = rig.state.claimHandoff(seed.identity, choice, origin);
	if (!claim.ok) throw new Error(`the seed claim failed: ${claim.reason}`);
	rig.state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: handles.paneId,
		tabId: handles.tabId,
		workspaceId: handles.workspaceId,
	});
	return {
		handoffId: claim.claim.attemptId,
		environment: handles.environment,
		tabId: handles.tabId,
		workspaceId: handles.workspaceId,
	};
}

/** End the work cycle one handoff ran: the ticket is open again. */
function closeCycle(rig: Rig, seed: Seed, handoffId: string): void {
	rig.state.settleTurn({
		ticketIdentity: seed.identity,
		handoffId,
		taskType: liveChoice.taskType,
		agentType: liveChoice.agentType,
		message: "the turn is done",
		turnLog: [{ kind: "text", text: "the turn is done" }],
		completedAt: "2026-09-01T01:00:00Z",
	});
	rig.state.applyCompletionDecision({
		ticketIdentity: seed.identity,
		handoffId,
		decision: "closed",
		decidedAt: "2026-09-01T01:00:00Z",
	});
}

/**
 * A handoff of a cycle that already closed: the record a Close cleanup of an
 * ended cycle, a Clear action, or the next handoff works on.
 */
function seedClosedHandoff(
	rig: Rig,
	seed: Seed,
	choice: HandoffChoice = liveChoice,
	over: Partial<StoredHandoffFacts & { paneId: string | null }> = {},
): StoredHandoffFacts {
	const stored = seedHandoff(rig, seed, choice, over);
	closeCycle(rig, seed, stored.handoffId);
	return stored;
}

/** Rest the ticket on its settled turn, awaiting a route, without closing it. */
function settleTurn(rig: Rig, seed: Seed, handoffId: string): void {
	rig.state.settleTurn({
		ticketIdentity: seed.identity,
		handoffId,
		taskType: liveChoice.taskType,
		agentType: liveChoice.agentType,
		message: "the turn is done",
		turnLog: [{ kind: "text", text: "the turn is done" }],
		completedAt: "2026-09-01T01:00:00Z",
	});
}

/** The Message line a handoff of this ticket writes when it starts. */
function workingLine(seed: Seed, title = seed.title): string {
	return `working:handing off "${title}"...`;
}

/** The agent start of a live-worktree handoff in the rig's own tab. */
function agentStart(name: string): string {
	return `herdr agent start ${name} --kind pi --pane pane-agent`;
}

/** herdr 0.8.2 refuses a name one of its own agents already holds. */
function nameTaken(name: string, holders: { paneId: string; workspaceId: string }[]): string {
	const candidates = holders
		.map(
			(holder) =>
				`terminal_id=term-${holder.paneId} pane_id=${holder.paneId} workspace_id=${holder.workspaceId} tab_id=tab-${holder.paneId} cwd=unknown status=Idle`,
		)
		.join(", ");
	return `{"error":{"code":"agent_name_taken","message":"agent name ${name} is already used; candidates: ${candidates}"},"id":"cli:agent:start"}\n`;
}

describe("the seat", () => {
	test("one handoff holds the seat, and the next waits behind it", async () => {
		const rigRef = rig([FIRST, SECOND]);
		rigRef.hold("herdr agent start");
		await expect(start(rigRef, FIRST, "open")).resolves.toEqual({ ok: true });
		expect(rigRef.dispatch.handoffActive()).toBe(true);
		await expect(start(rigRef, SECOND, "open")).resolves.toEqual({ ok: true });
		await rigRef.waitForArrivals(1);
		// The claim moved the second ticket at once, and its work waits: herdr
		// has heard of one agent, not two.
		expect(rigRef.held()).toEqual([agentStart(FIRST.name)]);
		await releaseHeld(rigRef, 1);
		await releaseHeld(rigRef, 2);
		await rigRef.waitForStarted(SECOND.identity);
		// Claim order: the ticket that queued first is the second agent herdr starts.
		expect(rigRef.held()).toEqual([agentStart(FIRST.name), agentStart(SECOND.name)]);
	});

	test("a Close cleanup queues behind the handoff in flight", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const stored = seedClosedHandoff(rigRef, SECOND);
		rigRef.hold("herdr workspace list");
		const started = start(rigRef, FIRST, "open");
		expect(rigRef.dispatch.handoffActive()).toBe(true);
		const cleanup = rigRef.dispatch.closeCleanup(SECOND.identity, stored, "closed");
		await rigRef.waitForArrivals(1);
		// The cleanup holds the seat it reserved, but herdr hears no removal
		// while the handoff is half built.
		expect(rigRef.held()).toEqual(["herdr workspace list"]);
		rigRef.release();
		await expect(cleanup).resolves.toBeUndefined();
		await started;
		await rigRef.waitForStarted(FIRST.identity);
		// The seat kept its promise: the agent was built before herdr took the
		// other environment away.
		expect(rigRef.commands().indexOf(agentStart(FIRST.name))).toBeLessThan(
			rigRef.commands().indexOf(`herdr tab close ${stored.tabId}`),
		);
	});

	test("a handoff queues behind a queued Close cleanup", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const stored = seedClosedHandoff(rigRef, SECOND);
		rigRef.hold("herdr tab close");
		const cleanup = rigRef.dispatch.closeCleanup(SECOND.identity, stored, "closed");
		await rigRef.waitForArrivals(1);
		await expect(start(rigRef, FIRST, "open")).resolves.toEqual({ ok: true });
		// The cleanup reserved the seat the moment it queued: the handoff the
		// operator starts beside it builds nothing yet.
		expect(rigRef.held()).toEqual([`herdr tab close ${stored.tabId}`]);
		rigRef.release();
		expect(await cleanup).toBeUndefined();
		await rigRef.waitForStarted(FIRST.identity);
		const commands = rigRef.commands();
		// The order is the whole fact: herdr takes the tab away, and only then
		// builds the new agent.
		expect(commands.indexOf(`herdr tab close ${stored.tabId}`)).toBeLessThan(
			commands.indexOf(agentStart(FIRST.name)),
		);
	});

	test("Close cleanups run one at a time behind each other", async () => {
		const rigRef = rig([FIRST, SECOND, THIRD]);
		const first = seedHandoff(rigRef, FIRST);
		const second = seedHandoff(rigRef, SECOND);
		const third = seedHandoff(rigRef, THIRD);
		rigRef.hold("herdr tab close");
		const cleanups = [
			rigRef.dispatch.closeCleanup(FIRST.identity, first, "closed"),
			rigRef.dispatch.closeCleanup(SECOND.identity, second, "closed"),
			rigRef.dispatch.closeCleanup(THIRD.identity, third, "closed"),
		];
		await rigRef.waitForArrivals(1);
		// One removal at a time: herdr never takes two environments away in one
		// breath, and no handoff can drain between them.
		expect(rigRef.held()).toEqual([`herdr tab close ${FIRST.tabId}`]);
		await releaseHeld(rigRef, 1);
		await rigRef.waitForArrivals(2);
		expect(rigRef.held()).toEqual([
			`herdr tab close ${FIRST.tabId}`,
			`herdr tab close ${SECOND.tabId}`,
		]);
		await releaseHeld(rigRef, 2);
		await releaseHeld(rigRef, 3);
		for (const cleanup of cleanups) await expect(cleanup).resolves.toBeUndefined();
		expect(rigRef.commands().filter((c) => c.startsWith("herdr tab close"))).toEqual([
			`herdr tab close ${FIRST.tabId}`,
			`herdr tab close ${SECOND.tabId}`,
			`herdr tab close ${THIRD.tabId}`,
		]);
	});

	test("two handoffs wait behind the one in flight, and take the seat one at a time", async () => {
		const rigRef = rig([FIRST, SECOND, THIRD]);
		rigRef.hold("herdr agent start");
		await start(rigRef, FIRST, "open");
		await start(rigRef, SECOND, "open");
		await start(rigRef, THIRD, "open");
		await rigRef.waitForArrivals(1);
		await releaseHeld(rigRef, 1);
		await rigRef.waitForArrivals(2);
		expect(rigRef.held()).toEqual([agentStart(FIRST.name), agentStart(SECOND.name)]);
		await releaseHeld(rigRef, 2);
		await rigRef.waitForArrivals(3);
		await releaseHeld(rigRef, 3);
		await rigRef.waitForStarted(THIRD.identity);
		expect(rigRef.held()).toEqual([
			agentStart(FIRST.name),
			agentStart(SECOND.name),
			agentStart(THIRD.name),
		]);
	});

	test("a cleanup's answer reaches its caller before the next handoff writes its line", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const stored = seedClosedHandoff(rigRef, SECOND);
		rigRef.runner.set("herdr", ["tab", "close", SECOND.tabId], { code: 1, stderr: "tab is busy" });
		rigRef.hold("herdr tab close");
		const cleanup = rigRef.dispatch
			.closeCleanup(SECOND.identity, stored, "closed")
			.then((failure) => {
				// The operator's Close words the failure the module answered with.
				if (failure !== undefined) rigRef.events.push(`error:${failure}`);
			});
		await rigRef.waitForArrivals(1);
		const started = start(rigRef, FIRST, "open");
		rigRef.release();
		await Promise.all([cleanup, started]);
		await rigRef.waitForStarted(FIRST.identity);
		// The failed cleanup is on the line first, and the next handoff's
		// Working line is the last fact written over it: the order this code had
		// before the module, pinned so a drain rewrite cannot invert it.
		const reported = rigRef.events.indexOf("error:tab is busy");
		expect(reported).toBeGreaterThanOrEqual(0);
		expect(rigRef.events.lastIndexOf(workingLine(FIRST))).toBeGreaterThan(reported);
	});
});

describe("the queue drain", () => {
	test("a queued handoff whose ticket moved on fails, and the queue keeps draining", async () => {
		const rigRef = rig([FIRST, SECOND, THIRD]);
		const second = seedHandoff(rigRef, SECOND);
		settleTurn(rigRef, SECOND, second.handoffId);
		const secondStarted: DispatchResult[] = [];
		const thirdStarted: DispatchResult[] = [];
		rigRef.hold("herdr agent start");
		await start(rigRef, FIRST, "open");
		await expect(
			start(rigRef, SECOND, "workflow", (r) => secondStarted.push(r), {
				...liveChoice,
				taskType: "review",
			}),
		).resolves.toEqual({ ok: true });
		await expect(start(rigRef, THIRD, "open", (r) => thirdStarted.push(r))).resolves.toEqual({
			ok: true,
		});
		// The middle ticket's awaited turn closes while it waits: the handoff
		// that queued for its route has nothing to start.
		closeCycle(rigRef, SECOND, second.handoffId);
		await releaseHeld(rigRef, 1);
		await releaseHeld(rigRef, 2);
		await rigRef.waitForStarted(THIRD.identity);
		// The moved-on ticket settled its claim as failed, on the line and on
		// the report its caller waited for.
		expect(rigRef.state.ticketState(SECOND.identity)).toBe("open");
		expect(secondStarted).toEqual([{ ok: false, reason: "the queued handoff was not run" }]);
		expect(rigRef.events).toContain(
			`warning:queued handoff for "${SECOND.title}" was not run: the ticket is now open`,
		);
		// The drain did not stop at the failure: the third claim ran, and herdr
		// heard two agents, not three.
		expect(thirdStarted).toEqual([{ ok: true }]);
		expect(rigRef.held()).toEqual([agentStart(FIRST.name), agentStart(THIRD.name)]);
	});

	test("a queued handoff runs on the ticket the state holds when its turn comes", async () => {
		const rigRef = rig([FIRST, SECOND]);
		rigRef.hold("herdr agent start");
		await start(rigRef, FIRST, "open");
		await start(rigRef, SECOND, "open");
		// The source renames the queued ticket while it waits: the handoff runs
		// on the fresh projection, and the line the operator reads says so.
		const renamed = { ...SECOND, title: "Close the renamed deploy branch" };
		rigRef.state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-09-01T03:00:00Z",
			tickets: [issueTicket(FIRST), issueTicket(renamed)],
		});
		await releaseHeld(rigRef, 1);
		await rigRef.waitForArrivals(2);
		await releaseHeld(rigRef, 2);
		await rigRef.waitForStarted(SECOND.identity);
	});

	test("a queued workflow handoff runs while its ticket still awaits its route", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const second = seedHandoff(rigRef, SECOND);
		settleTurn(rigRef, SECOND, second.handoffId);
		rigRef.hold("herdr agent start");
		await start(rigRef, FIRST, "open");
		await start(rigRef, SECOND, "workflow", undefined, { ...liveChoice, taskType: "review" });
		await releaseHeld(rigRef, 1);
		await releaseHeld(rigRef, 2);
		await rigRef.waitForStarted(SECOND.identity);
		expect(rigRef.held()).toEqual([agentStart(FIRST.name), agentStart(SECOND.name)]);
	});

	test("a queued restart runs while its ticket is still in flight", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const second = seedHandoff(rigRef, SECOND);
		const started: DispatchResult[] = [];
		rigRef.hold("herdr agent start");
		await start(rigRef, FIRST, "open");
		await start(rigRef, SECOND, "restart", (r) => started.push(r));
		await releaseHeld(rigRef, 1);
		await releaseHeld(rigRef, 2);
		await rigRef.waitForStarted(SECOND.identity);
		expect(started).toEqual([{ ok: true }]);
		// The seat came to the restart, and the agent herdr started belongs to a
		// new handoff of the same cycle.
		expect(rigRef.state.latestHandoff(SECOND.identity)?.handoffId).not.toBe(second.handoffId);
	});

	test("a queued restart runs while its agent works", async () => {
		const rigRef = rig([FIRST, SECOND]);
		seedHandoff(rigRef, SECOND);
		// The observation corrected the ticket to running: a restart waits on the
		// seat like any other handoff, and the seat still answers for it.
		expect(rigRef.state.markTicketRunning(SECOND.identity)).toBe(true);
		rigRef.hold("herdr agent start");
		await start(rigRef, FIRST, "open");
		await start(rigRef, SECOND, "restart");
		await releaseHeld(rigRef, 1);
		await releaseHeld(rigRef, 2);
		await rigRef.waitForArrivals(2);
		expect(rigRef.held()).toEqual([agentStart(FIRST.name), agentStart(SECOND.name)]);
		await rigRef.waitForStarted(SECOND.identity);
	});

	test("a queued restart of a ticket whose cycle closed while it waited fails", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const second = seedHandoff(rigRef, SECOND);
		rigRef.hold("herdr agent start");
		await start(rigRef, FIRST, "open");
		await start(rigRef, SECOND, "restart");
		settleTurn(rigRef, SECOND, second.handoffId);
		closeCycle(rigRef, SECOND, second.handoffId);
		await releaseHeld(rigRef, 1);
		await rigRef.waitForStarted(FIRST.identity);
		expect(rigRef.state.ticketState(SECOND.identity)).toBe("open");
		expect(rigRef.events).toContain(
			`warning:queued handoff for "${SECOND.title}" was not run: the ticket is now open`,
		);
		// The closed cycle's restart never reached herdr.
		expect(rigRef.held()).toEqual([agentStart(FIRST.name)]);
	});
});

describe("the claim, the settle, and every origin", () => {
	test("an open handoff settles the attempt, and its start report fires once and last", async () => {
		const rigRef = rig();
		const started: DispatchResult[] = [];
		await expect(
			start(rigRef, FIRST, "open", (result) => {
				started.push(result);
				rigRef.events.push("started");
			}),
		).resolves.toEqual({ ok: true });
		await rigRef.waitForStarted(FIRST.identity);
		expect(started).toEqual([{ ok: true }]);
		// The start report is the last fact of the handoff: the settle, the
		// projection refresh, and the status line all stand before it.
		expect(rigRef.events[rigRef.events.length - 1]).toBe("started");
		expect(rigRef.events.indexOf("refresh")).toBeLessThan(rigRef.events.indexOf("clear-working"));
		expect(rigRef.events.indexOf("clear-working")).toBeLessThan(rigRef.events.length - 1);
		expect(rigRef.dispatch.handoffActive()).toBe(false);
	});

	test("an open handoff herdr refuses settles as failed and releases the seat", async () => {
		const rigRef = rig();
		rigRef.runner.set("herdr", ["workspace", "list"], { code: 1, stderr: "herdr is unavailable" });
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "open", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		expect(await rigRef.waitForStarted(FIRST.identity)).toEqual({
			ok: false,
			reason: "herdr is unavailable",
		});
		expect(started).toEqual([{ ok: false, reason: "herdr is unavailable" }]);
		expect(rigRef.events).toContain("error:herdr is unavailable");
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("open");
		expect(rigRef.dispatch.handoffActive()).toBe(false);
	});

	test("a workflow handoff settles the agent it started in the stored workspace", async () => {
		const rigRef = rig();
		const stored = await handOff(rigRef, FIRST);
		settleTurn(rigRef, FIRST, stored.handoffId);
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("awaiting");
		// The stored workspace still holds, so the reuse starts a fresh tab in it.
		rigRef.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: FIRST.workspaceId, checkoutPath: rigRef.checkout }]),
		});
		rigRef.runner.set("herdr", ["tab", "create", "--workspace", FIRST.workspaceId, "--no-focus"], {
			stdout: tabCreateJson("pane-route", "tab-route"),
		});
		const started: DispatchResult[] = [];
		await expect(
			start(rigRef, FIRST, "workflow", (r) => started.push(r), {
				...liveChoice,
				taskType: "review",
			}),
		).resolves.toEqual({ ok: true });
		await rigRef.waitForStarted(FIRST.identity);
		expect(started).toEqual([{ ok: true }]);
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("handed-off");
		expect(rigRef.commands()).toContain(
			`herdr agent start ${FIRST.name} --kind pi --pane pane-route`,
		);
		// The routed handoff closed the tab of the turn it routes from.
		expect(rigRef.commands()).toContain(`herdr tab close ${stored.tabId}`);
	});

	test("a workflow handoff that never started settles as failed", async () => {
		const rigRef = rig();
		const stored = seedHandoff(rigRef, FIRST);
		settleTurn(rigRef, FIRST, stored.handoffId);
		rigRef.runner.set("herdr", ["workspace", "list"], { code: 1, stderr: "herdr is gone" });
		const started: DispatchResult[] = [];
		await expect(
			start(rigRef, FIRST, "workflow", (r) => started.push(r), {
				...liveChoice,
				taskType: "review",
			}),
		).resolves.toEqual({ ok: true });
		expect(await rigRef.waitForStarted(FIRST.identity)).toEqual({
			ok: false,
			reason: "herdr is gone",
		});
		expect(started).toEqual([{ ok: false, reason: "herdr is gone" }]);
		expect(rigRef.events).toContain("error:herdr is gone");
		// The failed settle leaves the ticket where the claim left it: awaiting
		// its route still, with the reason on the line.
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("awaiting");
		expect(rigRef.dispatch.handoffActive()).toBe(false);
	});

	test("a restart settles the agent it started", async () => {
		const rigRef = rig();
		await handOff(rigRef, FIRST);
		rigRef.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: FIRST.workspaceId, checkoutPath: rigRef.checkout }]),
		});
		rigRef.runner.set("herdr", ["tab", "create", "--workspace", FIRST.workspaceId, "--no-focus"], {
			stdout: tabCreateJson("pane-again", "tab-again"),
		});
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "restart", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		await rigRef.waitForStarted(FIRST.identity);
		expect(started).toEqual([{ ok: true }]);
		expect(rigRef.commands()).toContain(
			`herdr agent start ${FIRST.name} --kind pi --pane pane-again`,
		);
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("handed-off");
	});

	test("a restart of a worktree cycle reopens the ticket's own branch", async () => {
		const rigRef = rig();
		seedHandoff(rigRef, FIRST, worktreeChoice);
		// herdr no longer holds the stored workspace: the restart takes the
		// ticket's branch, not a fresh environment built at the checkout.
		rigRef.runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		const branch = "factory/5-add-a-webhook-retry-policy";
		const worktreePath = join(rigRef.checkout, "wt");
		rigRef.runner.set(
			"herdr",
			["worktree", "open", "--cwd", rigRef.checkout, "--branch", branch, "--no-focus"],
			{
				stdout: worktreeOpenJson(FIRST.workspaceId, "pane-worktree", {
					alreadyOpen: true,
					worktreePath,
				}),
			},
		);
		rigRef.runner.set(
			"herdr",
			["tab", "create", "--workspace", FIRST.workspaceId, "--cwd", worktreePath, "--no-focus"],
			{ stdout: tabCreateJson("pane-in-wt", "tab-in-wt") },
		);
		const started: DispatchResult[] = [];
		await expect(
			start(rigRef, FIRST, "restart", (r) => started.push(r), worktreeChoice),
		).resolves.toEqual({ ok: true });
		await rigRef.waitForStarted(FIRST.identity);
		expect(started).toEqual([{ ok: true }]);
		expect(rigRef.commands()).toContain(
			`herdr worktree open --cwd ${rigRef.checkout} --branch ${branch} --no-focus`,
		);
		expect(rigRef.commands()).toContain(
			`herdr agent start ${FIRST.name} --kind pi --pane pane-in-wt`,
		);
		expect(rigRef.commands()).not.toContain(
			`herdr workspace create --cwd ${rigRef.checkout} --no-focus`,
		);
	});

	test("a restart herdr refuses settles as failed and releases the seat", async () => {
		const rigRef = rig();
		await handOff(rigRef, FIRST);
		rigRef.runner.set("herdr", ["workspace", "list"], {
			code: 1,
			stderr:
				'{"error":{"code":"ipc_timeout","message":"herdr did not answer"},"id":"cli:workspace:list"}\n',
		});
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "restart", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		expect(await rigRef.waitForStarted(FIRST.identity)).toEqual({
			ok: false,
			reason: "herdr did not answer (ipc_timeout)",
		});
		expect(started).toEqual([{ ok: false, reason: "herdr did not answer (ipc_timeout)" }]);
		expect(rigRef.events).toContain("error:herdr did not answer (ipc_timeout)");
		expect(rigRef.dispatch.handoffActive()).toBe(false);
	});

	test("a claim herdr refuses starts nothing and answers with the claim's reason", async () => {
		const rigRef = rig();
		await handOff(rigRef, FIRST);
		await expect(start(rigRef, FIRST, "open")).resolves.toEqual({
			ok: false,
			reason: expect.stringContaining("only open tickets can be handed off"),
		});
		expect(rigRef.events.filter((event) => event.startsWith("working:"))).toHaveLength(1);
	});

	test("a handoff of a ticket the state no longer holds is refused", async () => {
		const rigRef = rig();
		rigRef.state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-09-02T00:00:00Z",
			tickets: [],
		});
		await expect(start(rigRef, FIRST, "open")).resolves.toEqual({
			ok: false,
			reason: "the ticket no longer exists",
		});
		expect(rigRef.dispatch.handoffActive()).toBe(false);
	});

	test("handoff work that throws settles as failed and gives the seat back", async () => {
		const rigRef = rig([FIRST, SECOND]);
		// The throw is outside every outcome herdr can write: the prompt call
		// itself breaks on the way to the pane.
		let broken = false;
		const throwing: CommandRunner = {
			run: (command, args, options) => {
				if (command === "herdr" && args[0] === "agent" && args[1] === "prompt" && !broken) {
					broken = true;
					return Promise.reject(new Error("the pipe broke"));
				}
				return rigRef.runner.run(command, args, options);
			},
			listModels: (kind) => rigRef.runner.listModels(kind),
		};
		rigRef.dispatch = withRunner(rigRef, throwing);
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "open", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		// A second claim queues behind the one that is about to break: the drain
		// the failed settle runs is the only thing that starts it.
		await expect(start(rigRef, SECOND, "open")).resolves.toEqual({ ok: true });
		expect(await rigRef.waitForStarted(FIRST.identity)).toEqual({
			ok: false,
			reason: "the pipe broke",
		});
		expect(started).toEqual([{ ok: false, reason: "the pipe broke" }]);
		// The failure ends the handoff's own progress line and states its reason,
		// and the refresh of the projection it changed comes first.
		const failedAt = rigRef.events.indexOf("error:handoff failed: the pipe broke");
		expect(failedAt).toBeGreaterThan(0);
		expect(rigRef.events.slice(0, failedAt)).toContain("refresh");
		expect(rigRef.events.slice(0, failedAt)).toContain("clear-working");
		// The ticket stays where the claim left it: nothing started.
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("open");
		// And the handoff behind it ran: a throw cannot deadlock the seat.
		await rigRef.waitForStarted(SECOND.identity);
		// The queued handoff settles the second claim before its final drain
		// releases the seat. Wait for that drain before reading the seat.
		await seatReleased();
		expect(rigRef.dispatch.handoffActive()).toBe(false);
	});

	test("a throwing Working report cannot lose the queued handoff", async () => {
		const rigRef = rig([FIRST, SECOND]);
		// The first handoff settles, then its drain reaches the second claim. The
		// renderer disappears while the second Working line is reported. Reporting
		// is best effort, so the queued durable claim must still settle.
		const started: DispatchResult[] = [];
		const secondStarted: DispatchResult[] = [];
		const dispatch = withRunner(rigRef, rigRef.runner, {
			working: (text) => {
				if (text.includes(SECOND.title)) throw new Error("the renderer is gone");
				rigRef.events.push(`working:${text}`);
			},
		});
		await expect(
			dispatch.dispatch({
				origin: "open",
				ticketIdentity: FIRST.identity,
				choice: liveChoice,
				previousMessage: "",
				onStarted: (result) => {
					rigRef.reportStarted(FIRST.identity, result);
					started.push(result);
				},
			}),
		).resolves.toEqual({ ok: true });
		await expect(
			dispatch.dispatch({
				origin: "open",
				ticketIdentity: SECOND.identity,
				choice: liveChoice,
				previousMessage: "",
				onStarted: (result) => {
					rigRef.reportStarted(SECOND.identity, result);
					secondStarted.push(result);
				},
			}),
		).resolves.toEqual({ ok: true });
		await rigRef.waitForStarted(FIRST.identity);
		await rigRef.waitForStarted(SECOND.identity);
		expect(started).toEqual([{ ok: true }]);
		expect(secondStarted).toEqual([{ ok: true }]);
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("handed-off");
		expect(rigRef.state.ticketState(SECOND.identity)).toBe("handed-off");
	});
});

describe("the outcome wording", () => {
	/** The Message line one outcome leaves, captured in place of the app. */
	function sink(): {
		events: string[];
		reports: Pick<HandoffDispatchReports, "clearWorking" | "warning" | "error">;
	} {
		const events: string[] = [];
		return {
			events,
			reports: {
				warning: (text) => events.push(`warning:${text}`),
				error: (text) => events.push(`error:${text}`),
				clearWorking: () => events.push("clear-working"),
			},
		};
	}

	const agent = { name: "webhook-retry", paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1" };
	const held: NameCollision = {
		stableName: "webhook-retry",
		startedAs: null,
		holder: { paneId: "pane-x", tabId: "tab-x", workspaceId: "ws-x", terminalId: "term-x" },
		own: false,
		reason: "agent name is already used",
	};

	test("a clean outcome with nothing to say leaves only its progress line", async () => {
		const line = sink();
		await reportHandoffOutcome({ status: "ok", agent }, line.reports);
		expect(line.events).toEqual(["clear-working"]);
	});

	test("a bent repository resolution warns on a clean outcome, after the write that failed", async () => {
		const line = sink();
		await reportHandoffOutcome(
			{
				status: "ok",
				agent,
				notes: {
					warning: "the checkout was a sibling clone",
					mappingToWrite: { repository: "acme/factory", path: "/home/me/factory" },
				},
			},
			line.reports,
			() => Promise.resolve("could not persist the repository mapping"),
		);
		expect(line.events).toEqual([
			"clear-working",
			"warning:could not persist the repository mapping; the checkout was a sibling clone",
		]);
	});

	test("a failed outcome reports its own reason, and never the note it carried", async () => {
		const line = sink();
		await reportHandoffOutcome(
			{
				status: "failed",
				reason: "herdr is unavailable",
				notes: { warning: "the checkout was a sibling clone" },
			},
			line.reports,
		);
		expect(line.events).toEqual(["clear-working", "error:herdr is unavailable"]);
	});

	test("a name the handoff could not take says so, and claims no name it started under", async () => {
		const line = sink();
		await reportHandoffOutcome(
			{ status: "failed", reason: "the name is held", collision: held },
			line.reports,
		);
		expect(line.events).toEqual(["clear-working", "error:the name is held"]);
	});

	test("an agent that started beside its own leftover names both facts in one line", async () => {
		const line = sink();
		await reportHandoffOutcome(
			{ status: "ok", agent, collision: { ...held, startedAs: "webhook-retry-c2" } },
			line.reports,
		);
		expect(line.events).toEqual([
			"clear-working",
			"warning:a leftover agent still holds the herdr name webhook-retry; this agent started as webhook-retry-c2",
		]);
	});

	test("a discovered mapping the module cannot persist leaves no line", async () => {
		const line = sink();
		// No `persistMapping` on this module: the handoff still started, and the
		// mapping it found is not a fact the operator is asked to read.
		await reportHandoffOutcome(
			{
				status: "ok",
				agent,
				notes: { mappingToWrite: { repository: "acme/factory", path: "/p" } },
			},
			line.reports,
		);
		expect(line.events).toEqual(["clear-working"]);
	});

	test("a prompt that never landed keeps its reason ahead of the name it took", async () => {
		const line = sink();
		await reportHandoffOutcome(
			{
				status: "prompt-failed",
				reason: "agent webhook-retry started, but the prompt failed: herdr is gone",
				agent,
				collision: { ...held, startedAs: "webhook-retry-c2" },
			},
			line.reports,
		);
		expect(line.events).toEqual([
			"clear-working",
			"error:agent webhook-retry started, but the prompt failed: herdr is gone; a leftover agent still holds the herdr name webhook-retry; this agent started as webhook-retry-c2",
		]);
	});
});

describe("the Close cleanup", () => {
	test("a cleanup herdr refuses records the leftover fact the ticket carries", async () => {
		const rigRef = rig();
		const stored = seedClosedHandoff(rigRef, FIRST);
		rigRef.runner.set("herdr", ["tab", "close", FIRST.tabId], {
			code: 1,
			stderr: "the tab has a running agent",
		});
		await expect(rigRef.dispatch.closeCleanup(FIRST.identity, stored, "closed")).resolves.toBe(
			"the tab has a running agent",
		);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toEqual(
			expect.objectContaining({
				handoffId: stored.handoffId,
				reason: "the tab has a running agent",
			}),
		);
	});

	test("a cleanup that never ran records a readable failure of its own", async () => {
		const rigRef = rig();
		const stored = seedClosedHandoff(rigRef, FIRST);
		const broken: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr" && args[0] === "tab"
					? Promise.reject(new Error("herdr is not reachable"))
					: rigRef.runner.run(command, args, options),
			listModels: (kind) => rigRef.runner.listModels(kind),
		};
		const dispatch = withRunner(rigRef, broken);
		await expect(dispatch.closeCleanup(FIRST.identity, stored, "closed")).resolves.toBe(
			"the close cleanup did not run: herdr is not reachable",
		);
		// The environment still stands, and the ticket carries that fact: the
		// caller that only reports the answer never guards a throw of its own.
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)?.reason).toBe(
			"the close cleanup did not run: herdr is not reachable",
		);
	});

	test("a tab herdr already lost is a success that clears the fact", async () => {
		const rigRef = rig();
		const stored = seedClosedHandoff(rigRef, FIRST);
		rigRef.runner.set("herdr", ["tab", "close", FIRST.tabId], { code: 1, stderr: "busy" });
		await expect(rigRef.dispatch.closeCleanup(FIRST.identity, stored, "closed")).resolves.toBe(
			"busy",
		);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).not.toBeNull();
		// The operator has since closed the tab in herdr: the retry meets
		// tab_not_found, the way it meets a workspace that is gone.
		rigRef.runner.set("herdr", ["tab", "close", FIRST.tabId], {
			code: 1,
			stderr: '{"error":{"code":"tab_not_found","message":"tab is gone"},"id":"cli:tab:close"}\n',
		});
		await expect(
			rigRef.dispatch.closeCleanup(FIRST.identity, stored, "closed"),
		).resolves.toBeUndefined();
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
	});

	test("a workspace herdr already lost is a success that clears the fact", async () => {
		const rigRef = rig();
		const stored = seedClosedHandoff(rigRef, FIRST, worktreeChoice);
		rigRef.runner.set("herdr", ["worktree", "remove", "--workspace", FIRST.workspaceId], {
			code: 1,
			stderr:
				'{"error":{"code":"workspace_not_found","message":"workspace is gone"},"id":"cli:worktree:remove"}\n',
		});
		// The removal met a workspace that is gone: the environment is cleaned,
		// the way it is when the checkout itself is gone.
		await expect(
			rigRef.dispatch.closeCleanup(FIRST.identity, stored, "closed"),
		).resolves.toBeUndefined();
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
	});

	test("a successful workspace removal clears every fact that named it", async () => {
		const rigRef = rig();
		const worktree = seedClosedHandoff(rigRef, FIRST, worktreeChoice);
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: worktree.handoffId,
			reason: "the workspace is dirty",
		});
		await expect(
			rigRef.dispatch.closeCleanup(FIRST.identity, worktree, "closed"),
		).resolves.toBeUndefined();
		expect(rigRef.commands()).toContain(`herdr worktree remove --workspace ${FIRST.workspaceId}`);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
	});

	test("a workspace removal clears every fact that names the workspace it closed", async () => {
		const rigRef = rig();
		const first = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			tabId: "tab-a",
			workspaceId: "ws-shared",
		});
		const second = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			tabId: "tab-b",
			workspaceId: "ws-shared",
		});
		for (const handoff of [first, second])
			rigRef.state.recordLeftoverEnvironment({
				ticketIdentity: FIRST.identity,
				handoffId: handoff.handoffId,
				reason: "the workspace is dirty",
			});
		await expect(
			rigRef.dispatch.closeCleanup(FIRST.identity, first, "closed"),
		).resolves.toBeUndefined();
		// One workspace closed with the checkout: every fact that named it is
		// gone, and herdr never heard a tab close.
		expect(rigRef.state.leftoverEnvironments(FIRST.identity)).toEqual([]);
		expect(rigRef.commands().filter((c) => c.startsWith("herdr tab close"))).toHaveLength(0);
	});

	test("a tab close clears every fact that names the tab it closed", async () => {
		const rigRef = rig();
		const first = seedClosedHandoff(rigRef, FIRST, liveChoice, {
			tabId: "tab-shared",
			workspaceId: "ws-a",
		});
		const second = seedClosedHandoff(rigRef, FIRST, liveChoice, {
			tabId: "tab-shared",
			workspaceId: "ws-b",
		});
		for (const handoff of [first, second])
			rigRef.state.recordLeftoverEnvironment({
				ticketIdentity: FIRST.identity,
				handoffId: handoff.handoffId,
				reason: "the tab has a running agent",
			});
		await expect(
			rigRef.dispatch.closeCleanup(FIRST.identity, first, "closed"),
		).resolves.toBeUndefined();
		expect(rigRef.state.leftoverEnvironments(FIRST.identity)).toEqual([]);
	});

	test("a cleanup that broke on its way out still releases the seat", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const stored = seedClosedHandoff(rigRef, SECOND);
		// The projection refresh the cleanup ends with is the thing that breaks:
		// the answer to the caller must still settle, and the seat must still
		// come back, or every later handoff waits on a seat nobody holds.
		const dispatch = withRunner(rigRef, rigRef.runner, {
			refresh: () => {
				throw new Error("the frame is gone");
			},
		});
		await expect(dispatch.closeCleanup(SECOND.identity, stored, "closed")).resolves.toBeUndefined();
		expect(rigRef.events).not.toContain("error:the frame is gone");
		expect(rigRef.dispatch.handoffActive()).toBe(false);
		await expect(start(rigRef, FIRST, "open")).resolves.toEqual({ ok: true });
		await rigRef.waitForStarted(FIRST.identity);
	});

	test("a cleanup reaches only the environments its own removal names", async () => {
		const rigRef = rig([FIRST, SECOND]);
		const worktree = seedClosedHandoff(rigRef, FIRST, worktreeChoice);
		const beside = seedClosedHandoff(rigRef, FIRST, liveChoice, {
			tabId: "tab-beside",
			workspaceId: "ws-beside",
		});
		for (const handoff of [worktree, beside])
			rigRef.state.recordLeftoverEnvironment({
				ticketIdentity: FIRST.identity,
				handoffId: handoff.handoffId,
				reason: "the environment is still open",
			});
		// The cleanup of one live tab closes that tab and nothing beside it: the
		// fact of another environment stands (ADR 0012).
		await expect(
			rigRef.dispatch.closeCleanup(FIRST.identity, beside, "closed"),
		).resolves.toBeUndefined();
		expect(rigRef.state.leftoverEnvironments(FIRST.identity)).toEqual([
			expect.objectContaining({ handoffId: worktree.handoffId }),
		]);
	});

	test("a cleanup returns herdr's focus to the workspace the operator works in", async () => {
		const rigRef = rig();
		const stored = seedClosedHandoff(rigRef, FIRST, worktreeChoice);
		const dispatch = withRunner(rigRef, rigRef.runner, {
			controlPlaneWorkspaceId: "ws-control-plane",
		});
		await expect(dispatch.closeCleanup(FIRST.identity, stored, "closed")).resolves.toBeUndefined();
		// herdr moved its focus when the workspace disappeared: the cleanup
		// brings it back to the control plane.
		expect(rigRef.commands()).toContain("herdr workspace focus ws-control-plane");
	});
});

describe("the Clear action", () => {
	/** A ticket that is open, with one leftover tab herdr refused to close. */
	async function leftoverRig(): Promise<Rig> {
		const rigRef = rig([FIRST, SECOND]);
		const stored = seedHandoff(rigRef, FIRST);
		rigRef.runner.set("herdr", ["tab", "close", FIRST.tabId], { code: 1, stderr: "tab is busy" });
		await rigRef.dispatch.closeCleanup(FIRST.identity, stored, "closed");
		closeCycle(rigRef, FIRST, stored.handoffId);
		await seatReleased();
		rigRef.runner.set("herdr", ["tab", "close", FIRST.tabId], { code: 0 });
		return rigRef;
	}

	test("the retry clears the fact herdr let go, and answers with nothing", async () => {
		const rigRef = await leftoverRig();
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
		expect(rigRef.commands()).toContain(`herdr tab close ${FIRST.tabId}`);
	});

	test("the retry reaches every leftover of the ticket and answers with what stayed", async () => {
		const rigRef = await leftoverRig();
		const dirty = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			tabId: "tab-dirty",
			workspaceId: "ws-dirty",
		});
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: dirty.handoffId,
			reason: "the workspace is dirty",
		});
		rigRef.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-dirty"], {
			code: 1,
			stderr: '{"error":{"code":"dirty_worktree_requires_force","message":"use --force"}}\n',
		});
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([
			"use --force (dirty_worktree_requires_force)",
		]);
		// One queue item owned the loop: herdr was asked for both environments,
		// and a refusal on one did not spare the other the call. The tab herdr
		// let go is gone; the workspace it kept still stands.
		expect(rigRef.commands()).toContain(`herdr tab close ${FIRST.tabId}`);
		expect(rigRef.commands()).toContain("herdr worktree remove --workspace ws-dirty");
		expect(rigRef.state.leftoverEnvironments(FIRST.identity)).toEqual([
			expect.objectContaining({ handoffId: dirty.handoffId }),
		]);
	});

	test("only the operator's Force choice reaches herdr with --force", async () => {
		const rigRef = await leftoverRig();
		const dirty = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			tabId: "tab-dirty",
			workspaceId: "ws-dirty",
		});
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: dirty.handoffId,
			reason: "the workspace is dirty",
		});
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, true)).resolves.toEqual([]);
		expect(rigRef.commands()).toContain("herdr worktree remove --workspace ws-dirty --force");
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
	});

	test("the clear refuses while a handoff holds the seat", async () => {
		const rigRef = await leftoverRig();
		rigRef.hold("herdr workspace list");
		const started = start(rigRef, SECOND, "open");
		await rigRef.waitForArrivals(1);
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.events).toContain(
			`warning:a handoff is in flight: wait for it to settle before you clear the leftover environment of ticket ${FIRST.identity}`,
		);
		// The tab close the clear would have run never reaches herdr: the agent
		// being built cannot meet a removal half way.
		expect(rigRef.held()).toEqual(["herdr workspace list"]);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).not.toBeNull();
		rigRef.release();
		await started;
		await rigRef.waitForStarted(SECOND.identity);
	});

	test("the clear refuses while another clear holds the seat", async () => {
		const rigRef = await leftoverRig();
		rigRef.hold("herdr tab close");
		const first = rigRef.dispatch.clearLeftover(FIRST.identity, false);
		await rigRef.waitForArrivals(1);
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.events).toContain(
			`warning:a leftover clear is already in flight: wait for it to settle before you clear ticket ${FIRST.identity} again`,
		);
		expect(rigRef.held()).toEqual([`herdr tab close ${FIRST.tabId}`]);
		rigRef.release();
		await expect(first).resolves.toEqual([]);
	});

	test("a ticket that holds no leftover answers the refusal, and the projection refreshes", async () => {
		const rigRef = rig();
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.events).toContain(
			`warning:no leftover environment is recorded for ticket ${FIRST.identity}`,
		);
		expect(rigRef.events).toContain("refresh");
		expect(rigRef.commands().filter((c) => c.startsWith("herdr tab close"))).toHaveLength(0);
	});

	test("the clear refuses a leftover that names the ticket's live tab", async () => {
		const rigRef = await leftoverRig();
		// The agent of a new cycle runs on the tab the closed handoff named: the
		// shape a reclaimed agent leaves behind (ADR 0011).
		if (
			rigRef.state.reclaimHandoff(FIRST.identity, {
				paneId: FIRST.paneId,
				tabId: FIRST.tabId,
				workspaceId: FIRST.workspaceId,
			}) === null
		)
			throw new Error("the seed left nothing to reclaim");
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.events).toContain(
			`warning:the agent of ticket ${FIRST.identity} runs in herdr tab ${FIRST.tabId}: close its work cycle before you clear that tab`,
		);
		expect(rigRef.commands().filter((c) => c.startsWith("herdr tab close"))).toHaveLength(1);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).not.toBeNull();
	});

	test("the clear refuses a workspace that holds the ticket's live agent", async () => {
		const rigRef = await leftoverRig();
		const dirty = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			tabId: "tab-live",
			workspaceId: "ws-live",
		});
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: dirty.handoffId,
			reason: "the workspace is dirty",
		});
		if (
			rigRef.state.reclaimHandoff(FIRST.identity, {
				paneId: "pane-live",
				tabId: "tab-live",
				workspaceId: "ws-live",
			}) === null
		)
			throw new Error("the seed left nothing to reclaim");
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.events).toContain(
			`warning:the agent of ticket ${FIRST.identity} runs in herdr workspace ws-live: close its work cycle before you clear that workspace`,
		);
	});

	test("the clear refuses the pane its leftover lives in", async () => {
		const rigRef = await leftoverRig();
		// The leftover is a worktree row whose tab the ticket's live agent shares:
		// closing it ends the agent with it, so the guard reads the pane.
		const shared = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			paneId: "pane-shared",
			tabId: "tab-shared",
			workspaceId: "ws-shared",
		});
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: shared.handoffId,
			reason: "the workspace is dirty",
		});
		if (
			rigRef.state.reclaimHandoff(FIRST.identity, {
				paneId: "pane-shared",
				tabId: "tab-other",
				workspaceId: "ws-other",
			}) === null
		)
			throw new Error("the seed left nothing to reclaim");
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.events).toContain(
			`warning:the agent of ticket ${FIRST.identity} runs in herdr pane pane-shared: close its work cycle before you clear that pane`,
		);
	});

	test("the clear reaches a leftover that shares no handle with the live agent", async () => {
		const rigRef = await leftoverRig();
		// The next cycle runs somewhere else entirely, and it is still in
		// flight: the leftover is safe to clear, because no removal reaches the
		// handle the live agent works on.
		seedHandoff(rigRef, FIRST, liveChoice, {
			paneId: "pane-elsewhere",
			tabId: "tab-elsewhere",
			workspaceId: "ws-elsewhere",
		});
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.commands()).toContain(`herdr tab close ${FIRST.tabId}`);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
	});

	test("the clear reaches a worktree leftover beside a live agent in another workspace", async () => {
		const rigRef = await leftoverRig();
		const dirty = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			paneId: "pane-dirty",
			tabId: "tab-dirty",
			workspaceId: "ws-dirty",
		});
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: dirty.handoffId,
			reason: "the workspace is dirty",
		});
		// The live agent works in its own workspace, tab, and pane: none of them
		// is the leftover's, so the removal is free to run.
		seedHandoff(rigRef, FIRST, liveChoice, {
			paneId: "pane-live",
			tabId: "tab-live",
			workspaceId: "ws-live",
		});
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.commands()).toContain("herdr worktree remove --workspace ws-dirty");
	});

	test("a leftover that names no handle is clearable beside an agent that names none", async () => {
		const rigRef = rig();
		// A row herdr never placed: no workspace, no tab, no pane. The guard
		// compares handles, and an absent handle never meets another absent one.
		const nameless = seedClosedHandoff(rigRef, FIRST, worktreeChoice, {
			paneId: null,
			tabId: null,
			workspaceId: null,
		});
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: nameless.handoffId,
			reason: "the workspace is dirty",
		});
		seedHandoff(rigRef, FIRST, liveChoice, {
			paneId: null,
			tabId: null,
			workspaceId: null,
		});
		await expect(rigRef.dispatch.clearLeftover(FIRST.identity, false)).resolves.toEqual([]);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
	});
});

describe("the name fact", () => {
	test("a handoff beside the ticket's own leftover records the fact and starts anyway", async () => {
		const rigRef = rig();
		const previous = seedClosedHandoff(rigRef, FIRST);
		// A second closed cycle of the same ticket: the newest row is not the
		// one whose agent holds the name, and the fact knows the difference.
		seedClosedHandoff(rigRef, FIRST, liveChoice, {
			paneId: "pane-latest",
			tabId: "tab-latest",
			workspaceId: "ws-latest",
		});
		// The environment of the closed cycle is still open, and its agent still
		// holds the stable name: herdr says so, and names a handle this ticket's
		// own handoff recorded.
		rigRef.runner.set(
			"herdr",
			["agent", "start", FIRST.name, "--kind", "pi", "--pane", "pane-agent"],
			{
				code: 1,
				stderr: nameTaken(FIRST.name, [{ paneId: FIRST.paneId, workspaceId: FIRST.workspaceId }]),
			},
		);
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "open", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		await rigRef.waitForStarted(FIRST.identity);
		expect(started).toEqual([{ ok: true }]);
		// The handoff started beside the leftover, under its cycle name.
		expect(rigRef.commands()).toContain(
			`herdr agent start ${FIRST.name}-c3 --kind pi --pane pane-agent`,
		);
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("handed-off");
		// The leftover stays a fact on the ticket, not only a line that fades,
		// and it lands on the handoff that owns the name.
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toEqual(
			expect.objectContaining({
				handoffId: previous.handoffId,
				paneId: FIRST.paneId,
				reason: expect.stringContaining(
					`the leftover agent still holds the herdr name ${FIRST.name}`,
				),
			}),
		);
		// And the line says which name the agent actually runs under.
		expect(rigRef.events).toContain(
			`warning:a leftover agent still holds the herdr name ${FIRST.name}; this agent started as ${FIRST.name}-c3`,
		);
	});

	test("the ticket's own leftover fact makes a holder it never saw its own", async () => {
		const rigRef = rig();
		const previous = seedClosedHandoff(rigRef, FIRST);
		// The control plane still carries the fact of a leftover environment of
		// this ticket, and herdr refuses the name without naming who holds it:
		// the handoff starts beside it rather than failing on a message with no
		// action in it.
		rigRef.state.recordLeftoverEnvironment({
			ticketIdentity: FIRST.identity,
			handoffId: previous.handoffId,
			reason: "herdr refused to close the tab",
		});
		rigRef.runner.set(
			"herdr",
			["agent", "start", FIRST.name, "--kind", "pi", "--pane", "pane-agent"],
			{
				code: 1,
				stderr: `{"error":{"code":"agent_name_taken","message":"agent name ${FIRST.name} is already used"},"id":"cli:agent:start"}\n`,
			},
		);
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "open", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		await rigRef.waitForStarted(FIRST.identity);
		expect(started).toEqual([{ ok: true }]);
		expect(rigRef.commands()).toContain(
			`herdr agent start ${FIRST.name}-c2 --kind pi --pane pane-agent`,
		);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)?.reason).toContain(
			`the leftover agent still holds the herdr name ${FIRST.name}`,
		);
	});

	test("a name another ticket's agent holds fails the handoff and records no fact", async () => {
		const rigRef = rig();
		// The ticket has a closed cycle of its own, so a record that should not
		// happen would land on its latest handoff.
		seedClosedHandoff(rigRef, FIRST);
		rigRef.runner.set(
			"herdr",
			["agent", "start", FIRST.name, "--kind", "pi", "--pane", "pane-agent"],
			{
				code: 1,
				stderr: nameTaken(FIRST.name, [{ paneId: "pane-stranger", workspaceId: "ws-stranger" }]),
			},
		);
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "open", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		await rigRef.waitForStarted(FIRST.identity);
		expect(started[0]?.ok).toBe(false);
		expect(rigRef.state.ticketState(FIRST.identity)).toBe("open");
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
		// The stranger is not this ticket's to move aside, and a name of its own
		// is no answer: the stable name was asked for once.
		expect(rigRef.commands().filter((c) => c.startsWith("herdr agent start"))).toHaveLength(1);
	});

	test("a refusal that names no holder is no agent of this ticket, and records nothing", async () => {
		const rigRef = rig();
		seedClosedHandoff(rigRef, FIRST);
		rigRef.runner.set(
			"herdr",
			["agent", "start", FIRST.name, "--kind", "pi", "--pane", "pane-agent"],
			{
				code: 1,
				stderr: `{"error":{"code":"agent_name_taken","message":"agent name ${FIRST.name} is already used"},"id":"cli:agent:start"}\n`,
			},
		);
		const started: DispatchResult[] = [];
		await expect(start(rigRef, FIRST, "open", (r) => started.push(r))).resolves.toEqual({
			ok: true,
		});
		await rigRef.waitForStarted(FIRST.identity);
		expect(started[0]?.ok).toBe(false);
		// herdr named no holder: the line says so, and no fact lands on the
		// ticket's own closed cycle.
		expect(rigRef.events).toContain(
			`error:the herdr name ${FIRST.name} is held by a pane herdr did not name, which is no agent of this ticket: agent name ${FIRST.name} is already used (agent_name_taken)`,
		);
		expect(rigRef.state.leftoverEnvironment(FIRST.identity)).toBeNull();
	});
});
