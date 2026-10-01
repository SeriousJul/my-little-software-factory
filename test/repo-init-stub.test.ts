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
import type { TaskTypeConfig, WorkflowState } from "../src/config.ts";
import {
	AGENT_SKILLS_HEADING,
	CONVENTION_FILE_PATHS,
	conventionFileContent,
	repositoryInitLabelSet,
	runRepositoryInit,
} from "../src/repo-init.ts";
import { createChildProcessRunner } from "../src/runner.ts";
import { createStubRunner } from "../src/stub/runner.ts";
import type { StubWorld } from "../src/stub/world.ts";
import { StubWorldStore } from "../src/stub/world.ts";

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
