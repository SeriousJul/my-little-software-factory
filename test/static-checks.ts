/**
 * The shared walker for the static architecture checks.
 *
 * A declared dependency rule reads the plane's own sources, and two checks
 * need the same set: every TypeScript file under a directory. The copy lives
 * here so a check cannot drift from the others by walking something else.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every TypeScript source file under `directory`, as paths relative to the
 * process's working directory, in path order. `keep` narrows the set when a
 * check reads only part of the tree.
 *
 * The list is sorted because `readdirSync` answers in the order the filesystem
 * holds the entries, and that order is not the same in a git checkout as on a
 * developer's disk. A check that compares a walked set against a written list
 * would then pass on one machine and fail on the other: measured here, the
 * grouped-list check in `test/shared-control-architecture.test.ts` passed in
 * this worktree and failed in the CI checkout on the same commit.
 */
export function sourceFiles(
	directory: string,
	keep: (file: string) => boolean = () => true,
): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourceFiles(path, keep));
			continue;
		}
		if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			const rel = relative(process.cwd(), path);
			if (keep(rel)) found.push(rel);
		}
	}
	return found.sort();
}
