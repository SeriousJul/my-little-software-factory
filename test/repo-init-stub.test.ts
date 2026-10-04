/**
 * The Stub world's label seam for the Repository init act (ADR 0075, testing
 * decision 2).
 *
 * The prior art is the same as the Stub world suite: the tests drive the real
 * production modules through the stub runner over a world file in a temporary
 * directory. The label seam closes the surface the act writes on: the world
 * holds a repository-level label set, answers `gh label list` and `gh label
 * create`, and refuses an item edit that names a label the set does not hold.
 * The end-to-end run opens a real git origin and clone in a temporary
 * directory and walks the act through the stub: fake external `gh`, real git,
 * no desktop, no live Agent, isolated state.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, type TaskTypeConfig, type WorkflowState } from "../src/config.ts";
import {
	AGENT_SKILLS_HEADING,
	CONVENTION_FILE_PATHS,
	conventionFileContent,
	repositoryInitLabelSet,
	repositoryInitSettingsHash,
	runRepositoryInit,
} from "../src/repo-init.ts";
import { type CommandRunner, createChildProcessRunner } from "../src/runner.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import { createStubRunner } from "../src/stub/runner.ts";
import type { StubWorld } from "../src/stub/world.ts";
import { StubWorldStore } from "../src/stub/world.ts";
import { createTicketSource } from "../src/ticket-source.ts";
import {
	awaitFrame,
	awaitNewKeyHandler,
	keyHandlerListeners,
	messageRowOf,
	press,
	pressEnterQuiet,
	withApp,
} from "./app-harness.ts";
import { agentListJson } from "./fake-runner.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-init-stub-"));
	paths.push(dir);
	return dir;
}

/** The task types the act's label set reads, for the fixtures' transitions. */
function taskTypesFixture(): Record<string, TaskTypeConfig> {
	return {
		implement: { transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review"] } },
		review: {
			transition: {
				ticketFacts: [],
				pullRequestFacts: [],
				branches: [
					{ when: "score-above-threshold", pullRequestFacts: ["ready-to-ship"] },
					{ when: "score-below-threshold", pullRequestFacts: ["needs-work"] },
				],
			},
		},
		rework: {
			transition: { ticketFacts: ["rework-in-progress"], pullRequestFacts: ["ready-for-review"] },
		},
		merge: {
			transition: {
				ticketFacts: [],
				pullRequestFacts: [],
				branches: [{ when: "pull-request-open", pullRequestFacts: ["needs-work"] }],
			},
		},
	};
}

/** A state that gates on a scoping label no transition writes. */
function statesFixture(): WorkflowState[] {
	return [
		{
			name: "ready-for-agent",
			taskType: "implement",
			match: { sourceKind: "github-issue", labelsAny: ["ready-for-agent"] },
		},
	];
}

/** A world whose single repository stands uninitialized, with its label set. */
function singleRepoWorld(dir: string, labels: string[]): StubWorldStore {
	const world: StubWorld = {
		version: 1,
		host: "github.com",
		owner: "stub",
		autoScore: { enabled: false, score: 0 },
		repositories: [
			{
				name: "alpha",
				labels,
				issues: [],
				pullRequests: [],
				mergeGates: {},
				security: { advisories: [], dependabotAlerts: [], secretScanningAlerts: [] },
			},
		],
	};
	const path = join(dir, "world.json");
	writeFileSync(path, `${JSON.stringify(world, null, 2)}\n`);
	return StubWorldStore.load(path);
}

describe("the label seam (ADR 0075)", () => {
	const identity = "github.com/stub/alpha";

	test("gh label list answers the repository's set in the shape the act parses", async () => {
		const dir = tempDir();
		const store = singleRepoWorld(dir, ["ready-for-agent", "needs-work"]);
		const result = await store.answerGh(["label", "list", "--repo", identity, "--json", "name"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual([
			{ name: "ready-for-agent" },
			{ name: "needs-work" },
		]);
		// An unset set answers empty, the way the act reads a repository with no labels.
		const dir2 = tempDir();
		const bare = singleRepoWorld(dir2, []);
		const empty = await bare.answerGh(["label", "list", "--repo", identity, "--json", "name"]);
		expect(JSON.parse(empty.stdout)).toEqual([]);
		// A repository the world does not know is refused.
		const foreign = await store.answerGh([
			"label",
			"list",
			"--repo",
			"github.com/stub/omega",
			"--json",
			"name",
		]);
		expect(foreign.code).toBe(1);
	});

	test("gh label create adds the label to the set and persists it", async () => {
		const dir = tempDir();
		const store = singleRepoWorld(dir, ["ready-for-agent"]);
		const created = await store.answerGh([
			"label",
			"create",
			"needs-work",
			"--repo",
			identity,
			"-y",
		]);
		expect(created.code).toBe(0);
		expect(store.world.repositories[0].labels).toEqual(["ready-for-agent", "needs-work"]);
		// The write is on disk, for the run's next read.
		const reloaded = StubWorldStore.load(store.path);
		expect(reloaded.world.repositories[0].labels).toEqual(["ready-for-agent", "needs-work"]);
		// A label that already stands is not re-added.
		const again = await store.answerGh(["label", "create", "needs-work", "--repo", identity, "-y"]);
		expect(again.code).toBe(0);
		expect(store.world.repositories[0].labels).toEqual(["ready-for-agent", "needs-work"]);
	});

	test("an item edit that names a label the set does not hold is refused", async () => {
		const dir = tempDir();
		const store = singleRepoWorld(dir, ["ready-for-agent"]);
		// Seed an issue the edit can name.
		store.world.repositories[0].issues.push({
			number: 1,
			title: "the issue",
			body: "",
			labels: [],
			state: "open",
			updatedAt: "2026-01-01T00:00:00.000Z",
			comments: [],
		});
		store.save();
		const refused = await store.answerGh([
			"issue",
			"edit",
			"#1",
			"--repo",
			identity,
			"--add-label",
			"not-made",
		]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("does not hold the label: not-made");
		// The world is unchanged: the item has no label.
		expect(store.world.repositories[0].issues[0].labels).toEqual([]);
		// A label the set does hold is accepted.
		const accepted = await store.answerGh([
			"issue",
			"edit",
			"#1",
			"--repo",
			identity,
			"--add-label",
			"ready-for-agent",
		]);
		expect(accepted.code).toBe(0);
		expect(store.world.repositories[0].issues[0].labels).toEqual(["ready-for-agent"]);
	});

	test("a repository with no set takes any label, the way the world did before the seam", async () => {
		const dir = tempDir();
		const store = singleRepoWorld(dir, []);
		store.world.repositories[0].labels = undefined;
		store.world.repositories[0].issues.push({
			number: 1,
			title: "the issue",
			body: "",
			labels: [],
			state: "open",
			updatedAt: "2026-01-01T00:00:00.000Z",
			comments: [],
		});
		store.save();
		const result = await store.answerGh([
			"issue",
			"edit",
			"#1",
			"--repo",
			identity,
			"--add-label",
			"anything",
		]);
		expect(result.code).toBe(0);
		expect(store.world.repositories[0].issues[0].labels).toEqual(["anything"]);
	});
});

/**
 * The TUI walk of the init (ADR 0075, testing decision 2): the real App at a
 * fixed terminal size over the real state file and the real git, with GitHub
 * served from the Stub world. The operator's path is walked key by key - the
 * `i` on the Group header, the panel, the confirm - and the run's facts are
 * read from where the operator would: the labels standing in the world, the
 * files on the pushed branch through real git, the sources in the config
 * file, the init fact in the state file, and the marker clearing off the
 * Group header.
 */
describe("the TUI walk of the init (ADR 0075)", () => {
	/** The config the walk boots with: the operator's feed, the mapping, the machine. */
	function walkConfig(checkout: string): string {
		return `state-file = "factory.sqlite"
default-agent = "pi"
default-environment = "worktree"
default-task-type = "implement"
attention-bell = true
interaction-exit-key = "f12"
max-parallel-agents = 2
agent-poll-interval-seconds = 5
completion-message-lines = 200
max-handoffs-per-ticket = 2

[repos]
"github.com/acme/factory" = "${checkout}"

[scroll]
speed = 1
acceleration = 0.8
maximum-speed = 6

[agents.pi]
kind = "pi"

[[states]]
name = "ready-for-agent"
task-type = "implement"
[states.match]
source-kind = "github-issue"
labels-any = ["ready-for-agent"]

[task-types.implement]
template = "Do the work: {external-key}: {title}"
[task-types.implement.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]

[task-types.review]
template = "Review {external-key}: {title}."
[task-types.review.transition]
ticket-facts = []
pull-request-facts = []

[task-types.rework]
template = "Rework {external-key}: {title}."
[task-types.rework.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]

[task-types.merge]
template = "Merge {external-key}: {title}."
[task-types.merge.transition]
ticket-facts = []
pull-request-facts = []

[[sources]]
name = "acme-issues"
kind = "github-issues"
refresh-interval-seconds = 60
repositories = ["acme/factory"]
host = "github.com"
`;
	}

	test("the key, the panel, the confirm: the sources, the fact, and the marker clearing", async () => {
		const dir = tempDir();
		const real = createChildProcessRunner();

		// A real git origin and a clone the act works in: one committed
		// AGENTS.md on main the block surgery finds, a bare origin, and a
		// clone that carries the origin/HEAD symref the branch rule reads.
		const seed = join(dir, "seed");
		const origin = join(dir, "origin.git");
		const checkout = join(dir, "checkout");
		await real.run("git", ["init", "-b", "main", seed]);
		writeFileSync(join(seed, "AGENTS.md"), "# Factory\n\nIntro.\n", "utf8");
		await real.run("git", ["-C", seed, "add", "-A"]);
		await real.run("git", [
			"-c",
			"user.name=init",
			"-c",
			"user.email=init@example.com",
			"-C",
			seed,
			"commit",
			"-m",
			"seed",
		]);
		await real.run("git", ["clone", "--bare", seed, origin]);
		await real.run("git", ["clone", origin, checkout]);
		// The act's commit is a plain `git commit`: it takes its identity
		// from the checkout's config, the way it takes the operator's on a
		// real machine. The fixture stands that config, so the walk holds on
		// a machine with no global git identity.
		await real.run("git", ["-C", checkout, "config", "user.name", "init"]);
		await real.run("git", ["-C", checkout, "config", "user.email", "init@example.com"]);

		// The world: the repository stands uninitialized, and its one issue
		// matches no state, so the machine lists it and never starts an Agent.
		const world: StubWorld = {
			version: 1,
			host: "github.com",
			owner: "acme",
			autoScore: { enabled: false, score: 0 },
			repositories: [
				{
					name: "factory",
					labels: [],
					issues: [
						{
							number: 1,
							title: "an open issue",
							body: "",
							labels: [],
							state: "open",
							updatedAt: "2026-01-01T00:00:00.000Z",
							comments: [],
						},
					],
					pullRequests: [],
					mergeGates: {},
					security: {
						advisories: [],
						dependabotAlerts: [],
						secretScanningAlerts: [],
					},
				},
			],
		};
		writeFileSync(join(dir, "world.json"), `${JSON.stringify(world, null, 2)}\n`);
		const store = StubWorldStore.load(join(dir, "world.json"));
		// The stub answers the plane's gh over the world. The observation
		// loop's herdr probe stays hermetic, the way the harness default
		// keeps it: the empty agent list. Left to the stub's pass-through the
		// walk would read the machine's real herdr, and a machine without
		// one holds the warning on the Message line the note must stand on.
		const stubRunner = createStubRunner(real, store);
		const runner: CommandRunner = {
			run: (command, args, options) =>
				command === "herdr"
					? Promise.resolve({ code: 0, stdout: agentListJson([]), stderr: "" })
					: stubRunner.run(command, args, options),
			listModels: (kind) => stubRunner.listModels(kind),
		};

		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, walkConfig(checkout));
		const { config } = await loadConfigFile(configPath);
		// The startup wiring's own build: the operator's feed over the stub's
		// world, the way the entry module composes the plane.
		const sources = config.sources.map((source) => createTicketSource(source, runner));
		const state: FactoryState = openFactoryState(join(dir, "factory.sqlite"));
		state.grouping.setGroupingAxis("tickets", "repository");

		const headBefore = (await real.run("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();

		await withApp(
			async (setup) => {
				// The fetch the refresh loop runs through the stub stands the list:
				// the Group header wears the marker, and the one-time note names the
				// real path of the act. Both are awaited together: the note and the
				// marker stand in one render, and a frame captured mid-render can hold
				// the marker over a Message line row that is still blank. Reading the
				// row out of such a frame is the race this test hit on a loaded runner.
				const marked = await awaitFrame(
					setup,
					(f) =>
						f.includes("acme/factory") &&
						f.includes("uninit") &&
						messageRowOf(f).includes("Press i on one of their Group headers"),
					"the uninit marker on the Group header with the note on the Message line",
				);
				expect(marked).toContain("acme/factory");
				expect(messageRowOf(marked)).toContain("Press i on one of their Group headers");

				// The cursor rests on the first row, the Group header: the `i`
				// there opens the panel over the generator's plan.
				const before = keyHandlerListeners(setup);
				const panel = await press(setup, "i", "the init panel to open", (f) =>
					f.includes("Init acme/factory"),
				);
				await awaitNewKeyHandler(setup, before, "the init panel to take the keys");
				expect(panel).toContain("Pushes to main with a throwaway worktree.");

				// The confirm runs the act end to end: the result stands on the
				// Message line.
				const settled = await pressEnterQuiet(setup, "the init's result", (f) =>
					f.includes("acme/factory: pushed"),
				);
				// The result names the branch and the labels the act created.
				expect(settled).toContain("to main, created");

				// The world stands the label set the act created, and the refusal
				// log is empty: the stub answered every command the act issued.
				expect(store.world.repositories[0].labels).toEqual(
					repositoryInitLabelSet(config.taskTypes),
				);
				expect(store.refusals).toEqual([]);

				// The sources the flow registered stand in the config file on
				// disk. The operator's own feed, acme-issues, lists the
				// repository under the same host and kind as the planned issues
				// source, so the coverage check (issue 195) skips that feed and
				// the config gains only the missing pull request feed - the
				// operator's feed stands untouched, and no duplicate of the
				// covered feed appears beside it.
				const saved = readFileSync(configPath, "utf8");
				expect(saved).not.toContain("acme/factory-issues");
				expect(saved).toContain("acme/factory-pull-requests");
				expect(saved).toContain("acme-issues");

				// The init fact stands in the state file on the current settings.
				const fact = state.repositoryInit.repositoryInitFact("github.com/acme/factory");
				expect(fact).not.toBeNull();
				expect(fact?.settingsHash).toBe(
					repositoryInitSettingsHash(config.workflowStates, config.taskTypes),
				);

				// The marker cleared off the Group header in the same read.
				const cleared = await awaitFrame(
					setup,
					(f) => f.includes("acme/factory") && !f.includes("uninit"),
					"the marker to clear off the Group header",
				);
				expect(cleared).toContain("acme/factory");

				// The feed the act registered is live in this run:
				// the refresh coordinator holds it, and the source health rows it
				// seeds are the sources the plane polls. The operator's own feed
				// stands beside the pull request feed the act added.
				const polled = state.sourceFact
					.sourceHealths()
					.map((source) => source.name)
					.sort();
				expect(polled).toEqual(["acme-issues", "acme/factory-pull-requests"]);

				// The checkout never moved and never dirtied, and the worktree is
				// gone: the act pushed from a worktree the plane removed.
				const headAfter = (
					await real.run("git", ["-C", checkout, "rev-parse", "HEAD"])
				).stdout.trim();
				expect(headAfter).toBe(headBefore);
				expect((await real.run("git", ["-C", checkout, "status", "--porcelain"])).stdout).toBe("");
				expect(
					(await real.run("git", ["-C", checkout, "worktree", "list"])).stdout.trim().split("\n"),
				).toHaveLength(1);

				// A fresh clone of the branch carries the generated files, and the
				// block lands in the committed AGENTS.md with the file's section
				// standing.
				const verify = join(dir, "verify");
				await real.run("git", ["clone", origin, verify]);
				expect(readFileSync(join(verify, "docs/agents/domain.md"), "utf8")).toBe(
					conventionFileContent("docs/agents/domain.md"),
				);
				const agents = readFileSync(join(verify, "AGENTS.md"), "utf8");
				expect(agents).toContain(AGENT_SKILLS_HEADING);
				expect(agents).toContain("# Factory");
			},
			undefined,
			undefined,
			{ config, state, runner, sources, home: dir, configPath },
		);
		state.close();
	});
});

describe("the select list's bootstrap init (ADR 0082)", () => {
	/** The config the walk boots with: no Ticket source for the repository at all. */
	function bootstrapConfig(checkout: string): string {
		return `state-file = "factory.sqlite"
default-agent = "pi"
default-environment = "worktree"
default-task-type = "implement"
attention-bell = true
interaction-exit-key = "f12"
max-parallel-agents = 2
agent-poll-interval-seconds = 5
completion-message-lines = 200
max-handoffs-per-ticket = 2

[repos]
"github.com/acme/beta" = "${checkout}"

[scroll]
speed = 1
acceleration = 0.8
maximum-speed = 6

[agents.pi]
kind = "pi"

[[states]]
name = "ready-for-agent"
task-type = "implement"
[states.match]
source-kind = "github-issue"
labels-any = ["ready-for-agent"]

[task-types.implement]
template = "Do the work: {external-key}: {title}"
[task-types.implement.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]

[task-types.review]
template = "Review {external-key}: {title}."
[task-types.review.transition]
ticket-facts = []
pull-request-facts = []

[task-types.rework]
template = "Rework {external-key}: {title}."
[task-types.rework.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]

[task-types.merge]
template = "Merge {external-key}: {title}."
[task-types.merge.transition]
ticket-facts = []
pull-request-facts = []
`;
	}

	/** The `gh api graphql` answer the select list parses: the one repository. */
	function viewerRepositoriesJson(): string {
		return JSON.stringify({
			data: {
				viewer: {
					repositories: {
						nodes: [
							{
								name: "beta",
								nameWithOwner: "acme/beta",
								url: "https://github.com/acme/beta",
							},
						],
					},
					organizations: { nodes: [] },
				},
			},
		});
	}

	test("o, Enter, Enter: the feeds the act registers run in the same run", async () => {
		const dir = tempDir();
		const real = createChildProcessRunner();

		const seed = join(dir, "seed");
		const origin = join(dir, "origin.git");
		const checkout = join(dir, "beta");
		await real.run("git", ["init", "-b", "main", seed]);
		writeFileSync(join(seed, "AGENTS.md"), "# Factory\n\nIntro.\n", "utf8");
		await real.run("git", ["-C", seed, "add", "-A"]);
		await real.run("git", [
			"-c",
			"user.name=init",
			"-c",
			"user.email=init@example.com",
			"-C",
			seed,
			"commit",
			"-m",
			"seed",
		]);
		await real.run("git", ["clone", "--bare", seed, origin]);
		await real.run("git", ["clone", origin, checkout]);
		await real.run("git", ["-C", checkout, "config", "user.name", "init"]);
		await real.run("git", ["-C", checkout, "config", "user.email", "init@example.com"]);

		// The world: the repository stands uninitialized, and its one issue
		// wears the label the Workflow state matches on. The plane has no feed
		// for it yet, so the list starts empty and the Group header's `i` is
		// unreachable - `o` is the only path to this repository.
		const world: StubWorld = {
			version: 1,
			host: "github.com",
			owner: "acme",
			autoScore: { enabled: false, score: 0 },
			repositories: [
				{
					name: "beta",
					labels: [],
					issues: [
						{
							number: 1,
							title: "an open issue",
							body: "",
							labels: ["ready-for-agent"],
							state: "open",
							updatedAt: "2026-01-01T00:00:00.000Z",
							comments: [],
						},
					],
					pullRequests: [],
					mergeGates: {},
					security: { advisories: [], dependabotAlerts: [], secretScanningAlerts: [] },
				},
			],
		};
		writeFileSync(join(dir, "world.json"), `${JSON.stringify(world, null, 2)}\n`);
		const store = StubWorldStore.load(join(dir, "world.json"));

		const stubRunner = createStubRunner(real, store);
		const runner: CommandRunner = {
			run: (command, args, options) => {
				if (command === "herdr")
					return Promise.resolve({ code: 0, stdout: agentListJson([]), stderr: "" });
				// The select list's viewer read, and nothing else: the sources'
				// search document stays the world's own answer.
				if (
					command === "gh" &&
					args[0] === "api" &&
					args[1] === "graphql" &&
					!args.some((arg) => arg.startsWith("searchQuery="))
				)
					return Promise.resolve({ code: 0, stdout: viewerRepositoriesJson(), stderr: "" });
				return stubRunner.run(command, args, options);
			},
			listModels: (kind) => stubRunner.listModels(kind),
		};

		const configPath = join(dir, "config.toml");
		writeFileSync(configPath, bootstrapConfig(checkout));
		const { config } = await loadConfigFile(configPath);
		const state: FactoryState = openFactoryState(join(dir, "factory.sqlite"));
		state.grouping.setGroupingAxis("tickets", "repository");

		await withApp(
			async (setup) => {
				const boot = await awaitFrame(setup, (f) => f.includes("Tickets"), "the base view");
				expect(boot).not.toContain("an open issue");

				const beforeSelect = keyHandlerListeners(setup);
				const select = await press(setup, "o", "the select list to open", (f) =>
					f.includes("acme/beta"),
				);
				await awaitNewKeyHandler(setup, beforeSelect, "the select list to take the keys");
				expect(select).toContain("acme/beta");

				const beforePanel = keyHandlerListeners(setup);
				const panel = await pressEnterQuiet(setup, "the init panel", (f) =>
					f.includes("Init acme/beta"),
				);
				await awaitNewKeyHandler(setup, beforePanel, "the init panel to take the keys");
				expect(panel).toContain("Pushes to main");

				const settled = await pressEnterQuiet(setup, "the init's result", (f) =>
					f.includes("acme/beta: pushed"),
				);
				expect(messageRowOf(settled)).toContain("pushed");

				// The config file holds both feeds the act planned.
				const saved = readFileSync(configPath, "utf8");
				expect(saved).toContain("acme/beta-issues");
				expect(saved).toContain("acme/beta-pull-requests");

				// The running plane polls them now: the feed it just registered
				// carries its ticket into the list without a restart.
				const listed = await awaitFrame(
					setup,
					(f) => f.includes("an open issue"),
					"the registered feed's ticket to reach the list",
				);
				expect(listed).toContain("an open issue");
				expect(listed).toContain("acme/beta");
			},
			undefined,
			undefined,
			{ config, state, runner, sources: [], home: dir, configPath },
		);
		state.close();
	});
});

describe("the act runs end to end through the stub (ADR 0075)", () => {
	test("the labels stand in the world, the files push, and the act reports the commit", async () => {
		const dir = tempDir();
		// A real git origin and a clone the act's worktree add stands on: an
		// empty first commit on main, a bare origin, and a clone that carries
		// the origin/HEAD symref the branch rule reads.
		const real = createChildProcessRunner();
		const seed = join(dir, "seed");
		const origin = join(dir, "origin.git");
		const checkout = join(dir, "checkout");
		await real.run("git", ["init", "-b", "main", seed]);
		await real.run("git", [
			"-c",
			"user.name=init",
			"-c",
			"user.email=init@example.com",
			"-C",
			seed,
			"commit",
			"--allow-empty",
			"-m",
			"seed",
		]);
		await real.run("git", ["clone", "--bare", seed, origin]);
		await real.run("git", ["clone", origin, checkout]);
		await real.run("git", ["-C", checkout, "config", "user.name", "init"]);
		await real.run("git", ["-C", checkout, "config", "user.email", "init@example.com"]);

		// The repository stands uninitialized: an empty label set the act fills.
		const store = singleRepoWorld(dir, []);
		const runner = createStubRunner(real, store);
		const worktree = join(dir, "wt");
		const taskTypes = taskTypesFixture();
		const result = await runRepositoryInit({
			runner,
			checkout,
			identity: "github.com/stub/alpha",
			displayName: "stub/alpha",
			host: "github.com",
			workflowStates: statesFixture(),
			taskTypes,
			instructionFile: "AGENTS.md",
			worktreePath: worktree,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Every machine label the act writes stands in the world now, and the
		// act names none of them as already present.
		expect(store.world.repositories[0].labels).toEqual(repositoryInitLabelSet(taskTypes));
		expect(result.labelsCreated).toEqual(repositoryInitLabelSet(taskTypes));
		expect(result.labelsPresent).toEqual([]);
		// The label pass made no refusal: every create the act issued was answered.
		expect(store.refusals).toEqual([]);
		// A pushed commit stands on the branch and names a real ref.
		expect(result.pushedCommit.length).toBeGreaterThanOrEqual(7);
		// The files pushed: a fresh clone of the branch carries them, byte for
		// byte the generator's own.
		const verify = join(dir, "verify");
		await real.run("git", ["clone", origin, verify]);
		for (const path of CONVENTION_FILE_PATHS) {
			expect(readFileSync(join(verify, path), "utf8")).toBe(conventionFileContent(path));
		}
		expect(readFileSync(join(verify, "AGENTS.md"), "utf8")).toContain(AGENT_SKILLS_HEADING);
	});
});
