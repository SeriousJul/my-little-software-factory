/**
 * The unattended mode through the real UI: the mode line, the session-only
 * `a` toggle, the blocked and missing markers, the missing
 * panel (restart / abandon), the decision modal on an awaiting ticket, and
 * the auto dispatch of open tickets.
 *
 * Every test boots the real app with a real SQLite state seeded through the
 * state API, a fake ticket source, a fake command runner, and a pinned
 * poll interval, so the observation loop and the handoff pipeline run
 * without a herdr session or a source clock.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// readFileSync is the session-only check: the toggle must not write it.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppProps } from "../src/components/app.ts";
import { COLORS } from "../src/components/theme.ts";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { CommandRunner } from "../src/runner.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import type { TurnLogEntry } from "../src/turn-log.ts";
import {
	type AppSetup,
	awaitFrame,
	detailPaneText,
	frameText,
	HEIGHT,
	markerRowOf,
	press,
	pressArrow,
	pressScrollKey,
	rgb,
	rowsOf,
	settle,
	sleep,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import {
	agentListJson,
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const source = { name: "issues", kind: "github-issues" };
const identity = "github:github.com:I_5";
const secondIdentity = "github:github.com:I_6";
const repoIdentity = "github.com/acme/factory";
/**
 * A terminal wide enough to hold a whole status line at once.
 *
 * The status row is one line, truncated to the terminal width, so a test
 * that reads two facts off it (a failure and the warning that came with it)
 * needs the room for both.
 */
const WIDE_STATUS = 240;
/**
 * A terminal too narrow for the panel's own content width.
 *
 * The leftover panel caps a reason line at 60 cells on a wide terminal; this
 * is where the panel has to cut earlier, at the width it really renders at.
 */
const NARROW = 40;

/** A fetched ticket of the issues source; the index is the issue number. */
function fetched(index = 5, title = "Persist source facts"): FetchedTicket {
	return {
		identity: `github:github.com:I_${index}`,
		sourceKind: "github-issue",
		externalKey: `#${index}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${index}`,
		title,
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

const success: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [fetched()],
};

/** Two open tickets of the same repository: a queue the dispatch can form. */
const pairSuccess: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [fetched(5, "Persist source facts"), fetched(6, "Watch agent turns")],
};

/** A checkout directory the config maps the ticket's repository to. */
function checkout(): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-auto-checkout-"));
	paths.push(dir);
	return dir;
}

/** Stub the git answers for the checkout the config maps to. */
function stubCheckout(app: SeededApp): void {
	const path = Object.values(app.config.repos)[0];
	app.runner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	app.runner.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: `https://${repoIdentity}.git\n`,
	});
}

/**
 * A state with the ticket in the given shape: open, in flight with the
 * stored herdr handles, or awaiting with a settled completion. The stored
 * handoff takes the given environment kind.
 */
function seed(
	shape: "open" | "in-flight" | "awaiting",
	outcome: FetchOutcome = success,
	environment: "live-worktree" | "worktree" = "live-worktree",
	message = "The turn is done.",
	model = "",
	thinking = "",
	turnLog: TurnLogEntry[] | undefined = undefined,
): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-auto-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.initializeSources([source]);
	state.applyFetch(source, outcome);
	if (shape !== "open") {
		const claim = state.claimHandoff(
			identity,
			{
				agentType: "pi",
				environment,
				taskType: "implement",
				model,
				thinking,
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		if (shape === "awaiting") {
			state.settleTurn({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message,
				turnLog: turnLog ?? [{ kind: "text", text: message }],
				completedAt: "2026-08-31T11:00:00Z",
			});
		}
	}
	return state;
}

interface SeededApp {
	state: FactoryState;
	config: FactoryConfig;
	runner: FakeRunner;
	configPath: string;
	src: FakeSource;
}

/** A seeded state plus the app props that match it: config, runner, source. */
function seededApp(
	shape: "open" | "in-flight" | "awaiting",
	extra: Partial<FactoryConfig> = {},
	outcome: FetchOutcome = success,
	environment: "live-worktree" | "worktree" = "live-worktree",
	message = "The turn is done.",
	model = "",
	thinking = "",
	turnLog: TurnLogEntry[] | undefined = undefined,
): SeededApp {
	const state = seed(shape, outcome, environment, message, model, thinking, turnLog);
	const path = checkout();
	const home = mkdtempSync(join(tmpdir(), "factory-auto-home-"));
	paths.push(home);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
	const config: FactoryConfig = {
		...DEFAULT_CONFIG,
		repos: { [repoIdentity]: path },
		workflows: [{ from: "implement", to: ["review"] }],
		...extra,
	};
	const runner = new FakeRunner();
	const src = new FakeSource("issues", "github-issues", outcome);
	return { state, config, runner, configPath, src };
}

/**
 * A runner that passes through to a fake runner while holding one command
 * for a fixed time. A frame test uses it to hold the handoff seat: the
 * in-flight handoff keeps the queue blocked while the operator works the
 * ticket behind it, so the drain runs while that ticket is still moving.
 */
function holding(runner: FakeRunner, command: string, ms: number): CommandRunner {
	return {
		run: async (name, args, options) => {
			if ([name, ...args].join(" ").trim() === command) {
				await new Promise((resolve) => setTimeout(resolve, ms));
			}
			return runner.run(name, args, options);
		},
	};
}

function propsOf(app: SeededApp): AppProps {
	return {
		config: app.config,
		state: app.state,
		runner: app.runner,
		configPath: app.configPath,
		sources: [app.src],
		pollIntervalMs: 60_000,
	};
}

/** Enter through the real key path, then wait for its effect. */
async function pressReturn(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEnter();
	return await awaitFrame(setup, predicate, what);
}

/** Escape through the real key path, then wait for its effect. */
async function pressEscape(
	setup: AppSetup,
	what: string,
	predicate: (frame: string) => boolean,
): Promise<string> {
	setup.mockInput.pressEscape();
	return await awaitFrame(setup, predicate, what);
}

/** The ticket's list row, by its title. */
function ticketRow(frame: string, title = "Persist source facts"): string {
	const rows = rowsOf(frame);
	const row = rows.find((line) => line.includes(title));
	if (row === undefined) throw new Error(`no ticket row for ${title} in frame:\n${frame}`);
	return row;
}

describe("the mode line and the a key", () => {
	test("the mode line reports the mode and the in-flight count, and a toggles the session only", async () => {
		const app = seededApp("open");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const before = readFileSync(app.configPath, "utf8");

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("auto: off 0/2"), "the mode line");
				await press(setup, "a", "auto on", (f) => f.includes("auto: on 0/2"));
				// Session-only: the toggle never writes the config file.
				expect(readFileSync(app.configPath, "utf8")).toBe(before);
				await press(setup, "a", "auto off", (f) => f.includes("auto: off 0/2"));
				expect(readFileSync(app.configPath, "utf8")).toBe(before);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("an unlimited parallel limit shows the bare count on the mode line", async () => {
		const app = seededApp("in-flight", { maxParallelAgents: 0 });
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "blocked",
				},
			]),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("auto: off 1"),
					"the unlimited mode line",
				);
				// The count stands without a limit after it: no `/0` anywhere.
				expect(frame).toContain("auto: off 1");
				expect(frame).not.toContain("/0");
				// The blocked agent still holds its seat, with no limit to hold it to.
				expect(ticketRow(frame)).toContain("blocked");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the failure markers", () => {
	test("a blocked agent marks its running ticket", async () => {
		const app = seededApp("in-flight");
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "blocked",
				},
			]),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("blocked"),
					"the blocked badge",
				);
				// The agent is alive but not working: the state badge is replaced by the
				// blocked badge, and the live agent count still holds its slot.
				expect(ticketRow(frame)).toContain("blocked");
				expect(frame).toContain("auto: off 1/2");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a missing agent gets the missing marker and the missing modal", async () => {
		const app = seededApp("in-flight");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("missing"),
					"the missing badge",
				);
				// The missing badge replaces the state badge although no state changed:
				// manual mode never acts on a missing agent. The missing agent holds no
				// slot, so the live count is zero.
				expect(frame).toContain("auto: off 0/2");
				expect(ticketRow(frame)).toContain("missing");

				// Enter on the in-flight missing ticket opens the missing modal.
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Restart");
				expect(panel).toContain("Abandon");

				// Abandon is the last action: one down, confirm.
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
				// The open ticket keeps no failure badge.
				expect(ticketRow(await settle(setup))).not.toContain("missing");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("enter on a blocked ticket focuses the agent's pane", async () => {
		const app = seededApp("in-flight");
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "blocked",
				},
			]),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("blocked"), "the blocked badge");
				// Enter on the blocked ticket runs the Goto: it focuses the stored pane.
				await pressReturn(setup, "the focus", (f) => f.includes("focused the agent"));
				expect(app.runner.commands()).toContain("herdr agent focus pane-1");
				// The focus does not settle the turn: the ticket stays in flight,
				// and the blocked badge stands until the next poll.
				expect(app.state.ticketState(identity)).toBe("handed-off");
				expect(ticketRow(await settle(setup))).toContain("blocked");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("esc on the missing modal closes it and leaves the ticket in flight", async () => {
		const app = seededApp("in-flight");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				// The panel key handler subscribes in an effect that flushes after
				// the commit; a settled frame proves the panel is open and ready.
				await settle(setup);
				// Esc cancels: nothing runs, no decision lands.
				await pressEscape(setup, "the panel to close", (f) => !f.includes("Missing:"));
				// The ticket is still in flight with its missing agent.
				expect(app.state.ticketState(identity)).toBe("handed-off");
				expect(ticketRow(await settle(setup))).toContain("missing");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a ticket at the handoff limit wears the trailing marker on its row", async () => {
		const app = seededApp("in-flight", { maxHandoffsPerTicket: 1 });
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("handoff limit"),
					"the handoff limit marker",
				);
				// The marker rides at the end of the list row. The terminal row
				// also carries the detail pane, so check only the list half.
				const row = frameText(ticketRow(frame).slice(0, Math.floor(WIDTH / 2))).trimEnd();
				expect(row.endsWith("handoff limit")).toBe(true);
				// The limit does not unhand the ticket: it stays in flight, and its
				// missing agent still stands out in the badge's place.
				expect(row).toContain("missing");
				expect(app.state.ticketState(identity)).toBe("handed-off");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the detail pane", () => {
	test("shows the handoff count and the last completion of the ticket", async () => {
		const app = seededApp("awaiting");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[awaiting]"),
					"the awaiting ticket",
				);
				// The detail pane shows the selected ticket, which is the awaiting
				// one: first in the attention order.
				const detail = detailPaneText(frame);
				// The handoff count is the ticket's handoffs against its limit.
				expect(detail).toContain("Handoffs: 1/10");
				// The last completion: date, task type, agent, decision, message.
				expect(detail).toContain(
					"Last completion: 2026-08-31 11:00 implement by persist-source-facts (pi) pending",
				);
				expect(detail).toContain("The turn is done.");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the decision modal", () => {
	test("enter on an awaiting ticket shows the completion and routes on confirm", async () => {
		const review = { ...DEFAULT_CONFIG.taskTypes.review };
		review.template += "\n\nPrevious work message:\n{previous-message}";
		const app = seededApp("awaiting", {
			taskTypes: { ...DEFAULT_CONFIG.taskTypes, review },
		});
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		// The stored workspace still holds: the route reuses it in a new tab.
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			// A fresh tab, distinct from the settled agent's tab-1.
			stdout: tabCreateJson("pane-9", "tab-9"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("The turn is done.");
				expect(panel).toContain("Handoff: review");
				expect(panel).toContain("Goto");
				expect(panel).toContain("Close");

				// Close is the default; the workflow handoff is the last row: down twice.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				// The prompt carried the last captured message, and the
				// settled agent's tab was closed once the new agent started.
				const commands = app.runner.commands();
				const prompt = commands.find((c) => c.startsWith("herdr agent prompt"));
				expect(prompt?.includes("The turn is done.")).toBe(true);
				expect(commands.at(-1)).toBe("herdr tab close tab-1");
				// The route's decision landed on the settled turn's trace when
				// the routed handoff started, not at the claim.
				expect(app.state.lastCompletion(identity)?.decision).toBe("handed-off");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a manual workflow route starts with fresh model and target thinking", async () => {
		const app = seededApp(
			"awaiting",
			{
				taskTypes: {
					...DEFAULT_CONFIG.taskTypes,
					review: { ...DEFAULT_CONFIG.taskTypes.review, thinking: "low" },
				},
			},
			success,
			"live-worktree",
			"The turn is done.",
			"opus-4",
			"high",
		);
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision panel", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain("--kind pi --pane pane-9 -- --thinking low");
				expect(start).not.toContain("--model");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("each outgoing edge offers its own row, and the pinning shows on the row", async () => {
		const app = seededApp("awaiting", {
			workflows: [
				{ from: "implement", to: ["review"] },
				{ from: "implement", to: ["review"], agent: "codex" },
			],
		});
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				// Two edges to the same target keep both rows, so every edge
				// stays reachable. The second row's detail shows the pinning
				// that tells the rows apart.
				expect(panel.split("Handoff: review").length - 1).toBe(2);
				expect(panel).toContain("agent codex");

				// The pinned row is the last one: down three (close, goto,
				// first edge), confirm.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the first edge", (f) =>
					frameText(f).includes("❯ Handoff: review review"),
				);
				await pressArrow(setup, "down", "the pinned edge", (f) =>
					frameText(f).includes("❯ Handoff: review agent codex"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				// The handoff ran with the edge's pinned agent, and the
				// route's decision landed on the settled turn's trace when the
				// routed handoff started.
				expect(app.runner.commands()).toContain(
					"herdr agent start persist-source-facts --kind codex --pane pane-9",
				);
				expect(app.state.lastCompletion(identity)?.decision).toBe("handed-off");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a failed route leaves the trace pending, and Close still ends the cycle", async () => {
		const app = seededApp("awaiting");
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		// The stored workspace still lists, but the fresh tab cannot be made:
		// the handoff fails before the agent starts.
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			code: 1,
			stderr: "the workspace is gone",
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the failed route", (f) => f.includes("the workspace is gone"));

				// The handoff never started: the ticket still awaits, and the
				// turn's trace is still pending, so the decision modal keeps
				// working on it.
				expect(app.state.ticketState(identity)).toBe("awaiting");
				expect(app.state.lastCompletion(identity)?.decision).toBeNull();
				await pressReturn(setup, "the decision modal again", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				expect(app.state.ticketState(identity)).toBe("open");
				expect(app.state.lastCompletion(identity)?.decision).toBe("closed");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("goto focuses the stored pane and leaves the handoff open", async () => {
		const app = seededApp("awaiting");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				// Goto is the second row: one down, confirm.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressReturn(setup, "the focus", (f) => f.includes("focused the agent"));
				// The focus went to the stored pane, and the handoff stayed
				// open: the ticket is running, and the row wears the missing
				// badge only because the faked agent list is empty.
				expect(app.runner.commands()).toContain("herdr agent focus pane-1");
				const visible = app.state.visibleTickets(app.config.taskRules, app.config.defaultTaskType);
				expect(visible[0]?.state).toBe("running");
				expect(ticketRow(await settle(setup))).toContain("missing");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("shows the log at its bottom, with a proportional scrollbar", async () => {
		// Zero-padded labels: a bare "log 1" is a substring of "log 10".
		const lines = Array.from(
			{ length: 40 },
			(_, i) => `log ${String(i + 1).padStart(3, "0")}`,
		).join("\n");
		const app = seededApp("awaiting", {}, success, "live-worktree", lines);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const thumbRowOf = (frame: string) => rowsOf(frame).findIndex((row) => row.includes("█"));

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = await settle(setup);
				const text = frameText(panel);
				// The near-fullscreen modal holds 19 of the 40 lines. It opens at
				// the bottom, where the agent's conclusion is, and the scrollbar
				// thumb rests there.
				expect(text).toContain("log 022");
				expect(text).toContain("log 040");
				expect(text).toContain("█");
				const bottomThumbRow = thumbRowOf(panel);
				expect(bottomThumbRow).toBeGreaterThan(-1);

				// k scrolls up through the log, one row per press. Each press
				// drops the newest row; two presses move the thumb with the log.
				await press(
					setup,
					"k",
					"one row up",
					(f) => f.includes("log 021") && !f.includes("log 040"),
				);
				const higher = await press(
					setup,
					"k",
					"one more row up",
					(f) => f.includes("log 020") && !f.includes("log 039"),
				);
				expect(thumbRowOf(higher)).toBeLessThan(bottomThumbRow);
				// j scrolls back down and brings the thumb with it.
				const backDown = await press(
					setup,
					"j",
					"one row down",
					(f) => f.includes("log 039") && !f.includes("log 020"),
				);
				expect(thumbRowOf(backDown)).toBe(bottomThumbRow);

				// up and down move the action row.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "up", "back to close", (f) => frameText(f).includes("❯ Close"));
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("esc closes the panel and leaves the ticket awaiting", async () => {
		const app = seededApp("awaiting");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				// The panel key handler subscribes in an effect that flushes after
				// the commit; a settled frame proves the panel is open and ready.
				await settle(setup);
				// Esc cancels: nothing runs, no decision lands.
				await pressEscape(setup, "the panel to close", (f) => !f.includes("Decision:"));
				// The ticket is still awaiting, and the turn is still pending.
				expect(app.state.ticketState(identity)).toBe("awaiting");
				expect(app.state.lastCompletion(identity)?.decision).toBeNull();
				expect(ticketRow(await settle(setup))).toContain("[awaiting]");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("the modal shows the border title, the context line, and the log's notes", async () => {
		const conclusion = "## Result\n\n**All 142 tests pass.**";
		const app = seededApp("awaiting", {}, success, "live-worktree", conclusion, "", "", [
			{ kind: "text", text: "I will run the tests." },
			{ kind: "tool", name: "bash", target: "npm test", failed: false },
			{ kind: "tool", name: "bash", target: "npm run lint", failed: true },
			{ kind: "text", text: conclusion },
		]);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const modal = frameText(await settle(setup));
				// The border names the ticket, and the context line names the
				// repository, the task type, the agent, and the completion time.
				expect(modal).toContain("Decision: Persist source facts");
				expect(modal).toContain("acme/factory · implement · pi · 2026-08-31 11:00");
				// The log renders in order: the opening text, the tool notes,
				// and the markdown-dressed conclusion. The heading's hash and
				// the bold's asterisks do not show.
				expect(modal).toContain("I will run the tests.");
				expect(modal).toContain("▸ bash: npm test");
				expect(modal).toContain("▸ bash: npm run lint");
				expect(modal).toContain("All 142 tests pass.");
				expect(modal).not.toContain("**");
				expect(modal).not.toContain("##");
				// The key hint offers the log's scroll keys.
				expect(modal).toContain("pgup/pgdn page home/end");

				// The failed tool call wears the warning color, the passing one
				// the dim one. Both are painted, so the notes are on screen. The
				// pop-in fades in for a little while, so wait it out before
				// reading the painted colors: mid-fade they are blended.
				await sleep(250);
				expect(spanColors(setup, "npm run lint")).toContainEqual(rgb(COLORS.statusWarning));
				expect(spanColors(setup, "npm test")).toContainEqual(rgb(COLORS.dim));
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("home and end jump the log's ends, and pageup and pagedown page it", async () => {
		// Zero-padded labels: a bare "line 1" is a substring of "line 10".
		const lines = Array.from(
			{ length: 40 },
			(_, i) => `log ${String(i + 1).padStart(3, "0")}`,
		).join("\n");
		const app = seededApp("awaiting", {}, success, "live-worktree", lines);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await settle(setup);

				// The modal opens at the bottom, where the agent's conclusion is.
				// home takes the opening, without the conclusion.
				await pressScrollKey(
					setup,
					"home",
					"the log at its top",
					(f) => f.includes("log 001") && !f.includes("log 040"),
				);
				// end returns to the conclusion, without the opening.
				await pressScrollKey(
					setup,
					"end",
					"the log at its bottom",
					(f) => f.includes("log 040") && !f.includes("log 001"),
				);
				// pageup pages back up, out of the conclusion.
				await pressScrollKey(setup, "pageup", "a page up", (f) => !f.includes("log 040"));
				// pagedown pages back down to the bottom.
				await pressScrollKey(
					setup,
					"pagedown",
					"a page down",
					(f) => f.includes("log 040") && !f.includes("log 001"),
				);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the herdr-unreachable line", () => {
	test("a failed agent list warns and the observation holds", async () => {
		const app = seededApp("in-flight");
		// herdr cannot be reached: the agent list fails.
		app.runner.set("herdr", ["agent", "list"], { code: 1, stderr: "no herdr session" });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(
					setup,
					(f) => f.includes("herdr is unreachable"),
					"the herdr-unreachable warning",
				);
				// The loop holds: the failed list marks nothing, so the
				// in-flight ticket runs on without a marker.
				expect(ticketRow(setup.captureCharFrame())).not.toContain("missing");
				expect(ticketRow(setup.captureCharFrame())).not.toContain("blocked");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the Close cleanup", () => {
	test("close on a worktree handoff removes the checkout and the herdr workspace", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				// Close is the default row: confirm.
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				// herdr worktree remove closes the workspace with the checkout
				// and never deletes the branch, so pushed work and pull requests
				// survive. There is no workspace close after it.
				expect(commands).toContain("herdr worktree remove --workspace ws-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("branch -D");
				expect(joined).not.toContain("branch --delete");
				expect(joined).not.toContain("workspace close");
				expect(joined).not.toContain("tab close");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("close on a live worktree handoff closes only the tab it made", async () => {
		const app = seededApp("awaiting");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				expect(commands).toContain("herdr tab close tab-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("worktree remove");
				expect(joined).not.toContain("workspace close");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("abandon on a worktree handoff removes the checkout and the herdr workspace", async () => {
		const app = seededApp("in-flight", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				// herdr worktree remove closes the workspace with the checkout
				// and never deletes the branch: there is no workspace close after it.
				expect(commands).toContain("herdr worktree remove --workspace ws-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("branch -D");
				expect(joined).not.toContain("branch --delete");
				expect(joined).not.toContain("workspace close");
				expect(joined).not.toContain("tab close");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("abandon on a live worktree handoff closes only the tab it made", async () => {
		const app = seededApp("in-flight");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
				const commands = app.runner.commands();
				expect(commands).toContain("herdr tab close tab-1");
				const joined = commands.join("\n");
				expect(joined).not.toContain("worktree remove");
				expect(joined).not.toContain("workspace close");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the leftover environment", () => {
	/** The herdr answer that refuses to remove a dirty checkout. */
	const DIRTY_REMOVAL = {
		code: 1,
		stderr:
			'{"error":{"code":"dirty_worktree_requires_force","message":"fatal: the worktree contains modified or untracked files, use --force to delete it"},"id":"cli:worktree:remove"}\n',
	};

	test("a Close cleanup that fails leaves the ticket carrying the leftover", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], DIRTY_REMOVAL);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				// The state transition stands: the cycle closed. What failed is
				// now a fact on the ticket, not only a message line that fades.
				expect(app.state.ticketState(identity)).toBe("open");
				expect(app.state.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						workspaceId: "ws-1",
						paneId: "pane-1",
						reason: expect.stringContaining("dirty_worktree_requires_force"),
					}),
				);
				// The row wears the marker, and the detail pane says what is
				// still alive for this ticket and how to end it.
				const shown = setup.captureCharFrame();
				expect(ticketRow(shown)).toContain("leftover");
				const detail = detailPaneText(shown);
				expect(detail).toContain("Leftover: herdr workspace ws-1");
				expect(detail).toContain("press w to clear it");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a cleanup that cannot run at all is still the ticket's fact", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		// herdr is unreachable: the command throws instead of answering, and
		// the environment the ticket cannot close is a fact either way.
		const brokenRunner: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr" && args[0] === "worktree"
					? Promise.reject(new Error("herdr is not reachable"))
					: app.runner.run(command, args, options),
		};

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				expect(app.state.ticketState(identity)).toBe("open");
				expect(app.state.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						workspaceId: "ws-1",
						reason: "the close cleanup did not run: herdr is not reachable",
					}),
				);
				expect(frameText(setup.captureCharFrame())).toContain(
					"the close cleanup failed: the close cleanup did not run",
				);
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: brokenRunner },
		);
		app.state.close();
	});

	test("the observation abandons a missing cycle at the limit, and records the failed cleanup", async () => {
		const app = seededApp(
			"in-flight",
			{ maxHandoffsPerTicket: 1, autoHandoff: true },
			success,
			"worktree",
		);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], {
			code: 1,
			stderr: "the checkout is dirty",
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("leftover"),
					"the leftover marker",
				);
				// Auto mode ends the missing cycle at the limit, and the failed
				// Close cleanup of the abandoned handoff lands as a fact on the
				// ticket.
				expect(frameText(frame)).toContain(
					"abandoned; the close cleanup failed: the checkout is dirty",
				);
				expect(app.state.ticketState(identity)).toBe("open");
				expect(app.state.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({ workspaceId: "ws-1", reason: "the checkout is dirty" }),
				);
				// The row wears both trailing markers at once: the limit that
				// ended the cycle, and the leftover its cleanup left behind.
				// The terminal row also carries the detail pane, so check only
				// the list half.
				const row = frameText(ticketRow(frame).slice(0, Math.floor(WIDTH / 2))).trimEnd();
				expect(row.endsWith("handoff limit leftover")).toBe(true);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("one action clears a leftover environment, with force as its own choice", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], DIRTY_REMOVAL);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				const failed = app.runner.commands();
				expect(failed).toContain("herdr worktree remove --workspace ws-1");

				// The key guide offers the control while the ticket holds the
				// leftover, and one key opens the action.
				await press(setup, "?", "the key guide", (f) => f.includes("Key guide"));
				expect(frameText(setup.captureCharFrame())).toContain("w clear leftover");
				await pressEscape(setup, "the guide closes", (f) => !f.includes("Key guide"));
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				const panel = setup.captureCharFrame();
				expect(frameText(panel)).toContain("Retry");
				// herdr's force is its own row: the operator chooses it, and the
				// control plane never reaches for it alone.
				expect(frameText(panel)).toContain("Force");
				// It is the leftover panel and nothing else: a second modal
				// behind it would answer the same keys with other work.
				expect(panel).not.toContain("Restart");
				expect(panel).not.toContain("Abandon");
				await pressEscape(setup, "the panel closes", (f) => !f.includes("Leftover environment"));
				expect(app.state.leftoverEnvironment(identity)).not.toBe(null);

				// Retry alone does not ask herdr for force, and the leftover stands.
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				await pressReturn(setup, "the retry", (f) =>
					f.includes("still holds a leftover environment"),
				);
				expect(
					app.runner.commands().filter((c) => c === "herdr worktree remove --workspace ws-1"),
				).toHaveLength(2);
				expect(app.runner.commands().join("\n")).not.toContain("--force");
				expect(app.state.leftoverEnvironment(identity)).not.toBe(null);

				// The forced removal is what ends it: the fact clears, and the
				// marker leaves the row.
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				await pressArrow(setup, "down", "select force", (f) => frameText(f).includes("❯ Force"));
				await pressReturn(setup, "the forced removal", (f) =>
					f.includes("cleared the leftover environment"),
				);
				expect(app.runner.commands()).toContain("herdr worktree remove --workspace ws-1 --force");
				expect(app.state.leftoverEnvironment(identity)).toBe(null);
				// The fact is gone, so the marker and its control leave the row.
				expect(ticketRow(setup.captureCharFrame())).not.toContain("leftover");
				// The git branch stays: no automatic path deletes it.
				expect(app.runner.commands().join("\n")).not.toContain("branch -D");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a clear refuses to force the workspace its live agent runs in", async () => {
		const app = seededApp("in-flight", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{ paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1", agent: "pi", status: "working" },
			]),
		});
		const stored = app.state.latestHandoff(identity);
		if (stored === null) throw new Error("the seeded handoff is missing");
		// The workspace an earlier cycle left behind is the one the live agent
		// now works in: removing it would end that work.
		app.state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: stored.handoffId,
			reason: "the worktree is dirty",
			at: "2026-09-02T10:00:00.000Z",
		});

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => ticketRow(f).includes("leftover"), "the leftover marker");
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				await pressArrow(setup, "down", "select force", (f) => frameText(f).includes("❯ Force"));
				await pressReturn(setup, "the refusal", (f) =>
					f.includes("close its work cycle before you clear"),
				);
				// The control plane never reaches for force on its own, and the
				// in-flight agent keeps running.
				expect(app.runner.commands().join("\n")).not.toContain("--force");
				expect(app.runner.commands().join("\n")).not.toContain("herdr tab close");
				expect(app.state.leftoverEnvironment(identity)).not.toBe(null);
				// The refusal changes nothing: the agent keeps its cycle running.
				expect(app.state.ticketState(identity)).toBe("running");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a panel that has nothing left to show lets the keys back", async () => {
		// The ticket's agent disappears while the panel is open, the
		// observation ends the cycle at the handoff limit, and its Close
		// cleanup removes the workspace: the leftover the panel listed is
		// gone. A panel that can no longer be drawn must not keep swallowing
		// the keys the ticket panels take.
		const app = seededApp(
			"in-flight",
			{ autoHandoff: true, maxHandoffsPerTicket: 1 },
			success,
			"worktree",
		);
		// The agent lives while the panel opens, and is gone by the next poll.
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{ paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1", agent: "pi", status: "working" },
			]),
		});
		const stored = app.state.latestHandoff(identity);
		if (stored === null) throw new Error("the seeded handoff is missing");
		app.state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: stored.handoffId,
			reason: "the worktree is dirty",
			at: "2026-09-02T10:00:00.000Z",
		});

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => ticketRow(f).includes("leftover"), "the leftover marker");
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
				await awaitFrame(setup, (f) => !f.includes("Leftover environment"), "the panel closing");
				expect(app.state.leftoverEnvironment(identity)).toBe(null);
				expect(app.state.ticketState(identity)).toBe("open");
				// The ticket keys answer again.
				await press(setup, "?", "the key guide", (f) => f.includes("Key guide"));
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), pollIntervalMs: 20 },
		);
		app.state.close();
	});

	test("two unresolved leftovers show each reason under its own environment line", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		// Two closed cycles over the same reused workspace, each of whose
		// Close cleanup failed: the shape the ticket wears after a second
		// failed close.
		const first = app.state.latestHandoff(identity);
		if (first === null) throw new Error("the seeded handoff is missing");
		app.state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: first.handoffId,
			decision: "closed",
			decidedAt: "2026-09-02T09:30:00.000Z",
		});
		const claim = app.state.claimHandoff(
			identity,
			{ agentType: "pi", environment: "worktree", taskType: "implement", model: "", thinking: "" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		app.state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-1",
		});
		const second = app.state.latestHandoff(identity);
		if (second === null) throw new Error("the second handoff is missing");
		app.state.settleTurn({
			ticketIdentity: identity,
			handoffId: second.handoffId,
			taskType: "implement",
			agentType: "pi",
			message: "The second turn is done.",
			turnLog: [{ kind: "text", text: "The second turn is done." }],
			completedAt: "2026-09-02T10:30:00.000Z",
		});
		app.state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: second.handoffId,
			decision: "closed",
			decidedAt: "2026-09-02T10:40:00.000Z",
		});
		app.state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: first.handoffId,
			reason: "the first close failed",
			at: "2026-09-02T09:30:00.000Z",
		});
		app.state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: second.handoffId,
			reason: "the second close failed",
			at: "2026-09-02T10:40:00.000Z",
		});

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => ticketRow(f).includes("leftover"), "the leftover marker");
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				const panel = rowsOf(setup.captureCharFrame());
				// The guidance is on screen with the actions: the two rows mean
				// them, and the branch fact stands.
				expect(panel.some((row) => row.includes("Retry runs the Close cleanup again"))).toBe(true);
				expect(panel.some((row) => row.includes("The git branch stays either way"))).toBe(true);
				expect(panel.some((row) => row.includes("Force"))).toBe(true);
				// Each fact's reason follows its own environment line, in the
				// order the ticket holds them: the newest handoff first.
				const secondEnv = panel.findIndex((row) =>
					row.includes("still open: herdr workspace ws-1, tab tab-2, pane pane-2"),
				);
				expect(secondEnv).toBeGreaterThan(-1);
				expect(panel[secondEnv + 1]).toContain("the second close failed");
				const firstEnv = panel.findIndex((row) =>
					row.includes("still open: herdr workspace ws-1, tab tab-1, pane pane-1"),
				);
				expect(firstEnv).toBeGreaterThan(-1);
				expect(panel[firstEnv + 1]).toContain("the first close failed");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("an operator abandon records a cleanup that failed", async () => {
		// The Abandon row of the missing panel ends the cycle, and its Close
		// cleanup is the same cleanup the automatic end runs: a checkout herdr
		// will not remove lands as the ticket's fact.
		const app = seededApp("in-flight", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], DIRTY_REMOVAL);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("leftover"));
				expect(app.runner.commands()).toContain("herdr worktree remove --workspace ws-1");
				expect(app.state.ticketState(identity)).toBe("open");
				// The fact names the handoff the abandon ended, so the clear that
				// follows reaches the environment this cycle left.
				expect(app.state.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						handoffId: app.state.latestHandoff(identity)?.handoffId,
						workspaceId: "ws-1",
						reason: expect.stringContaining("dirty_worktree_requires_force"),
					}),
				);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("the automatic close records a cleanup that failed", async () => {
		// No operator key ends this cycle: the observation loop closes the
		// settled turn itself, and its cleanup is the same call. A tab herdr
		// will not close is the ticket's fact to carry.
		const app = seededApp("awaiting", {
			autoHandoff: true,
			workflows: [],
			maxHandoffsPerTicket: 1,
		});
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["tab", "close", "tab-1"], {
			code: 1,
			stderr: '{"error":{"code":"agent_running","message":"running agent pi"}}\n',
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("leftover"), "the leftover marker");
				expect(app.state.lastCompletion(identity)?.decision).toBe("auto-closed");
				expect(app.runner.commands()).toContain("herdr tab close tab-1");
				expect(app.state.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({
						environment: "live-worktree",
						tabId: "tab-1",
						reason: expect.stringContaining("agent_running"),
					}),
				);
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), pollIntervalMs: 20 },
		);
		app.state.close();
	});

	test("a clear refuses the tab its own live agent runs on", async () => {
		// The shape a reclaim leaves behind (ADR 0011): the cycle closed around
		// an agent that outlived it, and Enter built the next handoff on the
		// same tab. A tab close ends every pane inside it, so the leftover of
		// the older row is one the clear must refuse.
		const app = seededApp("awaiting", {}, success, "live-worktree");
		const closed = app.state.latestHandoff(identity);
		if (closed === null) throw new Error("the seeded handoff is missing");
		app.state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: closed.handoffId,
			decision: "closed",
			decidedAt: "2026-09-02T09:30:00.000Z",
		});
		// The tab herdr would not close, and the handoff Enter started took that
		// same tab: the two rows name one live agent.
		app.state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: closed.handoffId,
			reason: "herdr refused to close tab tab-1 of ticket ticket-1: running agent pi",
			at: "2026-09-02T09:30:00.000Z",
		});
		const reclaim = app.state.claimHandoff(
			identity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
			},
			"open",
		);
		if (!reclaim.ok) throw new Error(reclaim.reason);
		app.state.settleHandoff(reclaim.claim.attemptId, true, undefined, {
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{ paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1", agent: "pi", status: "working" },
			]),
		});

		await withApp(
			async (setup) => {
				await awaitFrame(setup, (f) => f.includes("leftover"), "the leftover marker");
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				await pressReturn(setup, "the refusal", (f) =>
					// The status line is truncated to the terminal width here.
					f.includes("close its work cycle before you clear"),
				);
				// The refusal names the handle it refused: the live agent's tab.
				expect(frameText(setup.captureCharFrame())).toContain("runs in herdr tab tab-1");
				// A tab close is what would end the live agent: it never runs.
				expect(app.runner.commands().join("\n")).not.toContain("herdr tab close");
				expect(app.state.leftoverEnvironment(identity)).not.toBe(null);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a clear refuses while a handoff holds the seat", async () => {
		// A live-worktree cycle: its Close cleanup closes one tab, and its next
		// handoff reaches herdr through the workspace list first.
		const app = seededApp("awaiting", {}, success, "live-worktree");
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["tab", "close", "tab-1"], { code: 1, stderr: "the tab has an agent" });
		// The handoff stops at herdr's first call, so the seat stays taken while
		// the operator works the clear behind it.
		const gate = gatedRunner(app, (command) => command.startsWith("herdr workspace list"));

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				expect(tabCloses(app)).toBe(1);
				await pressReturn(setup, "the handoff", (f) => f.includes("handing off"));
				await awaitFrame(setup, () => gate.busy(), "the handoff reaching herdr");

				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				await pressReturn(setup, "the refusal", (f) => f.includes("a handoff is in flight"));
				// The tab close the clear would have run never reaches herdr: the
				// agent being built cannot meet it half way.
				expect(tabCloses(app)).toBe(1);
				expect(app.state.leftoverEnvironment(identity)).not.toBe(null);
				gate.release();
				await awaitFrame(setup, () => !gate.busy(), "the handoff settling");
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

	test("a handoff the operator starts during a clear waits for the removal", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], DIRTY_REMOVAL);
		// The handoff Enter starts reads herdr's workspace list first: answer it,
		// so the queued claim reaches the create the test waits for.
		app.runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		// The clear stops at herdr's removal, so the seat stays taken while the
		// operator presses Enter on the open ticket. The Close cleanup that left
		// the fact ran first: only the operator's retry is held.
		let holdRemoval = false;
		const gate = gatedRunner(
			app,
			(command) => holdRemoval && command.startsWith("herdr worktree remove"),
		);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => f.includes("leftover"));

				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				holdRemoval = true;
				// The panel closes in the same action that starts the clear, and
				// the render can lag the command: wait for both.
				await pressReturn(setup, "the clear reaching herdr", () => gate.busy());
				await awaitFrame(setup, (f) => !f.includes("Leftover environment"), "the panel closing");
				// A second clear meets the seat the first one holds: it reports that
				// and runs nothing, because two removals of one workspace cannot
				// take turns at herdr.
				await press(setup, "w", "the leftover panel again", (f) =>
					f.includes("Leftover environment"),
				);
				await pressReturn(setup, "the second clear", (f) =>
					f.includes("a leftover clear is already in flight"),
				);
				expect(
					app.runner.commands().filter((c) => c === "herdr worktree remove --workspace ws-1"),
				).toHaveLength(1);
				await pressReturn(setup, "the handoff the operator starts", (f) => f.includes("[open]"));
				// The claim is taken, but it waits: no environment work of its
				// own has reached herdr while the removal holds the seat.
				await settle(setup);
				expect(creates(app)).toEqual([]);
				gate.release();
				await awaitFrame(
					setup,
					() => creates(app).length > 0,
					"the queued handoff taking the seat",
				);
				const commands = app.runner.commands();
				// The order is the whole point: the removal the operator asked
				// for ends, and the handoff follows it.
				expect(commands.filter((c) => c === "herdr worktree remove --workspace ws-1")).toHaveLength(
					2,
				);
				expect(commands.lastIndexOf("herdr worktree remove --workspace ws-1")).toBeLessThan(
					commands.findIndex((c) => c.startsWith("herdr workspace create")),
				);
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

	/** How many times the Close cleanup tried to close the seeded tab. */
	function tabCloses(app: SeededApp): number {
		return app.runner.commands().filter((command) => command.startsWith("herdr tab close")).length;
	}

	/** The herdr calls that would have built a new environment for a handoff. */
	function creates(app: SeededApp): string[] {
		return app.runner
			.commands()
			.filter((command) => /^herdr (worktree|workspace) (create|open)/.test(command));
	}

	test("a cleanup that ran no command ends only the fact of its own row", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const first = app.state.latestHandoff(identity);
		if (first === null) throw new Error("the seeded handoff is missing");
		// One cycle closed over a workspace herdr would not remove: its fact
		// stands, and it names that workspace.
		app.state.applyCompletionDecision({
			ticketIdentity: identity,
			handoffId: first.handoffId,
			decision: "closed",
			decidedAt: "2026-09-02T09:30:00.000Z",
		});
		app.state.recordLeftoverEnvironment({
			ticketIdentity: identity,
			handoffId: first.handoffId,
			reason: "the worktree is dirty",
			at: "2026-09-02T09:30:00.000Z",
		});
		// A second cycle whose handoff stored no environment handle at all: its
		// Close cleanup has nothing to close.
		const claim = app.state.claimHandoff(
			identity,
			{ agentType: "pi", environment: "worktree", taskType: "implement", model: "", thinking: "" },
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		app.state.settleHandoff(claim.claim.attemptId, true, undefined, { paneId: "pane-2" });
		app.state.settleTurn({
			ticketIdentity: identity,
			handoffId: claim.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The second turn is done.",
			turnLog: [{ kind: "text", text: "The second turn is done." }],
			completedAt: "2026-09-02T10:30:00.000Z",
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => f.includes(" closed"));
				// Nothing to close means nothing reached: the fact of the row the
				// cleanup did not reach stands, and no command resolved it.
				expect(app.runner.commands().join("\n")).not.toContain("herdr worktree remove");
				expect(app.runner.commands().join("\n")).not.toContain("herdr tab close");
				expect(app.state.leftoverEnvironments(identity)).toEqual([
					expect.objectContaining({ handoffId: first.handoffId, workspaceId: "ws-1" }),
				]);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("the leftover block and the panel guide keep their own colours", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], DIRTY_REMOVAL);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				// The detail block is one warning the operator can act on: the
				// fact, its reason, and the key that ends it all carry it.
				expect(spanColors(setup, "Leftover: herdr workspace ws-1")).toEqual([
					rgb(COLORS.statusWarning),
				]);
				expect(spanColors(setup, "press w to clear it")).toEqual([rgb(COLORS.statusWarning)]);
				await press(setup, "w", "the leftover panel", (f) => f.includes("Leftover environment"));
				// The panel's guidance is message colour, not warning colour: it
				// explains the action, it does not report a fact.
				expect(spanColors(setup, "Retry runs the Close cleanup again.")).toEqual([rgb(COLORS.dim)]);
				expect(spanColors(setup, "still open: herdr workspace ws-1")).toEqual([rgb(COLORS.dim)]);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("the leftover panel cuts its reason to the width it renders at", async () => {
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const LONG_REASON =
			"herdr refused to remove the workspace of ticket ticket-1: fatal: the worktree contains modified or untracked files, use --force to delete it";
		const first = app.state.latestHandoff(identity);
		if (first === null) throw new Error("the seeded handoff is missing");
		// Three closed cycles over the same workspace: the ticket holds three
		// unresolved facts, and the panel cannot hold the guide, the blank, and
		// all six fact rows at once.
		const closeCycle = (handoffId: string, at: string) =>
			app.state.applyCompletionDecision({
				ticketIdentity: identity,
				handoffId,
				decision: "closed",
				decidedAt: at,
			});
		const nextCycle = (pane: string) => {
			const claim = app.state.claimHandoff(
				identity,
				{
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
					model: "",
					thinking: "",
				},
				"open",
			);
			if (!claim.ok) throw new Error(claim.reason);
			app.state.settleHandoff(claim.claim.attemptId, true, undefined, {
				paneId: pane,
				tabId: `tab-${pane}`,
				workspaceId: "ws-1",
			});
			app.state.settleTurn({
				ticketIdentity: identity,
				handoffId: claim.claim.attemptId,
				taskType: "implement",
				agentType: "pi",
				message: `${pane} settled`,
				turnLog: [{ kind: "text", text: `${pane} settled` }],
				completedAt: "2026-09-02T10:30:00.000Z",
			});
			return claim.claim.attemptId;
		};
		const ids = [first.handoffId];
		closeCycle(ids[0] as string, "2026-09-02T09:00:00.000Z");
		ids.push(nextCycle("pane-2"));
		closeCycle(ids[1] as string, "2026-09-02T09:10:00.000Z");
		ids.push(nextCycle("pane-3"));
		closeCycle(ids[2] as string, "2026-09-02T09:20:00.000Z");
		// The panel lists the newest fact first, so the long reason leads.
		const reasons = ["the first close failed", "the second close failed", LONG_REASON];
		for (const [index, handoffId] of ids.entries()) {
			app.state.recordLeftoverEnvironment({
				ticketIdentity: identity,
				handoffId,
				reason: reasons[index] as string,
				at: `2026-09-02T10:0${index}:00.000Z`,
			});
		}

		await withApp(
			async (setup) => {
				// The list column is narrow here, so the marker cannot be read
				// off the row: the detail pane and the panel carry the fact.
				await awaitFrame(setup, (f) => f.includes("[open]"), "the open ticket");
				const frame = await press(setup, "w", "the leftover panel", (f) =>
					f.includes("Leftover environment"),
				);
				const rows = rowsOf(frame);
				const top = rows.findIndex((row) => row.startsWith("┌") && row.includes("Leftover"));
				const bottom = rows.findIndex((row, at) => at > top && row.startsWith("└"));
				const panel = rows.slice(top + 1, bottom);
				// The reason is cut where the panel renders it - not at the width a
				// wide terminal would give it - and the cut is marked, so a reader
				// sees a hint that stops early instead of a fact line that runs off.
				const cut = panel.find((row) => row.includes("herdr refused to remove"));
				if (cut === undefined) throw new Error(`no cut reason row in:\n${frame}`);
				// One row per fact and one per reason: a wrapped fact line would
				// push the reasons out of the window without saying so.
				expect(panel.filter((row) => row.includes("still open:")).length).toBe(1);
				const shown = cut.replace(/│$/, "").trimEnd();
				expect(shown.endsWith("…")).toBe(true);
				expect(cut.length).toBeLessThanOrEqual(NARROW);
				// A row the window cannot hold comes back as a count: nothing
				// leaves the screen silently.
				expect(panel.some((row) => /\+\d+ more/.test(row))).toBe(true);
				// The guidance keeps the rows it is drawn above: it is the meaning
				// of the facts, and it never scrolls away under them.
				expect(panel.some((row) => row.includes("The git branch stays either way"))).toBe(true);
				expect(panel.some((row) => row.includes("Retry runs the Close cleanup again."))).toBe(true);
			},
			NARROW,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	/**
	 * A runner that holds every command `matches` until the test lets it go.
	 *
	 * A seat test cannot race a timer: the command must stay in flight while
	 * the operator works the keys behind it, and answer as soon as the test
	 * says so.
	 */
	function gatedRunner(
		app: SeededApp,
		matches: (command: string) => boolean,
	): { runner: CommandRunner; release: () => void; busy: () => boolean } {
		const waiting: (() => void)[] = [];
		let held = 0;
		return {
			runner: {
				run: async (name, args, options) => {
					const command = [name, ...args].join(" ").trim();
					if (matches(command)) {
						held += 1;
						await new Promise<void>((resolve) => waiting.push(resolve));
						held -= 1;
					}
					return app.runner.run(name, args, options);
				},
			},
			release: () => waiting.shift()?.(),
			busy: () => held > 0,
		};
	}

	/**
	 * A ticket whose closed cycle left a dirty workspace in herdr, whose
	 * leftover agent still holds the name the ticket's next handoff wants.
	 *
	 * The Close cleanup fails on the dirty checkout, the cycle closes anyway,
	 * and the handoff the operator starts then meets its own leftover name.
	 */
	function leftoverNameApp(): SeededApp {
		const app = seededApp("awaiting", { defaultEnvironment: "worktree" }, success, "worktree");
		// The leftover agent reports idle: herdr sees no live work in it, so
		// nothing reclaims it, and it is exactly the agent that holds the name.
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-2",
					tabId: "tab-2",
					workspaceId: "ws-1",
					agent: "pi",
					status: "idle",
				},
			]),
		});
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], DIRTY_REMOVAL);
		const path = Object.values(app.config.repos)[0];
		stubCheckout(app);
		app.runner.set("git", ["-C", path, "branch", "--list", "factory/5-persist-source-facts"], {
			stdout: "  factory/5-persist-source-facts\n",
		});
		// herdr still holds the workspace of the closed cycle: the worktree
		// open reuses it, and the leftover agent still holds the ticket's name.
		app.runner.set(
			"herdr",
			[
				"worktree",
				"open",
				"--cwd",
				path,
				"--branch",
				"factory/5-persist-source-facts",
				"--no-focus",
			],
			{
				stdout: JSON.stringify({
					result: {
						already_open: true,
						workspace: { workspace_id: "ws-1" },
						tab: { tab_id: "tab-1" },
						root_pane: { pane_id: "pane-1" },
						worktree: { path: `${path}/wt` },
					},
				}),
			},
		);
		app.runner.set(
			"herdr",
			["tab", "create", "--workspace", "ws-1", "--cwd", `${path}/wt`, "--no-focus"],
			{ stdout: tabCreateJson("pane-2", "tab-2") },
		);
		app.runner.set(
			"herdr",
			["agent", "start", "persist-source-facts", "--kind", "pi", "--pane", "pane-2"],
			{
				code: 1,
				stderr:
					'{"error":{"code":"agent_name_taken","message":"agent name persist-source-facts is already used; candidates: terminal_id=term_1 pane_id=pane-1 workspace_id=ws-1 tab_id=tab-1 cwd=unknown status=Idle"},"id":"cli:agent:start"}\n',
			},
		);
		return app;
	}

	/**
	 * Close the cycle the seeded agent settled, then hand the open ticket off
	 * again: the key path that meets the leftover name.
	 */
	async function closeAndHandOffAgain(setup: AppSetup): Promise<void> {
		await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
		await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
		await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
		// Enter on the open ticket: the leftover does not stop it.
		await pressReturn(setup, "the handoff", (f) => ticketRow(f).includes("[handed-off]"));
	}

	test("a handoff beside its own leftover agent starts anyway and says so", async () => {
		const app = leftoverNameApp();

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await closeAndHandOffAgain(setup);
				const commands = app.runner.commands();
				expect(commands).toContain(
					"herdr agent start persist-source-facts-c2 --kind pi --pane pane-2",
				);
				expect(commands.filter((command) => command.startsWith("herdr agent prompt "))).toEqual([
					expect.stringContaining("herdr agent prompt persist-source-facts-c2 "),
				]);
				// The operator learns why the name is not the one they know.
				expect(frameText(setup.captureCharFrame())).toContain(
					"this agent started as persist-source-facts-c2",
				);
				expect(app.state.leftoverEnvironment(identity)).not.toBe(null);
				// The durable handoff knows the name herdr accepted, so its
				// completion trace will name the agent that actually ran.
				expect(app.state.agentNameForTicket(identity)).toBe("persist-source-facts-c2");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a prompt that fails beside the leftover keeps its own reason", async () => {
		const app = leftoverNameApp();
		// The handoff's own failure: the agent started under its cycle name,
		// and the prompt never reached it. The name warning explains that name,
		// but it must not swallow the reason the operator has to act on.
		const promptRunner: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr" && args[0] === "agent" && args[1] === "prompt"
					? Promise.resolve({
							code: 1,
							stdout: "",
							stderr:
								'{"error":{"code":"agent_gone","message":"agent has no pane"},"id":"cli:agent:prompt"}\n',
						})
					: app.runner.run(command, args, options),
		};

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await closeAndHandOffAgain(setup);
				// One status line carries both facts: the failure first, the name
				// warning after it. The line is truncated to the terminal width,
				// so the test renders wide enough to hold the whole of it.
				const shown = frameText(setup.captureCharFrame());
				expect(shown).toContain(
					"agent persist-source-facts-c2 started, but the prompt failed: agent has no pane (agent_gone)",
				);
				expect(shown).toContain(
					"a leftover agent still holds the herdr name persist-source-facts; this agent started as persist-source-facts-c2",
				);
				// The agent runs, so the cycle stands: the ticket is handed off.
				expect(app.state.ticketState(identity)).toBe("handed-off");
			},
			WIDE_STATUS,
			HEIGHT,
			{ ...propsOf(app), runner: promptRunner },
		);
		app.state.close();
	});
});

describe("the auto dispatch", () => {
	test("auto mode hands off the open ticket on the first cycle", async () => {
		const app = seededApp("open", { autoHandoff: true });
		stubCheckout(app);
		const path = Object.values(app.config.repos)[0];
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		app.runner.set("herdr", ["workspace", "create", "--cwd", path, "--no-focus"], {
			stdout: workspaceCreateJson("ws-1", "pane-1"),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", path, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("auto: on 0/2") && f.includes("Agent: pi"),
					"the dispatch",
				);
				// The new agent's pane is not in the faked list: the row wears
				// the missing badge, and the detail pane shows the handoff.
				expect(ticketRow(frame)).toContain("missing");
				const commands = app.runner.commands();
				expect(commands).toContain(`herdr workspace create --cwd ${path} --no-focus`);
				expect(commands.some((c) => c.startsWith("herdr agent prompt"))).toBe(true);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("two open tickets dispatch in one cycle, and the queue drains when the seat frees", async () => {
		const app = seededApp("open", { autoHandoff: true }, pairSuccess);
		stubCheckout(app);
		const path = Object.values(app.config.repos)[0];
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		app.runner.set("herdr", ["workspace", "create", "--cwd", path, "--no-focus"], {
			stdout: workspaceCreateJson("ws-1", "pane-1"),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", path, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				// The first cycle dispatches both tickets: the first handoff
				// runs, the second queues behind it. When the first settles,
				// the seat frees, and the drain starts the second.
				await awaitFrame(
					setup,
					(f) =>
						f.includes("auto: on 0/2") &&
						ticketRow(f).includes("missing") &&
						ticketRow(f, "Watch agent turns").includes("missing"),
					"both dispatches",
				);
				// One herdr agent start per ticket, under the ticket's own
				// name: the queue drained, and no handoff ran twice.
				const starts = app.runner.commands().filter((c) => c.startsWith("herdr agent start"));
				expect(starts).toEqual([
					"herdr agent start persist-source-facts --kind pi --pane pane-1",
					"herdr agent start watch-agent-turns --kind pi --pane pane-1",
				]);
				// No ticket is left with an unresolved handoff: every claim
				// the queue held settled, so nothing needs recovery.
				const visible = app.state.visibleTickets(app.config.taskRules, app.config.defaultTaskType);
				expect(visible).toHaveLength(2);
				for (const ticket of visible) {
					expect(ticket.handoffRecoveryRequired).toBe(false);
					expect(ticket.state).toBe("handed-off");
				}
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("manual mode leaves the open ticket alone", async () => {
		const app = seededApp("open");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(setup, (f) => f.includes("auto: off 0/2"), "the mode line");
				expect(ticketRow(frame)).toContain("[open]");
				// No herdr handoff commands: only the agent list polls.
				// No herdr handoff commands: only agent list polls plus the
				// one-time repository validation for the launcher.
				const commands = app.runner.commands();
				expect(commands.length).toBeGreaterThan(0);
				expect(
					commands.every(
						(c) =>
							c === "herdr agent list" ||
							c.endsWith(" rev-parse --git-dir") ||
							c.endsWith(" remote get-url origin"),
					),
				).toBe(true);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the auto decision", () => {
	test("auto mode routes a settled turn to the workflow target without the operator", async () => {
		const review = { ...DEFAULT_CONFIG.taskTypes.review };
		review.template += "\n\nPrevious work message:\n{previous-message}";
		const app = seededApp("awaiting", {
			autoHandoff: true,
			taskTypes: { ...DEFAULT_CONFIG.taskTypes, review },
		});
		stubCheckout(app);
		// The routed agent's pane is live from the first list: a later tick
		// must not read it as missing and restart it.
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-9",
					tabId: "tab-9",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
				},
			]),
		});
		// The stored workspace still holds: the route reuses it in a new tab.
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			// A fresh tab, distinct from the settled agent's tab-1.
			stdout: tabCreateJson("pane-9", "tab-9"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				// No operator key: the loop routed the settled turn, and the
				// trace carries the automatic decision.
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("auto-handed-off"),
					"the automatic route",
				);
				expect(app.state.lastCompletion(identity)?.decision).toBe("auto-handed-off");
				expect(["handed-off", "running"]).toContain(app.state.ticketState(identity));
				// The row wears the workflow task's badge.
				expect(ticketRow(frame)).toContain("[review]");
				// The prompt carried the settled turn's last message, and the
				// settled agent's tab was closed once the new agent started.
				const commands = app.runner.commands();
				const prompt = commands.find((c) => c.startsWith("herdr agent prompt"));
				expect(prompt?.includes("The turn is done.")).toBe(true);
				expect(commands).toContain("herdr tab close tab-1");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("auto mode closes a settled turn with no workflow route", async () => {
		// The handoff limit equals the ticket's one handoff: the close is the
		// limit degrade, and it keeps the open ticket from being re-handed.
		const app = seededApp("awaiting", {
			autoHandoff: true,
			workflows: [],
			maxHandoffsPerTicket: 1,
		});
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[open]") && ticketRow(f).includes("handoff limit"),
					"the auto close",
				);
				// The settled turn is auto-closed: the cycle ended, the trace
				// carries the automatic decision, and the live tab was closed.
				expect(app.state.ticketState(identity)).toBe("open");
				expect(app.state.lastCompletion(identity)?.decision).toBe("auto-closed");
				const commands = app.runner.commands();
				expect(commands).toContain("herdr tab close tab-1");
				// At the handoff limit, auto-handoff leaves the open ticket
				// alone: no agent start ran.
				expect(commands.filter((c) => c.startsWith("herdr agent start"))).toHaveLength(0);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("enter on an awaiting ticket in auto mode reports the factory's decision", async () => {
		const app = seededApp("awaiting", { autoHandoff: true, maxParallelAgents: 1 }, pairSuccess);
		// The second ticket holds the single parallel seat with a live agent,
		// so the route waits and the ticket stays awaiting.
		const claim = app.state.claimHandoff(
			secondIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		app.state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-6",
			tabId: "tab-6",
			workspaceId: "ws-6",
		});
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-6",
					tabId: "tab-6",
					workspaceId: "ws-6",
					agent: "watch-agent-turns",
					status: "working",
				},
			]),
		});

		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				// The route waits for the free seat: the ticket stays awaiting.
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				// Enter does not open the decision modal: the factory decides.
				await pressReturn(setup, "the factory's notice", (f) =>
					f.includes("the factory decides this ticket"),
				);
				const frame = await settle(setup);
				expect(frame).not.toContain("Decision:");
				expect(app.state.ticketState(identity)).toBe("awaiting");
				expect(app.state.lastCompletion(identity)?.decision).toBeNull();
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the handoff queue", () => {
	test("a queued handoff whose ticket moved on settles its claim as failed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-auto-state-"));
		paths.push(dir);
		// The seeded in-flight ticket carries the newer external update: once
		// the open ticket's handoff puts both tickets in the in-flight group,
		// the tie-break sorts the in-flight one first, and the list move
		// lands on it.
		const pairMoved: FetchOutcome = {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [
				fetched(5, "Persist source facts"),
				{ ...fetched(6, "Watch agent turns"), externalUpdatedAt: "2026-08-31T10:05:00Z" },
			],
		};
		const state = openFactoryState(join(dir, "state.sqlite"));
		state.initializeSources([source]);
		state.applyFetch(source, pairMoved);
		// The second ticket starts in flight, with the stored herdr handles.
		const claim = state.claimHandoff(
			secondIdentity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
			},
			"open",
		);
		if (!claim.ok) throw new Error(claim.reason);
		state.settleHandoff(claim.claim.attemptId, true, undefined, {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});

		const path = checkout();
		const home = mkdtempSync(join(tmpdir(), "factory-auto-home-"));
		paths.push(home);
		const configPath = join(home, "config.toml");
		writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			repos: { [repoIdentity]: path },
			workflows: [{ from: "implement", to: ["review"] }],
		};
		const inner = new FakeRunner();
		inner.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		inner.set("git", ["-C", path, "remote", "get-url", "origin"], {
			stdout: `https://${repoIdentity}.git\n`,
		});
		inner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		inner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		inner.set("herdr", ["workspace", "create", "--cwd", path, "--no-focus"], {
			stdout: workspaceCreateJson("ws-1", "pane-1"),
		});
		inner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", path, "--no-focus"], {
			stdout: tabCreateJson("pane-1"),
		});
		// Hold the first handoff's agent start: the seat stays busy through
		// the whole key sequence, so the drain runs after the last key, while
		// the ticket the queued restart waits on has already moved on.
		const runner = holding(
			inner,
			"herdr agent start persist-source-facts --kind pi --pane pane-1",
			4000,
		);
		const src = new FakeSource("issues", "github-issues", pairMoved);

		await withApp(
			async (setup) => {
				src.settle(pairMoved);
				// Let the settle's state updates commit before any key goes
				// out: the test renderer stalls a key that lands while the
				// refresh chain's updates are still in flight.
				await sleep(250);
				// The in-flight ticket is missing: its badge shows.
				await awaitFrame(
					setup,
					(f) => ticketRow(f, "Watch agent turns").includes("missing"),
					"the missing badge",
				);
				// Every key here waits for its effect and then for the chained
				// updates (the observation tick, the status line) to go quiet:
				// a key that lands while they are in flight stalls the test
				// renderer.
				const pressQuiet = async (
					key: Parameters<typeof press>[1],
					what: string,
					predicate: (f: string) => boolean,
				): Promise<string> => {
					const frame = await press(setup, key, what, predicate);
					await sleep(150);
					return frame;
				};
				const pressReturnQuiet = async (
					what: string,
					predicate: (f: string) => boolean,
				): Promise<string> => {
					const frame = await pressReturn(setup, what, predicate);
					await sleep(150);
					return frame;
				};
				// Hand off the open ticket: it runs, and it holds the seat.
				// The list rows sit on frame lines two and three: line one is
				// the box border, and the list pads a blank line above its
				// first row. The in-flight ticket is first, and it is the
				// initial selection, so the move down lands the marker on
				// line three - a line it was not on, so the key is applied
				// before the next key is pressed.
				await pressQuiet("j", "select the open ticket", (f) => markerRowOf(f) === 3);
				await pressReturnQuiet("the handoff to start", (f) => f.includes("handing off"));
				// Back to the missing ticket: its restart queues behind the
				// handoff in flight.
				await pressQuiet("k", "select the missing ticket", (f) => markerRowOf(f) === 2);
				await pressReturnQuiet("the missing modal", (f) => f.includes("Missing:"));
				await pressReturnQuiet("the restart to queue", (f) => !f.includes("Missing:"));
				// And while the restart is queued, the ticket moves on:
				// abandon it.
				await pressReturnQuiet("the missing modal again", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await sleep(150);
				await pressReturnQuiet("the abandonment", (f) =>
					ticketRow(f, "Watch agent turns").includes("[open]"),
				);
				// The handoff settles, and the queue drains: the restart's
				// claim settles as failed, because the ticket is open now.
				await awaitFrame(
					setup,
					(f) => f.includes("was not run"),
					"the drained queue warning",
					5000,
				);
				expect(frameText(setup.captureCharFrame())).toContain(
					'queued handoff for "Watch agent turns" was not run: the ticket is now open',
				);

				// The queue held exactly one handoff: the open ticket's.
				// No agent started for the ticket that moved on.
				const starts = inner.commands().filter((c) => c.startsWith("herdr agent start"));
				expect(starts).toEqual(["herdr agent start persist-source-facts --kind pi --pane pane-1"]);
				// The abandonment ran the Close cleanup on the stored
				// environment.
				expect(inner.commands()).toContain("herdr tab close tab-2");
				const visible = state.visibleTickets(config.taskRules, config.defaultTaskType);
				const movedOn = visible.find((t) => t.identity === secondIdentity);
				const inFlight = visible.find((t) => t.identity === identity);
				expect(movedOn?.state).toBe("open");
				expect(movedOn?.handoffRecoveryRequired).toBe(false);
				expect(movedOn?.actionable).toBe(true);
				expect(inFlight?.state).toBe("handed-off");
				expect(inFlight?.handoffRecoveryRequired).toBe(false);

				// The claim settled, so the ticket is not dead: it hands off
				// again on demand.
				await pressQuiet("j", "select the open ticket", (f) => markerRowOf(f) === 3);
				await pressReturnQuiet("the re-handoff", (f) => f.includes("handing off"));
				await awaitFrame(
					setup,
					() =>
						inner
							.commands()
							.includes("herdr agent start watch-agent-turns --kind pi --pane pane-1"),
					"the re-handoff start",
				);
				await settle(setup);
				const startsAfter = inner.commands().filter((c) => c.startsWith("herdr agent start"));
				expect(startsAfter).toEqual([
					"herdr agent start persist-source-facts --kind pi --pane pane-1",
					"herdr agent start watch-agent-turns --kind pi --pane pane-1",
				]);
				const finalVisible = state.visibleTickets(config.taskRules, config.defaultTaskType);
				const reHandled = finalVisible.find((t) => t.identity === secondIdentity);
				expect(reHandled?.state).toBe("handed-off");
				expect(reHandled?.handoffRecoveryRequired).toBe(false);
			},
			WIDTH,
			HEIGHT,
			{
				config,
				state,
				runner,
				configPath,
				sources: [src],
				pollIntervalMs: 60_000,
			},
		);
		state.close();
	});
});
