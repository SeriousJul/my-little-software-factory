/**
 * The repository resolution tests: the table of paths and remotes, and what
 * the resolver does for each.
 *
 * The filesystem side uses real directories in a temp home; the git side
 * runs through a fake runner, so no test clones anything real. The table:
 *
 * - an explicit mapping wins, and a mapping that holds a different
 *   repository is a hard failure;
 * - the convention path ~/src/<name> holds the same repository: it is used;
 * - the convention path holds a different repository or no verifiable
 *   remote: a sibling clone <name>_1, a warning, and a mapping to write;
 * - a missing path is cloned;
 * - a non-git path fails;
 * - a failed clone fails, and so does a clone target the filesystem
 *   refuses (a file where the parent should be).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config.ts";
import {
	expandHome,
	githubCloneUrl,
	matchesGitHubRepository,
	matchesRepository,
	resolveRepository,
} from "../src/repo.ts";
import { commandFailureText } from "../src/runner.ts";
import { FakeRunner } from "./fake-runner.ts";

const createdDirs: string[] = [];

function tempHome(): string {
	const home = join(tmpdir(), `factory-home-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
	createdDirs.push(home);
	return home;
}

afterAll(() => {
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A git checkout at `dir` whose origin points at the given GitHub repository. */
function checkout(
	home: string,
	dirName: string,
	runner: FakeRunner,
	remote: string | null,
): string {
	const dir = join(home, "src", dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "marker"), "repo");
	runner.set("git", ["-C", dir, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	if (remote !== null) {
		runner.set("git", ["-C", dir, "remote", "get-url", "origin"], { stdout: `${remote}\n` });
	} else {
		runner.set("git", ["-C", dir, "remote", "get-url", "origin"], {
			code: 128,
			stderr: "no remote\n",
		});
	}
	return dir;
}

const configWith = (repos: Record<string, string>): FactoryConfig => ({
	...DEFAULT_CONFIG,
	repos,
});

describe("matchesGitHubRepository", () => {
	test("accepts the common GitHub remote shapes", () => {
		expect(matchesGitHubRepository("https://github.com/acme/billing", "acme/billing")).toBe(true);
		expect(matchesGitHubRepository("https://github.com/acme/billing.git", "acme/billing")).toBe(
			true,
		);
		expect(matchesGitHubRepository("git@github.com:acme/billing", "acme/billing")).toBe(true);
		expect(matchesGitHubRepository("git@github.com:acme/billing.git", "acme/billing")).toBe(true);
	});

	test("a remote with a port, a trailing slash, or other casing still matches", () => {
		expect(matchesGitHubRepository("https://github.com/acme/billing/", "acme/billing")).toBe(true);
		expect(matchesGitHubRepository("https://github.com:443/acme/billing.git", "acme/billing")).toBe(
			true,
		);
		expect(matchesGitHubRepository("HTTPS://GITHUB.COM/ACME/BILLING", "acme/billing")).toBe(true);
		expect(matchesGitHubRepository("ssh://git@github.com:22/acme/billing", "acme/billing")).toBe(
			true,
		);
		expect(matchesGitHubRepository("git@GITHUB.COM:ACME/BILLING.git", "acme/billing")).toBe(true);
	});

	test("a different repository, a null remote, or an unknown shape is not a match", () => {
		expect(matchesGitHubRepository("https://github.com/acme/portal", "acme/billing")).toBe(false);
		expect(matchesGitHubRepository(null, "acme/billing")).toBe(false);
		expect(matchesGitHubRepository("https://gitlab.com/acme/billing.git", "acme/billing")).toBe(
			false,
		);
	});
});

describe("githubCloneUrl and expandHome", () => {
	test("a repository clones from https://github.com/<owner>/<name>.git", () => {
		expect(githubCloneUrl("acme/billing")).toBe("https://github.com/acme/billing.git");
	});

	test("a leading ~ expands to the home, other paths pass through", () => {
		expect(expandHome("~/src/billing", "/home/op")).toBe("/home/op/src/billing");
		expect(expandHome("~", "/home/op")).toBe("/home/op");
		expect(expandHome("/abs/billing", "/home/op")).toBe("/abs/billing");
	});
});

describe("resolveRepository", () => {
	test("a missing convention path is cloned from the GitHub URL", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		expect(outcome.repository.path).toBe(join(home, "src", "billing"));
		expect(outcome.repository.notes).toBeUndefined();
		expect(runner.commands()).toEqual([
			`git clone https://github.com/acme/billing.git ${join(home, "src", "billing")}`,
		]);
		// The resolver creates the parent; the clone itself is git's job.
		expect(existsSync(join(home, "src"))).toBe(true);
	});

	test("a convention path holding the same repository is used", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const dir = checkout(home, "billing", runner, "https://github.com/acme/billing.git");
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome).toMatchObject({ ok: true, repository: { path: dir } });
		expect(runner.calls.filter((c) => c.command === "git").length).toBe(2);
	});

	test("an explicit mapping wins over the convention", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const mapped = checkout(home, "elsewhere", runner, "https://github.com/acme/billing.git");
		const outcome = await resolveRepository(
			"acme/billing",
			configWith({ "acme/billing": "~/src/elsewhere" }),
			{ runner, home },
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.repository.path).toBe(mapped);
		}
	});

	test("an explicit mapping that holds a different repository fails hard", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		checkout(home, "elsewhere", runner, "https://github.com/acme/portal.git");
		const outcome = await resolveRepository(
			"acme/billing",
			configWith({ "acme/billing": "~/src/elsewhere" }),
			{ runner, home },
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toContain("explicit mapping conflict");
			expect(outcome.reason).toContain("acme/portal");
		}
		// The wrong tree is never used: nothing is cloned.
		expect(runner.commands().some((c) => c.startsWith("git clone"))).toBe(false);
	});

	test("an explicit mapping that holds no verifiable remote fails hard", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		checkout(home, "elsewhere", runner, null);
		const outcome = await resolveRepository(
			"acme/billing",
			configWith({ "acme/billing": "~/src/elsewhere" }),
			{ runner, home },
		);
		expect(outcome.ok).toBe(false);
	});

	test("a convention path holding a different repository yields a sibling clone", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		checkout(home, "billing", runner, "https://github.com/acme/portal.git");
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		const sibling = join(home, "src", "billing_1");
		expect(outcome.repository.path).toBe(sibling);
		expect(outcome.repository.notes?.mappingToWrite).toEqual({
			repository: "acme/billing",
			path: sibling,
		});
		expect(outcome.repository.notes?.warning).toContain("acme/portal");
		expect(runner.commands()).toContain(`git clone https://github.com/acme/billing.git ${sibling}`);
	});

	test("a convention path with no verifiable remote yields a sibling clone", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		checkout(home, "billing", runner, null);
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.repository.notes?.warning).toContain("no verifiable origin remote");
		}
	});

	test("a taken sibling is skipped for the next free suffix", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		checkout(home, "billing", runner, null);
		// billing_1 already holds a different repository: the resolver takes billing_2.
		checkout(home, "billing_1", runner, "https://github.com/acme/portal.git");
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.repository.path).toBe(join(home, "src", "billing_2"));
		}
	});

	test("a sibling clone that already holds the same repository is reused, not cloned again", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		checkout(home, "billing", runner, null);
		checkout(home, "billing_1", runner, "https://github.com/acme/billing.git");
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.repository.path).toBe(join(home, "src", "billing_1"));
			expect(outcome.repository.notes?.mappingToWrite).toEqual({
				repository: "acme/billing",
				path: join(home, "src", "billing_1"),
			});
		}
		expect(runner.commands().some((c) => c.startsWith("git clone"))).toBe(false);
	});

	test("a non-git path fails", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const dir = join(home, "src", "billing");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "plain.txt"), "not a repo");
		runner.set("git", ["-C", dir, "rev-parse", "--git-dir"], {
			code: 128,
			stderr: "not a git repository\n",
		});
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toContain("not a git repository");
		}
	});

	test("a failed clone fails with the git error", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		runner.set(
			"git",
			["clone", "https://github.com/acme/billing.git", join(home, "src", "billing")],
			{
				code: 128,
				stderr: "fatal: repository not found\n",
			},
		);
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toContain("clone failed");
			expect(outcome.reason).toContain("repository not found");
		}
	});

	test("a clone target the filesystem refuses fails with a reason", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		// A file where ~/src should be: mkdir cannot create the clone parent.
		writeFileSync(join(home, "src"), "a file");
		const outcome = await resolveRepository("acme/billing", DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reason).toContain("cannot create");
			expect(outcome.reason).toContain(join(home, "src"));
		}
		// The failure is before git: no command ran.
		expect(runner.calls).toHaveLength(0);
	});

	test("a missing parent directory is created for the clone", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const target = join(home, "deep", "nested", "billing");
		const outcome = await resolveRepository(
			"acme/billing",
			configWith({ "acme/billing": target }),
			{ runner, home },
		);
		expect(outcome.ok).toBe(true);
		expect(existsSync(join(home, "deep", "nested"))).toBe(true);
	});
});

describe("host-qualified repository references", () => {
	const gitlabBilling = {
		identity: "gitlab.com/acme/billing",
		displayName: "acme/billing",
		cloneUrl: "https://gitlab.com/acme/billing.git",
	};

	test("a remote matches only against its own host", () => {
		expect(matchesRepository("https://gitlab.com/acme/billing.git", gitlabBilling.identity)).toBe(
			true,
		);
		expect(matchesRepository("git@gitlab.com:acme/billing", gitlabBilling.identity)).toBe(true);
		expect(matchesRepository("https://github.com/acme/billing.git", gitlabBilling.identity)).toBe(
			false,
		);
		expect(matchesRepository(null, gitlabBilling.identity)).toBe(false);
	});

	test("a missing convention path clones from the reference's own clone URL", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const outcome = await resolveRepository(gitlabBilling, DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		// The convention name comes from the display name, not the identity.
		expect(outcome.repository.path).toBe(join(home, "src", "billing"));
		expect(runner.commands()).toEqual([
			`git clone https://gitlab.com/acme/billing.git ${join(home, "src", "billing")}`,
		]);
	});

	test("a mapping keyed by the host-qualified identity wins", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const mapped = checkout(home, "elsewhere", runner, "https://gitlab.com/acme/billing.git");
		const outcome = await resolveRepository(
			gitlabBilling,
			configWith({ "gitlab.com/acme/billing": "~/src/elsewhere" }),
			{ runner, home },
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.repository.path).toBe(mapped);
		}
	});

	test("the same owner/name on another host is a different repository", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		// The convention path holds the github.com twin, not the gitlab.com repository.
		checkout(home, "billing", runner, "https://github.com/acme/billing.git");
		const outcome = await resolveRepository(gitlabBilling, DEFAULT_CONFIG, { runner, home });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		const sibling = join(home, "src", "billing_1");
		expect(outcome.repository.path).toBe(sibling);
		expect(outcome.repository.notes?.warning).toContain("github.com/acme/billing");
		// The mapping written back is keyed by the host-qualified identity.
		expect(outcome.repository.notes?.mappingToWrite).toEqual({
			repository: "gitlab.com/acme/billing",
			path: sibling,
		});
		expect(runner.commands()).toContain(`git clone https://gitlab.com/acme/billing.git ${sibling}`);
	});

	test("a legacy owner/name mapping still resolves a github reference", async () => {
		const home = tempHome();
		const runner = new FakeRunner();
		const mapped = checkout(home, "elsewhere", runner, "https://github.com/acme/billing.git");
		const githubBilling = {
			identity: "github.com/acme/billing",
			displayName: "acme/billing",
			cloneUrl: "https://github.com/acme/billing.git",
		};
		const outcome = await resolveRepository(
			githubBilling,
			configWith({ "acme/billing": "~/src/elsewhere" }),
			{ runner, home },
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.repository.path).toBe(mapped);
		}
	});
});

describe("commandFailureText", () => {
	test("is the first stderr line, or the exit code when stderr is empty", () => {
		expect(
			commandFailureText({ code: 1, stdout: "", stderr: "  fatal: no such file\nmore\n" }),
		).toBe("fatal: no such file");
		expect(commandFailureText({ code: 3, stdout: "", stderr: "" })).toBe("exit code 3");
	});
});
