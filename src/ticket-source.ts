/**
 * Ticket source seam and the built-in GitHub adapters.
 *
 * A source is bound to one config entry. Its only operation returns a full,
 * settled snapshot. It never exposes scheduling, storage, or task choice.
 */
import type { GitHubAuthentication, TicketSourceConfig } from "./config.ts";
import { isSecuritySourceKind } from "./config.ts";
import {
	type FetchedTicket,
	type IssueReference,
	withHeadBranch,
	withIssueReferences,
} from "./domain/ticket.ts";
import { type CommandOptions, type CommandRunner, commandFailureText } from "./runner.ts";
import { GitHubSecurityTicketSource } from "./security-source.ts";

export type FetchOutcome =
	| {
			status: "success";
			fetchedAt: string;
			tickets: FetchedTicket[];
			/** The peripheral failures the refresh absorbed without failing. */
			warnings?: string[];
	  }
	| { status: "failed"; reason: string };

export interface TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs: number;
	/** Read one full, settled snapshot. */
	fetch(): Promise<FetchOutcome>;
}

/** Construct one configured built-in source. Config validation has run first. */
export function createTicketSource(
	config: TicketSourceConfig,
	runner: CommandRunner,
	environment: NodeJS.ProcessEnv = process.env,
): TicketSource {
	// The security feeds read REST endpoints, not GitHub searches (issue #73).
	if (isSecuritySourceKind(config.kind))
		return new GitHubSecurityTicketSource(config, runner, environment);
	return new GitHubTicketSource(config, runner, environment);
}

/**
 * The GitHub authentication of one configured source (issue #73 shares it
 * with the security sources): the existing table of a literal token, a token
 * environment variable, or an authenticated account. A token travels in the
 * environment, never in argv.
 */
export class GhAuthenticator {
	private accountToken: string | undefined;
	private readonly host: string;
	private readonly auth: GitHubAuthentication | undefined;
	private readonly runner: CommandRunner;
	private readonly environment: NodeJS.ProcessEnv;

	constructor(
		host: string,
		auth: GitHubAuthentication | undefined,
		runner: CommandRunner,
		environment: NodeJS.ProcessEnv,
	) {
		this.host = host;
		this.auth = auth;
		this.runner = runner;
		this.environment = environment;
	}

	async resolve(): Promise<{ ok: true; options: GhOptions } | { ok: false; reason: string }> {
		if (this.auth === undefined) return { ok: true, options: {} };
		if (this.auth.token !== undefined) return secretToken(this.auth.token);
		if (this.auth.tokenEnv !== undefined) {
			const token = this.environment[this.auth.tokenEnv];
			if (token === undefined || token === "")
				return {
					ok: false,
					reason: `GitHub token environment variable ${this.auth.tokenEnv} is not set`,
				};
			return secretToken(token);
		}
		if (this.accountToken !== undefined) return secretToken(this.accountToken);
		const account = this.auth.account ?? "";
		const result = await this.runner.run("gh", [
			"auth",
			"token",
			"--hostname",
			this.host,
			"--user",
			account,
		]);
		if (result.code !== 0)
			return {
				ok: false,
				reason: `GitHub account ${account} is unavailable: ${commandFailureText(result)}`,
			};
		const token =
			[...result.stdout.split(/\r?\n/)]
				.reverse()
				.find((line) => line.trim() !== "")
				?.trim() ?? "";
		if (token === "") return { ok: false, reason: `GitHub account ${account} returned no token` };
		this.accountToken = token;
		return secretToken(token);
	}
}

function secretToken(token: string): {
	ok: true;
	options: {
		env: Record<string, string>;
		secretEnv: readonly string[];
	};
} {
	return { ok: true, options: { env: { GH_TOKEN: token }, secretEnv: ["GH_TOKEN"] } };
}

const SEARCH_QUERY = `query FactorySearch($searchQuery: String!, $after: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        id number title body url state updatedAt
        labels(first: 100) { nodes { name } }
        blockedBy(first: 100) { nodes { number state } }
        repository { name nameWithOwner url }
      }
      ... on PullRequest {
        id number title body url state updatedAt isDraft headRefName
        labels(first: 100) { nodes { name } }
        repository { name nameWithOwner url }
        closingIssuesReferences(first: 100) {
          nodes {
            id number
            repository { name nameWithOwner }
          }
        }
      }
    }
  }
}`;

type GhOptions = CommandOptions;

class GitHubTicketSource implements TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs: number;
	private readonly config: TicketSourceConfig;
	private readonly runner: CommandRunner;
	private readonly authenticator: GhAuthenticator;

	constructor(config: TicketSourceConfig, runner: CommandRunner, environment: NodeJS.ProcessEnv) {
		this.config = config;
		this.runner = runner;
		this.authenticator = new GhAuthenticator(config.host, config.auth, runner, environment);
		this.name = config.name;
		this.kind = config.kind;
		this.refreshIntervalMs = config.refreshIntervalSeconds * 1000;
	}

	async fetch(): Promise<FetchOutcome> {
		try {
			const authentication = await this.authentication();
			if (!authentication.ok) return { status: "failed", reason: authentication.reason };
			const byIdentity = new Map<string, FetchedTicket>();
			for (const searchQuery of this.searchQueries()) {
				const query = await this.fetchQuery(searchQuery, authentication.options);
				if (query.status === "failed") return query;
				for (const ticket of query.tickets) byIdentity.set(ticket.identity, ticket);
			}
			const tickets = [...byIdentity.values()];
			return { status: "success", fetchedAt: new Date().toISOString(), tickets };
		} catch (error) {
			// A source bug must not terminate the control plane. Do not print
			// auth values: the string is only the error message, never argv/env.
			return {
				status: "failed",
				reason: `unexpected GitHub source failure: ${readableError(error)}`,
			};
		}
	}

	/** Read one search query to completion. A failure means the snapshot is incomplete. */
	private async fetchQuery(searchQuery: string, options: GhOptions): Promise<QueryResult> {
		const tickets: FetchedTicket[] = [];
		let cursor: string | undefined;
		let issueCount: number | undefined;
		for (;;) {
			const args = [
				"api",
				"graphql",
				"--hostname",
				this.config.host,
				"-f",
				`query=${SEARCH_QUERY}`,
				"-f",
				`searchQuery=${searchQuery}`,
			];
			if (cursor !== undefined) args.push("-f", `after=${cursor}`);
			const result = await this.runner.run("gh", args, options);
			if (result.code !== 0) {
				return { status: "failed", reason: `GitHub request failed: ${commandFailureText(result)}` };
			}
			const page = parseSearchPage(result.stdout);
			if (!page.ok) return { status: "failed", reason: page.reason };
			issueCount ??= page.issueCount;
			if (issueCount >= 1000) {
				return {
					status: "failed",
					reason: "GitHub search has 1,000 or more results and is incomplete",
				};
			}
			for (const node of page.nodes) {
				const normalized = normalizeGitHubNode(node, this.config);
				if (!normalized.ok) return { status: "failed", reason: normalized.reason };
				// An issue blocked by an unclosed issue is not handoff work. The
				// source drops it the way the `blocked` label does, so the app
				// never sees it at all.
				if (normalized.blocked) continue;
				tickets.push(normalized.ticket);
			}
			if (!page.hasNextPage) return { status: "success", tickets };
			if (page.endCursor === undefined)
				return { status: "failed", reason: "GitHub returned a next page without a cursor" };
			cursor = page.endCursor;
		}
	}

	/**
	 * One query per repository and per policy branch. GitHub issue search does
	 * not join qualifier values with AND/OR and has no parenthesized grouping:
	 * such queries fail or return zero silently. Merging separate queries is
	 * the only supported way to express a union. Config validation rejects
	 * user filters that carry these shapes.
	 */
	private searchQueries(): string[] {
		const queries: string[] = [];
		for (const repository of this.config.repositories) {
			if (this.config.filter !== undefined) {
				queries.push(`${this.kindQualifier()} repo:${repository} ${this.config.filter}`);
				continue;
			}
			const scope = `is:open ${this.kindQualifier()} repo:${repository} -label:blocked`;
			if (this.kind === "github-issues") {
				// The plane owns the workflow labels (ADR 0027): it writes
				// `ready-for-agent` itself, so the default query does not
				// require it. Every open issue enters the machine; a state
				// match names the task, and the default task type takes
				// the unlabeled issues.
				queries.push(scope);
			} else {
				// The same rule on the pull request side, and it is load-bearing:
				// the implement transition labels the pull request the agent just
				// opened, and it can only do that when the pull request is already
				// in the list. So the default policy lists open pull requests,
				// unlabeled ones included. The draft policy carries over: only
				// `needs-work` may rest on a draft, because a draft cannot be
				// reviewed to a verdict or merged, and GitHub search cannot express
				// that union in one query.
				queries.push(`${scope} label:needs-work`);
				queries.push(`${scope} no:draft`);
			}
		}
		return queries;
	}

	private kindQualifier(): string {
		return this.config.kind === "github-issues" ? "is:issue" : "is:pr";
	}

	private async authentication(): Promise<
		{ ok: true; options: GhOptions } | { ok: false; reason: string }
	> {
		return this.authenticator.resolve();
	}
}

type Page =
	| { ok: true; issueCount: number; nodes: unknown[]; hasNextPage: boolean; endCursor?: string }
	| { ok: false; reason: string };
function parseSearchPage(text: string): Page {
	let raw: unknown;
	// Version-manager shims can print a one-line activation notice before
	// gh's JSON. Keep the adapter strict about the JSON value while accepting
	// that harmless command-runner noise.
	const json = text.slice(text.indexOf("{"));
	try {
		raw = JSON.parse(json);
	} catch {
		return { ok: false, reason: "GitHub returned invalid JSON" };
	}
	const data = raw as {
		data?: {
			search?: {
				issueCount?: unknown;
				nodes?: unknown;
				pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
			};
		};
		errors?: Array<{ message?: unknown }>;
	};
	if (Array.isArray(data.errors) && data.errors.length > 0)
		return {
			ok: false,
			reason: `GitHub API error: ${String(data.errors[0].message ?? "unknown error")}`,
		};
	const search = data.data?.search;
	if (
		search === undefined ||
		!Number.isInteger(search.issueCount) ||
		!Array.isArray(search.nodes) ||
		typeof search.pageInfo?.hasNextPage !== "boolean"
	)
		return { ok: false, reason: "GitHub returned an unreadable search response" };
	const cursor = search.pageInfo.endCursor;
	return {
		ok: true,
		issueCount: search.issueCount as number,
		nodes: search.nodes,
		hasNextPage: search.pageInfo.hasNextPage,
		...(typeof cursor === "string" && cursor !== "" ? { endCursor: cursor } : {}),
	};
}

/** One search page's tickets. The pull request's closing references ride on
 * each ticket's own attributes (ADR 0050): the page carries no separate list. */
type QueryResult =
	| { status: "success"; tickets: FetchedTicket[] }
	| { status: "failed"; reason: string };

/** The labels of one node's label connection, or undefined when unreadable. */
function labelNamesOf(raw: unknown): string[] | undefined {
	const nodes = (raw as { nodes?: unknown } | undefined)?.nodes;
	if (!Array.isArray(nodes)) return undefined;
	const names: string[] = [];
	for (const label of nodes) {
		const name = stringOf((label as Record<string, unknown>).name);
		if (name === undefined) return undefined;
		names.push(name);
	}
	return names;
}

/**
 * The pull request's closing-issue references from a search node (ADR 0042).
 *
 * ADR 0050 retired the rank these references used to carry and kept the
 * link: the fixing pull request rule and the linked-pull-request lookup
 * read it.
 *
 * The references are secondary facts: a reference without a readable
 * number is skipped, and a reference the response leaves without a node
 * identity keeps an empty value.
 */
function parseClosingReferences(raw: unknown, host: string): IssueReference[] {
	const nodes = (raw as { nodes?: unknown } | undefined)?.nodes;
	if (!Array.isArray(nodes)) return [];
	const references: IssueReference[] = [];
	for (const node of nodes) {
		const item = node as Record<string, unknown>;
		const number = item.number;
		if (typeof number !== "number") continue;
		const nodeId = stringOf(item.id) ?? null;
		const repository =
			stringOf((item.repository as Record<string, unknown> | undefined)?.nameWithOwner) ?? "";
		references.push({
			identity: nodeId === null ? null : `github:${host.toLowerCase()}:${nodeId}`,
			number,
			repository,
		});
	}
	return references;
}

function normalizeGitHubNode(
	node: unknown,
	config: TicketSourceConfig,
): { ok: true; ticket: FetchedTicket; blocked: boolean } | { ok: false; reason: string } {
	const item = node as Record<string, unknown>;
	const expectedTypename = config.kind === "github-issues" ? "Issue" : "PullRequest";
	// The search query and this result check both enforce the configured kind.
	// A custom filter cannot turn an Issues source into a pull request source.
	if (item.__typename !== expectedTypename)
		return {
			ok: false,
			reason: `GitHub returned a ${String(item.__typename ?? "unknown item")} from a ${expectedTypename} source`,
		};
	const id = stringOf(item.id);
	const number = item.number;
	const title = stringOf(item.title);
	const url = stringOf(item.url);
	const state = stringOf(item.state);
	const updatedAt = stringOf(item.updatedAt);
	const repository = item.repository as Record<string, unknown> | undefined;
	const nameWithOwner = stringOf(repository?.nameWithOwner);
	const displayName = stringOf(repository?.name);
	if (
		id === undefined ||
		typeof number !== "number" ||
		title === undefined ||
		url === undefined ||
		state === undefined ||
		updatedAt === undefined ||
		nameWithOwner === undefined ||
		displayName === undefined
	) {
		return { ok: false, reason: `GitHub returned an unreadable ${expectedTypename}` };
	}
	if (
		!config.repositories.some(
			(repositoryName) => repositoryName.toLowerCase() === nameWithOwner.toLowerCase(),
		)
	) {
		return {
			ok: false,
			reason: `GitHub returned a ticket outside configured repositories: ${nameWithOwner}`,
		};
	}
	const labelNames = labelNamesOf(item.labels);
	if (labelNames === undefined) return { ok: false, reason: "GitHub returned an unreadable label" };
	const isDraft = item.isDraft;
	const headRefName = stringOf(item.headRefName);
	if (
		config.kind === "github-pull-requests" &&
		(typeof isDraft !== "boolean" || headRefName === undefined)
	)
		return { ok: false, reason: "GitHub returned an unreadable pull request" };
	// The pull request's closing-issue references, stored as source facts on
	// its membership (ADR 0042). A refresh can change them.
	const references =
		config.kind === "github-pull-requests"
			? parseClosingReferences(item.closingIssuesReferences, config.host)
			: [];
	// The issue's native "blocked by" links. A pull request carries no
	// links, and a server that answers without the field blocks nothing:
	// only a present but unreadable field fails the source.
	const blocked = isBlockedByOpenIssue(item.blockedBy);
	if (blocked === undefined)
		return { ok: false, reason: "GitHub returned an unreadable blocked-by link" };
	return {
		ok: true,
		ticket: {
			identity: `github:${config.host.toLowerCase()}:${id}`,
			sourceKind: config.kind === "github-issues" ? "github-issue" : "github-pull-request",
			externalKey: `#${number}`,
			sourceState: state.toLowerCase(),
			url,
			title,
			description: typeof item.body === "string" ? item.body : "",
			labels: labelNames,
			externalUpdatedAt: updatedAt,
			repository: {
				// The canonical repository identity is lowercase (the config
				// contract): the owner casing the API answers stays in the
				// display name only. A stored identity that keeps the API
				// casing breaks the case-insensitive repository equality every
				// cross-source rule reads, the fixing pull request's branch
				// link among them (ADR 0042).
				identity: `${config.host.toLowerCase()}/${nameWithOwner.toLowerCase()}`,
				displayName: nameWithOwner,
				cloneUrl: `https://${config.host}/${nameWithOwner}.git`,
			},
			attributes:
				config.kind === "github-pull-requests" && headRefName !== undefined
					? withHeadBranch(withIssueReferences({ draft: String(isDraft) }, references), headRefName)
					: {},
		},
		blocked,
	};
}

/**
 * Whether the issue is blocked by at least one unclosed issue: GitHub's
 * native "blocked by" links. A closed blocking issue unblocks. Returns
 * `undefined` when the field is present but unreadable, `false` when it is
 * absent.
 */
function isBlockedByOpenIssue(link: unknown): boolean | undefined {
	if (link === undefined || link === null) return false;
	const nodes = (link as { nodes?: unknown }).nodes;
	if (!Array.isArray(nodes)) return undefined;
	let blocked = false;
	for (const node of nodes) {
		const item = node as Record<string, unknown> | null;
		const state = item === null ? undefined : stringOf(item.state);
		if (state === undefined) return undefined;
		if (state.toUpperCase() === "OPEN") blocked = true;
	}
	return blocked;
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
