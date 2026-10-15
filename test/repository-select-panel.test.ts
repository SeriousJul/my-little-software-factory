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
import { join } from "node:path";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import type { StandingFacts } from "../src/components/controls.ts";
import { RepositorySelectPanel } from "../src/components/repository-select-panel.ts";
import { SPINNER_FRAMES } from "../src/components/shared/spinner.ts";
import { type InitableRepository, VIEWER_REPOSITORIES_QUERY } from "../src/repository-list.ts";
import {
	frameUntil,
	guideKey,
	HEIGHT,
	messageRowOf,
	pageKey,
	pressControl,
	rowsOf,
	settle,
	typeText,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { agentListJson, type FakeRunner } from "./fake-runner.ts";
import { withholdPassiveFlushes } from "./passive-flush-hold.ts";
import { plane } from "./plane.ts";

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
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
			},
		});
		const runner = planeRecord.fakeRunner;
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "Init a repository" });

				// The read settles: the list rows stand, own repositories first.
				const settled = await frameUntil(
					setup,
					"the list rows to settle",
					(f) => f.includes("acme/billing") && f.includes("SeriousJul/my-little-software-factory"),
				);
				const rows = rowsOf(settled);
				expect(rows.findIndex((row) => row.includes("acme/factory"))).toBeLessThan(
					rows.findIndex((row) => row.includes("acme/billing")),
				);
				// The read is one call.
				expect(runner.calls.filter((call) => call.command === "gh")).toHaveLength(1);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	test("typing filters the list, and Del takes the whole query back", async () => {
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
			},
		});
		const _runner = planeRecord.fakeRunner;
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "Init a repository" });
				await frameUntil(setup, "the list rows to settle", (f) => f.includes("acme/billing"));
				// The query filters by substring of the display name.
				await typeText(setup, "billing");
				const filtered = await frameUntil(
					setup,
					"the list to filter",
					(f) => !f.includes("acme/factory") && f.includes("acme/billing"),
				);
				expect(filtered).not.toContain("my-little-software-factory");
				// Del clears the whole query in one key.
				await pressControl(setup, "repository-select-clear", { quiet: true });
				await frameUntil(
					setup,
					"the list to clear back",
					(f) => f.includes("acme/factory") && f.includes("acme/billing"),
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	test("Esc closes the list and keeps the base frame", async () => {
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { opens: "Init a repository" });
				await pressControl(setup, "repository-select-cancel", { closes: "Init a repository" });
				const frame = await settle(setup);
				expect(frame).not.toContain("Init a repository");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
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
	 * the rig's named operations flush before their key-bus reads,
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
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
			},
		});
		await withApp(
			async (setup) => {
				// The plane's passive flushes land in the rig's hand, not on
				// the scheduler's clock: the loaded runner's shape, by design.
				const handFlushesBack = withholdPassiveFlushes();
				let bodyFailed = false;
				try {
					await guideKey(setup, "repository-select-open", "o", { opens: "Init a repository" });
					await pressControl(setup, "repository-select-cancel", { closes: "Init a repository" });
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
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	test("a read failure states its reason on the panel", async () => {
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.setDefault({ code: 4, stderr: "gh: Not logged in to github.com" });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "Not logged in" });
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	test("Enter on a row without a local checkout refuses with the path it needs", async () => {
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "acme/billing" });
				await typeText(setup, "billing");
				await frameUntil(setup, "the filter to settle", (f) => !f.includes("acme/factory"));
				// The bar states the act available: the row stands, so the press
				// runs the control and the refusal lands on the act's own read,
				// after the key.
				await pressControl(setup, "select-repository", { quiet: true });
				await frameUntil(
					setup,
					"the refusal with the path",
					(f) => f.includes("no local checkout at") && f.includes("src/billing"),
				);
				expect(messageRowOf(await settle(setup))).toContain("no local checkout at");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	// The list holds the operator's whole account, so the page and edge keys
	// run the way the ticket lists run: a step per row, a page per window, an
	// edge to the end, and the window riding the cursor (ADR 0082).
	test("the page keys and the edge keys reach the ends of a long list", async () => {
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
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.set("gh", viewerArgs(), { stdout: viewer });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "1-12/40" });
				// End lands the cursor on the last row, and the window rides to it.
				await pageKey(setup, "end", { quiet: true });
				const frame = await frameUntil(
					setup,
					"the window at the end",
					(f) => f.includes("acme/repo-39") && !f.includes("acme/repo-00"),
				);
				expect(frame).toContain("40/40");
				// Home takes the cursor back to the first row.
				await pageKey(setup, "home", { quiet: true });
				await frameUntil(
					setup,
					"the window at the start",
					(f) => f.includes("acme/repo-00") && !f.includes("acme/repo-39"),
				);
				// A page down is a window of rows: the first row leaves, and the
				// cursor's row stands on the window's last row.
				await pageKey(setup, "pagedown", { quiet: true });
				await frameUntil(
					setup,
					"the window after the page",
					(f) => !f.includes("acme/repo-00") && f.includes("acme/repo-12"),
				);
				// A page up is a window of rows back, clamped at the start.
				await pageKey(setup, "pageup", { quiet: true });
				await frameUntil(
					setup,
					"the window back at the start",
					(f) => f.includes("acme/repo-00") && !f.includes("acme/repo-39"),
				);
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
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
					messageRecorded: false,
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
		const planeRecord = await plane({
			sources: [],
			prepare: async (home) => {
				// The planning commands: the branch, the fetch, the file reads, the labels.
				mkdirSync(join(home, "src", "factory"), { recursive: true });
			},
			commands: (fake, home) => {
				const checkout = join(home, "src", "factory");
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
				fake.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
					stdout: "refs/remotes/origin/main\n",
				});
				fake.set("git", ["-C", checkout, "fetch", "origin", "main"], {});
				fake.set("git", ["-C", checkout, "show", "origin/main:CLAUDE.md"], { code: 1 });
				fake.set("git", ["-C", checkout, "show", "origin/main:AGENTS.md"], {
					stdout: "existing agents\n",
				});
				fake.set("gh", ["label", "list", "--repo", "github.com/acme/factory", "--json", "name"], {
					stdout: "[]",
				});
				fake.setDefault({ code: 0, stdout: "" });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "acme/factory" });
				await typeText(setup, "acme/fac");
				await frameUntil(
					setup,
					"the filter to settle",
					(f) => !f.includes("acme/billing") && !f.includes("my-little"),
				);
				// The plan settles and the confirmation panel opens on the row.
				const frame = await pressControl(setup, "select-repository", {
					opens: "Init acme/factory",
				});
				expect(frame).toContain("run the act now");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	// While an init plans, the base view's keyboard is live (ADR 0083): the
	// plane refuses a new open that the in-flight plan would then overwrite.
	test("a planning init refuses a new open, and opens when the plan lands", async () => {
		const planeRecord = await plane({
			sources: [],
			prepare: async (home) => {
				mkdirSync(join(home, "src", "factory"), { recursive: true });
			},
			commands: (fake, home) => {
				const factory = join(home, "src", "factory");
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
				planCanned(fake, factory, "acme/factory");
				// Hold the plan's first read, so the window the plan leaves open
				// stands long enough for the operator's key to land in it.
				fake.setDelay("git", ["-C", factory, "symbolic-ref", "refs/remotes/origin/HEAD"], 150);
				fake.setDefault({ code: 0, stdout: "" });
				fake.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "acme/factory" });
				await typeText(setup, "acme/factory");
				await frameUntil(
					setup,
					"the filter to settle",
					(f) => f.includes("acme/factory") && !f.includes("acme/billing"),
				);
				await pressControl(setup, "select-repository", { quiet: true });
				// The plan holds on its first read: the open is in flight, and a
				// new open is refused with the init that holds.
				const frame = await guideKey(setup, "repository-select-open", "o", {
					refuses: "the init for acme/factory is running",
				});
				expect(frame).not.toContain("Init a repository");
				// The plan lands, and the panel stands where the open asked for.
				await frameUntil(setup, "the confirmation", (f) => f.includes("Init acme/factory"));
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	// The queue the operator marks with Tab (ADR 0083): one repository per
	// entry, one confirmation panel per entry, in list order.
	test("Tab marks the row for the queue, and the key unmarks it", async () => {
		const planeRecord = await plane({
			sources: [],
			commands: (fake) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "acme/factory" });
				await pressControl(setup, "repository-select-toggle", { shows: "queued" });
				await pressControl(setup, "repository-select-toggle", { hides: "queued" });
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord },
		);
	});

	test("a marking of two runs the queue, one confirmation per row, in list order", async () => {
		const planeRecord = await plane({
			sources: [],
			prepare: async (home) => {
				mkdirSync(join(home, "src", "factory"), { recursive: true });
				mkdirSync(join(home, "src", "billing"), { recursive: true });
			},
			commands: (fake, home) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
				planCanned(fake, join(home, "src", "factory"), "acme/factory");
				planCanned(fake, join(home, "src", "billing"), "acme/billing");
				fake.setDefault({ code: 0, stdout: "" });
				// A readable agent list keeps the observation quiet, so the
				// Message line holds the line the queue leaves there.
				fake.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "acme/factory" });
				await typeText(setup, "acme");
				await frameUntil(
					setup,
					"the filter to settle",
					(f) => f.includes("acme/factory") && f.includes("acme/billing"),
				);
				// A short rest lets the last typed character settle before the
				// Tab: the keys arrive in separate reads, the way an operator's
				// do. Mark both rows, in list order.
				await new Promise((r) => setTimeout(r, 25));
				await pressControl(setup, "repository-select-toggle", { shows: "queued" });
				await pressControl(setup, "move-list", { via: "j", quiet: true });
				await frameUntil(
					setup,
					"the cursor on the second row",
					(f) => f.includes("❯ acme/billing") && f.includes("queued"),
				);
				await pressControl(setup, "repository-select-toggle", { quiet: true });
				await frameUntil(setup, "the second mark", (f) => (f.match(/queued/gu) ?? []).length === 2);
				// The queue runs in list order: the first marked row opens first.
				await pressControl(setup, "select-repository", { opens: "Init acme/factory" });
				// Cancel skips the entry, and the next row's panel stands in its place.
				await pressControl(setup, "cancel-action", { closes: "Init acme/factory" });
				await frameUntil(setup, "the second confirmation", (f) => f.includes("Init acme/billing"));
				// The drained queue leaves its settled line on the Message line.
				await pressControl(setup, "cancel-action", {
					shows: "the init queue settled: 0 ran, 2 skipped, 0 refused",
				});
				const frame = await settle(setup);
				expect(frame).not.toContain("Init acme");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	test("a queue entry without a checkout is refused, and the queue moves on", async () => {
		const planeRecord = await plane({
			sources: [],
			prepare: async (home) => {
				// Only the second row holds a checkout; the queue head refuses.
				mkdirSync(join(home, "src", "billing"), { recursive: true });
			},
			commands: (fake, home) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
				planCanned(fake, join(home, "src", "billing"), "acme/billing");
				fake.setDefault({ code: 0, stdout: "" });
				// A readable agent list keeps the observation quiet, so the
				// Message line holds the line the queue leaves there.
				fake.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
			},
		});
		await withApp(
			async (setup) => {
				await guideKey(setup, "repository-select-open", "o", { shows: "acme/factory" });
				await typeText(setup, "acme");
				await frameUntil(
					setup,
					"the filter to settle",
					(f) => f.includes("acme/factory") && f.includes("acme/billing"),
				);
				// A short rest lets the last typed character settle before the
				// Tab: the keys arrive in separate reads, the way an
				// operator's do.
				await new Promise((r) => setTimeout(r, 25));
				await pressControl(setup, "repository-select-toggle", { shows: "queued" });
				await pressControl(setup, "move-list", { via: "j", quiet: true });
				await frameUntil(setup, "the cursor on the second row", (f) =>
					f.includes("❯ acme/billing"),
				);
				await pressControl(setup, "repository-select-toggle", { quiet: true });
				await frameUntil(setup, "the second mark", (f) => (f.match(/queued/gu) ?? []).length === 2);
				// The head has no checkout: the refusal names its path, and the
				// next row's confirmation stands in its place.
				const frame = await pressControl(setup, "select-repository", {
					shows: "Init acme/billing",
				});
				expect(frame).toContain(
					`acme/factory has no local checkout at ${join(planeRecord.home, "src", "factory")}`,
				);
				const settled = await pressControl(setup, "cancel-action", {
					shows: "the init queue settled: 0 ran, 1 skipped, 1 refused",
				});
				expect(settled).not.toContain("Init acme");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});

	test("a failed act stops the queue, and names the repository on the line", async () => {
		const planeRecord = await plane({
			// A source the operator named over the act's name stops the commit
			// before the act issues a command: a deterministic failure of the
			// entry's act.
			sources: [
				{
					config: {
						name: "acme/factory-issues",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["other/elsewhere"],
						host: "github.com",
					},
					tickets: [],
				},
			],
			prepare: async (home) => {
				mkdirSync(join(home, "src", "factory"), { recursive: true });
				mkdirSync(join(home, "src", "billing"), { recursive: true });
			},
			commands: (fake, home) => {
				fake.set("gh", viewerArgs(), { stdout: viewerJson() });
				planCanned(fake, join(home, "src", "factory"), "acme/factory");
				planCanned(fake, join(home, "src", "billing"), "acme/billing");
				fake.setDefault({ code: 0, stdout: "" });
				// A readable agent list keeps the observation quiet, so the
				// Message line holds the line the queue leaves there.
				fake.set("herdr", ["agent", "list"], { stdout: agentListJson([]) });
			},
		});
		await withApp(
			async (setup) => {
				// The bound source stands on its empty snapshot: the boot's read
				// settles on it, so the standing is complete before the keys land.
				planeRecord.settleFirstFetch();
				await guideKey(setup, "repository-select-open", "o", { shows: "acme/factory" });
				await typeText(setup, "acme");
				await frameUntil(
					setup,
					"the filter to settle",
					(f) => f.includes("acme/factory") && f.includes("acme/billing"),
				);
				// A short rest lets the last typed character settle before the
				// Tab: the keys arrive in separate reads, the way an
				// operator's do.
				await new Promise((r) => setTimeout(r, 25));
				await pressControl(setup, "repository-select-toggle", { shows: "queued" });
				await pressControl(setup, "move-list", { via: "j", quiet: true });
				await frameUntil(setup, "the cursor on the second row", (f) =>
					f.includes("❯ acme/billing"),
				);
				await pressControl(setup, "repository-select-toggle", { quiet: true });
				await frameUntil(setup, "the second mark", (f) => (f.match(/queued/gu) ?? []).length === 2);
				await pressControl(setup, "select-repository", { opens: "Init acme/factory" });
				const frame = await pressControl(setup, "confirm-action", {
					shows: "a source named acme/factory-issues is already configured",
				});
				// The queue stopped: the next row's panel never opens.
				expect(frame).not.toContain("Init acme/billing");
			},
			{ width: WIDTH, height: HEIGHT, plane: planeRecord, loopPolicy: { kind: "production" } },
		);
	});
});
