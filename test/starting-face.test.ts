/**
 * The spinner face the Starting window wears in place of the state badge
 * (ADR 0030), through the real application flow.
 *
 * A ticket's Starting window is the claim this run made on it, or the
 * `handed-off` state the claim settled into. In the window the row and the
 * detail header wear the animated spinner face beside its written word; the
 * `[handed-off]` badge is never drawn. The timeline is tested with fake
 * external operations and isolated test state: the manual hand-off, the
 * failed start, the auto hand-off, the workflow route, and the restart of a
 * crash remnant, each from the keypress or the dispatch to the first
 * observation. The failure marker outranks the face, and a crash remnant
 * wears its recovery fact, never the spinner.
 *
 * The face steps its braille frame every ~100 ms, so the checks run on the
 * written word beside any of the shared frames; the animation itself is not
 * what the frame snapshots verify.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppProps } from "../src/components/app.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	awaitFrame,
	frameText,
	HEIGHT,
	listHalfOf,
	markerRowOf,
	messageRowOf,
	press,
	pressArrow,
	rowsOf,
	settle,
	spanColorAt,
	startingFaceOf,
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
import { type GatedRunner, gatedRunner } from "./gated-runner.ts";
import "./theme-isolation.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const source = { name: "issues", kind: "github-issues" };
const identity = "github:github.com:I_5";
const repoIdentity = "github.com/acme/factory";

function fetched(index = 5): FetchedTicket {
	return {
		identity: `github:github.com:I_${index}`,
		sourceKind: "github-issue",
		externalKey: `#${index}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${index}`,
		title: "Persist source facts",
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/factory",
			cloneUrl: `https://${repoIdentity}.git`,
		},
		attributes: {},
	};
}

const success: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [fetched()],
};

/** Stub the git answers for the checkout the config maps to. */
function stubCheckout(runner: FakeRunner, checkout: string): void {
	runner.set("git", ["-C", checkout, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	runner.set("git", ["-C", checkout, "remote", "get-url", "origin"], {
		stdout: `https://${repoIdentity}.git\n`,
	});
}

/** The checkout directory the seeded config maps the ticket's repository to. */
const checkoutOf = (config: FactoryConfig): string => Object.values(config.repos)[0] as string;

interface SeedDetail {
	/** The state's clock. Pin it in the past to age the stored handoff past its startup grace. */
	stateNow?: () => number;
	/** The cause the settled turn takes: the default `completed` leaves the ticket undetermined. */
	cause?: "completed" | "failed";
}

/**
 * A state with the ticket in the given shape: open, in flight with the
 * stored herdr handles, or awaiting with a settled completion.
 */
function seed(shape: "open" | "in-flight" | "awaiting", detail: SeedDetail = {}): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-face-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"), detail.stateNow);
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
				contextWindow: "",
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
				message: "The turn is done.",
				turnLog: [{ kind: "text", text: "The turn is done." }],
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

/** A seeded state plus the app props that match it. */
function seededApp(
	shape: "open" | "in-flight" | "awaiting",
	extra: Partial<FactoryConfig> = {},
	detail: SeedDetail = {},
): SeededApp {
	const state = seed(shape, detail);
	const home = mkdtempSync(join(tmpdir(), "factory-face-home-"));
	paths.push(home);
	const repo = mkdtempSync(join(tmpdir(), "factory-face-repo-"));
	paths.push(repo);
	const configPath = join(home, "config.toml");
	writeFileSync(configPath, "agent-poll-interval-seconds = 60\n");
	const config: FactoryConfig = {
		...BASE_CONFIG,
		repos: { [repoIdentity]: repo },
		...extra,
	};
	const runner = new FakeRunner();
	const src = new FakeSource("issues", "github-issues", success);
	return { state, config, runner, configPath, src };
}

/**
 * The observation loop on a short cycle: the first observation lands while
 * the test still holds its gate, and the settle it reports is the frame the
 * timeline moves on.
 */
const POLL_MS = 40;

function propsOf(app: SeededApp): AppProps {
	return {
		config: app.config,
		state: app.state,
		runner: app.runner,
		configPath: app.configPath,
		sources: [app.src],
		pollIntervalMs: POLL_MS,
	};
}

/** The list pane's selected row, or an empty string before the first marker. */
const selectedRow = (frame: string): string => {
	const index = markerRowOf(frame);
	return index >= 0 ? rowsOf(frame)[index] : "";
};

/** The face the selected row wears, or null. */
const face = (frame: string): string | null => startingFaceOf(listHalfOf(selectedRow(frame)));

/** The list pane's half of the selected row, where the state badge sits. */
const badgeRow = (frame: string): string => listHalfOf(selectedRow(frame));

/** How many faces stand in the frame: the list row's, and the detail header's. */
const faceCount = (frame: string): number => (frame.match(/ starting/g) ?? []).length;

/** Stub a successful live-worktree handoff at the convention checkout. */
function stubLiveHandoff(runner: FakeRunner, checkout: string): void {
	runner.set("herdr", ["workspace", "list"], { stdout: workspaceListJson([]) });
	runner.set("herdr", ["workspace", "create", "--cwd", checkout, "--no-focus"], {
		stdout: workspaceCreateJson("ws-1"),
	});
	runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--cwd", checkout, "--no-focus"], {
		stdout: tabCreateJson("pane-1"),
	});
}

/** Hold the agent's start itself, so the claim stands in flight on screen. */
const gateStart = (runner: FakeRunner): GatedRunner =>
	gatedRunner(runner, (command) => command.includes("agent start"));

/** The herdr agent list where pane-1 works. */
const workingList = () =>
	agentListJson([
		{ paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1", agent: "pi", status: "working" },
	]);

describe("the Starting window's timeline", () => {
	test("the manual hand-off wears the face from the keypress to the first observation", async () => {
		const app = seededApp("open");
		stubCheckout(app.runner, checkoutOf(app.config));
		stubLiveHandoff(app.runner, checkoutOf(app.config));
		app.runner.set("herdr", ["agent", "list"], { stdout: workingList() });
		const gate = gateStart(app.runner);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// Enter: the face lands on the keypress, before the agent
				// starts, and the badge is nowhere in the frame.
				const inFlight = await press(
					setup,
					"return",
					"the face on the keypress",
					(f) => face(f) !== null && messageRowOf(f).includes("Working: handing off"),
				);
				expect(inFlight).not.toContain("[handed-off]");
				// The row and the detail header wear the same face.
				expect(faceCount(inFlight)).toBe(2);
				// The counts keep the resting rule: the claim is not a step yet.
				expect(inFlight).toContain("open: 1  running: 0  awaiting: 0");
				// The start settles into `handed-off`: the face stays, and the
				// first observation steps the ticket to running in its place.
				gate.release();
				const running = await awaitFrame(
					setup,
					(f) => badgeRow(f).includes("[running]"),
					"the ticket to run",
				);
				expect(face(running)).toBeNull();
				expect(running).toContain("open: 0  running: 1  awaiting: 0");
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

	test("a failed start drops the face and returns the row to its state", async () => {
		const app = seededApp("open");
		stubCheckout(app.runner, checkoutOf(app.config));
		stubLiveHandoff(app.runner, checkoutOf(app.config));
		// The workspace create is the failing step: the gate holds it while
		// the claim stands in flight, and the failure lands on the release.
		app.runner.set(
			"herdr",
			["workspace", "create", "--cwd", checkoutOf(app.config), "--no-focus"],
			{
				code: 1,
				stderr: "error: the workspace is not creatable\n",
			},
		);
		app.runner.set("herdr", ["agent", "list"], { stdout: workingList() });
		const gate = gatedRunner(app.runner, (command) => command.startsWith("herdr workspace create"));
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const inFlight = await press(
					setup,
					"return",
					"the face on the keypress",
					(f) => face(f) !== null && messageRowOf(f).includes("Working: handing off"),
				);
				expect(face(inFlight)).not.toBeNull();
				gate.release();
				const failed = await awaitFrame(
					setup,
					(f) => badgeRow(f).includes("[open]") && face(f) === null,
					"the row to return",
				);
				expect(messageRowOf(failed)).toContain("Error:");
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

	test("the auto hand-off wears the face while its start stands", async () => {
		const app = seededApp("open", { autoHandoff: true });
		stubCheckout(app.runner, checkoutOf(app.config));
		stubLiveHandoff(app.runner, checkoutOf(app.config));
		app.runner.set("herdr", ["agent", "list"], { stdout: workingList() });
		const gate = gateStart(app.runner);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// No key: the observation dispatches, and the face wears from
				// the claim the dispatch makes.
				const inFlight = await awaitFrame(
					setup,
					(f) => face(f) !== null && f.includes("auto: on"),
					"the dispatched face",
				);
				expect(inFlight).not.toContain("[handed-off]");
				gate.release();
				await awaitFrame(setup, (f) => badgeRow(f).includes("[running]"), "the ticket to run");
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

	test("a workflow route over a held turn wears the face, and a failed start gives the held face back", async () => {
		const app = seededApp(
			"awaiting",
			{ workflows: [{ from: "implement", to: ["review"] }] },
			{ cause: "failed" },
		);
		stubCheckout(app.runner, checkoutOf(app.config));
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		// The stored workspace still holds: the route reuses it in a new tab,
		// and the start itself fails on the release.
		const path = checkoutOf(app.config);
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: path }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-9", "tab-9"),
		});
		app.runner.set(
			"herdr",
			["agent", "start", "persist-source-facts", "--kind", "pi", "--pane", "pane-9"],
			{
				code: 1,
				stderr: "error: the pane is gone\n",
			},
		);
		const gate = gateStart(app.runner);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const held = await awaitFrame(
					setup,
					(f) => badgeRow(f).includes("held"),
					"the held ticket",
				);
				expect(face(held)).toBeNull();
				// Enter shows the decision; the workflow handoff is the last
				// row, and its confirm claims the ticket.
				await press(setup, "return", "the decision modal", (f) => f.includes("Decision:"));
				await pressArrow(setup, "down", "the goto row", (f) => f.includes("❯ Goto"));
				await pressArrow(setup, "down", "the handoff row", (f) =>
					frameText(f).includes("❯ Handoff: review"),
				);
				const claimed = await press(setup, "return", "the routed face", (f) => face(f) !== null);
				// The claim's face outranks the held badge while the start
				// stands...
				expect(badgeRow(claimed)).not.toContain("held");
				// ...and a failed start gives the held face back: the window
				// closed, and the state rules decide the resting face.
				gate.release();
				const back = await awaitFrame(
					setup,
					(f) => badgeRow(f).includes("held") && face(f) === null,
					"the held face to return",
				);
				expect(messageRowOf(back)).toContain("Error:");
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

	test("a crash remnant wears its recovery fact, never the spinner, and its restart wears the face", async () => {
		// The handoff stored a minute ago: past its startup grace, so the
		// missing agent is a death, not a slow boot, and the automatic restart
		// stands behind it.
		const app = seededApp(
			"in-flight",
			{ autoHandoff: true },
			{ stateNow: () => Date.now() - 60_000 },
		);
		stubCheckout(app.runner, checkoutOf(app.config));
		// The new pane the restart lands in stands in the list: unknown while
		// the start stands, working once it answers, so the markers and the
		// step to running both come from the list.
		const list = (status: string) =>
			agentListJson([
				{
					paneId: "pane-2",
					tabId: "tab-2",
					workspaceId: "ws-1",
					agent: "pi",
					status,
				},
			]);
		app.runner.set("herdr", ["agent", "list"], { stdout: list("unknown") });
		const path = checkoutOf(app.config);
		app.runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-1", checkoutPath: path }]),
		});
		app.runner.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
			stdout: tabCreateJson("pane-2", "tab-2"),
		});
		const gate = gateStart(app.runner);
		await withApp(
			async (setup) => {
				app.src.settle(success);
				// The remnant boots wearing the missing marker: its stored pane
				// is not in the list, and the recovery fact outranks the face,
				// so the spinner is not drawn.
				const remnant = await awaitFrame(
					setup,
					(f) => badgeRow(f).includes("missing"),
					"the crash remnant",
				);
				expect(face(remnant)).toBeNull();
				// The automatic restart claims the ticket behind its own gate...
				await gate.waitForArrivals(1);
				// ...and the start settles into `handed-off` on the new pane.
				// The missing marker is gone with the old pane, and the row
				// wears the face until the agent reports a step.
				gate.release();
				const restarted = await awaitFrame(setup, (f) => face(f) !== null, "the restart's face");
				expect(badgeRow(restarted)).not.toContain("missing");
				expect(restarted).not.toContain("[handed-off]");
				// The agent answers working, and the row steps to running.
				app.runner.set("herdr", ["agent", "list"], { stdout: list("working") });
				await awaitFrame(setup, (f) => badgeRow(f).includes("[running]"), "the ticket to run");
			},
			WIDTH,
			HEIGHT,
			{ ...propsOf(app), runner: gate.runner },
		);
		app.state.close();
	});

	test("an awaiting ticket rests on its own face: the window closed", async () => {
		const app = seededApp("awaiting");
		stubCheckout(app.runner, checkoutOf(app.config));
		app.runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		await withApp(
			async (setup) => {
				app.src.settle(success);
				const resting = await awaitFrame(
					setup,
					(f) => badgeRow(f).includes("[awaiting]"),
					"the awaiting ticket",
				);
				expect(face(resting)).toBeNull();
				expect(resting).not.toContain(" starting");
			},
			WIDTH,
			HEIGHT,
			propsOf(app),
		);
		app.state.close();
	});
});

describe("the no-color presentation", () => {
	test("NO_COLOR keeps the face's written word in the row and the detail, and drops its color", async () => {
		process.env.NO_COLOR = "1";
		await withApp(async (setup) => {
			// The sample data carries a handed-off ticket, so its face stands
			// on the boot frame; selecting it puts the same face in the detail.
			await settle(setup);
			const booted = await settle(setup);
			const faceRow = rowsOf(booted).findIndex((row) => startingFaceOf(row) !== null);
			expect(faceRow).toBeGreaterThanOrEqual(0);
			await press(setup, "j", "the handed-off ticket", (f) => faceCount(f) === 2);
			const frame = await settle(setup);
			const faceRows = rowsOf(frame).filter((row) => startingFaceOf(row) !== null);
			// The row and the detail header both wear the word...
			expect(faceRows.length).toBe(2);
			for (const row of faceRows) {
				// ...and neither wears a color: the presentation is the
				// terminal's own default.
				expect(spanColorAt(setup, rowsOf(frame).indexOf(row), "starting")).toEqual([255, 255, 255]);
			}
		});
	});
});
