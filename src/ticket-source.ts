/**
 * Ticket source seam and the built-in GitHub adapters.
 *
 * A source is bound to one config entry. Its only operation returns a full,
 * settled snapshot. It never exposes scheduling, storage, or task choice.
 */
import type { GitHubAuthentication, TicketSourceConfig } from "./config.ts";
import { isSecuritySourceKind } from "./config.ts";
import { type FetchedTicket, type IssueReference, withIssueReferences } from "./domain/ticket.ts";
import { type CommandOptions, type CommandRunner, commandFailureText } from "./runner.ts";
import { GitHubSecurityTicketSource } from "./security-source.ts";

/**
 * One Referenced issue fact (ADR 0023): the labels and fetch time the control
 * plane stores for an issue a reference covers, keyed by the issue's
 * identity. A fact is not a ticket: it takes no row in the Main view and is
 * never handed off.
 */
export interface ReferencedIssueFact {
	identity: string;
	labels: string[];
	fetchedAt: string;
}

export type FetchOutcome =
	| {
			status: "success";
			fetchedAt: string;
			tickets: FetchedTicket[];
			/**
			 * The Referenced issue facts covered by this refresh (ADR 0023), for
			 * every reference in the current snapshot or resolved by the direct
			 * read. Absent when the source holds no references, and when the
			 * direct read failed: the state then keeps the facts it already
			 * holds.
			 */
			referencedIssueFacts?: ReferencedIssueFact[];
			/** The peripheral failures the refresh absorbed without failing. */
			warnings?: string[];
	  }
	| { status: "failed"; reason: string };

/**
 * One live ticket as the refresh covers references against it (ADR 0023):
 * its identity and the labels of its newest membership.
 */
export interface LiveTicket {
	readonly identity: string;
	readonly labels: string[];
}

export interface TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs: number;
	/**
	 * Read one full, settled snapshot.
	 *
	 * @param knownLiveTickets The live tickets of the current snapshot with
	 * their newest membership labels (ADR 0023). The pull request source
	 * covers its Issue references against them: a covered reference's fact
	 * refreshes from its ticket's labels, and the uncovered ones are read
	 * directly, in chunks of at most 250 references per request.
	 */
	fetch(knownLiveTickets?: readonly LiveTicket[]): Promise<FetchOutcome>;
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

/**
 * The chunk of the batched reference read: one request per 250 references.
 * 250 references times their 100 labels is 25,000 possible nodes, a fifth
 * of GitHub's 500,000 possible-node cap, so the count of references can
 * grow without re-tripping the limit (issue #65).
 */
const REFERENCE_READ_CHUNK = 250;

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
        id number title body url state updatedAt isDraft
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

	async fetch(knownLiveTickets: readonly LiveTicket[] = []): Promise<FetchOutcome> {
		try {
			const authentication = await this.authentication();
			if (!authentication.ok) return { status: "failed", reason: authentication.reason };
			const byIdentity = new Map<string, FetchedTicket>();
			const references: SearchReference[] = [];
			for (const searchQuery of this.searchQueries()) {
				const query = await this.fetchQuery(searchQuery, authentication.options);
				if (query.status === "failed") return query;
				for (const ticket of query.tickets) byIdentity.set(ticket.identity, ticket);
				references.push(...query.references);
			}
			const tickets = [...byIdentity.values()];
			const fetchedAt = new Date().toISOString();
			const deduped = dedupeReferences(references);
			if (deduped.length === 0) return { status: "success", fetchedAt, tickets };
			// A reference is covered when the issue is a live ticket of the
			// current snapshot: its ticket's stored labels supply the rank,
			// and they refresh the reference's fact. One rule covers the
			// never-seen issue and the issue that left the source: the
			// uncovered ones are read directly (ADR 0023).
			const coveredLabels = new Map(
				knownLiveTickets.map((ticket) => [ticket.identity, ticket.labels]),
			);
			const uncovered = deduped.filter(
				(reference) => reference.identity === null || !coveredLabels.has(reference.identity),
			);
			if (uncovered.length === 0)
				return {
					status: "success",
					fetchedAt,
					tickets,
					referencedIssueFacts: deduped.map((reference) => ({
						identity: reference.identity as string,
						labels: coveredLabels.get(reference.identity as string) ?? [],
						fetchedAt,
					})),
				};
			const read = await this.readUncoveredReferences(authentication, uncovered);
			if (!read.ok)
				return {
					status: "success",
					fetchedAt,
					tickets,
					// A failed direct read never fails the source (ADR 0023): the
					// previous facts stay in place, the rest of the refresh
					// applies, and the outcome carries the one warning line.
					warnings: [`referenced issue read failed: ${read.reason}`],
				};
			// The read's answers line up with the uncovered references: a null
			// answer means the reference did not resolve, and it keeps its
			// previous fact: the outcome simply carries no fact for it.
			const answerByKey = new Map<string, { identity: string; labels: string[] }>();
			uncovered.forEach((reference, index) => {
				const answer = read.resolved[index];
				if (answer !== null) answerByKey.set(referenceKey(reference), answer);
			});
			const facts: ReferencedIssueFact[] = [];
			for (const reference of deduped) {
				const identity = reference.identity;
				if (identity !== null && coveredLabels.has(identity)) {
					facts.push({ identity, labels: coveredLabels.get(identity) ?? [], fetchedAt });
					continue;
				}
				const answer = answerByKey.get(referenceKey(reference));
				if (answer !== undefined)
					facts.push({ identity: answer.identity, labels: answer.labels, fetchedAt });
			}
			return { status: "success", fetchedAt, tickets, referencedIssueFacts: facts };
		} catch (error) {
			// A source bug must not terminate the control plane. Do not print
			// auth values: the string is only the error message, never argv/env.
			return {
				status: "failed",
				reason: `unexpected GitHub source failure: ${readableError(error)}`,
			};
		}
	}

	/**
	 * The batched direct read (ADR 0023): GraphQL requests that resolve every
	 * uncovered Issue reference, at most REFERENCE_READ_CHUNK per request, so
	 * the read stays under GitHub's possible-node budget no matter how many
	 * references a snapshot carries (issue #65). It resolves each reference by
	 * its identity when the identity is known, else by its repository and
	 * number. A failure returns the reason: the refresh still succeeds, with
	 * one warning line and the previous facts in place.
	 */
	private async readUncoveredReferences(
		authentication: { ok: true; options: GhOptions },
		references: readonly SearchReference[],
	): Promise<
		| {
				ok: true;
				resolved: Array<{ identity: string; number: number; labels: string[] } | null>;
		  }
		| { ok: false; reason: string }
	> {
		const resolved: Array<{ identity: string; number: number; labels: string[] } | null> =
			Array.from({ length: references.length }, () => null);
		for (let start = 0; start < references.length; start += REFERENCE_READ_CHUNK) {
			const chunk = references.slice(start, start + REFERENCE_READ_CHUNK);
			const read = await this.readReferenceChunk(authentication, chunk);
			if (!read.ok) return { ok: false, reason: read.reason };
			read.resolved.forEach((answer, index) => {
				resolved[start + index] = answer;
			});
		}
		return { ok: true, resolved };
	}

	/**
	 * One request of the batched direct read (ADR 0023): at most
	 * REFERENCE_READ_CHUNK references, so the request stays under GitHub's
	 * possible-node budget no matter how many references a snapshot carries
	 * (issue #65).
	 */
	private async readReferenceChunk(
		authentication: { ok: true; options: GhOptions },
		references: readonly SearchReference[],
	): Promise<
		| { ok: true; resolved: Array<{ identity: string; number: number; labels: string[] } | null> }
		| { ok: false; reason: string }
	> {
		const declarations: string[] = [];
		const fields: string[] = [];
		const assignments: string[] = [];
		references.forEach((reference, index) => {
			if (reference.nodeId !== null) {
				declarations.push(`$ref${index}Id: ID!`);
				fields.push(
					`reference${index}: node(id: $ref${index}Id) { ... on Issue { id number labels(first: 100) { nodes { name } } } }`,
				);
				assignments.push(`ref${index}Id=${reference.nodeId}`);
				return;
			}
			const separator = reference.repository.indexOf("/");
			const owner =
				separator === -1 ? reference.repository : reference.repository.slice(0, separator);
			const name = separator === -1 ? "" : reference.repository.slice(separator + 1);
			declarations.push(
				`$ref${index}Owner: String!`,
				`$ref${index}Name: String!`,
				`$ref${index}Number: Int!`,
			);
			fields.push(
				`reference${index}: repository(owner: $ref${index}Owner, name: $ref${index}Name) { issue(number: $ref${index}Number) { id number labels(first: 100) { nodes { name } } } }`,
			);
			assignments.push(
				`ref${index}Owner=${owner}`,
				`ref${index}Name=${name}`,
				`ref${index}Number=${reference.number}`,
			);
		});
		const args = [
			"api",
			"graphql",
			"--hostname",
			this.config.host,
			"-f",
			`query=query FactoryReferenceRead(${declarations.join(", ")}) { ${fields.join(" ")} }`,
		];
		for (const assignment of assignments) args.push("-f", assignment);
		const result = await this.runner.run("gh", args, authentication.options);
		if (result.code !== 0)
			return { ok: false, reason: `GitHub request failed: ${commandFailureText(result)}` };
		const parsed = parseReferenceResponse(result.stdout, references.length);
		if (!parsed.ok) return { ok: false, reason: parsed.reason };
		// Aligned with the references read: index i answers reference i.
		const resolved: Array<{ identity: string; number: number; labels: string[] } | null> =
			parsed.issues.map((issue) =>
				issue === null
					? null
					: {
							identity: `github:${this.config.host.toLowerCase()}:${issue.nodeId}`,
							number: issue.number,
							labels: issue.labels,
						},
			);
		return { ok: true, resolved };
	}

	/** Read one search query to completion. A failure means the snapshot is incomplete. */
	private async fetchQuery(searchQuery: string, options: GhOptions): Promise<QueryResult> {
		const tickets: FetchedTicket[] = [];
		const references: SearchReference[] = [];
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
				references.push(...normalized.references);
			}
			if (!page.hasNextPage) return { status: "success", tickets, references };
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

/** One search page's tickets and the references the pull requests closed. */
type QueryResult =
	| { status: "success"; tickets: FetchedTicket[]; references: SearchReference[] }
	| { status: "failed"; reason: string };

/**
 * One referenced issue as the search response resolves it (ADR 0023). The
 * search carries no labels on the reference: a nested label list would push
 * the query past GitHub's possible-node budget (issue #65). The labels ride
 * the ticket's snapshot or the direct read.
 */
type SearchReference = IssueReference & { nodeId: string | null };

/** The map key of one reference: the identity, else the number. */
function referenceKey(reference: { identity: string | null; number: number }): string {
	return reference.identity ?? `number:${reference.number}`;
}

/** The references of every fetched ticket, deduped by their key. */
function dedupeReferences(references: readonly SearchReference[]): SearchReference[] {
	const seen = new Set<string>();
	const deduped: SearchReference[] = [];
	for (const reference of references) {
		const key = referenceKey(reference);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(reference);
	}
	return deduped;
}

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
 * The pull request's closing-issue references from a search node (ADR 0023).
 *
 * The references are secondary facts: a reference without a readable
 * number is skipped, and a reference the response leaves without a node
 * identity keeps an empty value, so the refresh can still read it directly.
 */
function parseClosingReferences(raw: unknown, host: string): SearchReference[] {
	const nodes = (raw as { nodes?: unknown } | undefined)?.nodes;
	if (!Array.isArray(nodes)) return [];
	const references: SearchReference[] = [];
	for (const node of nodes) {
		const item = node as Record<string, unknown>;
		const number = item.number;
		if (typeof number !== "number") continue;
		const nodeId = stringOf(item.id) ?? null;
		const repository =
			stringOf((item.repository as Record<string, unknown> | undefined)?.nameWithOwner) ?? "";
		references.push({
			identity: nodeId === null ? null : `github:${host.toLowerCase()}:${nodeId}`,
			nodeId,
			number,
			repository,
		});
	}
	return references;
}

/** The direct read's answer: one issue per reference, null when unresolved. */
type ReferenceResponse =
	| {
			ok: true;
			issues: Array<null | { nodeId: string; number: number; labels: string[] }>;
	  }
	| { ok: false; reason: string };
function parseReferenceResponse(text: string, count: number): ReferenceResponse {
	let raw: unknown;
	const json = text.slice(text.indexOf("{"));
	try {
		raw = JSON.parse(json);
	} catch {
		return { ok: false, reason: "GitHub returned invalid JSON" };
	}
	const data = raw as {
		data?: Record<string, unknown>;
		errors?: Array<{ message?: unknown }>;
	};
	if (Array.isArray(data.errors) && data.errors.length > 0)
		return {
			ok: false,
			reason: `GitHub API error: ${String(data.errors[0].message ?? "unknown error")}`,
		};
	if (data.data === undefined)
		return { ok: false, reason: "GitHub returned an unreadable reference response" };
	const issues: Array<null | { nodeId: string; number: number; labels: string[] }> = [];
	for (let index = 0; index < count; index++) {
		let value = data.data[`reference${index}`] as Record<string, unknown> | null | undefined;
		// The repository-and-number shape wraps the issue one level deeper.
		if (value !== null && value !== undefined && "issue" in value)
			value = (value as { issue?: Record<string, unknown> | null }).issue ?? null;
		const nodeId = stringOf(value?.id);
		const number = value?.number;
		if (nodeId === undefined || typeof number !== "number") {
			issues.push(null);
			continue;
		}
		const labels = labelNamesOf(value?.labels);
		issues.push(labels === undefined ? null : { nodeId, number, labels });
	}
	return { ok: true, issues };
}

function normalizeGitHubNode(
	node: unknown,
	config: TicketSourceConfig,
):
	| { ok: true; ticket: FetchedTicket; references: SearchReference[]; blocked: boolean }
	| { ok: false; reason: string } {
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
	if (config.kind === "github-pull-requests" && typeof isDraft !== "boolean")
		return { ok: false, reason: "GitHub returned an unreadable pull request" };
	// The pull request's closing-issue references, stored as source facts on
	// its membership (ADR 0023). A refresh can change them.
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
				identity: `${config.host.toLowerCase()}/${nameWithOwner}`,
				displayName: nameWithOwner,
				cloneUrl: `https://${config.host}/${nameWithOwner}.git`,
			},
			attributes:
				config.kind === "github-pull-requests"
					? withIssueReferences({ draft: String(isDraft) }, references)
					: {},
		},
		references,
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
