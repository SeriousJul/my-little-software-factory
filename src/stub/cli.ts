/**
 * The world CLI (issue #178, ADR 0073).
 *
 * The operator's hand on the Stub world between turns: add an issue, add a
 * pull request, undraft a pull request, set labels, add a comment, set the
 * merge gate, and reset to the seed. The world file path is an argument,
 * and a direct hand edit of the file stays legal: the CLI, the edit, and the
 * run meet on the file, and the run re-reads it on every command, so an edit
 * stands for the run on its next command.
 */
import { stubWorldSeed } from "./seed.ts";
import { StubWorldStore } from "./world.ts";

export interface WorldCliResult {
	ok: boolean;
	lines: string[];
}

/** The verbs the world CLI answers, in its usage line. */
export const WORLD_CLI_USAGE =
	"usage: stub-world <world-file> <add-issue|add-pull-request|undraft|set-labels|add-comment|set-merge-gate|set-auto-score|reset>";

interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string[]>;
	booleans: Set<string>;
}

function parseArgs(tokens: readonly string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags = new Map<string, string[]>();
	const booleans = new Set<string>();
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const name = token.slice(2);
		const value = tokens[i + 1];
		if (value === undefined || value.startsWith("--")) {
			booleans.add(name);
			continue;
		}
		flags.set(name, [...(flags.get(name) ?? []), value]);
		i += 1;
	}
	return { positionals, flags, booleans };
}

const fail = (reason: string): WorldCliResult => ({ ok: false, lines: [reason] });
const ok = (lines: string[]): WorldCliResult => ({ ok: true, lines });

function repoOf(world: StubWorldStore, name: string) {
	return world.world.repositories.find(
		(repository) => repository.name.toLowerCase() === name.toLowerCase(),
	);
}

function itemNumber(flags: Map<string, string[]>): number | null {
	const value = flags.get("number")?.[0] ?? flags.get("issue")?.[0] ?? flags.get("pr")?.[0];
	if (value === undefined) return null;
	if (!/^\d+$/.test(value)) return null;
	return Number(value);
}

/** Run one world CLI call. The first argument is the world file, the second the verb. */
export async function worldCli(argv: readonly string[]): Promise<WorldCliResult> {
	const [worldPath, verb, ...rest] = argv;
	if (worldPath === undefined || verb === undefined) return fail(WORLD_CLI_USAGE);
	let store: StubWorldStore;
	try {
		store = StubWorldStore.load(worldPath);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	const args = parseArgs(rest);
	try {
		switch (verb) {
			case "add-issue":
				return addIssue(store, args);
			case "add-pull-request":
				return addPullRequest(store, args);
			case "undraft":
				return undraft(store, args);
			case "set-labels":
				return setLabels(store, args);
			case "add-comment":
				return addComment(store, args);
			case "set-merge-gate":
				return setMergeGate(store, args);
			case "set-auto-score":
				return setAutoScore(store, args);
			case "reset":
				resetToSeed(store);
				return ok([`the world at ${store.path} is the seed again`]);
			default:
				return fail(WORLD_CLI_USAGE);
		}
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

function requireRepo(store: StubWorldStore, flags: Map<string, string[]>) {
	const name = flags.get("repo")?.[0];
	if (name === undefined) throw new Error("the verb needs --repo");
	const repository = repoOf(store, name);
	if (repository === undefined) throw new Error(`the world has no repository named ${name}`);
	return repository;
}

function addIssue(store: StubWorldStore, args: ParsedArgs): WorldCliResult {
	const repository = requireRepo(store, args.flags);
	const number = itemNumber(args.flags);
	const title = args.flags.get("title")?.[0];
	if (number === null) throw new Error("the verb needs --number");
	if (title === undefined || title === "") throw new Error("the verb needs --title");
	if (repository.issues.some((item) => item.number === number))
		throw new Error(`issue #${number} already stands in ${repository.name}`);
	const labels = args.flags.get("label") ?? [];
	repository.issues.push({
		number,
		title,
		body: args.flags.get("body")?.[0] ?? "",
		labels,
		state: "open",
		updatedAt: new Date().toISOString(),
		comments: [],
	});
	store.save();
	return ok([`issue #${number} ${title} stands in ${repository.name}`]);
}

function addPullRequest(store: StubWorldStore, args: ParsedArgs): WorldCliResult {
	const repository = requireRepo(store, args.flags);
	const number = itemNumber(args.flags);
	const title = args.flags.get("title")?.[0];
	if (number === null) throw new Error("the verb needs --number");
	if (title === undefined || title === "") throw new Error("the verb needs --title");
	const headBranch = args.flags.get("head-branch")?.[0];
	if (headBranch === undefined || headBranch === "")
		throw new Error("the verb needs --head-branch, the branch the pull request pushes from");
	if (repository.pullRequests.some((item) => item.number === number))
		throw new Error(`pull request #${number} already stands in ${repository.name}`);
	const closing = (args.flags.get("closing")?.[0] ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter((item) => /^\d+$/.test(item))
		.map(Number);
	repository.pullRequests.push({
		number,
		title,
		body: args.flags.get("body")?.[0] ?? "",
		labels: args.flags.get("label") ?? [],
		state: "open",
		merged: false,
		draft: args.booleans.has("draft"),
		headBranch,
		closingIssueNumbers: closing,
		comments: [],
		reviews: [],
		updatedAt: new Date().toISOString(),
	});
	store.save();
	return ok([`pull request #${number} ${title} stands in ${repository.name}`]);
}

function setLabels(store: StubWorldStore, args: ParsedArgs): WorldCliResult {
	const repository = requireRepo(store, args.flags);
	const number = itemNumber(args.flags);
	const labelsValue = args.flags.get("labels");
	if (number === null) throw new Error("the verb needs --issue or --pr");
	if (labelsValue === undefined) throw new Error("the verb needs --labels");
	const labels = labelsValue[0]
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
	const isPr = args.flags.has("pr");
	const item = isPr
		? repository.pullRequests.find((entry) => entry.number === number)
		: repository.issues.find((entry) => entry.number === number);
	if (item === undefined)
		throw new Error(`no ${isPr ? "pull request" : "issue"} #${number} in ${repository.name}`);
	item.labels = labels;
	item.updatedAt = new Date().toISOString();
	store.save();
	return ok([
		`${isPr ? "pull request" : "issue"} #${number} wears ${labels.join(", ") || "no label"}`,
	]);
}

function addComment(store: StubWorldStore, args: ParsedArgs): WorldCliResult {
	const repository = requireRepo(store, args.flags);
	const number = itemNumber(args.flags);
	const body = args.flags.get("body")?.[0];
	if (number === null) throw new Error("the verb needs --issue or --pr");
	if (body === undefined || body === "") throw new Error("the verb needs --body");
	const isPr = args.flags.has("pr");
	const pull = isPr ? repository.pullRequests.find((entry) => entry.number === number) : undefined;
	if (isPr && pull === undefined)
		throw new Error(`no pull request #${number} in ${repository.name}`);
	if (pull !== undefined) {
		pull.comments.push({ body, createdAt: new Date().toISOString() });
		pull.updatedAt = new Date().toISOString();
		store.save();
		return ok([`the comment stands on pull request #${number} in ${repository.name}`]);
	}
	const issue = repository.issues.find((entry) => entry.number === number);
	if (issue === undefined) throw new Error(`no issue #${number} in ${repository.name}`);
	issue.comments.push({ body, createdAt: new Date().toISOString() });
	issue.updatedAt = new Date().toISOString();
	store.save();
	return ok([`the comment stands on issue #${number} in ${repository.name}`]);
}

function undraft(store: StubWorldStore, args: ParsedArgs): WorldCliResult {
	const repository = requireRepo(store, args.flags);
	const number = itemNumber(args.flags);
	if (number === null) throw new Error("the verb needs --pr");
	const pull = repository.pullRequests.find((entry) => entry.number === number);
	if (pull === undefined) throw new Error(`no pull request #${number} in ${repository.name}`);
	pull.draft = false;
	pull.updatedAt = new Date().toISOString();
	store.save();
	return ok([`pull request #${number} in ${repository.name} is not a draft`]);
}

function setMergeGate(store: StubWorldStore, args: ParsedArgs): WorldCliResult {
	const repository = requireRepo(store, args.flags);
	const number = itemNumber(args.flags);
	if (number === null) throw new Error("the verb needs --pr");
	if (!repository.pullRequests.some((item) => item.number === number))
		throw new Error(`no pull request #${number} in ${repository.name}`);
	const passing = args.booleans.has("pass");
	const failing = args.booleans.has("fail");
	if (passing === failing) throw new Error("the verb needs --pass or --fail");
	repository.mergeGates[String(number)] = {
		passing,
		reason: args.flags.get("reason")?.[0] ?? "",
	};
	store.save();
	return ok([
		`the merge gate of pull request #${number} in ${repository.name} is ${
			passing ? "passing" : "failing"
		}`,
	]);
}

function setAutoScore(store: StubWorldStore, args: ParsedArgs): WorldCliResult {
	const on = args.booleans.has("on");
	const off = args.booleans.has("off");
	const inherit = args.booleans.has("inherit");
	const target = args.flags.get("pr")?.[0];
	if (target !== undefined) return setAutoScorePull(store, target, { on, off, inherit });
	if (on === off) throw new Error("the verb needs --on or --off");
	store.world.autoScore.enabled = on;
	if (args.flags.has("score")) {
		const score = Number(args.flags.get("score")?.[0]);
		if (!Number.isFinite(score)) throw new Error("the score is not a number");
		store.world.autoScore.score = score;
	}
	store.save();
	return ok([
		`the world's auto score is ${on ? "on" : "off"}, ${store.world.autoScore.score} / 100`,
	]);
}

/** The one world write one auto-score pull-request target lands. */
function setAutoScorePull(
	store: StubWorldStore,
	target: string,
	verbs: { on: boolean; off: boolean; inherit: boolean },
): WorldCliResult {
	const { on, off, inherit } = verbs;
	const cut = target.lastIndexOf(":");
	const numberPart = cut > 0 ? target.slice(cut + 1) : "";
	if (cut <= 0 || !/^\d+$/.test(numberPart))
		throw new Error("the --pr target has the form owner/name:N");
	const parts = target.slice(0, cut).split("/");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "")
		throw new Error("the --pr target has the form owner/name:N");
	const repository =
		parts[0].toLowerCase() === store.world.owner.toLowerCase()
			? repoOf(store, parts[1])
			: undefined;
	const number = Number(numberPart);
	const pull = repository?.pullRequests.find((item) => item.number === number);
	if (repository === undefined || pull === undefined)
		throw new Error(`no pull request ${target} in the world`);
	if (inherit) delete pull.autoScore;
	else if (on) pull.autoScore = true;
	else if (off) pull.autoScore = false;
	else throw new Error("the --pr target needs --on, --off, or --inherit");
	store.save();
	return ok([
		`the auto score rule of pull request ${target} is ${inherit ? "inherited" : on ? "on" : "off"}`,
	]);
}

function resetToSeed(store: StubWorldStore): void {
	Object.assign(store.world, stubWorldSeed());
	store.save();
}
