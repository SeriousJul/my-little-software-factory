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
 * - a failed clone fails.
 *
 * Git runs through the command runner (the only exit to the outside world);
 * path existence is plain filesystem work against real directories.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import type { FactoryConfig } from "./config.ts";
import type { CommandResult, CommandRunner } from "./runner.ts";

/** A repository resolved to a checkout path on this machine. */
export interface ResolvedRepository {
	path: string;
	/** A sibling clone was resolved; this mapping belongs in the config. */
	mappingToWrite?: { repository: string; path: string };
	/** A warning worth showing to the operator, if the resolution bent. */
	warning?: string;
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
	repository: string,
	config: FactoryConfig,
	{ runner, home }: ResolutionOptions,
): Promise<RepositoryOutcome> {
	const name = repository.split("/").pop() ?? repository;
	const mapped = config.repos[repository];
	const path = mapped !== undefined ? expandHome(mapped, home) : join(home, "src", name);
	const explicit = mapped !== undefined;

	if (!existsSync(path)) {
		return cloneRepository(repository, path, runner);
	}
	if (!(await isGitRepository(path, runner))) {
		return { ok: false, reason: `${path} is not a git repository` };
	}
	const remote = await originRemoteOf(path, runner);

	if (explicit) {
		if (!matchesGitHubRepository(remote, repository)) {
			const holds = remote === null ? "no origin remote" : `a different repository (${remote})`;
			return {
				ok: false,
				reason: `explicit mapping conflict: ${path} holds ${holds}, not ${repository}`,
			};
		}
		return { ok: true, repository: { path } };
	}

	if (matchesGitHubRepository(remote, repository)) {
		return { ok: true, repository: { path } };
	}

	// A conflicting convention path: the wrong tree is never used. A sibling
	// clone takes the work, and the mapping is written back so the next
	// handoff is explicit.
	const warning =
		remote === null
			? `~/src/${name} has no verifiable origin remote; cloned ${repository} to a sibling`
			: `~/src/${name} holds ${remote}, not ${repository}; cloned ${repository} to a sibling`;
	const sibling = await findSiblingClone(repository, name, home, runner);
	if (!sibling.ok) {
		return sibling;
	}
	return {
		ok: true,
		repository: {
			path: sibling.path,
			mappingToWrite: { repository, path: sibling.path },
			warning,
		},
	};
}

/**
 * The first usable sibling clone under ~/src: <name>_1, then _2, ...
 *
 * A candidate that is missing is cloned. A candidate that already holds the
 * same repository is reused, so a retry after a crash never clones again.
 * A candidate that holds something else is skipped for the next suffix.
 */
async function findSiblingClone(
	repository: string,
	name: string,
	home: string,
	runner: CommandRunner,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
	for (let suffix = 1; ; suffix += 1) {
		const candidate = join(home, "src", `${name}_${suffix}`);
		if (!existsSync(candidate)) {
			return cloneRepository(repository, candidate, runner).then((outcome) =>
				outcome.ok
					? { ok: true as const, path: candidate }
					: { ok: false as const, reason: outcome.reason },
			);
		}
		if (
			(await isGitRepository(candidate, runner)) &&
			matchesGitHubRepository(await originRemoteOf(candidate, runner), repository)
		) {
			return { ok: true, path: candidate };
		}
	}
}

/** Clone a GitHub repository into `path`, creating parent directories. */
function cloneRepository(
	repository: string,
	path: string,
	runner: CommandRunner,
): Promise<RepositoryOutcome> {
	mkdirSync(dirname(path), { recursive: true });
	return runner.run("git", ["clone", githubCloneUrl(repository), path]).then((result) => {
		if (result.code !== 0) {
			return {
				ok: false as const,
				reason: `clone failed for ${repository}: ${commandFailureText(result)}`,
			};
		}
		return { ok: true as const, repository: { path } };
	});
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
 * Accepts the common GitHub remote shapes: https, ssh, and the scp-style
 * git@github.com:owner/name, with or without a .git suffix. A URL that is
 * not a parseable GitHub remote is unverifiable, not a match.
 */
export function matchesGitHubRepository(remote: string | null, repository: string): boolean {
	if (remote === null) {
		return false;
	}
	const forms = [
		`https://github.com/${repository}`,
		`https://github.com/${repository}.git`,
		`git@github.com:${repository}`,
		`git@github.com:${repository}.git`,
		`ssh://git@github.com/${repository}`,
		`ssh://git@github.com/${repository}.git`,
	];
	return forms.includes(remote);
}

/** The first line of a failed command's stderr, trimmed. */
export function commandFailureText(result: CommandResult): string {
	if (result.stderr !== "") {
		const line = result.stderr
			.split("\n")
			.map((part) => part.trim())
			.find((part) => part !== "");
		if (line !== undefined) {
			return line;
		}
	}
	return `exit code ${result.code}`;
}

/**
 * The real path of a checkout when it exists, for comparing against the
 * checkout path herdr records on a workspace (a symlinked checkout must
 * still match the workspace it already has).
 */
export function realPathOf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}
