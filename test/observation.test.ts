import { describe, expect, mock, test } from "bun:test";

import type { FactoryConfig, TransitionOutcome } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { DispatchResult, HandoffIntent } from "../src/handoff-dispatch.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import {
	type AgentReader,
	HerdrAgentReader,
	normalizeAgentStatus,
	ObservationCoordinator,
	STARTUP_GRACE_MS,
	stripAnsi,
} from "../src/observation.ts";
import type { RefreshClock } from "../src/refresh.ts";
import { type ConsultationState, type FactoryState, openFactoryState } from "../src/state.ts";
import type { SessionTurnRead, TurnEndCause, TurnLogEntry } from "../src/turn-log.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner } from "./fake-runner.ts";

const source = { name: "issues", kind: "github-issues" };
const choice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
	contextWindow: "",
};

/**
 * The task types the awaiting rule reasons about (ADR 0027). The rule
 * decides from the transition's stored outcome, not from the config:
 * - review auto-advances with no position: it closes at any time.
 * - route auto-advances into a position that offers implement: it routes
 *   while there is parallel room, and degrades to close at the handoff
 *   limit, in manual mode too.
 * - research never auto-advances: in auto mode the factory still decides
 *   it (close), and in manual mode it waits for a human.
 * - implement and polish are the open dispatch's types.
 */
const config: FactoryConfig = {
	...BASE_CONFIG,
	taskTypes: {
		implement: { template: "implement", thinking: "high" },
		review: { template: "review" },
		route: { template: "route" },
		research: { template: "research" },
		polish: { template: "polish" },
	},
	maxParallelAgents: 2,
	maxHandoffsPerTicket: 2,
};

/** The transition outcome the tests settle on: fired and auto-advanced. */
function outcome(over: Partial<TransitionOutcome> = {}): TransitionOutcome {
	return {
		fired: true,
		when: null,
		reason: "",
		ticketFacts: [],
		pullRequestFacts: [],
		autoAdvance: true,
		ticketWrite: null,
		pullRequestWrite: null,
		pullRequestIdentity: null,
		pullRequestKey: null,
		writeFailure: "",
		positionTaskType: null,
		positionTicketIdentity: null,
		...over,
	};
}

/**
 * The route's auto-advance outcome: the position offers implement and sits
 * on the ticket itself, the way these tests' issue feed has no pull
 * requests.
 */
function routeOutcome(identity = "github:github.com:I_5"): TransitionOutcome {
	return outcome({
		positionTaskType: "implement",
		positionTicketIdentity: identity,
	});
}

function fetched(
	identity = "github:github.com:I_5",
	labels: readonly string[] = ["ready-for-agent"],
	externalUpdatedAt = "2026-08-31T10:00:00Z",
): FetchedTicket {
	return {
		identity,
		sourceKind: "github-issue",
		externalKey: "#5",
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${identity.split("I_")[1]}`,
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: [...labels],
		externalUpdatedAt,
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

function success(tickets: FetchedTicket[]) {
	return { status: "success" as const, fetchedAt: "2026-08-31T10:01:00Z", tickets };
}

function reader(
	agents: () => HerdrAgent[],
	readPane?: (paneId: string, lines: number) => Promise<string | null>,
): AgentReader {
	return {
		listAgents: async () => ({ kind: "ok", agents: agents() }),
		// The AgentReader contract: pane output comes back ANSI stripped.
		readPane:
			readPane ?? (async (paneId) => stripAnsi(`\u001b[1mDone.\u001b[0m message of ${paneId}`)),
	};
}

function agent(
	paneId: string,
	status = "working",
	sessionId = "",
	stableSessionId?: string,
	name?: string,
): HerdrAgent {
	return {
		paneId,
		tabId: "tab-1",
		workspaceId: "ws-1",
		agent: "factory-implement-I_5",
		status,
		sessionId,
		...(stableSessionId === undefined ? {} : { stableSessionId }),
		...(name === undefined ? {} : { name }),
	};
}

interface Rig {
	state: FactoryState;
	intents: HandoffIntent[];
	/** The attempt ids of the claims the dispatching rig made, in dispatch order. */
	claims: string[];
	/** Report the start of the oldest dispatch still waiting for one. */
	reportStart: (started?: DispatchResult) => void;
	/** The loop's own calls and dispatches in order, when the rig records them. */
	order: string[] | undefined;
	statuses: Array<{ kind: "info" | "warning" | "error"; text: string }>;
	cleanups: Array<{ paneId: string | null; tabId: string | null; workspaceId: string | null }>;
	coordinator: ObservationCoordinator;
	/** Advance the clock the state and the loop share. */
	advance: (ms: number) => void;
	/** Swap the agent list the next probe returns. */
	setAgents: (next: HerdrAgent[]) => void;
}

function rig(options: {
	autoOn?: boolean;
	/** Override a config knob the awaiting and dispatch rules read. */
	config?: Partial<FactoryConfig>;
	agents?: HerdrAgent[];
	readPane?: (paneId: string, lines: number) => Promise<string | null>;
	/** The turn log the fake session reader returns. Null: no session log. */
	turnLogs?: (
		kind: string,
		sessionId: string,
		startedAt: string | null,
	) => Promise<SessionTurnRead>;
	/** The cycle-end report the loop answers to, the way the app does. */
	onCycleEnd?: (ticketIdentity: string) => void;
	/**
	 * Claim in the state, the way the app's dispatch does, so a dispatched
	 * handoff is in progress until a test settles it. Off by default: the
	 * loop-level tests drive the state by hand.
	 */
	dispatchClaims?: boolean;
	/**
	 * The Work queue's pickup (ADR 0034): the number of waiting starts this
	 * cycle's free seats take. The coordinator calls it before auto-dispatch
	 * and holds each picked claim's seat against the later dispatches of the
	 * same cycle. Absent by default, the way an app without a queue is.
	 */
	pickupWorkQueue?: () => Promise<number>;
	/**
	 * The loop's own calls and dispatches in order, so a test can see where
	 * the queue step sits in the cycle.
	 */
	order?: string[];
	startupGraceMs?: number;
	/**
	 * The transition fire seam (ADR 0027). The app injects the real one; a
	 * test holds its own seam to watch when the loop fires a completed turn
	 * and what it stores on the trace.
	 */
	fireCompleted?: (ticket: {
		ticketIdentity: string;
		handoffAttemptId: string;
		taskType: string;
		agentType: string;
	}) => Promise<TransitionOutcome | null>;
}): Rig {
	let nowMs = Date.parse("2026-08-31T11:00:00Z");
	let agents = [...(options.agents ?? [])];
	// The state and the loop share the clock, so a handoff's age is
	// deterministic: advance() ages it.
	const state = openFactoryState(":memory:", () => nowMs);
	state.initializeSources([source]);
	state.applyFetch(source, success([fetched()]));
	const intents: HandoffIntent[] = [];
	const claims: string[] = [];
	const order = options.order;
	const pickup = options.pickupWorkQueue;
	// The start reports the dispatches still owe the loop. The app answers a
	// claim first and reports the start when its external work settles, so
	// the rig holds each report back until a test fires it.
	const pending: Array<(started: DispatchResult) => void> = [];
	const statuses: Rig["statuses"] = [];
	const cleanups: Rig["cleanups"] = [];
	const coordinator = new ObservationCoordinator({
		state,
		herdr: reader(() => agents, options.readPane),
		turnLogs: {
			read: options.turnLogs ?? (async () => ({ kind: "unavailable" })),
		},
		config: () => ({ ...config, ...options.config }),
		onCycleEnd: options.onCycleEnd,
		// The dispatch seam enqueues the way the app's module does (ADR
		// 0049): the hard checks run at the enqueue, the item rests in the
		// queue, and the pickup is the only starter. The queue's depth is
		// the top-up's pace, so the rig mirrors it: an add lands in the
		// state's queue and blocks the next cycle's add.
		dispatch: async (intent) => {
			order?.push(`dispatch:${intent.origin}`);
			intents.push(intent);
			const enqueued = state.enqueueWork({
				ticketIdentity: intent.ticketIdentity,
				routeFromIdentity: intent.routeFromIdentity ?? null,
				origin: intent.origin,
				choice: intent.choice,
				previousMessage: intent.previousMessage,
				automatic: intent.automatic === true,
			});
			if (enqueued.ok !== true) return { ok: false, reason: enqueued.reason };
			if (options.dispatchClaims) {
				const claim = state.claimHandoff(intent.ticketIdentity, intent.choice, intent.origin);
				if (claim.ok) claims.push(claim.claim.attemptId);
			}
			if (intent.onStarted !== undefined) pending.push(intent.onStarted);
			return { ok: true, queued: true };
		},
		pickupWorkQueue:
			pickup === undefined
				? undefined
				: async () => {
						order?.push("pickup");
						return await pickup();
					},
		cleanup: async (handoff) => {
			cleanups.push({
				paneId: handoff.paneId,
				tabId: handoff.tabId,
				workspaceId: handoff.workspaceId,
			});
			return undefined;
		},
		...(options.fireCompleted === undefined ? {} : { fireCompleted: options.fireCompleted }),
		now: () => nowMs,
		mode: () => options.autoOn ?? false,
		startupGraceMs: options.startupGraceMs,
		intervalMs: 60_000,
		onChanged: () => {},
		onStatus: (kind, text) => {
			statuses.push({ kind, text });
		},
	});
	return {
		state,
		intents,
		claims,
		reportStart: (started: DispatchResult = { ok: true, queued: false }) => {
			const next = pending.shift();
			if (next === undefined) throw new Error("no dispatch is waiting to report a start");
			next(started);
		},
		order,
		statuses,
		cleanups,
		coordinator,
		advance: (ms: number) => {
			nowMs += ms;
		},
		setAgents: (next: HerdrAgent[]) => {
			agents = next;
		},
	};
}

/** Hand an in-flight ticket out so its pane is known to the loop. */
function handOut(state: FactoryState, identity: string, taskType = "implement"): string {
	const claim = state.claimHandoff(identity, { ...choice, taskType }, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: `pane-${taskType}`,
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	return claim.claim.attemptId;
}

/**
 * Hand a ticket out and settle its turn, so it rests in awaiting. The
 * optional transition is what the turn's fire stored on the trace, the way
 * the app's settle path stores it.
 */
function settleFor(
	state: FactoryState,
	identity: string,
	taskType: string,
	transition: TransitionOutcome | null = null,
): string {
	const attempt = handOut(state, identity, taskType);
	state.settleTurn({
		ticketIdentity: identity,
		handoffId: attempt,
		taskType,
		agentType: "pi",
		message: "settled the turn",
		turnLog: [{ kind: "text", text: "settled the turn" }],
		completedAt: "2026-08-31T11:00:00Z",
		...(transition === null ? {} : { transition }),
	});
	return attempt;
}

/** Hand a ticket out and settle its turn with an explicit cause, so it can rest held. */
function settleForCause(
	state: FactoryState,
	identity: string,
	taskType: string,
	cause: TurnEndCause,
	detail = "",
	transition: TransitionOutcome | null = null,
): string {
	const attempt = handOut(state, identity, taskType);
	state.settleTurn({
		ticketIdentity: identity,
		handoffId: attempt,
		taskType,
		agentType: "pi",
		message: "settled the turn",
		turnLog: [{ kind: "text", text: "settled the turn" }],
		completedAt: "2026-08-31T11:00:00Z",
		cause,
		detail,
		transition,
	});
	return attempt;
}

describe("normalizeAgentStatus", () => {
	test("maps the closed herdr 0.8.2 status set and falls back to unknown", () => {
		expect(normalizeAgentStatus("working")).toBe("working");
		expect(normalizeAgentStatus("Done")).toBe("done");
		expect(normalizeAgentStatus("idle")).toBe("idle");
		expect(normalizeAgentStatus("blocked")).toBe("blocked");
		expect(normalizeAgentStatus("unknown")).toBe("unknown");
		expect(normalizeAgentStatus("meditating")).toBe("unknown");
	});
});

describe("stripAnsi", () => {
	test("removes escape sequences and control characters", () => {
		expect(stripAnsi("\u001b[1mbold\u001b[0m plain\u0007")).toBe("bold plain");
		expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
	});
});

describe("HerdrAgentReader.readPane", () => {
	test("reads the pane with the pinned herdr command and the configured line cap", async () => {
		const runner = new FakeRunner();
		const lines = ["first", "second", "third"].map(
			(text, index) => `\u001b[1m${text}\u001b[0m ${index}`,
		);
		runner.set(
			"herdr",
			[
				"agent",
				"read",
				"pane-1",
				"--lines",
				"10",
				"--source",
				"recent-unwrapped",
				"--format",
				"text",
			],
			{
				stdout: JSON.stringify({ result: { output: lines.join("\n") } }),
			},
		);
		const reader = new HerdrAgentReader(runner);
		const pane = await reader.readPane("pane-1", 10);
		expect(pane).toBe("first 0\nsecond 1\nthird 2");
		expect(runner.commands()).toEqual([
			"herdr agent read pane-1 --lines 10 --source recent-unwrapped --format text",
		]);
	});

	test("re-caps the output client side when herdr returns more lines", async () => {
		const runner = new FakeRunner();
		const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
		runner.set(
			"herdr",
			[
				"agent",
				"read",
				"pane-1",
				"--lines",
				"4",
				"--source",
				"recent-unwrapped",
				"--format",
				"text",
			],
			{
				stdout: lines.join("\n"),
			},
		);
		const reader = new HerdrAgentReader(runner);
		const pane = await reader.readPane("pane-1", 4);
		expect(pane).toBe("line 0\nline 1\nline 2\nline 3");
	});

	test("a failed read yields null", async () => {
		const runner = new FakeRunner();
		runner.set(
			"herdr",
			[
				"agent",
				"read",
				"pane-1",
				"--lines",
				"1",
				"--source",
				"recent-unwrapped",
				"--format",
				"text",
			],
			{
				code: 1,
				stderr: "no such pane",
			},
		);
		const reader = new HerdrAgentReader(runner);
		expect(await reader.readPane("pane-1", 1)).toBeNull();
	});
});

describe("HerdrAgentReader.listAgents", () => {
	/** Parse one agent item shaped with the given extra fields. */
	async function parseItem(extra: Record<string, unknown>): Promise<HerdrAgent | undefined> {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: JSON.stringify({
				result: { agents: [{ pane_id: "pane-1", agent: "pi", ...extra }] },
			}),
		});
		const probe = await new HerdrAgentReader(runner).listAgents();
		return probe.kind === "ok" ? probe.agents[0] : undefined;
	}

	test("reads every name herdr may give the turn sequence", async () => {
		// herdr 0.8.2 names this field `state_change_seq`. The other three
		// names are the aliases the reader accepts, not fields herdr emits, so
		// a new herdr that renames the sequence still reads. Do not add a name
		// here without a herdr release that sends it.
		for (const [field, sequence] of [
			["sequence", 1],
			["seq", 2],
			["state_change_sequence", 3],
			["state_change_seq", 4],
		] as const) {
			expect(await parseItem({ [field]: sequence }), `the ${field} name`).toMatchObject({
				sequence,
			});
		}
		// The first name wins when herdr reports two of them.
		expect(await parseItem({ sequence: 1, seq: 9 })).toMatchObject({ sequence: 1 });
		// A value that is not a number leaves the sequence off the item.
		expect(await parseItem({ seq: "not a number" })).not.toHaveProperty("sequence");
		expect(await parseItem({ sequence: null, seq: 2 })).toMatchObject({ sequence: 2 });
	});

	test("reads every name herdr may give the checkout path", async () => {
		// herdr 0.8.2 names this field `cwd`; the other two are accepted
		// aliases. See the turn sequence note for the same rule.
		for (const [field, checkout] of [
			["checkout_path", "/a"],
			["cwd", "/b"],
			["working_directory", "/c"],
		] as const) {
			expect(await parseItem({ [field]: checkout }), `the ${field} name`).toMatchObject({
				checkoutPath: checkout,
			});
		}
		expect(await parseItem({ cwd: "/b", checkout_path: "/a" })).toMatchObject({
			checkoutPath: "/a",
		});
		expect(await parseItem({ cwd: 7 })).not.toHaveProperty("checkoutPath");
	});

	test("reads every name herdr may give the stable session identity", async () => {
		// herdr 0.8.2 sends no stable session id at all, which is why the
		// reader keeps two aliases and the Coordinator holds its stored id
		// when a verified Agent reports none: issue #24.
		for (const [field, stable] of [
			["session_id", "s1"],
			["agent_session_id", "s2"],
		] as const) {
			expect(await parseItem({ [field]: stable }), `the ${field} name`).toMatchObject({
				stableSessionId: stable,
			});
		}
		expect(await parseItem({ agent_session_id: "s2", session_id: "s1" })).toMatchObject({
			stableSessionId: "s1",
		});
		expect(await parseItem({ session_id: 7 })).not.toHaveProperty("stableSessionId");
	});

	test("an item with no readable status reads as unknown", async () => {
		expect(await parseItem({})).toMatchObject({ status: "unknown" });
		expect(await parseItem({ agent_status: 7 })).toMatchObject({ status: "unknown" });
		expect(await parseItem({ agent_status: "busy" })).toMatchObject({ status: "busy" });
	});

	test("only a path session handle gives a session path", async () => {
		expect(await parseItem({ agent_session: { kind: "path", value: "/s/jsonl" } })).toMatchObject({
			sessionId: "/s/jsonl",
		});
		expect(await parseItem({ agent_session: { kind: "id", value: "/s/jsonl" } })).toMatchObject({
			sessionId: "",
		});
		expect(await parseItem({ agent_session: { kind: "path", value: 7 } })).toMatchObject({
			sessionId: "",
		});
	});

	test("drops items without a usable pane id or agent name", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: JSON.stringify({
				result: {
					agents: [
						// A missing handle is unusable, and so is an empty one: an
						// empty string names no pane and no agent, so the item can
						// never be addressed, and it must not claim a ticket.
						{ agent: "pi", agent_status: "working" },
						{ pane_id: "", agent: "pi", agent_status: "working" },
						{ pane_id: "pane-no-agent", agent_status: "working" },
						{ pane_id: "pane-empty-name", agent: "", agent_status: "working" },
						{ pane_id: "pane-kept", agent: "pi", agent_status: "working" },
					],
				},
			}),
		});
		expect(await new HerdrAgentReader(runner).listAgents()).toEqual({
			kind: "ok",
			agents: [
				{
					paneId: "pane-kept",
					tabId: "",
					workspaceId: "",
					agent: "pi",
					status: "working",
					sessionId: "",
				},
			],
		});
	});

	test("keeps an item with a non-record session handle but no session path", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: JSON.stringify({
				result: {
					agents: [
						{
							pane_id: "pane-1",
							tab_id: "tab-1",
							workspace_id: "ws-1",
							agent: "pi",
							agent_status: "idle",
							agent_session: null,
						},
					],
				},
			}),
		});
		const probe = await new HerdrAgentReader(runner).listAgents();
		expect(probe).toEqual(
			expect.objectContaining({
				agents: [expect.objectContaining({ paneId: "pane-1", sessionId: "" })],
			}),
		);
	});

	test("degrades non-string handles and a non-number sequence", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: JSON.stringify({
				result: {
					agents: [
						{
							pane_id: "pane-1",
							tab_id: 7,
							workspace_id: null,
							agent: "pi",
							agent_status: "idle",
							sequence: "not a number",
						},
					],
				},
			}),
		});
		const probe = await new HerdrAgentReader(runner).listAgents();
		expect(probe).toEqual({
			kind: "ok",
			agents: [
				{
					paneId: "pane-1",
					tabId: "",
					workspaceId: "",
					agent: "pi",
					status: "idle",
					sessionId: "",
				},
			],
		});
	});

	test("reports an agent list that is not JSON with a readable reason", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: "not JSON" });
		expect(await new HerdrAgentReader(runner).listAgents()).toEqual({
			kind: "error",
			reason: "herdr agent list did not return a readable agent list",
		});
	});

	test("reports the failed herdr command's readable reason", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			code: 1,
			stderr: "herdr session is gone\nmore detail",
		});
		expect(await new HerdrAgentReader(runner).listAgents()).toEqual({
			kind: "error",
			reason: "herdr session is gone",
		});
	});
});

describe("the observation cycle", () => {
	test("marks a working agent's ticket running and settles a done one into awaiting", async () => {
		const { state, coordinator } = rig({ agents: [agent("pane-implement", "working")] });
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();

		const done = rig({ agents: [agent("pane-implement", "done")] });
		handOut(done.state, "github:github.com:I_5");
		done.advance(30_001);
		await done.coordinator.tick();
		const [ticket] = done.state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({
					message: "Done. message of pane-implement",
					decision: null,
				}),
			}),
		);
		done.state.close();
	});

	test("settle reads the turn log from the agent's session record, not the pane", async () => {
		const calls: Array<{ kind: string; sessionId: string }> = [];
		const paneReads: string[] = [];
		const entries: TurnLogEntry[] = [
			{ kind: "text", text: "I looked at the code." },
			{ kind: "tool", name: "bash", target: "npm test", failed: false },
			{ kind: "text", text: "Done. The tests pass." },
		];
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", "done", "/tmp/session.jsonl")],
			turnLogs: async (kind, sessionId) => {
				calls.push({ kind, sessionId });
				return { kind: "ended", turnEnd: { log: entries, cause: "completed", detail: "" } };
			},
			readPane: async (paneId) => {
				paneReads.push(paneId);
				return "the pane capture";
			},
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket.state).toBe("awaiting");
		// The session record wins: the trace holds the log and its final
		// text, and the pane was never read.
		expect(calls).toEqual([{ kind: "pi", sessionId: "/tmp/session.jsonl" }]);
		expect(paneReads).toEqual([]);
		expect(ticket.lastCompletion).toEqual(
			expect.objectContaining({
				message: "Done. The tests pass.",
				turnLog: entries,
				decision: null,
			}),
		);
		state.close();
	});

	test("settle falls back to the pane capture when the session log is missing", async () => {
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", "done", "/tmp/session.jsonl")],
			turnLogs: async () => ({ kind: "unavailable" }),
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket.state).toBe("awaiting");
		// The capture stands in: the message is the raw output, and its
		// lines become a plain-text log.
		expect(ticket.lastCompletion).toEqual(
			expect.objectContaining({
				message: "Done. message of pane-implement",
				turnLog: [{ kind: "text", text: "Done. message of pane-implement" }],
				decision: null,
			}),
		);
		state.close();
	});

	test("an agent herdr gives no session for falls back without asking a reader", async () => {
		let asked = false;
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", "done")],
			turnLogs: async () => {
				asked = true;
				return {
					kind: "ended",
					turnEnd: { log: [{ kind: "text", text: "a log" }], cause: "completed", detail: "" },
				};
			},
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(asked).toBe(false);
		expect(ticket.lastCompletion?.message).toBe("Done. message of pane-implement");
		state.close();
	});

	test("an idle agent settles too: the turn ended, even without an explicit done", async () => {
		const { state, coordinator, advance } = rig({ agents: [agent("pane-implement", "idle")] });
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("an idle agent in the startup window does not settle: the handoff is still booting", async () => {
		const { state, coordinator, advance, statuses } = rig({
			agents: [agent("pane-implement", "idle")],
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		// The agent is still booting: the ticket rests in handed-off, with no
		// trace and no settle message.
		expect(state.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		expect(statuses.filter((status) => status.text.includes("settled"))).toHaveLength(0);
		// Past the grace, the same idle agent settles.
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("the grace window is inclusive: one ms short holds, the last ms settles", async () => {
		// The window's last millisecond still settles the turn, so a
		// comparison that reads the boundary as exclusive fails here.
		const { state, coordinator, advance } = rig({ agents: [agent("pane-implement", "idle")] });
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS - 1);
		await coordinator.tick();
		expect(state.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		// One ms more, and the window is over: the same idle agent settles.
		advance(1);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("a working report marks the ticket running but drops no grace", async () => {
		// The flap: herdr reports working while the agent boots, then idle
		// while it parks. The record holds no turn, so the grace stays until
		// the clock says otherwise (ADR 0017).
		const { state, coordinator, setAgents, advance, statuses } = rig({
			agents: [agent("pane-implement", "working", "session-1")],
			turnLogs: async () => ({ kind: "no-turn" }),
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toHaveLength(1);
		setAgents([agent("pane-implement", "idle", "session-1")]);
		await coordinator.tick();
		// Inside the startup window the parked agent does not settle: the
		// turn never started, and the flap did not lift the grace.
		expect(state.ticketsByState(["running"])).toHaveLength(1);
		expect(state.visibleTickets([], "implement").at(0)?.lastCompletion).toBeNull();
		// Past the grace, the parked agent settles no-turn, held.
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket.state).toBe("awaiting");
		expect(ticket.lastCompletion).toEqual(
			expect.objectContaining({
				cause: "no-turn",
				detail: "",
				decision: null,
			}),
		);
		// The hold is loud on the Message line.
		expect(
			statuses.some(
				(status) => status.kind === "warning" && status.text.includes("held (no-turn)"),
			),
		).toBe(true);
		state.close();
	});

	test("a no-turn settle is held: auto mode does not close the cycle", async () => {
		const { state, coordinator, setAgents, advance } = rig({
			autoOn: true,
			agents: [agent("pane-implement", "working", "session-1")],
			turnLogs: async () => ({ kind: "no-turn" }),
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		setAgents([agent("pane-implement", "idle", "session-1")]);
		await coordinator.tick();
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		// The cycle is not closed on a boot screen: the ticket rests in
		// awaiting, the trace held, and the decision is still open.
		expect(ticket.state).toBe("awaiting");
		expect(ticket.lastCompletion).toEqual(
			expect.objectContaining({ cause: "no-turn", decision: null }),
		);
		state.close();
	});

	test("a real turn that ends inside the grace settles at once, on its record", async () => {
		const { state, coordinator, setAgents } = rig({
			agents: [agent("pane-implement", "working", "session-1")],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "the work is done" }],
					cause: "completed",
					detail: "",
				},
			}),
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toHaveLength(1);
		// The record holds the turn's end, so the idle agent settles at once,
		// without waiting out the boot window.
		setAgents([agent("pane-implement", "idle", "session-1")]);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toHaveLength(1);
		state.close();
	});

	test("a held turn settles at once: the startup grace does not guard a failure", async () => {
		const { state, coordinator } = rig({
			agents: [agent("pane-implement", "done", "session-1")],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "the turn failed" }],
					cause: "failed",
					detail: "the build broke",
				},
			}),
		});
		handOut(state, "github:github.com:I_5");
		// No advance: the handoff is still inside the startup window. A turn that
		// demonstrably failed does not wait it out; it settles now, and is held.
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({
					cause: "failed",
					detail: "the build broke",
					decision: null,
				}),
			}),
		);
		state.close();
	});

	test("an awaiting ticket whose agent works again reopens its pending turn", async () => {
		const { state, coordinator, setAgents, advance } = rig({
			agents: [agent("pane-implement", "idle")],
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toHaveLength(1);
		// The agent works again: the settle was premature, and the ticket
		// goes back to running.
		setAgents([agent("pane-implement", "working")]);
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toHaveLength(1);
		// The next settle refreshes the pending trace in place.
		advance(1_000);
		setAgents([agent("pane-implement", "done")]);
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({
					completedAt: "2026-08-31T11:00:31.001Z",
					decision: null,
				}),
			}),
		);
		state.close();
	});

	test("an awaiting ticket with a decided trace does not reopen on a working agent", async () => {
		const { state, coordinator, setAgents, advance } = rig({
			agents: [agent("pane-implement", "idle")],
		});
		const attempt = handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toHaveLength(1);
		// The turn is decided: the routed handoff has not settled yet, so the
		// ticket rests in awaiting wearing a decided trace.
		state.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "handed-off",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		setAgents([agent("pane-implement", "working")]);
		await coordinator.tick();
		// The working agent does not reopen a decided turn.
		expect(state.ticketsByState(["awaiting"])).toHaveLength(1);
		state.close();
	});

	test("an unknown agent neither runs nor settles", async () => {
		const { state, coordinator } = rig({ agents: [agent("pane-implement", "meditating")] });
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("settle reads the last completion lines from the pane", async () => {
		const seen: Array<[string, number]> = [];
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", "done")],
			readPane: async (paneId, lines) => {
				seen.push([paneId, lines]);
				return `line one of ${paneId}\nline two`;
			},
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(seen).toEqual([["pane-implement", config.completionMessageLines]]);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket.lastCompletion?.message).toBe("line one of pane-implement\nline two");
		state.close();
	});

	test("herdr unreachable: the cycle holds and nothing changes", async () => {
		const state = openFactoryState(":memory:");
		state.initializeSources([source]);
		state.applyFetch(source, success([fetched()]));
		handOut(state, "github:github.com:I_5");
		const statuses: string[] = [];
		let changes = 0;
		const coordinator = new ObservationCoordinator({
			state,
			herdr: {
				listAgents: async () => ({ kind: "error", reason: "no herdr session" }),
				readPane: async () => null,
			},
			config: () => config,
			dispatch: mock().mockResolvedValue({ ok: true, queued: false }),
			cleanup: async () => undefined,
			now: () => Date.parse("2026-08-31T11:00:00Z"),
			mode: () => true,
			intervalMs: 60_000,
			onChanged: () => {
				changes += 1;
			},
			onStatus: (_kind, text) => {
				statuses.push(text);
			},
		});
		await coordinator.tick();
		await coordinator.tick();
		expect(state.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		expect(statuses).toEqual([
			"herdr is unreachable: no herdr session; the observation is holding",
		]);
		expect(changes).toBe(1);
		expect(coordinator.lastAgents()).toBeNull();
		state.close();
	});
});

describe("the transition fire of a completed settle", () => {
	test("the loop fires the task type's transition and stores its outcome on the trace", async () => {
		const fires: Array<{ identity: string; taskType: string }> = [];
		const written = outcome({ ticketWrite: { added: ["ready-for-review"], removed: [] } });
		const { state, coordinator, advance } = rig({
			// A session record gives the settle its `completed` cause: the fire
			// reads that cause, so the test must land one.
			agents: [agent("pane-implement", "done", "/tmp/session.jsonl")],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "Done. The pull request is open." }],
					cause: "completed",
					detail: "",
				},
			}),
			fireCompleted: async (ticket) => {
				fires.push({ identity: ticket.ticketIdentity, taskType: ticket.taskType });
				return written;
			},
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		// One fire, on the settled completed turn.
		expect(fires).toEqual([
			{
				identity: "github:github.com:I_5",
				taskType: "implement",
			},
		]);
		expect(state.lastCompletion("github:github.com:I_5")?.transition).toEqual(written);
		state.close();
	});

	test("a held settle fires no transition: the plane writes no label on a turn that did not complete", async () => {
		let fired = 0;
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", "done")],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: { log: [{ kind: "text", text: "It failed." }], cause: "failed", detail: "" },
			}),
			fireCompleted: async () => {
				fired += 1;
				return outcome();
			},
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(fired).toBe(0);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket.state).toBe("awaiting");
		expect(ticket.lastCompletion?.transition).toBeNull();
		state.close();
	});

	test("the fire runs before the completion decision, and its position routes", async () => {
		// Auto mode with no operator: the fired transition's auto-advance and
		// its derived position are what the loop hands off, in one cycle.
		const order: string[] = [];
		const { state, coordinator, advance, intents } = rig({
			autoOn: true,
			agents: [agent("pane-implement", "done", "/tmp/session.jsonl")],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "Done. The pull request is open." }],
					cause: "completed",
					detail: "",
				},
			}),
			fireCompleted: async () => {
				order.push("fire");
				return outcome({
					positionTaskType: "implement",
					positionTicketIdentity: "github:github.com:I_6",
					ticketWrite: { added: ["ready-for-review"], removed: [] },
				});
			},
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const attempt = handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		order.push("decide");
		expect(order).toEqual(["fire", "decide"]);
		// The route enqueued on the position's task, and the trace holds the
		// fire.
		expect(intents.map((intent) => [intent.origin, intent.choice.taskType])).toEqual([
			["workflow", "implement"],
		]);
		// The pickup's start lands the decision, named as the auto mode names
		// it (ADR 0049).
		state.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "auto-handed-off",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		expect(state.lastCompletion("github:github.com:I_5")?.decision).toBe("auto-handed-off");
		state.close();
	});
});

describe("missing agents", () => {
	test("auto mode restarts a missing agent once per episode, with the last message", async () => {
		const { state, intents, coordinator, advance } = rig({ autoOn: true, agents: [] });
		handOut(state, "github:github.com:I_5");
		// The agent ran past the startup grace, then disappeared.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
				previousMessage: "",
				choice: expect.objectContaining({ taskType: "implement" }),
			}),
		]);
		// The second cycle of the same episode does not restart again.
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		state.close();
	});

	test("a restart carries the last completion message", async () => {
		const rigHandle = rig({ autoOn: true, agents: [] });
		const { state, intents, coordinator, advance } = rigHandle;
		const identity = "github:github.com:I_5";
		settleFor(state, identity, "implement");
		// The poll sees the agent working on its still-pending turn: the
		// ticket is in flight again on the same pane, which then disappears
		// from the herdr list.
		rigHandle.setAgents([agent("pane-implement", "working")]);
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity }),
		]);
		rigHandle.setAgents([]);
		// The agent ran past the startup grace, then disappeared.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
				previousMessage: "settled the turn",
				choice: expect.objectContaining({ taskType: "implement" }),
			}),
		]);
		state.close();
	});

	test("a restart keeps the settings the previous handoff ran with", async () => {
		const { state, intents, coordinator, advance } = rig({ autoOn: true, agents: [] });
		const claim = state.claimHandoff(
			"github:github.com:I_5",
			{ ...choice, model: "opus-4", thinking: "high", contextWindow: "272000" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-implement",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// The agent ran past the startup grace, then disappeared.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
				ticketIdentity: "github:github.com:I_5",
				choice: {
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
					model: "opus-4",
					thinking: "high",
					// Recovery repeats the interrupted handoff: every setting it
					// ran with comes back, so a restart cannot widen or narrow
					// the room the agent worked in.
					contextWindow: "272000",
				},
			}),
		]);
		state.close();
	});

	test("manual mode leaves a missing agent for the operator's panel", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.ticketsByState(["handed-off"])).toHaveLength(1);
		state.close();
	});

	test("auto mode restarts a ticket whose pane holds a foreign agent", async () => {
		const { state, intents, coordinator, advance, setAgents } = rig({
			autoOn: true,
			agents: [],
		});
		handOut(state, "github:github.com:I_5");
		// Herdr handed the closed pane's id out again: a different agent works
		// in the ticket's pane. The ticket's own agent is gone, so the missing
		// path runs, not the settle.
		setAgents([agent("pane-implement", "working", "session-1", undefined, "some-other-agent")]);
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({ origin: "restart", ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("manual mode leaves a ticket whose pane holds a foreign agent for the operator", async () => {
		const { state, intents, coordinator, setAgents } = rig({ autoOn: false, agents: [] });
		handOut(state, "github:github.com:I_5");
		setAgents([agent("pane-implement", "working", "session-1", undefined, "some-other-agent")]);
		await coordinator.tick();
		// No automatic restart, and no state correction from the foreign agent.
		expect(intents).toHaveLength(0);
		expect(state.ticketsByState(["running"])).toEqual([]);
		expect(state.ticketsByState(["handed-off"])).toHaveLength(1);
		state.close();
	});

	test("an awaiting ticket does not resume on a foreign agent in its pane", async () => {
		const { state, coordinator, setAgents } = rig({ agents: [] });
		settleFor(state, "github:github.com:I_5", "implement");
		expect(state.ticketsByState(["awaiting"])).toHaveLength(1);
		setAgents([agent("pane-implement", "working", "session-1", undefined, "some-other-agent")]);
		await coordinator.tick();
		// The pending turn stays pending: the working agent is not the
		// ticket's own.
		expect(state.ticketsByState(["running"])).toEqual([]);
		expect(state.ticketsByState(["awaiting"])).toHaveLength(1);
		state.close();
	});

	test("a missing agent at the handoff limit is abandoned, not restarted", async () => {
		const { state, intents, cleanups, coordinator, advance } = rig({
			autoOn: true,
			agents: [],
		});
		const identity = "github:github.com:I_5";
		handOut(state, identity);
		// Use up the second handoff the way a restart dispatch would.
		const claim = state.claimHandoff(identity, choice, "restart");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-implement",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// The agent ran past the startup grace, then disappeared.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		// No restart: the ticket is abandoned, its environment is closed, and
		// the auto mode may hand the now-open ticket out again.
		expect(intents.every((intent) => intent.origin !== "restart")).toBe(true);
		expect(cleanups).toEqual([{ paneId: "pane-implement", tabId: "tab-1", workspaceId: "ws-1" }]);
		const [ticket] = state.visibleTickets([], "implement");
		// Back to open, at its handoff limit, never restarted.
		expect(ticket).toEqual(expect.objectContaining({ state: "open", handoffCount: 2 }));
		expect(ticket.lastCompletion?.decision).toBe("abandoned");
		state.close();
	});

	test("a restart enters the queue even while live agents hold every seat", async () => {
		const { state, intents, coordinator, advance } = rig({
			autoOn: true,
			agents: [
				agent("pane-github:github.com:I_6", "working"),
				agent("pane-github:github.com:I_7", "working"),
			],
		});
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		// Two other in-flight tickets with live agents hold both seats.
		for (const identity of ["github:github.com:I_6", "github:github.com:I_7"]) {
			const claim = state.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: `pane-${identity}`,
				tabId: "tab-2",
				workspaceId: "ws-2",
			});
		}
		handOut(state, "github:github.com:I_5");
		// The missing agent ran past the startup grace.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		// The wait lives at the queue, not in the seat (ADR 0051): the
		// restart enters the queue, and the item rests until a seat frees.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
			}),
		]);
		expect(state.workQueue()).toHaveLength(1);
		state.close();
	});

	test("a started agent inside the startup grace is booting, not missing", async () => {
		const { state, intents, claims, coordinator } = rig({
			autoOn: true,
			agents: [],
			dispatchClaims: true,
		});
		await coordinator.tick();
		// The one open ticket dispatched; the limit of two still has room.
		expect(intents).toHaveLength(1);
		// The agent started, but herdr has not listed it yet.
		state.settleHandoff(claims[0], true, undefined, {
			paneId: "pane-fresh",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		await coordinator.tick();
		// Inside the startup grace the agent is booting, not missing: a
		// restart would double-start the turn even though the limit has room.
		expect(intents).toHaveLength(1);
		state.close();
	});

	test("a missing restart skips a ticket the Work queue already waits for", async () => {
		const { state, intents, coordinator, advance } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		handOut(state, identity);
		// The operator's restart waits in the Work queue for a seat.
		expect(
			state.enqueueWork({
				ticketIdentity: identity,
				origin: "restart",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		// The agent ran past the startup grace, then disappeared.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		// The automatic restart holds: the missing agent holds no slot, so the
		// seat is the operator's, and the pickup starts the ticket with the
		// operator's captured choice, not the automatic one.
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a missing agent's restart enters the queue beside the live agents", async () => {
		const { state, intents, coordinator, advance } = rig({
			autoOn: true,
			agents: [agent("pane-github:github.com:I_6", "working")],
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		// One in-flight ticket holds a live seat...
		const claim = state.claimHandoff("github:github.com:I_6", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-github:github.com:I_6",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});
		// ...and the other in-flight ticket's agent is missing past the
		// startup grace.
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		// The seat the item cannot take yet is the wait the queue item
		// holds (ADR 0051): the restart enters the queue beside the live
		// agent's seat.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
				ticketIdentity: "github:github.com:I_5",
			}),
		]);
		state.close();
	});

	test("one restart per cycle: the queue holds the second until the first drains", async () => {
		const { state, intents, coordinator, advance } = rig({ autoOn: true, agents: [] });
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		handOut(state, "github:github.com:I_5");
		handOut(state, "github:github.com:I_6");
		// Past the startup grace both agents are missing, not booting.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		// Both agents are missing, but the top-up adds one item: the queue's
		// depth is its pace, and the second restart waits for the first to
		// drain.
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(expect.objectContaining({ origin: "restart" }));
		// The pickup claims the seat, the start settles, and the item leaves.
		const [item] = state.workQueue();
		if (item === undefined || item.kind !== "handoff") throw new Error("missing queue item");
		const claim = state.claimHandoff(item.ticketIdentity, item.choice, item.origin);
		if (!claim.ok) throw new Error(claim.reason);
		state.removeWorkItem(item.ticketIdentity);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: `pane-${item.ticketIdentity}`,
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// The queue drained: the other missing ticket's restart adds then, and
		// the drained one is booting inside its new grace.
		await coordinator.tick();
		expect(intents).toHaveLength(2);
		state.close();
	});
});

describe("the awaiting rule", () => {
	test("an auto-advance with no position closes the cycle in auto mode", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "review", outcome());
		expect(coordinator.decideAwaiting(0, outcome())).toBe("close");
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		// The re-read gate holds the re-hand until the source re-reads the
		// ticket the close just returned to open.
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("manual mode rests a settled turn in awaiting for the operator", async () => {
		// In manual mode the machine resolves nothing: the settled turn that
		// offers a continuation rests in awaiting, and the operator's Decision
		// screen routes it (ADR 0051).
		for (const transition of [routeOutcome(), null]) {
			const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
			settleFor(state, "github:github.com:I_5", "route", transition);
			await coordinator.tick();
			const [resting] = state.visibleTickets([], "implement");
			expect(resting).toEqual(
				expect.objectContaining({
					state: "awaiting",
					lastCompletion: expect.objectContaining({ decision: null }),
				}),
			);
			expect(intents).toHaveLength(0);
			state.close();
		}
	});

	test("a routable completion routes through the top-up in auto mode", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		// The position is the open ticket the route advances into: the
		// settled ticket rests in awaiting, and the position offers the task.
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		expect(coordinator.decideAwaiting(0, routeOutcome("github:github.com:I_6"))).toBe("route");
		await coordinator.tick();
		// The route enters the queue as the top-up's continuation item, the
		// way the Decision screen's route enters it: the item rests in the
		// queue and the turn rests in awaiting, undecided until the pickup
		// starts it.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: "github:github.com:I_5",
				previousMessage: "settled the turn",
				choice: expect.objectContaining({ taskType: "implement" }),
			}),
		]);
		expect(state.workQueue()).toHaveLength(1);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ decision: null }),
			}),
		);
		state.close();
	});

	test("a failed label write parks the turn for the operator", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const failed = routeOutcome();
		failed.writeFailure = "gh: the write failed";
		settleFor(state, "github:github.com:I_5", "route", failed);
		expect(coordinator.decideAwaiting(0, failed)).toBe("park");
		await coordinator.tick();
		// The plane does not route from labels it did not write: the ticket
		// rests in awaiting, undecided, for the operator's Decision screen.
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ decision: null }),
			}),
		);
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("an automatic route skips a ticket the Work queue already waits for", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "route");
		// The operator's route waits in the Work queue for a seat.
		expect(
			state.enqueueWork({
				ticketIdentity: "github:github.com:I_5",
				origin: "workflow",
				choice,
				previousMessage: "settled the turn",
			}),
		).toEqual({ ok: true });
		await coordinator.tick();
		// The automatic add holds: the seat is the operator's, and the
		// pickup starts the ticket with the operator's captured choice, not
		// the automatic one. It mirrors the skip the automatic restart keeps.
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a decided turn routes no second time: the routed turn rests for the close", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const attempt = settleFor(
			state,
			"github:github.com:I_5",
			"route",
			routeOutcome("github:github.com:I_6"),
		);
		await coordinator.tick();
		// The route to the position enqueues, the way the pickup's start would.
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({ origin: "workflow", ticketIdentity: "github:github.com:I_6" }),
		);
		// The pickup's start lands the decision on the settled turn (ADR 0049),
		// and the item leaves the queue with it.
		state.removeWorkItem("github:github.com:I_6");
		state.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "auto-handed-off",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		// The decided turn offers no second continuation: the empty-queue
		// cycles add no second route, and the turn rests in awaiting for the
		// operator's close.
		await coordinator.tick();
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(1);
		const [resting] = state.visibleTickets([], "implement");
		expect(resting.state).toBe("awaiting");
		expect(resting.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});

	test("a route starts fresh from its target task profile", async () => {
		const targetProfileConfig: FactoryConfig = {
			...config,
			defaultModel: "factory-model",
			taskTypes: {
				...config.taskTypes,
				implement: { ...config.taskTypes.implement, agent: "codex", model: "profile-model" },
			},
		};
		const { state, intents, coordinator } = rig({
			autoOn: true,
			config: targetProfileConfig,
			agents: [],
		});
		// The position is the open ticket the route advances into.
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const claim = state.claimHandoff(
			"github:github.com:I_5",
			// The previous handoff ran on a model and a thinking that differ
			// from the target's own default, so the fresh choice cannot be the
			// inherited one.
			{ ...choice, taskType: "route", model: "opus-4", thinking: "low" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.settleTurn({
			ticketIdentity: "github:github.com:I_5",
			handoffId: claim.claim.attemptId,
			taskType: "route",
			agentType: "pi",
			message: "settled the turn",
			turnLog: [{ kind: "text", text: "settled the turn" }],
			completedAt: "2026-08-31T11:00:00Z",
			transition: routeOutcome("github:github.com:I_6"),
		});
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				ticketIdentity: "github:github.com:I_6",
				previousMessage: "settled the turn",
				choice: {
					agentType: "codex",
					environment: "live-worktree",
					taskType: "implement",
					// The target profile, not the prior handoff, controls every
					// profile setting of this fresh workflow handoff.
					model: "profile-model",
					thinking: "high",
					contextWindow: "",
				},
			}),
		]);
		state.close();
	});

	test("a route degrades to close at the handoff limit", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		const settleForAttempt = settleFor(state, identity, "route", routeOutcome());
		// Use up the second handoff so the ticket sits at its limit: close the
		// first trace, hand it out again, and settle that second turn.
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: settleForAttempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
		// The re-read that the close triggers clears the gate for the claim.
		state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:01:00Z",
			tickets: [fetched()],
		});
		const claim = state.claimHandoff(identity, { ...choice, taskType: "route" }, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "route",
			agentType: "pi",
			message: "again settled",
			turnLog: [{ kind: "text", text: "again settled" }],
			completedAt: "2026-08-31T11:00:00Z",
			transition: routeOutcome(),
		});
		expect(coordinator.decideAwaiting(2, routeOutcome())).toBe("close");
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				handoffCount: 2,
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		// The open walk ignores the ticket at its limit too.
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a routable completion enters the queue even while live agents hold every seat", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [
				agent("pane-github:github.com:I_6", "working"),
				agent("pane-github:github.com:I_7", "working"),
			],
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		// The wait lives at the queue, not in the seat (ADR 0051): the route
		// enters the queue, and the item rests until a seat frees.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: "github:github.com:I_6",
			}),
		]);
		expect(state.workQueue()).toHaveLength(1);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ decision: null }),
			}),
		);
		state.close();
	});

	test("one add per cycle: the queue's depth is the top-up's pace", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		// Two continuations compete in the ticket list order, both advancing
		// into the one open position.
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		settleFor(state, "github:github.com:I_7", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		// The first in the list order adds, and the queue's item holds the
		// second until it drains: one add per cycle.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: "github:github.com:I_5",
			}),
		]);
		state.close();
	});

	test("auto mode closes a fired transition that does not auto-advance", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "implement", outcome({ autoAdvance: false }));
		expect(coordinator.decideAwaiting(0, outcome({ autoAdvance: false }))).toBe("close");
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a route whose start never lands leaves the turn undecided, and the top-up asks again", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		// The start never went live: the pickup drops the item with its
		// warning (ADR 0049) and the queue drains. The record holds no
		// decision the handoff never made, so the top-up's next empty-queue
		// cycle asks again: the failed start consumed nothing.
		state.removeWorkItem("github:github.com:I_6");
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(2);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ decision: null }),
			}),
		);
		state.close();
	});

	test("auto mode closes a completion whose transition never fired", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "research");
		expect(coordinator.decideAwaiting(0, null)).toBe("close");
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		// The gate holds the dispatch until the source re-reads the ticket the
		// loop just handed back, so the close does not re-hand off on the stale
		// fetch the close itself made.
		expect(intents).toHaveLength(0);
		// The re-read lands, and under the handoff limit the ticket is
		// re-handed: the close-and-rehandoff loop the limit bounds.
		state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:01:00Z",
			tickets: [fetched()],
		});
		await coordinator.tick();
		expect(intents).toEqual([expect.objectContaining({ origin: "open", automatic: true })]);
		state.close();
	});
});

test("the open dispatch hands off nothing on a parking state", async () => {
	// The park holds the ticket: the machine matched and offered no task,
	// so the loop starts no agent on it in any mode (ADR 0027).
	const { state, intents, coordinator } = rig({
		autoOn: true,
		agents: [],
		config: {
			workflowStates: [
				{
					name: "waiting-for-a-human",
					match: { sourceKind: "github-issue", labelsNone: ["ready-for-review"] },
				},
			],
		},
	});
	await coordinator.tick();
	expect(intents).toEqual([]);
	const [ticket] = state.visibleTickets(
		[
			{
				name: "waiting-for-a-human",
				match: { sourceKind: "github-issue", labelsNone: ["ready-for-review"] },
			},
		],
		"implement",
	);
	expect(ticket.suggestedTaskType).toBeNull();
	state.close();
});

describe("the open dispatch", () => {
	test("the top-up adds one open ticket per cycle, in the list order", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			dispatchClaims: true,
		});
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		await coordinator.tick();
		// Three eligible tickets: the top-up adds one, the first in the list
		// order, and the queue's item holds the rest until it drains.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
				previousMessage: "",
				choice: expect.objectContaining({
					agentType: BASE_CONFIG.defaultAgent,
					environment: BASE_CONFIG.defaultEnvironment,
					taskType: "implement",
				}),
			}),
		]);
		// The queue drains: the next empty-queue cycle adds the next ticket.
		state.removeWorkItem("github:github.com:I_5");
		await coordinator.tick();
		expect(intents).toHaveLength(2);
		expect(intents[1]).toEqual(
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:I_6",
			}),
		);
		state.close();
	});

	test("a started handoff leaves the open walk's candidates", async () => {
		const { state, intents, claims, coordinator } = rig({
			autoOn: true,
			agents: [],
			dispatchClaims: true,
		});
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		await coordinator.tick();
		// The one open ticket added; the claim moved it out of the open walk.
		expect(intents).toHaveLength(1);
		// The start settles but herdr has not listed the agent yet: the
		// ticket is in flight, so the open walk has no candidate, and the
		// queue's item holds the next add until it drains.
		if (claims[0] === undefined) throw new Error("missing claim");
		state.settleHandoff(claims[0], true, undefined, {
			paneId: "pane-fresh",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		state.close();
	});

	test("auto mode resolves the open ticket's task profile", async () => {
		const profileConfig: FactoryConfig = {
			...config,
			defaultModel: "global-model",
			taskTypes: {
				...config.taskTypes,
				implement: {
					...config.taskTypes.implement,
					agent: "codex",
					model: "profile-model",
					thinking: "high",
					contextWindow: "",
				},
			},
		};
		const { state, intents, coordinator } = rig({
			autoOn: true,
			config: profileConfig,
			agents: [],
		});
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				choice: {
					agentType: "codex",
					environment: "live-worktree",
					taskType: "implement",
					model: "profile-model",
					thinking: "high",
					contextWindow: "",
				},
			}),
		]);
		state.close();
	});

	test("a ticket at its handoff limit is not dispatched", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		for (let round = 0; round < 2; round += 1) {
			const claim = state.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: `pane-${round}`,
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			// Settle the turn so the ticket returns to open, at its limit.
			state.settleTurn({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: "done again",
				turnLog: [{ kind: "text", text: "done again" }],
				completedAt: "2026-08-31T11:00:00Z",
			});
			// implement never auto-closes, so decide the trace by hand to keep
			// the ticket open for the dispatch question.
			state.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:01:00Z",
			});
			// The re-read that the close triggers keeps the ticket listed, and
			// clears the gate for the round that follows.
			state.applyFetch(source, {
				status: "success",
				fetchedAt: `2026-08-31T11:0${2 + round}:00Z`,
				tickets: [fetched()],
			});
		}
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("manual mode never dispatches open tickets", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	/**
	 * Run one full cycle on the fixture ticket and end it after the source's
	 * last read: the shape the gate reasons about.
	 */
	function endedCycle(
		state: FactoryState,
		identity: string,
		decision: "closed" | "auto-closed",
	): void {
		const claim = state.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: `pane-${identity}`,
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "research",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			decision,
			decidedAt: "2026-08-31T11:01:00Z",
		});
	}

	test("a cycle that just ended holds the dispatch until the source re-reads the ticket", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		endedCycle(state, identity, "closed");
		// The stale fetch still lists the ticket, and still reads healthy: the
		// gate, not the projection, holds the dispatch.
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		// The source re-reads and the ticket still wants work: it dispatches.
		state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:02:00Z",
			tickets: [fetched()],
		});
		await coordinator.tick();
		expect(intents.map((intent) => intent.ticketIdentity)).toEqual([identity]);
		state.close();
	});

	test("a cycle that ended on a merged ticket drops it on the re-read", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		endedCycle(state, identity, "auto-closed");
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		// The re-read no longer lists the merged ticket: it leaves the list, and
		// no later cycle can hand it off again on the stale fetch.
		state.applyFetch(source, { status: "success", fetchedAt: "2026-08-31T11:02:00Z", tickets: [] });
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.visibleTickets(config.workflowStates, "implement")).toEqual([]);
		state.close();
	});

	test("a cycle the loop ends asks the app to re-read the ticket's source", async () => {
		const ends: string[] = [];
		const { state, coordinator, cleanups, advance } = rig({
			autoOn: true,
			agents: [],
			onCycleEnd: (identity) => ends.push(identity),
		});
		const identity = "github:github.com:I_5";
		// A closed cycle, and the re-read that clears its gate.
		const first = state.claimHandoff(identity, choice, "open");
		if (!first.ok) throw new Error(first.reason);
		state.settleHandoff(first.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.settleTurn({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			taskType: "research",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:02:00Z",
			tickets: [fetched()],
		});
		// The second cycle uses up the ticket's handoffs, so the missing agent
		// abandons it, the cycle the loop ends.
		const second = state.claimHandoff(identity, choice, "open");
		if (!second.ok) throw new Error(second.reason);
		state.settleHandoff(second.claim.attemptId, true, undefined, {
			paneId: "pane-2",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// The agent ran past the startup grace, then disappeared.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(ends).toEqual([identity]);
		expect(cleanups).toHaveLength(1);
		state.close();
	});

	test("a live agent holding every seat does not hold the open add", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [agent("pane-github:github.com:I_6", "working")],
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const claim = state.claimHandoff("github:github.com:I_6", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-github:github.com:I_6",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		await coordinator.tick();
		// The wait lives at the queue, not in the seat (ADR 0051): the open
		// ticket's add lands anyway, and the item rests until a seat frees.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
			}),
		]);
		expect(state.workQueue()).toHaveLength(1);
		state.close();
	});

	test("the cycle runs the pickup before the top-up, and the top-up skips a queue that holds an item", async () => {
		const order: string[] = [];
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			pickupWorkQueue: async () => 0,
			order,
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		// The operator's start waits in the queue for a seat the pickup's pass
		// does not free.
		expect(
			state.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				origin: "open",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		await coordinator.tick();
		// The pickup ran first, and the queue that holds the operator's item
		// holds the top-up's add until it drains.
		expect(order).toEqual(["pickup"]);
		expect(intents).toEqual([]);
		state.close();
	});

	test("a queue that drains in the pickup's pass leaves the top-up free to add", async () => {
		const order: string[] = [];
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			pickupWorkQueue: async () => {
				// The pickup's pass: the items take their seats and leave.
				const items = state.workQueue();
				for (const item of items) {
					if (item.kind === "handoff") state.removeWorkItem(item.ticketIdentity);
					else state.removeConsultationWorkItem(item.consultationId);
				}
				return items.length;
			},
			order,
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		expect(
			state.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				origin: "open",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		await coordinator.tick();
		// The pickup drained the operator's item, and the queue that is empty
		// again leaves the top-up free to add in the same cycle: the
		// operator's staging starts before the factory's.
		expect(order).toEqual(["pickup", "dispatch:open"]);
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				ticketIdentity: "github:github.com:I_5",
			}),
		]);
		state.close();
	});

	/**
	 * ADR 0034 says a pickup is a manual start, so it runs "in auto or manual
	 * mode alike", and the cycle places the step outside the `autoOn` branch.
	 * This walks that placement: with Auto-handoff off the queue still takes the
	 * free seats, and the automatic dispatches stay held (issue #92).
	 */
	test("the queue picks up with Auto-handoff off, and the automatic dispatches stay held", async () => {
		const order: string[] = [];
		const { state, intents, coordinator } = rig({
			autoOn: false,
			agents: [],
			pickupWorkQueue: async () => 1,
			order,
		});
		// Two open tickets, and a settled awaiting ticket whose type would route
		// in auto mode: with Auto-handoff off only the queue's pickup may start.
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched(), fetched("github:github.com:I_7", [])]),
		);
		settleFor(state, "github:github.com:I_7", "implement");
		await coordinator.tick();
		// The pickup ran, and nothing else did: the open dispatch and the
		// awaiting route both sit behind the `autoOn` gate.
		expect(order).toEqual(["pickup"]);
		expect(intents).toEqual([]);
		state.close();
	});
});

describe("the held turn and the Dispatch pause", () => {
	test("auto mode holds a failed route instead of routing it", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleForCause(state, "github:github.com:I_5", "route", "failed", "the build broke");
		await coordinator.tick();
		// The held gate stops the automatic route: nothing is dispatched.
		expect(intents).toHaveLength(0);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({
					cause: "failed",
					detail: "the build broke",
					decision: null,
				}),
			}),
		);
		state.close();
	});

	test("auto mode holds a failed review instead of auto-closing it", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleForCause(state, "github:github.com:I_5", "review", "failed");
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ cause: "failed", decision: null }),
			}),
		);
		state.close();
	});

	test("auto mode holds a truncated and an aborted turn, not just a failed one", async () => {
		for (const cause of ["truncated", "aborted"] as const) {
			const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
			settleForCause(state, "github:github.com:I_5", "review", cause);
			await coordinator.tick();
			expect(intents).toHaveLength(0);
			const [ticket] = state.visibleTickets([], "implement");
			expect(ticket.state).toBe("awaiting");
			expect(ticket.lastCompletion?.decision).toBe(null);
			state.close();
		}
	});

	test("manual mode holds an auto-close type's held turn: no close, no route", async () => {
		for (const taskType of ["review", "route"]) {
			const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
			settleForCause(state, "github:github.com:I_5", taskType, "failed", "the build broke");
			await coordinator.tick();
			// The gate holds the auto-close type's automatic decision without the
			// operator too: no close, no route, and the turn rests held with its
			// trace undecided.
			expect(intents).toHaveLength(0);
			const [ticket] = state.visibleTickets([], "implement");
			expect(ticket).toEqual(
				expect.objectContaining({
					state: "awaiting",
					lastCompletion: expect.objectContaining({
						cause: "failed",
						detail: "the build broke",
						decision: null,
					}),
				}),
			);
			state.close();
		}
	});

	test("auto mode still decides an unknown turn, which fails open", async () => {
		const { state, coordinator } = rig({ autoOn: true, agents: [] });
		settleForCause(state, "github:github.com:I_5", "review", "unknown");
		await coordinator.tick();
		// unknown is not held: the review auto-closes as it normally would, then
		// the loop re-dispatches the now-open ticket. It never rests as held.
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket.lastCompletion?.decision).toBe("auto-closed");
		state.close();
	});

	test("auto mode still closes a completed route's turn and routes it", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const attempt = settleForCause(
			state,
			"github:github.com:I_5",
			"route",
			"completed",
			"",
			routeOutcome("github:github.com:I_6"),
		);
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({ origin: "workflow", ticketIdentity: "github:github.com:I_6" }),
		);
		// The pickup's start lands the decision, named as the auto mode names it.
		state.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "auto-handed-off",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		const [decided] = state.visibleTickets([], "implement");
		expect(decided.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});

	test("a decided held turn is no longer held and no longer pauses", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const attempt = settleForCause(state, "github:github.com:I_5", "route", "failed");
		expect(state.dispatchPauseActive()).toBe(true);
		// The operator decides the held turn: it is no longer held, and the
		// pause ends.
		state.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		expect(state.dispatchPauseActive()).toBe(false);
		// The gate holds the dispatch until the source re-reads the ticket,
		// so the re-read lands before the dispatch question.
		state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:02:00Z",
			tickets: [fetched()],
		});
		await coordinator.tick();
		// The pause is gone: the now-open ticket dispatches as open.
		expect(intents).toHaveLength(1);
		expect(intents[0].origin).toBe("open");
		state.close();
	});

	test("auto mode's Dispatch pause holds a new open ticket", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		// A held failed trace sits on one ticket. The pause is global, so the
		// fresh open ticket the loop would otherwise dispatch is held too.
		settleForCause(state, "github:github.com:I_5", "review", "failed");
		state.applyFetch(source, success([fetched("github:github.com:I_6")]));
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.ticketState("github:github.com:I_6")).toBe("open");
		state.close();
	});

	test("manual mode never dispatches an open ticket, pause or no", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		settleForCause(state, "github:github.com:I_5", "review", "failed");
		state.applyFetch(source, success([fetched("github:github.com:I_6")]));
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		// Manual mode does not auto-dispatch open tickets at all, pause or no:
		// the ticket stays open for the operator. The pause's one effect in
		// manual mode is the auto-close route, covered by its own test.
		expect(state.ticketState("github:github.com:I_6")).toBe("open");
		state.close();
	});

	test("the pause holds an auto-close type's route in manual mode, like the Parallel limit", async () => {
		const { state, intents, statuses, coordinator } = rig({ autoOn: false, agents: [] });
		state.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		// I_6's completed route predates I_5's held failure, so the pause is on
		// while the completed turn waits for its route. Manual mode never
		// dispatches the open tickets, but the auto-close route still runs
		// there - and the pause holds it, exactly as a full Parallel limit
		// would.
		settleForCause(state, "github:github.com:I_5", "review", "failed");
		const claim = state.claimHandoff(
			"github:github.com:I_6",
			{ ...choice, taskType: "route" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.settleTurn({
			ticketIdentity: "github:github.com:I_6",
			handoffId: claim.claim.attemptId,
			taskType: "route",
			agentType: "pi",
			message: "settled the turn",
			turnLog: [{ kind: "text", text: "settled the turn" }],
			completedAt: "2026-08-31T10:00:00Z",
			cause: "completed",
		});
		expect(state.dispatchPauseActive()).toBe(true);
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		const resting = state
			.visibleTickets([], "implement")
			.find((ticket) => ticket.identity === "github:github.com:I_6");
		expect(resting).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ cause: "completed", decision: null }),
			}),
		);
		// The pause is a state fact, not an auto-mode state: the Message line
		// names it in manual mode too, where it holds the auto-close route.
		expect(statuses.some((s) => s.kind === "warning" && s.text.startsWith("Dispatch pause:"))).toBe(
			true,
		);
		state.close();
	});

	test("a completed turn that cannot route during a pause stays awaiting and routes next cycle", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(
			source,
			success([fetched(), fetched("github:github.com:I_6"), fetched("github:github.com:I_7")]),
		);
		// I_5's held failure trips the pause after I_6's completed turn waited
		// for its route: the pause holds the top-up, the trace stays
		// undecided, and the turn rests in awaiting.
		const heldAttempt = settleForCause(state, "github:github.com:I_5", "review", "failed");
		const claim = state.claimHandoff(
			"github:github.com:I_6",
			{ ...choice, taskType: "route" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		const routeAttempt = claim.claim.attemptId;
		state.settleHandoff(routeAttempt, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.settleTurn({
			ticketIdentity: "github:github.com:I_6",
			handoffId: routeAttempt,
			taskType: "route",
			agentType: "pi",
			message: "settled the turn",
			turnLog: [{ kind: "text", text: "settled the turn" }],
			completedAt: "2026-08-31T10:00:00Z",
			cause: "completed",
			transition: routeOutcome("github:github.com:I_7"),
		});
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		const resting = state
			.visibleTickets([], "implement")
			.find((ticket) => ticket.identity === "github:github.com:I_6");
		expect(resting).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ cause: "completed", decision: null }),
			}),
		);
		// The operator decides the held turn that started the pause: the route
		// is not lost, and the next cycle's top-up takes it to the position.
		state.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: heldAttempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		await coordinator.tick();
		expect(
			intents.some(
				(intent) =>
					intent.origin === "workflow" && intent.routeFromIdentity === "github:github.com:I_6",
			),
		).toBe(true);
		// The pickup's start lands the decision on I_6's settled turn.
		state.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_6",
			handoffId: routeAttempt,
			decision: "auto-handed-off",
			decidedAt: "2026-08-31T11:02:00Z",
		});
		const routed = state
			.visibleTickets([], "implement")
			.find((ticket) => ticket.identity === "github:github.com:I_6");
		expect(routed?.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});

	test("auto mode's Dispatch pause holds a missing agent's restart", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		// A held failed trace sits on one ticket; a different ticket's agent has
		// gone missing. The pause holds the restart, not just the open dispatch.
		settleForCause(state, "github:github.com:I_5", "review", "failed");
		handOut(state, "github:github.com:I_6");
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.ticketState("github:github.com:I_6")).toBe("handed-off");
		state.close();
	});

	test("a completed turn after the held failure ends the pause and frees dispatch", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		settleForCause(state, "github:github.com:I_5", "review", "failed");
		expect(state.dispatchPauseActive()).toBe(true);
		// A completed settle after the held failure clears the pause.
		settleForCause(state, "github:github.com:I_6", "review", "completed");
		expect(state.dispatchPauseActive()).toBe(false);
		await coordinator.tick();
		// The held failure stays held; the completed one auto-closes. The gate
		// holds its re-dispatch until the source re-reads the ticket.
		expect(state.ticketState("github:github.com:I_5")).toBe("awaiting");
		expect(intents).toHaveLength(0);
		state.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:01:00Z",
			tickets: [fetched(), fetched("github:github.com:I_6")],
		});
		await coordinator.tick();
		// The re-read lands, and the now-open ticket dispatches, proving the
		// pause is gone.
		expect(
			intents.some(
				(intent) => intent.origin === "open" && intent.ticketIdentity === "github:github.com:I_6",
			),
		).toBe(true);
		state.close();
	});

	test("the Message line reports the hold and the pause as they happen", async () => {
		const { state, coordinator, statuses } = rig({
			autoOn: true,
			agents: [agent("pane-implement", "done", "session-1")],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "the turn failed" }],
					cause: "failed",
					detail: "the build broke",
				},
			}),
		});
		state.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		handOut(state, "github:github.com:I_5");
		// The held settle names the ticket and the cause on the Message line,
		// and the failed settle trips the Dispatch pause on the same cycle.
		await coordinator.tick();
		expect(
			statuses.some(
				(s) =>
					s.kind === "warning" &&
					s.text === "ticket github:github.com:I_5 held (failed): the build broke",
			),
		).toBe(true);
		expect(statuses.some((s) => s.kind === "warning" && s.text.startsWith("Dispatch pause:"))).toBe(
			true,
		);
		// A completed settle after the held failure clears the pause: the next
		// cycle tells the operator the dispatch resumes.
		settleForCause(state, "github:github.com:I_6", "review", "completed");
		await coordinator.tick();
		expect(
			statuses.some((s) => s.kind === "info" && s.text.startsWith("Dispatch pause cleared:")),
		).toBe(true);
		state.close();
	});

	test("a restart after a held turn with no agent text carries the cause as the previous message", async () => {
		// No startup grace: the agents of this test are about to die, not to boot.
		const { state, intents, setAgents, coordinator } = rig({
			autoOn: true,
			agents: [agent("pane-implement", "working")],
			startupGraceMs: 0,
		});
		state.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		// I_5's failed turn left no agent text: the provider's own words sit in
		// the detail. A later completed settle on another ticket lifts the
		// pause, so the restart is not the pause's to hold.
		const attempt = handOut(state, "github:github.com:I_5");
		state.settleTurn({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			taskType: "implement",
			agentType: "pi",
			message: "",
			turnLog: [],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "failed",
			detail: "the build broke",
		});
		settleForCause(state, "github:github.com:I_6", "review", "completed");
		expect(state.dispatchPauseActive()).toBe(false);
		await coordinator.tick();
		// I_5's agent still works: the held ticket reopens, and its next settle
		// would overwrite the trace. Its trace still carries the cause.
		expect(state.ticketState("github:github.com:I_5")).toBe("running");
		// The agent goes missing: the restart carries the cause and its detail
		// as the previous message, so the next agent reads the wall instead of
		// inheriting silence.
		setAgents([]);
		await coordinator.tick();
		const restarts = intents.filter((intent) => intent.origin === "restart");
		expect(restarts).toEqual([
			expect.objectContaining({
				ticketIdentity: "github:github.com:I_5",
				previousMessage: "previous turn ended failed: the build broke",
			}),
		]);
		state.close();
	});
});

describe("the injectable clock", () => {
	/** The scheduling clock, faked: time moves only when the test fires it. */
	class FakeClock implements RefreshClock {
		readonly delays: number[] = [];
		private nextId = 1;
		private readonly live = new Map<number, { delay: number; callback: () => void }>();

		setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
			const id = this.nextId++;
			this.live.set(id, { delay: milliseconds, callback });
			this.delays.push(milliseconds);
			return id as unknown as ReturnType<typeof setTimeout>;
		}

		clearTimeout(handle: ReturnType<typeof setTimeout>): void {
			this.live.delete(Number(handle));
		}

		/** Fire the oldest pending timer. */
		fireOldest(): void {
			const [id, timer] = [...this.live.entries()][0] ?? [];
			if (timer === undefined) return;
			this.live.delete(id);
			timer.callback();
		}

		get pending(): number {
			return this.live.size;
		}
	}

	/** Drain every pending microtask before continuing the test. */
	async function turns(): Promise<void> {
		await new Promise((resolve) => setImmediate(resolve));
		await Promise.resolve();
	}

	test("the loop polls on the clock, and stop clears the pending poll", async () => {
		const clock = new FakeClock();
		let listCalls = 0;
		const state = openFactoryState(":memory:");
		state.initializeSources([source]);
		state.applyFetch(source, success([fetched()]));
		const coordinator = new ObservationCoordinator({
			state,
			herdr: {
				listAgents: async () => {
					listCalls += 1;
					return { kind: "ok", agents: [] };
				},
				readPane: async () => null,
			},
			config: () => config,
			dispatch: async () => ({ ok: true, queued: false }),
			cleanup: async () => undefined,
			now: () => Date.parse("2026-08-31T11:00:00Z"),
			mode: () => false,
			intervalMs: 5_000,
			clock,
			onChanged: () => undefined,
			onStatus: () => undefined,
		});
		coordinator.start();
		await turns();
		// The first cycle ran at once, and the next poll waits on the clock.
		expect(listCalls).toBe(1);
		expect(clock.delays).toEqual([5_000]);
		expect(clock.pending).toBe(1);

		// Firing the pending poll runs a second cycle and schedules the next.
		clock.fireOldest();
		await turns();
		expect(listCalls).toBe(2);
		expect(clock.delays).toEqual([5_000, 5_000]);

		// Stop cleared the pending poll: nothing is left on the clock.
		coordinator.stop();
		expect(clock.pending).toBe(0);
		state.close();
	});
});

describe("the Consultation parallel seats", () => {
	/**
	 * Seed a Consultation in the given state with a stored Agent in the given
	 * pane, the way a launch records it.
	 */
	function consultationIn(
		state: FactoryState,
		id: string,
		paneId: string,
		stateName: ConsultationState,
	): void {
		state.createConsultation({
			id,
			typeName: "grill",
			agentType: "pi",
			environment: "worktree",
			template: "/grill {input}",
			initialInput: "review auth",
			renderedOpeningPrompt: "/grill review auth",
			repository: { ...fetched().repository, path: "/tmp/factory" },
			agentName: `consultation-${id}`,
		});
		state.recordConsultationAgentHandles(id, {
			paneId,
			tabId: "tab-1",
			workspaceId: "ws-1",
			sessionId: `session-${id}`,
		});
		if (stateName !== "opening") state.setConsultationState(id, stateName);
	}

	test("a working Consultation holds a seat the top-up does not wait on", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [agent("pane-consult", "working")],
			dispatchClaims: true,
		});
		try {
			consultationIn(state, "consultation-working", "pane-consult", "working");
			state.applyFetch(
				source,
				success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
			);
			await coordinator.tick();
			// The wait lives at the gate, not in the seat (ADR 0051): the
			// working Consultation's seat holds the pickup, not the top-up, so
			// the open add lands in the queue anyway.
			expect(intents).toHaveLength(1);
			expect(intents[0]).toEqual(expect.objectContaining({ origin: "open" }));
			expect(state.workQueue()).toHaveLength(1);
		} finally {
			state.close();
		}
	});

	test("a working Consultation holds a seat the restart does not wait on", async () => {
		const { state, intents, coordinator, advance } = rig({
			autoOn: true,
			agents: [agent("pane-consult", "working")],
			config: { maxParallelAgents: 1 },
		});
		try {
			consultationIn(state, "consultation-working", "pane-consult", "working");
			handOut(state, "github:github.com:I_5");
			advance(STARTUP_GRACE_MS + 1);
			await coordinator.tick();
			// The missing agent's restart enters the queue beside the seat the
			// working Consultation holds: the wait lives at the pickup.
			expect(intents).toHaveLength(1);
			expect(intents[0]).toEqual(expect.objectContaining({ origin: "restart", automatic: true }));
			expect(state.ticketState("github:github.com:I_5")).toBe("handed-off");
		} finally {
			state.close();
		}
	});

	test("a Consultation in any state holds no gate over the top-up", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [agent("pane-consult", "working")],
			dispatchClaims: true,
		});
		try {
			consultationIn(state, "consultation-awaiting", "pane-consult", "awaiting-response");
			state.applyFetch(
				source,
				success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
			);
			await coordinator.tick();
			// The awaiting-response Consultation holds no seat, and the top-up
			// holds none either: the open add lands in the queue.
			expect(intents).toHaveLength(1);
			expect(intents[0]).toEqual(expect.objectContaining({ origin: "open" }));
		} finally {
			state.close();
		}
	});
});

describe("Consultation observation identity", () => {
	function openingConsultation(
		state: FactoryState,
		id: string,
		paneId = "pane-1",
		sessionId = "session-1",
	) {
		state.createConsultation({
			id,
			typeName: "grill",
			agentType: "pi",
			environment: "worktree",
			template: "/grill {input}",
			initialInput: "review auth",
			renderedOpeningPrompt: "/grill review auth",
			repository: { ...fetched().repository, path: "/tmp/factory" },
			agentName: `consultation-${id}`,
		});
		state.recordConsultationAgentHandles(id, {
			paneId,
			tabId: "tab-1",
			workspaceId: "ws-1",
			sessionId,
		});
	}

	test("keeps a restart-interrupted opening until explicit recovery", async () => {
		const { state, coordinator } = rig({
			agents: [agent("pane-1", "idle", "", "session-1")],
		});
		try {
			openingConsultation(state, "consultation-opening");
			await coordinator.tick();
			expect(state.consultation("consultation-opening")).toMatchObject({
				state: "opening",
				paneId: "pane-1",
				warning: "Opening Agent verified; explicit recovery is required",
			});
		} finally {
			state.close();
		}
	});

	test("warns when an opening Consultation has an ambiguous Agent match", async () => {
		const { state, coordinator, statuses } = rig({
			agents: [agent("pane-1", "idle", "", "replacement-session")],
		});
		try {
			openingConsultation(state, "opening-ambiguous");
			await coordinator.tick();
			expect(state.consultation("opening-ambiguous")).toMatchObject({
				state: "opening",
				warning: "Opening Agent match is ambiguous; explicit recovery is required",
			});
			expect(statuses).toContainEqual(
				expect.objectContaining({
					kind: "warning",
					text: expect.stringContaining("needs recovery"),
				}),
			);
		} finally {
			state.close();
		}
	});

	test("warns when an opening Consultation Agent is not visible", async () => {
		const { state, coordinator, statuses } = rig({ agents: [] });
		try {
			openingConsultation(state, "opening-not-visible");
			await coordinator.tick();
			expect(state.consultation("opening-not-visible")).toMatchObject({
				state: "opening",
				warning: "Opening Agent is not visible; explicit recovery is required",
			});
			expect(statuses).toContainEqual(
				expect.objectContaining({
					kind: "warning",
					text: expect.stringContaining("needs recovery"),
				}),
			);
		} finally {
			state.close();
		}
	});

	test("moves a working or awaiting Consultation with no Agent to missing", async () => {
		for (const stateName of ["working", "awaiting-response"] as const) {
			const rigged = rig({ agents: [] });
			try {
				openingConsultation(rigged.state, `missing-${stateName}`);
				rigged.state.setConsultationAgent(`missing-${stateName}`, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					sessionId: "session-1",
				});
				if (stateName === "awaiting-response")
					rigged.state.settleConsultationTurn(`missing-${stateName}`, null, "output", "idle");
				await rigged.coordinator.tick();
				expect(rigged.state.consultation(`missing-${stateName}`)).toMatchObject({
					state: "missing",
					warning: "Agent is missing",
				});
				expect(rigged.statuses).toContainEqual(
					expect.objectContaining({
						kind: "warning",
						text: expect.stringContaining("Agent is missing"),
					}),
				);
			} finally {
				rigged.state.close();
			}
		}
	});

	test("moves a working or awaiting Consultation with an ambiguous Agent to missing", async () => {
		for (const stateName of ["working", "awaiting-response"] as const) {
			const rigged = rig({ agents: [agent("pane-1", "idle", "", "other-session")] });
			try {
				openingConsultation(rigged.state, `ambiguous-${stateName}`);
				rigged.state.setConsultationAgent(`ambiguous-${stateName}`, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					sessionId: "session-1",
				});
				if (stateName === "awaiting-response")
					rigged.state.settleConsultationTurn(`ambiguous-${stateName}`, null, "output", "idle");
				await rigged.coordinator.tick();
				expect(rigged.state.consultation(`ambiguous-${stateName}`)).toMatchObject({
					state: "missing",
					warning: "Agent session match is ambiguous",
				});
			} finally {
				rigged.state.close();
			}
		}
	});

	test("keeps a uniquely verified opening state and refreshes its handles", async () => {
		const verified = {
			...agent("pane-new", "idle", "", "session-1"),
			tabId: "tab-new",
			workspaceId: "ws-new",
		};
		const { state, coordinator } = rig({ agents: [verified] });
		try {
			openingConsultation(state, "opening-verified", "pane-old", "session-1");
			await coordinator.tick();
			expect(state.consultation("opening-verified")).toMatchObject({
				state: "opening",
				paneId: "pane-new",
				tabId: "tab-new",
				workspaceId: "ws-new",
				sessionId: "session-1",
				warning: "Opening Agent verified; explicit recovery is required",
			});
		} finally {
			state.close();
		}
	});

	test("gives a verified opening Agent with unknown status the weaker warning", async () => {
		const { state, coordinator } = rig({
			agents: [agent("pane-1", "not reported", "", "session-1")],
		});
		try {
			openingConsultation(state, "opening-unknown");
			await coordinator.tick();
			expect(state.consultation("opening-unknown")).toMatchObject({
				state: "opening",
				warning: "Agent status is unknown",
			});
		} finally {
			state.close();
		}
	});

	// Issue #24: Herdr can omit this optional handle. The known pane is
	// verified at weaker certainty and the stored session id is preserved.
	test("keeps the stored session id when a verified opening Agent has no stable session id", async () => {
		const { state, coordinator } = rig({ agents: [agent("pane-1", "idle")] });
		try {
			openingConsultation(state, "opening-without-stable-id");
			await coordinator.tick();
			expect(state.consultation("opening-without-stable-id")).toMatchObject({
				state: "opening",
				sessionId: "session-1",
				warning: "Opening Agent verified; explicit recovery is required",
			});
		} finally {
			state.close();
		}
	});

	test("does not re-warn an opening Consultation on the next identical poll", async () => {
		const { state, coordinator, statuses } = rig({ agents: [] });
		try {
			openingConsultation(state, "opening-warned");
			await coordinator.tick();
			await coordinator.tick();
			expect(state.consultation("opening-warned")?.warning).toBe(
				"Opening Agent is not visible; explicit recovery is required",
			);
			expect(statuses.filter(({ text }) => text.includes("needs recovery"))).toHaveLength(1);
			// The warning is one message, not a general note: the bar names the
			// Consultation by its short id and nothing else.
			expect(statuses).toContainEqual({
				kind: "warning",
				text: "Consultation opening- needs recovery",
			});
		} finally {
			state.close();
		}
	});

	test("refreshes a live Consultation when any one herdr handle moves", async () => {
		// One handle at a time: a check that stops comparing a handle must let
		// that move go unrecorded, and a stored handle the operator cannot see
		// is a cleanup that closes the wrong pane.
		for (const [moved, value] of [
			["paneId", "pane-new"],
			["tabId", "tab-new"],
			["workspaceId", "ws-new"],
		] as const) {
			const id = `live-${moved}`;
			const reported = {
				...agent("pane-1", "working", "", "session-1"),
				[moved]: value,
			};
			const { state, coordinator } = rig({ agents: [reported] });
			try {
				openingConsultation(state, id);
				state.setConsultationAgent(id, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					sessionId: "session-1",
				});
				await coordinator.tick();
				expect(state.consultation(id), `the moved ${moved}`).toMatchObject({
					state: "working",
					paneId: reported.paneId,
					tabId: reported.tabId,
					workspaceId: reported.workspaceId,
				});
			} finally {
				state.close();
			}
		}
	});

	test("holds a live Consultation's unknown-status warning only while herdr is unsure", async () => {
		const { state, coordinator, statuses, setAgents } = rig({
			agents: [agent("pane-1", "meditating", "", "session-1")],
		});
		try {
			openingConsultation(state, "live-unknown");
			state.setConsultationAgent("live-unknown", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "session-1",
			});
			await coordinator.tick();
			expect(state.consultation("live-unknown")).toMatchObject({
				state: "working",
				warning: "Agent status is unknown",
			});
			expect(statuses).toContainEqual({
				kind: "warning",
				text: "Agent status is unknown for Consultation live-unk",
			});
			// A known status clears it: the warning is the poll's current read,
			// not a mark the Consultation carries for good.
			setAgents([agent("pane-1", "working", "", "session-1")]);
			await coordinator.tick();
			expect(state.consultation("live-unknown")?.warning).toBeNull();
		} finally {
			state.close();
		}
	});

	test("records an external turn only when herdr reports a newer sequence", async () => {
		const open = (sequence: number | undefined) => {
			const rigged = rig({
				agents: [{ ...agent("pane-1", "idle", "", "session-1"), sequence }],
			});
			openingConsultation(rigged.state, "live-sequence");
			rigged.state.setConsultationAgent("live-sequence", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "session-1",
			});
			rigged.state.settleConsultationTurn("live-sequence", 5, "the settled turn", "idle");
			return rigged;
		};
		// The same sequence is the turn the control plane already holds: a new
		// turn would double-count the Agent's own step.
		const same = open(5);
		try {
			await same.coordinator.tick();
			expect(same.state.consultationTurns("live-sequence")).toHaveLength(1);
			expect(same.state.consultation("live-sequence")?.latestSequence).toBe(5);
		} finally {
			same.state.close();
		}
		// A newer sequence is input the operator never sent: it opens a turn of
		// its own, with the placeholder input the modal shows.
		const newer = open(6);
		try {
			await newer.coordinator.tick();
			const turns = newer.state.consultationTurns("live-sequence");
			expect(turns).toHaveLength(2);
			const external = turns.find((turn) => turn.input === "[external Agent input not captured]");
			expect(external, "the turn herdr reported on its own").toBeDefined();
			expect(external?.sequenceBaseline).toBe(5);
			expect(newer.state.consultation("live-sequence")?.latestSequence).toBe(6);
			expect(newer.statuses).toContainEqual({
				kind: "info",
				text: "Consultation live-seq awaits a response",
			});
		} finally {
			newer.state.close();
		}
		// No sequence at all is no evidence of a new turn.
		const unknown = open(undefined);
		try {
			await unknown.coordinator.tick();
			expect(unknown.state.consultationTurns("live-sequence")).toHaveLength(1);
		} finally {
			unknown.state.close();
		}
	});

	test("rejects a reused pane whose stable session differs", async () => {
		const { state, coordinator } = rig({
			agents: [agent("pane-1", "working", "", "replacement-session")],
		});
		try {
			openingConsultation(state, "consultation-mismatch");
			state.setConsultationAgent("consultation-mismatch", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "expected-session",
			});
			await coordinator.tick();
			expect(state.consultation("consultation-mismatch")).toMatchObject({
				state: "missing",
				warning: "Agent session match is ambiguous",
			});
		} finally {
			state.close();
		}
	});

	test("follows a uniquely matched moved session and retargets cleanup resources", async () => {
		const moved = {
			...agent("pane-new", "working", "", "session-1"),
			tabId: "tab-new",
			workspaceId: "ws-new",
		};
		const { state, coordinator } = rig({ agents: [moved] });
		try {
			openingConsultation(state, "consultation-moved");
			state.setConsultationAgent("consultation-moved", {
				paneId: "pane-old",
				tabId: "tab-old",
				workspaceId: "ws-old",
				sessionId: "session-1",
			});
			for (const [kind, resourceId] of [
				["pane", "pane-old"],
				["tab", "tab-old"],
				["workspace", "ws-old"],
			] as const)
				state.recordConsultationResource("consultation-moved", {
					kind,
					resourceId,
					owned: true,
					details: `owned ${kind} ${resourceId}`,
				});
			await coordinator.tick();
			expect(state.consultation("consultation-moved")).toMatchObject({
				paneId: "pane-new",
				tabId: "tab-new",
				workspaceId: "ws-new",
			});
			expect(state.consultationResources("consultation-moved")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "pane", resourceId: "pane-new" }),
					expect.objectContaining({ kind: "tab", resourceId: "tab-new" }),
					expect.objectContaining({ kind: "workspace", resourceId: "ws-new" }),
				]),
			);
		} finally {
			state.close();
		}
	});
});

/**
 * An agent can outlive the work cycle that started it: the Close cleanup
 * cannot remove a dirty checkout, and the operator can re-prompt a settled
 * agent in its herdr pane. The cycle is closed, so the loop stops looking at
 * that pane, and the list reads `open` while the agent works. The poll
 * re-claims the agent it started: the same state correction on read it makes
 * for a ticket still in flight.
 */
describe("an agent that outlives its work cycle", () => {
	const identity = "github:github.com:I_5";
	const PANE = "pane-research";
	// The name the ticket's handoff expects: the stable name of its title,
	// so a leftover agent under it is the ticket's own.
	const NAME = "persist-source-facts";

	/** Hand a ticket out, settle its turn, and close its cycle. */
	function closedCycle(rig_: Pick<Rig, "state" | "advance" | "setAgents">): string {
		const attempt = handOut(rig_.state, identity, "research");
		// Age the cycle so its trace is older than anything the loop settles.
		rig_.advance(90_000);
		rig_.state.settleTurn({
			ticketIdentity: identity,
			handoffId: attempt,
			taskType: "research",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T11:01:30Z",
		});
		rig_.advance(30_000);
		rig_.state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:02:00Z",
		});
		return attempt;
	}

	function ticketOf(state: FactoryState, of = identity) {
		return state.visibleTickets([], "implement").find((ticket) => ticket.identity === of);
	}

	test("a working agent in a closed cycle's pane runs its ticket again", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, statuses, setAgents } = r;
		closedCycle(r);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		// The operator re-prompts the agent in its herdr pane.
		setAgents([agent(PANE, "working", "", undefined, NAME)]);
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toEqual([
			expect.objectContaining({
				ticketIdentity: identity,
				workCycle: 2,
				paneId: PANE,
				taskType: "research",
				agentType: "pi",
			}),
		]);
		expect(ticketOf(state)).toEqual(
			expect.objectContaining({
				state: "running",
				handoffCount: 2,
				handoff: expect.objectContaining({
					environment: "worktree",
					taskType: "research",
					paneId: PANE,
					tabId: "tab-1",
					workspaceId: "ws-1",
				}),
				// The closed cycle keeps its own decided trace.
				lastCompletion: expect.objectContaining({ decision: "closed" }),
			}),
		);
		expect(statuses.map((status) => status.text)).toEqual([expect.stringContaining(identity)]);
		// The same working agent on the next poll records no second handoff.
		await coordinator.tick();
		expect(ticketOf(state)?.handoffCount).toBe(2);
		state.close();
	});

	test("a reclaimed ticket settles into awaiting on its own next idle report", async () => {
		const r = rig({
			agents: [],
			// The reclaimed turn's record holds its end, so the idle report
			// settles it at once (ADR 0017).
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "the reclaimed turn is over" }],
					cause: "completed",
					detail: "",
				},
			}),
		});
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		setAgents([agent(PANE, "working", "session-1", undefined, NAME)]);
		await coordinator.tick();
		setAgents([agent(PANE, "idle", "session-1", undefined, NAME)]);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity, workCycle: 2, taskType: "research" }),
		]);
		expect(state.lastCompletion(identity)).toEqual(
			expect.objectContaining({ decision: null, taskType: "research" }),
		);
		state.close();
	});

	test("an agent that only reports settled or unknown does not restart a closed cycle", async () => {
		for (const status of ["idle", "done", "meditating"]) {
			const rig_ = rig({ agents: [] });
			const { state, coordinator, setAgents } = rig_;
			closedCycle(rig_);
			setAgents([agent(PANE, status)]);
			await coordinator.tick();
			expect(state.ticketsByState(["handed-off", "running", "awaiting"])).toEqual([]);
			expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
			state.close();
		}
	});

	test("a blocked agent in a closed cycle's pane is reclaimed too", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		setAgents([agent(PANE, "blocked", "", undefined, NAME)]);
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity }),
		]);
		state.close();
	});

	test("a pane another ticket holds is never reclaimed", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		// A second ticket is in flight in the very same pane: it owns the agent.
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const other = state.claimHandoff(
			"github:github.com:I_6",
			{ ...choice, taskType: "research" },
			"open",
		);
		if (!other.ok) throw new Error(other.reason);
		state.settleHandoff(other.claim.attemptId, true, undefined, {
			paneId: PANE,
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		setAgents([agent(PANE, "working")]);
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_6" }),
		]);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		state.close();
	});

	test("a reclaimed agent holds a parallel slot against the auto-handoff dispatch", async () => {
		const r = rig({ autoOn: true, agents: [], config: { maxParallelAgents: 1 } });
		const { state, intents, coordinator, setAgents } = r;
		closedCycle(r);
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		setAgents([agent(PANE, "working", "", undefined, NAME)]);
		await coordinator.tick();
		// The reclaimed agent is live: its ticket runs. The slot it holds
		// waits at the pickup, not the top-up (ADR 0051), so the open
		// ticket's add lands in the queue anyway.
		expect(state.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity }),
		]);
		expect(intents).toEqual([
			expect.objectContaining({ origin: "open", ticketIdentity: "github:github.com:I_6" }),
		]);
		state.close();
	});

	test("an agent under another name in a closed cycle's pane is never reclaimed", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		// Herdr handed the closed pane's id out again: a Consultation's agent
		// works in it now. The ticket's stale handle names that pane, but the
		// agent is not the ticket's own, so the poll adopts nothing.
		setAgents([agent(PANE, "working", "", undefined, "consultation-01234567")]);
		await coordinator.tick();
		expect(state.ticketsByState(["handed-off", "running", "awaiting"])).toEqual([]);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		state.close();
	});

	test("an agent herdr does not name in a closed cycle's pane is never reclaimed", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		// The reader cannot verify the agent's identity, so it adopts nothing:
		// a wrong adoption moves the ticket to running on a foreign pane.
		setAgents([agent(PANE, "working")]);
		await coordinator.tick();
		expect(state.ticketsByState(["handed-off", "running", "awaiting"])).toEqual([]);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		state.close();
	});

	test("an unreachable herdr reclaims nothing", async () => {
		const r = rig({ agents: [] });
		const { state, setAgents, statuses } = r;
		closedCycle(r);
		setAgents([agent(PANE, "working")]);
		const holding = new ObservationCoordinator({
			state,
			herdr: {
				listAgents: async () => ({ kind: "error", reason: "herdr is down" }),
				readPane: async () => null,
			},
			config: () => config,
			dispatch: async () => ({ ok: true, queued: false }),
			cleanup: async () => undefined,
			now: () => Date.parse("2026-08-31T11:05:00Z"),
			mode: () => false,
			intervalMs: 60_000,
			onChanged: () => {},
			onStatus: (kind, text) => {
				statuses.push({ kind, text });
			},
		});
		await holding.tick();
		expect(state.ticketsByState(["running"])).toEqual([]);
		state.close();
	});
});

describe("the re-fired skip's route (ADR 0042)", () => {
	const issueIdentity = "github:github.com:I_5";
	const pullSource = { name: "pulls", kind: "github-pull-requests" as const };
	const pullIdentity = "github:github.com:P_12";

	/** The fixing pull request the agent opened, by its labels. */
	function pullTicket(
		labels: readonly string[] = ["ready-for-review"],
		over: Partial<FetchedTicket> = {},
	): FetchedTicket {
		return {
			identity: pullIdentity,
			sourceKind: "github-pull-request",
			externalKey: "#12",
			sourceState: "open",
			url: "https://github.com/acme/factory/pulls/12",
			title: "Persist source facts in state",
			description: "The implementation of #5.",
			labels: [...labels],
			externalUpdatedAt: "2026-08-31T11:00:00Z",
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: {},
			...over,
		};
	}

	/** Land the pull request on the pulls source, the way a refresh would. */
	function landPulls(state: FactoryState, ...pulls: FetchedTicket[]): void {
		state.applyFetch(pullSource, {
			status: "success",
			fetchedAt: "2026-08-31T11:01:00Z",
			tickets: pulls,
		});
	}

	/**
	 * The re-fired skip outcome the trace carries: the fire found the pull
	 * request, wrote its facts, and derived the review position on it.
	 */
	function refiredOutcome(over: Partial<TransitionOutcome> = {}): TransitionOutcome {
		return outcome({
			positionTaskType: "review",
			positionTicketIdentity: pullIdentity,
			refired: true,
			...over,
		});
	}

	/**
	 * The skip's closed cycle on the issue: a settled implement turn that
	 * recorded the transition, then the close that left the ticket open
	 * behind it. The route reads the trace on the open ticket. The turn
	 * settles `completed`, the way a skip turn does: the work is done, and
	 * the Same-type hold keeps the open dispatch from re-running the issue
	 * while the pull request carries the work.
	 */
	function refiredCycle(state: FactoryState, transition: TransitionOutcome): void {
		const attempt = settleForCause(state, issueIdentity, "implement", "completed", "", transition);
		state.applyCompletionDecision({
			ticketIdentity: issueIdentity,
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
	}

	test("manual mode holds the re-fired skip's route for the operator", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		// In manual mode the top-up does not run (ADR 0051): the position
		// rests open and the operator hands it off.
		expect(intents).toEqual([]);
		expect(state.ticketState(pullIdentity)).toBe("open");
		// The issue's closed cycle stands: the route records no decision on it.
		expect(state.lastCompletion(issueIdentity)?.decision).toBe("closed");
		state.close();
	});

	test("an open ticket whose trace re-fired the skip routes the position's task", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		// The route enqueues on the pull request, continues the issue's cycle,
		// and carries the position's task profile and the settled message.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: pullIdentity,
				routeFromIdentity: issueIdentity,
				previousMessage: "settled the turn",
				choice: expect.objectContaining({
					agentType: "pi",
					environment: "live-worktree",
					taskType: "review",
				}),
			}),
		]);
		expect(state.workQueue()).toHaveLength(1);
		// The route records no decision on the issue: its cycle is closed, and
		// the route's decision belongs to the pull request's own turn.
		expect(state.lastCompletion(issueIdentity)?.decision).toBe("closed");
		state.close();
	});

	test("the route runs in auto mode too", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [], dispatchClaims: true });
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		// The route's claim takes the pull request off the open list, so the
		// auto dispatch of the same cycle finds no second start for it, and
		// the issue's closed cycle sits behind its Same-type hold.
		expect(intents).toHaveLength(1);
		expect(intents[0].ticketIdentity).toBe(pullIdentity);
		state.close();
	});

	test("a full parallel limit does not hold the route's enqueue", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [
				agent("pane-github:github.com:I_6", "working"),
				agent("pane-github:github.com:I_7", "working"),
			],
		});
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		for (const identity of ["github:github.com:I_6", "github:github.com:I_7"]) {
			const claim = state.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: `pane-${identity}`,
				tabId: "tab-2",
				workspaceId: "ws-2",
			});
		}
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		// The wait lives at the gate, not in the seat (ADR 0051): the full
		// parallel limit holds the pickup, not the top-up, so the route
		// enqueues anyway.
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({ origin: "workflow", ticketIdentity: pullIdentity }),
		);
		state.close();
	});

	test("a Dispatch pause holds the route", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		// A held failed turn that settled after the completed one pauses
		// automatic dispatch: a completed trace after it would end the pause.
		settleForCause(state, "github:github.com:I_6", "implement", "failed", "the build broke");
		expect(state.dispatchPauseActive()).toBe(true);
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a pull request that no longer offers the task holds the route", async () => {
		for (const labels of [[], ["needs-work"]]) {
			const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
			// No ready-for-review label: the position offers the default task,
			// not the review the outcome names, and the route waits for the
			// labels to stand.
			landPulls(state, pullTicket(labels));
			refiredCycle(state, refiredOutcome());
			await coordinator.tick();
			expect(intents).toHaveLength(0);
			state.close();
		}
	});

	test("a pull request that is not open holds the route", async () => {
		for (const stateShape of ["running", "awaiting"] as const) {
			const { state, intents, setAgents, coordinator } = rig({ autoOn: false, agents: [] });
			landPulls(state, pullTicket());
			// The pull request's own work: in flight, or resting awaiting its
			// own settled turn. Either way it is not open, and the route
			// starts nothing on it.
			const claim = state.claimHandoff(pullIdentity, { ...choice, taskType: "review" }, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: "pane-pull",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			if (stateShape === "running") {
				setAgents([agent("pane-pull", "working")]);
			} else {
				state.settleTurn({
					ticketIdentity: pullIdentity,
					handoffId: claim.claim.attemptId,
					taskType: "review",
					agentType: "pi",
					message: "settled the pull's turn",
					turnLog: [{ kind: "text", text: "settled the pull's turn" }],
					completedAt: "2026-08-31T11:00:00Z",
				});
			}
			refiredCycle(state, refiredOutcome());
			await coordinator.tick();
			expect(intents).toHaveLength(0);
			state.close();
		}
	});

	test("the Same-type hold over the refresh lag holds the route", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		// The pull request ran a review cycle that completed, and its moved
		// labels have not landed: it still wears the labels by which it
		// suggests review. The hold the lag needs is the completed turn of
		// the task it still suggests.
		const attempt = state.claimHandoff(pullIdentity, { ...choice, taskType: "review" }, "open");
		if (!attempt.ok) throw new Error(attempt.reason);
		state.settleHandoff(attempt.claim.attemptId, true, undefined, {
			paneId: "pane-pull",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.settleTurn({
			ticketIdentity: pullIdentity,
			handoffId: attempt.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "the review is done",
			turnLog: [{ kind: "text", text: "the review is done" }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		state.applyCompletionDecision({
			ticketIdentity: pullIdentity,
			handoffId: attempt.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a pull request at its handoff limit holds the route", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		// Two closed cycles put the pull request at the rig's limit of two.
		for (let cycle = 0; cycle < 2; cycle += 1) {
			const attempt = state.claimHandoff(pullIdentity, { ...choice, taskType: "review" }, "open");
			if (!attempt.ok) throw new Error(attempt.reason);
			state.settleHandoff(attempt.claim.attemptId, true, undefined, {
				paneId: "pane-pull",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			state.settleTurn({
				ticketIdentity: pullIdentity,
				handoffId: attempt.claim.attemptId,
				taskType: "review",
				agentType: "pi",
				message: "a done review",
				turnLog: [{ kind: "text", text: "a done review" }],
				completedAt: "2026-08-31T11:00:00Z",
				cause: "aborted",
			});
			state.applyCompletionDecision({
				ticketIdentity: pullIdentity,
				handoffId: attempt.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:00:30Z",
			});
		}
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a re-fired outcome that auto-advances nothing routes nothing", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome({ autoAdvance: false }));
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a re-fired outcome with a failed write routes nothing", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(
			state,
			refiredOutcome({ writeFailure: "gh pr edit #12 failed: HTTP 403", reason: "" }),
		);
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a settle-time outcome routes nothing, re-fired or not", async () => {
		// The marker is the guard: a routable settle-time outcome on an open
		// ticket is not a re-fired skip, and the operator's close of it stands
		// without a second route.
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(
			state,
			outcome({ positionTaskType: "review", positionTicketIdentity: pullIdentity }),
		);
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a trace that records no transition routes nothing", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		const attempt = settleFor(state, issueIdentity, "implement", null);
		state.applyCompletionDecision({
			ticketIdentity: issueIdentity,
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});
});
