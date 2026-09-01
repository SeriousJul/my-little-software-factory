import { describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import {
	type AgentReader,
	type HandoffIntent,
	type HerdrAgent,
	HerdrAgentReader,
	normalizeAgentStatus,
	ObservationCoordinator,
	stripAnsi,
} from "../src/observation.ts";
import type { RefreshClock } from "../src/refresh.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import { FakeRunner } from "./fake-runner.ts";

const source = { name: "issues", kind: "github-issues" };
const choice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
};

/**
 * The task types the awaiting rule reasons about:
 * - review auto-closes and has no route: it closes at any time.
 * - route auto-closes with one and only one edge: it routes while there is
 *   parallel room, and degrades to close at the handoff limit.
 * - split auto-closes with two edges: it is ambiguous, so it closes.
 * - implement and research never auto-close: they always wait for a human.
 */
const config: FactoryConfig = {
	...DEFAULT_CONFIG,
	taskTypes: {
		implement: { template: "implement", autoClose: false, thinking: "high" },
		review: { template: "review", autoClose: true },
		route: { template: "route", autoClose: true },
		split: { template: "split", autoClose: true },
		research: { template: "research", autoClose: false },
		polish: { template: "polish", autoClose: false },
	},
	workflows: [
		{ from: "implement", to: ["polish"] },
		{ from: "route", to: ["implement"] },
		{ from: "split", to: ["implement", "polish"] },
	],
	maxParallelAgents: 2,
	maxHandoffsPerTicket: 2,
};

function fetched(identity = "github:github.com:I_5"): FetchedTicket {
	return {
		identity,
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

function agent(paneId: string, status = "working"): HerdrAgent {
	return { paneId, tabId: "tab-1", workspaceId: "ws-1", agent: "factory-implement-I_5", status };
}

interface Rig {
	state: FactoryState;
	intents: HandoffIntent[];
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
	agents?: HerdrAgent[];
	readPane?: (paneId: string, lines: number) => Promise<string | null>;
}): Rig {
	let nowMs = Date.parse("2026-08-31T11:00:00Z");
	let agents = [...(options.agents ?? [])];
	// The state and the loop share the clock, so a handoff's age is
	// deterministic: advance() ages it.
	const state = openFactoryState(":memory:", () => nowMs);
	state.initializeSources([source]);
	state.applyFetch(source, success([fetched()]));
	const intents: HandoffIntent[] = [];
	const statuses: Rig["statuses"] = [];
	const cleanups: Rig["cleanups"] = [];
	const coordinator = new ObservationCoordinator({
		state,
		herdr: reader(() => agents, options.readPane),
		config: () => config,
		dispatch: async (intent) => {
			intents.push(intent);
			return { ok: true };
		},
		cleanup: async (handoff) => {
			cleanups.push({
				paneId: handoff.paneId,
				tabId: handoff.tabId,
				workspaceId: handoff.workspaceId,
			});
			return undefined;
		},
		now: () => nowMs,
		mode: () => options.autoOn ?? false,
		intervalMs: 60_000,
		onChanged: () => {},
		onStatus: (kind, text) => {
			statuses.push({ kind, text });
		},
	});
	return {
		state,
		intents,
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

/** Hand a ticket out and settle its turn, so it rests in awaiting. */
function settleFor(state: FactoryState, identity: string, taskType: string): string {
	const attempt = handOut(state, identity, taskType);
	state.settleTurn({
		ticketIdentity: identity,
		handoffId: attempt,
		taskType,
		agentType: "pi",
		message: "settled the turn",
		completedAt: "2026-08-31T11:00:00Z",
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
		runner.set("herdr", ["agent", "read", "pane-1", "--lines", "10", "--format", "text"], {
			stdout: JSON.stringify({ result: { output: lines.join("\n") } }),
		});
		const reader = new HerdrAgentReader(runner);
		const pane = await reader.readPane("pane-1", 10);
		expect(pane).toBe("first 0\nsecond 1\nthird 2");
		expect(runner.commands()).toEqual(["herdr agent read pane-1 --lines 10 --format text"]);
	});

	test("re-caps the output client side when herdr returns more lines", async () => {
		const runner = new FakeRunner();
		const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
		runner.set("herdr", ["agent", "read", "pane-1", "--lines", "4", "--format", "text"], {
			stdout: lines.join("\n"),
		});
		const reader = new HerdrAgentReader(runner);
		const pane = await reader.readPane("pane-1", 4);
		expect(pane).toBe("line 0\nline 1\nline 2\nline 3");
	});

	test("a failed read yields null", async () => {
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "read", "pane-1", "--lines", "1", "--format", "text"], {
			code: 1,
			stderr: "no such pane",
		});
		const reader = new HerdrAgentReader(runner);
		expect(await reader.readPane("pane-1", 1)).toBeNull();
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

	test("a running ticket settles on idle at once: the grace only guards a boot", async () => {
		const { state, coordinator, setAgents } = rig({
			agents: [agent("pane-implement", "working")],
		});
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(state.ticketsByState(["running"])).toHaveLength(1);
		// The turn ran, so the grace no longer applies: an idle agent
		// settles at once, without waiting.
		setAgents([agent("pane-implement", "idle")]);
		await coordinator.tick();
		expect(state.ticketsByState(["awaiting"])).toHaveLength(1);
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
			dispatch: vi.fn().mockResolvedValue({ ok: true }),
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

describe("missing agents", () => {
	test("auto mode restarts a missing agent once per episode, with the last message", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
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
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		const attempt = settleFor(state, identity, "implement");
		// The operator went to the agent: the ticket is in flight again on the
		// same pane, which then disappears from the herdr list.
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: attempt,
			decision: "goto",
			decidedAt: "2026-08-31T11:00:30Z",
		});
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

	test("a restart keeps the model and thinking the previous handoff ran with", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const claim = state.claimHandoff(
			"github:github.com:I_5",
			{ ...choice, model: "opus-4", thinking: "high" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-implement",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
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

	test("a missing agent at the handoff limit is abandoned, not restarted", async () => {
		const { state, intents, cleanups, coordinator } = rig({ autoOn: true, agents: [] });
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

	test("a restart waits while the parallel limit is full of live agents", async () => {
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
		// Two other in-flight tickets hold both parallel slots, and their
		// agents are live, so the slots really are in use.
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
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a missing agent does not hold a parallel slot", async () => {
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: [agent("pane-github:github.com:I_6", "working")],
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		// One in-flight ticket with a live agent holds one slot...
		const claim = state.claimHandoff("github:github.com:I_6", choice, "open");
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-github:github.com:I_6",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});
		// ...and the other in-flight ticket's agent is missing: it holds no slot.
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		// The missing ticket's restart fits under the limit of two.
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "restart",
				ticketIdentity: "github:github.com:I_5",
			}),
		]);
		state.close();
	});
});

describe("the awaiting rule", () => {
	test("an auto-close type with no route closes at any time, auto mode off included", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		settleFor(state, "github:github.com:I_5", "review");
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		expect(intents).toHaveLength(0);
		expect(coordinator.decideAwaiting("review", 0, 0)).toBe("close");
		state.close();
	});

	test("an auto-close type with multiple routes closes: the route is ambiguous", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		settleFor(state, "github:github.com:I_5", "split");
		expect(coordinator.decideAwaiting("split", 0, 0)).toBe("close");
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

	test("a fully determined route hands off while auto mode is on", async () => {
		const { state, intents, statuses, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "route");
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				ticketIdentity: "github:github.com:I_5",
				previousMessage: "settled the turn",
				choice: expect.objectContaining({ taskType: "implement", agentType: "pi" }),
			}),
		]);
		const [ticket] = state.visibleTickets([], "implement");
		// The decision is recorded on the trace before the handoff settles.
		expect(ticket.lastCompletion?.decision).toBe("auto-handed-off");
		expect(
			statuses.some((entry) => entry.text === "ticket github:github.com:I_5 routed to implement"),
		).toBe(true);
		state.close();
	});

	test("a route starts fresh: the workflow handoff never inherits the previous model or thinking", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
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
			completedAt: "2026-08-31T11:00:00Z",
		});
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				ticketIdentity: "github:github.com:I_5",
				previousMessage: "settled the turn",
				choice: {
					agentType: "pi",
					environment: "live-worktree",
					taskType: "implement",
					model: "",
					// The target task type's own default, not the inherited one.
					thinking: "high",
				},
			}),
		]);
		state.close();
	});

	test("a route degrades to close at the handoff limit", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		const identity = "github:github.com:I_5";
		const settleForAttempt = settleFor(state, identity, "route");
		// Use up the second handoff so the ticket sits at its limit: close the
		// first trace, hand it out again, and settle that second turn.
		state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: settleForAttempt,
			decision: "closed",
			decidedAt: "2026-08-31T11:00:30Z",
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
			completedAt: "2026-08-31T11:00:00Z",
		});
		expect(coordinator.decideAwaiting("route", 0, 2)).toBe("close");
		await coordinator.tick();
		const [ticket] = state.visibleTickets([], "implement");
		expect(ticket).toEqual(
			expect.objectContaining({
				state: "open",
				handoffCount: 2,
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("a route waits while the parallel limit is full of live agents", async () => {
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
		settleFor(state, "github:github.com:I_5", "route");
		// Both slots are held by live agents: the route waits, it does not close.
		expect(coordinator.decideAwaiting("route", 2, 0)).toBe("wait");
		await coordinator.tick();
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

	test("a type that never auto-closes waits for the operator, in both modes", async () => {
		for (const autoOn of [true, false]) {
			const { state, intents, coordinator } = rig({ autoOn, agents: [] });
			settleFor(state, "github:github.com:I_5", "research");
			expect(coordinator.decideAwaiting("research", 0, 0)).toBe("wait");
			await coordinator.tick();
			const [resting] = state.visibleTickets([], "implement");
			expect(resting).toEqual(expect.objectContaining({ state: "awaiting" }));
			expect(intents).toHaveLength(0);
			state.close();
		}
	});
});

describe("the open dispatch", () => {
	test("auto mode hands off every eligible open ticket under the limits", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		await coordinator.tick();
		// Three eligible tickets, a limit of two: only two are dispatched.
		expect(intents).toHaveLength(config.maxParallelAgents);
		expect(intents.map((intent) => intent.ticketIdentity).sort()).toEqual([
			"github:github.com:I_5",
			"github:github.com:I_6",
		]);
		for (const intent of intents) {
			expect(intent).toEqual(
				expect.objectContaining({
					origin: "open",
					previousMessage: "",
					choice: expect.objectContaining({
						agentType: DEFAULT_CONFIG.defaultAgent,
						environment: DEFAULT_CONFIG.defaultEnvironment,
						taskType: "implement",
					}),
				}),
			);
		}
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

	test("the live parallel count holds the dispatch", async () => {
		const ids = ["github:github.com:I_5", "github:github.com:I_6"];
		const { state, intents, coordinator } = rig({
			autoOn: true,
			agents: ids.map((identity) => agent(`pane-${identity}`, "working")),
		});
		state.applyFetch(source, success([fetched("github:github.com:I_6"), fetched()]));
		for (const identity of ids) {
			const claim = state.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: `pane-${identity}`,
				tabId: "tab-1",
				workspaceId: "ws-1",
			});
		}
		await coordinator.tick();
		expect(intents).toHaveLength(0);
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
			dispatch: async () => ({ ok: true }),
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
