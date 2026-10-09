/**
 * Every push the control plane builds bypasses the checkout's contributor
 * pre-push hook (ADR 0127).
 *
 * `scripts/git-hooks/pre-push` is active in any checkout that set
 * `core.hooksPath`, and that setting is common to every worktree of the
 * repository. It runs `bun run lint` and `bun run typecheck` on the tree it
 * stands in, so a shared checkout whose dependencies are not installed, or a
 * fresh worktree with no `node_modules` at all, refuses the plane's push. The
 * plane then reports only git's own last line, and the whole factory stops on
 * a check of a tree the plane never pushed.
 *
 * The hook gates a contributor's push of work. The plane's pushes carry its
 * own commits - the pull request hold commit, and a Repository init's first
 * commit - and CI runs the same checks on what lands. So each of the plane's
 * pushes names the bypass at the call site, through the one shared constant.
 *
 * This is a declared dependency rule, not a behavior test: the two behavior
 * seams (`test/handoff.test.ts`, `test/repo-init.test.ts`) pin the argv each
 * flow sends. This file refuses a third push written without the bypass, so
 * the rule cannot be dropped unnoticed, the way the shared-control library
 * check refuses a screen-built field.
 *
 * Two limits, stated so no reader trusts more than it holds: the scan reads a
 * `"push"` token standing in a `"git"` argv, so an argv assembled from pieces
 * and handed to the runner under another name is not read here, and neither is
 * an argv whose arguments before the token close a bracket, such as one that
 * spreads `parts[0]`. The behavior seams own both shapes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sourceFiles } from "./static-checks.ts";

const sources = sourceFiles("src");

/** A git argv that pushes, however its arguments are spread across lines. */
const GIT_PUSH_ARGV = /"git",\s*\[[^\]]*"push"/su;

/** The shared constant every plane push spreads into its argv. */
const PUSH_BYPASS = "BYPASS_CONTRIBUTOR_PUSH_HOOK";

describe("the plane's pushes bypass the contributor pre-push hook", () => {
	test("the scan reads the sources that push today", () => {
		// A check that scans nothing passes forever. The two flows that push
		// must stand in the scanned set.
		for (const required of ["src/handoff.ts", "src/repo-init.ts"]) {
			expect(sources, `${required} must be in the scanned set`).toContain(required);
		}
	});

	test("each source that builds a git push names the bypass", () => {
		const pushing = sources.filter((file) => GIT_PUSH_ARGV.test(readFileSync(file, "utf8")));
		// The set is read, not written down, so a new push lands in it by itself.
		expect(pushing.length).toBeGreaterThan(0);
		for (const file of pushing) {
			expect(
				readFileSync(file, "utf8"),
				`${file} builds a git push, so it must spread ${PUSH_BYPASS} into its argv (ADR 0127)`,
			).toContain(PUSH_BYPASS);
		}
	});

	test("the bypass is one constant, and it is the flag git documents for the pre-push hook", () => {
		const home = readFileSync("src/git-push.ts", "utf8");
		expect(home).toContain(`export const ${PUSH_BYPASS}`);
		expect(home).toContain('"--no-verify"');
		// One flag, named once: a second push flag in the constant would be a
		// second rule standing where the ADR names one.
		expect(home.match(/"--[a-z-]+"/gu)?.filter((flag) => flag !== `"--no-verify"`)).toEqual([]);
	});
});
