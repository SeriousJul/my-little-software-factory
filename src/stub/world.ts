/**
 * The Stub world (issue #178, ADR 0073).
 *
 * The Stub world is a JSON file and the source of truth of the stub side:
 * repositories, issues, pull requests, the merge gate fact of each pull
 * request, and the security feeds. Every mutation a plane write or a world
 * CLI verb makes goes through this store and writes the file atomically, so
 * a restart finds the world where the operator left it.
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
}

/** One pull request in the world. */
export interface StubPullRequest extends StubIssue {
	merged: boolean;
	draft: boolean;
	headBranch: string;
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
	readonly world: StubWorld;
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
		return new StubWorldStore(path, validateWorld(raw));
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
	 */
	answerGh(args: readonly string[]): Answer {
		if (args[0] === "auth") return this.answerAuth(args);
		if (args[0] === "api") return this.answerApi(args.slice(1));
		if (args[0] === "issue" || args[0] === "pr") return this.answerItem(args);
		return this.refusal(args, "an unknown GitHub command");
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
	private answerApi(tokens: readonly string[]): Answer {
		let endpoint: string | null = null;
		let hostname: string | null = null;
		const fields = new Map<string, string>();
		for (let i = 0; i < tokens.length; i += 1) {
			const token = tokens[i];
			if (token === "--hostname") {
				if (i + 1 >= tokens.length) return this.refusal(tokens, "the hostname flag has no value");
				i += 1;
				hostname = tokens[i];
			} else if (token === "--paginate" || token === "--method") {
				if (token === "--method" && i + 1 >= tokens.length)
					return this.refusal(tokens, "the method flag has no value");
				if (token === "--method") i += 1;
			} else if (token === "-f") {
				if (i + 1 >= tokens.length) return this.refusal(tokens, "the field flag has no value");
				const value = tokens[i + 1];
				const cut = value.indexOf("=");
				if (cut <= 0) return this.refusal(tokens, `an unreadable field: ${value}`);
				fields.set(value.slice(0, cut), value.slice(cut + 1));
				i += 1;
			} else if (token.startsWith("-")) {
				return this.refusal(tokens, `an unknown api flag: ${token}`);
			} else {
				if (endpoint !== null) return this.refusal(tokens, "two endpoints on one call");
				endpoint = token;
			}
		}
		if (endpoint === null) return this.refusal(tokens, "no endpoint");
		if (hostname !== this.world.host)
			return this.refusal(tokens, `a host the world does not serve: ${hostname ?? ""}`);
		const path = endpoint.split("?")[0];
		if (path === "graphql") return this.answerSearch(fields);
		if (path.startsWith("repos/")) return this.answerRepo(tokens, path, fields);
		return this.refusal(tokens, `an endpoint the world does not know: ${path}`);
	}

	// The GraphQL search the sources fetch: the fixed document, the search
	// query string, and the cursor.
	private answerSearch(fields: Map<string, string>): Answer {
		const query = fields.get("query");
		const searchQuery = fields.get("searchQuery");
		const graphql: readonly string[] = ["api", "graphql"];
		if (query === undefined || searchQuery === undefined)
			return this.refusal(graphql, "no search query field");
		if (query !== SEARCH_QUERY)
			return this.refusal(graphql, "a search document the world does not know");
		const nodes = this.searchNodes(searchQuery);
		if (nodes === null) return this.refusal(graphql, `a search query the world cannot answer`);
		return {
			code: 0,
			stdout: JSON.stringify({
				data: {
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
		let kind: "issue" | "pr" | null = null;
		let repositoryName: string | null = null;
		let state: "open" | "closed" | null = null;
		let draft: boolean | null = null;
		const required: string[] = [];
		const excluded: string[] = [];
		for (const token of searchQuery.split(/\s+/)) {
			if (token === "") continue;
			if (token === "is:issue") {
				if (kind !== null) return null;
				kind = "issue";
			} else if (token === "is:pr") {
				if (kind !== null) return null;
				kind = "pr";
			} else if (token === "is:open") state = "open";
			else if (token === "is:closed") state = "closed";
			else if (token === "is:draft") draft = true;
			else if (token === "no:draft") draft = false;
			else if (token.startsWith("repo:")) repositoryName = token.slice("repo:".length);
			else if (token.startsWith("-label:")) excluded.push(token.slice("-label:".length));
			else if (token.startsWith("label:")) required.push(token.slice("label:".length));
			else return null;
		}
		const matchLabels = (labels: readonly string[]): boolean => {
			const lower = labels.map((item) => item.toLowerCase());
			return (
				required.every((label) => lower.includes(label.toLowerCase())) &&
				excluded.every((label) => !lower.includes(label.toLowerCase()))
			);
		};
		const nodes: unknown[] = [];
		for (const repository of this.world.repositories) {
			const full = `${this.world.owner}/${repository.name}`.toLowerCase();
			if (repositoryName !== null && repositoryName.toLowerCase() !== full) continue;
			if (kind === "issue" || kind === null) {
				for (const issue of repository.issues) {
					if (state !== null && issue.state !== state) continue;
					if (!matchLabels(issue.labels)) continue;
					nodes.push(this.issueNode(repository, issue));
				}
			}
			if (kind === "pr" || kind === null) {
				for (const pull of repository.pullRequests) {
					if (state !== null && pull.state !== state) continue;
					if (draft !== null && pull.draft !== draft) continue;
					if (!matchLabels(pull.labels)) continue;
					nodes.push(this.pullNode(repository, pull));
				}
			}
		}
		return nodes;
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
	private answerRepo(tokens: readonly string[], path: string, fields: Map<string, string>): Answer {
		const parts = path.split("/");
		const repository = this.repositoryOf(parts[1], parts[2]);
		if (repository === null)
			return { code: 1, stdout: "", stderr: "HTTP 404: Not Found (stub world)\n" };
		const rest = parts.slice(3);
		if (rest[0] === "issues" && rest[1] !== undefined && rest[2] === "comments") {
			const number = Number(rest[1]);
			// The plane reads a pull request's verdicts on the issues path with
			// the pull request's number, so the pull request wins the match.
			const pull = repository.pullRequests.find((item) => item.number === number);
			const issue = repository.issues.find((item) => item.number === number);
			if (pull === undefined && issue === undefined)
				return { code: 1, stdout: "", stderr: "HTTP 404: Not Found (stub world)\n" };
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
			return { code: 0, stdout: "[]", stderr: "" };
		}
		if (rest[0] === "pulls" && rest[1] !== undefined && rest[2] === "reviews") {
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
		if (rest[0] === "pulls" && rest[1] !== undefined && rest.length === 2) {
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
		if (rest[0] === "security-advisories") {
			const state = fields.get("state");
			if (state === undefined)
				return this.refusal(tokens, "the advisory feed was read without a state");
			return {
				code: 0,
				stdout: JSON.stringify(
					repository.security.advisories.filter((item) => item.state === state),
				),
				stderr: "",
			};
		}
		if (rest[0] === "dependabot" && rest[1] === "alerts") {
			const state = fields.get("state");
			if (state === undefined)
				return this.refusal(tokens, "the dependabot feed was read without a state");
			return {
				code: 0,
				stdout: JSON.stringify(
					repository.security.dependabotAlerts.filter((item) => item.state === state),
				),
				stderr: "",
			};
		}
		if (rest[0] === "secret-scanning" && rest[1] === "alerts") {
			const state = fields.get("state");
			if (state === undefined)
				return this.refusal(tokens, "the secret scanning feed was read without a state");
			return {
				code: 0,
				stdout: JSON.stringify(
					repository.security.secretScanningAlerts.filter((item) => item.state === state),
				),
				stderr: "",
			};
		}
		return this.refusal(tokens, `an endpoint the world does not know: ${path}`);
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
		if (kind === "pr" && verb === "merge") return this.answerMerge(rest);
		if (kind === "pr" && verb === "comment") return this.answerComment(rest);
		return this.refusal(args, `an unknown item command: ${kind} ${verb}`);
	}

	private answerEdit(kind: "issue" | "pr", rest: string[]): Answer {
		const number = externalKeyNumber(rest[0]);
		let repositoryIdentity: string | null = null;
		const added: string[] = [];
		const removed: string[] = [];
		for (let i = 1; i < rest.length; i += 1) {
			const token = rest[i];
			if (token === "--repo") {
				if (i + 1 >= rest.length) return this.refusal(rest, "the repo flag has no value");
				repositoryIdentity = rest[i + 1];
				i += 1;
			} else if (token === "--add-label") {
				if (i + 1 >= rest.length) return this.refusal(rest, "the label flag has no value");
				added.push(...rest[i + 1].split(",").filter((item) => item !== ""));
				i += 1;
			} else if (token === "--remove-label") {
				if (i + 1 >= rest.length) return this.refusal(rest, "the label flag has no value");
				removed.push(...rest[i + 1].split(",").filter((item) => item !== ""));
				i += 1;
			} else {
				return this.refusal(rest, `an unknown edit flag: ${token}`);
			}
		}
		if (number === null || repositoryIdentity === null)
			return this.refusal(rest, "no item or no repository");
		const repository = this.repositoryOfIdentity(repositoryIdentity);
		if (repository === null)
			return {
				code: 1,
				stdout: "",
				stderr: `GraphQL: Could not resolve to ${kind === "pr" ? "a PullRequest" : "an Issue"} with the number of ${number}.\n`,
			};
		const item =
			kind === "issue"
				? repository.issues.find((entry) => entry.number === number)
				: repository.pullRequests.find((entry) => entry.number === number);
		if (item === undefined)
			return {
				code: 1,
				stdout: "",
				stderr: `GraphQL: Could not resolve to ${kind === "pr" ? "a PullRequest" : "an Issue"} with the number of ${number}.\n`,
			};
		for (const label of added)
			if (!item.labels.some((entry) => entry.toLowerCase() === label.toLowerCase()))
				item.labels.push(label);
		item.labels = item.labels.filter(
			(label) => !removed.some((entry) => entry.toLowerCase() === label.toLowerCase()),
		);
		item.updatedAt = now();
		this.save();
		return { code: 0, stdout: this.itemUrl(repository, kind, number), stderr: "" };
	}

	private answerMerge(rest: string[]): Answer {
		const number = externalKeyNumber(rest[0]);
		let repositoryIdentity: string | null = null;
		for (let i = 1; i < rest.length; i += 1) {
			const token = rest[i];
			if (token === "--repo") {
				if (i + 1 >= rest.length) return this.refusal(rest, "the repo flag has no value");
				repositoryIdentity = rest[i + 1];
				i += 1;
			} else if (token === "--squash" || token === "--merge" || token === "--rebase") {
				// The method the plane names. The stub's merge settles the same
				// way for every method, so the flag is validated and not stored.
			} else {
				return this.refusal(rest, `an unknown merge flag: ${token}`);
			}
		}
		if (number === null || repositoryIdentity === null)
			return this.refusal(rest, "no item or no repository");
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
		if (pull.merged)
			return { code: 1, stdout: "", stderr: "GraphQL: Pull request is already merged.\n" };
		if (pull.state === "closed")
			return { code: 1, stdout: "", stderr: "GraphQL: Pull request is closed.\n" };
		const gate = repository.mergeGates[String(number)];
		if (gate !== undefined && !gate.passing)
			return {
				code: 1,
				stdout: "",
				stderr: `GraphQL: Pull request is not mergeable: ${gate.reason || "the merge gate is failing"}\n`,
			};
		pull.merged = true;
		pull.state = "closed";
		pull.updatedAt = now();
		// The GitHub semantics: a merged pull request closes the issues it
		// closes, so both tickets leave the list on a clean merge.
		for (const issue of repository.issues) {
			if (pull.closingIssueNumbers.includes(issue.number)) {
				issue.state = "closed";
				issue.updatedAt = now();
			}
		}
		this.save();
		return {
			code: 0,
			stdout: `Successfully merged pull request #${number} in ${this.world.owner}/${repository.name}.\n`,
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
		pull.comments.push({ body, createdAt: now() });
		pull.updatedAt = now();
		this.save();
		return {
			code: 0,
			stdout: this.itemUrl(repository, "pr", number),
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

	/** Record the refusal and answer it. */
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
function externalKeyNumber(key: string | undefined): number | null {
	if (key === undefined) return null;
	const trimmed = key.trim();
	const cut = trimmed.startsWith("#") ? 1 : 0;
	const value = trimmed.slice(cut);
	if (value === "" || !/^\d+$/.test(value)) return null;
	return Number(value);
}

// The world file's document, checked. A malformed file is an error the
// startup report takes, not a silent empty world.
function validateWorld(raw: unknown): StubWorld {
	const record = raw as Record<string, unknown>;
	if (record === null || typeof record !== "object" || Array.isArray(record))
		throw new StubWorldError("the world file is not an object");
	if (record.version !== 1) throw new StubWorldError("the world file is not version 1");
	if (typeof record.host !== "string" || record.host === "")
		throw new StubWorldError("the world file has no host");
	if (typeof record.owner !== "string" || record.owner === "")
		throw new StubWorldError("the world file has no owner");
	const autoScore = record.autoScore as Record<string, unknown> | undefined;
	if (
		autoScore === undefined ||
		typeof autoScore.enabled !== "boolean" ||
		typeof autoScore.score !== "number"
	)
		throw new StubWorldError("the world file has no auto score setting");
	if (!Array.isArray(record.repositories))
		throw new StubWorldError("the world file has no repositories");
	const securityOf = (entry: Record<string, unknown>) =>
		typeof entry.security === "object" && entry.security !== null
			? (entry.security as Record<string, unknown>)
			: {};
	const repositories: StubRepository[] = [];
	for (const entry of record.repositories as unknown[]) {
		const item = entry as Record<string, unknown>;
		if (typeof item.name !== "string" || item.name === "")
			throw new StubWorldError("a repository in the world file has no name");
		if (!Array.isArray(item.issues) || !Array.isArray(item.pullRequests))
			throw new StubWorldError(`repository ${item.name} has no items`);
		repositories.push({
			name: item.name,
			issues: item.issues as StubIssue[],
			pullRequests: item.pullRequests as StubPullRequest[],
			mergeGates: (item.mergeGates ?? {}) as Record<string, StubMergeGate>,
			security: {
				advisories: (securityOf(item).advisories ?? []) as Array<Record<string, unknown>>,
				dependabotAlerts: (securityOf(item).dependabotAlerts ?? []) as Array<
					Record<string, unknown>
				>,
				secretScanningAlerts: (securityOf(item).secretScanningAlerts ?? []) as Array<
					Record<string, unknown>
				>,
			},
		});
	}
	return {
		version: 1,
		host: record.host,
		owner: record.owner,
		autoScore: { enabled: autoScore.enabled, score: autoScore.score },
		repositories,
	};
}
