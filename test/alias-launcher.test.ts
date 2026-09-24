/**
 * Tests for the `mlsf` alias launcher.
 *
 * The alias holds no install decision: it reads the main package's own bin and
 * re-execs it under Node with the operator's arguments, so `npx mlsf` and
 * `npx my-little-software-factory` are one command. What is its own, and what
 * these tests pin by starting the real file under Node in the directory shape
 * an npm install writes, is how the run ends: the child's exit code reaches the
 * operator unchanged, and a child the signal killed ends the launcher by that
 * signal rather than by a code of its own. The shipped bin does the latter, and
 * a launcher that answers `1` where the bin answers SIGTERM makes the same
 * interrupt mean two things depending on which name was typed.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const ALIAS_BIN = join(REPO_ROOT, "packages", "mlsf", "bin.mjs");

/**
 * A stand-in for the published bin: no network, no cache, and it ends the way
 * the real entry ends when its own child is signalled.
 */
const FAKE_MAIN_BIN = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const mode = process.argv[2];
if (mode === "signal") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 9000)"], { stdio: "inherit" });
  child.on("exit", (_code, signal) => {
    // The shipped bin's own contract: drop the listener so the re-raise takes
    // the default action rather than re-entering a handler.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    process.exit(1);
  });
  setTimeout(() => child.kill("SIGTERM"), 100);
} else {
  process.exit(Number(mode) || 0);
}
`;

/** An install-shaped tree whose `mlsf` is the real alias and whose main bin is the fake. */
function aliasInstallRoot(): { aliasEntry: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "mlsf-alias-"));
	const mainPkg = join(root, "node_modules", "my-little-software-factory");
	mkdirSync(join(mainPkg, "bin"), { recursive: true });
	writeFileSync(
		join(mainPkg, "package.json"),
		JSON.stringify({
			name: "my-little-software-factory",
			version: "0.0.0-test",
			bin: { factory: "./bin/factory-bin.mjs" },
		}),
		"utf8",
	);
	const fakeBin = join(mainPkg, "bin", "factory-bin.mjs");
	writeFileSync(fakeBin, FAKE_MAIN_BIN, "utf8");
	chmodSync(fakeBin, 0o755);
	// The alias resolves the main package from its own location, so it lives
	// inside the same node_modules the operator's install writes.
	const aliasPkg = join(root, "node_modules", "mlsf");
	mkdirSync(aliasPkg, { recursive: true });
	const aliasEntry = join(aliasPkg, "bin.mjs");
	cpSync(ALIAS_BIN, aliasEntry);
	return { aliasEntry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runAlias(aliasEntry: string, argv: string[]) {
	// Node, not Bun: the published launcher runs on the runtime npx provides.
	return spawnSync("node", [aliasEntry, ...argv], { encoding: "utf8", timeout: 60_000 });
}

describe("the alias launcher", () => {
	test("node is on this machine, the runtime the alias runs on", () => {
		expect(spawnSync("node", ["--version"], { encoding: "utf8" }).status).toBe(0);
	});

	test("it starts the main package's own bin with the operator's arguments", () => {
		// The fake main bin answers with the code the argument names, so a run
		// that reaches it with its argument intact answers 3 and nothing else.
		const { aliasEntry, cleanup } = aliasInstallRoot();
		try {
			const result = runAlias(aliasEntry, ["3"]);
			expect(result.status).toBe(3);
			expect(result.stderr).toBe("");
		} finally {
			cleanup();
		}
	});

	test("the child's exit code reaches the operator unchanged", () => {
		const { aliasEntry, cleanup } = aliasInstallRoot();
		try {
			expect(runAlias(aliasEntry, ["7"]).status).toBe(7);
		} finally {
			cleanup();
		}
	});

	test("a child the signal killed ends the alias by that signal, not by a code", () => {
		const { aliasEntry, cleanup } = aliasInstallRoot();
		try {
			const result = runAlias(aliasEntry, ["signal"]);
			// The pre-fix shape kept the signal's JS listener installed, so the
			// re-raise re-entered the handler and the `process.exit(1)` behind it
			// won the race: the same interrupt answered 1 through `npx mlsf` and
			// SIGTERM through `node_modules/.bin/factory`.
			expect(result.signal).toBe("SIGTERM");
			expect(result.status).toBeNull();
		} finally {
			cleanup();
		}
	});
});
