/**
 * Repository resolution: where on this machine a ticket's repository lives.
 *
 * A ticket carries its repository as "owner/name". Resolution finds a local
 * checkout for it:
 *
 * 1. An explicit config mapping wins. A mapped path holding a different
 *    repository is a hard failure: the wrong tree is never used.
 * 2. Then the convention ~/src/<name> (name is the last segment).
 *
 * A candidate path is verified by comparing the GitHub remote of the
 * checkout against the repository's owner/name. The outcomes:
 *
 * - a missing path is cloned;
 * - the same repository is used;
 * - a different repository or an unverifiable remote (convention only)
 *   yields a warning, a sibling clone <name>_1 (or the next free suffix),
 *   and an explicit mapping written back into the config;
 * - a non-git path fails;
 * - a failed clone fails, and so does a clone target the filesystem
 *   refuses (a read-only home, a file where the parent should be).
 *
 * Git runs through the command runner (the only exit to the outside world);
 * path existence is plain filesystem work against real directories.
 */
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FactoryConfig } from "./config.ts";
import type { RepositoryRef } from "./domain/ticket.ts";
import { fileExists } from "./fs.ts";
import { type CommandRunner, commandFailureText, errorMessage } from "./runner.ts";

/** An explicit repository mapping: a GitHub repository pinned to a checkout path. */
export interface RepositoryMapping {
	repository: string;
	path: string;
}

/**
 * The note the repository resolution carries with its result: a warning
 * worth showing to the operator and, when the resolution bent to a sibling
 * clone, the mapping to persist into the config.
 *
 * The two travel together through every handoff outcome, so they are one
 * type and a failure of a later step still carries both.
 */
export interface ResolutionNotes {
	/** A warning worth showing to the operator, if the resolution bent. */
	warning?: string;
	/** A sibling clone was resolved; this mapping belongs in the config. */
	mappingToWrite?: RepositoryMapping;
}

/** A repository resolved to a checkout path on this machine. */
export interface ResolvedRepository {
	path: string;
	/** The note the resolution bent with, if it bent at all. */
	notes?: ResolutionNotes;
}

export type RepositoryOutcome =
	| { ok: true; repository: ResolvedRepository }
	| { ok: false; reason: string };

interface ResolutionOptions {
	runner: CommandRunner;
	/** The home directory the ~/src convention resolves under. */
	home: string;
}

/** Resolve the checkout for one repository, cloning when it is missing. */
export async function resolveRepository(
	repository: string | RepositoryRef,
	config: FactoryConfig,
	{ runner, home }: ResolutionOptions,
): Promise<RepositoryOutcome> {
	const reference = repositoryReference(repository);
	const name = reference.displayName.split("/").pop() ?? reference.displayName;
	// The short legacy key is accepted for current installations. New source
	// data writes the host-qualified identity only.
	const mapped = config.repos[reference.mappingKey] ?? config.repos[reference.displayName];
	const path = mapped !== undefined ? expandHome(mapped, home) : join(home, "src", name);
	const explicit = mapped !== undefined;

	if (!(await fileExists(path))) return cloneRepositoryReference(reference, path, runner);
	if (!(await isGitRepository(path, runner)))
		return { ok: false, reason: `${path} is not a git repository` };
	const remote = await originRemoteOf(path, runner);
	if (explicit) {
		if (!matchesRepository(remote, reference.identity)) {
			const holds = remote === null ? "no origin remote" : `a different repository (${remote})`;
			return {
				ok: false,
				reason: `explicit mapping conflict: ${path} holds ${holds}, not ${reference.displayName}`,
			};
		}
		return { ok: true, repository: { path } };
	}
	if (matchesRepository(remote, reference.identity)) return { ok: true, repository: { path } };
	const warning =
		remote === null
			? `~/src/${name} has no verifiable origin remote; cloned ${reference.displayName} to a sibling`
			: `~/src/${name} holds ${remote}, not ${reference.displayName}; cloned ${reference.displayName} to a sibling`;
	const sibling = await findSiblingCloneReference(reference, name, home, runner);
	if (!sibling.ok) return sibling;
	return {
		ok: true,
		repository: {
			path: sibling.path,
			notes: { mappingToWrite: { repository: reference.mappingKey, path: sibling.path }, warning },
		},
	};
}

interface RepositoryReference {
	identity: string;
	displayName: string;
	cloneUrl: string;
	/** The key a new sibling clone writes to config. */
	mappingKey: string;
}

function repositoryReference(repository: string | RepositoryRef): RepositoryReference {
	if (typeof repository !== "string") {
		return {
			identity: repository.identity.toLowerCase(),
			displayName: repository.displayName,
			cloneUrl: repository.cloneUrl,
			mappingKey: repository.identity,
		};
	}
	return {
		identity: `github.com/${repository}`.toLowerCase(),
		displayName: repository,
		cloneUrl: githubCloneUrl(repository),
		mappingKey: repository,
	};
}

async function findSiblingCloneReference(
	repository: RepositoryReference,
	name: string,
	home: string,
	runner: CommandRunner,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
	for (let suffix = 1; ; suffix += 1) {
		const candidate = join(home, "src", `${name}_${suffix}`);
		if (!(await fileExists(candidate))) {
			const outcome = await cloneRepositoryReference(repository, candidate, runner);
			return outcome.ok ? { ok: true, path: candidate } : { ok: false, reason: outcome.reason };
		}
		if (
			(await isGitRepository(candidate, runner)) &&
			matchesRepository(await originRemoteOf(candidate, runner), repository.identity)
		)
			return { ok: true, path: candidate };
	}
}

async function cloneRepositoryReference(
	repository: RepositoryReference,
	path: string,
	runner: CommandRunner,
): Promise<RepositoryOutcome> {
	try {
		await mkdir(dirname(path), { recursive: true });
	} catch (error) {
		return { ok: false, reason: `cannot create ${dirname(path)}: ${errorMessage(error)}` };
	}
	const result = await runner.run("git", ["clone", repository.cloneUrl, path]);
	if (result.code !== 0)
		return {
			ok: false,
			reason: `clone failed for ${repository.displayName}: ${commandFailureText(result)}`,
		};
	return { ok: true, repository: { path } };
}

/** The GitHub URL a repository clones from. */
export function githubCloneUrl(repository: string): string {
	return `https://github.com/${repository}.git`;
}

/** Expand a leading ~ in a path to the home directory. */
export function expandHome(path: string, home: string): string {
	if (path === "~") {
		return home;
	}
	if (path.startsWith("~/")) {
		return join(home, path.slice(2));
	}
	return path;
}

/** Whether a path is inside a git repository, asked through git itself. */
async function isGitRepository(path: string, runner: CommandRunner): Promise<boolean> {
	const result = await runner.run("git", ["-C", path, "rev-parse", "--git-dir"]);
	return result.code === 0;
}

/** The URL of the origin remote, or null when it cannot be read. */
async function originRemoteOf(path: string, runner: CommandRunner): Promise<string | null> {
	const result = await runner.run("git", ["-C", path, "remote", "get-url", "origin"]);
	if (result.code !== 0) {
		return null;
	}
	const url = result.stdout.trim();
	return url === "" ? null : url;
}

/**
 * Whether a remote URL points at the given repository on GitHub.
 *
 * The URL is normalized before the compare, so the common GitHub remote
 * shapes all match: https and ssh, the scp-style git@github.com:owner/name,
 * with or without a .git suffix, a port, a trailing slash, or other
 * casing. A URL that is not a parseable GitHub remote is unverifiable, not
 * a match.
 */
export function matchesGitHubRepository(remote: string | null, repository: string): boolean {
	return matchesRepository(remote, `github.com/${repository}`);
}

/** Match a remote against a host-qualified repository identity. */
export function matchesRepository(remote: string | null, identity: string): boolean {
	if (remote === null) return false;
	const expected = normalizeRemote(`https://${identity}`);
	const actual = normalizeRemote(remote);
	return actual !== null && actual === expected;
}

/**
 * The normalized form of a remote: the lowercased host plus the lowercased
 * repository path, with the port, a .git suffix, and leading and trailing
 * slashes dropped. Null when the URL is not a parseable remote.
 */
function normalizeRemote(url: string): string | null {
	let host = "";
	let path = "";
	// The scp-style form (git@github.com:owner/name) is not a URL, so it is
	// split by hand before the URL parse.
	const scp = url.match(/^[^@/]+@([^/:]+):(.+)$/);
	if (scp !== null) {
		host = scp[1];
		path = scp[2];
	} else {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		host = parsed.hostname;
		path = parsed.pathname;
	}
	host = host.toLowerCase();
	if (host === "") return null;
	path = path
		.toLowerCase()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/, "");
	return `${host}/${path}`;
}

/**
 * The real path of a checkout when it exists, for comparing against the
 * checkout path herdr records on a workspace (a symlinked checkout must
 * still match the workspace it already has).
 */
export async function realPathOf(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}
