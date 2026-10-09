/**
 * Every path `docs/agents/shape.md` names is a path the tree holds.
 *
 * The module map is the file an agent reads first to find where a rule lives,
 * and it is prose, so it drifts in the cheap direction: a module moves or is
 * renamed and the map still points where it used to. The reviews of #229 found
 * the map sending a reader to `queue-staging.ts` for sentences that live in
 * `top-up.ts`, and a verification record naming a symbol the branch had already
 * renamed. A check cannot read whether a sentence describes the right module -
 * that is the doc-claim rule on the quality gate page, and a review measures it.
 * What a check can hold is the shape of the claim: a path the map prints either
 * exists or it does not.
 *
 * Both probes below assert that the text they edit actually changed, because a
 * probe that matches nothing proves nothing: an early version of this file
 * probed `src/state/store.ts`, a path the map never prints, and its "red" was
 * the check passing on an untouched document.
 *
 * The map is read as entries, the way it is written. Each entry opens with the
 * path it describes, and inside that entry a bare file name is relative to the
 * entry's own directory: the `src/state/` entry lists `store.ts` and `graph.ts`,
 * not their full paths. So a token with a slash is resolved against the
 * repository root, and a bare name with a file extension is resolved somewhere
 * under the entry's root. A token that is prose, a command, a key, a package
 * name, or an identifier is not a path claim and is left alone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const docPath = "docs/agents/shape.md";

/** Extensions the map names a file by. A bare token with one of these is a file claim. */
const FILE_EXTENSION = /\.(?:ts|tsx|mjs|cjs|js|json|toml|md|sql|png)$/;

/**
 * Returns whether a backticked token claims a path. Prose ("the Work queue"),
 * a command ("bun run test"), a flag ("--mutate=src/domain/**"), a config key
 * ("ticket-facts"), a package name ("@opentui/core"), and a bare identifier
 * ("writeConfigFile") claim nothing about the tree.
 */
function isPathClaim(token: string): boolean {
	if (token.startsWith("@") || token.startsWith("-") || token.includes(" ")) {
		return false;
	}
	return token.includes("/") || FILE_EXTENSION.test(token);
}

/** The map's entries: each top-level bullet, with the path its first token names. */
function entries(doc: string): { root: string; body: string }[] {
	const found: { root: string; body: string }[] = [];
	for (const block of doc.split("\n- ")) {
		const body = block.startsWith("- ") ? block.slice(2) : block;
		const opener = /^`([^`]+)`/.exec(body);
		if (!opener) {
			continue;
		}
		found.push({ root: opener[1].trim(), body });
	}
	return found;
}

/** Every backticked token in an entry, with trailing sentence punctuation cut. */
function tokens(body: string): string[] {
	const out: string[] = [];
	for (const match of body.matchAll(/`([^`\n]+)`/g)) {
		out.push(match[1].trim().replace(/[.,;:]+$/, ""));
	}
	return out;
}

/** Returns whether a bare file name stands anywhere under a directory. */
function standsUnder(dir: string, name: string): boolean {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (entry === name) {
			return true;
		}
		if (statSync(path).isDirectory() && standsUnder(path, name)) {
			return true;
		}
	}
	return false;
}

/** Every path claim in the map that the tree does not hold, stated per claim. */
function missingPathClaims(doc: string): string[] {
	const missing: string[] = [];
	for (const entry of entries(doc)) {
		for (const token of tokens(entry.body)) {
			if (!isPathClaim(token)) {
				continue;
			}
			const missingClaim = missingPathClaim(entry, token);
			if (missingClaim !== null) missing.push(missingClaim);
		}
	}
	return missing;
}

/** The claim one path token leaves missing, when the tree does not hold it. */
function missingPathClaim(entry: { root: string; body: string }, token: string): string | null {
	if (token.includes("/")) {
		const target = join(repo, token.replace(/\/$/, ""));
		if (!existsSync(target)) {
			return `${token} (entry ${entry.root}) names no file or directory`;
		}
		return null;
	}
	const scope =
		existsSync(join(repo, entry.root)) && statSync(join(repo, entry.root)).isDirectory()
			? join(repo, entry.root)
			: join(repo, "src");
	if (!standsUnder(scope, token)) {
		return `${token} (entry ${entry.root}) stands nowhere under ${scope.replace(`${repo}/`, "")}`;
	}
	return null;
}

describe("the module map names paths the tree holds", () => {
	const doc = readFileSync(join(repo, docPath), "utf8");

	// The check is only worth what it reads, so the run states its own coverage.
	const claims = entries(doc).flatMap((entry) => tokens(entry.body).filter(isPathClaim));

	test("the map states path claims for the check to read", () => {
		expect(claims.length).toBeGreaterThan(60);
	});

	test("every path the map prints exists", () => {
		expect(missingPathClaims(doc)).toEqual([]);
	});

	test("a module path the map moves off is caught here, not by a reader", () => {
		// Probe A, written as steps: in `docs/agents/shape.md`, rename the entry
		// `src/config-write.ts` to `src/config-write-back.ts`. The check goes red
		// with one line naming that path. Re-run here on the map's own text
		// through the same function, so the probe cannot drift from the check.
		const moved = doc.replace("`src/config-write.ts`", "`src/config-write-back.ts`");
		expect(moved).not.toBe(doc);
		expect(missingPathClaims(moved)).toEqual([expect.stringContaining("src/config-write-back.ts")]);
	});

	test("a bare name the map moves off is caught here too", () => {
		// Probe B, written as steps: in the `src/state/` entry, rename `batch.ts`
		// to `chunker.ts`. The bare-name branch resolves it under `src/state/`,
		// finds nothing, and goes red with that one line.
		const moved = doc.replace("`batch.ts` chunks", "`chunker.ts` chunks");
		expect(moved).not.toBe(doc);
		expect(missingPathClaims(moved)).toEqual([
			"chunker.ts (entry src/state/) stands nowhere under src/state/",
		]);
	});
});
