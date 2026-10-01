#!/usr/bin/env bun
/**
 * The Stub run seed (issue #178, ADR 0073).
 *
 * Recreates the Stub run's local checkouts and the world file from scratch,
 * so a walk is repeatable and a broken world is disposable. The target
 * directory is wiped whole: the world file, the checkouts, the state file,
 * and the log file all stand in it, and a fresh walk starts from a fresh
 * directory. Direct hand edits of the world file stay legal between seeds:
 * the seed is the reset, not the editor.
 *
 * The local checkouts are small git repositories, created here, with a bare
 * origin seeded beside them (ADR 0076): the plane's pull request open runs
 * real git, and its push of the factory branch lands on that origin, so the
 * walk keeps the live push step. The worktree base falls back to the
 * checkout's HEAD, the existing rule. The repository identities keep the
 * live host form with the stub owner, so the TUI reads them as ordinary
 * repositories.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { renderStubConfig, stubWorldSeed } from "../src/stub/seed.ts";

const TARGET = process.argv[2] ?? join(homedir(), ".local/share/my-little-software-factory/stub");
const REPOSITORY_NAMES = ["alpha", "beta"];

/**
 * One seeded checkout: a small git repository with a first commit and a
 * bare origin seeded beside it (ADR 0076), the place the plane's pull
 * request open pushes the factory branch.
 */
function createCheckout(path: string, name: string, origin: string): void {
	mkdirSync(path, { recursive: true });
	writeFileSync(
		join(path, "README.md"),
		`# ${name}\n\nThe Stub run's local checkout of the ${name} repository.\n`,
	);
	writeFileSync(join(path, "main.txt"), `the ${name} checkout stands on its first commit\n`);
	const git = (args: string[]) =>
		execFileSync("git", ["-C", path, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	git(["init", "-b", "main"]);
	git(["add", "README.md", "main.txt"]);
	git([
		"-c",
		"user.name=Stub Seeder",
		"-c",
		"user.email=stub@example.com",
		"commit",
		"-m",
		`the ${name} checkout's first commit`,
	]);
	// The bare origin beside the checkout: the plane's push of the factory
	// branch runs real git against it.
	execFileSync("git", ["init", "--bare", origin], { stdio: ["ignore", "pipe", "pipe"] });
	git(["remote", "add", "origin", origin]);
	git(["push", "-u", "origin", "main"]);
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(join(TARGET, "checkouts"), { recursive: true });
mkdirSync(join(TARGET, "origins"), { recursive: true });
for (const name of REPOSITORY_NAMES) {
	createCheckout(join(TARGET, "checkouts", name), name, join(TARGET, "origins", `${name}.git`));
}
writeFileSync(join(TARGET, "world.json"), `${JSON.stringify(stubWorldSeed(), null, 2)}\n`);
writeFileSync(join(TARGET, "config.toml"), renderStubConfig(TARGET));

console.log(`the Stub run stands in ${TARGET}`);
console.log(`  world:   ${join(TARGET, "world.json")}`);
console.log(`  config:  ${join(TARGET, "config.toml")}`);
console.log(
	`  run:     bun src/factory.ts --config ${join(TARGET, "config.toml")} --world ${join(TARGET, "world.json")}`,
);
console.log(`  cli:     bun bin/stub-world.mjs ${join(TARGET, "world.json")} <verb>`);
