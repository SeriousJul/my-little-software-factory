import { join } from "node:path";

import { describe, expect, mock, test } from "bun:test";

import type { FactoryConfig, TransitionOutcome } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { DispatchResult, HandoffIntent } from "../src/handoff-dispatch.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import { NOOP_LOGGER, type Logger } from "../src/logging.ts";
import { agentNameFor } from "../src/naming.ts";
import {
	type AgentReader,
	type AgentWaitResult,
	type AwaitingDecision,
	HerdrAgentReader,
	ObservationCoordinator,
	STARTUP_GRACE_MS,
	stripAnsi,
} from "../src/observation.ts";
import type { RefreshClock } from "../src/refresh.ts";
import type { ConsultationState } from "../src/state/consultation-record.ts";
import type { HandoffOrigin } from "../src/state/handoff.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { SessionTurnRead, TurnEndCause, TurnLogEntry } from "../src/turn-log.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { FakeRunner, tabCreateJson, worktreeOpenJson } from "./fake-runner.ts";
import { infoLine, type RecordedLine, recordLogger } from "./record-logger.ts";
import { rig as rigFixture, type RigOptions, settleFor as settleDispatch } from "./observation-fixture.ts";

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
 * The task types the awaiting rule reasons about (ADR 0027, ADR 0092). The
 * rule decides from the Next step the fired Transition derives, not from a
 * config flag:
 * - review fires and derives no position: it closes at any time.
 * - route fires and derives a Next step onto a position that offers
 *   implement: it routes while the gates hold nothing, and degrades to close
 *   at the handoff limit.
 * - research fires nothing: in auto mode the factory still decides it (close),
 *   and in manual mode it waits for a human.
 * - park carries the Operator-decides flag: its completions rest in awaiting
 *   for the operator ahead of every outcome check (ADR 0085).
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
		park: { template: "park", operatorDecides: true },
	},
	maxParallelAgents: 2,
	maxHandoffsPerTicket: 2,
};

/** The transition outcome the tests settle on: fired, with no Next step. */
function outcome(over: Partial<TransitionOutcome> = {}): TransitionOutcome {
	return {
		fired: true,
		when: null,
		reason: "",
		ticketFacts: [],
		pullRequestFacts: [],
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
 * The route's Next step: the position offers implement and sits on the ticket
 * itself, the way these tests' issue feed has no pull requests.
 */
function routeOutcome(identity = "github:github.com:I_5"): TransitionOutcome {
	return outcome({
		positionTaskType: "implement",
		positionTicketIdentity: identity,
	});
}

/**
 * The automatic rule's answer for the turn the test just settled (ADR 0092):
 * the coordinator reads the completion the state holds, and the Next step
 * derivation reads the projection the state holds.
 */
function ruleFor(
	state: FactoryState,
	coordinator: ObservationCoordinator,
	identity = "github:github.com:I_5",
): AwaitingDecision {
	return coordinator.decideAwaiting(
		state.ticketWorkCycle.lastCompletion(identity),
		state.ticketWorkCycle.ticketProjection(config.workflowStates, config.defaultTaskType),
	).decision;
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
	waitAgent?: (target: string, budgetMs: number) => Promise<AgentWaitResult>,
): AgentReader {
	return {
		listAgents: async () => ({ kind: "ok", agents: agents() }),
		// The AgentReader contract: pane output comes back ANSI stripped.
		readPane:
			readPane ?? (async (paneId) => stripAnsi(`\u001b[1mDone.\u001b[0m message of ${paneId}`)),
		// Absent by default: the loop the tests drive is the poll-only ADR
		// 0006 standing, and the wake tests opt in with their own wait.
		...(waitAgent === undefined ? {} : { waitAgent }),
	};
}

function agent(
	paneId: string,
	fields: { status?: string; sessionId?: string; stableSessionId?: string; name?: string } = {},
): HerdrAgent {
	const { status = "working", sessionId = "", stableSessionId, name } = fields;
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

type Rig = ReturnType<typeof rigFixture>;

/** The suite's rig: the shared fixture over this file's base config. */
const rig = (options: RigOptions = {}): Rig => rigFixture(options, config);

/** Hand an in-flight ticket out so its pane is known to the loop. */
function handOut(state: FactoryState, identity: string, taskType = "implement"): string {
	const claim = state.handoff.claimHandoff(identity, { ...choice, taskType }, "open");
	if (!claim.ok) throw new Error(claim.reason);
	state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
	state.ticketWorkCycle.settleTurn({
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

/**
 * Wait for a line on the cycle's status record: the module's background
 * pickup runs on behind the ask, and its settle lands a few turns after the
 * tick the test reads.
 */
async function untilStatus(
	statuses: readonly { kind: string; text: string }[],
	text: string,
): Promise<void> {
	const end = Date.now() + 5_000;
	for (;;) {
		if (statuses.some((status) => status.text === text)) return;
		if (Date.now() > end) throw new Error("the line never landed: " + text);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/** Hand a ticket out and settle its turn with an explicit cause, so it can rest held. */
function settleForCause(
	state: FactoryState,
	identity: string,
	fields: {
		taskType: string;
		cause: TurnEndCause;
		detail?: string;
		transition?: TransitionOutcome | null;
	},
): string {
	const { taskType, cause, detail = "", transition = null } = fields;
	const attempt = handOut(state, identity, taskType);
	state.ticketWorkCycle.settleTurn({
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
		const { state, coordinator } = rig({
			agents: [agent("pane-implement", { status: "working" })],
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();

		const done = rig({ agents: [agent("pane-implement", { status: "done" })] });
		handOut(done.state, "github:github.com:I_5");
		done.advance(30_001);
		await done.coordinator.tick();
		const [ticket] = done.state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			agents: [agent("pane-implement", { status: "done", sessionId: "/tmp/session.jsonl" })],
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			agents: [agent("pane-implement", { status: "done", sessionId: "/tmp/session.jsonl" })],
			turnLogs: async () => ({ kind: "unavailable" }),
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			agents: [agent("pane-implement", { status: "done" })],
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(asked).toBe(false);
		expect(ticket.lastCompletion?.message).toBe("Done. message of pane-implement");
		state.close();
	});

	test("an idle agent settles too: the turn ended, even without an explicit done", async () => {
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", { status: "idle" })],
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("an idle agent in the startup window does not settle: the handoff is still booting", async () => {
		const { state, coordinator, advance, statuses } = rig({
			agents: [agent("pane-implement", { status: "idle" })],
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		// The agent is still booting: the ticket rests in handed-off, with no
		// trace and no settle message.
		expect(state.ticketWorkCycle.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		expect(statuses.filter((status) => status.text.includes("settled"))).toHaveLength(0);
		// Past the grace, the same idle agent settles.
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("the grace window is inclusive: one ms short holds, the last ms settles", async () => {
		// The window's last millisecond still settles the turn, so a
		// comparison that reads the boundary as exclusive fails here.
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", { status: "idle" })],
		});
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS - 1);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		// One ms more, and the window is over: the same idle agent settles.
		advance(1);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("a working report marks the ticket running but drops no grace", async () => {
		// The flap: herdr reports working while the agent boots, then idle
		// while it parks. The record holds no turn, so the grace stays until
		// the clock says otherwise (ADR 0017).
		const { state, coordinator, setAgents, advance, statuses } = rig({
			agents: [agent("pane-implement", { status: "working", sessionId: "session-1" })],
			turnLogs: async () => ({ kind: "no-turn" }),
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toHaveLength(1);
		setAgents([agent("pane-implement", { status: "idle", sessionId: "session-1" })]);
		await coordinator.tick();
		// Inside the startup window the parked agent does not settle: the
		// turn never started, and the flap did not lift the grace.
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toHaveLength(1);
		expect(
			state.ticketWorkCycle.ticketListViews([], "implement").rows.at(0)?.lastCompletion,
		).toBeNull();
		// Past the grace, the parked agent settles no-turn, held.
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			agents: [agent("pane-implement", { status: "working", sessionId: "session-1" })],
			turnLogs: async () => ({ kind: "no-turn" }),
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		setAgents([agent("pane-implement", { status: "idle", sessionId: "session-1" })]);
		await coordinator.tick();
		advance(30_001);
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			agents: [agent("pane-implement", { status: "working", sessionId: "session-1" })],
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
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toHaveLength(1);
		// The record holds the turn's end, so the idle agent settles at once,
		// without waiting out the boot window.
		setAgents([agent("pane-implement", { status: "idle", sessionId: "session-1" })]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toHaveLength(1);
		state.close();
	});

	test("a held turn settles at once: the startup grace does not guard a failure", async () => {
		const { state, coordinator } = rig({
			agents: [agent("pane-implement", { status: "done", sessionId: "session-1" })],
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			agents: [agent("pane-implement", { status: "idle" })],
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toHaveLength(1);
		// The agent works again: the settle was premature, and the ticket
		// goes back to running.
		setAgents([agent("pane-implement", { status: "working" })]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toHaveLength(1);
		// The next settle refreshes the pending trace in place.
		advance(1_000);
		setAgents([agent("pane-implement", { status: "done" })]);
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			agents: [agent("pane-implement", { status: "idle" })],
		});
		const attempt = handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toHaveLength(1);
		// The turn is decided: the ask ends the cycle in the same write and
		// records the decision (ADR 0072).
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "handed-off",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		expect(state.ticketWorkCycle.ticketsByState(["open"])).toHaveLength(1);
		setAgents([agent("pane-implement", { status: "working" })]);
		await coordinator.tick();
		// The working agent does not reopen a decided turn: the ticket rests
		// open, and the pending-turn resume reads awaiting alone.
		expect(state.ticketWorkCycle.ticketsByState(["open"])).toHaveLength(1);
		state.close();
	});

	test("an unknown agent neither runs nor settles", async () => {
		const { state, coordinator } = rig({
			agents: [agent("pane-implement", { status: "meditating" })],
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
		]);
		state.close();
	});

	test("settle reads the last completion lines from the pane", async () => {
		const seen: Array<[string, number]> = [];
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", { status: "done" })],
			readPane: async (paneId, lines) => {
				seen.push([paneId, lines]);
				return `line one of ${paneId}\nline two`;
			},
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(seen).toEqual([["pane-implement", config.completionMessageLines]]);
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket.lastCompletion?.message).toBe("line one of pane-implement\nline two");
		state.close();
	});

	test("herdr unreachable: the cycle holds and nothing changes", async () => {
		const state = openFactoryState(":memory:");
		state.sourceFact.initializeSources([source]);
		state.sourceFact.applyFetch(source, success([fetched()]));
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
			dispatch: {
				dispatch: mock().mockResolvedValue({ ok: true }),
				dispatchPlaneAction: mock().mockResolvedValue({ ok: true }),
				planeActionRunInFlight: () => false,
				pickupWorkQueue: mock().mockResolvedValue(0),
				closeCleanup: mock().mockResolvedValue(undefined),
			},
			clock: {
				now: () => Date.parse("2026-08-31T11:00:00Z"),
				setTimeout,
				clearTimeout,
			},
			onCycleEnd: () => undefined,
			log: NOOP_LOGGER,
			turnLogs: { read: async () => ({ kind: "unavailable" }) },
			onChanged: () => {
				changes += 1;
			},
			onStatus: (_kind, text) => {
				statuses.push(text);
			},
		});
		await coordinator.tick();
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["handed-off"])).toEqual([
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
			agents: [agent("pane-implement", { status: "done", sessionId: "/tmp/session.jsonl" })],
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
		expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.transition).toEqual(
			written,
		);
		state.close();
	});

	test("a settle whose label write failed states the failure on the Message line", async () => {
		// The fault is loud where the operator looks (ADR 0092): the write failed,
		// so the machine routes nothing from labels it did not write, and the
		// reason lands on the Message line beside the settle that produced it.
		const { state, coordinator, advance, statuses, intents } = rig({
			autoOn: true,
			agents: [agent("pane-implement", { status: "done", sessionId: "/tmp/session.jsonl" })],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "Done. The pull request is open." }],
					cause: "completed",
					detail: "",
				},
			}),
			fireCompleted: async () =>
				outcome({
					ticketWrite: null,
					writeFailure: "gh pr edit #12 failed: HTTP 403",
					positionTaskType: "implement",
					positionTicketIdentity: "github:github.com:I_5",
				}),
		});
		handOut(state, "github:github.com:I_5");
		advance(30_001);
		await coordinator.tick();
		expect(statuses).toContainEqual(
			expect.objectContaining({
				kind: "warning",
				text: "ticket github:github.com:I_5 settled, and its label write failed: gh pr edit #12 failed: HTTP 403",
			}),
		);
		// The turn parks: no route stands, and the ticket keeps its undecided
		// trace for the operator's Decision screen.
		expect(intents).toHaveLength(0);
		expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBeNull();
		state.close();
	});

	test("a held settle fires no transition: the plane writes no label on a turn that did not complete", async () => {
		let fired = 0;
		const { state, coordinator, advance } = rig({
			agents: [agent("pane-implement", { status: "done" })],
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
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket.state).toBe("awaiting");
		expect(ticket.lastCompletion?.transition).toBeNull();
		state.close();
	});

	test("the fire runs before the completion decision, and its position routes", async () => {
		// Auto mode with no operator: the fired transition's Next step and
		// its derived position are what the loop hands off, in one cycle.
		const order: string[] = [];
		const { state, coordinator, advance, intents } = rig({
			autoOn: true,
			agents: [agent("pane-implement", { status: "done", sessionId: "/tmp/session.jsonl" })],
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
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
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
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "auto-handed-off",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBe(
			"auto-handed-off",
		);
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
		rigHandle.setAgents([agent("pane-implement", { status: "working" })]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([
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
		const claim = state.handoff.claimHandoff(
			"github:github.com:I_5",
			{ ...choice, model: "opus-4", thinking: "high", contextWindow: "272000" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
		expect(state.ticketWorkCycle.ticketsByState(["handed-off"])).toHaveLength(1);
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
		setAgents([
			agent("pane-implement", {
				status: "working",
				sessionId: "session-1",
				stableSessionId: undefined,
				name: "some-other-agent",
			}),
		]);
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
		setAgents([
			agent("pane-implement", {
				status: "working",
				sessionId: "session-1",
				stableSessionId: undefined,
				name: "some-other-agent",
			}),
		]);
		await coordinator.tick();
		// No automatic restart, and no state correction from the foreign agent.
		expect(intents).toHaveLength(0);
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([]);
		expect(state.ticketWorkCycle.ticketsByState(["handed-off"])).toHaveLength(1);
		state.close();
	});

	test("an awaiting ticket does not resume on a foreign agent in its pane", async () => {
		const { state, coordinator, setAgents } = rig({ agents: [] });
		settleFor(state, "github:github.com:I_5", "implement");
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toHaveLength(1);
		setAgents([
			agent("pane-implement", {
				status: "working",
				sessionId: "session-1",
				stableSessionId: undefined,
				name: "some-other-agent",
			}),
		]);
		await coordinator.tick();
		// The pending turn stays pending: the working agent is not the
		// ticket's own.
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([]);
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toHaveLength(1);
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
		const claim = state.handoff.claimHandoff(identity, choice, "restart");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
		expect(cleanups).toEqual([
			{
				handoffId: claim.claim.attemptId,
				tabId: "tab-1",
				workspaceId: "ws-1",
				end: "abandoned",
			},
		]);
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		// Back to open, at its handoff limit, never restarted.
		expect(ticket).toEqual(expect.objectContaining({ state: "open", handoffCount: 2 }));
		expect(ticket.lastCompletion?.decision).toBe("abandoned");
		state.close();
	});

	test("a restart enters the queue even while live agents hold every seat", async () => {
		const { state, intents, coordinator, advance } = rig({
			autoOn: true,
			agents: [
				agent("pane-github:github.com:I_6", { status: "working" }),
				agent("pane-github:github.com:I_7", { status: "working" }),
			],
		});
		state.sourceFact.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		// Two other in-flight tickets with live agents hold both seats.
		for (const identity of ["github:github.com:I_6", "github:github.com:I_7"]) {
			const claim = state.handoff.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
		expect(state.workQueue.items()).toHaveLength(1);
		state.close();
	});

	test("the restart walks past a standing row, and its row leads the queue (ADR 0108)", async () => {
		const { state, intents, coordinator, advance } = rig({ autoOn: true, agents: [] });
		// A Consultation stands in the queue for a seat, so the fresh-work
		// walk's empty-queue gate stands (ADR 0051).
		state.consultationRecord.createConsultation({
			id: "22222222-1111-4111-8111-111111111111",
			typeName: "grill",
			agentType: "pi",
			environment: "worktree",
			template: "/grill {input}",
			initialInput: "review auth",
			renderedOpeningPrompt: "/grill review auth",
			repository: { ...fetched().repository, path: "/tmp/factory" },
			agentName: "consultation-a1",
			initialState: "queued",
		});
		// The in-flight ticket's Agent is missing past the Startup grace: the
		// seat it held reads free, and it is the seat its restart row owns.
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		// The standing row does not hold the restart out: the seat the missing
		// Agent left is reserved for it, so the Top-up asks it past the row.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
			}),
		]);
		// The restart row leads the queue, so the pickup takes the reserved
		// seat first and the Consultation waits for the seat that start leaves.
		expect(state.workQueue.items().map((item) => item.kind)).toEqual(["handoff", "consultation"]);
		state.close();
	});

	test("a started agent inside the startup grace is booting, not missing", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		// The agent started, but herdr has not listed it yet: the start settled
		// on the pinned clock, so the grace runs from now.
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		// Inside the startup grace the agent is booting, not missing: a
		// restart would double-start the turn even though the limit has room.
		expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(0);
		state.close();
	});

	test("a missing restart skips a ticket the Work queue already waits for", async () => {
		const { state, intents, coordinator, advance } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		handOut(state, identity);
		// The operator's restart waits in the Work queue for a seat.
		expect(
			state.workQueue.enqueueWork({
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
			agents: [agent("pane-github:github.com:I_6", { status: "working" })],
		});
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		// One in-flight ticket holds a live seat...
		const claim = state.handoff.claimHandoff("github:github.com:I_6", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
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
		const [item] = state.workQueue.items();
		if (item === undefined || item.kind !== "handoff") throw new Error("missing queue item");
		const claim = state.handoff.claimHandoff(item.ticketIdentity, item.choice, item.origin);
		if (!claim.ok) throw new Error(claim.reason);
		state.workQueue.removeWorkItem(item.ticketIdentity);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
	test("a fired transition that derives no Next step closes the cycle in auto mode", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "review", outcome());
		expect(ruleFor(state, coordinator)).toBe("close");
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		// In manual mode the machine resolves nothing: the settled turn with a
		// Next step rests in awaiting, and the operator's Decision screen runs
		// it (ADR 0051, ADR 0092).
		for (const transition of [routeOutcome(), null]) {
			const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
			settleFor(state, "github:github.com:I_5", "route", transition);
			await coordinator.tick();
			const [resting] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		expect(ruleFor(state, coordinator)).toBe("route");
		await coordinator.tick();
		// The route enters the queue as the top-up's continuation item, the
		// way the Decision screen's route enters it: the item rests in the
		// queue, and the ask records the factory's decision on the settled
		// turn and ends its cycle in the same write, so the ticket rests
		// open behind the item (ADR 0064, ADR 0072).
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
		expect(state.workQueue.items()).toHaveLength(1);
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-handed-off" }),
			}),
		);
		state.close();
	});

	test("a failed label write parks the turn for the operator", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const failed = routeOutcome();
		failed.writeFailure = "gh: the write failed";
		settleFor(state, "github:github.com:I_5", "route", failed);
		expect(ruleFor(state, coordinator)).toBe("park");
		await coordinator.tick();
		// The plane does not route from labels it did not write: the ticket
		// rests in awaiting, undecided, for the operator's Decision screen.
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ decision: null }),
			}),
		);
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a Next step a gate holds answers hold, not route (ADR 0092)", async () => {
		// The fired Transition names a review position, and the position's own
		// labels still offer implement. The machine will not take the step, so the
		// word says so: the turn rests in awaiting undecided, the top-up adds
		// nothing, and the Decision screen states the gate beside the row.
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(
			state,
			"github:github.com:I_5",
			"route",
			outcome({ positionTaskType: "review", positionTicketIdentity: "github:github.com:I_5" }),
		);
		expect(ruleFor(state, coordinator)).toBe("hold");
		await coordinator.tick();
		const [resting] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(resting).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ decision: null }),
			}),
		);
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("an Operator-decides type parks every completion ahead of the outcome checks (ADR 0085, ADR 0092)", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "park");
		// The park stands ahead of the outcome checks: a completion without a
		// transition - the case that would close - rests in awaiting instead,
		// undecided, for the operator.
		expect(ruleFor(state, coordinator)).toBe("park");
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ decision: null }),
			}),
		);
		// The top-up adds nothing for the parked turn: a continuation needs a
		// transition that fired, and a parked ticket is not open.
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("an automatic route skips a ticket the Work queue already waits for", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "route");
		// The operator's route waits in the Work queue for a seat.
		expect(
			state.workQueue.enqueueWork({
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

	test("a dropped auto route re-offers the same turn, and the decision re-lands as a no-op (ADR 0064)", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const attempt = settleFor(
			state,
			"github:github.com:I_5",
			"route",
			routeOutcome("github:github.com:I_6"),
		);
		await coordinator.tick();
		// The route to the position enqueues, and the ask records the
		// factory's decision on the settled turn: the turn is decided while
		// the item waits, the way the module's enqueue records it.
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({ origin: "workflow", ticketIdentity: "github:github.com:I_6" }),
		);
		expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBe(
			"auto-handed-off",
		);
		// The route's start dropped: the item leaves the queue, and the
		// decision keeps its place - a second record of the same decision
		// re-lands on the decided trace as a no-op, so the original ask's
		// stamp holds.
		state.workQueue.removeWorkItem("github:github.com:I_6");
		expect(
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: "github:github.com:I_5",
				handoffId: attempt,
				decision: "auto-handed-off",
				decidedAt: "2026-08-31T11:02:00Z",
			}),
		).toBe(false);
		// The dropped auto route re-offers: the empty-queue cycle walks the
		// auto-handed-off turn again, the position still offers the task, and
		// the route enqueues a second time.
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(2);
		const [resting] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		// The second ask re-lands the decision as a no-op, and the ticket rests
		// open, the state the first ask left (ADR 0072).
		expect(resting.state).toBe("open");
		expect(resting.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});

	test("the top-up skips the route's marked trace, the way the removal's mark stands (ADR 0072)", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		// The route to the position enqueues, and the ask records the
		// factory's decision on the settled turn, the way the drop's test
		// leaves it.
		expect(intents).toHaveLength(1);
		expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBe(
			"auto-handed-off",
		);
		// The operator removes the item: the row leaves, and the settled
		// turn's trace takes the removal's mark in the same write.
		expect(state.workQueue.cancelWorkItem("github:github.com:I_6")).toBe(true);
		expect(
			state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.transition?.routeRemoved,
		).toBe(true);
		// The marked trace is not re-offered: the empty-queue cycle walks the
		// decided turn, the mark holds it out, and the removal stands - the
		// machine does not bring the operator's removal back.
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(1);
		// The route's item is the one that stays out: the queue may hold the
		// position's own open add, never the marked route's re-offer.
		expect(
			state.workQueue
				.items()
				.filter((item) => item.kind !== "consultation" && item.origin === "workflow"),
		).toHaveLength(0);
		const [resting] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(resting).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-handed-off" }),
			}),
		);
		state.close();
	});

	/**
	 * ADR 0051's gate list, read by the continuation walk through
	 * `continuationPosition`. Each guard holds the position instead of adding
	 * it. The walks run in auto mode, because manual mode runs no top-up at
	 * all - a guard tested there is the mode gate, not the guard. And each
	 * test asks about the route alone: the same cycle may legitimately hand
	 * the open position off as a new open ticket, and that add is not this
	 * route.
	 */
	describe("the continuation walk's guards (ADR 0051)", () => {
		/**
		 * The config with a State that offers a task of its own on an issue
		 * label: the position's suggested task then differs from the `implement`
		 * the outcome names, which is the "still offers the task" guard.
		 */
		const stateConfig: FactoryConfig = {
			...config,
			workflowStates: [
				{
					name: "on-hold",
					taskType: "polish",
					match: { sourceKind: "github-issue", labelsAny: ["on-hold"] },
				},
			],
		};

		/** One awaiting ticket whose settled turn routes into the open position. */
		function continuationRig(over: { config?: FactoryConfig } = {}) {
			const cfg = over.config ?? config;
			const r = rig({ autoOn: true, agents: [], config: cfg });
			r.state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
			settleFor(r.state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
			return r;
		}

		const routes = (intents: readonly HandoffIntent[]) =>
			intents.filter((intent) => intent.origin === "workflow");

		test("the base walk routes: the position stands open and offers the task", async () => {
			const { state, intents, coordinator } = continuationRig();
			await coordinator.tick();
			expect(routes(intents)).toHaveLength(1);
			state.close();
		});

		test("a position that no longer offers the task holds the continuation", async () => {
			// The `on-hold` label moves the position onto the State that offers
			// polish: the outcome names implement, the position offers polish, and
			// the add waits for the labels the machine wrote to agree with it.
			const { state, intents, coordinator } = continuationRig({ config: stateConfig });
			state.sourceFact.applyFetch(
				source,
				success([fetched("github:github.com:I_6", ["on-hold"]), fetched()]),
			);
			await coordinator.tick();
			expect(routes(intents)).toHaveLength(0);
			state.close();
		});

		test("a position that is not open holds the continuation", async () => {
			const { state, intents, setAgents, coordinator } = continuationRig();
			// The position runs a live turn of its own: it is not open, and the
			// route starts nothing on it.
			handOut(state, "github:github.com:I_6", "implement");
			setAgents([agent("pane-implement", { status: "working" })]);
			await coordinator.tick();
			expect(routes(intents)).toHaveLength(0);
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("running");
			state.close();
		});

		test("a position that is not actionable holds the continuation", async () => {
			const { state, intents, coordinator } = continuationRig();
			// The source's health went unhealthy: an open ticket the plane cannot
			// act on holds the add, the way the claim check refuses it.
			state.sourceFact.applyFetch(source, { status: "failed", reason: "gh is not authenticated" });
			await coordinator.tick();
			expect(routes(intents)).toHaveLength(0);
			state.close();
		});

		/**
		 * An unresolved attempt makes the position both `handoffRecoveryRequired`
		 * and not actionable, and the claim refuses it at the ask, so the walk
		 * reaches the recovery guard only through a position the projection
		 * still shows as open and healthy. This walk pins the fact the guard
		 * shares with the actionable guard and the claim's own ledger check: a
		 * position with an unfinished attempt starts nothing.
		 */
		test("a position with an unfinished attempt holds the continuation", async () => {
			const { state, intents, coordinator } = continuationRig();
			const claim = state.handoff.claimHandoff("github:github.com:I_6", choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			// The projection folds the unfinished attempt into the open position's
			// actionable fact, and the walk reads that fact first: one test of the
			// position's standing, stated twice on the row.
			const position = state.ticketWorkCycle
				.projectedTickets(config.workflowStates, config.defaultTaskType)
				.find((candidate) => candidate.identity === "github:github.com:I_6");
			expect(position?.handoffRecoveryRequired).toBe(true);
			expect(position?.actionable).toBe(false);
			expect(state.handoff.handoffInFlight("github:github.com:I_6")).toBe(true);
			await coordinator.tick();
			expect(routes(intents)).toHaveLength(0);
			// The claim at the ask agrees: the same attempt is a hard refusal, so
			// a route that reached the enqueue would never take a row either.
			expect(state.handoff.handoffClaimCheck("github:github.com:I_6", "workflow")).toEqual({
				ok: false,
				reason: expect.stringContaining("recovery is required"),
			});
			state.close();
		});

		/**
		 * ADR 0100 moves the gate: the queue's depth is no longer the continuation's
		 * hold, so the walk reaches the per-ticket rule inside the dispatch. The row
		 * the operator staged for the position stands, the walk asks its route, and
		 * the one-item-per-ticket rule is what refuses the add.
		 */
		test("a standing row does not hold the continuation, and the position's own waiting row refuses the add", async () => {
			const { state, intents, statuses, lines, coordinator } = continuationRig();
			expect(
				state.workQueue.enqueueWork({
					ticketIdentity: "github:github.com:I_6",
					routeFromIdentity: null,
					origin: "open",
					choice,
					previousMessage: "",
					automatic: false,
				}).ok,
			).toBe(true);
			await coordinator.tick();
			// The walk asked: the queue's depth holds the fresh-work adds, not a
			// continuation (ADR 0051, ADR 0094, ADR 0100).
			expect(routes(intents)).toHaveLength(1);
			// The refusal is the per-ticket rule's, and the row the operator staged
			// stands untouched: the first item keeps its place.
			expect(
				state.workQueue.items().map((item) => {
					if (item.kind !== "handoff") throw new Error("the queue holds no handoff item");
					return [item.ticketIdentity, item.origin, item.automatic];
				}),
			).toEqual([["github:github.com:I_6", "open", false]]);
			// The standing row is a hold, not a start that could not run (issue
			// #327): the record states the fact, and the Message line stays
			// clear.
			expect(
				statuses.some((status) => status.text.includes("already has a waiting queue item")),
			).toBe(false);
			expect(
				lines.some((line) =>
					line.message.includes("the Work queue already holds an item for the Ticket"),
				),
			).toBe(true);
			state.close();
		});

		/**
		 * Close one position's settled turn the way the plane does, and re-read
		 * its source: the cycle ends, the ticket returns to open still wearing the
		 * labels that offer the same task, and only the Same-type hold is left
		 * between it and a second start.
		 */
		function closedSameTypeCycle(state: FactoryState, identity: string): void {
			// The turn settles `completed`: the hold reads the cause of the
			// cycle's last trace, and only a completed turn of the suggested task
			// holds a repeat.
			const attempt = settleForCause(state, identity, {
				taskType: "implement",
				cause: "completed",
			});
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attempt,
				decision: "closed",
				decidedAt: "2026-08-31T11:00:30Z",
			});
			state.sourceFact.applyFetch(source, {
				status: "success",
				fetchedAt: "2026-08-31T11:01:00Z",
				tickets: [fetched(identity), fetched("github:github.com:I_5")],
			});
		}

		test("a position under the Same-type hold holds the continuation", async () => {
			const { state, intents, coordinator } = continuationRig();
			// The position's newest closed cycle completed the very task it still
			// suggests by labels the refresh has not moved: the hold waits for the
			// moved labels to land instead of starting the task twice.
			closedSameTypeCycle(state, "github:github.com:I_6");
			expect(state.ticketWorkCycle.sameTypeHoldActive("github:github.com:I_6", "implement")).toBe(
				true,
			);
			await coordinator.tick();
			expect(routes(intents)).toHaveLength(0);
			state.close();
		});

		/**
		 * A ticket at its handoff limit is ignored (ADR 0051): the limit is the
		 * continuation walk's own guard, not one of the claim's hard gates, so
		 * the walk is the only place that can hold it.
		 */
		test("a position at its handoff limit holds the continuation", async () => {
			const { state, intents, coordinator } = continuationRig();
			// Two closed cycles put the position at the rig's limit of two. Each
			// settles `aborted`, not `completed`, so the Same-type hold stands
			// clear and the limit is the only guard left between the position and
			// the add; each closes with its source re-read, so the ticket stands
			// open and eligible to start.
			for (let cycle = 0; cycle < 2; cycle += 1) {
				const attempt = settleForCause(state, "github:github.com:I_6", {
					taskType: "review",
					cause: "aborted",
				});
				state.ticketWorkCycle.applyCompletionDecision({
					ticketIdentity: "github:github.com:I_6",
					handoffId: attempt,
					decision: "closed",
					decidedAt: "2026-08-31T11:00:30Z",
				});
				state.sourceFact.applyFetch(source, {
					status: "success",
					fetchedAt: `2026-08-31T11:0${cycle + 1}:00Z`,
					tickets: [fetched("github:github.com:I_6"), fetched()],
				});
			}
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("open");
			expect(state.ticketWorkCycle.sameTypeHoldActive("github:github.com:I_6", "implement")).toBe(
				false,
			);
			expect(state.handoff.handoffCount("github:github.com:I_6")).toBe(2);
			await coordinator.tick();
			// The limit holds the step, and a step the Handoff limit holds closes the
			// cycle the way a route at the limit did (ADR 0092): the settled turn
			// ends, its ticket rests open for the operator, and no route row stands
			// in the queue. The top-up's fresh open walk then takes the empty queue
			// with its own item on the settled ticket.
			expect(routes(intents)).toHaveLength(0);
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("open");
			expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBe(
				"auto-closed",
			);
			expect(state.workQueue.items()).toEqual([expect.objectContaining({ origin: "open" })]);
			state.close();
		});

		/**
		 * ADR 0092 records the cross-ticket Handoff limit consequence, and this test
		 * follows it to its end. The gate reads the count of the position the step
		 * stands on, so a settled turn whose Next step lands on a position at its
		 * limit closes, and the top-up's fresh walk re-dispatches the settled ticket
		 * as open work. Each round spends one handoff of the settled ticket's own
		 * budget, and the loop ends where that budget ends: the settled ticket stands
		 * at its own limit, the fresh walk holds it out, the queue stays empty, and the
		 * ticket rests open owing its next start to the operator.
		 */
		test("the cross-ticket limit loop ends at the settled ticket's own limit", async () => {
			const { state, intents, coordinator, advance } = continuationRig();
			const settled = "github:github.com:I_5";
			const position = "github:github.com:I_6";
			/** Re-read both rows, the way a refresh does, at the named time. */
			const reRead = (at: string) =>
				state.sourceFact.applyFetch(source, {
					status: "success",
					fetchedAt: at,
					tickets: [fetched(position), fetched(settled)],
				});
			// The position at the rig's limit of two, the way the test above leaves it.
			for (let cycle = 0; cycle < 2; cycle += 1) {
				const attempt = settleForCause(state, position, { taskType: "review", cause: "aborted" });
				state.ticketWorkCycle.applyCompletionDecision({
					ticketIdentity: position,
					handoffId: attempt,
					decision: "closed",
					decidedAt: "2026-08-31T11:00:30Z",
				});
				reRead(`2026-08-31T11:0${cycle + 1}:00Z`);
			}
			expect(state.handoff.handoffCount(position)).toBe(config.maxHandoffsPerTicket);

			// Turn 1: the settled turn's Next step stands on the limited position, so
			// the turn closes and the fresh walk re-dispatches the settled ticket.
			await coordinator.tick();
			expect(state.ticketWorkCycle.lastCompletion(settled)?.decision).toBe("auto-closed");
			expect(state.workQueue.items()).toEqual([
				expect.objectContaining({ origin: "open", ticketIdentity: settled }),
			]);
			expect(state.handoff.handoffCount(settled)).toBe(1);

			// The item runs: its row leaves the queue, its handoff starts, and its turn
			// settles with the same Next step onto the same limited position. Starting
			// it is what spends the settled ticket's second handoff.
			expect(state.workQueue.removeWorkItem(settled)).toBe(true);
			settleFor(state, settled, "route", routeOutcome(position));
			expect(state.handoff.handoffCount(settled)).toBe(config.maxHandoffsPerTicket);
			advance(60_000);
			reRead("2026-08-31T11:03:00Z");

			// The loop's end: the second turn closes the same way, and the fresh walk
			// now holds the settled ticket out because it stands at its own limit. The
			// queue stays empty, the ticket rests open, and no later cycle adds anything
			// for it.
			await coordinator.tick();
			expect(state.ticketWorkCycle.lastCompletion(settled)?.decision).toBe("auto-closed");
			expect(state.workQueue.items()).toEqual([]);
			expect(state.handoff.handoffCount(settled)).toBe(config.maxHandoffsPerTicket);
			await coordinator.tick();
			await coordinator.tick();
			expect(state.workQueue.items()).toEqual([]);
			expect(state.ticketWorkCycle.ticketState(settled)).toBe("open");
			expect(state.handoff.handoffCount(settled)).toBe(config.maxHandoffsPerTicket);
			expect(intents.filter((intent) => intent.origin === "open")).toHaveLength(1);
			state.close();
		});
	});

	/**
	 * ADR 0092: with no flag anywhere in the config, the Next step the fired
	 * Transition derives is the whole route. These tests run the shipped chain -
	 * implement, review, merge - through the top-up with no keypress, and its
	 * opposite in manual mode.
	 */
	/**
	 * A held Next step stated where the operator reads it (ADR 0092).
	 *
	 * In Auto-handoff mode the Decision screen never opens on a settled turn, so
	 * the Message line is the surface a held step has. These tests drive the real
	 * cycle and read the line the loop reports.
	 */
	describe("a held Next step states itself on the Message line (ADR 0092)", () => {
		/**
		 * One awaiting ticket whose settled turn's Next step stands on another
		 * ticket, and stands held: the outcome names the review, the position's own
		 * labels offer something else, so the gate is the position's task.
		 */
		function heldRig(autoOn: boolean) {
			const r = rig({ autoOn, agents: [] });
			r.state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
			settleFor(
				r.state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "review", positionTicketIdentity: "github:github.com:I_6" }),
			);
			return r;
		}

		const holdLines = (statuses: Rig["statuses"]) =>
			statuses.filter((status) => status.text.includes("holds its Next step"));

		test("the cycle states the held step, its position, and its gate", async () => {
			const { state, coordinator, statuses } = heldRig(true);
			await coordinator.tick();
			expect(statuses).toContainEqual({
				kind: "info",
				text: "ticket github:github.com:I_5 holds its Next step review on github:github.com:I_6: the position no longer offers the task",
			});
			// The hold moves nothing: the turn still owes the operator its decision.
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("awaiting");
			expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBeNull();
			state.close();
		});

		test("one held turn states itself once, cycle after cycle", async () => {
			const { state, coordinator, statuses } = heldRig(true);
			await coordinator.tick();
			expect(holdLines(statuses)).toHaveLength(1);
			// The hold is re-derived every cycle, so the line is a report of the last
			// fact, not a copy of the fact: an unchanged hold says nothing again.
			await coordinator.tick();
			await coordinator.tick();
			expect(holdLines(statuses)).toHaveLength(1);
			state.close();
		});

		test("a hold on the settled ticket's own position names one ticket", async () => {
			const lines: RecordedLine[] = [];
			const { state, coordinator, statuses } = rig({
				autoOn: true,
				agents: [],
				log: recordLogger(lines),
			});
			settleFor(
				state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "review", positionTicketIdentity: "github:github.com:I_5" }),
			);
			await coordinator.tick();
			expect(statuses).toContainEqual({
				kind: "info",
				text: "ticket github:github.com:I_5 holds its Next step review: the position no longer offers the task",
			});
			// The record line names one ticket too: no position is named beside the
			// settled turn's own.
			expect(lines.filter((line) => line.message.startsWith("next step held:"))).toEqual([
				infoLine(
					'next step held: "Persist source facts" review (the position no longer offers the task)',
				),
			]);
			state.close();
		});

		/**
		 * The same fact in the plane's record (issue #223). The Message line is gone by
		 * the time anyone reads the file, so a gated Next step was the one automatic
		 * hold a reviewer could not see after the run: the record carried the start that
		 * never came and nothing about the gate that held it.
		 */
		test("the held step leaves one record line, named the way the record names a ticket", async () => {
			const lines: RecordedLine[] = [];
			const r = rig({ autoOn: true, agents: [], log: recordLogger(lines) });
			r.state.sourceFact.applyFetch(
				source,
				success([
					{ ...fetched("github:github.com:I_6"), title: "Add a webhook retry policy" },
					fetched(),
				]),
			);
			settleFor(
				r.state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "review", positionTicketIdentity: "github:github.com:I_6" }),
			);
			await r.coordinator.tick();
			// The record names the ticket the way its other lines name a ticket, and
			// names the gate in parentheses the way every refusal line names its fact.
			const held = () => lines.filter((line) => line.message.startsWith("next step held:"));
			expect(held()).toEqual([
				infoLine(
					'next step held: "Persist source facts" review on "Add a webhook retry policy" (the position no longer offers the task)',
				),
			]);
			// One fact, one line: the hold is re-derived every poll, and the record
			// states it once while it stands.
			await r.coordinator.tick();
			await r.coordinator.tick();
			expect(held()).toHaveLength(1);
			r.state.close();
		});

		/**
		 * The dedupe the record line uses is the shared standing-fact one (issue
		 * #232): the fact is the ticket, the step, the position, and the gate, and a
		 * hold that changes any of them is a new fact that states itself again, on
		 * both outlets.
		 */
		test("a held Next step whose gate changes is a new fact both outlets state again (issue #232)", async () => {
			const lines: RecordedLine[] = [];
			const r = rig({
				autoOn: true,
				agents: [],
				log: recordLogger(lines),
				config: {
					// The two positions the test moves the step between: the plain
					// position offers implement, the review position the very task
					// the outcome owes.
					workflowStates: [
						{
							name: "ready-for-agent",
							taskType: "implement",
							match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
						},
						{
							name: "ready-for-review",
							taskType: "review",
							match: { sourceKind: "github-issue", labelsAny: ["ready-for-review"] },
						},
					],
				},
			});
			r.state.sourceFact.applyFetch(
				source,
				success([
					{ ...fetched("github:github.com:I_6"), title: "Add a webhook retry policy" },
					fetched(),
				]),
			);
			// The position's newest closed turn completed the review the step owes,
			// so the moment its labels come to offer it the Same-type hold stands
			// ready. Ignored, so the fresh-work walk leaves the test's position
			// alone and the only fact that moves is the gate.
			const written = r.state.ticketWorkCycle.setTicketIgnored("github:github.com:I_6", true, null);
			if (!written.ok) throw new Error(written.reason);
			const attempt = settleForCause(r.state, "github:github.com:I_6", {
				taskType: "review",
				cause: "completed",
			});
			r.state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: "github:github.com:I_6",
				handoffId: attempt,
				decision: "closed",
				decidedAt: "2026-08-31T10:00:30Z",
			});
			settleFor(
				r.state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "review", positionTicketIdentity: "github:github.com:I_6" }),
			);
			await r.coordinator.tick();
			const held = () => lines.filter((line) => line.message.startsWith("next step held:"));
			expect(held()).toEqual([
				infoLine(
					'next step held: "Persist source facts" review on "Add a webhook retry policy" (the position no longer offers the task)',
				),
			]);
			// The refresh moves the position's labels onto the position that offers
			// the review: same ticket, same step, same position, a new gate - a new
			// fact, on both outlets.
			r.state.sourceFact.applyFetch(
				source,
				success([
					{
						...fetched("github:github.com:I_6", ["ready-for-review"]),
						title: "Add a webhook retry policy",
					},
					fetched(),
				]),
			);
			await r.coordinator.tick();
			expect(held()).toEqual([
				infoLine(
					'next step held: "Persist source facts" review on "Add a webhook retry policy" (the position no longer offers the task)',
				),
				infoLine(
					'next step held: "Persist source facts" review on "Add a webhook retry policy" (the Same-type hold stands on the position)',
				),
			]);
			const holdLines = r.statuses.filter((status) => status.text.includes("holds its Next step"));
			expect(holdLines).toHaveLength(2);
			expect(holdLines[1]).toEqual({
				kind: "info",
				text: "ticket github:github.com:I_5 holds its Next step review on github:github.com:I_6: the Same-type hold stands on the position",
			});
			// The stand holds: the new fact, like the old one, states itself once.
			await r.coordinator.tick();
			expect(held()).toHaveLength(2);
			expect(
				r.statuses.filter((status) => status.text.includes("holds its Next step")),
			).toHaveLength(2);
			r.state.close();
		});

		/**
		 * The awaiting walk owns the fact, and the walk reads no held step while the
		 * mode is off: the skip is the cycle's own choice, not the fact leaving, so a
		 * mode that returns to a still-standing hold states nothing again on either
		 * outlet (issue #232).
		 */
		test("a mode that leaves and returns to a standing hold states it once, on both outlets (issue #232)", async () => {
			const lines: RecordedLine[] = [];
			const r = rig({ autoOn: true, agents: [], log: recordLogger(lines) });
			r.state.sourceFact.applyFetch(
				source,
				success([
					{ ...fetched("github:github.com:I_6"), title: "Add a webhook retry policy" },
					fetched(),
				]),
			);
			const attempt = settleFor(
				r.state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "review", positionTicketIdentity: "github:github.com:I_6" }),
			);
			await r.coordinator.tick();
			const held = () => lines.filter((line) => line.message.startsWith("next step held:"));
			expect(held()).toHaveLength(1);
			// The mode leaves: the awaiting walk stops running, and the hold's fact
			// stands the whole time.
			r.setAutoMode(false);
			await r.coordinator.tick();
			await r.coordinator.tick();
			// The mode returns to the still-standing hold: no second line, on either
			// outlet.
			r.setAutoMode(true);
			await r.coordinator.tick();
			expect(held()).toHaveLength(1);
			expect(
				r.statuses.filter((status) => status.text.includes("holds its Next step")),
			).toHaveLength(1);
			// And the fact still retires the way it always did: the ticket that leaves
			// awaiting states a later hold again.
			r.state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: "github:github.com:I_5",
				handoffId: attempt,
				decision: "closed",
				decidedAt: "2026-08-31T10:05:00Z",
			});
			// The source re-read the claim demands after the closed cycle, at its own
			// time.
			r.state.sourceFact.applyFetch(source, {
				status: "success",
				fetchedAt: "2026-08-31T10:06:00Z",
				tickets: [
					{ ...fetched("github:github.com:I_6"), title: "Add a webhook retry policy" },
					fetched(),
				],
			});
			settleFor(
				r.state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "park", positionTicketIdentity: "github:github.com:I_5" }),
			);
			await r.coordinator.tick();
			await r.coordinator.tick();
			expect(held()).toHaveLength(2);
			r.state.close();
		});

		test("manual mode states nothing on the line: the Decision screen is its surface", async () => {
			const { state, coordinator, statuses } = heldRig(false);
			await coordinator.tick();
			expect(holdLines(statuses)).toHaveLength(0);
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("awaiting");
			state.close();
		});

		/**
		 * A settled turn whose facts land the ticket on an Operator-decides position
		 * (ADR 0117): the automatic rule answers hold, the turn rests awaiting with no
		 * decision, and the gate's sentence reaches both surfaces the held step states
		 * on - the Message line and the record.
		 */
		test("a step on an Operator-decides type holds, and the line and the record state its gate (ADR 0117)", async () => {
			const lines: RecordedLine[] = [];
			const { state, coordinator, statuses } = rig({
				autoOn: true,
				agents: [],
				log: recordLogger(lines),
			});
			// The settled turn ran an unflagged type: the park stands on the position's
			// type, the one the fire's labels put the ticket on.
			settleFor(
				state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "park", positionTicketIdentity: "github:github.com:I_5" }),
			);
			await coordinator.tick();
			// The hold moves nothing: the turn rests in awaiting, undecided, and the
			// environment stays untouched - the same rest the position's other gates
			// owe, on its own sentence.
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("awaiting");
			expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBeNull();
			expect(state.workQueue.items()).toHaveLength(0);
			expect(statuses).toContainEqual({
				kind: "info",
				text: "ticket github:github.com:I_5 holds its Next step park: the task type carries Operator-decides",
			});
			// One fact, one line: the record states the hold once while it stands.
			expect(lines.filter((line) => line.message.startsWith("next step held:"))).toEqual([
				infoLine(
					'next step held: "Persist source facts" park (the task type carries Operator-decides)',
				),
			]);
			await coordinator.tick();
			await coordinator.tick();
			expect(lines.filter((line) => line.message.startsWith("next step held:"))).toHaveLength(1);
			expect(statuses.filter((status) => status.text.includes("holds its Next step"))).toHaveLength(
				1,
			);
			state.close();
		});
	});

	describe("the Operator-decides brake holds the type's automatic adds (ADR 0117)", () => {
		/**
		 * The config the walk tests run on: the flagged position offers the park
		 * type, the plain position offers the implement type, and the ship position
		 * offers the merge Plane action the flag's brake also covers.
		 */
		const walkConfig: Partial<FactoryConfig> = {
			workflowStates: [
				{
					name: "spec",
					taskType: "park",
					match: { sourceKind: "github-issue", labelsAny: ["ready-for-spec"] },
				},
				{
					name: "agent",
					taskType: "implement",
					match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
				},
				{
					name: "ship",
					taskType: "merge",
					match: { sourceKind: "github-issue", labelsAny: ["ready-to-ship"] },
				},
			],
		};

		test("the open walk holds the flagged row, stays silent, and falls to the next candidate", async () => {
			const { state, coordinator, intents, statuses } = rig({
				autoOn: true,
				agents: [],
				config: walkConfig,
			});
			// The flagged ticket leads the list: the walk holds it only, falls to the
			// plain row behind it, and asks that start - the hold is not a cycle
			// wait, and it states nothing, the way the parking state's silence is
			// designed.
			state.sourceFact.applyFetch(
				source,
				success([{ ...fetched("github:github.com:I_4"), labels: ["ready-for-spec"] }, fetched()]),
			);
			await coordinator.tick();
			expect(intents).toHaveLength(1);
			expect(intents[0].ticketIdentity).toBe("github:github.com:I_5");
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_4")).toBe("open");
			// The silence is part of the rule: no hold line stands for the row the
			// flag held.
			expect(statuses.filter((status) => status.text.includes("holds")).length).toBe(0);
			expect(statuses.filter((status) => status.text.includes("Operator-decides")).length).toBe(0);
			state.close();
		});

		test("the open walk asks no merge of a flagged Plane action type", async () => {
			const r = rig({
				autoOn: true,
				agents: [],
				order: [],
				config: {
					...walkConfig,
					taskTypes: {
						...config.taskTypes,
						merge: { action: "merge-pull-request", operatorDecides: true },
					},
				},
			});
			// The ticket's labels put it on the ship position, whose task type is the
			// merge. The walk holds the row on the flag's brake and asks no start of
			// the type, handoff or merge: the seat no automatic add takes is not
			// reserved (ADR 0108), and the Decision screen's key is the operator's.
			r.state.sourceFact.applyFetch(source, success([{ ...fetched(), labels: ["ready-to-ship"] }]));
			await r.coordinator.tick();
			// The cycle's own pickup pass runs, and the walk asks nothing.
			expect(r.order).toEqual(["pickup"]);
			expect(r.state.workQueue.items()).toHaveLength(0);
			expect(r.state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("open");
			r.state.close();
		});

		test("the continuation walk answers hold on the flag's gate and asks nothing (ADR 0117)", async () => {
			const r = rig({
				autoOn: true,
				agents: [],
				order: [],
				config: {
					...walkConfig,
					taskTypes: {
						...config.taskTypes,
						merge: { action: "merge-pull-request", operatorDecides: true },
					},
				},
			});
			// The settled turn's fire put the ticket on the ship position, whose task
			// type is the flagged merge. The re-fired skip's route and the
			// continuation's route both read the gate before the position, so neither
			// asks a start of the type, and the turn rests awaiting, undecided, on
			// its own gate's sentence.
			r.state.sourceFact.applyFetch(source, success([{ ...fetched(), labels: ["ready-to-ship"] }]));
			settleFor(
				r.state,
				"github:github.com:I_5",
				"route",
				outcome({ positionTaskType: "merge", positionTicketIdentity: "github:github.com:I_5" }),
			);
			await r.coordinator.tick();
			// The cycle's own pickup pass runs, and the walk asks nothing.
			expect(r.order).toEqual(["pickup"]);
			expect(r.state.workQueue.items()).toHaveLength(0);
			expect(r.state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("awaiting");
			expect(r.state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBeNull();
			expect(r.statuses).toContainEqual({
				kind: "info",
				text: "ticket github:github.com:I_5 holds its Next step merge: the task type carries Operator-decides",
			});
			r.state.close();
		});

		test("the restart walk asks no start of a flagged type, and the Ticket keeps its Missing fact", async () => {
			const { state, coordinator, intents, advance } = rig({ autoOn: true, agents: [] });
			// The interrupted handoff ran the flagged type and its Agent has
			// disappeared: the facts that would make the Ticket the restart
			// candidate all stand, and the flag's brake holds it out. The Missing
			// fact is the operator's surface: their Restart or abandon is the act
			// that answers.
			handOut(state, "github:github.com:I_5", "park");
			advance(STARTUP_GRACE_MS + 1);
			await coordinator.tick();
			await coordinator.tick();
			expect(intents).toEqual([]);
			// The handoff keeps its place: the walk asked no restart, and the
			// Ticket rests in flight on its Missing fact.
			const inFlight = state.ticketWorkCycle.ticketsByState(["handed-off", "running"]);
			expect(inFlight.map((ticket) => ticket.ticketIdentity)).toContain("github:github.com:I_5");
			state.close();
		});
	});

	describe("the Next step chain runs unattended (ADR 0092)", () => {
		/**
		 * The config the chain runs on: the implement Transition lands the review
		 * state, the review Transition lands the ship state, and the ship state
		 * offers the merge Plane action. No advance flag stands anywhere in it, and
		 * the Handoff limit is the dev configuration's, so the chain's three hops
		 * run well inside it.
		 */
		const chainConfig: Partial<FactoryConfig> = {
			maxHandoffsPerTicket: 20,
			taskTypes: {
				implement: {
					template: "implement",
					thinking: "high",
					transition: { ticketFacts: ["ready-for-review"], pullRequestFacts: [] },
				},
				review: {
					template: "review",
					transition: { ticketFacts: ["ready-to-ship"], pullRequestFacts: [] },
				},
				merge: { action: "merge-pull-request", method: "squash" },
			},
			workflowStates: [
				{
					name: "ready-for-review",
					taskType: "review",
					match: { labelsAny: ["ready-for-review"] },
				},
				{
					name: "ready-to-ship",
					taskType: "merge",
					match: { labelsAny: ["ready-to-ship"] },
				},
			],
		};

		/**
		 * Re-read the ticket with the labels the fire landed on it, the way a
		 * source refresh re-reads them. The test's settle stores the outcome on
		 * the trace; the projection's labels are the source's own.
		 */
		function wearLabels(state: FactoryState, labels: readonly string[]): void {
			state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_5", labels)]));
		}

		/** The implement turn's fire: its write lands the review state on the ticket. */
		function implementFire(): TransitionOutcome {
			return outcome({
				ticketWrite: { added: ["ready-for-review"], removed: [] },
				positionTaskType: "review",
				positionTicketIdentity: "github:github.com:I_5",
			});
		}

		/** The review turn's fire: its write lands the ship state the merge stands on. */
		function reviewFire(): TransitionOutcome {
			return outcome({
				ticketWrite: { added: ["ready-to-ship"], removed: ["ready-for-review"] },
				positionTaskType: "merge",
				positionTicketIdentity: "github:github.com:I_5",
			});
		}

		test("implement routes review, and review routes the merge, with no keypress", async () => {
			const { state, intents, planeAsks, statuses, coordinator } = rig({
				autoOn: true,
				agents: [],
				config: chainConfig,
			});
			// Hop 1: the implement turn fired, wrote ready-for-review, and its Next
			// step is the review the labels put on the same ticket.
			settleFor(state, "github:github.com:I_5", "implement", implementFire());
			wearLabels(state, ["ready-for-review"]);
			await coordinator.tick();
			expect(intents[0]).toEqual(
				expect.objectContaining({
					origin: "workflow",
					automatic: true,
					ticketIdentity: "github:github.com:I_5",
					choice: expect.objectContaining({ taskType: "review" }),
				}),
			);
			// The route's ask ended the cycle at the ask (ADR 0072), named as the
			// mode names it.
			expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBe(
				"auto-handed-off",
			);

			// Hop 2: the review item drains, its turn runs and fires, and its Next
			// step is the merge the ship state offers.
			state.workQueue.removeWorkItem("github:github.com:I_5");
			settleFor(state, "github:github.com:I_5", "review", reviewFire());
			wearLabels(state, ["ready-to-ship"]);
			await coordinator.tick();
			// The chain's last hop is a Plane action: the ask took the queue with
			// no keypress from the operator, and the decision landed at the ask.
			expect(intents).toHaveLength(1);
			expect(planeAsks).toEqual([
				expect.objectContaining({ origin: "workflow", taskType: "merge" }),
			]);
			expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBe(
				"auto-merged",
			);
			// The module's own pickup took the item on behind the ask, and the
			// merge run finds no pull request in this feed: the drop's line
			// stands, and the queue is empty again.
			await untilStatus(
				statuses,
				'the merge of "Persist source facts" was not run: no linked pull request was found for the ticket',
			);
			expect(state.workQueue.items()).toEqual([]);
			state.close();
		});

		test("manual mode routes nothing: the same chain rests awaiting", async () => {
			const { state, intents, coordinator } = rig({
				autoOn: false,
				agents: [],
				config: chainConfig,
			});
			settleFor(state, "github:github.com:I_5", "implement", implementFire());
			wearLabels(state, ["ready-for-review"]);
			await coordinator.tick();
			// The Next step stands there for the operator to read, and the machine
			// starts nothing (ADR 0051, ADR 0092).
			expect(intents).toEqual([]);
			expect(state.workQueue.items()).toEqual([]);
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("awaiting");
			expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.decision).toBeNull();
			state.close();
		});
	});

	/**
	 * ADR 0060: an ignored Ticket is out of every automatic start. The rule is one
	 * predicate, `automaticStartBlocked` (widened to the source's mute by ADR 0070),
	 * and each of the four Top-up walks calls it on the row it holds: the
	 * continuation, the re-fired skip, the restart, and the open-ticket add each
	 * hold the Ticket out, and each reconsider it after the un-ignore. The
	 * open-ticket add reads the list with the withhold lifted, so its own call is
	 * what holds the row out - the gate is never a side effect of the view a walk
	 * happens to read. The restart walk is the one that needs its own test the
	 * most: it reads the in-flight tickets directly, not the list, so it asks the
	 * cycle's one read of the wider pile, `automaticStartBlockedTickets`.
	 */
	describe("the ignored ticket holds every automatic start (ADR 0060)", () => {
		const ignore = (state: FactoryState, identity: string): void => {
			const written = state.ticketWorkCycle.setTicketIgnored(identity, true, null);
			if (!written.ok) throw new Error(written.reason);
		};
		const takeBack = (state: FactoryState, identity: string): void => {
			const written = state.ticketWorkCycle.setTicketIgnored(identity, false, null);
			if (!written.ok) throw new Error(written.reason);
		};

		test("the open-ticket add holds an ignored Ticket out, and the un-ignore adds it", async () => {
			const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
			ignore(state, "github:github.com:I_5");
			await coordinator.tick();
			// No row, no counts, and no automatic start: the ask never reaches the
			// queue, and the queue stays empty.
			expect(intents).toEqual([]);
			expect(state.workQueue.items()).toEqual([]);
			takeBack(state, "github:github.com:I_5");
			await coordinator.tick();
			expect(intents).toEqual([
				expect.objectContaining({
					origin: "open",
					automatic: true,
					ticketIdentity: "github:github.com:I_5",
				}),
			]);
			state.close();
		});

		test("the continuation walk holds an ignored position out, and the un-ignore routes it", async () => {
			const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
			state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
			settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
			// The route starts an Agent on the position, so the position's own
			// ignore holds the add: the projection read before the list rule is
			// where the flag needs its test.
			ignore(state, "github:github.com:I_6");
			await coordinator.tick();
			expect(intents.filter((intent) => intent.origin === "workflow")).toEqual([]);
			takeBack(state, "github:github.com:I_6");
			await coordinator.tick();
			expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(1);
			state.close();
		});

		test("the continuation walk holds an ignored settled Ticket out", async () => {
			const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
			state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
			// The operator ignores the Ticket while its turn is in flight, and the
			// turn settles after: the flag stands on the awaiting row, which the list
			// reveals because it owes a decision, and the walk holds the route out.
			const attempt = handOut(state, "github:github.com:I_5");
			ignore(state, "github:github.com:I_5");
			state.ticketWorkCycle.settleTurn({
				ticketIdentity: "github:github.com:I_5",
				handoffId: attempt,
				taskType: "route",
				agentType: "pi",
				message: "settled the turn",
				turnLog: [{ kind: "text", text: "settled the turn" }],
				completedAt: "2026-08-31T11:00:00Z",
				transition: routeOutcome("github:github.com:I_6"),
			});
			await coordinator.tick();
			expect(intents.filter((intent) => intent.origin === "workflow")).toEqual([]);
			state.close();
		});

		test("the restart walk holds an ignored in-flight Ticket out, and keeps holding it", async () => {
			const { state, intents, coordinator, advance, statuses } = rig({
				autoOn: true,
				agents: [],
			});
			handOut(state, "github:github.com:I_5");
			// The agent is gone past the startup grace: the walk would restart it.
			ignore(state, "github:github.com:I_5");
			advance(STARTUP_GRACE_MS + 1);
			const before = statuses.length;
			await coordinator.tick();
			// The plane starts no Agent on work the operator just judged out, even
			// though this walk reads the in-flight tickets, not the list.
			expect(intents.filter((intent) => intent.origin === "restart")).toEqual([]);
			expect(state.workQueue.items()).toEqual([]);
			// The flag is the operator's own and the plane never clears it (ADR 0060):
			// the row is listed again because its work is live, and the gate keeps
			// holding the automatic Restart out cycle after cycle until the operator
			// takes the Ticket back or decides it by hand.
			expect(state.ticketWorkCycle.ignoredTickets().has("github:github.com:I_5")).toBe(true);
			expect(statuses.slice(before).map((status) => status.text)).toEqual([]);
			expect(
				state.ticketWorkCycle
					.ticketListViews([], "implement")
					.rows.map((ticket) => `${ticket.identity}:${ticket.state}`),
			).toEqual(["github:github.com:I_5:handed-off"]);
			await coordinator.tick();
			await coordinator.tick();
			expect(intents.filter((intent) => intent.origin === "restart")).toEqual([]);
			// Take it back: the same walk asks for the restart in the next cycle.
			takeBack(state, "github:github.com:I_5");
			await coordinator.tick();
			expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
			state.close();
		});

		/**
		 * The reveal's own seam (ADR 0060): the ignore hides a resting Ticket and
		 * never live work or a decision owed, so a flag the operator set on a Ticket
		 * stands through its settle and its list never holds an obligation hidden away
		 * for the automatic walks to read - and the row goes back into the pile when
		 * the cycle ends.
		 */
		test("a settle keeps the ignore and reveals the row the held count reads", async () => {
			const { state, coordinator, advance, statuses } = rig({
				autoOn: false,
				agents: [agent("pane-implement", { status: "idle" })],
			});
			handOut(state, "github:github.com:I_5");
			ignore(state, "github:github.com:I_5");
			// Past the startup grace, so the idle report settles the turn at once.
			advance(STARTUP_GRACE_MS + 1);
			const before = statuses.length;
			await coordinator.tick();
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("awaiting");
			// Nothing cleared the flag: the row is listed because it owes a decision,
			// and the obligation reads the same facts the row's face wears.
			expect(state.ticketWorkCycle.ignoredTickets().has("github:github.com:I_5")).toBe(true);
			expect(
				state.ticketWorkCycle
					.ticketListViews([], "implement")
					.rows.map((ticket) => ticket.identity),
			).toEqual(["github:github.com:I_5"]);
			// The obligation the row owes is what the ignore's write refuses
			// (issue #202 review).
			expect(state.ticketWorkCycle.setTicketIgnored("github:github.com:I_5", true, null)).toEqual({
				ok: false,
				reason: "the selected Ticket cannot be ignored: it awaits a decision",
			});
			// The cycle's own settle line is the news; the ignore says nothing twice.
			expect(
				statuses
					.slice(before)
					.map((status) => status.text)
					.some((text) => text.includes("ignored")),
			).toBe(false);
			state.close();
		});

		test("a held settle keeps the ignore, and the row the bell reads", async () => {
			const { state, coordinator } = rig({
				autoOn: false,
				agents: [agent("pane-implement", { status: "done", sessionId: "session-1" })],
				// The session record ends the turn failed: the settle rests held.
				turnLogs: async () => ({
					kind: "ended",
					turnEnd: {
						log: [{ kind: "text", text: "I cannot continue" }],
						cause: "failed",
						detail: "the build broke",
					},
				}),
			});
			handOut(state, "github:github.com:I_5");
			ignore(state, "github:github.com:I_5");
			await coordinator.tick();
			// A held turn is the fact the Dispatch pause stalls every automatic start
			// on, and the held count reads the list: an ignored held Ticket stays in
			// that list, so the stall is never invisible (ADR 0060).
			expect(state.ticketWorkCycle.ignoredTickets().has("github:github.com:I_5")).toBe(true);
			expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
			expect(
				state.ticketWorkCycle
					.ticketListViews([], "implement")
					.rows.map((ticket) => ticket.identity),
			).toEqual(["github:github.com:I_5"]);
			// The held turn is the obligation the ignore's write refuses
			// (issue #202 review).
			expect(state.ticketWorkCycle.setTicketIgnored("github:github.com:I_5", true, null)).toEqual({
				ok: false,
				reason: "the selected Ticket cannot be ignored: its held turn awaits a decision",
			});
			state.close();
		});

		/**
		 * ADR 0060: the ignore moves the row; it changes no fact. A completed
		 * settle on an ignored Ticket still fires its Transition, and the machine
		 * reads the same trace the operator's own row would have carried.
		 */
		test("an ignored Ticket still fires its Transition at a completed settle", async () => {
			const fires: string[] = [];
			const written = outcome({ ticketWrite: { added: ["ready-for-review"], removed: [] } });
			const { state, coordinator, advance } = rig({
				autoOn: false,
				agents: [agent("pane-implement", { status: "done", sessionId: "/tmp/session.jsonl" })],
				turnLogs: async () => ({
					kind: "ended",
					turnEnd: {
						log: [{ kind: "text", text: "Done. The pull request is open." }],
						cause: "completed",
						detail: "",
					},
				}),
				fireCompleted: async (ticket) => {
					fires.push(ticket.ticketIdentity);
					return written;
				},
			});
			handOut(state, "github:github.com:I_5");
			ignore(state, "github:github.com:I_5");
			advance(STARTUP_GRACE_MS + 1);
			await coordinator.tick();
			// The fire ran on the ignored Ticket's own completed turn, and its
			// outcome stands on the trace.
			expect(fires).toEqual(["github:github.com:I_5"]);
			expect(state.ticketWorkCycle.lastCompletion("github:github.com:I_5")?.transition).toEqual(
				written,
			);
			// The settle left the Ticket awaiting a decision, so its row stands in the
			// list while the flag stays set underneath it (ADR 0060).
			expect(state.ticketWorkCycle.ignoredTickets().has("github:github.com:I_5")).toBe(true);
			expect(
				state.ticketWorkCycle
					.ticketListViews([], "implement")
					.rows.map((ticket) => ticket.identity),
			).toEqual(["github:github.com:I_5"]);
			state.close();
		});

		test("an ignored resting Ticket leaves the list, and a live one keeps it", async () => {
			const { state, coordinator } = rig({
				autoOn: false,
				agents: [agent("pane-implement", { status: "working" })],
			});
			handOut(state, "github:github.com:I_5");
			ignore(state, "github:github.com:I_5");
			await coordinator.tick();
			// Live work owes no decision yet, and the flag stands on it: the row stays
			// listed because there is live work to reach, and the seat stays counted,
			// so the Parallel limit keeps telling the truth.
			expect(state.ticketWorkCycle.ignoredTickets().has("github:github.com:I_5")).toBe(true);
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("running");
			expect(
				state.ticketWorkCycle
					.ticketListViews([], "implement")
					.rows.map((ticket) => ticket.identity),
			).toEqual(["github:github.com:I_5"]);
			expect(
				state.ticketWorkCycle
					.ticketListViews([], "implement", "ignored")
					.rows.map((t) => t.identity),
			).toEqual(["github:github.com:I_5"]);
			// End the cycle with the Close the row reaches: the Ticket rests `open`,
			// and the same flag takes the row out of the active view at once.
			state.ticketWorkCycle.closeWorkCycle("github:github.com:I_5");
			expect(state.ticketWorkCycle.ticketListViews([], "implement").rows).toEqual([]);
			expect(
				state.ticketWorkCycle
					.ticketListViews([], "implement", "ignored")
					.rows.map((t) => t.identity),
			).toEqual(["github:github.com:I_5"]);
			state.close();
		});
	});

	/**
	 * ADR 0052: the queue pause holds the top-up's adds at the observation seam
	 * too. Auto mode is on, the queue is empty, and an eligible ticket stands
	 * ready - the pause alone is what keeps the cycle from adding. The resume
	 * frees the adds again.
	 */
	test("the queue pause holds the top-up's add, and the resume adds", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.workQueue.setQueuePaused(true);
		await coordinator.tick();
		// The pause held the add: no ask, no row, and the queue stayed empty.
		expect(intents).toEqual([]);
		expect(state.workQueue.items()).toEqual([]);
		state.workQueue.setQueuePaused(false);
		await coordinator.tick();
		// Resumed, the same eligible ticket takes the one automatic add.
		expect(intents).toEqual([expect.objectContaining({ origin: "open", automatic: true })]);
		expect(state.workQueue.items()).toHaveLength(1);
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
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const claim = state.handoff.claimHandoff(
			"github:github.com:I_5",
			// The previous handoff ran on a model and a thinking that differ
			// from the target's own default, so the fresh choice cannot be the
			// inherited one.
			{ ...choice, taskType: "route", model: "opus-4", thinking: "low" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
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
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: settleForAttempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
		// The re-read that the close triggers clears the gate for the claim.
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:01:00Z",
			tickets: [fetched()],
		});
		const claim = state.handoff.claimHandoff(identity, { ...choice, taskType: "route" }, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "route",
			agentType: "pi",
			message: "again settled",
			turnLog: [{ kind: "text", text: "again settled" }],
			completedAt: "2026-08-31T11:00:00Z",
			transition: routeOutcome(),
		});
		expect(ruleFor(state, coordinator)).toBe("close");
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
				agent("pane-github:github.com:I_6", { status: "working" }),
				agent("pane-github:github.com:I_7", { status: "working" }),
			],
		});
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		// The wait lives at the queue, not in the seat (ADR 0051): the route
		// enters the queue, and the item rests until a seat frees. The ask
		// records the factory's decision on the settled turn and ends its
		// cycle in the same write, so the ticket rests open behind the item
		// (ADR 0064, ADR 0072).
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: "github:github.com:I_6",
			}),
		]);
		expect(state.workQueue.items()).toHaveLength(1);
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-handed-off" }),
			}),
		);
		state.close();
	});

	test("one add per cycle: the queue's depth is the top-up's pace", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(
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

	test("auto mode closes a fired transition that derives no Next step", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "implement", outcome());
		expect(ruleFor(state, coordinator)).toBe("close");
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a route whose start never lands keeps the decision the ask made, and the top-up asks again (ADR 0064)", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		// The start never went live: the pickup drops the item with its
		// warning (ADR 0049) and the queue drains. The drop keeps the
		// decision the ask recorded, and the position still offers the task,
		// so the top-up's next empty-queue cycle asks again: the failed start
		// consumed nothing, and the second ask re-lands the decision as a
		// no-op beside the first.
		state.workQueue.removeWorkItem("github:github.com:I_6");
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(2);
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-handed-off" }),
			}),
		);
		state.close();
	});

	test("auto mode closes a completion whose transition never fired", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "research");
		expect(ruleFor(state, coordinator)).toBe("close");
		await coordinator.tick();
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		state.sourceFact.applyFetch(source, {
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
	const [ticket] = state.ticketWorkCycle.ticketListViews(
		[
			{
				name: "waiting-for-a-human",
				match: { sourceKind: "github-issue", labelsNone: ["ready-for-review"] },
			},
		],
		"implement",
	).rows;
	expect(ticket.suggestedTaskType).toBeNull();
	state.close();
});

describe("the open dispatch", () => {
	test("the top-up adds one open ticket per cycle, in the list order", async () => {
		// One free seat, so the ask's own pickup pass starts the item the
		// walk adds, the way the module's pickup does.
		const seats = { current: 1 };
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			seatCount: () => seats.current,
		});
		state.sourceFact.applyFetch(
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
		// The ask's pickup pass starts the item on the free seat: the row
		// leaves, and the ticket's state leaves the open walk's candidates.
		await settleDispatch(state);
		// The next empty-queue cycle adds the next ticket.
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

	/**
	 * Story 47 (ADR 0051): the top-up's own Message lines. The operator
	 * reads what the factory added and what the channel refused, in the
	 * words the plane writes: the add names the ticket and the walk, and
	 * the refusal names the walk and the dispatch's reason. Every line names
	 * the ticket by the title the row shows, the way every other queue line
	 * does - not by its raw identity.
	 */
	test("the top-up's open add line names the ticket on the Message", async () => {
		const { state, coordinator, statuses } = rig({ autoOn: true, agents: [] });
		await coordinator.tick();
		expect(statuses).toContainEqual({
			kind: "info",
			text: 'work queue top-up: handing off "Persist source facts"',
		});
		state.close();
	});

	test("the top-up's continuation add line names the route and the task", async () => {
		const { state, coordinator, statuses } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		expect(ruleFor(state, coordinator)).toBe("route");
		await coordinator.tick();
		expect(statuses).toContainEqual({
			kind: "info",
			text: 'work queue top-up: routing "Persist source facts" to implement',
		});
		state.close();
	});

	test("the top-up's restart add line names the ticket", async () => {
		const { state, coordinator, statuses, advance } = rig({ autoOn: true, agents: [] });
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(statuses).toContainEqual({
			kind: "info",
			text: 'work queue top-up: restarting "Persist source facts"',
		});
		state.close();
	});

	/**
	 * The restart walk's queue fact (issue #202 review). The walk takes the queue's
	 * own items - the one read the cycle gate already pays for its depth - and hands
	 * the standing item to the rule. The gate holds the walk out whenever the queue
	 * holds any item, so no cycle reaches the fact as true through the walk: this
	 * test holds the wiring and the fact's effect on the walk, and
	 * `test/top-up.test.ts` holds the fact on the rule itself.
	 */
	test("the restart walk holds no item the queue already holds", async () => {
		const { state, intents, coordinator, advance } = rig({ autoOn: true, agents: [] });
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS + 1);
		// An item already stands for the in-flight candidate the walk would restart.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_5",
				origin: "open",
				choice: { ...choice, taskType: "implement" },
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		await coordinator.tick();
		expect(intents).toEqual([]);
		expect(state.workQueue.items()).toHaveLength(1);
		// The item drains, and the next empty-queue cycle runs the restart: the walk
		// carries no stale fact of its own across cycles.
		state.workQueue.removeWorkItem("github:github.com:I_5");
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({
				origin: "restart",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
			}),
		);
		state.close();
	});

	test("the top-up's refusal line names the walk and the dispatch's reason", async () => {
		// The open walk's row gate holds a Ticket that carries an unsettled claim
		// before it ever reaches the ask, so the refusal the walk states is the
		// one the restart walk can send: the in-flight Ticket the claim stands on.
		const { state, coordinator, statuses, advance } = rig({
			autoOn: true,
			agents: [],
			config: { maxHandoffsPerTicket: 20 },
		});
		state.sourceFact.applyFetch(source, success([fetched()]));
		// A start that reached its Agent: the Ticket is in flight, and the Agent
		// is gone, so the restart walk owes it the re-ask.
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS + 1);
		// A second claim the module never settled: the recovery the claim's gate
		// refuses on, so the ask the walk sends is the refusal.
		const claim = state.handoff.claimHandoff("github:github.com:I_5", choice, "restart");
		if (!claim.ok) throw new Error(claim.reason);
		await coordinator.tick();
		expect(statuses).toContainEqual({
			kind: "warning",
			text:
				'work queue top-up could not restart "Persist source facts": handoff recovery is required before another handoff',
		});
		state.close();
	});

	// A stopped dispatch is the teardown's fact, not a handoff refusal: the
	// ask answers the stop, and the cycle ends its walk without a line. A
	// warning per cycle would pin the Message line while the run ends.
	test("the top-up's stopped dispatch is a stop, not a refusal", async () => {
		const { state, dispatch, coordinator, statuses, settle } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched()]));
		// The teardown's stop, on the module the cycle crosses.
		dispatch.stop();
		await coordinator.tick();
		expect(statuses).not.toContainEqual(expect.objectContaining({ kind: "warning" }));
		expect(statuses).not.toContainEqual(
			expect.objectContaining({ text: 'work queue top-up: handing off "Persist source facts"' }),
		);
		state.close();
	});

	/**
	 * Story 24 (ADR 0051): an item the pickup dropped is reconsidered every
	 * cycle the queue is empty - the restart included. The top-up marks the
	 * ticket restarted for the episode when it asks, and every exit that ends
	 * the item without a start clears the mark through the ask's own start
	 * report: a dispatch refusal never took a row, and a pickup drop, an
	 * operator remove, or a race cancel leaves a row that already went. A
	 * restart that actually started keeps its mark until the episode ends.
	 */
	test("a refused top-up restart is asked again, a started one is not", async () => {
		const refused = rig({
			autoOn: true,
			agents: [],
			// The planted claim counts on the Ticket, so the claim's gate - not
			// the Handoff limit - is the refusal the walk hears.
			config: { maxHandoffsPerTicket: 20 },
		});
		handOut(refused.state, "github:github.com:I_5");
		// A claim the module never settled: the recovery gate refuses the
		// restart ask, and the refusal clears the episode mark with it.
		const planted = refused.state.handoff.claimHandoff("github:github.com:I_5", choice, "restart");
		if (!planted.ok) throw new Error(planted.reason);
		refused.advance(STARTUP_GRACE_MS + 1);
		await refused.coordinator.tick();
		await refused.coordinator.tick();
		// The refusal cleared the mark: the second cycle asked again.
		expect(refused.intents.filter((intent) => intent.origin === "restart")).toHaveLength(2);
		refused.state.close();

		const seats = { current: 1 };
		const accepted = rig({ autoOn: true, agents: [], seatCount: () => seats.current });
		// The restart reopens the ticket's own branch: herdr answers the open
		// with the stored workspace held, and a fresh tab in it.
		const worktreePath = join(accepted.checkout, "wt");
		accepted.runner.set(
			"herdr",
			["worktree", "open", "--cwd", accepted.checkout, "--branch", "factory/5-persist-source-facts", "--no-focus"],
			{ stdout: worktreeOpenJson("ws-1", "pane-wt", { alreadyOpen: true, worktreePath }) },
		);
		accepted.runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-1", "--cwd", worktreePath, "--no-focus"],
			{ stdout: tabCreateJson("pane-agent", "tab-agent") },
		);
		handOut(accepted.state, "github:github.com:I_5");
		accepted.advance(STARTUP_GRACE_MS + 1);
		await accepted.coordinator.tick();
		expect(accepted.intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
		// The free seat ran the start on behind the ask: the row leaves the
		// queue, and the episode mark stands for the started restart.
		await accepted.settle();
		await accepted.coordinator.tick();
		expect(accepted.intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
		accepted.state.close();
	});

	test("a top-up restart the pickup dropped holds no automatic re-ask (issue #370)", async () => {
		// A free seat runs the restart's start on behind the ask, and herdr
		// refuses the worktree open: the pickup's drop, ADR 0049. The old rig's
		// seam drop recorded no failed attempt, so its newest handoff kept a
		// pane and the walk re-asked; the real module's drop settles the
		// attempt pane-less, and the restart walk's pane gate holds the
		// ticket out (issue #370).
		const seats = { current: 1 };
		const { state, intents, statuses, coordinator, advance, runner, checkout } = rig({
			autoOn: true,
			agents: [],
			config: { maxHandoffsPerTicket: 20 },
			seatCount: () => seats.current,
		});
		runner.set(
			"herdr",
			["worktree", "open", "--cwd", checkout, "--branch", "factory/5-persist-source-facts", "--no-focus"],
			{ code: 1, stderr: "Preparing worktree: the worktree path already exists" },
		);
		handOut(state, "github:github.com:I_5");
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
		// The drop: the row leaves with the warning that names the refusal, and
		// the ticket keeps the state it wore while it waited.
		expect(state.workQueue.hasWorkItem("github:github.com:I_5")).toBe(false);
		expect(statuses).toContainEqual(
			expect.objectContaining({
				kind: "warning",
				text:
					'queued handoff for "Persist source facts" was not run: Preparing worktree: the worktree path already exists',
			}),
		);
		// The failed start settles a handoff that holds no pane, so the restart
		// walk's pane gate holds the ticket out: no automatic re-ask, and the
		// hold states nothing. The operator's Restart in the Missing modal is
		// the path that answers it.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
		state.close();
	});

	test("a started handoff leaves the open walk's candidates", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		await coordinator.tick();
		// The one open ticket added; the queue holds the rest until it drains.
		expect(intents).toHaveLength(1);
		// The item waits for a seat the pickup does not free, so the queue's
		// row holds the next add and the open walk adds no second ticket.
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
			const claim = state.handoff.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: `pane-${round}`,
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			// Settle the turn so the ticket returns to open, at its limit.
			state.ticketWorkCycle.settleTurn({
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
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				decision: "closed",
				decidedAt: "2026-08-31T11:01:00Z",
			});
			// The re-read that the close triggers keeps the ticket listed, and
			// clears the gate for the round that follows.
			state.sourceFact.applyFetch(source, {
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
		const claim = state.handoff.claimHandoff(identity, choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: `pane-${identity}`,
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "research",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.ticketWorkCycle.applyCompletionDecision({
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
		state.sourceFact.applyFetch(source, {
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
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:02:00Z",
			tickets: [],
		});
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.ticketWorkCycle.ticketListViews(config.workflowStates, "implement").rows).toEqual(
			[],
		);
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
		const first = state.handoff.claimHandoff(identity, choice, "open");
		if (!first.ok) throw new Error(first.reason);
		state.handoff.settleHandoff(first.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			taskType: "research",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T11:00:00Z",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: first.claim.attemptId,
			decision: "closed",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:02:00Z",
			tickets: [fetched()],
		});
		// The second cycle uses up the ticket's handoffs, so the missing agent
		// abandons it, the cycle the loop ends.
		const second = state.handoff.claimHandoff(identity, choice, "open");
		if (!second.ok) throw new Error(second.reason);
		state.handoff.settleHandoff(second.claim.attemptId, true, undefined, {
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
			agents: [agent("pane-github:github.com:I_6", { status: "working" })],
		});
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const claim = state.handoff.claimHandoff("github:github.com:I_6", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
		expect(state.workQueue.items()).toHaveLength(1);
		state.close();
	});

	test("the cycle runs the pickup before the top-up, and the top-up skips a queue that holds an item", async () => {
		const order: string[] = [];
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			order,
		});
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		// The operator's start waits in the queue for a seat the pickup's pass
		// does not free.
		expect(
			state.workQueue.enqueueWork({
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
		const seats = { current: 1 };
		const { state, intents, coordinator, settle } = rig({
			autoOn: true,
			agents: [],
			seatCount: () => seats.current,
			order,
		});
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		// The operator's start waits in the queue, and the pickup's pass takes
		// the one free seat it holds: the live-worktree build runs on the
		// fixture's herdr, and the row leaves with the start.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_6",
				origin: "open",
				choice: { ...choice, environment: "live-worktree" },
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		await coordinator.tick();
		// The pickup claimed the operator's item and its start runs on behind
		// the walk: the row stands until the start answers, so this cycle's
		// top-up holds on the waiting row the pickup holds.
		expect(order).toEqual(["pickup"]);
		expect(intents).toEqual([]);
		// The start answers, the row leaves with it, and the queue that is
		// empty again leaves the next cycle's top-up free to add: the
		// operator's staging starts before the factory's.
		await settle();
		await coordinator.tick();
		expect(order).toEqual(["pickup", "pickup", "dispatch:open"]);
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				ticketIdentity: "github:github.com:I_5",
			}),
		]);
		state.close();
	});

	test("the owed continuation is asked before the pickup, ahead of the standing fresh-work item", async () => {
		const order: string[] = [];
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			order,
		});
		state.sourceFact.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		// The factory's fresh work already stands in the queue: an open ticket's
		// item added in an earlier cycle, waiting for a seat.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_7",
				origin: "open",
				choice,
				previousMessage: "",
				automatic: true,
			}),
		).toEqual({ ok: true });
		// A settled turn owes itself a route (ADR 0092).
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		// The ask the settled turn owes runs before the pickup's pass (ADR 0094),
		// and its row stands ahead of the fresh-work row, so the free seat goes to
		// the settled turn's own next step.
		expect(order).toEqual(["dispatch:workflow", "pickup"]);
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: "github:github.com:I_5",
			}),
		]);
		expect(
			state.workQueue.items().map((item) => {
				if (item.kind !== "handoff") throw new Error("the queue holds no handoff item");
				return item.ticketIdentity;
			}),
		).toEqual(["github:github.com:I_6", "github:github.com:I_7"]);
		state.close();
	});

	test("an item the operator staged does not hold the owed continuation", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		// The operator's own start waits in the queue for a seat.
		expect(
			state.workQueue.enqueueWork({
				ticketIdentity: "github:github.com:I_7",
				origin: "open",
				choice,
				previousMessage: "",
			}),
		).toEqual({ ok: true });
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		await coordinator.tick();
		// The owed continuation outranks the operator's staging (ADR 0100): the
		// settled turn's own next step is asked, and its row stands ahead of the
		// row the operator staged.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: "github:github.com:I_6",
				routeFromIdentity: "github:github.com:I_5",
			}),
		]);
		expect(
			state.workQueue.items().map((item) => {
				if (item.kind !== "handoff") throw new Error("the queue holds no handoff item");
				return item.ticketIdentity;
			}),
		).toEqual(["github:github.com:I_6", "github:github.com:I_7"]);
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
			order,
		});
		// Two open tickets, and a settled awaiting ticket whose type would route
		// in auto mode: with Auto-handoff off only the queue's pickup may start.
		state.sourceFact.applyFetch(
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
		settleForCause(state, "github:github.com:I_5", {
			taskType: "route",
			cause: "failed",
			detail: "the build broke",
		});
		await coordinator.tick();
		// The held gate stops the automatic route: nothing is dispatched.
		expect(intents).toHaveLength(0);
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: "failed" });
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
			settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: cause });
			await coordinator.tick();
			expect(intents).toHaveLength(0);
			const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
			expect(ticket.state).toBe("awaiting");
			expect(ticket.lastCompletion?.decision).toBe(null);
			state.close();
		}
	});

	test("manual mode holds an auto-close type's held turn: no close, no route", async () => {
		for (const taskType of ["review", "route"]) {
			const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
			settleForCause(state, "github:github.com:I_5", {
				taskType: taskType,
				cause: "failed",
				detail: "the build broke",
			});
			await coordinator.tick();
			// The gate holds the auto-close type's automatic decision without the
			// operator too: no close, no route, and the turn rests held with its
			// trace undecided.
			expect(intents).toHaveLength(0);
			const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
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
		settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: "unknown" });
		await coordinator.tick();
		// unknown is not held: the review auto-closes as it normally would, then
		// the loop re-dispatches the now-open ticket. It never rests as held.
		const [ticket] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(ticket.lastCompletion?.decision).toBe("auto-closed");
		state.close();
	});

	test("auto mode still closes a completed route's turn and routes it", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const attempt = settleForCause(state, "github:github.com:I_5", {
			taskType: "route",
			cause: "completed",
			detail: "",
			transition: routeOutcome("github:github.com:I_6"),
		});
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({ origin: "workflow", ticketIdentity: "github:github.com:I_6" }),
		);
		// The pickup's start lands the decision, named as the auto mode names it.
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "auto-handed-off",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		const [decided] = state.ticketWorkCycle.ticketListViews([], "implement").rows;
		expect(decided.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});

	test("a decided held turn is no longer held and no longer pauses", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const attempt = settleForCause(state, "github:github.com:I_5", {
			taskType: "route",
			cause: "failed",
		});
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		// The operator decides the held turn: it is no longer held, and the
		// pause ends.
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_5",
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:01:00Z",
		});
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		// The gate holds the dispatch until the source re-reads the ticket,
		// so the re-read lands before the dispatch question.
		state.sourceFact.applyFetch(source, {
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
		settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: "failed" });
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6")]));
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("open");
		state.close();
	});

	test("manual mode never dispatches an open ticket, pause or no", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: "failed" });
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6")]));
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		// Manual mode does not auto-dispatch open tickets at all, pause or no:
		// the ticket stays open for the operator. The pause's one effect in
		// manual mode is the auto-close route, covered by its own test.
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("open");
		state.close();
	});

	test("the pause holds an auto-close type's route in manual mode, like the Parallel limit", async () => {
		const { state, intents, statuses, coordinator } = rig({ autoOn: false, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		// I_6's completed route predates I_5's held failure, so the pause is on
		// while the completed turn waits for its route. Manual mode never
		// dispatches the open tickets, but the auto-close route still runs
		// there - and the pause holds it, exactly as a full Parallel limit
		// would.
		settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: "failed" });
		const claim = state.handoff.claimHandoff(
			"github:github.com:I_6",
			{ ...choice, taskType: "route" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: "github:github.com:I_6",
			handoffId: claim.claim.attemptId,
			taskType: "route",
			agentType: "pi",
			message: "settled the turn",
			turnLog: [{ kind: "text", text: "settled the turn" }],
			completedAt: "2026-08-31T10:00:00Z",
			cause: "completed",
		});
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		const resting = state.ticketWorkCycle
			.ticketListViews([], "implement")
			.rows.find((ticket) => ticket.identity === "github:github.com:I_6");
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
		state.sourceFact.applyFetch(
			source,
			success([fetched(), fetched("github:github.com:I_6"), fetched("github:github.com:I_7")]),
		);
		// I_5's held failure trips the pause after I_6's completed turn waited
		// for its route: the pause holds the top-up, the trace stays
		// undecided, and the turn rests in awaiting.
		const heldAttempt = settleForCause(state, "github:github.com:I_5", {
			taskType: "review",
			cause: "failed",
		});
		const claim = state.handoff.claimHandoff(
			"github:github.com:I_6",
			{ ...choice, taskType: "route" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		const routeAttempt = claim.claim.attemptId;
		state.handoff.settleHandoff(routeAttempt, true, undefined, {
			paneId: "pane-route",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
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
		const resting = state.ticketWorkCycle
			.ticketListViews([], "implement")
			.rows.find((ticket) => ticket.identity === "github:github.com:I_6");
		expect(resting).toEqual(
			expect.objectContaining({
				state: "awaiting",
				lastCompletion: expect.objectContaining({ cause: "completed", decision: null }),
			}),
		);
		// The operator decides the held turn that started the pause: the route
		// is not lost, and the next cycle's top-up takes it to the position.
		state.ticketWorkCycle.applyCompletionDecision({
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
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_6",
			handoffId: routeAttempt,
			decision: "auto-handed-off",
			decidedAt: "2026-08-31T11:02:00Z",
		});
		const routed = state.ticketWorkCycle
			.ticketListViews([], "implement")
			.rows.find((ticket) => ticket.identity === "github:github.com:I_6");
		expect(routed?.lastCompletion?.decision).toBe("auto-handed-off");
		state.close();
	});

	test("auto mode's Dispatch pause holds a missing agent's restart", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		// A held failed trace sits on one ticket; a different ticket's agent has
		// gone missing. The pause holds the restart, not just the open dispatch.
		settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: "failed" });
		handOut(state, "github:github.com:I_6");
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("handed-off");
		state.close();
	});

	test("a failed turn whose Agent works again frees the top-up's add", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		// The failed settle arms the pause, and the fresh open ticket is held out.
		const attempt = settleForCause(state, "github:github.com:I_5", {
			taskType: "review",
			cause: "failed",
		});
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		// The Agent reports working again: the turn reopens (ADR 0016), the row
		// leaves `awaiting` for `running`, and the `held` badge and the decision
		// surface leave with the state. No Held turn stands, and the pause's only
		// other release - a `completed` settle - is the very start the pause holds.
		// The factory keeps working while that Agent works.
		expect(state.ticketWorkCycle.reopenTurn("github:github.com:I_5", attempt)).toBe(true);
		await coordinator.tick();
		expect(
			intents.some(
				(intent) => intent.origin === "open" && intent.ticketIdentity === "github:github.com:I_6",
			),
		).toBe(true);
		state.close();
	});

	test("a completed turn after the held failure ends the pause and frees dispatch", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.sourceFact.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		settleForCause(state, "github:github.com:I_5", { taskType: "review", cause: "failed" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		// A completed settle after the held failure clears the pause.
		settleForCause(state, "github:github.com:I_6", { taskType: "review", cause: "completed" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		await coordinator.tick();
		// The held failure stays held; the completed one auto-closes. The gate
		// holds its re-dispatch until the source re-reads the ticket.
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("awaiting");
		expect(intents).toHaveLength(0);
		state.sourceFact.applyFetch(source, {
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
			agents: [agent("pane-implement", { status: "done", sessionId: "session-1" })],
			turnLogs: async () => ({
				kind: "ended",
				turnEnd: {
					log: [{ kind: "text", text: "the turn failed" }],
					cause: "failed",
					detail: "the build broke",
				},
			}),
		});
		state.sourceFact.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
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
		settleForCause(state, "github:github.com:I_6", { taskType: "review", cause: "completed" });
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
			agents: [agent("pane-implement", { status: "working" })],
			startupGraceMs: 0,
		});
		state.sourceFact.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		// I_5's failed turn left no agent text: the provider's own words sit in
		// the detail. A later completed settle on another ticket lifts the
		// pause, so the restart is not the pause's to hold.
		const attempt = handOut(state, "github:github.com:I_5");
		state.ticketWorkCycle.settleTurn({
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
		settleForCause(state, "github:github.com:I_6", { taskType: "review", cause: "completed" });
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(false);
		await coordinator.tick();
		// I_5's agent still works: the held ticket reopens, and its next settle
		// would overwrite the trace. Its trace still carries the cause.
		expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("running");
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

		now(): number {
			return Date.parse("2026-08-31T11:00:00Z");
		}

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
		state.sourceFact.initializeSources([source]);
		state.sourceFact.applyFetch(source, success([fetched()]));
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
			dispatch: {
				dispatch: async () => ({ ok: true }),
				dispatchPlaneAction: async () => ({ ok: true }),
				planeActionRunInFlight: () => false,
				pickupWorkQueue: async () => 0,
				closeCleanup: async () => undefined,
			},
			clock,
			pollIntervalMs: 5_000,
			onCycleEnd: () => undefined,
			log: NOOP_LOGGER,
			turnLogs: { read: async () => ({ kind: "unavailable" }) },
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
		state.consultationRecord.createConsultation({
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
		state.consultationRecord.recordConsultationAgentHandles(id, {
			paneId,
			tabId: "tab-1",
			workspaceId: "ws-1",
			sessionId: `session-${id}`,
		});
		if (stateName !== "opening") state.consultationRecord.setConsultationState(id, stateName);
	}

	test("a working Consultation holds a seat the top-up does not wait on", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [agent("pane-consult", { status: "working" })],
		});
		try {
			consultationIn(state, "consultation-working", "pane-consult", "working");
			state.sourceFact.applyFetch(
				source,
				success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
			);
			await coordinator.tick();
			// The wait lives at the gate, not in the seat (ADR 0051): the
			// working Consultation's seat holds the pickup, not the top-up, so
			// the open add lands in the queue anyway.
			expect(intents).toHaveLength(1);
			expect(intents[0]).toEqual(expect.objectContaining({ origin: "open" }));
			expect(state.workQueue.items()).toHaveLength(1);
		} finally {
			state.close();
		}
	});

	test("a working Consultation holds a seat the restart does not wait on", async () => {
		const { state, intents, coordinator, advance } = rig({
			autoOn: true,
			agents: [agent("pane-consult", { status: "working" })],
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
			expect(state.ticketWorkCycle.ticketState("github:github.com:I_5")).toBe("handed-off");
		} finally {
			state.close();
		}
	});

	test("a Consultation in any state holds no gate over the top-up", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [agent("pane-consult", { status: "working" })],
		});
		try {
			consultationIn(state, "consultation-awaiting", "pane-consult", "awaiting-response");
			state.sourceFact.applyFetch(
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
		state.consultationRecord.createConsultation({
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
		state.consultationRecord.recordConsultationAgentHandles(id, {
			paneId,
			tabId: "tab-1",
			workspaceId: "ws-1",
			sessionId,
		});
	}

	test("keeps a restart-interrupted opening until explicit recovery", async () => {
		const { state, coordinator } = rig({
			agents: [agent("pane-1", { status: "idle", sessionId: "", stableSessionId: "session-1" })],
		});
		try {
			openingConsultation(state, "consultation-opening");
			await coordinator.tick();
			expect(state.consultationRecord.consultation("consultation-opening")).toMatchObject({
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
			agents: [
				agent("pane-1", { status: "idle", sessionId: "", stableSessionId: "replacement-session" }),
			],
		});
		try {
			openingConsultation(state, "opening-ambiguous");
			await coordinator.tick();
			expect(state.consultationRecord.consultation("opening-ambiguous")).toMatchObject({
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
			expect(state.consultationRecord.consultation("opening-not-visible")).toMatchObject({
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
				rigged.state.consultationRecord.setConsultationAgent(`missing-${stateName}`, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					sessionId: "session-1",
				});
				if (stateName === "awaiting-response")
					rigged.state.consultationRecord.settleConsultationTurn(
						`missing-${stateName}`,
						null,
						"output",
						{ settledStatus: "idle" },
					);
				await rigged.coordinator.tick();
				expect(rigged.state.consultationRecord.consultation(`missing-${stateName}`)).toMatchObject({
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
			const rigged = rig({
				agents: [
					agent("pane-1", { status: "idle", sessionId: "", stableSessionId: "other-session" }),
				],
			});
			try {
				openingConsultation(rigged.state, `ambiguous-${stateName}`);
				rigged.state.consultationRecord.setConsultationAgent(`ambiguous-${stateName}`, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					sessionId: "session-1",
				});
				if (stateName === "awaiting-response")
					rigged.state.consultationRecord.settleConsultationTurn(
						`ambiguous-${stateName}`,
						null,
						"output",
						{ settledStatus: "idle" },
					);
				await rigged.coordinator.tick();
				expect(
					rigged.state.consultationRecord.consultation(`ambiguous-${stateName}`),
				).toMatchObject({
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
			...agent("pane-new", { status: "idle", sessionId: "", stableSessionId: "session-1" }),
			tabId: "tab-new",
			workspaceId: "ws-new",
		};
		const { state, coordinator } = rig({ agents: [verified] });
		try {
			openingConsultation(state, "opening-verified", "pane-old", "session-1");
			await coordinator.tick();
			expect(state.consultationRecord.consultation("opening-verified")).toMatchObject({
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
			agents: [
				agent("pane-1", { status: "not reported", sessionId: "", stableSessionId: "session-1" }),
			],
		});
		try {
			openingConsultation(state, "opening-unknown");
			await coordinator.tick();
			expect(state.consultationRecord.consultation("opening-unknown")).toMatchObject({
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
		const { state, coordinator } = rig({ agents: [agent("pane-1", { status: "idle" })] });
		try {
			openingConsultation(state, "opening-without-stable-id");
			await coordinator.tick();
			expect(state.consultationRecord.consultation("opening-without-stable-id")).toMatchObject({
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
			expect(state.consultationRecord.consultation("opening-warned")?.warning).toBe(
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
				...agent("pane-1", { status: "working", sessionId: "", stableSessionId: "session-1" }),
				[moved]: value,
			};
			const { state, coordinator } = rig({ agents: [reported] });
			try {
				openingConsultation(state, id);
				state.consultationRecord.setConsultationAgent(id, {
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					sessionId: "session-1",
				});
				await coordinator.tick();
				expect(state.consultationRecord.consultation(id), `the moved ${moved}`).toMatchObject({
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
			agents: [
				agent("pane-1", { status: "meditating", sessionId: "", stableSessionId: "session-1" }),
			],
		});
		try {
			openingConsultation(state, "live-unknown");
			state.consultationRecord.setConsultationAgent("live-unknown", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "session-1",
			});
			await coordinator.tick();
			expect(state.consultationRecord.consultation("live-unknown")).toMatchObject({
				state: "working",
				warning: "Agent status is unknown",
			});
			expect(statuses).toContainEqual({
				kind: "warning",
				text: "Agent status is unknown for Consultation live-unk",
			});
			// A known status clears it: the warning is the poll's current read,
			// not a mark the Consultation carries for good.
			setAgents([
				agent("pane-1", { status: "working", sessionId: "", stableSessionId: "session-1" }),
			]);
			await coordinator.tick();
			expect(state.consultationRecord.consultation("live-unknown")?.warning).toBeNull();
		} finally {
			state.close();
		}
	});

	test("records an external turn only when herdr reports a newer sequence", async () => {
		const open = (sequence: number | undefined) => {
			const rigged = rig({
				agents: [
					{
						...agent("pane-1", { status: "idle", sessionId: "", stableSessionId: "session-1" }),
						sequence,
					},
				],
			});
			openingConsultation(rigged.state, "live-sequence");
			rigged.state.consultationRecord.setConsultationAgent("live-sequence", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "session-1",
			});
			rigged.state.consultationRecord.settleConsultationTurn(
				"live-sequence",
				5,
				"the settled turn",
				{ settledStatus: "idle" },
			);
			return rigged;
		};
		// The same sequence is the turn the control plane already holds: a new
		// turn would double-count the Agent's own step.
		const same = open(5);
		try {
			await same.coordinator.tick();
			expect(same.state.consultationRecord.consultationTurns("live-sequence")).toHaveLength(1);
			expect(same.state.consultationRecord.consultation("live-sequence")?.latestSequence).toBe(5);
		} finally {
			same.state.close();
		}
		// A newer sequence is input the operator never sent: it opens a turn of
		// its own, with the placeholder input the modal shows.
		const newer = open(6);
		try {
			await newer.coordinator.tick();
			const turns = newer.state.consultationRecord.consultationTurns("live-sequence");
			expect(turns).toHaveLength(2);
			const external = turns.find((turn) => turn.input === "[external Agent input not captured]");
			expect(external, "the turn herdr reported on its own").toBeDefined();
			expect(external?.sequenceBaseline).toBe(5);
			expect(newer.state.consultationRecord.consultation("live-sequence")?.latestSequence).toBe(6);
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
			expect(unknown.state.consultationRecord.consultationTurns("live-sequence")).toHaveLength(1);
		} finally {
			unknown.state.close();
		}
	});

	test("rejects a reused pane whose stable session differs", async () => {
		const { state, coordinator } = rig({
			agents: [
				agent("pane-1", {
					status: "working",
					sessionId: "",
					stableSessionId: "replacement-session",
				}),
			],
		});
		try {
			openingConsultation(state, "consultation-mismatch");
			state.consultationRecord.setConsultationAgent("consultation-mismatch", {
				paneId: "pane-1",
				tabId: "tab-1",
				workspaceId: "ws-1",
				sessionId: "expected-session",
			});
			await coordinator.tick();
			expect(state.consultationRecord.consultation("consultation-mismatch")).toMatchObject({
				state: "missing",
				warning: "Agent session match is ambiguous",
			});
		} finally {
			state.close();
		}
	});

	test("follows a uniquely matched moved session and retargets cleanup resources", async () => {
		const moved = {
			...agent("pane-new", { status: "working", sessionId: "", stableSessionId: "session-1" }),
			tabId: "tab-new",
			workspaceId: "ws-new",
		};
		const { state, coordinator } = rig({ agents: [moved] });
		try {
			openingConsultation(state, "consultation-moved");
			state.consultationRecord.setConsultationAgent("consultation-moved", {
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
				state.consultationRecord.recordConsultationResource("consultation-moved", {
					kind,
					resourceId,
					owned: true,
					details: `owned ${kind} ${resourceId}`,
				});
			await coordinator.tick();
			expect(state.consultationRecord.consultation("consultation-moved")).toMatchObject({
				paneId: "pane-new",
				tabId: "tab-new",
				workspaceId: "ws-new",
			});
			expect(state.consultationRecord.consultationResources("consultation-moved")).toEqual(
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
	// The name the ticket's handoff expects: the stable name of its title with
	// its own identity tag (ADR 0098), so a leftover agent under it is the
	// ticket's own.
	const NAME = agentNameFor({ identity, title: "Persist source facts" });

	/** Hand a ticket out, settle its turn, and close its cycle. */
	function closedCycle(rig_: Pick<Rig, "state" | "advance" | "setAgents">): string {
		const attempt = handOut(rig_.state, identity, "research");
		// Age the cycle so its trace is older than anything the loop settles.
		rig_.advance(90_000);
		rig_.state.ticketWorkCycle.settleTurn({
			ticketIdentity: identity,
			handoffId: attempt,
			taskType: "research",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T11:01:30Z",
		});
		rig_.advance(30_000);
		rig_.state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:02:00Z",
		});
		return attempt;
	}

	function ticketOf(state: FactoryState, of = identity) {
		return state.ticketWorkCycle
			.ticketListViews([], "implement")
			.rows.find((ticket) => ticket.identity === of);
	}

	test("a working agent in a closed cycle's pane runs its ticket again", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, statuses, setAgents } = r;
		closedCycle(r);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		// The operator re-prompts the agent in its herdr pane.
		setAgents([
			agent(PANE, { status: "working", sessionId: "", stableSessionId: undefined, name: NAME }),
		]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([
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
		setAgents([
			agent(PANE, {
				status: "working",
				sessionId: "session-1",
				stableSessionId: undefined,
				name: NAME,
			}),
		]);
		await coordinator.tick();
		setAgents([
			agent(PANE, {
				status: "idle",
				sessionId: "session-1",
				stableSessionId: undefined,
				name: NAME,
			}),
		]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["awaiting"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity, workCycle: 2, taskType: "research" }),
		]);
		expect(state.ticketWorkCycle.lastCompletion(identity)).toEqual(
			expect.objectContaining({ decision: null, taskType: "research" }),
		);
		state.close();
	});

	test("an agent that only reports settled or unknown does not restart a closed cycle", async () => {
		for (const status of ["idle", "done", "meditating"]) {
			const rig_ = rig({ agents: [] });
			const { state, coordinator, setAgents } = rig_;
			closedCycle(rig_);
			setAgents([agent(PANE, { status: status })]);
			await coordinator.tick();
			expect(state.ticketWorkCycle.ticketsByState(["handed-off", "running", "awaiting"])).toEqual(
				[],
			);
			expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
			state.close();
		}
	});

	test("a blocked agent in a closed cycle's pane is reclaimed too", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		setAgents([
			agent(PANE, { status: "blocked", sessionId: "", stableSessionId: undefined, name: NAME }),
		]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity }),
		]);
		state.close();
	});

	test("a pane another ticket holds is never reclaimed", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		// A second ticket is in flight in the very same pane: it owns the agent.
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		const other = state.handoff.claimHandoff(
			"github:github.com:I_6",
			{ ...choice, taskType: "research" },
			"open",
		);
		if (!other.ok) throw new Error(other.reason);
		state.handoff.settleHandoff(other.claim.attemptId, true, undefined, {
			paneId: PANE,
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		setAgents([agent(PANE, { status: "working" })]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([
			expect.objectContaining({ ticketIdentity: "github:github.com:I_6" }),
		]);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		state.close();
	});

	test("a reclaimed agent holds a parallel slot against the auto-handoff dispatch", async () => {
		const r = rig({ autoOn: true, agents: [], config: { maxParallelAgents: 1 } });
		const { state, intents, coordinator, setAgents } = r;
		closedCycle(r);
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		setAgents([
			agent(PANE, { status: "working", sessionId: "", stableSessionId: undefined, name: NAME }),
		]);
		await coordinator.tick();
		// The reclaimed agent is live: its ticket runs. The slot it holds
		// waits at the pickup, not the top-up (ADR 0051), so the open
		// ticket's add lands in the queue anyway.
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([
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
		setAgents([
			agent(PANE, {
				status: "working",
				sessionId: "",
				stableSessionId: undefined,
				name: "consultation-01234567",
			}),
		]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["handed-off", "running", "awaiting"])).toEqual([]);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		state.close();
	});

	test("an agent herdr does not name in a closed cycle's pane is never reclaimed", async () => {
		const r = rig({ agents: [] });
		const { state, coordinator, setAgents } = r;
		closedCycle(r);
		// The reader cannot verify the agent's identity, so it adopts nothing:
		// a wrong adoption moves the ticket to running on a foreign pane.
		setAgents([agent(PANE, { status: "working" })]);
		await coordinator.tick();
		expect(state.ticketWorkCycle.ticketsByState(["handed-off", "running", "awaiting"])).toEqual([]);
		expect(ticketOf(state)).toEqual(expect.objectContaining({ state: "open", handoffCount: 1 }));
		state.close();
	});

	test("an unreachable herdr reclaims nothing", async () => {
		const r = rig({ agents: [] });
		const { state, setAgents, statuses } = r;
		closedCycle(r);
		setAgents([agent(PANE, { status: "working" })]);
		const holding = new ObservationCoordinator({
			state,
			herdr: {
				listAgents: async () => ({ kind: "error", reason: "herdr is down" }),
				readPane: async () => null,
			},
			config: () => config,
			dispatch: {
				dispatch: async () => ({ ok: true }),
				dispatchPlaneAction: async () => ({ ok: true }),
				planeActionRunInFlight: () => false,
				pickupWorkQueue: async () => 0,
				closeCleanup: async () => undefined,
			},
			clock: {
				now: () => Date.parse("2026-08-31T11:05:00Z"),
				setTimeout,
				clearTimeout,
			},
			onCycleEnd: () => undefined,
			log: NOOP_LOGGER,
			turnLogs: { read: async () => ({ kind: "unavailable" }) },
			onChanged: () => {},
			onStatus: (kind, text) => {
				statuses.push({ kind, text });
			},
		});
		await holding.tick();
		expect(state.ticketWorkCycle.ticketsByState(["running"])).toEqual([]);
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
		state.sourceFact.applyFetch(pullSource, {
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
		const attempt = settleForCause(state, issueIdentity, {
			taskType: "implement",
			cause: "completed",
			detail: "",
			transition: transition,
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: issueIdentity,
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
	}

	/**
	 * The skip's route asks among the cycle's intents. A guard test asks about
	 * the route alone: in auto mode the same cycle may legitimately hand the
	 * open pull request off as a new open ticket, and that add is not the
	 * route under test.
	 */
	function routeAsks(intents: readonly { origin: string }[]): number {
		return intents.filter((intent) => intent.origin === "workflow").length;
	}

	test("manual mode holds the re-fired skip's route for the operator", async () => {
		// This walk is the mode gate itself, not one of the route's guards: the
		// top-up does not run in manual mode at all (ADR 0051).
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		// In manual mode the top-up does not run (ADR 0051): the position
		// rests open and the operator hands it off.
		expect(intents).toEqual([]);
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		// The issue's closed cycle stands: the route records no decision on it.
		expect(state.ticketWorkCycle.lastCompletion(issueIdentity)?.decision).toBe("closed");
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
		expect(state.workQueue.items()).toHaveLength(1);
		// The route records no decision on the issue: its cycle is closed, and
		// the route's decision belongs to the pull request's own turn.
		expect(state.ticketWorkCycle.lastCompletion(issueIdentity)?.decision).toBe("closed");
		state.close();
	});

	test("an ignored position holds the re-fired skip's route, and the un-ignore frees it", async () => {
		// ADR 0060: this walk reads the projection before the list rule on
		// purpose, so the position's flag needs its own test - the route starts
		// an Agent on that Ticket, and an ignored one is out of every start.
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		expect(state.ticketWorkCycle.setTicketIgnored(pullIdentity, true, null).ok).toBe(true);
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(0);
		expect(state.ticketWorkCycle.setTicketIgnored(pullIdentity, false, null).ok).toBe(true);
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(1);
		state.close();
	});

	test("the route runs in auto mode too", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
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
				agent("pane-github:github.com:I_6", { status: "working" }),
				agent("pane-github:github.com:I_7", { status: "working" }),
			],
		});
		state.sourceFact.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		for (const identity of ["github:github.com:I_6", "github:github.com:I_7"]) {
			const claim = state.handoff.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
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
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		// A held failed turn that settled after the completed one pauses
		// automatic dispatch: a completed trace after it would end the pause.
		settleForCause(state, "github:github.com:I_6", {
			taskType: "implement",
			cause: "failed",
			detail: "the build broke",
		});
		expect(state.ticketWorkCycle.dispatchPauseActive()).toBe(true);
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a pull request that no longer offers the task holds the route", async () => {
		for (const labels of [[], ["needs-work"]]) {
			const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
			// No ready-for-review label: the position offers the default task,
			// not the review the outcome names, and the route waits for the
			// labels to stand.
			landPulls(state, pullTicket(labels));
			refiredCycle(state, refiredOutcome());
			await coordinator.tick();
			// The position offers the default task, not the review the outcome
			// names, so the route holds and the labels wait to land.
			expect(routeAsks(intents)).toBe(0);
			state.close();
		}
	});

	/**
	 * The pull request's own work standing between it and the route: claimed,
	 * settled into awaiting, or nothing. The route starts on an open position
	 * only.
	 */
	function pullOwnWork(
		state: FactoryState,
		setAgents: (agents: HerdrAgent[]) => void,
		shape: "running" | "awaiting",
	): void {
		const claim = state.handoff.claimHandoff(
			pullIdentity,
			{ ...choice, taskType: "review" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.handoff.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-pull",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		if (shape === "running") {
			setAgents([agent("pane-pull", { status: "working" })]);
			return;
		}
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: pullIdentity,
			handoffId: claim.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "settled the pull's turn",
			turnLog: [{ kind: "text", text: "settled the pull's turn" }],
			completedAt: "2026-08-31T11:00:00Z",
		});
	}

	/**
	 * The config with the pull request's own States: `ready-for-review` offers
	 * the review the re-fired outcome names. Without these States every ticket
	 * falls to the default task, and a fixture cannot tell "not open" apart
	 * from "offers another task" - the second guard answers first.
	 */
	const pullStateConfig: FactoryConfig = {
		...config,
		workflowStates: [
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
			},
		],
	};

	test("a pull request that is in flight holds the route", async () => {
		const { state, intents, setAgents, coordinator } = rig({
			autoOn: true,
			agents: [],
			config: pullStateConfig,
		});
		landPulls(state, pullTicket());
		// The pull request's own turn runs: it is not open, and the route starts
		// nothing on it. The position still offers the review the outcome names,
		// so the task guard cannot stand in for this one.
		pullOwnWork(state, setAgents, "running");
		expect(
			state.ticketWorkCycle
				.projectedTickets(pullStateConfig.workflowStates, "implement")
				.find((candidate) => candidate.identity === pullIdentity)?.suggestedTaskType,
		).toBe("review");
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(0);
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("running");
		state.close();
	});

	/**
	 * The position holds its own unfinished attempt: the walk reads that as
	 * recovery, and the claim refuses it at the ask. This walk pins both
	 * layers on one fixture, because either alone holds the route - the walk
	 * skips the position, and the state's gate refuses an ask that reaches it.
	 * That is defense in depth, and the record says so.
	 */
	test("a pull request with an unfinished attempt holds the route", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			config: pullStateConfig,
		});
		landPulls(state, pullTicket());
		// Claimed and never settled: the attempt stands unresolved.
		const claim = state.handoff.claimHandoff(
			pullIdentity,
			{ ...choice, taskType: "review" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		const position = state.ticketWorkCycle
			.projectedTickets(pullStateConfig.workflowStates, "implement")
			.find((candidate) => candidate.identity === pullIdentity);
		expect(position?.handoffRecoveryRequired).toBe(true);
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(0);
		// The state's own gate agrees: an ask that reached this position would
		// be refused at the enqueue (ADR 0049).
		expect(state.handoff.handoffClaimCheck(pullIdentity, "workflow")).toEqual({
			ok: false,
			reason: expect.stringContaining("recovery is required"),
		});
		state.close();
	});

	/**
	 * The skip's route reads the closed cycle that rests open behind it: a
	 * re-fired trace on a ticket that has since been handed off again, or that
	 * awaits another turn, is not the skip this walk starts on. The order of
	 * the closed cycle and the new turn is what this fixture holds.
	 */
	test("a re-fired trace on a ticket that is no longer open holds the route", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			config: pullStateConfig,
		});
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("open");
		expect(state.ticketWorkCycle.lastCompletion(issueIdentity)?.transition?.refired).toBe(true);
		// The issue is handed off again before the cycle runs: its re-fired
		// trace still stands, and the walk's entry test is the ticket's state.
		// The source re-reads first, so the claim the walk's own fixture makes
		// clears the re-verify gate that bounds a finished cycle.
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:02:00Z",
			tickets: [fetched()],
		});
		handOut(state, issueIdentity, "implement");
		expect(state.ticketWorkCycle.ticketState(issueIdentity)).toBe("handed-off");
		await coordinator.tick();
		// The walk starts on the open ticket the skip left behind. An in-flight
		// ticket with the same re-fired trace is not its candidate (ADR 0051).
		expect(routeAsks(intents)).toBe(0);
		state.close();
	});

	/**
	 * The position's own actionability, taken alone. A claim holds both this
	 * fact and the in-flight state above, so the pair is witnessed here on a
	 * position that stands open: its source is unhealthy, which makes it
	 * unactionable while it stays open, and the actionable guard is the only
	 * one left between the position and the add.
	 */
	test("a pull request whose source is unhealthy holds the route", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			config: pullStateConfig,
		});
		landPulls(state, pullTicket());
		refiredCycle(state, refiredOutcome());
		// The position stays open; its source goes unhealthy under it.
		state.sourceFact.applyFetch(pullSource, {
			status: "failed",
			reason: "gh is not authenticated",
		});
		const position = state.ticketWorkCycle
			.projectedTickets(pullStateConfig.workflowStates, "implement")
			.find((candidate) => candidate.identity === pullIdentity);
		expect(position?.state).toBe("open");
		expect(position?.actionable).toBe(false);
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(0);
		state.close();
	});

	/**
	 * The awaiting arm is not a guard the top-up holds: the cycle runs the
	 * automatic rule first, and the machine resolves the pull's own settled
	 * turn (its review task offers no continuation), closing that cycle before
	 * the route walk reads the row (ADR 0051). The position is open by then, so
	 * the route legitimately stands. This walk pins that order, which is the
	 * fact the retired "not open" fixture only reached in manual mode.
	 */
	test("a pull request whose own settled turn the machine closes routes after that close", async () => {
		const { state, intents, setAgents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		pullOwnWork(state, setAgents, "awaiting");
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("awaiting");
		refiredCycle(state, refiredOutcome());
		await coordinator.tick();
		// The machine closed the pull's own cycle first, and the same cycle's
		// route walk then took the position the close freed.
		expect(state.ticketWorkCycle.ticketState(pullIdentity)).toBe("open");
		expect(state.ticketWorkCycle.lastCompletion(pullIdentity)?.decision).toBe("auto-closed");
		expect(routeAsks(intents)).toBe(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({
				origin: "workflow",
				automatic: true,
				ticketIdentity: pullIdentity,
				routeFromIdentity: issueIdentity,
				choice: expect.objectContaining({ taskType: "review" }),
			}),
		);
		state.close();
	});

	test("the Same-type hold over the refresh lag holds the route", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		// The pull request ran a review cycle that completed, and its moved
		// labels have not landed: it still wears the labels by which it
		// suggests review. The hold the lag needs is the completed turn of
		// the task it still suggests.
		const attempt = state.handoff.claimHandoff(
			pullIdentity,
			{ ...choice, taskType: "review" },
			"open",
		);
		if (!attempt.ok) throw new Error(attempt.reason);
		state.handoff.settleHandoff(attempt.claim.attemptId, true, undefined, {
			paneId: "pane-pull",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: pullIdentity,
			handoffId: attempt.claim.attemptId,
			taskType: "review",
			agentType: "pi",
			message: "the review is done",
			turnLog: [{ kind: "text", text: "the review is done" }],
			completedAt: "2026-08-31T11:00:00Z",
			cause: "completed",
		});
		state.ticketWorkCycle.applyCompletionDecision({
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
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		// Two closed cycles put the pull request at the rig's limit of two.
		for (let cycle = 0; cycle < 2; cycle += 1) {
			const attempt = state.handoff.claimHandoff(
				pullIdentity,
				{ ...choice, taskType: "review" },
				"open",
			);
			if (!attempt.ok) throw new Error(attempt.reason);
			state.handoff.settleHandoff(attempt.claim.attemptId, true, undefined, {
				paneId: "pane-pull",
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
			state.ticketWorkCycle.settleTurn({
				ticketIdentity: pullIdentity,
				handoffId: attempt.claim.attemptId,
				taskType: "review",
				agentType: "pi",
				message: "a done review",
				turnLog: [{ kind: "text", text: "a done review" }],
				completedAt: "2026-08-31T11:00:00Z",
				cause: "aborted",
			});
			state.ticketWorkCycle.applyCompletionDecision({
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

	test("a re-fired outcome whose position left its source routes nothing", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		// The skip's fire derived its position; between the fire and the top-up
		// the ticket it named left every source, so the Next step stands held
		// and no route runs (ADR 0092).
		refiredCycle(state, refiredOutcome({ positionTicketIdentity: "github:github.com:P_999" }));
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(0);
		state.close();
	});

	test("a re-fired outcome with a failed write routes nothing", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(
			state,
			refiredOutcome({ writeFailure: "gh pr edit #12 failed: HTTP 403", reason: "" }),
		);
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(0);
		state.close();
	});

	test("a settle-time outcome routes nothing, re-fired or not", async () => {
		// The marker is the guard: a routable settle-time outcome on an open
		// ticket is not a re-fired skip, and the operator's close of it stands
		// without a second route.
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		refiredCycle(
			state,
			outcome({ positionTaskType: "review", positionTicketIdentity: pullIdentity }),
		);
		await coordinator.tick();
		// The marker is the guard: the routable settle-time outcome on the open
		// pull request is not a re-fired skip, so the route holds on it. The
		// pull's own open add stands: it is a different start, not this route.
		expect(routeAsks(intents)).toBe(0);
		expect(intents.some((intent) => intent.origin === "open")).toBe(true);
		state.close();
	});

	test("a trace that records no transition routes nothing", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		landPulls(state, pullTicket());
		const attempt = settleFor(state, issueIdentity, "implement", null);
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: issueIdentity,
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
		await coordinator.tick();
		expect(routeAsks(intents)).toBe(0);
		state.close();
	});
});

describe("the agent wake wait (ADR 0084)", () => {
	const identity = "github:github.com:I_5";
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	/**
	 * One wake fake: the wait targets it was armed on, in arm order, and the
	 * fires a test answers them in the same order.
	 */
	function wakeFake() {
		const targets: string[] = [];
		const waiters: Array<(matched: boolean) => void> = [];
		return {
			targets,
			arming: () => waiters.length,
			fire: (matched: boolean) => {
				const next = waiters.shift();
				if (next === undefined) throw new Error("no wake wait is pending");
				next(matched);
			},
			option: (target: string) =>
				new Promise<AgentWaitResult>((resolve) => {
					targets.push(target);
					waiters.push((matched: boolean) => resolve({ matched }));
				}),
		};
	}

	test("a settle state match runs a cycle now, so the turn settles without a poll", async () => {
		const wake = wakeFake();
		const fake = rig({
			agents: [agent("pane-implement", { status: "working" })],
			waitAgent: wake.option,
		});
		handOut(fake.state, identity);
		fake.advance(STARTUP_GRACE_MS + 1);
		await fake.coordinator.tick();
		// The cycle saw the working agent: the wait is armed on the agent's
		// name, the identity the live agent belongs to by.
		expect(wake.targets).toEqual([fake.state.ticketWorkCycle.agentNameForTicket(identity)]);
		// The agent finishes its turn between polls. The wake is the cycle.
		fake.setAgents([agent("pane-implement", { status: "idle" })]);
		wake.fire(true);
		await sleep(10);
		expect(
			fake.state.ticketWorkCycle
				.ticketsByState(["awaiting"])
				.some((t) => t.ticketIdentity === identity),
		).toBe(true);
		fake.coordinator.stop();
		fake.state.close();
	});

	test("the wait arms on the working report only: a booted idle agent holds no wait", async () => {
		const wake = wakeFake();
		const fake = rig({
			agents: [agent("pane-implement", { status: "idle" })],
			waitAgent: wake.option,
		});
		handOut(fake.state, identity);
		fake.advance(STARTUP_GRACE_MS + 1);
		await fake.coordinator.tick();
		// An idle report inside the startup grace is a boot, not a settle:
		// arming on it would match at once, in a loop the poll never had.
		expect(wake.targets).toEqual([]);
		fake.setAgents([agent("pane-implement", { status: "working" })]);
		await fake.coordinator.tick();
		expect(wake.targets).toEqual([fake.state.ticketWorkCycle.agentNameForTicket(identity)]);
		fake.coordinator.stop();
		fake.state.close();
	});

	test("a missing agent holds no wait", async () => {
		const wake = wakeFake();
		const fake = rig({ agents: [], waitAgent: wake.option });
		handOut(fake.state, identity);
		fake.advance(STARTUP_GRACE_MS + 1);
		await fake.coordinator.tick();
		expect(wake.targets).toEqual([]);
		fake.coordinator.stop();
		fake.state.close();
	});

	test("one wait per agent across cycles, and a settled ticket drops its arm", async () => {
		const wake = wakeFake();
		const fake = rig({
			agents: [agent("pane-implement", { status: "working" })],
			waitAgent: wake.option,
		});
		handOut(fake.state, identity);
		fake.advance(STARTUP_GRACE_MS + 1);
		await fake.coordinator.tick();
		await fake.coordinator.tick();
		// The armed wait is held, not re-armed: the second cycle adds none.
		expect(wake.targets).toHaveLength(1);
		// The wait answers with the settle: the turn settles, and the ticket
		// rests out of in-flight, so the next cycle arms nothing on it.
		fake.setAgents([agent("pane-implement", { status: "idle" })]);
		wake.fire(true);
		await sleep(10);
		await fake.coordinator.tick();
		expect(wake.targets).toHaveLength(1);
		fake.coordinator.stop();
		fake.state.close();
	});

	test("a failed wait wakes nothing, and the next cycle re-arms it", async () => {
		let listCalls = 0;
		const wake = wakeFake();
		const fake = rig({
			agents: () => {
				listCalls += 1;
				return [agent("pane-implement", { status: "working" })];
			},
			waitAgent: wake.option,
		});
		handOut(fake.state, identity);
		fake.advance(STARTUP_GRACE_MS + 1);
		await fake.coordinator.tick();
		expect(wake.targets).toHaveLength(1);
		expect(listCalls).toBe(1);
		// A missing agent, a herdr failure, and a budget timeout all answer
		// unmatched: a wake on none of them would run a cycle that re-arms the
		// same failed wait, in a loop.
		wake.fire(false);
		await sleep(10);
		expect(listCalls).toBe(1);
		expect(
			fake.state.ticketWorkCycle
				.ticketsByState(["awaiting"])
				.some((t) => t.ticketIdentity === identity),
		).toBe(false);
		// The failed wait is down; the next successful cycle re-arms it.
		await fake.coordinator.tick();
		expect(wake.targets).toHaveLength(2);
		fake.coordinator.stop();
		fake.state.close();
	});

	/**
	 * A working Consultation with a pending turn, the way a sent response
	 * leaves it: opened, the handles recorded, the response begun and
	 * accepted. The accept moves the record to working and commits the
	 * turn the settle needs.
	 */
	function workingConsultationWithTurn(state: FactoryState, id: string, paneId: string): void {
		state.consultationRecord.createConsultation({
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
		state.consultationRecord.recordConsultationAgentHandles(id, {
			paneId,
			tabId: "tab-1",
			workspaceId: "ws-1",
			sessionId: `session-${id}`,
		});
		state.consultationRecord.setConsultationState(id, "awaiting-response");
		const pending = state.consultationRecord.beginConsultationResponse(id, "go");
		if (pending === undefined) throw new Error("the response did not begin");
		const turn = state.consultationRecord.acceptConsultationResponse(id, pending.id);
		if (turn === undefined) throw new Error("the response did not accept");
	}

	test("a working Consultation whose agent works arms a wait on the Consultation's name", async () => {
		const wake = wakeFake();
		const fake = rig({
			agents: [agent("pane-consult", { status: "working" })],
			waitAgent: wake.option,
		});
		workingConsultationWithTurn(fake.state, "c-arm", "pane-consult");
		await fake.coordinator.tick();
		expect(wake.targets).toEqual(["consultation-c-arm"]);
		fake.coordinator.stop();
		fake.state.close();
	});

	test("a Consultation whose agent is not working or not its own arms no wait", async () => {
		const wake = wakeFake();
		const fake = rig({
			agents: [agent("pane-consult", { status: "idle" })],
			waitAgent: wake.option,
		});
		workingConsultationWithTurn(fake.state, "c-idle", "pane-consult");
		await fake.coordinator.tick();
		expect(wake.targets).toEqual([]);
		fake.coordinator.stop();
		fake.state.close();
	});

	test("a Consultation wait match settles its turn without a poll", async () => {
		const wake = wakeFake();
		const fake = rig({
			agents: [agent("pane-consult", { status: "working" })],
			waitAgent: wake.option,
		});
		workingConsultationWithTurn(fake.state, "c-settle", "pane-consult");
		await fake.coordinator.tick();
		expect(wake.targets).toEqual(["consultation-c-settle"]);
		// The agent finishes its answer between polls. The wake is the cycle.
		fake.setAgents([agent("pane-consult", { status: "idle" })]);
		wake.fire(true);
		await sleep(10);
		expect(fake.state.consultationRecord.consultation("c-settle")?.state).toBe("awaiting-response");
		fake.coordinator.stop();
		fake.state.close();
	});
});

describe("HerdrAgentReader.waitAgent", () => {
	const waitArgs = [
		"agent",
		"wait",
		"the-agent",
		"--until",
		"idle",
		"--until",
		"done",
		"--until",
		"blocked",
	];

	test("pins the herdr wait command and reads the state match", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", waitArgs, { stdout: "{}" });
		const result = await new HerdrAgentReader(runner).waitAgent("the-agent", 1500);
		expect(result).toEqual({ matched: true });
		expect(runner.commands()).toEqual([`herdr ${waitArgs.join(" ")}`]);
	});

	test("an unmatched exit is a failed wait", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", waitArgs, { code: 1, stderr: "agent target the-agent not found" });
		const result = await new HerdrAgentReader(runner).waitAgent("the-agent", 1500);
		expect(result).toEqual({ matched: false });
	});
});

describe("the open dispatch: the pull request group (ADR 0088)", () => {
	const pullSource = { name: "pulls", kind: "github-pull-requests" };

	function prFetched(
		index: number,
		labels: readonly string[],
		externalUpdatedAt = "2026-08-31T10:00:00Z",
	): FetchedTicket {
		return {
			identity: `github:github.com:P_${index}`,
			sourceKind: "github-pull-request",
			externalKey: `#${index}`,
			sourceState: "open",
			url: `https://github.com/acme/factory/pull/${index}`,
			title: `Pull request ${index}`,
			description: "The pull request of the factory branch.",
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

	function successPulls(tickets: FetchedTicket[], fetchedAt = "2026-08-31T10:02:00Z") {
		return { status: "success" as const, fetchedAt, tickets };
	}

	test("the top-up moves open pull request tickets before fresh open tickets", async () => {
		// One free seat, so each ask's own pickup pass starts the item the
		// walk adds, the way the module's pickup does.
		const seats = { current: 1 };
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			seatCount: () => seats.current,
		});
		state.sourceFact.initializeSources([source, pullSource]);
		state.sourceFact.applyFetch(source, success([fetched()]));
		state.sourceFact.applyFetch(
			pullSource,
			successPulls([prFetched(2, ["ready-for-review"]), prFetched(100, ["ready-for-review"])]),
		);
		await coordinator.tick();
		// The pull request group stands first, in the list's order inside it:
		// the lower-numbered pull request adds, ahead of the fresh issue and
		// the higher-numbered pull request alike.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:P_2",
				choice: expect.objectContaining({ taskType: "review" }),
			}),
		]);
		// The ask's pickup pass starts the review on the free seat: the row
		// leaves, and the ticket's state leaves the group's candidates.
		await settleDispatch(state);
		await coordinator.tick();
		// The group's second ticket adds before the fresh one: the walk
		// before the split took the issue #5 in this seat, the number order
		// of the list.
		expect(intents[1]).toEqual(
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:P_100",
				choice: expect.objectContaining({ taskType: "review" }),
			}),
		);
		await settleDispatch(state);
		await coordinator.tick();
		// The group drains, and the fresh ticket adds on its own.
		expect(intents[2]).toEqual(
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
				choice: expect.objectContaining({ taskType: "implement" }),
			}),
		);
		state.close();
	});

	test("a held pull request rests, and the walk falls to the fresh ticket", async () => {
		// One free seat, so the ask's own pickup pass starts the item the
		// walk adds, the way the module's pickup does.
		const seats = { current: 1 };
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [],
			seatCount: () => seats.current,
		});
		state.sourceFact.initializeSources([source, pullSource]);
		state.sourceFact.applyFetch(source, success([fetched(), fetched("github:github.com:I_6")]));
		state.sourceFact.applyFetch(pullSource, successPulls([prFetched(100, ["ready-for-review"])]));
		// The pull request's review completes without an advance: the cycle
		// closes, and the Same-type hold stands over the position the pull
		// request still offers.
		settleForCause(state, "github:github.com:P_100", {
			taskType: "review",
			cause: "completed",
			detail: "",
			transition: outcome(),
		});
		await coordinator.tick();
		// The auto-close ends the cycle, and the re-verify gate holds the
		// pull request until the source re-reads it. The gate holds the pull
		// request only: the walk falls to the fresh ticket in the same tick.
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual(
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
			}),
		);
		// The ask's pickup pass starts the fresh ticket on the free seat:
		// the row leaves, and the ticket's state leaves the walk's candidates.
		await settleDispatch(state);
		state.sourceFact.applyFetch(
			pullSource,
			successPulls([prFetched(100, ["ready-for-review"])], "2026-08-31T11:01:00Z"),
		);
		// The re-read landed: the re-verify gate is clear, and the Same-type
		// hold stands alone on the position.
		expect(state.ticketWorkCycle.sameTypeHoldActive("github:github.com:P_100", "review")).toBe(
			true,
		);
		await coordinator.tick();
		// The hold rests the pull request, and the walk falls to the next
		// fresh ticket: I_5 stands started from its add, so I_6 adds.
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
});

/**
 * The failed Handoff start's hold (ADR 0077 as extended by ADR 0101, issue #217).
 *
 * The development install recorded this shape on three Tickets: one start that
 * never reached its Agent, asked again on every observation cycle, 9,365 times
 * over five days on Ticket #37. The fixture's herdr refuses the start's
 * environment build: the claim ran, herdr refused the Agent, and the attempt
 * settled `failed` with no Handoff under it.
 */
describe("the failed Handoff start's hold (ADR 0077 as extended by ADR 0101, issue #217)", () => {
	const failure = "Preparing worktree: the worktree path already exists";

	/** One open Ticket, and the automatic start on it that started no Agent. */
	function failedStartRig(over: { config?: Partial<FactoryConfig> } = {}) {
		// The Handoff limit stands well above the run these tests build: the Failed-
		// start park holds the ask at half the limit (ADR 0106), and these tests are
		// about the Attempt hold's one-refresh wait, which the park sits behind.
		const r = rig({
			autoOn: true,
			agents: [],
			config: { maxHandoffsPerTicket: 20, ...over.config },
			// One free seat, so the ask's own pickup pass runs the start.
			seatCount: () => 1,
		});
		// The start's environment build is what herdr refuses.
		r.runner.set("herdr", ["workspace", "create", "--cwd", r.checkout, "--no-focus"], {
			code: 1,
			stderr: failure,
		});
		return r;
	}

	/** The re-read that carries the Ticket's current facts, one refresh later. */
	function refresh(state: FactoryState, identity = "github:github.com:I_5"): void {
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [fetched(identity)],
		});
	}

	const refusalLines = (statuses: Rig["statuses"]) =>
		statuses.filter((status) => status.text.includes("could not hand off"));

	test("the failed start holds the next cycle's ask, and the source's re-read releases it", async () => {
		const { state, intents, coordinator, settle } = failedStartRig();
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		// The ask's pickup pass ran on behind it; the test waits on the
		// settled ledger before it reads it.
		await settle();
		// The ask that ran and failed: the attempt row it left is the hold's fact.
		expect(state.handoff.handoffBlockedUnrefreshed("github:github.com:I_5")).toBe(true);
		// The cycles that follow ask nothing. Every other gate still reads clear -
		// the Ticket stands open and actionable, the queue stands empty - so the
		// hold is the only thing between the walk and the same failing start.
		await coordinator.tick();
		await coordinator.tick();
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		// The release: one active source re-reads the Ticket after the attempt.
		refresh(state);
		await coordinator.tick();
		expect(intents).toHaveLength(2);
		expect(intents[1]).toEqual(
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:I_5",
			}),
		);
		// The re-ask's own pickup pass runs its start on behind the ask; the
		// test waits on the settled ledger before the state goes.
		await settle();
		state.close();
	});

	test("the hold is silent: the refusal line stands once, not once per cycle", async () => {
		const { state, coordinator, statuses, settle } = failedStartRig();
		await coordinator.tick();
		await settle();
		// The ask ran, and the pickup's drop states the refusal once.
		const dropLines = () => statuses.filter((status) => status.text.includes("was not run"));
		expect(dropLines()).toHaveLength(1);
		await coordinator.tick();
		await coordinator.tick();
		await coordinator.tick();
		// The held re-ask says nothing: the walk moved on to its next candidate,
		// and the Message line carries no copy of a hold that changed nothing.
		expect(dropLines()).toHaveLength(1);
		expect(statuses.filter((status) => status.kind === "warning")).toHaveLength(1);
		// The re-ask on the refresh is the expected path, so its refusal is a line
		// again: the ask ran, and the hold did not.
		refresh(state);
		await coordinator.tick();
		await settle();
		expect(dropLines()).toHaveLength(2);
		state.close();
	});

	test("the hold covers the continuation walk's position", async () => {
		const { state, intents, coordinator, runner, checkout, settle } = rig({
			autoOn: true,
			agents: [],
			config: { maxHandoffsPerTicket: 20 },
			// One free seat, so the ask's own pickup pass runs the start.
			seatCount: () => 1,
		});
		// The start's environment build is what herdr refuses.
		runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
			code: 1,
			stderr: failure,
		});
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		// A settled turn whose Next step stands on the open position I_6.
		settleFor(state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		const asks = (identity: string) =>
			intents.filter((intent) => intent.ticketIdentity === identity);
		await coordinator.tick();
		expect(asks("github:github.com:I_6")).toHaveLength(1);
		// The ask's pickup pass ran the start on behind it; the test waits on
		// the settled ledger before it reads it.
		await settle();
		await coordinator.tick();
		await settle();
		await coordinator.tick();
		// The position the route starts on is the Ticket the failed start holds:
		// the hold covers it, and the walks move to their next candidates.
		expect(asks("github:github.com:I_6")).toHaveLength(1);
		refresh(state, "github:github.com:I_6");
		await coordinator.tick();
		expect(asks("github:github.com:I_6")).toHaveLength(2);
		// The re-ask's own pickup pass runs its start on behind the ask; the
		// test waits on the settled ledger before the state goes.
		await settle();
		state.close();
	});

	test("the hold covers the restart walk", async () => {
		const { state, intents, coordinator, setAgents, advance, runner, checkout, settle } = rig({
			autoOn: true,
			agents: [agent("pane-implement")],
			config: { maxHandoffsPerTicket: 5 },
			// One free seat, so the ask's own pickup pass runs the start.
			seatCount: () => 1,
		});
		// The restart reopens the ticket's branch, and herdr refuses the open.
		runner.set(
			"herdr",
			["worktree", "open", "--cwd", checkout, "--branch", "factory/5-persist-source-facts", "--no-focus"],
			{ code: 1, stderr: failure },
		);
		handOut(state, "github:github.com:I_5");
		setAgents([]);
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		await settle();
		expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
		await coordinator.tick();
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
		refresh(state);
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(2);
		// The re-ask's own pickup pass runs its start on behind the ask; the
		// test waits on the settled ledger before the state goes.
		await settle();
		state.close();
	});

	test("the hold gates the automatic ask, not the claim the operator's ask runs", async () => {
		const { state, intents, coordinator, settle } = failedStartRig();
		await coordinator.tick();
		// The ask's pickup pass ran on behind it; the test waits on the
		// settled ledger before it reads it.
		await settle();
		// The failed start stands, unrefreshed. The gate the hold owns is the
		// top-up's ask; the claim check the operator's confirm and the pickup run
		// answers clear, the way it answers past the Handoff limit and the
		// Same-type hold.
		expect(state.handoff.handoffBlockedUnrefreshed("github:github.com:I_5")).toBe(true);
		expect(state.handoff.handoffClaimCheck("github:github.com:I_5", "open")).toEqual({ ok: true });
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		state.close();
	});

	test("the loop as it runs: the ask enqueues, the pickup's start fails, the next ask is held", async () => {
		// The shape the development install actually ran (issue #217). The
		// automatic ask only enqueues, so it answers "added" before any start has
		// failed; the failure lands later, at the pickup, when herdr refuses the
		// start. The module's pickup runs that walk (ADR 0049): the claim runs the
		// hard checks, the start fails, the attempt settles `failed` with no Handoff
		// under it, and the item drops. That row is what the hold reads, and no
		// earlier test in this file covers this order.
		const identity = "github:github.com:I_5";
		const seats = { current: 2 };
		const { state, intents, coordinator, runner, checkout, settle } = rig({
			autoOn: true,
			agents: [],
			config: { maxHandoffsPerTicket: 20 },
			seatCount: () => seats.current,
		});
		// The start's environment build is what herdr refuses.
		runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
			code: 1,
			stderr: failure,
		});
		// Cycle 1: the ask lands in the queue. The seats stand full, so the
		// ask's own pickup pass takes nothing: nothing has failed, so nothing
		// is held, and the queue's one-item rule ends the cycle's fresh work.
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		expect(state.workQueue.hasWorkItem(identity)).toBe(true);
		expect(state.handoff.handoffBlockedUnrefreshed(identity)).toBe(false);
		// Cycle 2: the freed seat lets the pickup take the row, and herdr
		// refuses the start. The pickup runs ahead of the walk in the cycle,
		// so the failed attempt stands when the walk reads it: the ask in
		// this same cycle - the one that would have re-asked it - is held.
		seats.current = 1;
		await coordinator.tick();
		// The pickup's start runs on behind the cycle; the test waits on the
		// settled ledger before it reads it.
		await settle();
		expect(state.workQueue.hasWorkItem(identity)).toBe(false);
		expect(state.handoff.handoffBlockedUnrefreshed(identity)).toBe(true);
		expect(intents).toHaveLength(1);
		// Every later cycle reaches the same gate. Without the hold this is where
		// the loop ran: one ask per cycle, 9,365 of them on Ticket #37.
		await coordinator.tick();
		await coordinator.tick();
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		// The release: the source re-reads the Ticket, and the walk asks it again.
		refresh(state);
		await coordinator.tick();
		expect(intents).toHaveLength(2);
		// The re-ask's own pickup pass runs its start on behind the ask; the
		// test waits on the settled ledger before the state goes.
		await settle();
		state.close();
	});
});

/**
 * The Failed-start park (issue #298, ADR 0106).
 *
 * The Attempt hold above waits out one failed start for the source read that
 * carries the Ticket's current facts. That is the right wait for one failure and
 * the wrong one for a cause outside the Ticket: the development install asked
 * Ticket #37 9,365 times over five days, one ask per refresh, and the Handoff
 * limit that was supposed to bound it only stopped the cycle at 20. The park is
 * the second brake: at half the limit the Top-up stops asking, and the fact says
 * so on the record, the Message line, the row, and the detail.
 */
describe("the Failed-start park holds a Ticket whose starts keep failing (issue #298)", () => {
	const failure = "Preparing worktree: the worktree path already exists";
	const IDENTITY = "github:github.com:I_5";
	// A Handoff limit of 4 parks the Ticket at 2 failed starts and ends its work
	// cycle at 4 attempts, so a test can see the park arrive first.
	const PARK_LIMIT = 4;

	/** One open Ticket, every start on it starting no Agent, and its record. */
	function parkRig() {
		const lines: RecordedLine[] = [];
		const r = rig({
			autoOn: true,
			agents: [],
			config: { maxHandoffsPerTicket: PARK_LIMIT },
			// One free seat, so each ask's own pickup pass runs the start.
			seatCount: () => 1,
			log: recordLogger(lines),
		});
		// The start's environment build is what herdr refuses.
		r.runner.set("herdr", ["workspace", "create", "--cwd", r.checkout, "--no-focus"], {
			code: 1,
			stderr: failure,
		});
		return { ...r, lines };
	}

	/** The re-read that carries the Ticket's current facts, one refresh later. */
	function refresh(state: FactoryState, identity = IDENTITY): void {
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets: [fetched(identity)],
		});
	}

	/**
	 * Run the loop until the Ticket's newest run holds `streak` failed starts: each
	 * failure needs its own source re-read, because the Attempt hold waits the ask
	 * out until the read lands.
	 */
	async function failStarts(state: FactoryState, coordinator: Rig["coordinator"], streak: number) {
		for (let i = 0; i < streak; i += 1) {
			await coordinator.tick();
			// The ask's pickup pass ran the start on behind it; the re-read lands
			// after the failed start settled, the way the hold waits for it.
			await settleDispatch(state);
			refresh(state);
		}
		await coordinator.tick();
	}

	const holdLines = (lines: readonly RecordedLine[]) =>
		lines.filter((line) => line.message.includes("the Ticket's Handoff starts keep failing"));
	const parkWarnings = (statuses: Rig["statuses"]) =>
		statuses.filter((status) => status.text.startsWith("handoff failure park:"));

	test("the run of failed starts holds the Top-up out of the Ticket, and the record says so", async () => {
		const { state, intents, lines, coordinator } = parkRig();
		// Two failed starts: the park's count at this limit. The first ask ran and
		// failed, the second ran on the refresh and failed, and the third ask is the
		// one the park holds.
		await failStarts(state, coordinator, 2);
		expect(state.handoff.handoffCount(IDENTITY)).toBe(2);
		expect(intents).toHaveLength(2);
		// The record names the hold, and names the Ticket the walk reached: a run
		// with more than one Ticket in play has to say which one it left resting.
		expect(holdLines(lines).map((line) => line.message)).toEqual([
			'automatic walks hold: the Ticket\'s Handoff starts keep failing ("Persist source facts")',
		]);
		// The loop stops here. Every other gate reads clear - the Ticket stands open
		// and actionable, the queue stands empty, the source re-reads it - so without
		// the park this is where the 9,365 asks ran.
		for (let i = 0; i < 5; i += 1) {
			refresh(state);
			await coordinator.tick();
		}
		expect(intents).toHaveLength(2);
		// One line for a standing fact, not one per poll (issue #223).
		expect(holdLines(lines)).toHaveLength(1);
		state.close();
	});

	test("the park states itself on the Message line as the warning the notification carries", async () => {
		const { state, coordinator, statuses } = parkRig();
		await failStarts(state, coordinator, 2);
		// The standing warning the Desktop notification carries (ADR 0080): the
		// operator learns the loop stopped without reading the file, and the count is
		// what they weigh.
		expect(parkWarnings(statuses).map((status) => status.text)).toEqual([
			'handoff failure park: "Persist source facts" (2 Handoff starts in a row never reached an Agent)',
		]);
		expect(parkWarnings(statuses)[0].kind).toBe("warning");
		for (let i = 0; i < 5; i += 1) {
			refresh(state);
			await coordinator.tick();
		}
		expect(parkWarnings(statuses)).toHaveLength(1);
		state.close();
	});

	test("the park arrives before the Handoff limit ends the work cycle", async () => {
		const { state, intents, coordinator } = parkRig();
		await failStarts(state, coordinator, 2);
		// The park stands at half the cap, and the cap that ends a work cycle is
		// still ahead of it: the operator meets the loop while the limit can still
		// count what comes after.
		expect(state.handoff.handoffCount(IDENTITY)).toBe(2);
		expect(state.handoff.handoffCount(IDENTITY)).toBeLessThan(PARK_LIMIT);
		for (let i = 0; i < 5; i += 1) {
			refresh(state);
			await coordinator.tick();
		}
		// The limit still counts every attempt, and it never reaches its own cap on
		// an automatic ask the park holds out.
		expect(state.handoff.handoffCount(IDENTITY)).toBe(2);
		expect(intents).toHaveLength(2);
		state.close();
	});

	test("a start that reaches its Agent ends the run, and the automatic ask comes back", async () => {
		const { state, intents, lines, coordinator, advance } = parkRig();
		await failStarts(state, coordinator, 2);
		expect(holdLines(lines)).toHaveLength(1);
		// The operator's own Handoff, the one act the park never holds out. It reaches
		// its Agent, so the run ends and the park leaves with it; the cycle closes the
		// way any settled turn does.
		const attempt = handOut(state, IDENTITY, "research");
		advance(90_000);
		state.ticketWorkCycle.settleTurn({
			ticketIdentity: IDENTITY,
			handoffId: attempt,
			taskType: "research",
			agentType: "pi",
			message: "the turn is over",
			turnLog: [{ kind: "text", text: "the turn is over" }],
			completedAt: "2026-08-31T11:01:30Z",
		});
		advance(30_000);
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: IDENTITY,
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:02:00Z",
		});
		expect(state.handoff.failedStartStreaksFor([IDENTITY]).get(IDENTITY)).toBe(0);
		// The Ticket rests open with its run ended, and the automatic walk asks it
		// again: the resume needs no second act.
		refresh(state);
		await coordinator.tick();
		expect(intents).toHaveLength(3);
		expect(intents[2]).toEqual(
			expect.objectContaining({ origin: "open", automatic: true, ticketIdentity: IDENTITY }),
		);
		state.close();
	});

	test("the operator's ignore answers the failure, and un-ignoring states the park again", async () => {
		const { state, coordinator, statuses, lines } = parkRig();
		await failStarts(state, coordinator, 2);
		expect(parkWarnings(statuses)).toHaveLength(1);
		// The ignore is the operator's answer to the failing starts, so the standing
		// fact retires: the walk holds the Ticket out before it reaches the ask.
		expect(state.ticketWorkCycle.setTicketIgnored(IDENTITY, true)).toEqual({ ok: true });
		await coordinator.tick();
		expect(parkWarnings(statuses)).toHaveLength(1);
		expect(holdLines(lines)).toHaveLength(1);
		// The act leaves, the run is still there, and the park is a fact the cycle
		// derives: it states itself again rather than staying silent forever.
		expect(state.ticketWorkCycle.setTicketIgnored(IDENTITY, false)).toEqual({ ok: true });
		refresh(state);
		await coordinator.tick();
		expect(parkWarnings(statuses)).toHaveLength(2);
		expect(holdLines(lines)).toHaveLength(2);
		state.close();
	});

	test("a source mute answers the failure through the cycle, and un-muting states it again", async () => {
		// The mute is the other operator act on the failing starts (ADR 0070): the
		// Ticket's source is the thing that keeps offering the task, and muting it is
		// the answer. The park reads the same judged-out fact the row does, so the
		// standing fact retires through the cycle and not only on the row.
		const { state, coordinator, statuses, lines } = parkRig();
		await failStarts(state, coordinator, 2);
		expect(parkWarnings(statuses)).toHaveLength(1);
		expect(state.sourceFact.setSourceMuted(source.name, true)).toEqual({ ok: true, removed: 0 });
		await coordinator.tick();
		// The walk never reaches the ask: the judged-out gate holds the Ticket out
		// ahead of it, and the retired report says nothing more.
		expect(state.ticketWorkCycle.automaticStartBlockedTicket(IDENTITY)).toBe(true);
		expect(parkWarnings(statuses)).toHaveLength(1);
		expect(holdLines(lines)).toHaveLength(1);
		// The act leaves, the run is still in the ledger, and the park is a fact the
		// cycle derives: the next ask states it again rather than staying silent.
		expect(state.sourceFact.setSourceMuted(source.name, false)).toEqual({ ok: true, removed: 0 });
		refresh(state);
		await coordinator.tick();
		expect(parkWarnings(statuses)).toHaveLength(2);
		expect(holdLines(lines)).toHaveLength(2);
		state.close();
	});
});

/**
 * The holds the automatic walks take, stated in the record (issue #223).
 *
 * Every one of these holds returns before a walk asks anything, so the run shows
 * the start that never came and says nothing about why - the failure the dev run
 * on PR #215 left behind. The cycle carries the dispatch's `log` seam and states
 * each fact it acted on once, in the words the gate rule owns, at the `info`
 * level the configuration reference states for these lines.
 */
/**
 * The Agent name collision (issue #299, ADR 0107): the standing fact a Handoff
 * start leaves when herdr holds the Ticket's stable Agent name in a pane the
 * plane does not own.
 *
 * The refusal is not transient, so the automatic re-ask waits for the operator
 * instead of spending the Handoff limit on it: the walk holds the Ticket out
 * while the fact stands, states the hold once with the refusal beside it, and
 * asks again when the operator's own Handoff takes the name. The dispatch's own
 * recording of the fact is measured in test/handoff-dispatch.test.ts; this rig's
 * start seam settles the attempt without a herdr refusal, so these tests record
 * the fact the way the dispatch leaves it.
 */
describe("the Agent name collision holds the Top-up out (issue #299)", () => {
	const IDENTITY = "github:github.com:I_5";
	const REFUSAL =
		"the herdr name persist-source-facts-1a2b3c4d is held by pane w13K:p1 in workspace w13K, " +
		"which is no agent of this ticket: agent_name_taken";
	const HOLD_LINE = `automatic walks hold: another pane holds the Ticket's Agent name ("Persist source facts": ${REFUSAL})`;
	const WARNING =
		'agent name held: "Persist source facts" (the herdr name persist-source-facts-1a2b3c4d ' +
		"is held by pane w13K:p1 in workspace w13K)";

	/** The record lines and the rig of one Ticket whose start herdr refuses. */
	function collisionRig(config?: Partial<FactoryConfig>) {
		const lines: RecordedLine[] = [];
		const r = rig({
			autoOn: true,
			agents: [],
			// The rig's default Handoff limit of 2 parks a Ticket at one failed start.
			// These tests want the collision alone in front of them, so the limit sits
			// high; the test that wants both facts names its own.
			config: { maxHandoffsPerTicket: 10, ...config },
			// One free seat, so the ask's own pickup pass runs the start.
			seatCount: () => 1,
			log: recordLogger(lines),
		});
		// The start's environment build is what herdr refuses, with the refusal
		// the collision fact names.
		r.runner.set("herdr", ["workspace", "create", "--cwd", r.checkout, "--no-focus"], {
			code: 1,
			stderr: REFUSAL,
		});
		return { ...r, lines };
	}

	/** The fact one refused start leaves on the Ticket. */
	function standCollision(state: FactoryState): void {
		state.handoff.recordNameCollision({
			ticketIdentity: IDENTITY,
			heldName: "persist-source-facts-1a2b3c4d",
			holderPaneId: "w13K:p1",
			holderWorkspaceId: "w13K",
			reason: REFUSAL,
		});
	}

	/** The re-read that carries the Ticket's current facts, one refresh later. */
	function refresh(state: FactoryState, tickets: FetchedTicket[] = [fetched(IDENTITY)]): void {
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:30:00Z",
			tickets,
		});
	}

	const holdLines = (lines: readonly RecordedLine[]) =>
		lines.filter((line) => line.message.startsWith("automatic walks hold: another pane holds"));

	test("the collision holds the Top-up out, and the walk stops asking", async () => {
		const { state, coordinator, intents, statuses, advance, lines, settle } = collisionRig();
		// The first ask runs and herdr refuses the start: the attempt settles failed.
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		await settle();
		standCollision(state);
		// The source re-reads the Ticket, so the Attempt hold releases - and the
		// collision takes the gate: the walk adds nothing, however long it waits.
		refresh(state);
		for (let i = 0; i < 4; i += 1) {
			await coordinator.tick();
			advance(60_000);
		}
		expect(intents).toHaveLength(1);
		// The refusal stands as a fact the operator can act on, and the record names
		// the hold once, with the refusal the attempt stored beside the Ticket.
		expect(holdLines(lines)).toEqual([infoLine(HOLD_LINE)]);
		// The Message line carries the same fact as the warning the notification
		// shows, naming where the name is held.
		expect(statuses.filter((status) => status.text.startsWith("agent name held:"))).toEqual([
			{ kind: "warning", text: WARNING },
		]);
		// The row carries the fact, so the marker and the detail state which Ticket
		// rests without a rule of their own.
		expect(
			state.ticketWorkCycle.ticketListViews([], "implement").rows[0].nameCollision,
		).not.toBeNull();
		state.close();
	});

	test("the collision speaks before the Failed-start park (issue #299)", async () => {
		// Both facts stand on the same ledger, and the collision is the one the
		// operator can act on: the walk names it, and the park stays silent.
		const { state, coordinator, intents, lines, settle } = collisionRig({ maxHandoffsPerTicket: 2 });
		await coordinator.tick();
		await settle();
		standCollision(state);
		refresh(state);
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		expect(holdLines(lines)).toEqual([infoLine(HOLD_LINE)]);
		expect(
			lines.filter((line) => line.message.includes("the Ticket's Handoff starts keep failing")),
		).toEqual([]);
		state.close();
	});

	test("the operator's own Handoff that takes the name ends the hold", async () => {
		const { state, coordinator, intents, advance, settle } = collisionRig();
		await coordinator.tick();
		await settle();
		standCollision(state);
		refresh(state);
		await coordinator.tick();
		expect(intents).toHaveLength(1);
		// The operator closes the stranger's agent in herdr and hands the Ticket off.
		// That start reaches its Agent, so the fact leaves - and the automatic adds
		// resume on the same rule, with no second act.
		expect(state.handoff.clearNameCollision(IDENTITY)).toBe(true);
		advance(60_000);
		refresh(state);
		await coordinator.tick();
		expect(intents).toHaveLength(2);
		expect(intents[1]).toEqual(
			expect.objectContaining({ origin: "open", automatic: true, ticketIdentity: IDENTITY }),
		);
		state.close();
	});

	test("the ignore answers the refusal, and un-ignoring states it again", async () => {
		const { state, coordinator, lines, settle } = collisionRig();
		await coordinator.tick();
		await settle();
		standCollision(state);
		refresh(state);
		await coordinator.tick();
		expect(holdLines(lines)).toEqual([infoLine(HOLD_LINE)]);
		// The ignore is the operator's answer to the refusal, the way it answers a run
		// of failed starts (ADR 0060, ADR 0070, ADR 0106): the standing fact retires,
		// and the walk stops naming the hold.
		expect(state.ticketWorkCycle.setTicketIgnored(IDENTITY, true)).toEqual({ ok: true });
		await coordinator.tick();
		expect(holdLines(lines)).toHaveLength(1);
		// The act leaves, the refusal still stands in herdr, and the fact is on the
		// Ticket: it states itself again rather than staying silent forever.
		expect(state.ticketWorkCycle.setTicketIgnored(IDENTITY, false)).toEqual({ ok: true });
		refresh(state);
		await coordinator.tick();
		expect(holdLines(lines)).toHaveLength(2);
		state.close();
	});

	test("the fact leaves the record when the source closes the Ticket", async () => {
		const { state, coordinator, lines, settle } = collisionRig();
		await coordinator.tick();
		await settle();
		standCollision(state);
		refresh(state);
		await coordinator.tick();
		expect(holdLines(lines)).toEqual([infoLine(HOLD_LINE)]);
		// The Ticket left the list, so the walk has no candidate to hold out and no
		// line to re-state: the entry retires with it.
		refresh(state, []);
		await coordinator.tick();
		await coordinator.tick();
		expect(holdLines(lines)).toEqual([infoLine(HOLD_LINE)]);
		state.close();
	});
});

describe("the automatic walks state their holds in the record (issue #223)", () => {
	/** One cycle over the default feed, with its record lines read back. */
	function recordRig(over: { autoOn?: boolean } = {}) {
		const lines: RecordedLine[] = [];
		const r = rig({
			autoOn: over.autoOn ?? true,
			agents: [],
			log: recordLogger(lines),
		});
		return { ...r, lines };
	}

	/** Stand one row in the queue, the way an ask that found no seat leaves it. */
	function queueRow(
		state: FactoryState,
		identity: string,
		origin: HandoffOrigin,
		automatic: boolean,
	): void {
		const enqueued = state.workQueue.enqueueWork({
			ticketIdentity: identity,
			routeFromIdentity: null,
			origin,
			choice,
			previousMessage: "",
			automatic,
		});
		if (!enqueued.ok) throw new Error(enqueued.reason);
	}

	/** One awaiting ticket whose settled turn owes a route onto another ticket. */
	function continuationRecordRig(over: { autoOn?: boolean } = {}) {
		const r = recordRig(over);
		// The two tickets carry different titles, so a hold line that names a row can
		// be told from one that names another (issue #223 review).
		r.state.sourceFact.applyFetch(
			source,
			success([
				{ ...fetched("github:github.com:I_6"), title: "Add a webhook retry policy" },
				fetched(),
			]),
		);
		settleFor(r.state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_6"));
		return r;
	}

	test("a continuation already standing holds the owed one, and the cycle names the hold", async () => {
		const { state, intents, lines, coordinator } = continuationRecordRig();
		queueRow(state, "github:github.com:I_6", "workflow", true);
		await coordinator.tick();
		// The queue's own pace: one continuation at a time (ADR 0051).
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(0);
		// Each fact the cycle acted on names itself: the continuation the walk
		// would have jumped, and the row the fresh-work add waits behind. A hold is
		// news about a run that started nothing, not a warning, so both lines carry
		// `info`.
		expect(lines).toEqual([
			infoLine(
				'automatic walks hold: the Work queue already holds a continuation ("Add a webhook retry policy")',
			),
			infoLine("automatic walks hold: the Work queue holds a waiting row"),
		]);
		state.close();
	});

	/**
	 * The row the dev run on PR #215 left behind (issue #223). The operator's route
	 * decision keeps its row in the queue with no `automatic` mark, and the queue's
	 * pace rule holds on a Workflow route row already standing, of either staging
	 * (issue #230), so this row is the row the walk waits behind and the cycle asks
	 * nothing. ADR 0100 ranks the owed continuation ahead in the queue's order; a row
	 * that already stands is never overtaken by a row that has not entered. The line
	 * has to say whose row it is: the origin of the operator's route and of the
	 * factory's continuation is the same `workflow`, and a record that calls the
	 * operator's row a continuation names a fact the row is not.
	 */
	test("an item the operator staged holds the owed one, and the cycle names it as the operator's", async () => {
		const { state, intents, lines, coordinator } = continuationRecordRig();
		queueRow(state, "github:github.com:I_6", "workflow", false);
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(0);
		expect(lines).toEqual([
			infoLine(
				'automatic walks hold: the Work queue holds an item the operator staged ("Add a webhook retry policy")',
			),
			infoLine("automatic walks hold: the Work queue holds a waiting row"),
		]);
		state.close();
	});

	/**
	 * The question this issue's title asks (issue #223 review): a run with more than
	 * one ticket in play has to say which owed start the hold blocked, not only that
	 * a hold happened. The walk holds the standing row in hand when its gate
	 * answers, so the line names that row, and a later cycle that waits behind a
	 * different row is a different fact that states itself again.
	 */
	test("the hold names the row it waits behind, and a different row is a new fact", async () => {
		const { state, lines, coordinator } = continuationRecordRig();
		queueRow(state, "github:github.com:I_6", "workflow", true);
		await coordinator.tick();
		const first = [...lines];
		expect(first[0]).toEqual(
			infoLine(
				'automatic walks hold: the Work queue already holds a continuation ("Add a webhook retry policy")',
			),
		);
		// The same row stands: the fact says nothing again.
		await coordinator.tick();
		expect(lines).toEqual(first);
		// The row leaves, and the row that stands next belongs to another ticket.
		expect(state.workQueue.removeWorkItem("github:github.com:I_6")).toBe(true);
		queueRow(state, "github:github.com:I_5", "workflow", true);
		await coordinator.tick();
		expect(lines[first.length]).toEqual(
			infoLine(
				'automatic walks hold: the Work queue already holds a continuation ("Persist source facts")',
			),
		);
		state.close();
	});

	test("each hold names its own fact, and no two share a line", async () => {
		// Auto-handoff mode off: the walks run no automatic add at all.
		const off = recordRig({ autoOn: false });
		await off.coordinator.tick();
		expect(off.lines).toEqual([infoLine("automatic walks hold: auto-handoff is off")]);
		off.state.close();

		// The operator's brake on the queue itself (ADR 0052).
		const paused = recordRig();
		paused.state.workQueue.setQueuePaused(true);
		await paused.coordinator.tick();
		expect(paused.lines).toEqual([infoLine("automatic walks hold: the Work queue is paused")]);
		paused.state.close();

		// The Dispatch pause: a held failed turn stands undecided (ADR 0016).
		const held = recordRig();
		settleForCause(held.state, "github:github.com:I_5", {
			taskType: "route",
			cause: "failed",
			detail: "the build broke",
		});
		await held.coordinator.tick();
		expect(held.lines).toEqual([
			infoLine("automatic walks hold: a failed turn waits for the operator"),
		]);
		held.state.close();

		// A row the operator staged stands in the queue (ADR 0100): the fresh-work
		// add is the walk it holds.
		const row = recordRig();
		queueRow(row.state, "github:github.com:I_5", "open", false);
		await row.coordinator.tick();
		expect(row.lines).toEqual([
			infoLine("automatic walks hold: the Work queue holds a waiting row"),
		]);
		row.state.close();
	});

	test("a standing hold states itself once, and a fact that moves states itself again", async () => {
		const { state, lines, coordinator } = continuationRecordRig();
		queueRow(state, "github:github.com:I_6", "workflow", true);
		await coordinator.tick();
		const standing = [...lines];
		expect(standing).toHaveLength(2);
		// The poll re-derives the same facts every five seconds: an unchanged cycle
		// says nothing again, so the line cannot pin the file at the poll's cadence.
		await coordinator.tick();
		await coordinator.tick();
		expect(lines).toEqual(standing);
		// A new fact states itself once.
		state.workQueue.setQueuePaused(true);
		await coordinator.tick();
		expect(lines.slice(standing.length)).toEqual([
			infoLine("automatic walks hold: the Work queue is paused"),
		]);
		// The facts the queue still stands on state themselves once more, and then
		// hold their silence for every later cycle.
		state.workQueue.setQueuePaused(false);
		await coordinator.tick();
		expect(lines.length).toBe(standing.length + 3);
		await coordinator.tick();
		await coordinator.tick();
		expect(lines).toHaveLength(standing.length + 3);
		state.close();
	});

	/**
	 * The skip is not the fact leaving (issue #223 review). A cycle that asks a
	 * continuation asks no fresh work (ADR 0051), so the fresh-work walk never reads
	 * the row it waits behind. That row stood the whole cycle, and its hold states
	 * itself once - not once per skip.
	 */
	test("a cycle that skips the fresh-work walk does not state a standing row twice", async () => {
		const lines: RecordedLine[] = [];
		const r = rig({ autoOn: true, agents: [], log: recordLogger(lines) });
		// Two tickets with different titles, so a hold that names a row is told from
		// one that names another.
		r.state.sourceFact.applyFetch(
			source,
			success([
				{ ...fetched("github:github.com:I_6"), title: "Add a webhook retry policy" },
				fetched(),
			]),
		);
		// A row the operator staged stands from the first cycle to the last.
		queueRow(r.state, "github:github.com:I_6", "open", false);
		await r.coordinator.tick();
		const standing = [...lines];
		expect(standing).toEqual([
			infoLine("automatic walks hold: the Work queue holds a waiting row"),
		]);
		// A settled turn now owes a start, and the cycle asks it: the fresh-work walk
		// never runs, so it notes nothing this cycle.
		settleFor(r.state, "github:github.com:I_5", "route", routeOutcome("github:github.com:I_5"));
		await r.coordinator.tick();
		expect(r.intents.filter((intent) => intent.origin === "workflow")).toHaveLength(1);
		// The asked row now stands beside the operator's, so the next cycle reaches
		// the fresh-work walk again. The row it waits behind never left the queue,
		// so its line says nothing new; only the new standing continuation speaks.
		await r.coordinator.tick();
		expect(lines.slice(standing.length)).toEqual([
			infoLine(
				'automatic walks hold: the Work queue already holds a continuation ("Persist source facts")',
			),
		]);
		// And it stays silent from here on.
		await r.coordinator.tick();
		await r.coordinator.tick();
		expect(lines).toHaveLength(standing.length + 1);
		r.state.close();
	});

	/**
	 * The mode is the fact the operator sets by key, and the cycle reads it on every
	 * poll (issue #223 review). Moving it mid-run is how the operator's `a` moves it:
	 * the hold states itself for every move, and stays silent while the mode stands.
	 */
	test("a mode that moves mid-run states its hold again, and holds its silence between", async () => {
		const { state, lines, coordinator, setAutoMode } = recordRig();
		const modeHolds = () => lines.filter((line) => line.message.includes("auto-handoff is off"));
		// Auto-handoff on and nothing standing: the walks hold nothing, so the file
		// carries no mode hold line at all.
		await coordinator.tick();
		expect(modeHolds()).toEqual([]);
		setAutoMode(false);
		await coordinator.tick();
		expect(modeHolds()).toEqual([infoLine("automatic walks hold: auto-handoff is off")]);
		// The mode stands off across the next polls: one line for the fact, not one
		// per poll.
		await coordinator.tick();
		await coordinator.tick();
		expect(modeHolds()).toHaveLength(1);
		// The operator flips the mode back on, and back off: the fact left and came
		// back, so it states itself again.
		setAutoMode(true);
		await coordinator.tick();
		expect(modeHolds()).toHaveLength(1);
		setAutoMode(false);
		await coordinator.tick();
		expect(modeHolds()).toEqual([
			infoLine("automatic walks hold: auto-handoff is off"),
			infoLine("automatic walks hold: auto-handoff is off"),
		]);
		state.close();
	});

	test("a cycle that adds an item states no hold", async () => {
		// The walk took its one item, so nothing was held: the record carries the
		// ask's own line and no hold line.
		const { state, intents, lines, coordinator } = continuationRecordRig();
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "workflow")).toHaveLength(1);
		expect(lines).toEqual([]);
		state.close();
	});
});

describe("the fresh-work walk's per-candidate waits name their facts (issue #231)", () => {
	/** One cycle over the default feed, with its record lines read back. */
	function candidateRig(configOver: Partial<FactoryConfig> = {}) {
		const lines: RecordedLine[] = [];
		const r = rig({
			autoOn: true,
			agents: [],
			config: configOver,
			log: recordLogger(lines),
		});
		return { ...r, lines };
	}

	/** The two fetch rows the tests below re-read, with I_6's title of its own. */
	function bothTickets(): FetchedTicket[] {
		return [
			{ ...fetched("github:github.com:I_6"), title: "Add a webhook retry policy" },
			fetched(),
		];
	}

	/** Stand one row in the queue the way an operator's staging does. */
	function stageRow(state: FactoryState, identity: string): void {
		const enqueued = state.workQueue.enqueueWork({
			ticketIdentity: identity,
			routeFromIdentity: null,
			origin: "open",
			choice,
			previousMessage: "",
			automatic: false,
		});
		if (!enqueued.ok) throw new Error(enqueued.reason);
	}

	test("a fact the walk holds states once while it stands, and again when it changes", async () => {
		const { state, intents, lines, coordinator } = candidateRig();
		// The walk reads one candidate alone.
		state.sourceFact.applyFetch(source, success([fetched("github:github.com:I_6")]));
		// The candidate's last cycle completed the task its labels still suggest,
		// and the sources never re-read it since: the walk's first wait stands on
		// the re-read, and the Same-type hold the closed cycle stands on waits
		// behind it.
		const attempt = settleForCause(state, "github:github.com:I_6", {
			taskType: "implement",
			cause: "completed",
		});
		state.ticketWorkCycle.applyCompletionDecision({
			ticketIdentity: "github:github.com:I_6",
			handoffId: attempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
		});
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(lines).toEqual([
			infoLine(
				'automatic walks hold: the source has not re-read the Ticket since its last cycle ended ("Persist source facts")',
			),
		]);
		// The fact stands across the next polls: one line for the fact, not one
		// per poll.
		await coordinator.tick();
		expect(lines).toHaveLength(1);
		// The sources re-read the ticket and the labels stand put: the fact the
		// walk holds on moved to the Same-type hold, and a moved fact states
		// itself again.
		state.sourceFact.applyFetch(source, {
			status: "success",
			fetchedAt: "2026-08-31T11:02:00Z",
			tickets: [fetched("github:github.com:I_6")],
		});
		await coordinator.tick();
		expect(lines.slice(1)).toEqual([
			infoLine('automatic walks hold: the Same-type hold stands ("Persist source facts")'),
		]);
		await coordinator.tick();
		expect(lines).toHaveLength(2);
		state.close();
	});

	test("a candidate the walk stopped before keeps the fact its last line stated", async () => {
		const { state, lines, coordinator } = candidateRig();
		state.sourceFact.applyFetch(source, success(bothTickets()));
		// Both tickets close a cycle that completed the task their labels still
		// suggest, so both stand on the Same-type hold, and each re-read keeps
		// the hold standing clear of the re-read wait.
		for (const identity of ["github:github.com:I_5", "github:github.com:I_6"]) {
			const attempt = settleForCause(state, identity, {
				taskType: "implement",
				cause: "completed",
			});
			state.ticketWorkCycle.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId: attempt,
				decision: "closed",
				decidedAt: "2026-08-31T11:00:30Z",
			});
			state.sourceFact.applyFetch(source, {
				status: "success",
				fetchedAt: "2026-08-31T11:02:00Z",
				tickets: bothTickets(),
			});
		}
		// Each held candidate states its own fact, beside the Ticket's name.
		await coordinator.tick();
		expect(lines).toEqual([
			infoLine('automatic walks hold: the Same-type hold stands ("Persist source facts")'),
			infoLine('automatic walks hold: the Same-type hold stands ("Add a webhook retry policy")'),
		]);
		// The operator's row stands in the queue: the fresh-work walk stops at its
		// own gate and reads no candidate, so the two facts keep standing.
		stageRow(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(lines[2]).toEqual(infoLine("automatic walks hold: the Work queue holds a waiting row"));
		// The operator's row leaves, and the walk reads the candidates again: the
		// facts stand unchanged, so neither states itself - the skipped walk kept
		// them standing, the way a skipped walk's row does (issue #223 review).
		expect(state.workQueue.removeWorkItem("github:github.com:I_5")).toBe(true);
		await coordinator.tick();
		expect(lines).toHaveLength(3);
		state.close();
	});

	test("the restart candidate states the gate that holds it", async () => {
		const { state, intents, lines, coordinator, advance } = candidateRig();
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		// The restart walk reads the candidate before the open walk does, and the
		// open walk reads the ticket's own row: each states the fact it holds.
		expect(lines).toEqual([
			infoLine(
				'automatic walks hold: the Ticket\'s startup grace has not passed ("Persist source facts")',
			),
			infoLine('automatic walks hold: the row is not open ("Persist source facts")'),
		]);
		// The facts stand across polls: one line for each, not one per poll.
		await coordinator.tick();
		expect(lines).toHaveLength(2);
		// The grace passes and the restart gate answers nothing: the walk asks
		// the restart, and the fact leaves.
		advance(STARTUP_GRACE_MS + 1);
		await coordinator.tick();
		expect(intents.filter((intent) => intent.origin === "restart")).toHaveLength(1);
		expect(lines).toHaveLength(2);
		state.close();
	});

	test("the open walk states each row fact it holds on, and the brake states none", async () => {
		// The issues' states: a parking state offers no task, and a state that
		// offers the Operator-decides type is the brake's own (ADR 0117).
		const { state, intents, lines, coordinator } = candidateRig({
			workflowStates: [
				...config.workflowStates,
				{ name: "parked", match: { sourceKind: "github-issue", labelsAny: ["parked"] } },
				{
					name: "needs-operator",
					match: { sourceKind: "github-issue", labelsAny: ["needs-operator"] },
					taskType: "park",
				},
			],
		});
		state.sourceFact.applyFetch(
			source,
			success([
				{ ...fetched("github:github.com:I_5"), labels: ["parked"] },
				{
					...fetched("github:github.com:I_6"),
					labels: ["needs-operator"],
					title: "Add a webhook retry policy",
				},
				{ ...fetched("github:github.com:I_7"), title: "A third ticket" },
			]),
		);
		await coordinator.tick();
		// The parking row offers no task, and the walk states it: the ticket
		// rests, and only an external label write moves it (ADR 0027).
		expect(lines).toEqual([
			infoLine('automatic walks hold: the row offers no task ("Persist source facts")'),
		]);
		// The Operator-decides row holds the walk out with the designed silence:
		// the flag the operator set in their own config states no fact, and the
		// machine asks no start of the type.
		expect(
			intents.filter((intent) => intent.ticketIdentity === "github:github.com:I_6"),
		).toHaveLength(0);
		// The walk fell through the held rows to the one that stands, and asked it.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				automatic: true,
				ticketIdentity: "github:github.com:I_7",
			}),
		]);
		state.close();
	});
});
