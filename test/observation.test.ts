import { describe, expect, test, vi } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import {
	type AgentReader,
	type HandoffIntent,
	type HerdrAgent,
	normalizeAgentStatus,
	ObservationCoordinator,
	stripAnsi,
} from "../src/observation.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";

const source = { name: "issues", kind: "github-issues" };
const choice = {
	agentType: "pi",
	environment: "worktree" as const,
	taskType: "implement",
	model: "",
	thinking: "",
};

/**
 * The task types the awaiting rule reasons about: implement hands off to
 * review by its one and only edge, review auto-closes at any time, and
 * research has no route at all.
 */
const config: FactoryConfig = {
	...DEFAULT_CONFIG,
	taskTypes: {
		implement: { template: "implement", autoClose: false },
		review: { template: "review", autoClose: true },
		research: { template: "research", autoClose: false },
		polish: { template: "polish", autoClose: false },
	},
	workflows: [{ from: "implement", to: ["polish"] }],
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

function reader(agents: HerdrAgent[]): AgentReader {
	return {
		listAgents: async () => ({ kind: "ok", agents }),
		// The AgentReader contract: pane output comes back ANSI stripped.
		readPane: async (paneId) => stripAnsi(`\u001b[1mDone.\u001b[0m message of ${paneId}`),
	};
}

function agent(paneId: string, status = "working"): HerdrAgent {
	return { paneId, tabId: "tab-1", workspaceId: "ws-1", agent: "factory-implement-I_5", status };
}

interface Rig {
	state: FactoryState;
	intents: HandoffIntent[];
	statuses: Array<{ kind: "info" | "warning" | "error"; text: string }>;
	coordinator: ObservationCoordinator;
}

function rig(options: { autoOn?: boolean; agents?: HerdrAgent[] }): Rig {
	const state = openFactoryState(":memory:");
	state.initializeSources([source]);
	state.applyFetch(source, success([fetched()]));
	const intents: HandoffIntent[] = [];
	const statuses: Rig["statuses"] = [];
	const coordinator = new ObservationCoordinator({
		state,
		herdr: reader(options.agents ?? []),
		config,
		dispatch: async (intent) => {
			intents.push(intent);
		},
		now: () => Date.parse("2026-08-31T11:00:00Z"),
		mode: () => options.autoOn ?? false,
		intervalMs: 60_000,
		onChanged: () => {},
		onStatus: (kind, text) => {
			statuses.push({ kind, text });
		},
	});
	return { state, intents, statuses, coordinator };
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
function settleFor(state: FactoryState, identity: string, taskType: string): void {
	const attempt = handOut(state, identity, taskType);
	state.settleTurn({
		ticketIdentity: identity,
		handoffId: attempt,
		taskType,
		agentType: "pi",
		agentName: "factory-implement-I_5",
		message: "settled the turn",
		completedAt: "2026-08-31T11:00:00Z",
	});
}

describe("normalizeAgentStatus", () => {
	test("maps the herdr vocabulary and falls back to unknown", () => {
		expect(normalizeAgentStatus("working")).toBe("working");
		expect(normalizeAgentStatus("Done")).toBe("done");
		expect(normalizeAgentStatus("complete")).toBe("done");
		expect(normalizeAgentStatus("idle")).toBe("idle");
		expect(normalizeAgentStatus("blocked")).toBe("blocked");
		expect(normalizeAgentStatus("failed")).toBe("error");
		expect(normalizeAgentStatus("meditating")).toBe("unknown");
	});
});

describe("stripAnsi", () => {
	test("removes escape sequences and control characters", () => {
		expect(stripAnsi("\u001b[1mbold\u001b[0m plain\u0007")).toBe("bold plain");
		expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
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
		done.state.markTicketRunning("github:github.com:I_5");
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

	test("an idle or unknown agent neither runs nor settles", async () => {
		for (const status of ["idle", "meditating"]) {
			const { state, coordinator } = rig({ agents: [agent("pane-implement", status)] });
			handOut(state, "github:github.com:I_5");
			await coordinator.tick();
			expect(state.ticketsByState(["handed-off"])).toEqual([
				expect.objectContaining({ ticketIdentity: "github:github.com:I_5" }),
			]);
			state.close();
		}
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
			config,
			dispatch: vi.fn(),
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

	test("manual mode leaves a missing agent for the operator's panel", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		handOut(state, "github:github.com:I_5");
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		expect(state.ticketsByState(["handed-off"])).toHaveLength(1);
		state.close();
	});

	test("a missing agent at the handoff limit is abandoned, not restarted", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
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
		// No restart: the ticket is abandoned, and the auto mode may hand the
		// now-open ticket out again.
		expect(intents.every((intent) => intent.origin !== "restart")).toBe(true);
		const [ticket] = state.visibleTickets([], "implement");
		// Back to open, at its handoff limit, never restarted.
		expect(ticket).toEqual(expect.objectContaining({ state: "open", handoffCount: 2 }));
		state.close();
	});

	test("a restart waits while the parallel limit is full", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		// Two other in-flight tickets hold both parallel slots.
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
});

describe("the awaiting rule", () => {
	test("an auto-close type closes at any time, auto mode off included", async () => {
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
		expect(coordinator.decideAwaiting("review", false)).toBe("close");
		state.close();
	});

	test("a fully determined route hands off while auto mode is on", async () => {
		const { state, intents, statuses, coordinator } = rig({ autoOn: true, agents: [] });
		settleFor(state, "github:github.com:I_5", "implement");
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "workflow",
				ticketIdentity: "github:github.com:I_5",
				previousMessage: "settled the turn",
				choice: expect.objectContaining({ taskType: "polish", agentType: "pi" }),
			}),
		]);
		const [ticket] = state.visibleTickets([], "implement");
		// The decision is recorded on the trace before the handoff settles.
		expect(ticket.lastCompletion?.decision).toBe("auto-handed-off");
		expect(
			statuses.some((entry) => entry.text === "ticket github:github.com:I_5 routed to polish"),
		).toBe(true);
		state.close();
	});

	test("a route waits while auto mode is off or the parallel limit is full", async () => {
		// Auto off: the ticket rests for a human.
		const off = rig({ autoOn: false, agents: [] });
		settleFor(off.state, "github:github.com:I_5", "implement");
		expect(off.coordinator.decideAwaiting("implement", false)).toBe("wait");
		off.state.close();

		// Limit full: a route waits rather than closes, even with auto on.
		const full = rig({ autoOn: true, agents: [] });
		full.state.applyFetch(
			source,
			success([fetched("github:github.com:I_6"), fetched("github:github.com:I_7"), fetched()]),
		);
		for (const identity of ["github:github.com:I_6", "github:github.com:I_7"]) {
			const claim = full.state.claimHandoff(identity, choice, "open");
			if (!claim.ok) throw new Error(claim.reason);
			full.state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: `pane-${identity}`,
				tabId: "tab-2",
				workspaceId: "ws-2",
			});
		}
		settleFor(full.state, "github:github.com:I_5", "implement");
		expect(full.coordinator.decideAwaiting("implement", true)).toBe("wait");
		full.state.close();
	});

	test("a type with no route closes with auto on and waits with auto off", async () => {
		const on = rig({ autoOn: true, agents: [] });
		settleFor(on.state, "github:github.com:I_5", "research");
		expect(on.coordinator.decideAwaiting("research", true)).toBe("close");
		await on.coordinator.tick();
		const [closed] = on.state.visibleTickets([], "implement");
		expect(closed).toEqual(
			expect.objectContaining({
				state: "open",
				lastCompletion: expect.objectContaining({ decision: "auto-closed" }),
			}),
		);
		on.state.close();

		const off = rig({ autoOn: false, agents: [] });
		settleFor(off.state, "github:github.com:I_5", "research");
		expect(off.coordinator.decideAwaiting("research", false)).toBe("wait");
		await off.coordinator.tick();
		const [resting] = off.state.visibleTickets([], "implement");
		expect(resting).toEqual(expect.objectContaining({ state: "awaiting" }));
		expect(off.intents).toHaveLength(0);
		off.state.close();
	});
});

describe("the open dispatch", () => {
	test("auto mode hands off the first actionable open ticket under the limit", async () => {
		const { state, intents, coordinator } = rig({ autoOn: true, agents: [] });
		await coordinator.tick();
		expect(intents).toEqual([
			expect.objectContaining({
				origin: "open",
				ticketIdentity: "github:github.com:I_5",
				previousMessage: "",
				choice: expect.objectContaining({
					agentType: DEFAULT_CONFIG.defaultAgent,
					environment: DEFAULT_CONFIG.defaultEnvironment,
					taskType: "implement",
				}),
			}),
		]);
		state.close();
	});

	test("manual mode never dispatches open tickets", async () => {
		const { state, intents, coordinator } = rig({ autoOn: false, agents: [] });
		await coordinator.tick();
		expect(intents).toHaveLength(0);
		state.close();
	});

	test("the parallel limit holds the dispatch", async () => {
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
