/**
 * The Worktree base's default-branch rule, shared by the ticket and
 * Consultation handoffs (handoff.ts) and the Repository init (ADR 0075).
 *
 * The remote default branch is detected in the order the rule names: the
 * `origin/HEAD` symref, then `origin/main`, then `origin/master`. No config
 * names the branch. The rule answers the branch name, or null when none of
 * the three points at a branch.
 */
import type { CommandRunner } from "./runner.ts";

/**
 * The remote default branch, detected in the order the rule names: the
 * `origin/HEAD` symref, then `origin/main`, then `origin/master`. No config
 * names the branch. Null when none of the three points at a branch.
 */
export async function remoteDefaultBranch(
	checkout: string,
	runner: CommandRunner,
): Promise<string | null> {
	const symref = await runner.run("git", [
		"-C",
		checkout,
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
	]);
	if (symref.code === 0) {
		const target = symref.stdout.trim();
		const branch = target.startsWith("refs/remotes/origin/")
			? target.slice("refs/remotes/origin/".length)
			: "";
		if (branch !== "") return branch;
	}
	for (const candidate of ["main", "master"]) {
		const check = await runner.run("git", [
			"-C",
			checkout,
			"rev-parse",
			"--verify",
			"--quiet",
			`origin/${candidate}^{commit}`,
		]);
		if (check.code === 0) return candidate;
	}
	return null;
}
