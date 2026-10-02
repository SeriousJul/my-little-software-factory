/**
 * The Repository init (ADR 0075): one operator-confirmed act that makes one
 * repository factory-ready, uniformly, from the factory's own settings.
 *
 * The generator is deterministic, and no agent runs. This module owns every
 * byte of the act's output:
 *
 * - the label set, derived from the workflow config - the union of every label
 *   a transition writes (the ticket facts and the pull request facts of every
 *   task type and branch) plus the five canonical triage labels, with `blocked`
 *   and the scoping labels excluded;
 * - the three convention files and the Agent skills block, from templates the
 *   plane owns in its own repository;
 * - the fixed label palette, one known color and description per canonical
 *   label.
 *
 * The act itself (labels, the throwaway-worktree write, the commit, the push)
 * runs through the Command runner, the plane's single egress, so the automated
 * suite pins the exact command stream with a fake and never touches a real
 * repository or GitHub. The plane never gates on, moves, or dirties the
 * operator's checkout: it pushes through a throwaway worktree on the remote
 * default branch, the same default-branch rule as the Worktree base. A
 * throwaway worktree the removal cannot take - the plane dies between the
 * add and the remove, or the removal fails - leaves an entry in the
 * checkout's worktree registry that stands until `git worktree prune`;
 * the path is a fresh temp directory, so the entry is inert.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import agentSkillsBlockTemplate from "../templates/agents/agent-skills-block.md" with {
	type: "text",
};
import domainTemplate from "../templates/agents/domain.md" with { type: "text" };
import issueTrackerTemplate from "../templates/agents/issue-tracker.md" with { type: "text" };
import triageLabelsTemplate from "../templates/agents/triage-labels.md" with { type: "text" };
import type { TaskTypeConfig, TicketSourceConfig, WorkflowState } from "./config.ts";
import {
	type CommandOptions,
	type CommandResult,
	type CommandRunner,
	commandFailureText,
	errorMessage,
} from "./runner.ts";
import { remoteDefaultBranch } from "./worktree-base.ts";

/**
 * The generator's version. It is one of the inputs to the init fact's settings
 * hash (ADR 0075): a change to a template, a label, or the generator's own
 * rule bumps it, and the bump stands every Initialized repository in Init
 * drift at once, with no read of the repositories.
 */
export const GENERATOR_VERSION = "1";

/** The five canonical triage roles the triage skill speaks in. */
export const CANONICAL_TRIAGE_LABELS = [
	"needs-triage",
	"needs-info",
	"ready-for-agent",
	"ready-for-human",
	"wontfix",
] as const;

/** The source-side filter label the plane never writes; a filter on a missing label matches nothing. */
export const BLOCKED_LABEL = "blocked";

/** One known color and description for `gh label create`, per canonical label. */
export interface LabelPaletteEntry {
	color: string;
	description: string;
}

/**
 * The fixed label palette (ADR 0075): one known color and description per
 * canonical triage label. A machine label a transition writes that the palette
 * does not name takes the default, so a new transition label never leaves the
 * act without a color.
 */
export const LABEL_PALETTE: Readonly<Record<string, LabelPaletteEntry>> = {
	"needs-triage": { color: "ffd60a", description: "Needs triage" },
	"needs-info": { color: "c2e0c6", description: "Needs information" },
	"ready-for-agent": { color: "0e8a16", description: "Ready for an agent" },
	"ready-for-human": { color: "5319e7", description: "Ready for a human" },
	wontfix: { color: "e99695", description: "Will not fix" },
};

/** The color a label takes: the palette's, or the default for a machine label. */
export const DEFAULT_LABEL_COLOR = "ededed";
/** The description a machine label that the palette does not name takes. */
const DEFAULT_LABEL_DESCRIPTION = "Factory workflow label";

/** The color `gh label create` takes for one label. */
export function labelColor(label: string): string {
	return LABEL_PALETTE[label]?.color ?? DEFAULT_LABEL_COLOR;
}

/** The description `gh label create` takes for one label. */
export function labelDescription(label: string): string {
	return LABEL_PALETTE[label]?.description ?? DEFAULT_LABEL_DESCRIPTION;
}

/**
 * The union of every label a transition writes (ADR 0075): the ticket facts
 * and the pull request facts of every task type, plus the same union of every
 * branch. A branch without its own facts set inherits the transition's for the
 * surface it names, so it is the transition's facts that count, not a second
 * list. The result is a set: an order the caller sorts.
 */
export function transitionWrittenLabels(taskTypes: Record<string, TaskTypeConfig>): Set<string> {
	const labels = new Set<string>();
	const add = (facts: readonly string[]): void => {
		for (const label of facts) labels.add(label);
	};
	for (const taskType of Object.values(taskTypes)) {
		const transition = taskType.transition;
		if (transition === undefined) continue;
		add(transition.ticketFacts);
		add(transition.pullRequestFacts);
		for (const branch of transition.branches ?? []) {
			if (branch.ticketFacts !== undefined) add(branch.ticketFacts);
			if (branch.pullRequestFacts !== undefined) add(branch.pullRequestFacts);
		}
	}
	return labels;
}

/**
 * The label set the Repository init creates in one repository (ADR 0075): the
 * union of every label a transition writes plus the five canonical triage
 * labels, with `blocked` excluded. The scoping labels a state match gates on
 * are absent by construction - a state match is not a transition, so a label
 * only a state names never reaches this set, and those gates stay the
 * operator's own to create. Sorted so the act and the panel list labels in
 * one order and a fresh repository's created set is stable.
 */
export function repositoryInitLabelSet(taskTypes: Record<string, TaskTypeConfig>): string[] {
	const set = transitionWrittenLabels(taskTypes);
	for (const label of CANONICAL_TRIAGE_LABELS) set.add(label);
	set.delete(BLOCKED_LABEL);
	return [...set].sort();
}

/** The three convention files the plane owns in an Initialized repository. */
export const CONVENTION_FILE_PATHS = [
	"docs/agents/issue-tracker.md",
	"docs/agents/triage-labels.md",
	"docs/agents/domain.md",
] as const;

/** The content the generator writes to one convention file. */
export function conventionFileContent(path: (typeof CONVENTION_FILE_PATHS)[number]): string {
	switch (path) {
		case "docs/agents/issue-tracker.md":
			return issueTrackerTemplate;
		case "docs/agents/triage-labels.md":
			return triageLabelsTemplate;
		case "docs/agents/domain.md":
			return domainTemplate;
	}
}

/** The map of every convention file's path to the bytes the generator writes. */
export function conventionFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	for (const path of CONVENTION_FILE_PATHS) files[path] = conventionFileContent(path);
	return files;
}

/** The instruction file names the Agent skills block lands in, in the order they win. */
export const INSTRUCTION_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;
export type InstructionFileName = (typeof INSTRUCTION_FILE_NAMES)[number];

/**
 * The instruction file the Agent skills block lands in, when a repository has
 * at least one (ADR 0075): `CLAUDE.md` wins over `AGENTS.md`, the setup skill's
 * own rule. Null when the repository has neither, so the panel can offer the
 * operator the choice instead of the plane picking.
 */
export function chooseInstructionFile(
	claudeExists: boolean,
	agentsExists: boolean,
): InstructionFileName | null {
	if (claudeExists) return "CLAUDE.md";
	if (agentsExists) return "AGENTS.md";
	return null;
}

/**
 * The Agent skills block the generator writes for one repository: the plane's
 * template with the repository's display name in its own line. The block is
 * the whole `## Agent skills` section, from its heading to its last line.
 */
export function agentSkillsBlock(repository: string): string {
	const block = agentSkillsBlockTemplate.replaceAll("{repository}", repository);
	return block.endsWith("\n") ? block : `${block}\n`;
}

/** The heading line of the Agent skills block, as the surgery matches it. */
export const AGENT_SKILLS_HEADING = "## Agent skills";

/**
 * The block-only surgery (ADR 0075): the Agent skills block of a repository's
 * instruction file, in place when the block exists and appended when it does
 * not, never touching the surrounding sections.
 *
 * The block runs from its `## Agent skills` heading to the next level-two
 * heading or the end of the file. An existing block is replaced by the
 * generated one, and the text before the heading and after the next
 * level-two heading stands exactly as it was: a hand-written section keeps
 * its bytes. An absent block is appended at the end, preceded by a blank line
 * when the file does not already end in one, so two blocks never touch and the
 * appended block is a clean section.
 */
export function applyAgentSkillsBlock(existing: string, block: string): string {
	const blockText = block.endsWith("\n") ? block : `${block}\n`;
	const headingRe = /^##\s+Agent skills\s*$/m;
	const match = headingRe.exec(existing);
	if (match === null) {
		const prefix = existing === "" ? "" : existing.endsWith("\n") ? existing : `${existing}\n\n`;
		return `${prefix}${blockText}`;
	}
	// The block ends at the next level-two heading, or at the end of the file.
	const tail = existing.slice(match.index + match[0].length);
	const nextLevelTwo = tail.search(/\n^##\s(?!##)/m);
	const end = nextLevelTwo >= 0 ? match.index + match[0].length + nextLevelTwo : existing.length;
	const before = existing.slice(0, match.index);
	// The `after` slice starts with the line break the next section's heading
	// takes, so the block's own trailing line break leaves exactly one blank
	// line between the block and the next section, and none at the very end of
	// the file.
	const after = existing.slice(end);
	return `${before}${blockText}${after}`;
}

/**
 * The level-one heading inside the Agent skills block's run, or null when the
 * run holds none (ADR 0075): the run ends at the next level-two heading or the
 * end of the file, so a `#` section inside the run has no level-two boundary
 * and the block-only surgery swallows it, and everything below, on a re-init.
 * The plan refuses to stand over such a file, and the operator moves the
 * heading above the block by hand.
 */
export function levelOneHeadingInBlockRun(existing: string): string | null {
	const match = /^##\s+Agent skills\s*$/m.exec(existing);
	if (match === null) return null;
	const tail = existing.slice(match.index + match[0].length);
	const nextLevelTwo = tail.search(/\n^##\s(?!##)/m);
	const run = nextLevelTwo >= 0 ? tail.slice(0, nextLevelTwo) : tail;
	const levelOne = run.match(/\n# [^\n]+/m);
	return levelOne === null ? null : levelOne[0].trim();
}

/** A stable JSON form: object keys sorted, arrays kept in order. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * The hash of the settings that determine the generated content (ADR 0075):
 * the workflow states and the task types' transitions, plus the generator's
 * version. It is the input to the init fact, so a change of any of them stands
 * every Initialized repository in Init drift at once, with no read of the
 * repositories. The template bytes ride on the version, not the hash, so a
 * template edit that leaves the version alone does not drift a repository -
 * the operator's hand edit is caught when they re-run the act.
 */
export function repositoryInitSettingsHash(
	workflowStates: readonly WorkflowState[],
	taskTypes: Record<string, TaskTypeConfig>,
): string {
	const inputs = {
		version: GENERATOR_VERSION,
		states: workflowStates.map((state) => ({
			name: state.name,
			match: state.match,
			...(state.taskType === undefined ? {} : { taskType: state.taskType }),
		})),
		transitions: Object.keys(taskTypes)
			.sort()
			.map((name) => ({ name, transition: taskTypes[name].transition ?? null })),
	};
	return createHash("sha256").update(canonicalJson(inputs)).digest("hex");
}

/**
 * The two sources the Repository init registers in the Config file (ADR
 * 0075), named by the predictable scheme: the repository's display name plus
 * the feed. Each refreshes every 60 seconds. The issues source carries the
 * `ready-for-agent` rank, so the machine sees the repository's ready work
 * from the first refresh; the pull request source carries no filter and so
 * lists the machine's pull request positions and its parking state the way the
 * source's own default policy does.
 */
export function repositoryInitSources(
	repository: string,
	host: string,
): [TicketSourceConfig, TicketSourceConfig] {
	const issues: TicketSourceConfig = {
		name: `${repository}-issues`,
		kind: "github-issues",
		refreshIntervalSeconds: 60,
		repositories: [repository],
		host,
		filter: "label:ready-for-agent",
	};
	const pullRequests: TicketSourceConfig = {
		name: `${repository}-pull-requests`,
		kind: "github-pull-requests",
		refreshIntervalSeconds: 60,
		repositories: [repository],
		host,
	};
	return [issues, pullRequests];
}

/**
 * Whether a configured source is the one the plane itself registered for the
 * init (ADR 0075): the same name, the same kind, the same host, and the same
 * repository set. Such a source is the re-init's own standing fact, not a
 * collision: the re-init stands its fact over it without re-registering it,
 * while a source the operator named under the same name with any other fact is
 * the collision the act refuses (story 15).
 *
 * An operator's edit to a plane-registered source - its filter or its refresh
 * interval - survives the re-init: re-registering would duplicate the row, so
 * the test compares the four facts above alone, and the plane never repairs
 * the source's edited facts.
 */
export function isPlaneInitSource(
	configured: TicketSourceConfig,
	source: TicketSourceConfig,
): boolean {
	return (
		configured.name === source.name &&
		configured.kind === source.kind &&
		configured.host === source.host &&
		[...configured.repositories].sort().join("\u0000") ===
			[...source.repositories].sort().join("\u0000")
	);
}

/**
 * Whether a configured source covers a planned source (issue 195): the host
 * is equal, the kind is equal, and the configured source's repository set
 * contains every repository the planned source names - the init's planned
 * sources each name exactly one. The name, the filter, and the refresh
 * interval do not count: coverage holds on host, kind, and repository alone,
 * so a broad operator source listing the repository alongside others covers
 * the feed with any filter it carries, and a source on another host is no
 * coverage even when it names the same owner and name.
 *
 * The plane-source test implies this one: a source the plane registered
 * covers itself, so the re-init registers nothing new under either rule.
 */
export function sourceCovers(configured: TicketSourceConfig, planned: TicketSourceConfig): boolean {
	return (
		configured.host === planned.host &&
		configured.kind === planned.kind &&
		planned.repositories.every((repository) => configured.repositories.includes(repository))
	);
}

// ---------------------------------------------------------------------------
// The act: the command stream the plane issues for one Repository init.
// ---------------------------------------------------------------------------

/** What the act needs to know about one repository and the factory's settings. */
export interface RepositoryInitInput {
	runner: CommandRunner;
	/** The resolved local checkout path the act runs git in; never moved or dirtied. */
	checkout: string;
	/** The host-qualified repository identity, the form `gh --repo` takes. */
	identity: string;
	/** The repository's display name, `owner/name`. */
	displayName: string;
	/** The GitHub host the repository lives on, for the registered sources. */
	host: string;
	workflowStates: readonly WorkflowState[];
	taskTypes: Record<string, TaskTypeConfig>;
	/**
	 * The instruction file the Agent skills block lands in. Required when the
	 * repository has neither `CLAUDE.md` nor `AGENTS.md`: the panel resolves
	 * the operator's choice before the act runs, so the plane never picks.
	 */
	instructionFile: InstructionFileName;
	/** The throwaway worktree's path. Defaults to a fresh directory in the temp area. */
	worktreePath?: string;
	/** The commit message the init commits under. */
	commitMessage?: string;
	/** The command options the repository's sources' auth resolves to; empty when ambient. */
	ghOptions?: CommandOptions;
}

/** The facts the act answers with when it completes. */
export interface RepositoryInitResult {
	ok: true;
	/** The commit the act pushed to the remote default branch. */
	pushedCommit: string;
	/** The remote default branch the commit landed on. */
	targetBranch: string;
	/** The labels the act created, in the set's order. */
	labelsCreated: string[];
	/** The labels that already stood in the repository. */
	labelsPresent: string[];
	/** The convention files the act wrote, in `CONVENTION_FILE_PATHS` order. */
	filesWritten: string[];
	/** The instruction file the Agent skills block landed in. */
	instructionFile: InstructionFileName;
}

/** The act's answer: the facts on success, the reason on failure. */
export type RepositoryInitOutcome = RepositoryInitResult | { ok: false; reason: string };

/** The label pass's success: the labels it created and the ones that already stood. */
export interface LabelCreationResult {
	created: string[];
	present: string[];
}

/** The label list `gh label list --json name` returns, read leniently. */
function parseLabelList(stdout: string): string[] {
	const start = stdout.indexOf("[");
	if (start < 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.slice(start));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const names: string[] = [];
	for (const item of parsed) {
		if (
			item !== null &&
			typeof item === "object" &&
			typeof (item as { name?: unknown }).name === "string"
		) {
			names.push((item as { name: string }).name);
		}
	}
	return names;
}

/** The reason the repository's labels could not be read. */
export interface LabelReadFailure {
	ok: false;
	reason: string;
}

/**
 * The existing labels of the repository, read through the command runner (a
 * pre-step of the act's label pass). The answer is the list on success and the
 * reason on failure, so the act and the plan can report the label read as the
 * failure that started them.
 */
export async function existingRepositoryLabels(
	runner: CommandRunner,
	identity: string,
	ghOptions?: CommandOptions,
): Promise<LabelReadFailure | string[]> {
	const result = await runner.run(
		"gh",
		["label", "list", "--repo", identity, "--json", "name"],
		ghOptions,
	);
	if (result.code !== 0)
		return {
			ok: false,
			reason: `could not list labels for ${identity}: ${commandFailureText(result)}`,
		};
	return parseLabelList(result.stdout);
}

/**
 * Create every missing label in the repository (step 1 of the act, ADR
 * 0075). A refused label write fails the act: the reason names the refused
 * label and the labels created before it, so a partial init never presents as
 * a success and the operator sees which labels already stand.
 */
export async function createMissingLabels(
	runner: CommandRunner,
	identity: string,
	labels: readonly string[],
	existing: readonly string[],
	ghOptions?: CommandOptions,
): Promise<RepositoryInitOutcome | LabelCreationResult> {
	const presentSet = new Set(existing);
	const toCreate = labels.filter((label) => !presentSet.has(label));
	const created: string[] = [];
	for (const label of toCreate) {
		const args = ["label", "create", label, "--repo", identity, "--color", labelColor(label)];
		const description = labelDescription(label);
		if (description !== "") args.push("--description", description);
		const result = await runner.run("gh", args, ghOptions);
		if (result.code !== 0) {
			const soFar =
				created.length === 0
					? "no labels had been created"
					: `created before the refusal: ${created.join(", ")}`;
			return {
				ok: false,
				reason: `could not create label ${label} in ${identity} (${soFar}): ${commandFailureText(result)}`,
			};
		}
		created.push(label);
	}
	return { created, present: [...existing] };
}

/**
 * The act itself (steps 1 to 3 of ADR 0075): read the repository's labels and
 * create the missing ones, fetch the remote default branch, open a throwaway
 * worktree on it, write the convention files and the Agent skills block,
 * commit, push to the remote branch, and remove the worktree. It never
 * touches the operator's checkout.
 */
export async function runRepositoryInit(
	input: RepositoryInitInput,
): Promise<RepositoryInitOutcome> {
	const { runner, checkout, identity, displayName, taskTypes } = input;
	// The remote default branch: the origin/HEAD symref, then origin/main, then
	// origin/master - the same rule as the Worktree base (ADR 0075). A repository
	// that offers none of them refuses the act before any external change.
	const branch = await remoteDefaultBranch(checkout, runner);
	if (branch === null) {
		return {
			ok: false,
			reason: `cannot fetch the remote default branch of ${displayName} (tried the origin/HEAD symref, then origin/main, then origin/master)`,
		};
	}
	const fetch = await runner.run("git", ["-C", checkout, "fetch", "origin", branch]);
	if (fetch.code !== 0)
		return {
			ok: false,
			reason: `fetching origin/${branch} failed: ${commandFailureText(fetch)}`,
		};

	// Step 1: the labels. Read what stands and create the rest.
	const labels = repositoryInitLabelSet(taskTypes);
	const existing = await existingRepositoryLabels(runner, identity, input.ghOptions);
	if (!Array.isArray(existing)) return existing;
	const labelResult = await createMissingLabels(
		runner,
		identity,
		labels,
		existing,
		input.ghOptions,
	);
	if (!("created" in labelResult)) return labelResult;

	// Steps 2 and 3: the throwaway worktree on the fetched branch.
	const worktreePath =
		input.worktreePath ??
		join(
			tmpdir(),
			`factory-init-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		);
	const add = await runner.run("git", [
		"-C",
		checkout,
		"worktree",
		"add",
		"--detach",
		worktreePath,
		`origin/${branch}`,
	]);
	if (add.code !== 0)
		return {
			ok: false,
			reason: `opening the throwaway worktree failed: ${commandFailureText(add)}`,
		};
	const cleanup = async (): Promise<void> => {
		await runner.run("git", ["-C", checkout, "worktree", "remove", "--force", worktreePath]);
	};
	const written: string[] = [];
	try {
		for (const path of CONVENTION_FILE_PATHS) {
			const target = join(worktreePath, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, conventionFileContent(path), "utf8");
			written.push(path);
		}
		// The Agent skills block, block-only surgery on the chosen instruction
		// file: a missing file is created, an existing one keeps its other
		// sections.
		const instructionPath = join(worktreePath, input.instructionFile);
		let existingInstruction = "";
		try {
			existingInstruction = await readFile(instructionPath, "utf8");
		} catch {
			existingInstruction = "";
		}
		await writeFile(
			instructionPath,
			applyAgentSkillsBlock(existingInstruction, agentSkillsBlock(displayName)),
			"utf8",
		);

		const addAll = await runner.run("git", ["-C", worktreePath, "add", "-A"]);
		if (addAll.code !== 0) {
			await cleanup();
			return {
				ok: false,
				reason: `staging the init files failed: ${commandFailureText(addAll)}`,
			};
		}
		// The no-change answer (ADR 0075, stories 21 and 22): a settings change
		// that moves only labels leaves every generated byte standing, so the
		// worktree stages nothing and the commit would fail on an empty tree.
		// Read the branch's HEAD and answer success without a commit or a push,
		// and the fact the flow writes under it clears the drift.
		const status = await runner.run("git", ["-C", worktreePath, "status", "--porcelain"]);
		if (status.code !== 0) {
			await cleanup();
			return {
				ok: false,
				reason: `reading the init worktree's status failed: ${commandFailureText(status)}`,
			};
		}
		let pushedCommit = "";
		if (status.stdout.trim() === "") {
			const head = await runner.run("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
			if (head.code !== 0 || head.stdout.trim() === "") {
				await cleanup();
				return {
					ok: false,
					reason: `reading the init commit failed: ${commandFailureText(head)}`,
				};
			}
			pushedCommit = head.stdout.trim();
		} else {
			const commit = await runner.run("git", [
				"-C",
				worktreePath,
				"commit",
				"-m",
				input.commitMessage ?? `Initialize ${displayName} for the factory`,
			]);
			if (commit.code !== 0) {
				await cleanup();
				return {
					ok: false,
					reason: `committing the init failed: ${commandFailureText(commit)}`,
				};
			}
			const commitSha = await runner.run("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
			if (commitSha.code !== 0 || commitSha.stdout.trim() === "") {
				await cleanup();
				return {
					ok: false,
					reason: `reading the init commit failed: ${commandFailureText(commitSha)}`,
				};
			}
			pushedCommit = commitSha.stdout.trim();
			const push = await runner.run("git", [
				"-C",
				worktreePath,
				"push",
				"origin",
				`HEAD:${branch}`,
			]);
			if (push.code !== 0) {
				await cleanup();
				return {
					ok: false,
					reason: `pushing the init commit to ${branch} failed: ${commandFailureText(push)}`,
				};
			}
		}
		await cleanup();
		return {
			ok: true,
			pushedCommit,
			targetBranch: branch,
			labelsCreated: labelResult.created,
			labelsPresent: labelResult.present,
			filesWritten: written,
			instructionFile: input.instructionFile,
		};
	} catch (error) {
		await cleanup();
		return { ok: false, reason: `writing the init files failed: ${errorMessage(error)}` };
	}
}

/** How one file of the target branch will be treated by the act. */
export type FileAction = "unchanged" | "differing" | "new";

/**
 * The plan of one Repository init (ADR 0075): exactly what the act will change
 * in one repository, read from the remote default branch, so the panel can
 * show it before the operator confirms. It reports the labels to create beside
 * the ones already present, each convention file as unchanged, differing (the
 * one the act overwrites), or new, and the instruction file the Agent skills
 * block lands in and its own action.
 */
export interface RepositoryInitPlan {
	repository: string;
	/** The remote default branch the act pushes to. */
	targetBranch: string;
	labelsPresent: string[];
	labelsToCreate: string[];
	/** Each convention file's path and how the act will treat it. */
	files: Array<{ path: string; action: FileAction }>;
	/** The instruction file the Agent skills block lands in. */
	instructionFile: InstructionFileName;
	/** True when the repository has neither instruction file and the panel must offer the choice. */
	instructionFileChoiceNeeded: boolean;
	/** How the act will treat the instruction file. */
	instructionFileAction: FileAction;
}

/** The reason the plane cannot plan one repository's init. */
export interface RepositoryInitPlanFailure {
	ok: false;
	reason: string;
}

/** The plan's answer: the plan on success, the reason on failure. */
export type RepositoryInitPlanResult = RepositoryInitPlan | RepositoryInitPlanFailure;

/**
 * Plan one repository's init (ADR 0075): read the remote default branch and
 * the repository's labels, and answer with exactly what the act will change.
 * It fetches the branch the way the act does, so the plan is what the act will
 * stand, and it never writes.
 */
export async function planRepositoryInit(input: {
	runner: CommandRunner;
	checkout: string;
	identity: string;
	displayName: string;
	taskTypes: Record<string, TaskTypeConfig>;
	ghOptions?: CommandOptions;
}): Promise<RepositoryInitPlanResult> {
	const { runner, checkout, identity, displayName, taskTypes } = input;
	const branch = await remoteDefaultBranch(checkout, runner);
	if (branch === null) {
		return {
			ok: false,
			reason: `cannot plan: the repository offers no remote default branch (tried the origin/HEAD symref, then origin/main, then origin/master)`,
		};
	}
	const fetch = await runner.run("git", ["-C", checkout, "fetch", "origin", branch]);
	if (fetch.code !== 0)
		return { ok: false, reason: `cannot plan: fetching origin/${branch} failed` };

	const labels = repositoryInitLabelSet(taskTypes);
	const present = await existingRepositoryLabels(runner, identity, input.ghOptions);
	if (!Array.isArray(present)) return present;
	const presentSet = new Set(present);
	const toCreate = labels.filter((label) => !presentSet.has(label));

	const files: Array<{ path: string; action: FileAction }> = [];
	for (const path of CONVENTION_FILE_PATHS) {
		const current = await targetBranchFile(runner, checkout, branch, path);
		const action: FileAction =
			current === null
				? "new"
				: current === conventionFileContent(path)
					? "unchanged"
					: "differing";
		files.push({ path, action });
	}

	const claude = await targetBranchFile(runner, checkout, branch, "CLAUDE.md");
	const agents = await targetBranchFile(runner, checkout, branch, "AGENTS.md");
	const choice = chooseInstructionFile(claude !== null, agents !== null);
	const instructionFile = choice ?? "AGENTS.md";
	const currentInstruction = choice === "CLAUDE.md" ? claude : agents;
	// The block's run swallows a level-one section it holds (the run ends at the
	// next level-two heading or the end of the file), so the plan refuses to
	// stand over a file whose surgery would take the operator's section with it.
	if (currentInstruction !== null) {
		const swallowed = levelOneHeadingInBlockRun(currentInstruction);
		if (swallowed !== null)
			return {
				ok: false,
				reason: `cannot plan: the Agent skills block of ${instructionFile} runs into the level-one heading "${swallowed}": the re-init would swallow that section and everything below it. Move the heading above the block by hand`,
			};
	}
	const withBlock = applyAgentSkillsBlock(currentInstruction ?? "", agentSkillsBlock(displayName));
	const instructionFileAction: FileAction =
		currentInstruction === null
			? "new"
			: currentInstruction === withBlock
				? "unchanged"
				: "differing";

	return {
		repository: displayName,
		targetBranch: branch,
		labelsPresent: [...present].sort(),
		labelsToCreate: toCreate,
		files,
		instructionFile,
		instructionFileChoiceNeeded: choice === null,
		instructionFileAction,
	};
}

/** The content of one file on the remote default branch, or null when it is absent. */
export async function targetBranchFile(
	runner: CommandRunner,
	checkout: string,
	branch: string,
	path: string,
): Promise<string | null> {
	const result: CommandResult = await runner.run("git", [
		"-C",
		checkout,
		"show",
		`origin/${branch}:${path}`,
	]);
	if (result.code !== 0) return null;
	return result.stdout;
}
