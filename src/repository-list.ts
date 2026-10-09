/**
 * The repository list: the one read the init's select list stands on
 * (ADR 0082).
 *
 * The read is one GitHub GraphQL query on the authenticated `gh` identity:
 * the user's own repositories and the repositories of each organization the
 * user belongs to, newest first. The list is a selection input, not a source:
 * nothing here persists, and the plane carries the operator's choice to the
 * checkout resolution and the init's planning it already runs.
 *
 * The query reads through the same command shape the ticket sources use
 * (`gh api graphql --hostname <host>`) on the ambient `gh` identity, the
 * identity the operator logs in to work (ADR 0082): the plane asks no
 * credential of its own, and the read stands on whatever account `gh` holds.
 */
import { type CommandRunner, commandFailureText } from "./runner.ts";

/** One repository the operator can init, normalized to the plane's facts. */
export interface InitableRepository {
	/** The canonical repository identity: the host, owner, and name, lowercase. */
	identity: string;
	/** The owner/name form the sources and the init fact name. */
	displayName: string;
	/** The owner account, as GitHub holds it. */
	owner: string;
	/** The repository name, as GitHub holds it. */
	name: string;
	/** The HTML URL GitHub holds for the repository. */
	htmlUrl: string;
}

/** The read's one answer: the choices, or the line that refuses them. */
export type RepositoryListOutcome =
	| { status: "success"; repositories: readonly InitableRepository[] }
	| { status: "failed"; reason: string };

/**
 * The viewer query: the user's repositories first, then each organization's.
 *
 * The caps bound the read to one call: one hundred repositories per account,
 * twenty organizations, and the order is the API's, newest first, so the list
 * the operator sees starts at the repositories they work on.
 */
export const VIEWER_REPOSITORIES_QUERY = `query FactoryInitableRepositories {
	viewer {
		login
		repositories(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
			nodes { name nameWithOwner url }
		}
		organizations(first: 20) {
			nodes {
				login
				repositories(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
					nodes { name nameWithOwner url }
				}
			}
		}
	}
}`;

/** The one read: the operator's own repositories and their organizations'. */
export async function listInitableRepositories(
	runner: CommandRunner,
	host: string,
): Promise<RepositoryListOutcome> {
	try {
		const args = ["api", "graphql", "--hostname", host, "-f", `query=${VIEWER_REPOSITORIES_QUERY}`];
		const result = await runner.run("gh", args);
		if (result.code !== 0)
			return { status: "failed", reason: `GitHub request failed: ${commandFailureText(result)}` };
		return parseViewerRepositories(result.stdout, host);
	} catch (error) {
		// A list bug must not terminate the control plane, and the message
		// never carries auth values: the string is the error only.
		return {
			status: "failed",
			reason: `unexpected repository list failure: ${readableError(error)}`,
		};
	}
}

/** The repositories one organization node of the viewer answer carries, added through `add`. */
function parseViewerOrganizations(
	organizations: unknown,
	add: (nodes: unknown, where: string) => string | undefined,
): string | undefined {
	if (organizations === undefined) return undefined;
	if (!Array.isArray(organizations)) return "GitHub returned no organization list";
	for (const org of organizations) {
		const login = stringOf((org as Record<string, unknown>)?.login) ?? "an organization";
		const failure = add(
			((org as Record<string, unknown>)?.repositories as { nodes?: unknown } | undefined)?.nodes,
			`the organization ${login}`,
		);
		if (failure !== undefined) return failure;
	}
	return undefined;
}

/** The string one thrown error states, in one line. */
function readableError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The viewer answer, or the line that refuses it.
 *
 * Version-manager shims can print a one-line activation notice before gh's
 * JSON, the way the ticket sources already allow: the parse keeps the value
 * from the first brace and is strict about it.
 */
export function parseViewerRepositories(text: string, host: string): RepositoryListOutcome {
	let raw: unknown;
	const json = text.slice(text.indexOf("{"));
	try {
		raw = JSON.parse(json);
	} catch {
		return { status: "failed", reason: "GitHub returned invalid JSON" };
	}
	const data = raw as {
		data?: { viewer?: { repositories?: unknown; organizations?: unknown } | null };
		errors?: Array<{ message?: unknown }>;
	};
	if (Array.isArray(data.errors) && data.errors.length > 0)
		return {
			status: "failed",
			reason: `GitHub API error: ${String(data.errors[0].message ?? "unknown error")}`,
		};
	const viewer = data.data?.viewer;
	if (viewer === undefined || viewer === null)
		return { status: "failed", reason: "GitHub returned an unreadable account answer" };
	const repositories: InitableRepository[] = [];
	const seen = new Set<string>();
	const add = (nodes: unknown, where: string): string | undefined => {
		if (!Array.isArray(nodes)) return `GitHub returned no repository list for ${where}`;
		for (const node of nodes) {
			const item = parseRepositoryNode(node, host);
			if (item === undefined) return `GitHub returned an unreadable repository in ${where}`;
			if (seen.has(item.identity)) continue;
			seen.add(item.identity);
			repositories.push(item);
		}
		return undefined;
	};
	const own = add((viewer.repositories as { nodes?: unknown } | undefined)?.nodes, "the account");
	if (own !== undefined) return { status: "failed", reason: own };
	const organizations = (viewer.organizations as { nodes?: unknown } | undefined)?.nodes;
	const failure = parseViewerOrganizations(organizations, add);
	if (failure !== undefined) return { status: "failed", reason: failure };
	return { status: "success", repositories };
}

/** One repository node, or undefined when a fact is missing. */
function parseRepositoryNode(node: unknown, host: string): InitableRepository | undefined {
	const record = node as Record<string, unknown> | null;
	const name = stringOf(record?.name);
	const nameWithOwner = stringOf(record?.nameWithOwner);
	const url = stringOf(record?.url);
	if (name === undefined || nameWithOwner === undefined || url === undefined) return undefined;
	const slash = nameWithOwner.lastIndexOf("/");
	if (slash <= 0) return undefined;
	const owner = nameWithOwner.slice(0, slash);
	return {
		identity: `${host.toLowerCase()}/${nameWithOwner.toLowerCase()}`,
		displayName: nameWithOwner,
		owner,
		name,
		htmlUrl: url,
	};
}

/** A string, or undefined for anything that is not one. */
function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
