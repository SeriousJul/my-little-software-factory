import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryInitPanel } from "../src/components/repository-init-panel.ts";
import type { FactoryConfig, TaskTypeConfig, WorkflowState } from "../src/config.ts";
import {
	AGENT_SKILLS_HEADING,
	agentSkillsBlock,
	applyAgentSkillsBlock,
	CONVENTION_FILE_PATHS,
	chooseInstructionFile,
	conventionFileContent,
	conventionFiles,
	DEFAULT_LABEL_COLOR,
	isPlaneInitSource,
	labelColor,
	labelDescription,
	levelOneHeadingInBlockRun,
	planRepositoryInit,
	type RepositoryInitPlan,
	repositoryInitLabelSet,
	repositoryInitSettingsHash,
	repositoryInitSources,
	runRepositoryInit,
} from "../src/repo-init.ts";
import {
	commitRepositoryInit,
	type RepositoryInitFlowPlan,
	repositoryInitDrifted,
} from "../src/repo-init-flow.ts";
import { openFactoryState } from "../src/state.ts";
import { FakeRunner } from "./fake-runner.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	paths.push(dir);
	return dir;
}

/** The factory's own workflow machine, in the shape the config parser yields. */
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
		{
			name: "scoping-only",
			taskType: "implement",
			match: { sourceKind: "github-issue", labelsAny: ["team-core"] },
		},
	];
}

describe("the Repository init generator (ADR 0075)", () => {
	test("the label set is the transition union, the state gates, and the triage labels, sorted", () => {
		const set = repositoryInitLabelSet(taskTypesFixture(), statesFixture());
		expect(set).toEqual([
			"needs-info",
			"needs-triage",
			"needs-work",
			"ready-for-agent",
			"ready-for-human",
			"ready-for-review",
			"ready-to-ship",
			"rework-in-progress",
			"team-core",
			"wontfix",
		]);
	});

	test("the label set excludes blocked and takes the scoping label a state match names", () => {
		const withBlocked: Record<string, TaskTypeConfig> = {
			implement: { transition: { ticketFacts: ["blocked"], pullRequestFacts: [] } },
			review: taskTypesFixture().review,
		};
		const set = repositoryInitLabelSet(withBlocked, statesFixture());
		expect(set).not.toContain("blocked");
		// A gate the machine names is a gate the machine can reach only when the
		// repository holds the label (ADR 0115), so the act creates it.
		expect(set).toContain("team-core");
		expect(set).toContain("ready-for-agent");
	});

	test("a labels-none gate is no label the act creates", () => {
		const set = repositoryInitLabelSet(taskTypesFixture(), [
			{
				name: "parked",
				match: { sourceKind: "github-issue", labelsNone: ["do-not-start"] },
			},
		]);
		expect(set).not.toContain("do-not-start");
	});

	test("a machine label a transition writes that the palette does not name takes the default", () => {
		expect(labelColor("rework-in-progress")).toBe(DEFAULT_LABEL_COLOR);
		expect(labelColor("ready-for-agent")).toBe("0e8a16");
		expect(labelDescription("ready-for-human")).toBe("Ready for a human");
		// The shipped machine's spec gate carries its own pair, so a fresh
		// repository's ready-for-spec label reads the same in every repository.
		expect(labelColor("ready-for-spec")).toBe("006b75");
		expect(labelDescription("ready-for-spec")).toBe("Ready for specification");
		// The shipped machine's diagnosis gate takes GitHub's own spelling of
		// its bug label, so the act leaves an existing label looking as the
		// repository's owner made it (ADR 0116).
		expect(labelColor("bug")).toBe("d73a4a");
		expect(labelDescription("bug")).toBe("Something isn't working");
	});

	test("every convention file is non-empty, deterministic, and owns the three paths", () => {
		expect(CONVENTION_FILE_PATHS).toEqual([
			"docs/agents/issue-tracker.md",
			"docs/agents/triage-labels.md",
			"docs/agents/domain.md",
		]);
		const files = conventionFiles();
		for (const path of CONVENTION_FILE_PATHS) {
			expect(files[path]).toBe(conventionFileContent(path));
			expect(files[path].length).toBeGreaterThan(0);
			expect(files[path].trim().length).toBeGreaterThan(10);
		}
		// Deterministic: two reads agree to the byte.
		expect(conventionFiles()["docs/agents/triage-labels.md"]).toBe(
			conventionFileContent("docs/agents/triage-labels.md"),
		);
	});

	test("the Agent skills block names the repository in its own line", () => {
		const block = agentSkillsBlock("acme/factory");
		expect(block).toContain("## Agent skills");
		expect(block).toContain("`acme/factory`");
		expect(block).toContain("docs/agents/issue-tracker.md");
	});

	test("the block surgery appends when absent and keeps the file's tail clean", () => {
		const block = agentSkillsBlock("acme/factory");
		const existing = "# My Project\n\n## Rules\n\nBe careful.\n";
		const out = applyAgentSkillsBlock(existing, block);
		expect(out.startsWith(existing)).toBe(true);
		expect(out).toContain(AGENT_SKILLS_HEADING);
	});

	test("the block surgery replaces an existing block and preserves the surrounding sections", () => {
		const original = agentSkillsBlock("old/repo");
		const existing = `# My Project\n\n${original}\n\n## Other section\n\nHand-written.\n`;
		const out = applyAgentSkillsBlock(existing, agentSkillsBlock("new/repo"));
		expect(out).toContain("`new/repo`");
		expect(out).not.toContain("`old/repo`");
		expect(out).toContain("## Other section");
		expect(out).toContain("Hand-written.");
		expect(out).toContain("# My Project");
	});

	test("the block surgery leaves a file without a following section intact at the end", () => {
		const block = agentSkillsBlock("acme/factory");
		const existing = `# T\n\nIntro.\n\n${AGENT_SKILLS_HEADING}\n\nold block\n`;
		const out = applyAgentSkillsBlock(existing, block);
		expect(out).toBe(`# T\n\nIntro.\n\n${block}`);
	});

	test("the block surgery leaves one blank line before a following level-two section", () => {
		const existing = `# T\n\nIntro.\n\n${AGENT_SKILLS_HEADING}\n\nold block\n\n## Next\n\nHand-written.\n`;
		const out = applyAgentSkillsBlock(existing, agentSkillsBlock("acme/factory"));
		// Exactly one blank line stands between the block and the next section, in
		// either direction: the surgery replaces the old block's run and keeps the
		// gap the file had.
		expect(out).toContain(`${AGENT_SKILLS_HEADING}`);
		expect(out).toMatch(/\n\n## Next\n/);
		expect(out).not.toMatch(/\n\n\n/);
		expect(out).toContain("## Next\n\nHand-written.\n");
	});

	test("a level-one heading inside the block's run is named, and a level-two one is not", () => {
		// A level-one section after the block has no level-two boundary: the run
		// swallows it to the end of the file.
		expect(
			levelOneHeadingInBlockRun(`${AGENT_SKILLS_HEADING}\n\nold block\n\n# Section\n\nText.\n`),
		).toBe("# Section");
		// A level-two section ends the run: what follows it stands untouched.
		expect(
			levelOneHeadingInBlockRun(
				`${AGENT_SKILLS_HEADING}\n\nold\n\n## Next\n\n# Section\n\nText.\n`,
			),
		).toBe(null);
		// No block at all: no run to swallow anything.
		expect(levelOneHeadingInBlockRun("# Section\n\nText.\n")).toBe(null);
	});

	test("CLAUDE.md wins over AGENTS.md, and neither offers a choice", () => {
		expect(chooseInstructionFile(true, true)).toBe("CLAUDE.md");
		expect(chooseInstructionFile(false, true)).toBe("AGENTS.md");
		expect(chooseInstructionFile(false, false)).toBe(null);
		expect(chooseInstructionFile(true, false)).toBe("CLAUDE.md");
	});

	test("the settings hash is stable and changes when a transition or a state changes", () => {
		const taskTypes = taskTypesFixture();
		const states = statesFixture();
		const hash = repositoryInitSettingsHash(states, taskTypes);
		expect(hash).toBe(repositoryInitSettingsHash(states, taskTypes));
		// A new transition label changes the hash.
		const changed: Record<string, TaskTypeConfig> = {
			...taskTypes,
			implement: {
				transition: { ticketFacts: [], pullRequestFacts: ["ready-for-review", "new-fact"] },
			},
		};
		expect(repositoryInitSettingsHash(states, changed)).not.toBe(hash);
		// A changed state match changes the hash.
		const statesChanged: WorkflowState[] = [
			{ name: "ready-for-agent", taskType: "implement", match: { sourceKind: "github-issue" } },
		];
		expect(repositoryInitSettingsHash(statesChanged, taskTypes)).not.toBe(hash);
	});

	test("the registered sources follow the naming scheme and the 60-second refresh", () => {
		// One issues feed per label the machine gates issues on (ADR 0115):
		// GitHub search cannot union two `label:` qualifiers in one query, and the
		// plane's search rule is one source per query branch.
		const [issues, specIssues, pullRequests] = repositoryInitSources(
			"acme/factory",
			"github.com",
			statesFixture(),
		);
		expect(issues.name).toBe("acme/factory-issues");
		expect(issues.kind).toBe("github-issues");
		expect(issues.refreshIntervalSeconds).toBe(60);
		expect(issues.repositories).toEqual(["acme/factory"]);
		expect(issues.host).toBe("github.com");
		expect(issues.filter).toBe("label:ready-for-agent");
		expect(specIssues.name).toBe("acme/factory-issues-team-core");
		expect(specIssues.kind).toBe("github-issues");
		expect(specIssues.refreshIntervalSeconds).toBe(60);
		expect(specIssues.repositories).toEqual(["acme/factory"]);
		expect(specIssues.filter).toBe("label:team-core");
		expect(pullRequests.name).toBe("acme/factory-pull-requests");
		expect(pullRequests.kind).toBe("github-pull-requests");
		expect(pullRequests.refreshIntervalSeconds).toBe(60);
		expect(pullRequests.repositories).toEqual(["acme/factory"]);
		expect(pullRequests.host).toBe("github.com");
		expect(pullRequests.filter).toBeUndefined();
	});

	test("a gate label that is not a plain word reaches the query quoted", () => {
		const [issues] = repositoryInitSources("acme/factory", "github.com", [
			{
				name: "squad",
				taskType: "implement",
				match: { sourceKind: "github-issue", labelsAny: ["team core"] },
			},
		]);
		expect(issues.filter).toBe('label:"team core"');
	});

	test("a machine that gates no issue falls back to the canonical entry label", () => {
		const [issues] = repositoryInitSources("acme/factory", "github.com", [
			{
				name: "ready-for-review",
				taskType: "review",
				match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
			},
		]);
		expect(issues.name).toBe("acme/factory-issues");
		expect(issues.filter).toBe("label:ready-for-agent");
	});

	test("a source the plane registered is its re-init's standing fact, not a collision", () => {
		const plane = repositoryInitSources("acme/factory", "github.com", statesFixture())[0];
		// The same name, kind, host, and repository set: the plane's own source.
		expect(isPlaneInitSource(plane, plane)).toBe(true);
		// Same name and kind, the operator's own filter: still the plane's source,
		// the filter the operator tuned is not the collision's fact.
		expect(isPlaneInitSource({ ...plane, filter: "label:mine" }, plane)).toBe(true);
		// Same kind, a different name: the operator's own source.
		expect(isPlaneInitSource({ ...plane, name: "factory-issues" }, plane)).toBe(false);
		// Same name, a different repository set: the operator's own source.
		expect(
			isPlaneInitSource(
				{ ...plane, repositories: ["acme/other"] },
				repositoryInitSources("acme/factory", "github.com", statesFixture())[0],
			),
		).toBe(false);
		// Same name and repository, a different host: the operator's own source.
		expect(
			isPlaneInitSource(
				{ ...plane, host: "git.example.com" },
				repositoryInitSources("acme/factory", "github.com", statesFixture())[0],
			),
		).toBe(false);
	});
});

describe("the Repository init act (ADR 0075)", () => {
	const identity = "github.com/acme/factory";
	const displayName = "acme/factory";
	const checkout = "/tmp/checkout";

	function runnerWith(branch: string, existingLabels: string[]): FakeRunner {
		const runner = new FakeRunner();
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: `refs/remotes/origin/${branch}\n`,
		});
		runner.set("git", ["-C", checkout, "fetch", "origin", branch], {});
		runner.set("gh", ["label", "list", "--repo", identity, "--json", "name"], {
			stdout: JSON.stringify(existingLabels.map((name) => ({ name }))),
		});
		runner.setDefault({ code: 0, stdout: "" });
		return runner;
	}

	test("a fresh repository: the full command stream, the created labels, and the pushed files", async () => {
		const worktree = tempDir("factory-init-wt-");
		const runner = runnerWith("main", []);
		// The worktree stages the generated files, so the act commits and pushes.
		runner.set("git", ["-C", worktree, "status", "--porcelain"], {
			stdout: "A AGENTS.md\nA docs/agents/domain.md\n",
		});
		runner.set("git", ["-C", worktree, "rev-parse", "HEAD"], { stdout: "abc123def\n" });

		const result = await runRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			host: "github.com",
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			instructionFile: "AGENTS.md",
			worktreePath: worktree,
		});
		expect(result).toHaveProperty("ok", true);
		if (!result.ok) return;
		expect(result.pushedCommit).toBe("abc123def");
		expect(result.targetBranch).toBe("main");
		expect(result.labelsCreated).toEqual(
			repositoryInitLabelSet(taskTypesFixture(), statesFixture()),
		);
		expect(result.labelsPresent).toEqual([]);
		expect(result.filesWritten).toEqual([...CONVENTION_FILE_PATHS]);

		// The command stream: fetch, the label pass, the throwaway worktree, the
		// commit, the push, and the worktree removal - in order.
		const commands = runner.commands();
		expect(commands).toContain(`git -C ${checkout} fetch origin main`);
		expect(commands).toContain(`git -C ${checkout} worktree add --detach ${worktree} origin/main`);
		expect(commands).toContain(`git -C ${worktree} add -A`);
		expect(commands).toContain(`git -C ${worktree} push origin HEAD:main`);
		expect(commands).toContain(`git -C ${checkout} worktree remove --force ${worktree}`);
		expect(commands).toContain(
			`gh label create ready-for-agent --repo ${identity} --color 0e8a16 --description Ready for an agent`,
		);
		// blocked is never created.
		expect(commands.find((c) => c.includes("gh label create blocked"))).toBe(undefined);

		// The generated bytes land in the worktree.
		for (const path of CONVENTION_FILE_PATHS) {
			expect(readFileSync(join(worktree, path), "utf8")).toBe(conventionFileContent(path));
		}
		const agents = readFileSync(join(worktree, "AGENTS.md"), "utf8");
		expect(agents).toContain(AGENT_SKILLS_HEADING);
		expect(agents).toContain("`acme/factory`");
	});

	test("an existing label is not re-created and an existing instruction file keeps its other sections", async () => {
		const worktree = tempDir("factory-init-wt-");
		const existing = ["needs-triage", "ready-for-agent"];
		const runner = runnerWith("main", existing);
		runner.set("git", ["-C", worktree, "rev-parse", "HEAD"], { stdout: "def456abc\n" });
		// A pre-existing AGENTS.md with a hand-written section before the block.
		const preExisting = `# Guide\n\n## Other section\n\nHand-written.\n`;
		// Seed the worktree with the existing instruction file before the act reads it.
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(worktree, "AGENTS.md"), preExisting, "utf8");

		const result = await runRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			host: "github.com",
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			instructionFile: "AGENTS.md",
			worktreePath: worktree,
		});
		expect(result).toHaveProperty("ok", true);
		if (!result.ok) return;
		// The existing labels are not in the created set.
		expect(result.labelsCreated).not.toContain("needs-triage");
		expect(result.labelsCreated).not.toContain("ready-for-agent");
		expect(result.labelsPresent).toEqual(existing);
		// The hand-written section survives the block-only surgery.
		const agents = readFileSync(join(worktree, "AGENTS.md"), "utf8");
		expect(agents).toContain("## Other section");
		expect(agents).toContain("Hand-written.");
		expect(agents).toContain(AGENT_SKILLS_HEADING);
	});

	test("a refused label write fails the act and names the refused label and the ones created before it", async () => {
		const worktree = tempDir("factory-init-wt-");
		const runner = runnerWith("main", []);
		// The third label in the set's order is refused, so two stand already.
		runner.set(
			"gh",
			[
				"label",
				"create",
				"needs-work",
				"--repo",
				identity,
				"--color",
				DEFAULT_LABEL_COLOR,
				"--description",
				"Factory workflow label",
			],
			{ code: 1, stderr: "label already exists or was refused\n" },
		);
		const result = await runRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			host: "github.com",
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			instructionFile: "AGENTS.md",
			worktreePath: worktree,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// The reason names the refused label and the labels created before it,
		// so the operator sees which labels already stand.
		expect(result.reason).toContain("needs-work");
		expect(result.reason).toContain("created before the refusal: needs-info, needs-triage");
		// The worktree was never opened: no push, no file writes.
		expect(runner.commands().find((c) => c.includes("worktree add"))).toBe(undefined);
	});

	test("a repository with no default branch refuses before any external change", async () => {
		const worktree = tempDir("factory-init-wt-");
		const runner = new FakeRunner();
		// No symref, and neither candidate branch resolves.
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], { code: 1 });
		runner.set(
			"git",
			["-C", checkout, "rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
			{ code: 1 },
		);
		runner.set(
			"git",
			["-C", checkout, "rev-parse", "--verify", "--quiet", "origin/master^{commit}"],
			{ code: 1 },
		);
		const result = await runRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			host: "github.com",
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			instructionFile: "AGENTS.md",
			worktreePath: worktree,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("default branch");
		// Only the branch rule's read ran; nothing external - no fetch, label, worktree, or push.
		const mutating = runner
			.commands()
			.filter(
				(c) =>
					c.includes("fetch") ||
					c.includes("label") ||
					c.includes("worktree") ||
					c.includes("push"),
			);
		expect(mutating).toEqual([]);
	});

	test("a refused push fails the act and the worktree is removed", async () => {
		const worktree = tempDir("factory-init-wt-");
		const runner = runnerWith("main", []);
		runner.set("git", ["-C", worktree, "status", "--porcelain"], { stdout: "A AGENTS.md\n" });
		runner.set("git", ["-C", worktree, "rev-parse", "HEAD"], { stdout: "abc123\n" });
		runner.set("git", ["-C", worktree, "push", "origin", "HEAD:main"], {
			code: 1,
			stderr: "protected branch\n",
		});
		const result = await runRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			host: "github.com",
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			instructionFile: "AGENTS.md",
			worktreePath: worktree,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("protected branch");
		expect(runner.commands()).toContain(`git -C ${checkout} worktree remove --force ${worktree}`);
	});

	test("a settings change that moves only labels re-inits without a commit or a push", async () => {
		// The no-change answer (ADR 0075, stories 21 and 22): the repository is
		// already init'd, so the worktree stages nothing and the act reads the
		// branch's HEAD and answers success with no commit and no push, leaving
		// the pushed commit to stand where it is.
		const worktree = tempDir("factory-init-wt-");
		const existing = repositoryInitLabelSet(taskTypesFixture(), statesFixture());
		const runner = runnerWith("main", existing);
		// The worktree stages nothing: every generated byte already stands.
		runner.set("git", ["-C", worktree, "status", "--porcelain"], { stdout: "" });
		runner.set("git", ["-C", worktree, "rev-parse", "HEAD"], { stdout: "abc123def\n" });

		const result = await runRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			host: "github.com",
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			instructionFile: "AGENTS.md",
			worktreePath: worktree,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The pushed commit is the branch's current HEAD, not a new commit.
		expect(result.pushedCommit).toBe("abc123def");
		// Every label already stands, so none are created and all are present.
		expect(result.labelsCreated).toEqual([]);
		expect(result.labelsPresent).toEqual(existing);
		// The act read the status and the HEAD, but committed nothing and pushed
		// nothing: the worktree was still opened and removed.
		const commands = runner.commands();
		expect(commands).toContain(`git -C ${worktree} add -A`);
		expect(commands).toContain(`git -C ${worktree} status --porcelain`);
		expect(commands).toContain(`git -C ${worktree} rev-parse HEAD`);
		expect(commands.find((c) => c.includes("commit"))).toBe(undefined);
		expect(commands.find((c) => c.includes("push"))).toBe(undefined);
		expect(commands).toContain(`git -C ${checkout} worktree remove --force ${worktree}`);
	});
});

describe("the Repository init plan (ADR 0075)", () => {
	const identity = "github.com/acme/factory";
	const displayName = "acme/factory";
	const checkout = "/tmp/checkout";

	test("it classifies files, labels, and the instruction file against the target branch", async () => {
		const runner = new FakeRunner();
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.set("git", ["-C", checkout, "fetch", "origin", "main"], {});
		// issue-tracker.md is absent (new); triage-labels.md differs; domain.md matches.
		runner.set("git", ["-C", checkout, "show", "origin/main:docs/agents/issue-tracker.md"], {
			code: 1,
		});
		runner.set("git", ["-C", checkout, "show", "origin/main:docs/agents/triage-labels.md"], {
			stdout: "stale triage\n",
		});
		runner.set("git", ["-C", checkout, "show", "origin/main:docs/agents/domain.md"], {
			stdout: conventionFileContent("docs/agents/domain.md"),
		});
		runner.set("git", ["-C", checkout, "show", "origin/main:CLAUDE.md"], { code: 1 });
		runner.set("git", ["-C", checkout, "show", "origin/main:AGENTS.md"], {
			stdout: "existing agents\n",
		});
		runner.set("gh", ["label", "list", "--repo", identity, "--json", "name"], {
			stdout: JSON.stringify([{ name: "needs-triage" }]),
		});
		runner.setDefault({ code: 0, stdout: "" });

		const plan = await planRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
		});
		expect(plan).not.toHaveProperty("ok");
		if ("ok" in plan) return;
		expect(plan.targetBranch).toBe("main");
		expect(plan.files.find((f) => f.path === "docs/agents/issue-tracker.md")?.action).toBe("new");
		expect(plan.files.find((f) => f.path === "docs/agents/triage-labels.md")?.action).toBe(
			"differing",
		);
		expect(plan.files.find((f) => f.path === "docs/agents/domain.md")?.action).toBe("unchanged");
		expect(plan.instructionFile).toBe("AGENTS.md");
		expect(plan.instructionFileChoiceNeeded).toBe(false);
		expect(plan.labelsPresent).toEqual(["needs-triage"]);
		expect(plan.labelsToCreate).toEqual(
			repositoryInitLabelSet(taskTypesFixture(), statesFixture()).filter(
				(l) => l !== "needs-triage",
			),
		);
	});

	test("a block whose run swallows a level-one section refuses the plan", async () => {
		const runner = new FakeRunner();
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.set("git", ["-C", checkout, "fetch", "origin", "main"], {});
		runner.set("git", ["-C", checkout, "show", "origin/main:CLAUDE.md"], { code: 1 });
		runner.set("git", ["-C", checkout, "show", "origin/main:AGENTS.md"], {
			stdout: `# Guide\n\n${AGENT_SKILLS_HEADING}\n\nold block\n\n# Late section\n\nHand-written.\n`,
		});
		runner.set("gh", ["label", "list", "--repo", identity, "--json", "name"], {
			stdout: "[]",
		});
		runner.setDefault({ code: 0, stdout: "" });
		const plan = await planRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
		});
		expect(plan).toHaveProperty("ok", false);
		if (!("ok" in plan)) throw new Error("expected the plan to refuse");
		expect(plan.reason).toContain("Late section");
		expect(plan.reason).toContain("AGENTS.md");
	});

	test("a repository with neither instruction file offers the choice", async () => {
		const runner = new FakeRunner();
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.set("git", ["-C", checkout, "fetch", "origin", "main"], {});
		runner.set("git", ["-C", checkout, "show", "origin/main:CLAUDE.md"], { code: 1 });
		runner.set("git", ["-C", checkout, "show", "origin/main:AGENTS.md"], { code: 1 });
		runner.set("gh", ["label", "list", "--repo", identity, "--json", "name"], {
			stdout: "[]",
		});
		runner.setDefault({ code: 0, stdout: "" });
		const plan = await planRepositoryInit({
			runner,
			checkout,
			identity,
			displayName,
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
		});
		expect(plan).not.toHaveProperty("ok");
		if ("ok" in plan) return;
		expect(plan.instructionFileChoiceNeeded).toBe(true);
	});
});

describe("the init fact (ADR 0075)", () => {
	test("it stores and reads one fact per repository, and drift is the hash mismatch", () => {
		const state = openFactoryState(":memory:");
		expect(state.repositoryInit.repositoryInitFact("acme/factory")).toBe(null);
		state.repositoryInit.setRepositoryInitFact("acme/factory", "hash-a", "commit-a");
		expect(state.repositoryInit.repositoryInitFact("acme/factory")).toEqual({
			repository: "acme/factory",
			settingsHash: "hash-a",
			pushedCommit: "commit-a",
			at: expect.any(String),
		});
		// A second repository is its own row: each read stands its own fact.
		state.repositoryInit.setRepositoryInitFact("acme/other", "hash-b", "commit-b");
		expect(state.repositoryInit.repositoryInitFact("acme/factory")?.settingsHash).toBe("hash-a");
		expect(state.repositoryInit.repositoryInitFact("acme/other")?.settingsHash).toBe("hash-b");
		// The drift helper: the stored hash against the current settings' hash.
		const fact = state.repositoryInit.repositoryInitFact("acme/factory");
		if (fact === null) throw new Error("expected a stored init fact");
		const drifted =
			fact.settingsHash !== repositoryInitSettingsHash(statesFixture(), taskTypesFixture());
		expect(drifted).toBe(true);
	});

	test("re-storing a fact for the same repository keeps one row", () => {
		const state = openFactoryState(":memory:");
		state.repositoryInit.setRepositoryInitFact("acme/factory", "hash-a", "commit-a");
		state.repositoryInit.setRepositoryInitFact("acme/factory", "hash-b", "commit-b");
		const fact = state.repositoryInit.repositoryInitFact("acme/factory");
		expect(fact).not.toBe(null);
		expect(fact?.settingsHash).toBe("hash-b");
		expect(fact?.pushedCommit).toBe("commit-b");
	});
});

describe("the repository init's commit flow", () => {
	const identity = "github.com/acme/factory";
	const displayName = "acme/factory";
	const checkout = "/tmp/checkout";

	function commitRunner(worktree: string): FakeRunner {
		const runner = new FakeRunner();
		runner.set("git", ["-C", checkout, "symbolic-ref", "refs/remotes/origin/HEAD"], {
			stdout: "refs/remotes/origin/main\n",
		});
		runner.set("git", ["-C", checkout, "fetch", "origin", "main"], {});
		runner.set("gh", ["label", "list", "--repo", identity, "--json", "name"], {
			stdout: "[]",
		});
		runner.set("git", ["-C", worktree, "rev-parse", "HEAD"], { stdout: "abc1234\n" });
		runner.setDefault({ code: 0, stdout: "" });
		return runner;
	}

	const repository = {
		identity,
		displayName,
		host: "github.com",
		cloneUrl: "https://github.com/acme/factory.git",
		checkout,
	};

	test("runs the act, registers the sources, and writes the init fact", async () => {
		const state = openFactoryState(":memory:");
		const worktree = tempDir("factory-init-flow-");
		const result = await commitRepositoryInit({
			runner: commitRunner(worktree),
			state,
			config: { sources: [] } as unknown as FactoryConfig,
			repository,
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			plan: {
				instructionFile: "AGENTS.md",
				labelsToCreate: repositoryInitLabelSet(taskTypesFixture(), statesFixture()),
				fileActions: CONVENTION_FILE_PATHS.map((path) => ({ path, action: "new" })),
			},
			worktreePath: worktree,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected the commit to pass");
		expect(result.newSources.map((s) => s.name)).toEqual([
			"acme/factory-issues",
			"acme/factory-issues-team-core",
			"acme/factory-pull-requests",
		]);
		const fact = state.repositoryInit.repositoryInitFact(identity);
		expect(fact?.pushedCommit).toBe("abc1234");
		expect(fact?.settingsHash).toBe(
			repositoryInitSettingsHash(statesFixture(), taskTypesFixture()),
		);
	});

	test("a source name the operator already names refuses before the act issues a command", async () => {
		const state = openFactoryState(":memory:");
		const worktree = tempDir("factory-init-flow-");
		// The operator's source wears the plane's name but no kind and another
		// repository set: it is the operator's, not the plane's registration.
		const busyConfig = {
			sources: [{ name: "acme/factory-issues", host: "github.com", repositories: ["acme/other"] }],
		} as unknown as FactoryConfig;
		const runner = commitRunner(worktree);
		const result = await commitRepositoryInit({
			runner,
			state,
			config: busyConfig,
			repository,
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			plan: { instructionFile: "AGENTS.md", labelsToCreate: [], fileActions: [] },
			worktreePath: worktree,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the commit to refuse");
		expect(result.reason).toBe("a source named acme/factory-issues is already configured");
		// The collision stops before the state write and before the act issues a
		// single command (ADR 0075, story 15): no fetch, label, or worktree ran.
		expect(state.repositoryInit.repositoryInitFact(identity)).toBe(null);
		expect(runner.commands()).toEqual([]);
	});

	test("a configured auth that fails to resolve refuses before the act issues a command", async () => {
		// Ambient auth is the fallback for a source that names no auth, never for
		// an auth the operator configured that failed to resolve: the label pass
		// and the push must not run against the wrong account.
		const state = openFactoryState(":memory:");
		const worktree = tempDir("factory-init-flow-");
		const runner = commitRunner(worktree);
		const result = await commitRepositoryInit({
			runner,
			state,
			config: { sources: [] } as unknown as FactoryConfig,
			repository: { ...repository, auth: { tokenEnv: "MLSF_TEST_NO_SUCH_VAR" } },
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			plan: { instructionFile: "AGENTS.md", labelsToCreate: [], fileActions: [] },
			worktreePath: worktree,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the commit to refuse");
		expect(result.reason).toContain("did not resolve");
		expect(result.reason).toContain("MLSF_TEST_NO_SUCH_VAR");
		// The refusal stands before the act: no fetch, label, or worktree ran.
		expect(runner.commands()).toEqual([]);
		expect(state.repositoryInit.repositoryInitFact(identity)).toBe(null);
	});

	test("the re-init stands over the sources the plane already registered", async () => {
		// The drift mechanism's one real use case (ADR 0075, stories 21 to 23):
		// after the first init, the config carries the plane's feeds, and
		// a settings change stands the repository in drift. The same key re-runs
		// the act, and the plane's own registrations are no collision: the
		// re-init passes them, re-writes the fact on the new settings, and
		// registers nothing new, so the config gains no duplicate row.
		const state = openFactoryState(":memory:");
		const worktree = tempDir("factory-init-reinit-");
		const plane = repositoryInitSources(displayName, "github.com", statesFixture());
		const reinitConfig = { sources: [...plane] } as unknown as FactoryConfig;
		const result = await commitRepositoryInit({
			runner: commitRunner(worktree),
			state,
			config: reinitConfig,
			repository,
			workflowStates: statesFixture(),
			taskTypes: taskTypesFixture(),
			plan: {
				instructionFile: "AGENTS.md",
				labelsToCreate: [],
				fileActions: CONVENTION_FILE_PATHS.map((path) => ({ path, action: "differing" })),
			},
			worktreePath: worktree,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected the re-init to pass");
		// Nothing new registers: the plane's sources already stand in the config.
		expect(result.newSources).toEqual([]);
		// The skip decision stands on the re-run, naming the covering sources
		// as the plane's own registrations.
		expect(result.skippedSources).toEqual([
			{ name: "acme/factory-issues", coveredBy: "acme/factory-issues" },
			{
				name: "acme/factory-issues-team-core",
				coveredBy: "acme/factory-issues-team-core",
			},
			{
				name: "acme/factory-pull-requests",
				coveredBy: "acme/factory-pull-requests",
			},
		]);
		// The fact re-writes on the current settings: the drift clears.
		expect(state.repositoryInit.repositoryInitFact(identity)?.settingsHash).toBe(
			repositoryInitSettingsHash(statesFixture(), taskTypesFixture()),
		);
		expect(repositoryInitDrifted(state, identity, statesFixture(), taskTypesFixture())).toBe(false);
	});

	describe("the coverage skip (issue 195)", () => {
		// A hand-written broad source per feed, covering four repositories
		// including the init's, the shape that doubled every ticket in the
		// diagnostic session.
		const broadRepositories = ["acme/factory", "acme/alpha", "acme/beta", "acme/gamma"];
		function broadConfig(): FactoryConfig {
			return {
				sources: [
					{
						name: "broad-issues",
						kind: "github-issues",
						refreshIntervalSeconds: 300,
						repositories: broadRepositories,
						host: "github.com",
					},
					{
						name: "broad-pull-requests",
						kind: "github-pull-requests",
						refreshIntervalSeconds: 300,
						repositories: broadRepositories,
						host: "github.com",
					},
				],
			} as unknown as FactoryConfig;
		}

		test("a filter-free source per feed skips every feed, names the skips, and leaves the fact standing", async () => {
			const state = openFactoryState(":memory:");
			const worktree = tempDir("factory-init-covered-");
			const result = await commitRepositoryInit({
				runner: commitRunner(worktree),
				state,
				config: broadConfig(),
				repository,
				workflowStates: statesFixture(),
				taskTypes: taskTypesFixture(),
				plan: {
					instructionFile: "AGENTS.md",
					labelsToCreate: [],
					fileActions: CONVENTION_FILE_PATHS.map((path) => ({ path, action: "new" })),
				},
				worktreePath: worktree,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected the commit to pass");
			// Every feed registers nothing: each already stands under the
			// operator's broad, filter-free sources.
			expect(result.newSources).toEqual([]);
			expect(result.skippedSources).toEqual([
				{ name: "acme/factory-issues", coveredBy: "broad-issues" },
				{
					name: "acme/factory-issues-team-core",
					coveredBy: "broad-issues",
				},
				{
					name: "acme/factory-pull-requests",
					coveredBy: "broad-pull-requests",
				},
			]);
			// The outcome names what it skipped and why, so the operator reads
			// the decision in the init answer.
			expect(result.message).toContain(
				"skipped acme/factory-issues (covered by broad-issues), acme/factory-issues-team-core (covered by broad-issues), acme/factory-pull-requests (covered by broad-pull-requests)",
			);
			// The act ran and the fact stands on the current settings: the
			// drift the plane reports is not about sources.
			expect(state.repositoryInit.repositoryInitFact(identity)?.pushedCommit).toBe("abc1234");
			expect(repositoryInitDrifted(state, identity, statesFixture(), taskTypesFixture())).toBe(
				false,
			);
		});

		test("a re-run over the same covering config skips again", async () => {
			const state = openFactoryState(":memory:");
			const first = tempDir("factory-init-covered-");
			const second = tempDir("factory-init-covered-");
			const plan: RepositoryInitFlowPlan = {
				instructionFile: "AGENTS.md",
				labelsToCreate: [],
				fileActions: [],
			};
			const run = async (worktree: string) =>
				commitRepositoryInit({
					runner: commitRunner(worktree),
					state,
					config: broadConfig(),
					repository,
					workflowStates: statesFixture(),
					taskTypes: taskTypesFixture(),
					plan,
					worktreePath: worktree,
				});
			const once = await run(first);
			expect(once.ok).toBe(true);
			if (!once.ok) throw new Error("expected the commit to pass");
			expect(once.newSources).toEqual([]);
			// The skip is derived from the current config on every run, so it
			// stands while the covering config stands.
			const again = await run(second);
			expect(again.ok).toBe(true);
			if (!again.ok) throw new Error("expected the re-run to pass");
			expect(again.newSources).toEqual([]);
			expect(again.skippedSources).toEqual(once.skippedSources);
		});

		test("removing the covering sources re-registers the pair", async () => {
			const state = openFactoryState(":memory:");
			const covered = tempDir("factory-init-covered-");
			const runCovered = await commitRepositoryInit({
				runner: commitRunner(covered),
				state,
				config: broadConfig(),
				repository,
				workflowStates: statesFixture(),
				taskTypes: taskTypesFixture(),
				plan: { instructionFile: "AGENTS.md", labelsToCreate: [], fileActions: [] },
				worktreePath: covered,
			});
			expect(runCovered.ok).toBe(true);
			if (!runCovered.ok) throw new Error("expected the commit to pass");
			expect(runCovered.newSources).toEqual([]);
			// The operator deleted the covering sources and re-ran the init:
			// the config holds none of them now, so every feed registers.
			const restored = tempDir("factory-init-restored-");
			const runRestored = await commitRepositoryInit({
				runner: commitRunner(restored),
				state,
				config: { sources: [] } as unknown as FactoryConfig,
				repository,
				workflowStates: statesFixture(),
				taskTypes: taskTypesFixture(),
				plan: { instructionFile: "AGENTS.md", labelsToCreate: [], fileActions: [] },
				worktreePath: restored,
			});
			expect(runRestored.ok).toBe(true);
			if (!runRestored.ok) throw new Error("expected the re-run to pass");
			expect(runRestored.newSources.map((s) => s.name)).toEqual([
				"acme/factory-issues",
				"acme/factory-issues-team-core",
				"acme/factory-pull-requests",
			]);
			expect(runRestored.skippedSources).toEqual([]);
		});

		test("a filtered source covers only the feed that reads its branch", async () => {
			const state = openFactoryState(":memory:");
			const worktree = tempDir("factory-init-covered-");
			// The broad source names a filter, so it reads one query branch: it
			// covers the feed for that same gate and no other (ADR 0115). The
			// feeds for the gates it does not read still register, and the pull
			// request feed has no filter to match, so it registers too.
			const config = {
				sources: [
					{
						name: "broad-issues",
						kind: "github-issues",
						refreshIntervalSeconds: 300,
						repositories: broadRepositories,
						host: "github.com",
						filter: "label:team-core",
					},
				],
			} as unknown as FactoryConfig;
			const result = await commitRepositoryInit({
				runner: commitRunner(worktree),
				state,
				config,
				repository,
				workflowStates: statesFixture(),
				taskTypes: taskTypesFixture(),
				plan: { instructionFile: "AGENTS.md", labelsToCreate: [], fileActions: [] },
				worktreePath: worktree,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected the commit to pass");
			// The missing feeds complete; the feed on the operator's own gate does
			// not duplicate.
			expect(result.newSources.map((s) => s.name)).toEqual([
				"acme/factory-issues",
				"acme/factory-pull-requests",
			]);
			expect(result.skippedSources).toEqual([
				{ name: "acme/factory-issues-team-core", coveredBy: "broad-issues" },
			]);
			expect(result.message).toContain(
				"skipped acme/factory-issues-team-core (covered by broad-issues)",
			);
		});

		test("a source on another host that names the repository is no coverage", async () => {
			const state = openFactoryState(":memory:");
			const worktree = tempDir("factory-init-covered-");
			// The same owner and name under a different host: coverage is per
			// host, so every feed registers as on a fresh config.
			const config = broadConfig();
			for (const source of config.sources) source.host = "github.example.com";
			const result = await commitRepositoryInit({
				runner: commitRunner(worktree),
				state,
				config,
				repository,
				workflowStates: statesFixture(),
				taskTypes: taskTypesFixture(),
				plan: { instructionFile: "AGENTS.md", labelsToCreate: [], fileActions: [] },
				worktreePath: worktree,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("expected the commit to pass");
			expect(result.newSources.map((s) => s.name)).toEqual([
				"acme/factory-issues",
				"acme/factory-issues-team-core",
				"acme/factory-pull-requests",
			]);
			expect(result.skippedSources).toEqual([]);
		});

		test("a same-name collision still refuses where the coverage check would skip", async () => {
			// The operator took the plane's issues name for a source on the same
			// host and kind listing the repository: the coverage check would
			// skip it, but the collision refusal stands first, unchanged.
			const state = openFactoryState(":memory:");
			const worktree = tempDir("factory-init-covered-");
			const config = {
				sources: [
					{
						name: "acme/factory-issues",
						kind: "github-issues",
						refreshIntervalSeconds: 300,
						repositories: broadRepositories,
						host: "github.com",
					},
				],
			} as unknown as FactoryConfig;
			const runner = commitRunner(worktree);
			const result = await commitRepositoryInit({
				runner,
				state,
				config,
				repository,
				workflowStates: statesFixture(),
				taskTypes: taskTypesFixture(),
				plan: { instructionFile: "AGENTS.md", labelsToCreate: [], fileActions: [] },
				worktreePath: worktree,
			});
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected the commit to refuse");
			expect(result.reason).toBe("a source named acme/factory-issues is already configured");
			expect(runner.commands()).toEqual([]);
			expect(state.repositoryInit.repositoryInitFact(identity)).toBe(null);
		});
	});
});

describe("the init drift", () => {
	test("a changed setting drifts the fact; a matching setting does not", () => {
		const state = openFactoryState(":memory:");
		const base = statesFixture();
		state.repositoryInit.setRepositoryInitFact(
			"github.com/acme/factory",
			repositoryInitSettingsHash(base, taskTypesFixture()),
			"abc1234",
		);
		expect(repositoryInitDrifted(state, "github.com/acme/factory", base, taskTypesFixture())).toBe(
			false,
		);
		const changed = base.map((s, i) => (i === 0 ? { ...s, name: "review" } : s));
		expect(
			repositoryInitDrifted(state, "github.com/acme/factory", changed, taskTypesFixture()),
		).toBe(true);
	});

	test("a repository never init'd is not drifted", () => {
		const state = openFactoryState(":memory:");
		expect(
			repositoryInitDrifted(state, "github.com/acme/other", statesFixture(), taskTypesFixture()),
		).toBe(false);
	});
});

describe("the Repository init panel (ADR 0075)", () => {
	/** One plan the test bends: a fresh repository, two labels, one new file. */
	const plan = (overrides: Partial<RepositoryInitPlan> = {}): RepositoryInitPlan => ({
		repository: "acme/factory",
		targetBranch: "main",
		labelsPresent: [],
		labelsToCreate: ["ready-for-review", "needs-work"],
		files: [{ path: "GLOSSARY.md", action: "new" }],
		instructionFile: "AGENTS.md",
		instructionFileChoiceNeeded: false,
		instructionFileAction: "new",
		...overrides,
	});

	test("it names the branch, the labels it creates, and each file's treatment", () => {
		const panel = repositoryInitPanel(plan());
		expect(panel.title).toBe("Init acme/factory");
		expect(panel.bodyLines).toContain("Pushes to main with a throwaway worktree.");
		expect(panel.bodyLines).toContain("Creates 2 labels:");
		expect(panel.bodyLines).toContain("  ready-for-review");
		expect(panel.bodyLines).toContain("  needs-work");
		expect(panel.bodyLines).toContain("GLOSSARY.md will be written");
		expect(panel.bodyLines).toContain(
			"The Agent skills block lands in AGENTS.md (will be created).",
		);
		// The ordinary confirm and stand-down keys.
		expect(panel.actions.map((row) => row.key)).toEqual(["init", "cancel"]);
	});

	test("the labels the act leaves stand stand beside the ones it creates (story 2)", () => {
		const panel = repositoryInitPanel(plan({ labelsPresent: ["ready-for-agent", "wontfix"] }));
		expect(panel.bodyLines).toContain("Already present (2): ready-for-agent, wontfix");
		// Every label already stands: the panel says so and names what stands.
		const allPresent = repositoryInitPanel(
			plan({ labelsToCreate: [], labelsPresent: ["ready-for-review"] }),
		);
		expect(allPresent.bodyLines).toContain("Every label the act writes already stands.");
		expect(allPresent.bodyLines).toContain("Already present (1): ready-for-review");
		// Neither: the panel says the repository stands bare.
		const bare = repositoryInitPanel(plan({ labelsToCreate: [], labelsPresent: [] }));
		expect(bare.bodyLines).toContain("No labels to create, and none stand in the repository.");
	});

	test("a repository with neither instruction file offers the two candidates (story 12)", () => {
		const panel = repositoryInitPanel(plan({ instructionFileChoiceNeeded: true }));
		expect(panel.bodyLines).toContain(
			"The repository has no instruction file; choose which to create.",
		);
		// The two confirm keys name the candidates, and Cancel stands down.
		expect(panel.actions.map((row) => row.key)).toEqual(["init-claude", "init-agents", "cancel"]);
		expect(panel.actions.map((row) => row.label)).toEqual(["CLAUDE.md", "AGENTS.md", "Cancel"]);
	});
});
