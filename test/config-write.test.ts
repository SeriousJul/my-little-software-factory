/**
 * The config write-back (ADR 0103).
 *
 * The plane owns two regions of the operator's config file: the `[repos]`
 * table and the `[[sources]]` blocks. A write-back edits those regions and
 * leaves every other byte, the operator's comments and blank-line layout
 * included, where the operator wrote it. A file the edit cannot be trusted on
 * falls back to the full rewrite, and the fallback is named on the Message
 * line.
 *
 * Unit layer only: a config file in a temporary directory, no app, no window
 * manager, no Agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configToToml, type FactoryConfig, loadConfigFile } from "../src/config.ts";
import { configWriteLine, writeConfigFile } from "../src/config-write.ts";
import { BASE_CONFIG } from "./base-config.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function inTempDir(): (path: string) => string {
	const dir = mkdtempSync(join(tmpdir(), "config-write-"));
	tempDirs.push(dir);
	return (path: string) => {
		const full = join(dir, path);
		mkdirSync(join(full, ".."), { recursive: true });
		return full;
	};
}

/**
 * The operator's own file: their comments carry the reasoning behind each
 * choice, a template holds a line that reads like a table header, and the
 * mapping and source blocks stand where the operator put them.
 */
function operatorFile(checkout: string): string {
	return `# The control plane's machine: the states, the task types, and the feeds.
default-agent = "pi"
default-environment = "live-worktree"
default-task-type = "implement"
attention-bell = true
interaction-exit-key = "f12"
max-parallel-agents = 2
agent-poll-interval-seconds = 5
completion-message-lines = 200
max-handoffs-per-ticket = 2

[agents.pi]
kind = "pi"

[scroll]
speed = 1
acceleration = 0.8
maximum-speed = 6

# The checkouts the plane works in. The mapping is the one the plane writes
# back when it discovers a sibling clone.
[repos]
"github.com/acme/factory" = "${checkout}"

# The feed the operator reads by hand: the issues of the one repository.
[[sources]]
name = "acme-issues"
kind = "github-issues"
refresh-interval-seconds = 60
repositories = [ "acme/factory" ]

# The states of the label workflow, in match order.
[[states]]
name = "ready-for-review"
task-type = "review"
[states.match]
source-kind = "github-pull-request"
labels-any = [ "ready-for-review" ]

[[states]]
name = "needs-work"
task-type = "rework"
[states.match]
source-kind = "github-pull-request"
labels-any = [ "needs-work" ]

[task-types.implement]
template = """Implement the following {external-key}: {title}.

[[sources]] is a line of the template's own prose, not a table the file opens.
Repository: {repository}"""

[task-types.review]
template = """Review pull request {external-key}: {title}."""

[task-types.rework]
template = """Rework pull request {external-key}: {title}."""
`;
}

/** Write the operator's file and read it the way startup reads it. */
async function operatorConfig(path: string): Promise<{ config: FactoryConfig; text: string }> {
	const text = readFileSync(path, "utf8");
	const { config } = await loadConfigFile(path);
	return { config, text };
}

function commentLines(text: string): string[] {
	return text.split("\n").filter((line) => line.trim().startsWith("#"));
}

describe("the config write-back (ADR 0103)", () => {
	test("a mapping write keeps every comment line the operator wrote", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config, text } = await operatorConfig(path);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		for (const line of commentLines(text)) {
			expect(written).toContain(line);
		}
		expect(commentLines(written)).toHaveLength(commentLines(text).length);
		// The data still round-trips, and the new mapping stands.
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos).toEqual({
			"github.com/acme/factory": "/home/me/src/factory",
			"github.com/acme/billing": "/home/me/src/billing_1",
		});
	});

	test("a mapping write changes only the line it adds", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config, text } = await operatorConfig(path);

		await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		const before = text.split("\n");
		const after = readFileSync(path, "utf8").split("\n");
		// The one line the write adds stands inside the `[repos]` table, after
		// the mapping the operator wrote. Nothing else in the file moves.
		const at = before.indexOf('"github.com/acme/factory" = "/home/me/src/factory"');
		expect(at).toBeGreaterThan(-1);
		expect(after).toEqual([
			...before.slice(0, at + 1),
			'"github.com/acme/billing" = "/home/me/src/billing_1"',
			...before.slice(at + 1),
		]);
	});

	test("a source write appends its block and leaves the rest of the file byte for byte", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config, text } = await operatorConfig(path);

		const added: FactoryConfig["sources"] = [
			{
				name: "acme/factory-pull-requests",
				kind: "github-pull-requests",
				refreshIntervalSeconds: 300,
				repositories: ["acme/factory"],
				host: "github.com",
			},
		];
		const fact = await writeConfigFile(path, { ...config, sources: [...config.sources, ...added] });

		expect(fact.mode).toBe("sections");
		const before = text.split("\n");
		const after = readFileSync(path, "utf8").split("\n");
		// The only lines the write adds are the appended block and the blank
		// line that separates it, and they stand after the operator's own
		// source block. Every line the operator wrote stands unchanged.
		const block = [
			"",
			"[[sources]]",
			'name = "acme/factory-pull-requests"',
			'kind = "github-pull-requests"',
			"refresh-interval-seconds = 300",
			'repositories = [ "acme/factory" ]',
		];
		const at = before.indexOf('repositories = [ "acme/factory" ]');
		expect(at).toBeGreaterThan(-1);
		expect(after).toEqual([...before.slice(0, at + 1), ...block, ...before.slice(at + 1)]);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.sources.map((source) => source.name)).toEqual([
			"acme-issues",
			"acme/factory-pull-requests",
		]);
	});

	test("a field the loader fills in is not read as an operator edit", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await operatorConfig(path);
		// The file names no host, so the loader stands `github.com` in for the
		// operator's source. A source the plane adds carries its own host the
		// same way. The check compares what the file would say about each side,
		// so a filled-in default does not push the write to a full rewrite.
		expect(config.sources[0].host).toBe("github.com");
		const fact = await writeConfigFile(path, {
			...config,
			sources: [
				...config.sources,
				{
					name: "acme-pull-requests",
					kind: "github-pull-requests",
					refreshIntervalSeconds: 300,
					repositories: ["acme/factory"],
				} as FactoryConfig["sources"][number],
			],
		});

		expect(fact.mode).toBe("sections");
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.sources.map((source) => source.name)).toEqual([
			"acme-issues",
			"acme-pull-requests",
		]);
	});

	test("a write-back that holds nothing new leaves the file alone", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config, text } = await operatorConfig(path);
		const before = statSync(path);

		const fact = await writeConfigFile(path, config);

		expect(fact.mode).toBe("unchanged");
		expect(readFileSync(path, "utf8")).toBe(text);
		expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
		expect(configWriteLine(fact, "registered 1 new source")).toBe("");
	});

	test("a mapping the operator wrote by hand since the load stays in the file", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await operatorConfig(path);
		// The operator adds a mapping while the plane runs. The plane's config
		// never read it, and the write-back owns its own keys, not theirs.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				'github.com/acme/factory" = "/home/me/src/factory"',
				'github.com/acme/factory" = "/home/me/src/factory"\n"github.com/acme/other" = "/home/me/src/other"',
			),
			"utf8",
		);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain('"github.com/acme/other" = "/home/me/src/other"');
		expect(written).toContain('"github.com/acme/billing" = "/home/me/src/billing_1"');
	});

	test("a mapping the plane already holds keeps the line the operator wrote", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		// The operator's own spelling of the key and value.
		writeFileSync(
			path,
			operatorFile("/home/me/src/factory").replace(
				'"github.com/acme/factory" = "/home/me/src/factory"',
				"'github.com/acme/factory' = '/home/me/src/factory'",
			),
			"utf8",
		);
		const { config, text } = await operatorConfig(path);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain("'github.com/acme/factory' = '/home/me/src/factory'");
		expect(written.split("\n").filter((line) => line.includes("acme/factory")).length).toBe(
			text.split("\n").filter((line) => line.includes("acme/factory")).length,
		);
	});

	test("a template line that reads like a table header does not move the edit", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config, text } = await operatorConfig(path);
		// The fixture's implement template holds a `[[sources]]` line inside its
		// prompt. An edit that mistook it for a table would land inside the
		// prompt; the scan reads the string, so it does not.
		expect(text).toContain("[[sources]] is a line of the template's own prose");

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.taskTypes.implement?.template).toBe(config.taskTypes.implement?.template);
		expect(reloaded.sources).toEqual(config.sources);
	});

	test("a file the operator changed under the plane falls back to the full rewrite", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await operatorConfig(path);
		// The operator re-points the feed's kind while the plane runs. The
		// section edit leaves that block alone, so the file no longer carries
		// what the plane holds, and the checker refuses the patch.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace('kind = "github-issues"', 'kind = "github-pull-requests"'),
			"utf8",
		);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("rewrite");
		const written = readFileSync(path, "utf8");
		// The whole file is the plane's own serialization: the data stands, the
		// operator's prose does not.
		expect(written).toBe(
			configToToml({
				...config,
				repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
			}),
		);
		expect(commentLines(written)).toHaveLength(0);
		expect(configWriteLine(fact, "recorded github.com/acme/billing")).toContain(
			"the whole config file was rewritten, and the comments in it did not survive",
		);
	});

	test("a missing file is created by the write", async () => {
		const temp = inTempDir();
		const path = temp("factory/config.toml");

		const fact = await writeConfigFile(path, BASE_CONFIG);

		expect(fact.mode).toBe("created");
		expect(fact.path).toBe(path);
		const { config } = await loadConfigFile(path);
		expect(config).toEqual(BASE_CONFIG);
	});
});

describe("the write-back's Message line (ADR 0103)", () => {
	test("a section edit names the file it wrote", () => {
		const line = configWriteLine(
			{ mode: "sections", path: "/home/me/config.toml" },
			"recorded acme/billing",
		);
		expect(line).toBe("recorded acme/billing in /home/me/config.toml");
	});

	test("a full rewrite says plainly that the comments did not survive", () => {
		const line = configWriteLine(
			{ mode: "rewrite", path: "/home/me/config.toml" },
			"registered 2 new sources",
		);
		expect(line).toBe(
			"registered 2 new sources in /home/me/config.toml; " +
				"the whole config file was rewritten, and the comments in it did not survive",
		);
	});
});
