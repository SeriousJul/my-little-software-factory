/**
 * The Stub world (issue #178, ADR 0073).
 *
 * The Stub world is a JSON file and the source of truth of the stub side:
 * repositories, issues, pull requests, the merge gate fact of each pull
 * request, and the security feeds. Every mutation a plane write or a world
 * CLI verb makes goes through this store and writes the file atomically,
 * and the store re-reads the file before every answer, so a CLI or hand
 * edit stands for the run on the next command, and a restart finds the
 * world where the operator left it.
 *
 * The store answers the closed `gh` surface the plane issues: the GraphQL
 * search the sources fetch, the comments and reviews reads the score
 * Judgment walks, the pull request record read the open and merged Judgment
 * takes, the issue and pull request edits the transitions and the Placement
 * write, the merge and the blocked comment the plane action runs, and the
 * auth token only when a source names an auth, which the stub configuration
 * never does. A `gh` command outside the surface is refused, and the refusal
 * is recorded: the closed-surface check reads the record and fails when a
 * real command shape met a refusal, so the surface stays closed when the
 * plane grows.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CommandResult } from "../runner.ts";
import { SEARCH_QUERY } from "../ticket-source.ts";
import { scoreFromMessage } from "../workflow.ts";

/** A posted comment on a pull request, or a posted review. */
export interface StubComment {
	body: string;
	createdAt: string;
}
export interface StubReview {
	body: string;
	submittedAt: string;
}

/** One issue in the world. */
export interface StubIssue {
	number: number;
	title: string;
	body: string;
	labels: string[];
	state: "open" | "closed";
	updatedAt: string;
	comments: StubComment[];
}

/** One pull request in the world. */
export interface StubPullRequest extends StubIssue {
	merged: boolean;
	draft: boolean;
	headBranch: string;
	/** The branch the pull request merges into; absent worlds read as `main`. */
	base?: string;
	closingIssueNumbers: number[];
	comments: StubComment[];
	reviews: StubReview[];
	/**
	 * The per-pull-request override of the world's auto score rule. `true`
	 * posts, `false` never posts, and the absence inherits the world.
	 */
	autoScore?: boolean;
	/**
	 * Whether the world handled the pull request's first comment read under
	 * the auto score rule, posted or not: the rule runs once per pull
	 * request, so a later read never posts a second score.
	 */
	scorePosted?: boolean;
}

/** The merge gate fact of one pull request. */
export interface StubMergeGate {
	passing: boolean;
	reason: string;
}

/** The security feed items of one repository, as GitHub lists them. */
export interface StubSecurity {
	advisories: Array<Record<string, unknown>>;
	dependabotAlerts: Array<Record<string, unknown>>;
	secretScanningAlerts: Array<Record<string, unknown>>;
}

/** One repository in the world. */
export interface StubRepository {
	name: string;
	/**
	 * The repository's label set: the labels that stand in the repository today.
	 * The `gh label list` answer and the item-edit refusal both read it (ADR
	 * 0075, the init act's label seam), and `gh label create` adds to it. Where
	 * it stands unset the world holds no closed surface for the labels: the list
	 * answers empty and the item edit takes any label, the way the world did
	 * before the seam. A set that stands enforces the refusal.
	 */
	labels?: string[];
	issues: StubIssue[];
	pullRequests: StubPullRequest[];
	mergeGates: Record<string, StubMergeGate>;
	security: StubSecurity;
}

/** The world file's document. */
export interface StubWorld {
	version: 1;
	host: string;
	owner: string;
	autoScore: { enabled: boolean; score: number };
	repositories: StubRepository[];
}

/** The world's read or its write failed. */
export class StubWorldError extends Error {}

/**
 * The world's answer to one `gh` command. `code` is the exit code the
 * command would have had, and `stderr` carries the GitHub-style refusal for
 * a failed command, the way the plane's own readers take it.
 */
type Answer = CommandResult;

const now = () => new Date().toISOString();

/**
 * The auto score body the world posts: the template's fixed score line with
 * its scale, the way the review agent posts it. The score reader parses the
 * line back, so the posted score is the score the judgment reads.
 */
export function autoScoreBody(score: number): string {
	return [
		`- **Score:** ${score} / 100`,
		"- **Specification Check:** Pass",
		"- **Quality Check:** Pass",
		"- **Required Changes:** none",
	].join("\n");
}

/** Whether a pull request's posted records already carry a verdict. */
function hasVerdict(pr: StubPullRequest): boolean {
	return (
		pr.comments.some((comment) => scoreFromMessage(comment.body) !== null) ||
		pr.reviews.some((review) => scoreFromMessage(review.body) !== null)
	);
}

export class StubWorldStore {
	readonly path: string;
	/** The world the store answers from: the file's contents, re-read on every command. */
	world: StubWorld;
	/**
	 * The `gh` command shapes the world refused, in the order they came.
	 * In memory only: the refusal is the closed-surface check's fact, not
	 * world state. The empty record is the pass.
	 */
	readonly refusals: string[] = [];

	private constructor(path: string, world: StubWorld) {
		this.path = path;
		this.world = world;
	}

	/** Read and validate the world file. A missing or malformed file is an error. */
	static load(path: string): StubWorldStore {
		return new StubWorldStore(path, readWorld(path));
	}

	/** Write the world to its file atomically: temp file, then rename. */
	save(): void {
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify(this.world, null, 2)}\n`);
		renameSync(temp, this.path);
	}

	/**
	 * Answer one `gh` command from the world. Commands outside the closed
	 * surface are refused and recorded; a command inside it gets the
	 * GitHub-shaped answer the plane's readers take.
	 *
	 * The answer starts from a re-read of the file: the file is the source
	 * of truth, so a world CLI or hand edit made between commands stands on
	 * the next command, and a mutation the store writes through does not
	 * clobber an edit that landed before the store read the file.
	 */
	answerGh(args: readonly string[]): Answer {
		try {
			this.world = readWorld(this.path);
		} catch (error) {
			const reason = error instanceof StubWorldError ? error.message : String(error);
			return { code: 1, stdout: "", stderr: `the stub world cannot be read: ${reason}\n` };
		}
		if (args[0] === "auth") return this.answerAuth(args);
		if (args[0] === "api") return this.answerApi(args);
		if (args[0] === "label") return this.answerLabel(args);
		if (args[0] === "issue" || args[0] === "pr") return this.answerItem(args);
		return this.refusal(args, "an unknown GitHub command");
	}

	// The label commands the init act runs (ADR 0075, stories 6 and 16): the
	// list reads the repository's label set one name per line, the way the
	// act's `--jq '.[].name'` parses it, and the create adds a label to the
	// set the walk keeps. A repository the world does not know is refused.
	private answerLabel(args: readonly string[]): Answer {
		const verb = args[1];
		if (verb === "list") return this.labelList(args);
		if (verb === "create") return this.labelCreate(args);
		return this.refusal(args, `an unknown label command: ${verb ?? ""}`);
	}

	private labelList(args: readonly string[]): Answer {
		// The list takes the repository on the `--repo` flag, the way the
		// act's read issues it.
		const flag = repoFlagFrom(args, 2);
		if (flag.missing) return this.refusal(args, "the repo flag has no value");
		const repository = flag.identity === null ? null : this.repositoryOfIdentity(flag.identity);
		if (repository === null)
			return this.refusal(args, `the world does not know the repository: ${flag.identity ?? ""}`);
		// The act's read takes `--json name` and parses the array of name
		// objects, so the answer is the real `gh` JSON shape, not one name per line.
		return {
			code: 0,
			stdout: JSON.stringify((repository.labels ?? []).map((name) => ({ name }))),
			stderr: "",
		};
	}

	private labelCreate(args: readonly string[]): Answer {
		const name = args[2];
		const flag = repoFlagFrom(args, 3);
		if (flag.missing) return this.refusal(args, "the repo flag has no value");
		// The `-y` flag and any other flag the act passes are accepted and ignored.
		if (name === undefined || name === "") return this.refusal(args, "no label name");
		const repository = flag.identity === null ? null : this.repositoryOfIdentity(flag.identity);
		if (repository === null)
			return this.refusal(args, `the world does not know the repository: ${flag.identity ?? ""}`);
		this.addLabelToRepository(repository, name);
		return { code: 0, stdout: `created ${name}\n`, stderr: "" };
	}

	/** The label joins the repository's set when it holds it not. */
	private addLabelToRepository(repository: StubRepository, name: string): void {
		if (repository.labels === undefined) repository.labels = [];
		const labels = repository.labels;
		if (!labels.some((entry) => entry.toLowerCase() === name.toLowerCase())) labels.push(name);
		this.save();
	}

	// The auth token: the stub configuration names no auth, so the plane
	// never resolves it. A source that named an auth gets the stub token,
	// which answers the read and keeps the token out of any real account.
	private answerAuth(args: readonly string[]): Answer {
		const expected = args.slice(1);
		if (
			expected.length < 5 ||
			expected[0] !== "token" ||
			expected[1] !== "--hostname" ||
			expected[3] !== "--user" ||
			expected[2] !== this.world.host
		)
			return this.refusal(args, "an unknown auth command");
		return { code: 0, stdout: "stub-world-token\n", stderr: "" };
	}

	// One `gh api` call. The positional is the endpoint, the flags carry the
	// hostname, the method, the pagination, and the form fields.
	private answerApi(args: readonly string[]): Answer {
		const tokens = args.slice(1);
		const parsed = this.apiParseTokens(tokens, args);
		if ("code" in parsed) return parsed;
		const { endpoint, hostname, fields } = parsed;
		if (hostname !== this.world.host)
			return this.refusal(args, `a host the world does not serve: ${hostname ?? ""}`);
		// The query the direct read rides on (ADR 0076): the state and head
		// filters of the pull request list, read off the endpoint.
		const query = this.apiParseQuery(endpoint, args);
		if (!query.ok) return this.refusal(args, `an unreadable query in the endpoint: ${query.pair}`);
		const path = apiEndpointPath(endpoint);
		if (path === "graphql") return this.answerSearch(fields, args);
		if (path.startsWith("repos/")) return this.answerRepo(args, path, fields, query.query);
		return this.refusal(args, `an endpoint the world does not know: ${path}`);
	}

	private apiParseTokens(
		tokens: string[],
		args: readonly string[],
	): { endpoint: string; hostname: string | null; fields: Map<string, string> } | Answer {
		let endpoint: string | null = null;
		let hostname: string | null = null;
		const fields = new Map<string, string>();
		for (let i = 0; i < tokens.length; i += 1) {
			const step = apiTokenStep(tokens[i], tokens, i, endpoint);
			if (step.reason !== undefined) return this.refusal(args, step.reason);
			if (step.endpoint !== undefined) endpoint = step.endpoint;
			if (step.hostname !== undefined) hostname = step.hostname;
			if (step.field !== undefined) fields.set(step.field[0], step.field[1]);
			i += step.advance;
		}
		if (endpoint === null) return this.refusal(args, "no endpoint");
		return { endpoint, hostname, fields };
	}

	private apiParseQuery(
		endpoint: string,
		args: readonly string[],
	): { ok: true; query: Map<string, string> } | { ok: false; pair: string } {
		const queryIndex = endpoint.indexOf("?");
		const query = new Map<string, string>();
		if (queryIndex === -1) return { ok: true, query };
		for (const pair of endpoint.slice(queryIndex + 1).split("&")) {
			if (pair === "") continue;
			const equals = pair.indexOf("=");
			const key = equals === -1 ? pair : pair.slice(0, equals);
			const value = equals === -1 ? "" : pair.slice(equals + 1);
			try {
				query.set(decodeURIComponent(key), decodeURIComponent(value));
			} catch {
				return { ok: false, pair };
			}
		}
		return { ok: true, query };
	}

	// The GraphQL search the sources fetch: the fixed document, the search
	// query string, and the cursor.
	private answerSearch(fields: Map<string, string>, shape: readonly string[]): Answer {
		const query = fields.get("query");
		const searchQuery = fields.get("searchQuery");
		if (query === undefined || searchQuery === undefined)
			return this.refusal(shape, "no search query field");
		if (query !== SEARCH_QUERY)
			return this.refusal(shape, "a search document the world does not know");
		const nodes = this.searchNodes(searchQuery);
		if (nodes === null) return this.refusal(shape, `a search query the world cannot answer`);
		return {
			code: 0,
			stdout: JSON.stringify({
				data: {
					// The page cost the sources meter (issue #194): it scales with
					// the edges the answer returns, the way GitHub's does, so the
					// meter stands in the stub path with the metered query.
					rateLimit: { cost: nodes.length },
					search: {
						issueCount: nodes.length,
						pageInfo: { hasNextPage: false },
						nodes,
					},
				},
			}),
			stderr: "",
		};
	}

	/**
	 * The search query string the sources send. The qualifiers the plane
	 * issues are the supported set; an unknown one is a surface drift the
	 * world refuses instead of guessing.
	 */
	private searchNodes(searchQuery: string): unknown[] | null {
		const filters = parseSearchFilters(searchQuery);
		if (filters === null) return null;
		const matchLabels = (labels: readonly string[]): boolean => {
			const lower = labels.map((item) => item.toLowerCase());
			return (
				filters.required.every((label) => lower.includes(label.toLowerCase())) &&
				filters.excluded.every((label) => !lower.includes(label.toLowerCase()))
			);
		};
		const nodes: unknown[] = [];
		for (const repository of this.world.repositories) {
			nodes.push(...this.searchNodesOf(repository, filters, matchLabels));
		}
		return nodes;
	}

	/** The nodes the filters hold in one repository. */
	private searchNodesOf(
		repository: StubRepository,
		filters: SearchFilters,
		matchLabels: (labels: readonly string[]) => boolean,
	): unknown[] {
		const nodes: unknown[] = [];
		const full = `${this.world.owner}/${repository.name}`.toLowerCase();
		if (filters.repositoryName !== null && filters.repositoryName.toLowerCase() !== full)
			return nodes;
		if (filters.kind === "issue" || filters.kind === null)
			this.searchIssuesOf(repository, filters, matchLabels, nodes);
		if (filters.kind === "pr" || filters.kind === null)
			this.searchPullsOf(repository, filters, matchLabels, nodes);
		return nodes;
	}

	private searchIssuesOf(
		repository: StubRepository,
		filters: SearchFilters,
		matchLabels: (labels: readonly string[]) => boolean,
		nodes: unknown[],
	): void {
		for (const issue of repository.issues) {
			if (filters.state !== null && issue.state !== filters.state) continue;
			if (!matchLabels(issue.labels)) continue;
			nodes.push(this.issueNode(repository, issue));
		}
	}

	private searchPullsOf(
		repository: StubRepository,
		filters: SearchFilters,
		matchLabels: (labels: readonly string[]) => boolean,
		nodes: unknown[],
	): void {
		for (const pull of repository.pullRequests) {
			if (filters.state !== null && pull.state !== filters.state) continue;
			if (filters.draft !== null && pull.draft !== filters.draft) continue;
			if (!matchLabels(pull.labels)) continue;
			nodes.push(this.pullNode(repository, pull));
		}
	}

	private issueNode(repository: StubRepository, issue: StubIssue): Record<string, unknown> {
		return {
			__typename: "Issue",
			id: `issue-${this.world.host}/${this.world.owner}/${repository.name}/${issue.number}`,
			number: issue.number,
			title: issue.title,
			body: issue.body,
			url: `https://${this.world.host}/${this.world.owner}/${repository.name}/issues/${issue.number}`,
			state: issue.state.toUpperCase(),
			updatedAt: issue.updatedAt,
			labels: { nodes: issue.labels.map((name) => ({ name })) },
			repository: {
				name: repository.name,
				nameWithOwner: `${this.world.owner}/${repository.name}`,
				url: `https://${this.world.host}/${this.world.owner}/${repository.name}`,
			},
		};
	}

	private pullNode(repository: StubRepository, pull: StubPullRequest): Record<string, unknown> {
		return {
			__typename: "PullRequest",
			id: `pull-${this.world.host}/${this.world.owner}/${repository.name}/${pull.number}`,
			number: pull.number,
			title: pull.title,
			body: pull.body,
			url: `https://${this.world.host}/${this.world.owner}/${repository.name}/pull/${pull.number}`,
			state: pull.state.toUpperCase(),
			updatedAt: pull.updatedAt,
			isDraft: pull.draft,
			headRefName: pull.headBranch,
			labels: { nodes: pull.labels.map((name) => ({ name })) },
			repository: {
				name: repository.name,
				nameWithOwner: `${this.world.owner}/${repository.name}`,
				url: `https://${this.world.host}/${this.world.owner}/${repository.name}`,
			},
			closingIssuesReferences: {
				nodes: pull.closingIssueNumbers.map((number) => ({
					id: `issue-${this.world.host}/${this.world.owner}/${repository.name}/${number}`,
					number,
					repository: {
						name: repository.name,
						nameWithOwner: `${this.world.owner}/${repository.name}`,
					},
				})),
			},
		};
	}

	// One REST endpoint under a repository.
	private answerRepo(
		tokens: readonly string[],
		path: string,
		fields: Map<string, string>,
		query: Map<string, string>,
	): Answer {
		const parts = path.split("/");
		const repository = this.repositoryOf(parts[1], parts[2]);
		if (repository === null)
			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found (stub world)\n" };
		const rest = parts.slice(3);
		if (rest[0] === "issues" && rest[1] !== undefined && rest[2] === "comments")
			return this.answerIssueComments(repository, rest);
		if (rest[0] === "pulls" && rest[1] !== undefined && rest[2] === "reviews")
			return this.answerPullReviews(repository, rest);
		if (rest[0] === "pulls" && rest.length === 1)
			return this.answerPullList(repository, query, tokens);
		if (rest[0] === "pulls" && rest[1] !== undefined && rest.length === 2)
			return this.answerPullOne(repository, rest);
		if (rest[0] === "security-advisories")
			return this.answerStateFeed(tokens, fields, {
				read: () => repository.security.advisories,
				name: "advisory",
			});
		if (rest[0] === "dependabot" && rest[1] === "alerts")
			return this.answerStateFeed(tokens, fields, {
				read: () => repository.security.dependabotAlerts,
				name: "dependabot",
			});
		if (rest[0] === "secret-scanning" && rest[1] === "alerts")
			return this.answerStateFeed(tokens, fields, {
				read: () => repository.security.secretScanningAlerts,
				name: "secret scanning",
			});
		return this.refusal(tokens, `an endpoint the world does not know: ${path}`);
	}

	/**
	 * The comments of one issue number: the pull request's verdicts win the
	 * match, because the plane reads a pull request's verdicts on the issues
	 * path with the pull request's number.
	 */
	private answerIssueComments(repository: StubRepository, rest: readonly string[]): Answer {
		const number = Number(rest[1]);
		const pull = repository.pullRequests.find((item) => item.number === number);
		if (pull !== undefined) {
			this.applyAutoScore(pull);
			return {
				code: 0,
				stdout: JSON.stringify(
					pull.comments.map((comment) => ({
						body: comment.body,
						created_at: comment.createdAt,
					})),
				),
				stderr: "",
			};
		}
		const issue = repository.issues.find((item) => item.number === number);
		if (issue === undefined)
			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found (stub world)\n" };
		return {
			code: 0,
			stdout: JSON.stringify(
				issue.comments.map((comment) => ({
					body: comment.body,
					created_at: comment.createdAt,
				})),
			),
			stderr: "",
		};
	}

	/** The reviews of one pull request. */
	private answerPullReviews(repository: StubRepository, rest: readonly string[]): Answer {
		const number = Number(rest[1]);
		const pull = repository.pullRequests.find((item) => item.number === number);
		if (pull === undefined)
			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found (stub world)\n" };
		return {
			code: 0,
			stdout: JSON.stringify(
				pull.reviews.map((review) => ({
					body: review.body,
					submitted_at: review.submittedAt,
				})),
			),
			stderr: "",
		};
	}

	/**
	 * The direct read of the open pull requests of one head branch (ADR 0076):
	 * the plane reaches the draft the projection hides through this list, by
	 * the branch the head parameter names.
	 */
	private answerPullList(
		repository: StubRepository,
		query: Map<string, string>,
		tokens: readonly string[],
	): Answer {
		const state = query.get("state") ?? "open";
		const head = query.get("head");
		let headOwner: string | null = null;
		let headBranch: string | null = null;
		if (head !== undefined) {
			const colon = head.indexOf(":");
			if (colon <= 0) return this.refusal(tokens, `an unreadable head parameter: ${head}`);
			headOwner = head.slice(0, colon);
			headBranch = head.slice(colon + 1);
		}
		const matches = repository.pullRequests.filter((pull) => {
			if (pull.state !== state) return false;
			if (headOwner !== null && headOwner.toLowerCase() !== this.world.owner.toLowerCase())
				return false;
			if (headBranch !== null && pull.headBranch !== headBranch) return false;
			return true;
		});
		return {
			code: 0,
			stdout: JSON.stringify(matches.map((pull) => this.pullRest(repository, pull))),
			stderr: "",
		};
	}

	/** The open fact of one pull request number. */
	private answerPullOne(repository: StubRepository, rest: readonly string[]): Answer {
		const number = Number(rest[1]);
		const pull = repository.pullRequests.find((item) => item.number === number);
		if (pull === undefined)
			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found (stub world)\n" };
		return {
			code: 0,
			stdout: JSON.stringify({
				number: pull.number,
				state: pull.state,
				merged: pull.merged,
				html_url: `https://${this.world.host}/${this.world.owner}/${repository.name}/pull/${pull.number}`,
			}),
			stderr: "",
		};
	}

	/** The security feed of one state, by the feed the route names. */
	private answerStateFeed(
		tokens: readonly string[],
		fields: Map<string, string>,
		feed: { read: () => Array<Record<string, unknown>>; name: string },
	): Answer {
		const state = fields.get("state");
		if (state === undefined)
			return this.refusal(tokens, `the ${feed.name} feed was read without a state`);
		return {
			code: 0,
			stdout: JSON.stringify(feed.read().filter((item) => item.state === state)),
			stderr: "",
		};
	}

	// The pull request record the direct read answers (ADR 0076): the shape
	// of the REST list entry, the draft fact and the head and base branches
	// the open and the commit count read.
	private pullRest(repository: StubRepository, pull: StubPullRequest): Record<string, unknown> {
		return {
			number: pull.number,
			state: pull.state,
			draft: pull.draft,
			html_url: `https://${this.world.host}/${this.world.owner}/${repository.name}/pull/${pull.number}`,
			head: { ref: pull.headBranch },
			base: { ref: pull.base ?? "main" },
			labels: pull.labels.map((name) => ({ name })),
		};
	}

	// The auto score rule: the first comment read on a pull request that
	// carries no verdict posts the configured score. The post is the world's,
	// and it is the durable record the score Judgment reads.
	private applyAutoScore(pull: StubPullRequest): void {
		if (pull.scorePosted) return;
		pull.scorePosted = true;
		const enabled = pull.autoScore ?? this.world.autoScore.enabled;
		if (!enabled || hasVerdict(pull)) return;
		pull.comments.push({ body: autoScoreBody(this.world.autoScore.score), createdAt: now() });
		this.save();
	}

	// The item commands: the label edits the transitions and the Placement
	// write, the merge and the blocked comment the plane action runs.
	private answerItem(args: readonly string[]): Answer {
		const [kind, verb, ...rest] = args;
		if ((kind === "issue" || kind === "pr") && verb === "edit") return this.answerEdit(kind, rest);
		if (kind === "pr" && verb === "create") return this.answerPullCreate(rest);
		if (kind === "pr" && verb === "ready") return this.answerPullReady(rest);
		if (kind === "pr" && verb === "close") return this.answerPullClose(rest);
		if (kind === "pr" && verb === "merge") return this.answerMerge(rest);
		if (kind === "pr" && verb === "comment") return this.answerComment(rest);
		return this.refusal(args, `an unknown item command: ${kind} ${verb}`);
	}

	// The open of the ticket's pull request (ADR 0076): the draft the plane
	// puts on the branch before the agent works. The world numbers it after
	// its own items and takes the closing references the body carries.
	private answerPullCreate(rest: string[]): Answer {
		const parsed = this.parsePullCreateFlags(rest);
		if (!parsed.ok) return this.refusal(rest, parsed.reason);
		const { repositoryIdentity, head, draft, title, body } = parsed.facts;
		const repository = this.repositoryOfIdentity(repositoryIdentity);
		if (repository === null)
			return { code: 1, stdout: "", stderr: "GraphQL: Could not resolve the repository.\n" };
		const numbers = [
			...repository.issues.map((item) => item.number),
			...repository.pullRequests.map((item) => item.number),
		];
		const number = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
		const closing = [...body.matchAll(/(?:Closes|Fixes|Resolves)\s+#(\d+)/gi)].map((item) =>
			Number(item[1]),
		);
		repository.pullRequests.push({
			number,
			title,
			body,
			labels: [],
			state: "open",
			updatedAt: now(),
			merged: false,
			draft,
			headBranch: head,
			base: "main",
			closingIssueNumbers: closing,
			comments: [],
			reviews: [],
		});
		this.save();
		return { code: 0, stdout: `${this.itemUrl(repository, "pr", number)}\n`, stderr: "" };
	}

	/**
	 * The flags of the pull request open: the repo, the head, the draft, the
	 * title, and the body, and the refusal the walk earns.
	 */
	private parsePullCreateFlags(rest: readonly string[]):
		| {
				ok: true;
				facts: {
					repositoryIdentity: string;
					head: string;
					draft: boolean;
					title: string;
					body: string;
				};
		  }
		| { ok: false; reason: string } {
		const facts: PullCreateFacts = {
			repositoryIdentity: null,
			head: null,
			draft: false,
			title: "",
			body: "",
		};
		for (let i = 0; i < rest.length; i += 1) {
			const step = pullCreateTokenStep(rest, i, facts);
			if (step.reason !== undefined) return { ok: false, reason: step.reason };
			i += step.advance;
		}
		const { repositoryIdentity, head, title, body, draft } = facts;
		if (repositoryIdentity === null || head === null || title === "")
			return { ok: false, reason: "no repository, no head, or no title" };
		return { ok: true, facts: { repositoryIdentity, head, draft, title, body } };
	}

	/**
	 * The flag walk the pull answers share: the item number, the repository,
	 * and the refusal the walk earns. `allowed` names the extra flags the
	 * answer accepts beside the repo flag.
	 */
	private parsePullFlags(
		rest: string[],
		verb: string,
		allowed: readonly string[] = [],
	): { number: number; repositoryIdentity: string } | Answer {
		const number = externalKeyNumber(rest[0]);
		let repositoryIdentity: string | null = null;
		for (let i = 1; i < rest.length; i += 1) {
			const token = rest[i];
			if (token === "--repo") {
				if (i + 1 >= rest.length) return this.refusal(rest, "the repo flag has no value");
				repositoryIdentity = rest[i + 1];
				i += 1;
			} else if (allowed.includes(token)) {
				// The method the plane names. The stub's merge settles the same
				// way for every method, so the flag is validated and not stored.
			} else {
				return this.refusal(rest, `an unknown ${verb} flag: ${token}`);
			}
		}
		if (number === null || repositoryIdentity === null)
			return this.refusal(rest, "no item or no repository");
		return { number, repositoryIdentity };
	}

	/**
	 * The pull the flags name, and the repository it stands in: the refusals
	 * for no repository and no pull are the GraphQL words the real gh
	 * answers with.
	 */
	private pullOf(
		repositoryIdentity: string,
		number: number,
	): { repository: StubRepository; pull: StubPullRequest } | Answer {
		const repository = this.repositoryOfIdentity(repositoryIdentity);
		if (repository === null)
			return { code: 1, stdout: "", stderr: "GraphQL: Could not resolve the repository.\n" };
		const pull = repository.pullRequests.find((entry) => entry.number === number);
		if (pull === undefined)
			return {
				code: 1,
				stdout: "",
				stderr: `GraphQL: Could not resolve to a PullRequest with the number of ${number}.\n`,
			};
		return { repository, pull };
	}

	/**
	 * The gate the ready, close, and merge answers run before they act: a
	 * pull that is already merged or closed refuses, the way the real gh
	 * does. `closedWord` is the answer's own word for the closed pull: the
	 * close answer says `already closed`, the ready and merge say `closed`.
	 */
	private pullGate(
		repositoryIdentity: string,
		number: number,
		closedWord: string,
	): { repository: StubRepository; pull: StubPullRequest } | Answer {
		const found = this.pullOf(repositoryIdentity, number);
		if ("code" in found) return found;
		if (found.pull.merged)
			return { code: 1, stdout: "", stderr: "GraphQL: Pull request is already merged.\n" };
		if (found.pull.state === "closed")
			return { code: 1, stdout: "", stderr: `GraphQL: Pull request is ${closedWord}.\n` };
		return found;
	}

	// The publish (ADR 0076): the draft the plane opened is marked ready for
	// review. A pull request that is not a draft stands as it stands, and the
	// act is never a conversion back to a draft.
	private answerPullReady(rest: string[]): Answer {
		const parsed = this.parsePullFlags(rest, "ready");
		if ("code" in parsed) return parsed;
		const gate = this.pullGate(parsed.repositoryIdentity, parsed.number, "closed");
		if ("code" in gate) return gate;
		gate.pull.draft = false;
		gate.pull.updatedAt = now();
		this.save();
		return { code: 0, stdout: this.itemUrl(gate.repository, "pr", gate.pull.number), stderr: "" };
	}

	// The close the cycle end runs (ADR 0076): the draft leaves the open state,
	// and the labels it carried stay with it. A failed Handoff start runs no
	// close - the draft it opened stands for the next start to reuse (issue #296).
	private answerPullClose(rest: string[]): Answer {
		const parsed = this.parsePullFlags(rest, "close");
		if ("code" in parsed) return parsed;
		const gate = this.pullGate(parsed.repositoryIdentity, parsed.number, "already closed");
		if ("code" in gate) return gate;
		gate.pull.state = "closed";
		gate.pull.updatedAt = now();
		this.save();
		return { code: 0, stdout: this.itemUrl(gate.repository, "pr", gate.pull.number), stderr: "" };
	}

	private answerEdit(kind: "issue" | "pr", rest: string[]): Answer {
		const parsed = this.parseEditFlags(rest);
		if (!parsed.ok) return this.refusal(rest, parsed.reason);
		const { number, repositoryIdentity, added, removed } = parsed.facts;
		if (number === null || repositoryIdentity === null)
			return this.refusal(rest, "no item or no repository");
		const found = this.editItemOf(kind, repositoryIdentity, number);
		if (found === null) return this.editItemRefusal(kind, number);
		// A label the repository's set does not hold is refused before any change
		// (ADR 0075, the init act's label seam): the machine labels the transitions
		// write stand in the set the init created, so a label the operator has not
		// made stands nowhere. Where the set is unset the world takes any label, the
		// way it did before the seam.
		const labelGate = this.editLabelGate(found.repository, added);
		if (labelGate !== null) return labelGate;
		this.applyEditLabels(found.item, added, removed);
		found.item.updatedAt = now();
		this.save();
		return { code: 0, stdout: this.itemUrl(found.repository, kind, number), stderr: "" };
	}

	/** The item the edit acts on, in its repository, or none. */
	private editItemOf(
		kind: "issue" | "pr",
		repositoryIdentity: string,
		number: number,
	): { repository: StubRepository; item: StubIssue | StubPullRequest } | null {
		const repository = this.repositoryOfIdentity(repositoryIdentity);
		if (repository === null) return null;
		const item =
			kind === "issue"
				? repository.issues.find((entry) => entry.number === number)
				: repository.pullRequests.find((entry) => entry.number === number);
		if (item === undefined) return null;
		return { repository, item };
	}

	/** The refusal the edit earns when the repository or the item is missing. */
	private editItemRefusal(kind: "issue" | "pr", number: number): Answer {
		return {
			code: 1,
			stdout: "",
			stderr: `GraphQL: Could not resolve to ${kind === "pr" ? "a PullRequest" : "an Issue"} with the number of ${number}.\n`,
		};
	}

	/** The refusal one added label earns when the repository's set does not hold it. */
	private editLabelGate(repository: StubRepository, added: string[]): Answer | null {
		const labelSet = repository.labels;
		if (labelSet === undefined) return null;
		for (const label of added) {
			if (!labelSet.some((entry) => entry.toLowerCase() === label.toLowerCase()))
				return {
					code: 1,
					stdout: "",
					stderr: `the repository does not hold the label: ${label}\n`,
				};
		}
		return null;
	}

	/** The labels the edit writes on the item: the additions, then the removals. */
	private applyEditLabels(
		item: StubIssue | StubPullRequest,
		added: string[],
		removed: string[],
	): void {
		for (const label of added)
			if (!item.labels.some((entry) => entry.toLowerCase() === label.toLowerCase()))
				item.labels.push(label);
		item.labels = item.labels.filter(
			(label) => !removed.some((entry) => entry.toLowerCase() === label.toLowerCase()),
		);
	}

	/**
	 * The flags of the item edit: the item number, the repository, the labels
	 * added and removed, and the refusal the walk earns.
	 */
	private parseEditFlags(rest: readonly string[]):
		| {
				ok: true;
				facts: {
					number: number | null;
					repositoryIdentity: string | null;
					added: string[];
					removed: string[];
				};
		  }
		| { ok: false; reason: string } {
		const number = externalKeyNumber(rest[0]);
		const facts: EditFlagFacts = { repositoryIdentity: null, added: [], removed: [] };
		for (let i = 1; i < rest.length; i += 1) {
			const step = editFlagStep(rest, i, facts);
			if (step.reason !== undefined) return { ok: false, reason: step.reason };
			i += step.advance;
		}
		return {
			ok: true,
			facts: {
				number,
				repositoryIdentity: facts.repositoryIdentity,
				added: facts.added,
				removed: facts.removed,
			},
		};
	}

	private answerMerge(rest: string[]): Answer {
		const parsed = this.parsePullFlags(rest, "merge", ["--squash", "--merge", "--rebase"]);
		if ("code" in parsed) return parsed;
		const gate = this.pullGate(parsed.repositoryIdentity, parsed.number, "closed");
		if ("code" in gate) return gate;
		const mergeGate = gate.repository.mergeGates[String(parsed.number)];
		if (mergeGate !== undefined && !mergeGate.passing)
			return {
				code: 1,
				stdout: "",
				stderr: `GraphQL: Pull request is not mergeable: ${mergeGate.reason || "the merge gate is failing"}\n`,
			};
		gate.pull.merged = true;
		gate.pull.state = "closed";
		gate.pull.updatedAt = now();
		// The GitHub semantics: a merged pull request closes the issues it
		// closes, so both tickets leave the list on a clean merge.
		for (const issue of gate.repository.issues) {
			if (gate.pull.closingIssueNumbers.includes(issue.number)) {
				issue.state = "closed";
				issue.updatedAt = now();
			}
		}
		this.save();
		return {
			code: 0,
			stdout: `Successfully merged pull request #${parsed.number} in ${this.world.owner}/${gate.repository.name}.\n`,
			stderr: "",
		};
	}

	private answerComment(rest: string[]): Answer {
		const number = externalKeyNumber(rest[0]);
		let repositoryIdentity: string | null = null;
		let body: string | null = null;
		for (let i = 1; i < rest.length; i += 1) {
			const token = rest[i];
			if (token === "--repo") {
				if (i + 1 >= rest.length) return this.refusal(rest, "the repo flag has no value");
				repositoryIdentity = rest[i + 1];
				i += 1;
			} else if (token === "--body") {
				if (i + 1 >= rest.length) return this.refusal(rest, "the body flag has no value");
				body = rest[i + 1];
				i += 1;
			} else {
				return this.refusal(rest, `an unknown comment flag: ${token}`);
			}
		}
		if (number === null || repositoryIdentity === null || body === null)
			return this.refusal(rest, "no item, no repository, or no body");
		const found = this.pullOf(repositoryIdentity, number);
		if ("code" in found) return found;
		found.pull.comments.push({ body, createdAt: now() });
		found.pull.updatedAt = now();
		this.save();
		return {
			code: 0,
			stdout: this.itemUrl(found.repository, "pr", found.pull.number),
			stderr: "",
		};
	}

	private itemUrl(repository: StubRepository, kind: "issue" | "pr", number: number): string {
		const tail = kind === "issue" ? "issues" : "pull";
		return `https://${this.world.host}/${this.world.owner}/${repository.name}/${tail}/${number}`;
	}

	/** The repository the `owner/name` names, or null when it does not. */
	private repositoryOf(owner: string | undefined, name: string | undefined): StubRepository | null {
		if (owner === undefined || name === undefined) return null;
		if (owner.toLowerCase() !== this.world.owner.toLowerCase()) return null;
		return (
			this.world.repositories.find(
				(repository) => repository.name.toLowerCase() === name.toLowerCase(),
			) ?? null
		);
	}

	/**
	 * The repository a `gh --repo` identity names. The identity carries the
	 * host (`<host>/<owner>/<name>`), the form `gh --repo` takes.
	 */
	private repositoryOfIdentity(identity: string): StubRepository | null {
		const parts = identity.split("/");
		if (parts.length !== 3) return null;
		return this.repositoryOf(parts[1], parts[2]);
	}

	/** Record the refusal and answer it. `shape` is the command that met the refusal. */
	private refusal(shape: readonly string[], reason: string): Answer {
		const line = `gh ${shape.join(" ")}`;
		this.refusals.push(line);
		return {
			code: 1,
			stdout: "",
			stderr: `the stub world cannot answer this GitHub command: ${line} - ${reason}\n`,
		};
	}
}

/** The number an external key carries, `#12` as `12`. */
/** The `--repo` flag the commands share, read from `from` on in the args. */
function repoFlagFrom(
	args: readonly string[],
	from: number,
): { identity: string | null; missing: boolean } {
	let identity: string | null = null;
	for (let i = from; i < args.length; i += 1) {
		if (args[i] !== "--repo") continue;
		if (i + 1 >= args.length) return { identity: null, missing: true };
		identity = args[i + 1];
		i += 1;
	}
	return { identity, missing: false };
}

/** The endpoint path of one `gh api` endpoint, its query dropped. */
function apiEndpointPath(endpoint: string): string {
	const queryIndex = endpoint.indexOf("?");
	return queryIndex === -1 ? endpoint : endpoint.slice(0, queryIndex);
}

/** The tokens one flag consumes after itself: `--paginate` none, `--method` one. */
function apiFlagSkip(token: string): number | null {
	if (token === "--paginate") return 0;
	if (token === "--method") return 1;
	return null;
}

/**
 * The one token of a `gh api` call, read into the facts the walk holds, or
 * the refusal the token earns.
 */
function apiTokenStep(
	token: string,
	tokens: string[],
	i: number,
	endpoint: string | null,
): {
	advance: number;
	endpoint?: string;
	hostname?: string;
	field?: [string, string];
	reason?: string;
} {
	if (token === "--hostname") {
		if (i + 1 >= tokens.length) return { advance: 0, reason: "the hostname flag has no value" };
		return { advance: 1, hostname: tokens[i + 1] };
	}
	const skip = apiFlagSkip(token);
	if (skip !== null) {
		if (token === "--method" && i + 1 >= tokens.length)
			return { advance: 0, reason: "the method flag has no value" };
		return { advance: skip };
	}
	if (token === "-f") {
		if (i + 1 >= tokens.length) return { advance: 0, reason: "the field flag has no value" };
		const value = tokens[i + 1];
		const cut = value.indexOf("=");
		if (cut <= 0) return { advance: 0, reason: `an unreadable field: ${value}` };
		return { advance: 1, field: [value.slice(0, cut), value.slice(cut + 1)] };
	}
	if (token.startsWith("-")) return { advance: 0, reason: `an unknown api flag: ${token}` };
	if (endpoint !== null) return { advance: 0, reason: "two endpoints on one call" };
	return { advance: 0, endpoint: token };
}

/** The filters one search query string names. */
interface SearchFilters {
	kind: "issue" | "pr" | null;
	repositoryName: string | null;
	state: "open" | "closed" | null;
	draft: boolean | null;
	required: string[];
	excluded: string[];
}

/** The item kind one search token names, or none. */
function kindFilterOf(token: string): "issue" | "pr" | null {
	if (token === "is:issue") return "issue";
	if (token === "is:pr") return "pr";
	return null;
}

/**
 * The one token of a search query string, written into the filters, or false
 * when the token is a qualifier the world does not support.
 */
function searchFilterToken(token: string, filters: SearchFilters): boolean {
	if (token === "") return true;
	const kind = kindFilterOf(token);
	if (kind !== null) {
		if (filters.kind !== null) return false;
		filters.kind = kind;
		return true;
	}
	if (token === "is:open") {
		filters.state = "open";
		return true;
	}
	if (token === "is:closed") {
		filters.state = "closed";
		return true;
	}
	if (token === "is:draft") {
		filters.draft = true;
		return true;
	}
	if (token === "no:draft") {
		filters.draft = false;
		return true;
	}
	if (token.startsWith("repo:")) {
		filters.repositoryName = token.slice("repo:".length);
		return true;
	}
	if (token.startsWith("-label:")) {
		filters.excluded.push(token.slice("-label:".length));
		return true;
	}
	if (token.startsWith("label:")) {
		filters.required.push(token.slice("label:".length));
		return true;
	}
	return false;
}

/** The filters the search query string names, or null where one token is unknown. */
function parseSearchFilters(searchQuery: string): SearchFilters | null {
	const filters: SearchFilters = {
		kind: null,
		repositoryName: null,
		state: null,
		draft: null,
		required: [],
		excluded: [],
	};
	for (const token of searchQuery.split(/\s+/)) {
		if (!searchFilterToken(token, filters)) return null;
	}
	return filters;
}

/** The facts one pull request create call carries. */
interface PullCreateFacts {
	repositoryIdentity: string | null;
	head: string | null;
	draft: boolean;
	title: string;
	body: string;
}

const PULL_CREATE_FLAGS: Record<string, "repo" | "head" | "title" | "body" | undefined> = {
	"--repo": "repo",
	"--head": "head",
	"--title": "title",
	"--body": "body",
};

/**
 * The one token of a pull request create call, written into the facts, or
 * the refusal the token earns.
 */
function pullCreateTokenStep(
	rest: readonly string[],
	i: number,
	facts: PullCreateFacts,
): { advance: number; reason?: string } {
	const token = rest[i];
	if (token === "--draft") {
		facts.draft = true;
		return { advance: 0 };
	}
	const flag = PULL_CREATE_FLAGS[token];
	if (flag === undefined) return { advance: 0, reason: `an unknown create flag: ${token}` };
	if (i + 1 >= rest.length) return { advance: 0, reason: `the ${flag} flag has no value` };
	assignPullCreateFact(facts, flag, rest[i + 1]);
	return { advance: 1 };
}

/** The fact one create flag names, written with its value. */
function assignPullCreateFact(facts: PullCreateFacts, flag: string, value: string): void {
	if (flag === "repo") facts.repositoryIdentity = value;
	else if (flag === "head") facts.head = value;
	else if (flag === "title") facts.title = value;
	else facts.body = value;
}

/** The facts one item edit call carries. */
interface EditFlagFacts {
	repositoryIdentity: string | null;
	added: string[];
	removed: string[];
}

/** The label list one edit flag writes, or none when the flag is not a label flag. */
function editLabelListOf(token: string, facts: EditFlagFacts): string[] | undefined {
	if (token === "--add-label") return facts.added;
	if (token === "--remove-label") return facts.removed;
	return undefined;
}

/**
 * The one token of an item edit call, written into the facts, or the refusal
 * the token earns.
 */
function editFlagStep(
	rest: readonly string[],
	i: number,
	facts: EditFlagFacts,
): { advance: number; reason?: string } {
	const token = rest[i];
	if (token === "--repo") {
		if (i + 1 >= rest.length) return { advance: 0, reason: "the repo flag has no value" };
		facts.repositoryIdentity = rest[i + 1];
		return { advance: 1 };
	}
	const list = editLabelListOf(token, facts);
	if (list === undefined) return { advance: 0, reason: `an unknown edit flag: ${token}` };
	if (i + 1 >= rest.length) return { advance: 0, reason: "the label flag has no value" };
	list.push(...rest[i + 1].split(",").filter((item) => item !== ""));
	return { advance: 1 };
}

function externalKeyNumber(key: string | undefined): number | null {
	if (key === undefined) return null;
	const trimmed = key.trim();
	const cut = trimmed.startsWith("#") ? 1 : 0;
	const value = trimmed.slice(cut);
	if (value === "" || !/^\d+$/.test(value)) return null;
	return Number(value);
}

/** Read, parse, and validate the world file. A missing or malformed file is an error. */
function readWorld(path: string): StubWorld {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new StubWorldError(`the stub world at ${path} cannot be read: ${String(error)}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new StubWorldError(`the stub world at ${path} is not valid JSON`);
	}
	return validateWorld(raw);
}

/** Whether a value is a plain object the file's fields may stand in. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a value is a list of strings. */
function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The comments of one item, checked. A bad entry fails the load. */
function validateComments(raw: unknown, label: string): StubComment[] {
	if (!Array.isArray(raw)) throw new StubWorldError(`${label} has a bad comment list`);
	return raw.map((entry, index) => {
		const item = entry as Record<string, unknown>;
		if (!isRecord(item) || typeof item.body !== "string" || typeof item.createdAt !== "string")
			throw new StubWorldError(`${label} has a bad comment at index ${index}`);
		return { body: item.body as string, createdAt: item.createdAt as string };
	});
}

/** The reviews of one pull request, checked. A bad entry fails the load. */
function validateReviews(raw: unknown, label: string): StubReview[] {
	if (!Array.isArray(raw)) throw new StubWorldError(`${label} has a bad review list`);
	return raw.map((entry, index) => {
		const item = entry as Record<string, unknown>;
		if (!isRecord(item) || typeof item.body !== "string" || typeof item.submittedAt !== "string")
			throw new StubWorldError(`${label} has a bad review at index ${index}`);
		return { body: item.body as string, submittedAt: item.submittedAt as string };
	});
}

/** One issue's fields, checked. A hand-edited file with a bad item fails here, at load. */
function validateIssue(raw: unknown, label: string): StubIssue {
	const item = raw as Record<string, unknown>;
	if (!isRecord(item)) throw new StubWorldError(`${label} is not an object`);
	if (typeof item.number !== "number" || !Number.isInteger(item.number))
		throw new StubWorldError(`${label} has a bad number`);
	if (typeof item.title !== "string") throw new StubWorldError(`${label} has no title`);
	if (typeof item.body !== "string") throw new StubWorldError(`${label} has no body`);
	if (!isStringList(item.labels)) throw new StubWorldError(`${label} has a bad label list`);
	if (item.state !== "open" && item.state !== "closed")
		throw new StubWorldError(`${label} has a bad state`);
	if (typeof item.updatedAt !== "string") throw new StubWorldError(`${label} has no updatedAt`);
	return {
		number: item.number,
		title: item.title,
		body: item.body,
		labels: item.labels,
		state: item.state as StubIssue["state"],
		updatedAt: item.updatedAt,
		comments: validateComments(item.comments ?? [], label),
	};
}

/** One pull request's fields, checked. The issue's fields plus its own. */
function validatePullRequest(raw: unknown, label: string): StubPullRequest {
	const item = raw as Record<string, unknown>;
	if (!isRecord(item)) throw new StubWorldError(`${label} is not an object`);
	const issue = validateIssue(item, label);
	if (typeof item.merged !== "boolean") throw new StubWorldError(`${label} has a bad merged fact`);
	if (typeof item.draft !== "boolean") throw new StubWorldError(`${label} has a bad draft fact`);
	if (typeof item.headBranch !== "string") throw new StubWorldError(`${label} has no head branch`);
	if (
		!Array.isArray(item.closingIssueNumbers) ||
		!item.closingIssueNumbers.every((number) => typeof number === "number")
	)
		throw new StubWorldError(`${label} has a bad closing issue list`);
	if (item.autoScore !== undefined && typeof item.autoScore !== "boolean")
		throw new StubWorldError(`${label} has a bad auto score override`);
	if (item.scorePosted !== undefined && typeof item.scorePosted !== "boolean")
		throw new StubWorldError(`${label} has a bad score posted fact`);
	return {
		...issue,
		merged: item.merged,
		draft: item.draft,
		headBranch: item.headBranch,
		closingIssueNumbers: item.closingIssueNumbers as number[],
		reviews: validateReviews(item.reviews ?? [], label),
		...(item.autoScore !== undefined ? { autoScore: item.autoScore } : {}),
		...(item.scorePosted !== undefined ? { scorePosted: item.scorePosted } : {}),
	};
}

// The world file's document, checked. A malformed file is an error the
// startup report takes, not a silent empty world. A hand-edited file with a
// bad item fails here, at load, not later in an answer.
function validateWorld(raw: unknown): StubWorld {
	const record = raw as Record<string, unknown>;
	if (record === null || typeof record !== "object" || Array.isArray(record))
		throw new StubWorldError("the world file is not an object");
	const top = validateWorldTop(record);
	const repositories = (record.repositories as unknown[]).map((entry) =>
		validateWorldRepository(entry as Record<string, unknown>),
	);
	return {
		version: 1,
		host: top.host,
		owner: top.owner,
		autoScore: top.autoScore,
		repositories,
	};
}

/** The world file's top: the version, the host, the owner, the auto score. */
function validateWorldTop(record: Record<string, unknown>): {
	host: string;
	owner: string;
	autoScore: { enabled: boolean; score: number };
} {
	if (record.version !== 1) throw new StubWorldError("the world file is not version 1");
	if (typeof record.host !== "string" || record.host === "")
		throw new StubWorldError("the world file has no host");
	if (typeof record.owner !== "string" || record.owner === "")
		throw new StubWorldError("the world file has no owner");
	const autoScore = record.autoScore;
	if (
		!isRecord(autoScore) ||
		typeof autoScore.enabled !== "boolean" ||
		typeof autoScore.score !== "number"
	)
		throw new StubWorldError("the world file has no auto score setting");
	if (!Array.isArray(record.repositories))
		throw new StubWorldError("the world file has no repositories");
	return {
		host: record.host,
		owner: record.owner,
		autoScore: { enabled: autoScore.enabled, score: autoScore.score },
	};
}

/** One repository of the world file: the items, the gates, the security. */
function validateWorldRepository(item: Record<string, unknown>): StubRepository {
	if (typeof item.name !== "string" || item.name === "")
		throw new StubWorldError("a repository in the world file has no name");
	if (!Array.isArray(item.issues) || !Array.isArray(item.pullRequests))
		throw new StubWorldError(`repository ${item.name} has no items`);
	const label = `repository ${item.name}`;
	// The repository's label set, absent where the file does not name it.
	let labels: string[] | undefined;
	if (item.labels !== undefined) {
		if (!Array.isArray(item.labels) || !item.labels.every((entry) => typeof entry === "string"))
			throw new StubWorldError(`${label} has a bad label set`);
		labels = [...item.labels];
	}
	const mergeGates: Record<string, StubMergeGate> = {};
	const gates = item.mergeGates ?? {};
	if (!isRecord(gates)) throw new StubWorldError(`${label} has a bad merge gate table`);
	for (const [key, value] of Object.entries(gates)) {
		const gate = value as Record<string, unknown>;
		if (!isRecord(gate) || typeof gate.passing !== "boolean" || typeof gate.reason !== "string")
			throw new StubWorldError(`${label} has a bad merge gate for pull request ${key}`);
		mergeGates[key] = { passing: gate.passing, reason: gate.reason };
	}
	return {
		name: item.name,
		...(labels === undefined ? {} : { labels }),
		issues: item.issues.map((entry, index) =>
			validateIssue(entry, `${label} issue at index ${index}`),
		),
		pullRequests: item.pullRequests.map((entry, index) =>
			validatePullRequest(entry, `${label} pull request at index ${index}`),
		),
		mergeGates,
		security: worldSecurityOf(item, label),
	};
}

/** The security feed of one repository of the world file. */
function worldSecurityOf(entry: Record<string, unknown>, label: string): StubSecurity {
	const security = isRecord(entry.security) ? entry.security : {};
	const listOf = (name: string): Array<Record<string, unknown>> => {
		const value = security[name] ?? [];
		if (!Array.isArray(value) || !value.every(isRecord))
			throw new StubWorldError(`${label} has a bad ${name} list`);
		return value as Array<Record<string, unknown>>;
	};
	return {
		advisories: listOf("advisories"),
		dependabotAlerts: listOf("dependabotAlerts"),
		secretScanningAlerts: listOf("secretScanningAlerts"),
	};
}
