/**
 * The repository select panel tests (ADR 0082): the `o` key opens the list
 * the operator picks the next repository to init from.
 *
 * The tests boot the plane at a fixed size and press the panel's keys the way
 * the operator does: `o` opens, typing filters, Enter selects, Esc closes.
 * The read is one canned GitHub answer on the fake runner, and the selection
 * runs the real checkout resolution and planning against the fake commands,
 * so the path from a list row to the confirmation panel is the plane's own.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import type { StandingFacts } from "../src/components/controls.ts";
import { RepositorySelectPanel } from "../src/components/repository-select-panel.ts";
import { SPINNER_FRAMES } from "../src/components/shared/spinner.ts";
import { type InitableRepository, VIEWER_REPOSITORIES_QUERY } from "../src/repository-list.ts";
import {
	awaitFrame,
	closeOverlay,
	HEIGHT,
	messageRowOf,
	pressScrollKey,
	rowsOf,
	settle,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { agentListJson, FakeRunner } from "./fake-runner.ts";
import { withholdPassiveFlushes } from "./passive-flush-hold.ts";
import { cleanupStateFixtures, freshState } from "./state-fixture.ts";

/** The viewer answer the list stands on in these tests. */
const VIEWER = {
	login: "seriousjul",
	repositories: {
		nodes: [
			{
				name: "my-little-software-factory",
				nameWithOwner: "SeriousJul/my-little-software-factory",
				url: "https://github.com/SeriousJul/my-little-software-factory",
			},
		],
	},
	organizations: {
		nodes: [
			{
				login: "acme",
				repositories: {
					nodes: [
						{
							name: "factory",
							nameWithOwner: "acme/factory",
							url: "https://github.com/acme/factory",
						},
						{
							name: "billing",
							nameWithOwner: "acme/billing",
							url: "https://github.com/acme/billing",
						},
					],
				},
			},
		],
	},
};

const viewerJson = () => JSON.stringify({ data: { viewer: VIEWER } });

/**
 * The planning commands one checkout answers, so the select list's Enter can
 * reach the confirmation panel: the branch, the fetch, the file reads, the
 * labels. The instruction file reads out as AGENTS.md, so the panel owes no
 * choice and its confirm is the plain act.
 */
const planCanned = (runner: FakeRunner, checkout: string, identity: string): void => {
	runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
		stdout: "refs/remotes/origin/main\n",
	});
	runner.set("git", ["-C", checkout, "fetch", "origin", "main"], {});
	runner.set("git", ["-C", checkout, "show", "origin/main:CLAUDE.md"], { code: 1 });
	runner.set("git", ["-C", checkout, "show", "origin/main:AGENTS.md"], {
		stdout: "existing agents\n",
	});
	runner.set("gh", ["label", "list", "--repo", `github.com/${identity}`, "--json", "name"], {
		stdout: "[]",
	});
};

/** The exact gh call the list read sends, for a canned answer. */
const viewerArgs = (host = "github.com"): readonly string[] => [
	"api",
	"graphql",
	"--hostname",
	host,
	"-f",
	`query=${VIEWER_REPOSITORIES_QUERY}`,
];

describe("the repository select panel", () => {
	test("o opens the list; the read runs once and the rows stand in the API's order", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("o");
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Init a repository"),
					"the select list to open",
				);
				// The read settles: the list rows stand, own repositories first.
				const settled = await awaitFrame(
					setup,
					(f) => f.includes("acme/billing") && f.includes("SeriousJul/my-little-software-factory"),
					"the list rows to settle",
				);
				const rows = rowsOf(settled);
				expect(rows.findIndex((row) => row.includes("acme/factory"))).toBeLessThan(
					rows.findIndex((row) => row.includes("acme/billing")),
				);
				// The read is one call.
				expect(runner.calls.filter((call) => call.command === "gh")).toHaveLength(1);
				void frame;
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner },
		);
	});

	test("typing filters the list, and Del takes the whole query back", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("o");
				await awaitFrame(setup, (f) => f.includes("acme/billing"), "the list rows to settle");
				// The query filters by substring of the display name.
				for (const letter of "billing") setup.mockInput.pressKey(letter);
				const filtered = await awaitFrame(
					setup,
					(f) => !f.includes("acme/factory") && f.includes("acme/billing"),
					"the list to filter",
				);
				expect(filtered).not.toContain("my-little-software-factory");
				// Del clears the whole query in one key.
				setup.mockInput.pressKey("delete");
				await awaitFrame(
					setup,
					(f) => f.includes("acme/factory") && f.includes("acme/billing"),
					"the list to clear back",
				);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner },
		);
	});

	test("Esc closes the list and keeps the base frame", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("o");
				await awaitFrame(setup, (f) => f.includes("Init a repository"), "the list to open");
				setup.mockInput.pressKey("escape");
				await closeOverlay(setup, "Init a repository", "the list to close");
				const frame = await settle(setup);
				expect(frame).not.toContain("Init a repository");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner },
		);
	});

	/**
	 * The pin for the deadline the loaded suite missed (issue #311).
	 *
	 * The case above is the one the loaded runs red at `FRAME_DEADLINE_MS`,
	 * and the hold puts the measured miss on a schedule a test can name.
	 * A keypress schedules the commit it owns and the commit queues the
	 * flush of the passive effects it mounted, and the reconciler puts
	 * both on a queue it runs from its own `act` completion while a queue
	 * stands in its internal seam, and on the scheduler's clock while
	 * none does. On a loaded runner that clock ran 2 to 6 ms behind the
	 * frame the same commit drew, and a wait that ended on the flush -
	 * the frame wait for the closed panel, the key-handler wait for the
	 * panel's handler to leave the bus - missed `FRAME_DEADLINE_MS` even
	 * though the app was sound. The hold here stands up the seam, so
	 * every commit and flush the case makes stands in the rig's hand
	 * until the rig runs it, and the window the loaded runner opened by
	 * chance stands open by design.
	 *
	 * The fixed wait runs what the rig holds before it reads the state it
	 * waits on: each `awaitFrame` poll flushes before it captures, and
	 * `closeOverlay` and the key-handler waits flush before they read,
	 * through `flushPassiveNow` in `test/passive-flush-hold.ts`, which
	 * walks to the fixpoint a commit and its flush need, in the rig's
	 * own turn, on every poll, hold up or not.
	 *
	 * Where this pin bites, written as a step a reviewer can re-run. The
	 * probe edits one file and is then reverted: in `test/app-harness.ts`,
	 * delete the `flushPassiveNow();` line of the poll loop in
	 * `awaitFrame`. The hold then keeps the commit the open scheduled in
	 * the rig's hand, the panel never reaches the frame, and this record
	 * goes red at the `FRAME_DEADLINE_MS` deadline on "the list to open".
	 * Every other record in this file stays green, because the hold stands
	 * only for this case's open and close.
	 */
	test("Esc closes the list when the plane's own flush lands late", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		await withApp(
			async (setup) => {
				// The plane's passive flushes land in the rig's hand, not on
				// the scheduler's clock: the loaded runner's shape, by design.
				const handFlushesBack = withholdPassiveFlushes();
				let bodyFailed = false;
				try {
					setup.mockInput.pressKey("o");
					await awaitFrame(setup, (f) => f.includes("Init a repository"), "the list to open");
					await closeOverlay(setup, "Init a repository", "the list to close");
					const frame = await settle(setup);
					expect(frame).not.toContain("Init a repository");
				} catch (error) {
					// The failure the body hit is the failure the record reports.
					// The kept check stands only for the green run.
					bodyFailed = true;
					throw error;
				} finally {
					const kept = handFlushesBack();
					if (!bodyFailed) {
						expect(kept, "the hold kept no passive flush, so it proved nothing").toBeGreaterThan(0);
					}
				}
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner },
		);
	});

	test("a read failure states its reason on the panel", async () => {
		const runner = new FakeRunner();
		runner.setDefault({ code: 4, stderr: "gh: Not logged in to github.com" });
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("o");
				await awaitFrame(setup, (f) => f.includes("Not logged in"), "the failure line");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner },
		);
	});

	test("Enter on a row without a local checkout refuses with the path it needs", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		const home = join(tmpdir(), `factory-select-home-${Date.now()}`);
		mkdirSync(home, { recursive: true });
		const state = freshState();
		try {
			await withApp(
				async (setup) => {
					setup.mockInput.pressKey("o");
					await awaitFrame(setup, (f) => f.includes("acme/billing"), "the list rows");
					for (const letter of "billing") setup.mockInput.pressKey(letter);
					await awaitFrame(setup, (f) => !f.includes("acme/factory"), "the filter to settle");
					setup.mockInput.pressEnter();
					await awaitFrame(
						setup,
						(f) => f.includes("no local checkout at") && f.includes("src/billing"),
						"the refusal with the path",
					);
					expect(messageRowOf(await settle(setup))).toContain("no local checkout at");
				},
				WIDTH,
				HEIGHT,
				{ config: BASE_CONFIG, runner, home, state },
			);
		} finally {
			cleanupStateFixtures();
		}
	});

	// The list holds the operator's whole account, so the page and edge keys
	// run the way the ticket lists run: a step per row, a page per window, an
	// edge to the end, and the window riding the cursor (ADR 0082).
	test("the page keys and the edge keys reach the ends of a long list", async () => {
		const runner = new FakeRunner();
		const repos = Array.from({ length: 40 }, (_, i) => {
			const name = `repo-${String(i).padStart(2, "0")}`;
			return { name, nameWithOwner: `acme/${name}`, url: `https://github.com/acme/${name}` };
		});
		const viewer = JSON.stringify({
			data: {
				viewer: {
					login: "seriousjul",
					repositories: { nodes: [] },
					organizations: { nodes: [{ login: "acme", repositories: { nodes: repos } }] },
				},
			},
		});
		runner.set("gh", viewerArgs(), { stdout: viewer });
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("o");
				await awaitFrame(setup, (f) => f.includes("1-12/40"), "the list rows");
				// End lands the cursor on the last row, and the window rides to it.
				const frame = await pressScrollKey(
					setup,
					"end",
					"the window at the end",
					(f) => f.includes("acme/repo-39") && !f.includes("acme/repo-00"),
				);
				expect(frame).toContain("40/40");
				// Home takes the cursor back to the first row.
				await pressScrollKey(
					setup,
					"home",
					"the window at the start",
					(f) => f.includes("acme/repo-00") && !f.includes("acme/repo-39"),
				);
				// A page down is a window of rows: the first row leaves, and the
				// cursor's row stands on the window's last row.
				await pressScrollKey(
					setup,
					"pagedown",
					"the window after the page",
					(f) => !f.includes("acme/repo-00") && f.includes("acme/repo-12"),
				);
				// A page up is a window of rows back, clamped at the start.
				await pressScrollKey(
					setup,
					"pageup",
					"the window back at the start",
					(f) => f.includes("acme/repo-00") && !f.includes("acme/repo-39"),
				);
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner },
		);
	});

	// The read's frame stands on its own (ADR 0082): the face keeps its row,
	// the note keeps its row, and the box asks for the room its content paints.
	// The app settles the read in a microtask, so the state this test holds is
	// the component's: the read never settles, and the face stands where the
	// operator finds it.
	test("the loading frame holds the face and the note in their own rows", async () => {
		const setup = await testRender(
			createElement(RepositorySelectPanel, {
				fetchRepositories: () =>
					new Promise<
						| { status: "success"; repositories: readonly InitableRepository[] }
						| { status: "failed"; reason: string }
					>(() => undefined),
				onSelect: () => undefined,
				onCancel: () => undefined,
				standing: {
					sourceCount: 0,
					refreshingSourceCount: 0,
					handoffActive: false,
					messageTruncated: false,
					consultationTypesConfigured: true,
					interactionExitKey: "f12",
					queuePaused: false,
				} satisfies StandingFacts,
				message: null,
				onEmergencyExit: () => undefined,
				// The plane-level keys resolve to the catalogue's controls; the
				// the panel's own frame is what this suite measures (issue #319).
				onQueuePause: () => undefined,
				onAutoHandoff: () => undefined,
			}),
			{ width: WIDTH, height: HEIGHT, exitOnCtrlC: false },
		);
		try {
			await setup.flush();
			const rows = rowsOf(setup.captureCharFrame());
			const faceRow = rows.findIndex((row) => row.includes("Reading repositories"));
			const noteRow = rows.findIndex((row) => row.includes("Enter selects. Esc closes."));
			expect(faceRow).toBeGreaterThan(-1);
			// The note stands below the face, whole: neither cuts the other.
			expect(noteRow).toBeGreaterThan(faceRow);
			// The face wears a glyph of its own frames beside its word.
			const glyph = SPINNER_FRAMES.find((candidate) =>
				rows[faceRow]?.includes(`${candidate} Reading`),
			);
			expect(glyph).toBeDefined();
		} finally {
			await setup.renderer.destroy();
		}
	});

	test("Enter on a row runs the plan and opens the confirmation panel", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		const home = join(tmpdir(), `factory-select-home-${Date.now()}`);
		const checkout = join(home, "src", "factory");
		mkdirSync(checkout, { recursive: true });
		// The planning commands: the branch, the fetch, the file reads, the labels.
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.set("git", ["-C", checkout, "fetch", "origin", "main"], {});
		runner.set("git", ["-C", checkout, "show", "origin/main:CLAUDE.md"], { code: 1 });
		runner.set("git", ["-C", checkout, "show", "origin/main:AGENTS.md"], {
			stdout: "existing agents\n",
		});
		runner.set("gh", ["label", "list", "--repo", "github.com/acme/factory", "--json", "name"], {
			stdout: "[]",
		});
		runner.setDefault({ code: 0, stdout: "" });
		const state = freshState();
		try {
			await withApp(
				async (setup) => {
					setup.mockInput.pressKey("o");
					await awaitFrame(setup, (f) => f.includes("acme/factory"), "the list rows");
					for (const letter of "acme/fac") setup.mockInput.pressKey(letter);
					await awaitFrame(
						setup,
						(f) => !f.includes("acme/billing") && !f.includes("my-little"),
						"the filter to settle",
					);
					setup.mockInput.pressEnter();
					// The plan settles and the confirmation panel opens on the row.
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("Init acme/factory"),
						"the confirmation panel",
					);
					expect(frame).toContain("run the act now");
				},
				WIDTH,
				HEIGHT,
				{ config: BASE_CONFIG, runner, home, state },
			);
		} finally {
			cleanupStateFixtures();
		}
	});

	// While an init plans, the base view's keyboard is live (ADR 0083): the
	// plane refuses a new open that the in-flight plan would then overwrite.
	test("a planning init refuses a new open, and opens when the plan lands", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		const home = join(tmpdir(), `factory-select-home-${Date.now()}`);
		const factory = join(home, "src", "factory");
		mkdirSync(factory, { recursive: true });
		planCanned(runner, factory, "acme/factory");
		// Hold the plan's first read, so the window the plan leaves open stands
		// long enough for the operator's key to land in it.
		runner.setDelay("git", ["-C", factory, "symbolic-ref", "refs/remotes/origin/HEAD"], 150);
		runner.setDefault({ code: 0, stdout: "" });
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const state = freshState();
		try {
			await withApp(
				async (setup) => {
					setup.mockInput.pressKey("o");
					await awaitFrame(setup, (f) => f.includes("acme/factory"), "the list rows");
					for (const letter of "acme/factory") setup.mockInput.pressKey(letter);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory") && !f.includes("acme/billing"),
						"the filter to settle",
					);
					await new Promise((r) => setTimeout(r, 25));
					setup.mockInput.pressEnter();
					// The plan holds on its first read: the open is in flight, and a
					// new open is refused with the init that holds.
					await new Promise((r) => setTimeout(r, 25));
					setup.mockInput.pressKey("o");
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("the init for acme/factory is running"),
						"the refusal line",
					);
					expect(frame).not.toContain("Init a repository");
					// The plan lands, and the panel stands where the open asked for.
					await awaitFrame(setup, (f) => f.includes("Init acme/factory"), "the confirmation");
				},
				WIDTH,
				HEIGHT,
				{ config: BASE_CONFIG, runner, home, state },
			);
		} finally {
			cleanupStateFixtures();
		}
	});

	// The queue the operator marks with Tab (ADR 0083): one repository per
	// entry, one confirmation panel per entry, in list order.
	test("Tab marks the row for the queue, and the key unmarks it", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		await withApp(
			async (setup) => {
				setup.mockInput.pressKey("o");
				await awaitFrame(setup, (f) => f.includes("acme/factory"), "the list rows");
				setup.mockInput.pressTab();
				await awaitFrame(setup, (f) => f.includes("queued"), "the queue mark");
				setup.mockInput.pressTab();
				await awaitFrame(setup, (f) => !f.includes("queued"), "the mark to lift");
			},
			WIDTH,
			HEIGHT,
			{ config: BASE_CONFIG, runner },
		);
	});

	test("a marking of two runs the queue, one confirmation per row, in list order", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		const home = join(tmpdir(), `factory-select-home-${Date.now()}`);
		const factory = join(home, "src", "factory");
		const billing = join(home, "src", "billing");
		mkdirSync(factory, { recursive: true });
		mkdirSync(billing, { recursive: true });
		planCanned(runner, factory, "acme/factory");
		planCanned(runner, billing, "acme/billing");
		runner.setDefault({ code: 0, stdout: "" });
		// A readable agent list keeps the observation quiet, so the
		// Message line holds the line the queue leaves there.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const state = freshState();
		try {
			await withApp(
				async (setup) => {
					setup.mockInput.pressKey("o");
					await awaitFrame(setup, (f) => f.includes("acme/factory"), "the list rows");
					for (const letter of "acme") setup.mockInput.pressKey(letter);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory") && f.includes("acme/billing"),
						"the filter to settle",
					);
					// A short rest lets the last typed character settle before the
					// Tab: the keys arrive in separate reads, the way an operator's
					// do. Mark both rows, in list order.
					await new Promise((r) => setTimeout(r, 25));
					setup.mockInput.pressTab();
					await awaitFrame(setup, (f) => f.includes("queued"), "the first mark");
					setup.mockInput.pressKey("j");
					await awaitFrame(
						setup,
						(f) => f.includes("❯ acme/billing") && f.includes("queued"),
						"the cursor on the second row",
					);
					setup.mockInput.pressTab();
					await awaitFrame(
						setup,
						(f) => (f.match(/queued/gu) ?? []).length === 2,
						"the second mark",
					);
					setup.mockInput.pressEnter();
					// The queue runs in list order: the first marked row opens first.
					await awaitFrame(setup, (f) => f.includes("Init acme/factory"), "the first confirmation");
					// Cancel skips the entry, and the next row's panel stands in its place.
					setup.mockInput.pressEscape();
					await awaitFrame(
						setup,
						(f) => f.includes("Init acme/billing"),
						"the second confirmation",
					);
					// The drained queue leaves its settled line on the Message line.
					setup.mockInput.pressEscape();
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("the init queue settled: 0 ran, 2 skipped, 0 refused"),
						"the settled line",
					);
					expect(frame).not.toContain("Init acme");
				},
				WIDTH,
				HEIGHT,
				{ config: BASE_CONFIG, runner, home, state },
			);
		} finally {
			cleanupStateFixtures();
		}
	});

	test("a queue entry without a checkout is refused, and the queue moves on", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		const home = join(tmpdir(), `factory-select-home-${Date.now()}`);
		// Only the second row holds a checkout; the queue head refuses.
		const billing = join(home, "src", "billing");
		mkdirSync(billing, { recursive: true });
		planCanned(runner, billing, "acme/billing");
		runner.setDefault({ code: 0, stdout: "" });
		// A readable agent list keeps the observation quiet, so the
		// Message line holds the line the queue leaves there.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const state = freshState();
		try {
			await withApp(
				async (setup) => {
					setup.mockInput.pressKey("o");
					await awaitFrame(setup, (f) => f.includes("acme/factory"), "the list rows");
					for (const letter of "acme") setup.mockInput.pressKey(letter);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory") && f.includes("acme/billing"),
						"the filter to settle",
					);
					// A short rest lets the last typed character settle before the
					// Tab: the keys arrive in separate reads, the way an
					// operator's do.
					await new Promise((r) => setTimeout(r, 25));
					setup.mockInput.pressTab();
					await awaitFrame(setup, (f) => f.includes("queued"), "the first mark");
					setup.mockInput.pressKey("j");
					await awaitFrame(
						setup,
						(f) => f.includes("❯ acme/billing"),
						"the cursor on the second row",
					);
					setup.mockInput.pressTab();
					await awaitFrame(
						setup,
						(f) => (f.match(/queued/gu) ?? []).length === 2,
						"the second mark",
					);
					setup.mockInput.pressEnter();
					// The head has no checkout: the refusal names its path, and the
					// next row's confirmation stands in its place.
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("Init acme/billing"),
						"the next confirmation",
					);
					expect(frame).toContain(
						`acme/factory has no local checkout at ${join(home, "src", "factory")}`,
					);
					setup.mockInput.pressEscape();
					const settled = await awaitFrame(
						setup,
						(f) => f.includes("the init queue settled: 0 ran, 1 skipped, 1 refused"),
						"the settled line",
					);
					expect(settled).not.toContain("Init acme");
				},
				WIDTH,
				HEIGHT,
				{ config: BASE_CONFIG, runner, home, state },
			);
		} finally {
			cleanupStateFixtures();
		}
	});

	test("a failed act stops the queue, and names the repository on the line", async () => {
		const runner = new FakeRunner();
		runner.set("gh", viewerArgs(), { stdout: viewerJson() });
		const home = join(tmpdir(), `factory-select-home-${Date.now()}`);
		const factory = join(home, "src", "factory");
		const billing = join(home, "src", "billing");
		mkdirSync(factory, { recursive: true });
		mkdirSync(billing, { recursive: true });
		planCanned(runner, factory, "acme/factory");
		planCanned(runner, billing, "acme/billing");
		// The colliding source the config names below is a live feed: the plane
		// polls the sources the config names. A readable empty search page keeps
		// it quiet, so the Message line holds the queue's own line.
		runner.setDefault({
			code: 0,
			stdout: JSON.stringify({
				data: {
					rateLimit: { cost: 1 },
					search: {
						issueCount: 0,
						nodes: [],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				},
			}),
		});
		// A readable agent list keeps the observation quiet, so the
		// Message line holds the line the queue leaves there.
		runner.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
		const state = freshState();
		// A source the operator named over the act's name stops the commit before
		// the act issues a command: a deterministic failure of the entry's act.
		const config: typeof BASE_CONFIG = {
			...BASE_CONFIG,
			sources: [
				{
					name: "acme/factory-issues",
					kind: "github-issues",
					refreshIntervalSeconds: 60,
					repositories: ["other/elsewhere"],
					host: "github.com",
				},
			],
		};
		try {
			await withApp(
				async (setup) => {
					setup.mockInput.pressKey("o");
					await awaitFrame(setup, (f) => f.includes("acme/factory"), "the list rows");
					for (const letter of "acme") setup.mockInput.pressKey(letter);
					await awaitFrame(
						setup,
						(f) => f.includes("acme/factory") && f.includes("acme/billing"),
						"the filter to settle",
					);
					// A short rest lets the last typed character settle before the
					// Tab: the keys arrive in separate reads, the way an
					// operator's do.
					await new Promise((r) => setTimeout(r, 25));
					setup.mockInput.pressTab();
					await awaitFrame(setup, (f) => f.includes("queued"), "the first mark");
					setup.mockInput.pressKey("j");
					await awaitFrame(
						setup,
						(f) => f.includes("❯ acme/billing"),
						"the cursor on the second row",
					);
					setup.mockInput.pressTab();
					await awaitFrame(
						setup,
						(f) => (f.match(/queued/gu) ?? []).length === 2,
						"the second mark",
					);
					setup.mockInput.pressEnter();
					await awaitFrame(setup, (f) => f.includes("Init acme/factory"), "the first confirmation");
					setup.mockInput.pressEnter();
					const frame = await awaitFrame(
						setup,
						(f) => f.includes("a source named acme/factory-issues is already configured"),
						"the failure line",
					);
					// The queue stopped: the next row's panel never opens.
					expect(frame).not.toContain("Init acme/billing");
				},
				WIDTH,
				HEIGHT,
				{ config, runner, home, state },
			);
		} finally {
			cleanupStateFixtures();
		}
	});
});
