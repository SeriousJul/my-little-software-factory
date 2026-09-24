/**
 * The control plane never moves herdr's view on its own (ADR 0061).
 *
 * An end-of-environment act is bookkeeping the operator cannot watch: the
 * Close cleanup of a finished cycle, a route's close of the previous
 * handoff's environment at the ask, that same close when it runs at the free
 * seat for an item that waited in the Work queue, and a Consultation close
 * that takes its workspace down. Each flow here runs through the real screens
 * at a fixed terminal size, and each reads the same fact off the injected
 * runner: herdr did the work the plane asked for, and the plane sent no
 * focus command with it.
 *
 * The one focus move the plane makes is Goto, the operator's own key, and
 * `test/herdr-view-architecture.test.ts` is the static half of the same rule.
 * No test here can reach a real herdr session, so none of them claims what a
 * window shows; the live walk is recorded in
 * `docs/verification/shared-controls.md`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config.ts";
import { baseChoice } from "../src/handoff.ts";
import { openFactoryState } from "../src/state.ts";
import {
	awaitFrame,
	frameText,
	messageRowOf,
	press,
	pressArrow,
	pressEnterQuiet,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import {
	agentListJson,
	FakeRunner,
	herdrFocusCommands,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import {
	issuesConfig,
	issueTicket,
	seedAwaitingTurn,
	seedInFlightTurn,
	success,
} from "./state-fixture.ts";

const FIRST = "github:github.com:I_5";
const SECOND = "github:github.com:I_6";

/** The settled turn's review position: the route the Decision screen offers. */
const reviewRoute = {
	fired: true,
	when: null,
	reason: "",
	ticketFacts: [],
	pullRequestFacts: [],
	autoAdvance: false,
	ticketWrite: null,
	pullRequestWrite: null,
	pullRequestIdentity: null,
	pullRequestKey: null,
	writeFailure: "",
	// The settled turn's position offers the ticket's own default task, so the
	// route asks for no placement write: the frames read the close, not the
	// label edit.
	positionTaskType: "implement",
	positionTicketIdentity: FIRST,
};

let home = "";
let checkout = "";

/** A terminal wide enough to hold one whole warning line at once. */
const WIDE_STATUS = 240;

beforeEach(() => {
	home = join(tmpdir(), `factory-herdr-view-${Math.random().toString(36).slice(2)}`);
	checkout = join(home, "src", "factory");
	mkdirSync(checkout, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** The two tickets the route frames walk: a settled one and a seat holder. */
function twoTickets() {
	return [
		issueTicket(FIRST),
		issueTicket(SECOND, {
			externalKey: "#6",
			url: "https://github.com/acme/factory/issues/6",
			title: "Close the stale deploy branch",
		}),
	];
}

/**
 * The worktree handoff of the settled turn, closed by the route's ask.
 *
 * The route of a worktree environment takes the herdr workspace down and
 * reopens the worktree in a fresh one, so the workspace close is the command
 * ADR 0061 is about: herdr moves its own focus when a workspace disappears,
 * and the plane used to follow it back. The handoff that follows reads the
 * branch the naming rule gives the ticket, and no worktree holds it here, so
 * the fresh workspace is the one `worktree open` attaches.
 */
function routeRunner(): FakeRunner {
	const runner = new FakeRunner();
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: "https://github.com/acme/factory.git\n",
	});
	runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
		stdout: "refs/remotes/origin/main\n",
	});
	// The close took the workspace: herdr lists none at the checkout, so the
	// handoff that follows builds its own fresh environment, and every create
	// it asks for states its no-focus default (ADR 0061).
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson("ws-route", "pane-root"),
	});
	runner.set(
		"herdr",
		["tab", "create", "--workspace", "ws-route", "--cwd", checkout, "--no-focus"],
		{ stdout: tabCreateJson("pane-route", "tab-route") },
	);
	runner.set("herdr", ["agent", "start", "add-a-webhook-retry-policy", "--kind", "pi"], {
		stdout: JSON.stringify({ result: { agent: { session_id: "sess-route" } } }),
	});
	return runner;
}

/** The config the route frames boot on: one seat, no source clock. */
function routeConfig(): FactoryConfig {
	return { ...issuesConfig, repos: { "github.com/acme/factory": checkout } };
}

describe("the route close moves no view", () => {
	test("the Decision screen's route closes the settled workspace and sends no focus", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const outcome = success([issueTicket(FIRST)]);
		seedAwaitingTurn(state, outcome, FIRST, reviewRoute, "worktree");
		const runner = routeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const source = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("[awaiting]"), "the awaiting ticket");
					await press(setup, "return", "the decision modal", (f) => f.includes("Decision:"));
					await pressArrow(setup, "down", "the Goto row", (f) => frameText(f).includes("❯ Goto"));
					await pressArrow(setup, "down", "the route row", (f) =>
						frameText(f).includes("❯ Handoff: implement"),
					);
					// The routed handoff started beside the workspace the ask took
					// down; the egress list is the fact the rule reads.
					await pressEnterQuiet(setup, "the routed handoff to start", () =>
						runner.commands().some((c) => c.startsWith("herdr agent prompt")),
					);
					const commands = runner.commands();
					// The ask takes the settled turn's workspace down, and the
					// handoff builds its own beside it: the route ran.
					expect(commands).toContain("herdr workspace close ws-1");
					expect(commands.indexOf("herdr workspace close ws-1")).toBeLessThan(
						commands.indexOf("herdr workspace list"),
					);
					// The handoff that follows built its own fresh environment.
					expect(commands).toContain(`herdr workspace create --cwd ${checkout} --no-focus`);
					// And the plane asked herdr for no focus anywhere in it
					// (ADR 0061): the operator's view never moved.
					expect(herdrFocusCommands(commands)).toEqual([]);
				},
				WIDTH,
				34,
				{ state, config: routeConfig(), home, runner, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("a route that waited in the Work queue closes at the seat with no focus", async () => {
		// The worst case has no keypress beside it: the close runs when a seat
		// frees, so the view must be untouchable at that moment.
		const state = openFactoryState(join(home, "state.sqlite"), () => Date.now() - 600_000);
		const outcome = success(twoTickets());
		seedAwaitingTurn(state, outcome, FIRST, reviewRoute, "worktree");
		// The second ticket holds the factory's one seat with a live agent. Its
		// handoff is aged past the Startup grace, so the seat is the agent's own:
		// when herdr stops listing it, the seat frees and the queue drains.
		const held = state.claimHandoff(
			SECOND,
			{ ...baseChoice("pi", "live-worktree", "implement") },
			"open",
		);
		if (!held.ok) throw new Error(held.reason);
		state.settleHandoff(held.claim.attemptId, true, undefined, {
			paneId: "pane-9",
			tabId: "tab-9",
			workspaceId: "ws-9",
		});
		const runner = routeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-9",
					agent: "close-the-stale-deploy-branch",
					status: "working",
				},
			]),
		});
		const source = new FakeSource("issues", "github-issues", outcome);
		const config: FactoryConfig = {
			...routeConfig(),
			maxParallelAgents: 1,
			agentPollIntervalSeconds: 60,
		};
		try {
			await withApp(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("[awaiting]"), "the awaiting ticket");
					await press(setup, "return", "the decision modal", (f) => f.includes("Decision:"));
					await pressArrow(setup, "down", "the Goto row", (f) => frameText(f).includes("❯ Goto"));
					await pressArrow(setup, "down", "the route row", (f) =>
						frameText(f).includes("❯ Handoff: implement"),
					);
					// The route cannot take a seat: it waits in the Work queue,
					// and nothing has closed yet.
					await press(setup, "return", "the route to wait", (f) =>
						frameText(f).includes("is in the Work queue"),
					);
					// The close is the ask's own act, queued as cleanup work, so it
					// runs while nothing starts (ADR 0046).
					const waiting = await awaitFrame(
						setup,
						() => runner.commands().includes("herdr workspace close ws-1"),
						"the queued route's close at the ask",
					);
					let commands = runner.commands();
					expect(commands).toContain("herdr workspace close ws-1");
					expect(commands.filter((c) => c.startsWith("herdr agent start"))).toEqual([]);
					expect(herdrFocusCommands(commands)).toEqual([]);
					// The Message line carries the queue's notice, not a focus move.
					expect(messageRowOf(waiting)).not.toContain("focus");
					// The holder's Agent leaves herdr: the seat frees, the pickup
					// takes the item up, and the close with no keypress beside it
					// still moves nothing.
					runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
					await awaitFrame(
						setup,
						() => runner.commands().some((c) => c.startsWith("herdr agent prompt")),
						"the freed seat to take the queued route up",
					);
					commands = runner.commands();
					expect(commands).toContain(`herdr workspace create --cwd ${checkout} --no-focus`);
					expect(herdrFocusCommands(commands)).toEqual([]);
				},
				WIDTH,
				34,
				{ state, config, home, runner, sources: [source], pollIntervalMs: 100 },
			);
		} finally {
			state.close();
		}
	});
});

describe("the Close cleanup moves no view", () => {
	test("the Close action on a worktree cycle removes the checkout and sends no focus", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		const outcome = success([issueTicket(FIRST)]);
		seedInFlightTurn(state, outcome, FIRST, "worktree");
		const runner = new FakeRunner();
		// No Agent in the recorded pane: the close is the way out of the cycle,
		// and the cleanup is the work ADR 0061 is about.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const source = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("missing"), "the in-flight ticket");
					await press(setup, "w", "the Close confirmation", (f) =>
						f.includes("Close: Add a webhook retry policy"),
					);
					const frame = await press(setup, "return", "the close to end the cycle", (f) =>
						f.includes("[open]"),
					);
					const commands = runner.commands();
					expect(commands).toContain("herdr worktree remove --workspace ws-1");
					expect(herdrFocusCommands(commands)).toEqual([]);
					// The bookkeeping the operator cannot see still reports: the
					// Message line names the closed ticket.
					expect(messageRowOf(frame)).toContain("closed");
				},
				WIDTH,
				34,
				{ state, config: routeConfig(), home, runner, sources: [source] },
			);
		} finally {
			state.close();
		}
	});

	test("a herdr refusal of the close reports on the line and records the leftover", async () => {
		// Dropping the focus call costs no bookkeeping (story 9): a refusal is
		// still one line on the Message line and a surviving environment on the
		// ticket's facts.
		const state = openFactoryState(join(home, "state.sqlite"));
		const outcome = success([issueTicket(FIRST)]);
		seedInFlightTurn(state, outcome, FIRST, "worktree");
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr:
				'{"error":{"code":"dirty_worktree_requires_force","message":"fatal: the worktree contains modified or untracked files, use --force to delete it"},"id":"cli:worktree:remove"}\n',
		});
		const source = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("missing"), "the in-flight ticket");
					await press(setup, "w", "the Close confirmation", (f) =>
						f.includes("Close: Add a webhook retry policy"),
					);
					await press(setup, "return", "the close to run", (f) => f.includes("[open]"));
					expect(state.ticketState(FIRST)).toBe("open");
					// The refusal line names the failure and herdr's own reason, so
					// the read takes the wide terminal the status row truncates to.
					const frame = await awaitFrame(
						setup,
						(f) => messageRowOf(f).includes("the close cleanup failed"),
						"the refusal on the Message line",
					);
					expect(messageRowOf(frame)).toContain("dirty_worktree_requires_force");
					expect(frame).toContain("leftover");
					expect(state.leftoverEnvironment(FIRST)).toEqual(
						expect.objectContaining({
							workspaceId: "ws-1",
							reason: expect.stringContaining("dirty_worktree_requires_force"),
						}),
					);
					expect(herdrFocusCommands(runner.commands())).toEqual([]);
				},
				WIDE_STATUS,
				34,
				{ state, config: routeConfig(), home, runner, sources: [source] },
			);
		} finally {
			state.close();
		}
	});
});

describe("Goto stays the one focus move", () => {
	test("`g` on a settled ticket asks herdr for the Agent's pane and nothing else moves", async () => {
		// The exception to the rule runs at the operator's key (ADR 0033,
		// ADR 0061): the Goto is the plane's only focus command, and its
		// confirmation still names the workspace it moved the view into.
		const state = openFactoryState(join(home, "state.sqlite"));
		const outcome = success([issueTicket(FIRST)]);
		seedAwaitingTurn(state, outcome, FIRST, null, "worktree");
		const runner = new FakeRunner();
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "pi",
					status: "idle",
					name: "add-a-webhook-retry-policy",
				},
			]),
		});
		runner.set("herdr", ["workspace", "get", "ws-1"], {
			stdout: JSON.stringify({
				result: {
					type: "workspace_info",
					workspace: { focused: false, label: "retry", workspace_id: "ws-1" },
				},
			}),
		});
		const source = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("[awaiting]"), "the awaiting ticket");
					const frame = await press(setup, "g", "the Goto confirmation", (f) =>
						messageRowOf(f).includes("focused the agent"),
					);
					const commands = runner.commands();
					expect(commands).toContain("herdr agent focus pane-1");
					// The one allowed move is an Agent focus: never a workspace
					// focus, and no second move to compensate for anything.
					expect(herdrFocusCommands(commands)).toEqual(["herdr agent focus pane-1"]);
					// The confirmation names the workspace it landed in (story 8).
					expect(messageRowOf(frame)).toContain("in workspace retry");
				},
				WIDTH,
				34,
				{ state, config: routeConfig(), home, runner, sources: [source] },
			);
		} finally {
			state.close();
		}
	});
});

describe("the environment a handoff builds stays out of the view", () => {
	test("a handoff builds its environment asking for no focus, and moves none", async () => {
		// herdr's changelog records the create-focus default regressing once
		// (#3766, v0.9.1), so the flag is a contract, not noise (story 13).
		const state = openFactoryState(join(home, "state.sqlite"));
		const outcome = success([issueTicket(SECOND)]);
		const runner = new FakeRunner();
		runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
			stdout: "https://github.com/acme/factory.git\n",
		});
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
			stdout: JSON.stringify({
				result: {
					workspace: { workspace_id: "ws-build" },
					tab: { tab_id: "tab-build" },
					root_pane: { pane_id: "pane-build" },
				},
			}),
		});
		runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-build", "--cwd", checkout, "--no-focus"],
			{ stdout: tabCreateJson("pane-agent", "tab-agent") },
		);
		runner.set("herdr", ["agent", "start", "close-the-stale-deploy-branch", "--kind", "pi"], {
			stdout: JSON.stringify({ result: { agent: { session_id: "sess-build" } } }),
		});
		const source = new FakeSource("issues", "github-issues", outcome);
		try {
			await withApp(
				async (setup) => {
					source.settle(outcome);
					await awaitFrame(setup, (f) => f.includes("[open]"), "the open ticket");
					// Enter hands the row under the cursor off with the defaults.
					await pressEnterQuiet(setup, "the handoff to run", () =>
						runner.commands().some((c) => c.startsWith("herdr agent prompt")),
					);
					const commands = runner.commands();
					// The build created its workspace and its tab asking for no
					// focus, and sent no focus command afterwards (story 11).
					expect(commands).toContain(`herdr workspace create --cwd ${checkout} --no-focus`);
					expect(commands).toContain(
						`herdr tab create --workspace ws-build --cwd ${checkout} --no-focus`,
					);
					expect(herdrFocusCommands(commands)).toEqual([]);
					// No create reached herdr without its flag: the contract stands.
					for (const create of commands.filter((c) => / (create|open) /u.test(c)))
						expect(create).toContain("--no-focus");
				},
				WIDTH,
				34,
				{ state, config: routeConfig(), home, runner, sources: [source] },
			);
		} finally {
			state.close();
		}
	});
});
