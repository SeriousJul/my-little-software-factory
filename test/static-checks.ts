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
 * process's working directory. `keep` narrows the set when a check reads only
 * part of the tree.
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
	return found;
}
