/**
 * Ticket source seam and the built-in GitHub adapters.
 *
 * A source is bound to one config entry. Its only operation returns a full,
 * settled snapshot. It never exposes scheduling, storage, or task choice.
 */
import type { GitHubAuthentication, TicketSourceConfig } from "./config.ts";
import type { FetchedTicket } from "./domain/ticket.ts";
import { type CommandRunner, commandFailureText } from "./runner.ts";

export type FetchOutcome =
	| { status: "success"; fetchedAt: string; tickets: FetchedTicket[] }
	| { status: "failed"; reason: string };

export interface TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs: number;
	fetch(): Promise<FetchOutcome>;
}

/** Construct one configured built-in source. Config validation has run first. */
export function createTicketSource(
	config: TicketSourceConfig,
	runner: CommandRunner,
	environment: NodeJS.ProcessEnv = process.env,
): TicketSource {
	return new GitHubTicketSource(config, runner, environment);
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
        repository { name nameWithOwner url }
      }
      ... on PullRequest {
        id number title body url state updatedAt isDraft
        labels(first: 100) { nodes { name } }
        repository { name nameWithOwner url }
      }
    }
  }
}`;

type GhOptions = { env?: Record<string, string>; secretEnv?: readonly string[] };

class GitHubTicketSource implements TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs: number;
	private accountToken: string | undefined;
	private readonly config: TicketSourceConfig;
	private readonly runner: CommandRunner;
	private readonly environment: NodeJS.ProcessEnv;

	constructor(config: TicketSourceConfig, runner: CommandRunner, environment: NodeJS.ProcessEnv) {
		this.config = config;
		this.runner = runner;
		this.environment = environment;
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
			return {
				status: "success",
				fetchedAt: new Date().toISOString(),
				tickets: [...byIdentity.values()],
			};
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
	private async fetchQuery(searchQuery: string, options: GhOptions): Promise<FetchOutcome> {
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
				tickets.push(normalized.ticket);
			}
			if (!page.hasNextPage)
				return { status: "success", fetchedAt: new Date().toISOString(), tickets };
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
				queries.push(`${scope} label:ready-for-agent`);
			} else {
				// `needs-work` intentionally does not test draft. The review and
				// merge halves do: a draft cannot be reviewed to a verdict or merged.
				queries.push(`${scope} label:needs-work`);
				queries.push(`${scope} label:ready-for-review no:draft`);
				queries.push(`${scope} label:ready-to-ship no:draft`);
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
		const auth = this.config.auth;
		if (auth === undefined) return { ok: true, options: {} };
		if (auth.token !== undefined) return secretToken(auth.token);
		if (auth.tokenEnv !== undefined) {
			const token = this.environment[auth.tokenEnv];
			if (token === undefined || token === "")
				return {
					ok: false,
					reason: `GitHub token environment variable ${auth.tokenEnv} is not set`,
				};
			return secretToken(token);
		}
		return this.accountAuthentication(auth);
	}

	private async accountAuthentication(
		auth: GitHubAuthentication,
	): Promise<{ ok: true; options: GhOptions } | { ok: false; reason: string }> {
		if (this.accountToken !== undefined) return secretToken(this.accountToken);
		const result = await this.runner.run("gh", [
			"auth",
			"token",
			"--hostname",
			this.config.host,
			"--user",
			auth.account ?? "",
		]);
		if (result.code !== 0)
			return {
				ok: false,
				reason: `GitHub account ${auth.account} is unavailable: ${commandFailureText(result)}`,
			};
		const token =
			[...result.stdout.split(/\r?\n/)]
				.reverse()
				.find((line) => line.trim() !== "")
				?.trim() ?? "";
		if (token === "")
			return { ok: false, reason: `GitHub account ${auth.account} returned no token` };
		this.accountToken = token;
		return secretToken(token);
	}
}

function secretToken(token: string): {
	ok: true;
	options: { env: Record<string, string>; secretEnv: readonly string[] };
} {
	return { ok: true, options: { env: { GH_TOKEN: token }, secretEnv: ["GH_TOKEN"] } };
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

function normalizeGitHubNode(
	node: unknown,
	config: TicketSourceConfig,
): { ok: true; ticket: FetchedTicket } | { ok: false; reason: string } {
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
	const labels = ((item.labels as { nodes?: unknown })?.nodes ?? []) as unknown[];
	const labelNames: string[] = [];
	for (const label of labels) {
		const name = stringOf((label as Record<string, unknown>).name);
		if (name === undefined) return { ok: false, reason: "GitHub returned an unreadable label" };
		labelNames.push(name);
	}
	const isDraft = item.isDraft;
	if (config.kind === "github-pull-requests" && typeof isDraft !== "boolean")
		return { ok: false, reason: "GitHub returned an unreadable pull request" };
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
				identity: `${config.host.toLowerCase()}/${nameWithOwner}`,
				displayName: nameWithOwner,
				cloneUrl: `https://${config.host}/${nameWithOwner}.git`,
			},
			attributes: config.kind === "github-pull-requests" ? { draft: String(isDraft) } : {},
		},
	};
}
function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
