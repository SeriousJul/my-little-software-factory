/**
 * The unattended mode through the real UI: the mode line, the session-only
 * `a` toggle, the blocked and missing markers, the missing
 * panel (restart / abandon), the decision panel on an awaiting ticket, and
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
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	type AppSetup,
	awaitFrame,
	frameText,
	HEIGHT,
	press,
	rowsOf,
	settle,
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
const repoIdentity = "github.com/acme/factory";

function fetched(): FetchedTicket {
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
 * stored herdr handles, or awaiting with a settled completion.
 */
function seed(shape: "open" | "in-flight" | "awaiting"): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-auto-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.initializeSources([source]);
	state.applyFetch(source, success);
	if (shape !== "open") {
		const claim = state.claimHandoff(
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
				agentName: "persist-source-facts",
				message: "The turn is done.",
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
): SeededApp {
	const state = seed(shape);
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
	const src = new FakeSource("issues", "github-issues", success);
	return { state, config, runner, configPath, src };
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

/** The ticket's list row, by its title. */
function ticketRow(frame: string): string {
	const rows = rowsOf(frame);
	const row = rows.find((line) => line.includes("Persist source facts"));
	if (row === undefined) throw new Error(`no ticket row in frame:\n${frame}`);
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
				await awaitFrame(
					setup,
					(f) => f.includes("auto-handoff: off, agents 0/2"),
					"the mode line",
				);
				await press(setup, "a", "auto on", (f) => f.includes("auto-handoff: on, agents 0/2"));
				// Session-only: the toggle never writes the config file.
				expect(readFileSync(app.configPath, "utf8")).toBe(before);
				await press(setup, "a", "auto off", (f) => f.includes("auto-handoff: off, agents 0/2"));
				expect(readFileSync(app.configPath, "utf8")).toBe(before);
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
					(f) => ticketRow(f).includes("!"),
					"the blocked marker",
				);
				// The agent is alive but not working: the badge stays, the
				// marker says blocked.
				expect(ticketRow(frame)).toContain("[handed-off]");
				expect(frame).toContain("agents 1/2");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a missing agent gets the missing marker and the missing panel", async () => {
		const app = seededApp("in-flight");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("✗"),
					"the missing marker",
				);
				// The marker appears although no state changed: manual mode
				// never acts on a missing agent.
				expect(frame).toContain("agents 1/2");
				expect(ticketRow(frame)).toContain("[handed-off]");

				// Enter on the in-flight missing ticket opens the missing panel.
				await pressReturn(setup, "the missing panel", (f) => f.includes("Missing:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Restart");
				expect(panel).toContain("Abandon");

				// Abandon is the last action: one down, confirm.
				await press(setup, "j", "select abandon", (f) => frameText(f).includes("❯ Abandon"));
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
				// The open ticket keeps no failure marker.
				expect(ticketRow(await settle(setup))).not.toContain("✗");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the decision panel", () => {
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
				await pressReturn(setup, "the decision panel", (f) => f.includes("Decision:"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("The turn is done.");
				expect(panel).toContain("Handoff review");
				expect(panel).toContain("Close");

				// Confirm the first action: the workflow handoff.
				await pressReturn(setup, "the routed handoff", (f) =>
					ticketRow(f).includes("[handed-off]"),
				);

				// The prompt carried the last captured message, and the
				// settled agent's tab was closed once the new agent started.
				const commands = app.runner.commands();
				const prompt = commands.find((c) => c.startsWith("herdr agent prompt"));
				expect(prompt?.includes("The turn is done.")).toBe(true);
				expect(commands.at(-1)).toBe("herdr tab close tab-1");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
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
					(f) => f.includes("auto-handoff: on, agents 1/2"),
					"the dispatch",
				);
				expect(ticketRow(frame)).toContain("[handed-off]");
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

	test("manual mode leaves the open ticket alone", async () => {
		const app = seededApp("open");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("auto-handoff: off, agents 0/2"),
					"the mode line",
				);
				expect(ticketRow(frame)).toContain("[open]");
				// No herdr handoff commands: only the agent list polls.
				const commands = app.runner.commands();
				expect(commands.length).toBeGreaterThan(0);
				expect(commands.every((c) => c === "herdr agent list")).toBe(true);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});
