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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// readFileSync is the session-only check: the toggle must not write it.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppProps } from "../src/components/app.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { CommandRunner } from "../src/runner.ts";
import { type FactoryState, openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import type { TurnEndCause, TurnLogEntry } from "../src/turn-log.ts";
import {
	type AppSetup,
	awaitFrame,
	detailPaneText,
	frameText,
	HEIGHT,
	markerRowOf,
	press,
	pressArrow,
	pressEnterQuiet,
	pressQuiet,
	pressScrollKey,
	rgb,
	roleColor,
	rowsOf,
	settle,
	sleep,
	spanColors,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import {
	agentListJson,
	FakeRunner,
	tabCreateJson,
	workspaceCreateJson,
	workspaceListJson,
} from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { type GatedRunner, gatedRunner as gateOnRunner } from "./gated-runner.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const source = { name: "issues", kind: "github-issues" };
const identity = "github:github.com:I_5";
const secondIdentity = "github:github.com:I_6";
const repoIdentity = "github.com/acme/factory";
/**
 * A terminal wide enough to hold a whole Message line at once.
 *
 * The status row is one line, truncated to the terminal width, so a test
 * that reads two facts off it (a failure and the warning that came with it)
 * needs the room for both.
 */
const WIDE_STATUS = 240;
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

/** The settled handoff's turn facts, and the clock the state writes with. */
interface SeedDetail {
	message?: string;
	model?: string;
	thinking?: string;
	contextWindow?: string;
	turnLog?: TurnLogEntry[];
	/**
	 * The cause the seeded turn settles with. The default is the fail-open
	 * `unknown`; a test that seeds a finished turn names `completed`.
	 */
	cause?: TurnEndCause;
	/**
	 * The state's clock. Pin it in the past to age the stored handoff, so a
	 * missing agent is past the startup grace: it died, it did not fail to
	 * boot.
	 */
	stateNow?: () => number;
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
	detail: SeedDetail = {},
): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-auto-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"), detail.stateNow);
	state.initializeSources([source]);
	state.applyFetch(source, outcome);
	if (shape !== "open") {
		const message = detail.message ?? "The turn is done.";
		const claim = state.claimHandoff(
			identity,
			{
				agentType: "pi",
				environment,
				taskType: "implement",
				model: detail.model ?? "",
				thinking: detail.thinking ?? "",
				contextWindow: detail.contextWindow ?? "",
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
				turnLog: detail.turnLog ?? [{ kind: "text", text: message }],
				completedAt: "2026-08-31T11:00:00Z",
				cause: detail.cause,
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
	detail: SeedDetail = {},
): SeededApp {
	const state = seed(shape, outcome, environment, detail);
	const path = checkout();
	const home = mkdtempSync(join(tmpdir(), "factory-auto-home-"));
	paths.push(home);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
	const config: FactoryConfig = {
		...BASE_CONFIG,
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
		listModels: (kind) => runner.listModels(kind),
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

/**
 * The app re-reads the ticket's source when a cycle ends, so a seeded close
 * that the next claim follows takes that re-read with it: the open ticket is
 * re-verified at the given time.
 */
function reverify(app: SeededApp, outcome: FetchOutcome, at: string): void {
	const refetch: FetchOutcome =
		outcome.status === "success"
			? { status: "success", fetchedAt: at, tickets: outcome.tickets }
			: outcome;
	app.state.applyFetch(source, refetch);
}

/**
 * The app re-reads the ticket's source when a cycle ends inside the app.
 * Settle that re-read at a time after the decision: the open ticket is
 * re-verified for the next handoff.
 */
async function settleReverify(src: FakeSource, outcome: FetchOutcome): Promise<void> {
	const refetch: FetchOutcome =
		outcome.status === "success"
			? {
					status: "success",
					fetchedAt: new Date(Date.now() + 60_000).toISOString(),
					tickets: outcome.tickets,
				}
			: outcome;
	src.settle(refetch);
	// Let the coordinator's applyFetch land before the next key goes out.
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
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

/**
 * The ticket's list row, by its title.
 *
 * The dual-list frame (ADR 0019) truncates the list row's title - at the
 * handoff limit, to its leading cells - so the row is found by the selection
 * marker and the title's leading cells, with the full-title row (the detail
 * pane, the modal's title) as the fallback a modal frame offers.
 */
function ticketRow(frame: string, title = "Persist source facts"): string {
	const rows = rowsOf(frame);
	const row =
		rows.find((line) => line.includes("❯") && line.includes(title.slice(0, 3))) ??
		rows.find((line) => line.includes(title));
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

	test("a working Consultation holds its seat beside the ticket seat on the mode line", async () => {
		const app = seededApp("in-flight");
		// The Consultation starts in opening and takes its confirmed Agent with
		// it into working, so the poll keeps it where it is.
		app.state.createConsultation({
			id: "consultation-1",
			typeName: "grill-with-docs",
			agentType: "pi",
			environment: "worktree",
			model: "",
			thinking: "",
			contextWindow: "",
			template: "/skill:grill-with-docs {input}",
			initialInput: "Review this repository",
			renderedOpeningPrompt: "/skill:grill-with-docs Review this repository",
			repository: {
				identity: repoIdentity,
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
				path: "/tmp/factory",
			},
			agentName: "consultation-11111111",
			createdAt: "2026-08-31T09:50:00.000Z",
		});
		app.state.setConsultationAgent("consultation-1", {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});
		app.runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "persist-source-facts",
					status: "working",
				},
				{
					paneId: "pane-2",
					tabId: "tab-2",
					workspaceId: "ws-2",
					agent: "consultation-11111111",
					status: "working",
				},
			]),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The ticket seat and the Consultation seat fill the limit of
				// two in one number on the mode line.
				await awaitFrame(setup, (f) => f.includes("auto: off 2/2"), "the mode line");
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
				expect(frame).toContain("auto: off 1/2");
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

	test("restart in the Missing modal repeats the interrupted handoff choices", async () => {
		const app = seededApp("in-flight", {}, success, "live-worktree", {
			message: "",
			model: "gpt-5.6",
			thinking: "high",
		});
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		stubCheckout(app);
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1" }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-restart", "tab-restart"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the Missing modal", (f) => f.includes("Missing:"));
				const modal = frameText(await settle(setup));
				expect(modal).toContain("Restart");
				expect(modal).toContain("same task type, same workspace");
				expect(modal).toContain("Abandon");
				await pressReturn(setup, "the restart handoff", (_frame) =>
					app.runner.commands().some((command) => command.startsWith("herdr agent prompt")),
				);
				expect(app.runner.commands()).toContain(
					"herdr agent start persist-source-facts --kind pi --pane pane-restart -- --model gpt-5.6 --thinking high",
				);
				expect(app.state.visibleTickets([], "implement")[0].handoff).toEqual(
					expect.objectContaining({
						model: "gpt-5.6",
						thinking: "high",
						paneId: "pane-restart",
					}),
				);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("abandon in the Missing modal closes the cycle and increments its durable number", async () => {
		const app = seededApp("in-flight");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("missing"), "the missing badge");
				await pressReturn(setup, "the Missing modal", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await pressReturn(setup, "the abandonment", (f) => ticketRow(f).includes("[open]"));
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		reverify(app, success, new Date(Date.now() + 60_000).toISOString());
		const next = app.state.claimHandoff(
			identity,
			{
				agentType: "pi",
				environment: "live-worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!next.ok) throw new Error(next.reason);
		app.state.settleHandoff(next.claim.attemptId, true);
		expect(app.state.ticketsByState(["handed-off"])).toEqual([
			expect.objectContaining({ ticketIdentity: identity, workCycle: 2 }),
		]);
		app.state.close();
	});

	test("enter on a blocked ticket opens the Live view without acting", async () => {
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
		app.runner.set(
			"herdr",
			[
				"agent",
				"read",
				"pane-1",
				"--lines",
				"200",
				"--source",
				"recent-unwrapped",
				"--format",
				"text",
			],
			{ stdout: "the agent is waiting on a build\n" },
		);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("blocked"), "the blocked badge");
				// Enter on the blocked ticket opens the Live view: the Goto is
				// one confirm away, and nothing focuses before it.
				await pressReturn(setup, "the Live view", (f) => f.includes("Live: Persist source facts"));
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent focus");
				// The stream shows the pane output under the ticket's context,
				// and the blocked status stands on the context line.
				await awaitFrame(setup, (f) => f.includes("the agent is waiting on a build"), "the stream");
				expect(frameText(setup.captureCharFrame())).toContain("acme/factory · implement · pi");
				// The pop-in fades in for a little while, so wait it out before
				// reading the painted colors: mid-fade they are blended.
				await sleep(250);
				expect(spanColors(setup, "blocked")).toContainEqual(rgb(roleColor("yellow")));
				// Enter confirms the Goto: the focus runs, the view closes, and
				// the ticket stays in flight with the blocked badge standing.
				await pressReturn(setup, "the focus", (f) => f.includes("focused the agent"));
				expect(app.runner.commands()).toContain("herdr agent focus pane-1");
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
		const review = { ...BASE_CONFIG.taskTypes.review };
		review.template += "\n\nPrevious work message:\n{previous-message}";
		const app = seededApp("awaiting", {
			taskTypes: { ...BASE_CONFIG.taskTypes, review },
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

	test("a routed handoff does not record the predecessor it closed as leftover", async () => {
		const app = seededApp("awaiting");
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});
		// The previous agent holds the stable name. The routed handoff starts
		// under its cycle name, then closes the predecessor tab that held it.
		app.runner.set(
			"herdr",
			["agent", "start", "persist-source-facts", "--kind", "pi", "--pane", "pane-9"],
			{
				code: 1,
				stderr:
					'{"error":{"code":"agent_name_taken","message":"agent name persist-source-facts is already used; candidates: terminal_id=term_1 pane_id=pane-1 workspace_id=ws-1 tab_id=tab-1 cwd=unknown status=Idle"}}\n',
			},
		);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);
				expect(app.runner.commands()).toContain("herdr tab close tab-1");
				// The name holder is gone with its predecessor tab. It is not a
				// leftover fact, and the row must not carry a false marker.
				expect(app.state.leftoverEnvironment(identity)).toBe(null);
				expect(ticketRow(setup.captureCharFrame())).not.toContain("leftover");
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
					...BASE_CONFIG.taskTypes,
					review: { ...BASE_CONFIG.taskTypes.review, thinking: "low" },
				},
			},
			success,
			"live-worktree",
			{ message: "The turn is done.", model: "opus-4", thinking: "high" },
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

	test("a manual workflow route starts with its target task profile", async () => {
		const app = seededApp(
			"awaiting",
			{
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: {
						...BASE_CONFIG.taskTypes.review,
						agent: "codex",
						model: "review-model",
						thinking: "high",
					},
				},
			},
			success,
			"live-worktree",
			{ message: "The turn is done.", model: "opus-4", thinking: "high" },
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
				expect(start).toContain(
					"--kind codex --pane pane-9 -- --model review-model -c model_reasoning_effort=high",
				);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("e on a workflow row edits the route's settings before it starts", async () => {
		const app = seededApp("awaiting", {
			workflows: [{ from: "implement", to: ["review"], agent: "pi" }],
			agents: {
				...BASE_CONFIG.agents,
				pi: {
					...BASE_CONFIG.agents.pi,
					contextWindow: "--context {value}",
				},
			},
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				review: {
					...BASE_CONFIG.taskTypes.review,
					model: "review-model",
					contextWindow: "131072",
				},
			},
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
				// The first row ends the cycle: it has no Handoff settings to
				// edit, so e there opens nothing.
				await press(setup, "e", "the decision modal to hold", (f) => f.includes("Decision:"));
				expect(frameText(await settle(setup))).not.toContain("Override");
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);

				// e opens the panel on the choice the edge resolved: the pinned
				// pi agent, and the target profile's model and context window.
				await press(setup, "e", "the route override panel", (f) => f.includes("Override"));
				const panel = frameText(await settle(setup));
				expect(panel).toContain("Agent pi");
				expect(panel).toContain("Model review-model");
				expect(panel).toContain("Context 131072");
				// Opening the edit starts nothing: the claim waits for the confirm.
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent start");
				expect(app.state.ticketState(identity)).toBe("awaiting");

				// The operator replaces the resolved model for this one handoff.
				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				await press(setup, "j", "the model row", (f) => f.includes("❯ Model"));
				// The row's input takes focus on its own render pass: let that
				// land, and the frame settle, before the edit keys go in.
				await settle(setup);
				setup.mockInput.pressKey("HOME");
				for (const _ of "review-model") setup.mockInput.pressKey("DELETE");
				await setup.mockInput.typeText("one-shot-model");
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("Model one-shot-model"),
					"the typed model",
				);
				await pressReturn(setup, "the routed handoff", (f) =>
					f.includes("Handoff task type: review"),
				);

				// The override is the last writer: the agent started on the
				// operator's model, not the profile's. The context window the
				// operator never touched still rides on the route's profile value.
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain(
					"--kind pi --pane pane-9 -- --model one-shot-model --context 131072",
				);
				expect(app.state.ticketState(identity)).toBe("handed-off");
				expect(app.state.lastCompletion(identity)?.decision).toBe("handed-off");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a route edit that moves to another Task type follows that profile, not the edge", async () => {
		// The one place the panel can undo an edge pin without a keystroke on
		// the Agent row: the edge pins the Agent of the route it triggers, and a
		// Task type the operator moves to owns its own profile.
		const app = seededApp("awaiting", {
			workflows: [{ from: "implement", to: ["review"], agent: "claude" }],
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				review: { ...BASE_CONFIG.taskTypes.review, model: "review-model" },
				fix: { ...BASE_CONFIG.taskTypes.fix, agent: "pi", model: "fix-model" },
			},
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
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await press(setup, "e", "the route override panel", (f) => f.includes("Override"));
				const opened = frameText(await settle(setup));
				// The panel starts on the route the edge resolved: its pinned Agent,
				// and the target profile's Model.
				expect(opened).toContain("Agent claude");
				expect(opened).toContain("Model review-model");

				await press(setup, "j", "the environment row", (f) => f.includes("❯ Environment"));
				await press(setup, "j", "the task type row", (f) => f.includes("❯ Task type"));
				// Left from `review` lands on `fix`, whose profile names its own
				// Agent and Model. Both rows are untouched, so both follow it, and
				// the edge's pin is gone with the edge's target.
				await press(setup, "h", "the fix task type", (f) => frameText(f).includes("Task type fix"));
				const moved = frameText(await settle(setup));
				expect(moved).toContain("Agent pi");
				expect(moved).toContain("Model fix-model");

				await pressReturn(setup, "the routed handoff", (f) => f.includes("Handoff task type: fix"));
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain("--kind pi --pane pane-9 -- --model fix-model");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("escape in a route edit returns to the decision with no claim", async () => {
		const app = seededApp("awaiting");
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				await press(setup, "e", "the route override panel", (f) => f.includes("Override"));
				await settle(setup);
				// Esc drops the edit and returns to the decision still being made.
				const back = await pressEscape(
					setup,
					"the decision modal",
					(f) => !f.includes("Override") && f.includes("Decision:"),
				);
				expect(frameText(back)).toContain("❯ Close");
				expect(app.state.ticketState(identity)).toBe("awaiting");
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent start");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("e alone on an awaiting ticket points at the decision instead of a panel", async () => {
		const app = seededApp("awaiting");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				const frame = await press(setup, "e", "the hint on the status line", (f) =>
					frameText(f).includes("press Enter, then e on a Handoff row"),
				);
				// The bar carries the e Override hint with its reason; the panel's
				// box title is the open signal.
				expect(frame).not.toContain("┌─Override");
				expect(app.state.ticketState(identity)).toBe("awaiting");
				expect(app.runner.commands().join("\n")).not.toContain("herdr agent start");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a workflow row shows the arriving task profile's effective agent", async () => {
		const app = seededApp("awaiting", {
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				review: { ...BASE_CONFIG.taskTypes.review, agent: "codex" },
			},
		});
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(
					setup,
					(frame) => ticketRow(frame).includes("[awaiting]"),
					"the awaiting ticket",
				);
				await pressReturn(setup, "the decision modal", (frame) => frame.includes("Decision:"));
				expect(frameText(await settle(setup))).toContain("Handoff: review agent codex");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("a workflow route resolves the target profile's model", async () => {
		// Story 26, through the pinned herdr sequence: the route's model comes from
		// the target task profile's chain, not from the handoff that just settled.
		// A route that started on an empty model would be the bug ADR 0009 exists
		// to remove.
		const app = seededApp(
			"awaiting",
			{
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: {
						...BASE_CONFIG.taskTypes.review,
						model: "anthropic/claude-review-4",
					},
				},
			},
			success,
			"live-worktree",
			{ message: "The turn is done.", model: "opus-4", thinking: "high" },
		);
		stubCheckout(app);
		app.runner.setModelList("pi", ["anthropic/claude-review-4"]);
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
				expect(start).toContain("--model anthropic/claude-review-4");
				expect(start).not.toContain("opus-4");
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
				{ from: "implement", to: ["review"], environment: "worktree" },
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
				expect(panel).toContain("agent pi, environment worktree");
				expect(panel).toContain("agent codex");

				// The pinned row is the last one: down three (close, goto,
				// first edge), confirm.
				await pressArrow(setup, "down", "the goto row", (f) => frameText(f).includes("❯ Goto"));
				await pressArrow(setup, "down", "the first edge", (f) =>
					frameText(f).includes("❯ Handoff: review agent pi"),
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
				setup.mockInput.pressEnter();
				await awaitFrame(
					setup,
					() => app.runner.commands().includes("herdr agent focus pane-1"),
					"the focus",
				);
				// The focus went to the stored pane, and the handoff stayed
				// open: Goto is navigation (ADR 0033), so the ticket rests in
				// awaiting until the poll or a decision moves it, and its row
				// reads the state it wears.
				expect(app.runner.commands()).toContain("herdr agent focus pane-1");
				const visible = app.state.visibleTickets(app.config.taskRules, app.config.defaultTaskType);
				expect(visible[0]?.state).toBe("awaiting");
				expect(ticketRow(await settle(setup))).toContain("[awaiting]");
				expect(app.state.lastCompletion(identity)?.decision ?? null).toBeNull();
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("g in the base mode focuses the stored pane of an awaiting ticket and moves nothing", async () => {
		const app = seededApp("awaiting");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				// `g` is the base-mode Goto (ADR 0033): on an awaiting ticket the
				// recorded pane stands, the focus runs without opening a surface,
				// and the ticket rests awaiting until the poll or a decision
				// moves it.
				setup.mockInput.pressKey("g");
				await awaitFrame(
					setup,
					() => app.runner.commands().includes("herdr agent focus pane-1"),
					"the focus",
				);
				expect(
					app.state.visibleTickets(app.config.taskRules, app.config.defaultTaskType)[0]?.state,
				).toBe("awaiting");
				expect(app.state.lastCompletion(identity)?.decision ?? null).toBeNull();
				const frame = await settle(setup);
				expect(ticketRow(frame)).toContain("[awaiting]");
				expect(frame).not.toContain("Live:");
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
		const app = seededApp("awaiting", {}, success, "live-worktree", { message: lines });
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const thumbRowOf = (frame: string) => rowsOf(frame).findIndex((row) => row.includes("█"));

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				const panel = await settle(setup);
				const text = frameText(panel);
				// The near-fullscreen modal gives the terminal's last two rows to
				// its own Message line and Action bar, and the log window is what
				// the box has left. It opens at the bottom, where the agent's
				// conclusion is, and the scrollbar thumb rests there.
				const shown = rowsOf(panel).filter((row) => /log \d\d\d/.test(row)).length;
				expect(shown).toBeGreaterThan(2);
				expect(text).toContain(`log ${String(41 - shown).padStart(3, "0")}`);
				expect(text).toContain("log 040");
				expect(text).toContain("█");
				const bottomThumbRow = thumbRowOf(panel);
				expect(bottomThumbRow).toBeGreaterThan(-1);

				// k scrolls up through the log, one row per press. Each press
				// drops the newest row; two presses move the thumb with the log.
				// `first(n)` is the oldest line still on screen after n steps up.
				const first = (steps: number) => `log ${String(41 - shown - steps).padStart(3, "0")}`;
				const last = (steps: number) => `log ${String(40 - steps).padStart(3, "0")}`;
				await press(setup, "k", "one row up", (f) => f.includes(first(1)) && !f.includes(last(0)));
				const higher = await press(
					setup,
					"k",
					"one more row up",
					(f) => f.includes(first(2)) && !f.includes(last(1)),
				);
				expect(thumbRowOf(higher)).toBeLessThan(bottomThumbRow);
				// j scrolls back down and brings the thumb with it.
				const backDown = await press(
					setup,
					"j",
					"one row down",
					(f) => f.includes(last(1)) && !f.includes(first(2)),
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
		const app = seededApp("awaiting", {}, success, "live-worktree", {
			message: conclusion,
			turnLog: [
				{ kind: "text", text: "I will run the tests." },
				{ kind: "tool", name: "bash", target: "npm test", failed: false },
				{ kind: "tool", name: "bash", target: "npm run lint", failed: true },
				{ kind: "text", text: conclusion },
			],
		});
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressEnterQuiet(setup, "the decision modal", (f) => f.includes("Decision:"));
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
				// The shared Action bar offers the log's scroll key.
				expect(modal).toContain("j/k Scroll log");

				// The failed tool call wears the warning color, the passing one
				// the dim one. Both are painted, so the notes are on screen. The
				// pop-in fades in for a little while, so wait it out before
				// reading the painted colors: mid-fade they are blended.
				await sleep(250);
				expect(spanColors(setup, "npm run lint")).toContainEqual(rgb(roleColor("yellow")));
				expect(spanColors(setup, "npm test")).toContainEqual(rgb(roleColor("subtext0")));
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
		const app = seededApp("awaiting", {}, success, "live-worktree", { message: lines });
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
				// still alive for this ticket and where its cleanup lives.
				const shown = setup.captureCharFrame();
				expect(ticketRow(shown)).toContain("leftover");
				const detail = detailPaneText(shown);
				expect(detail).toContain("Leftover: herdr workspace ws-1");
				expect(detail).toContain("its cleanup runs in herdr");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("w on a leftover ticket opens no panel and runs no command; the fact stands", async () => {
		// The key the clear had is free (ADR 0032): a press on a ticket that
		// holds a leftover environment reaches no control. The acceptance
		// answer is the absence - no panel, no herdr command, and the leftover
		// fact untouched.
		const app = seededApp("awaiting", {}, success, "worktree");
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], DIRTY_REMOVAL);

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
				const commandsBefore = app.runner.commands();
				setup.mockInput.pressKey("w");
				const frame = await settle(setup);
				// No panel and no reopened decision, and no herdr command ran.
				expect(frame).not.toContain("Leftover environment");
				expect(frame).not.toContain("Decision:");
				expect(app.runner.commands()).toEqual(commandsBefore);
				// The leftover fact still stands: the marker on the row, the
				// block in the detail, and its herdr pointer.
				expect(ticketRow(frame)).toContain("leftover");
				const detail = detailPaneText(frame);
				expect(detail).toContain("Leftover: herdr workspace ws-1");
				expect(detail).toContain("its cleanup runs in herdr");
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
			listModels: (kind) => app.runner.listModels(kind),
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
			// The agent ran a while before it died: the handoff is past the
			// startup grace, so the missing agent is not a booted one.
			{ stateNow: () => Date.now() - 600_000 },
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

	test("queued Close cleanups finish before their queued handoff starts", async () => {
		const app = seededApp("awaiting", {}, pairSuccess, "worktree");
		stubCheckout(app);
		const second = app.state.claimHandoff(
			secondIdentity,
			{
				agentType: "pi",
				environment: "worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
			"open",
		);
		if (!second.ok) throw new Error(second.reason);
		app.state.settleHandoff(second.claim.attemptId, true, undefined, {
			paneId: "pane-2",
			tabId: "tab-2",
			workspaceId: "ws-2",
		});
		app.state.settleTurn({
			ticketIdentity: secondIdentity,
			handoffId: second.claim.attemptId,
			taskType: "implement",
			agentType: "pi",
			message: "The second turn is done.",
			turnLog: [{ kind: "text", text: "The second turn is done." }],
			completedAt: "2026-09-02T11:00:00.000Z",
		});
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
		const gate = gatedRunner(app, (command) => command.startsWith("herdr worktree remove"));

		await withApp(
			async (setup) => {
				app.src.settle(pairSuccess);
				await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[awaiting]"),
					"the first awaiting ticket",
				);
				await pressReturn(setup, "the first decision", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the first Close cleanup", () => gate.busy());
				await awaitFrame(setup, (f) => !f.includes("Decision:"), "the first panel closing");

				await pressArrow(setup, "up", "the second ticket", (f) =>
					detailPaneText(f).includes("External key: #6"),
				);
				await pressReturn(setup, "the second decision", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the queued second Close cleanup", (f) =>
					ticketRow(f, "Watch agent turns").includes("[open]"),
				);
				// The second ticket is open again. Its handoff claims now, but the
				// cleanup seat keeps its external work out of herdr.
				await settleReverify(app.src, pairSuccess);
				setup.mockInput.pressEnter();
				await settle(setup);

				gate.release();
				await awaitFrame(setup, () => gate.arrivals() === 2, "the second cleanup reaching herdr");
				expect(app.runner.commands()).not.toContain("herdr workspace list");

				gate.release();
				await awaitFrame(
					setup,
					() => app.runner.commands().includes("herdr workspace list"),
					"the queued handoff after both cleanups",
				);
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

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
		reverify(app, success, "2026-09-02T09:31:00.000Z");
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
			{
				agentType: "pi",
				environment: "worktree",
				taskType: "implement",
				model: "",
				thinking: "",
				contextWindow: "",
			},
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

	test("the leftover block keeps its warning colour", async () => {
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
				// fact, its reason, and its herdr pointer all carry it.
				expect(spanColors(setup, "Leftover: herdr workspace ws-1")).toEqual([
					rgb(roleColor("yellow")),
				]);
				expect(spanColors(setup, "its cleanup runs in herdr")).toEqual([rgb(roleColor("yellow"))]);
			},
			WIDTH,
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
	 * says so. The shared gate is the one the Handoff dispatch module tests use,
	 * so the seat rule is driven by one runner double everywhere.
	 */
	function gatedRunner(app: SeededApp, matches: (command: string) => boolean): GatedRunner {
		return gateOnRunner(app.runner, matches);
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
	async function closeAndHandOffAgain(setup: AppSetup, src: FakeSource): Promise<void> {
		await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
		await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
		await pressReturn(setup, "the close", (f) => ticketRow(f).includes("leftover"));
		await settleReverify(src, success);
		// Enter on the open ticket: the leftover does not stop it.
		await pressReturn(setup, "the handoff", (f) => ticketRow(f).includes("[handed-off]"));
	}

	test("a handoff beside its own leftover agent starts anyway and says so", async () => {
		const app = leftoverNameApp();

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await closeAndHandOffAgain(setup, app.src);
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

	test("an earlier own collision stays durable when a later name belongs to a stranger", async () => {
		const app = leftoverNameApp();
		// The earlier close succeeded, so the ticket has its old handoff handles
		// but no durable fact. The name collision itself must create that fact.
		app.runner.set("herdr", ["worktree", "remove", "--workspace", "ws-1"], { code: 0 });
		const collisionRunner: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr" &&
				args[0] === "agent" &&
				args[1] === "start" &&
				args[2] !== "persist-source-facts"
					? Promise.resolve({
							code: 1,
							stdout: "",
							stderr:
								'{"error":{"code":"agent_name_taken","message":"agent name persist-source-facts-c2 is already used; candidates: terminal_id=term_2 pane_id=pane-stranger workspace_id=ws-stranger tab_id=tab-stranger cwd=unknown status=Idle"}}\n',
						})
					: app.runner.run(command, args, options),
			listModels: (kind) => app.runner.listModels(kind),
		};

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => ticketRow(f).includes("[awaiting]"), "the awaiting ticket");
				await pressReturn(setup, "the decision modal", (f) => f.includes("Decision:"));
				await pressReturn(setup, "the close", (f) => ticketRow(f).includes("[open]"));
				await settleReverify(app.src, success);
				await pressReturn(setup, "the handoff stopped by the stranger", (f) =>
					f.includes("pane pane-stranger"),
				);
				// The stranger blocks the new name, but the stable name was still
				// this ticket's own leftover. That first collision remains a fact.
				expect(app.state.leftoverEnvironment(identity)).toEqual(
					expect.objectContaining({ paneId: "pane-1", workspaceId: "ws-1" }),
				);
				expect(ticketRow(setup.captureCharFrame())).toContain("leftover");
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: collisionRunner },
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
			listModels: (kind) => app.runner.listModels(kind),
		};

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await closeAndHandOffAgain(setup, app.src);
				// One Message line carries both facts: the failure first, the name
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
					(f) => f.includes("auto: on 1/2") && ticketRow(f).includes("missing"),
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

	test("an auto-handoff starts on the settings its task profile resolves", async () => {
		// ADR 0009: an unattended handoff resolves through the same chain the
		// panel shows, so the profile's own agent, model, and level start it.
		const app = seededApp("open", {
			autoHandoff: true,
			defaultModel: "anthropic/claude-sonnet-4-5",
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					agent: "codex",
					thinking: "high",
				},
			},
		});
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
				// An open ticket already shows its profile's agent in the detail
				// pane, so the wait resolves on the handoff itself: the pane's
				// task type row says `Handoff` only once the ticket is no longer
				// open, and the start command lands before that claim.
				await awaitFrame(setup, (f) => f.includes("Handoff task type: implement"), "the dispatch");
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				// The profile's agent, then that agent's settings: codex names its
				// level as a -c pair, and the default model resolves onto it.
				expect(start).toContain(
					"--kind codex --pane pane-1 -- --model anthropic/claude-sonnet-4-5 -c model_reasoning_effort=high",
				);
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("an unfit model fails an auto-handoff before it touches herdr", async () => {
		// ADR 0010: the fit check guards the unattended route too. The fake
		// reports a pi list without the profile's model, so the dispatch dies
		// on the check, not inside an agent terminal.
		const app = seededApp("open", {
			autoHandoff: true,
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, model: "gpt-4o" },
			},
		});
		stubCheckout(app);
		app.runner.setModelList("pi", ["anthropic/claude-sonnet-4-5"]);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("has no model"), "the refused dispatch");
				// The handoff never reached herdr: no workspace, no agent start.
				expect(app.runner.commands().some((c) => c.startsWith("herdr workspace"))).toBe(false);
				expect(app.runner.commands().some((c) => c.startsWith("herdr agent start"))).toBe(false);
				// The ticket stays open and dispatchable once the config is fixed.
				expect(ticketRow(setup.captureCharFrame())).toContain("[open]");
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
						f.includes("auto: on 2/2") &&
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

	test("the same-type hold withholds a finished ticket its item still lists", async () => {
		// ADR 0026: the shape of the loop the hold stops. The implement turn
		// completes while its item stays open - the follow-up work rides a
		// pull request, and the work signal the source query filters on is
		// still up. The auto-close ends the cycle, the source re-read
		// re-verifies the still-open item, and the open auto-handoff must
		// hold the ticket instead of re-running the completed type. A pair
		// ticket with no closed cycle dispatches in the same cycle: the loop
		// runs, and the finished work does not repeat.
		const app = seededApp(
			"awaiting",
			{ autoHandoff: true, workflows: [] },
			pairSuccess,
			"live-worktree",
			{ cause: "completed" },
		);
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
				// The first cycles: the turn settles, the auto-close ends the
				// cycle, and the pair takes the dispatch. The finished ticket
				// rests open, waiting on the re-read its close provoked.
				await awaitFrame(
					setup,
					(f) =>
						f.includes("auto: on 1/2") &&
						ticketRow(f).includes("[open]") &&
						ticketRow(f, "Watch agent turns").includes("missing"),
					"the auto close and the pair dispatch",
				);
				expect(app.state.lastCompletion(identity)?.decision).toBe("auto-closed");
				// The re-read lands after the decision: the re-verify gate opens
				// for the finished ticket, and the next cycle re-runs the
				// dispatch. The same-type hold withholds it.
				await settleReverify(app.src, pairSuccess);
				const held = await settle(setup);
				expect(ticketRow(held)).toContain("[open]");
				expect(app.runner.commands().filter((c) => c.startsWith("herdr agent start"))).toEqual([
					"herdr agent start watch-agent-turns --kind pi --pane pane-1",
				]);
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), pollIntervalMs: 20 },
		);
		app.state.close();
	});

	test("an open handoff its agent cannot take reports the ticket it failed", async () => {
		// The same loud rule on the other automatic path: an open Ticket's own
		// handoff resolves a Model its Agent maps no argument for, so nothing
		// starts, and the report names the ticket rather than only the reason.
		const app = seededApp("open", {
			autoHandoff: true,
			defaultModel: "factory-model",
			agents: { ...BASE_CONFIG.agents, cursor: { kind: "cursor" } },
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: { ...BASE_CONFIG.taskTypes.implement, agent: "cursor" },
			},
		});
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });

		await withApp(
			async (setup) => {
				app.src.settle(success);
				const failed = await awaitFrame(
					setup,
					(f) => frameText(f).includes("auto-handoff for ticket"),
					"the failed automatic handoff",
				);
				expect(frameText(failed)).toContain("no model setting");
				// Nothing ran, and the ticket stayed the open ticket it was.
				expect(app.runner.commands().some((c) => c.startsWith("herdr agent start"))).toBe(false);
				expect(app.state.ticketState(identity)).toBe("open");
				expect(ticketRow(failed)).toContain("[open]");
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
		const review = { ...BASE_CONFIG.taskTypes.review };
		review.template += "\n\nPrevious work message:\n{previous-message}";
		const app = seededApp("awaiting", {
			autoHandoff: true,
			taskTypes: { ...BASE_CONFIG.taskTypes, review },
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
				expect(["handed-off", "running"]).toContain(app.state.ticketState(identity) ?? "");
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

	test("an automatic route resolves the target profile's model, not the settled one", async () => {
		// Story 25 and story 26 on the unattended path: the loop's route resolves
		// agent, model, and thinking through the target task profile's chain, and
		// its fit check reads the same resolved value the start carries.
		const app = seededApp(
			"awaiting",
			{
				autoHandoff: true,
				taskTypes: {
					...BASE_CONFIG.taskTypes,
					review: { ...BASE_CONFIG.taskTypes.review, model: "anthropic/claude-review-4" },
				},
			},
			success,
			"live-worktree",
			{
				message: "The turn is done.",
				// The model the settled handoff ran on: a route must not inherit it.
				model: "opus-4",
				thinking: "high",
			},
		);
		stubCheckout(app);
		app.runner.setModelList("pi", ["anthropic/claude-review-4"]);
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
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				await awaitFrame(setup, (f) => f.includes("auto-handed-off"), "the automatic route");
				const start = app.runner
					.commands()
					.find((command) => command.startsWith("herdr agent start"));
				expect(start).toContain("--model anthropic/claude-review-4");
				// The settled handoff's own model never rides on the route.
				expect(start).not.toContain("opus-4");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});

	test("an auto route its agent cannot take starts nothing and decides nothing", async () => {
		// The review's own setup: the flow's one edge routes to a task type whose
		// profile names an agent that maps no Model setting, beside a configured
		// default model. The route can only fail, and it fails before any
		// external step, so it must leave the turn as undecided as it was: the
		// trace records a route only once an agent runs.
		const app = seededApp("awaiting", {
			autoHandoff: true,
			defaultAgent: "claude",
			defaultModel: "factory-model",
			agents: { ...BASE_CONFIG.agents, claude: { kind: "claude" } },
			workflows: [{ from: "implement", to: ["review"] }],
		});
		stubCheckout(app);
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: Object.values(app.config.repos)[0] }]),
		});

		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The loud reason reaches the status line, and it names the ticket
				// the route was for.
				const failed = await awaitFrame(
					setup,
					(f) => frameText(f).includes("automatic route for ticket"),
					"the failed automatic route",
				);
				expect(frameText(failed)).toContain("no model setting");
				// Nothing the record claims happened did happen: no agent started,
				// and the settled turn holds no decision at all.
				expect(app.runner.commands().some((c) => c.startsWith("herdr agent start"))).toBe(false);
				expect(app.state.ticketState(identity)).toBe("awaiting");
				expect(app.state.lastCompletion(identity)?.decision).toBe(null);
				expect(failed).not.toContain("auto-handed-off");

				// The ticket stayed awaiting, so the live agent that finished the
				// turn reopens it as it always does, and the undecided trace keeps
				// Close and Goto offered beside it. A route that consumed its own
				// decision would leave the operator with a settled turn that could
				// be neither routed nor closed.
				app.runner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "persist-source-facts",
							status: "working",
						},
					]),
				});
				const reopened = await awaitFrame(
					setup,
					(f) => ticketRow(f).includes("[running]"),
					"the reopened turn",
				);
				expect(ticketRow(reopened)).toContain("[running]");
				// And the turn it reopened is the same undecided turn: the record
				// still holds no decision for a route that never started.
				expect(app.state.ticketState(identity)).toBe("running");
				expect(app.state.lastCompletion(identity)?.decision).toBe(null);
			},
			WIDTH,
			HEIGHT,
			// A short interval keeps the route coming back each cycle: the failed
			// start must not consume the turn it came from, cycle after cycle.
			{ ...propsOf(app), pollIntervalMs: 25 },
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
				contextWindow: "",
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
				contextWindow: "",
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
			...BASE_CONFIG,
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
				// updates (the observation tick, the Message line) to go quiet:
				// a key that lands while they are in flight stalls the test
				// renderer.
				const pressQuietFor = (
					key: Parameters<typeof press>[1],
					what: string,
					predicate: (f: string) => boolean,
				) => pressQuiet(setup, key, what, predicate);
				const pressReturnQuietFor = (what: string, predicate: (f: string) => boolean) =>
					pressEnterQuiet(setup, what, predicate);
				// Hand off the open ticket: it runs, and it holds the seat.
				// The mode line, the Ticket header, the list box border, and
				// the box's padding row sit above the list rows, so the two
				// tickets sit on frame lines four and five. The in-flight
				// ticket is first, and it is the initial selection, so the
				// move down lands the marker on line five - a line it was not
				// on, so the key is applied before the next key is pressed.
				await pressQuietFor("j", "select the open ticket", (f) => markerRowOf(f) === 5);
				await pressReturnQuietFor("the handoff to start", (f) => f.includes("handing off"));
				// Back to the missing ticket: its restart queues behind the
				// handoff in flight.
				await pressQuietFor("k", "select the missing ticket", (f) => markerRowOf(f) === 4);
				await pressReturnQuietFor("the missing modal", (f) => f.includes("Missing:"));
				await pressReturnQuietFor("the restart to queue", (f) => !f.includes("Missing:"));
				// And while the restart is queued, the ticket moves on:
				// abandon it.
				await pressReturnQuietFor("the missing modal again", (f) => f.includes("Missing:"));
				await pressArrow(setup, "down", "select abandon", (f) =>
					frameText(f).includes("❯ Abandon"),
				);
				await sleep(150);
				await pressReturnQuietFor("the abandonment", (f) =>
					ticketRow(f, "Watch agent turns").includes("[open]"),
				);
				// The abandonment re-reads the ticket's sources: let that
				// fetch land, so the observation loop ticks and the pickup
				// meets the item. The ticket is open now, so the restart's
				// pickup refuses and the item keeps its place.
				src.settle({
					status: "success",
					fetchedAt: new Date(Date.now() + 60_000).toISOString(),
					tickets: pairMoved.tickets,
				});
				await awaitFrame(setup, (f) => f.includes("was not run"), "the pickup warning", 5000);
				expect(frameText(setup.captureCharFrame())).toContain(
					'queued handoff for "Watch agent turns" was not run: the ticket is now open',
				);

				// The open ticket's handoff started once; no agent started for
				// the ticket that moved on, and its item still waits in the
				// Work queue with its captured restart choice.
				const starts = inner.commands().filter((c) => c.startsWith("herdr agent start"));
				expect(starts).toEqual(["herdr agent start persist-source-facts --kind pi --pane pane-1"]);
				expect(state.workQueueIdentity(secondIdentity)).toBe(secondIdentity);
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
				// again on demand. It is the second row (row five: the mode
				// line, the Ticket header, the border, and the padding row
				// sit above the list), and the abandonment left the
				// selection on it, so the selection is probed instead of
				// stepped: a move down from the last row would cross into
				// the Consultation section.
				const held = await settle(setup);
				expect(markerRowOf(held)).toBe(5);
				await settleReverify(src, pairMoved);
				await pressReturnQuietFor("the re-handoff", (f) => f.includes("handing off"));
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
