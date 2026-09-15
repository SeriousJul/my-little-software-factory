/**
 * Ticket source seam and the built-in GitHub adapters.
 *
 * A source is bound to one config entry. Its only operation returns a full,
 * settled snapshot. It never exposes scheduling, storage, or task choice.
 */
import type { GitHubAuthentication, TicketSourceConfig } from "./config.ts";
import { type FetchedTicket, type IssueReference, withIssueReferences } from "./domain/ticket.ts";
import { type CommandRunner, commandFailureText } from "./runner.ts";

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

export interface TicketSource {
	readonly name: string;
	readonly kind: string;
	readonly refreshIntervalMs: number;
	/**
	 * Read one full, settled snapshot.
	 *
	 * @param knownTicketIdentities The identities of the live tickets of the
	 * current snapshot (ADR 0023). The pull request source covers its Issue
	 * references against them and reads the uncovered ones directly, in at
	 * most one extra request.
	 */
	fetch(knownTicketIdentities?: readonly string[]): Promise<FetchOutcome>;
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
        closingIssuesReferences(first: 100) {
          nodes {
            id number title
            labels(first: 100) { nodes { name } }
            repository { name nameWithOwner }
          }
        }
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

	async fetch(knownTicketIdentities: readonly string[] = []): Promise<FetchOutcome> {
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
			// current snapshot: its ticket's stored labels supply the rank.
			// One rule covers the never-seen issue and the issue that left
			// the source: the uncovered ones are read directly (ADR 0023).
			const covered = new Set(knownTicketIdentities);
			const uncovered = deduped.filter(
				(reference) => reference.identity === null || !covered.has(reference.identity),
			);
			if (uncovered.length === 0)
				return {
					status: "success",
					fetchedAt,
					tickets,
					referencedIssueFacts: deduped.map((reference) => ({
						identity: reference.identity as string,
						labels: reference.labels,
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
				if (identity !== null && covered.has(identity)) {
					facts.push({ identity, labels: reference.labels, fetchedAt });
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
	 * The batched direct read (ADR 0023): one GraphQL request per pull request
	 * source refresh that resolves every uncovered Issue reference. It
	 * resolves each reference by its identity when the identity is known, else
	 * by its repository and number. A failure returns the reason: the refresh
	 * still succeeds, with one warning line and the previous facts in place.
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
		const declarations: string[] = [];
		const fields: string[] = [];
		const assignments: string[] = [];
		references.forEach((reference, index) => {
			if (reference.nodeId !== null) {
				declarations.push(`$ref${index}Id: ID!`);
				fields.push(
					`reference${index}: node(id: $ref${index}Id) { ... on Issue { id number title labels(first: 100) { nodes { name } } } }`,
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
				`reference${index}: repository(owner: $ref${index}Owner, name: $ref${index}Name) { issue(number: $ref${index}Number) { id number title labels(first: 100) { nodes { name } } } }`,
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

/** One search page's tickets and the references the pull requests closed. */
type QueryResult =
	| { status: "success"; tickets: FetchedTicket[]; references: SearchReference[] }
	| { status: "failed"; reason: string };

/** One referenced issue as the search response resolves it (ADR 0023). */
type SearchReference = IssueReference & { nodeId: string | null; labels: string[] };

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
 * The references are secondary facts: a reference the response leaves
 * unreadable is skipped, so the readable ones still carry their rank.
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
			labels: labelNamesOf(item.labels) ?? [],
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
	| { ok: true; ticket: FetchedTicket; references: SearchReference[] }
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
	};
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
