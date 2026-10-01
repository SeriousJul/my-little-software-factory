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

import { VIEWER_REPOSITORIES_QUERY } from "../src/repository-list.ts";
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
import { FakeRunner } from "./fake-runner.ts";
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
});
