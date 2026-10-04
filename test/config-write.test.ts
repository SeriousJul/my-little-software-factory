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
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configToToml, type FactoryConfig, loadConfigFile } from "../src/config.ts";
import {
	type ConfigWriteMode,
	configWriteLine,
	writeConfigFile,
	writeFactWithConfirmation,
} from "../src/config-write.ts";
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

/**
 * How many blank lines stand directly above the last `[[sources]]` header the
 * file holds - the block the plane wrote last.
 */
function blankLinesAboveTheLastBlock(lines: string[]): number {
	const at = lines.lastIndexOf("[[sources]]");
	expect(at).toBeGreaterThan(-1);
	let count = 0;
	while (at - 1 - count >= 0 && lines[at - 1 - count].trim() === "") count += 1;
	return count;
}

/** A source a Repository init would register for the operator's one repository. */
function pullRequestSource(): FactoryConfig["sources"][number] {
	return {
		name: "acme/factory-pull-requests",
		kind: "github-pull-requests",
		refreshIntervalSeconds: 300,
		repositories: ["acme/factory"],
		host: "github.com",
	};
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

	test("a config file the plane cannot read is not read as a missing file", async () => {
		const temp = inTempDir();
		const dir = temp("factory");
		const path = join(dir, "config.toml");
		// A directory where the operator's file stands. The read fails, but not
		// for the reason that means "nothing of the operator's stands here to
		// lose", so the write reports it instead of landing a fresh file.
		mkdirSync(path, { recursive: true });

		await expect(writeConfigFile(path, BASE_CONFIG)).rejects.toThrow(/EISDIR/u);
		expect(statSync(path).isDirectory()).toBe(true);
		expect(readdirSync(dir)).toEqual(["config.toml"]);
	});

	test("the plane's own empty-sources form keeps its comments through a source append", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		// The form the plane's own serializer used to write for no sources: a
		// `sources = []` key. A `[[sources]]` block cannot stand beside a key of
		// that name, so the edit drops the key it wrote and appends the blocks it
		// registers at the end of the file. The operator's prose stays.
		const text = operatorFile("/home/me/src/factory")
			.replace(
				[
					"# The feed the operator reads by hand: the issues of the one repository.",
					"[[sources]]",
					'name = "acme-issues"',
					'kind = "github-issues"',
					"refresh-interval-seconds = 60",
					'repositories = [ "acme/factory" ]',
				].join("\n"),
				"",
			)
			.replace(
				"max-handoffs-per-ticket = 2",
				[
					"# The feed list, empty until the operator picks one.",
					"sources = []",
					"max-handoffs-per-ticket = 2",
				].join("\n"),
			);
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);
		expect(config.sources).toEqual([]);

		const fact = await writeConfigFile(path, {
			...config,
			sources: [
				{
					name: "acme/factory-pull-requests",
					kind: "github-pull-requests",
					refreshIntervalSeconds: 300,
					repositories: ["acme/factory"],
					host: "github.com",
				},
			],
		});

		expect(fact.mode).toBe("sections");
		const before = text.split("\n");
		const after = readFileSync(path, "utf8").split("\n");
		const at = before.indexOf("sources = []");
		expect(at).toBeGreaterThan(-1);
		// The key line is gone, every other line the operator wrote stands, and
		// the blocks the plane registered land at the end of the file: a table
		// cannot open in the middle of the file's top-level keys.
		expect(after).toEqual([
			...before.slice(0, at),
			// The operator's own lines, without the empty element the split yields
			// for the file's final newline.
			...before.slice(at + 1, -1),
			// One blank line, the same separator an in-region insert writes.
			"",
			"[[sources]]",
			'name = "acme/factory-pull-requests"',
			'kind = "github-pull-requests"',
			"refresh-interval-seconds = 300",
			'repositories = [ "acme/factory" ]',
			"",
		]);
		expect(commentLines(readFileSync(path, "utf8"))).toHaveLength(commentLines(text).length);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.sources.map((source) => source.name)).toEqual(["acme/factory-pull-requests"]);
	});

	test("a new mapping key lands after the commented line it follows", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(
			path,
			operatorFile("/home/me/src/factory").replace(
				'"github.com/acme/factory" = "/home/me/src/factory"',
				'"github.com/acme/factory" = "/home/me/src/factory" # the one checkout I keep',
			),
			"utf8",
		);
		const { config, text } = await operatorConfig(path);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const before = text.split("\n");
		const after = readFileSync(path, "utf8").split("\n");
		// The new key lands after the whole commented line: the plane does not
		// drive a wedge between a key and the note written beside it.
		const at = before.indexOf(
			'"github.com/acme/factory" = "/home/me/src/factory" # the one checkout I keep',
		);
		expect(at).toBeGreaterThan(-1);
		expect(after).toEqual([
			...before.slice(0, at + 1),
			'"github.com/acme/billing" = "/home/me/src/billing_1"',
			...before.slice(at + 1),
		]);
	});

	test("a rewritten mapping line keeps the comment the operator wrote beside it", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(
			path,
			operatorFile("/home/me/src/factory").replace(
				'"github.com/acme/factory" = "/home/me/src/factory"',
				'"github.com/acme/factory" = "/home/me/src/factory" # the checkout I keep for the plane',
			),
			"utf8",
		);
		const { config } = await loadConfigFile(path);

		// The plane re-points the key it owns: the value changes, the prose does not.
		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/factory": "/home/me/src/factory_2" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain(
			'"github.com/acme/factory" = "/home/me/src/factory_2" # the checkout I keep for the plane',
		);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos["github.com/acme/factory"]).toBe("/home/me/src/factory_2");
	});

	test("the file mode follows the config the file carries, not the caller's copy", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(path);
		const text = readFileSync(path, "utf8");
		// The plane's own copy holds no literal token, so it would ask for 0644.
		expect(config.sources.every((source) => source.auth?.token === undefined)).toBe(true);
		// The operator adds a source block with a literal token while the plane
		// runs. The write-back leaves that block alone, so the file it lands on
		// carries a token the caller never held, and it lands 0600 (ADR 0103).
		writeFileSync(
			path,
			`${text}\n[[sources]]\nname = "acme-security"\nkind = "github-pull-requests"\nrefresh-interval-seconds = 600\nrepositories = [ "acme/factory" ]\n[sources.auth]\ntoken = "ghp_the_operator_wrote_this_by_hand"\n`,
			"utf8",
		);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const written = readFileSync(path, "utf8");
		expect(written).toContain('token = "ghp_the_operator_wrote_this_by_hand"');
		expect(commentLines(written)).toHaveLength(commentLines(text).length);
	});

	test("a config file the operator locked to 0600 keeps that lock", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		chmodSync(path, 0o600);
		const { config } = await loadConfigFile(path);
		// The plane's own copy holds no literal token, so the text it lands would
		// ask for the ordinary mode. The lock the file carries is stricter, and the
		// plane cannot see why the operator set it, so the write keeps it (ADR 0103).
		expect(config.sources.every((source) => source.auth?.token === undefined)).toBe(true);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		expect(statSync(path).mode & 0o777).toBe(0o600);

		// The same rule on the fallback path. The operator re-points a held source
		// block, the checker refuses the patch, and the whole-file rewrite lands on
		// the locked file at the locked mode.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace('kind = "github-issues"', 'kind = "github-pull-requests"'),
			"utf8",
		);
		const rewritten = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/factory": "/home/me/src/factory_2" },
		});
		expect(rewritten.mode).toBe("rewrite");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("a file that ends its lines CRLF is edited in place and stays CRLF", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		const text = operatorFile("/home/me/src/factory").replaceAll("\n", "\r\n");
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain('"github.com/acme/billing" = "/home/me/src/billing_1"\r\n');
		// Every line the file held still stands, with the ending it had.
		const after = written.split("\r\n");
		for (const line of text.split("\r\n")) {
			expect(after).toContain(line);
		}
		// Every real line in a CRLF file carries its `\r`. The last element the
		// split yields is the artifact of the file's own final line ending, not a
		// line. A blank line the plane wrote with no ending fails this read.
		const rows = written.split("\n");
		expect(rows.at(-1)).toBe("");
		expect(rows.slice(0, -1).filter((line) => !line.endsWith("\r"))).toEqual([]);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos["github.com/acme/billing"]).toBe("/home/me/src/billing_1");
	});

	test("a raw multiline string and an escaped quote do not move the edit", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		// Two string forms the scan has to read through: a literal multiline
		// string whose prose holds a table header, a hash, and a quote, and a
		// basic string whose value carries an escaped quote and a header.
		const text = operatorFile("/home/me/src/factory")
			.replace(
				'template = """Review pull request {external-key}: {title}."""',
				[
					"template = '''Review prose.",
					"",
					"[[repos]] is a line of this prompt, not a table the file opens.",
					'It holds a " quote and a # hash.',
					"''' # the operator's note about the prompt",
				].join("\n"),
			)
			.replace(
				'template = """Rework pull request {external-key}: {title}."""',
				'template = "Rework \\" {external-key} \\" and a [[sources]] line that is prose."',
			);
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		// The new key landed in the plane's own table, not inside either prompt.
		const at = written.split("\n").indexOf('"github.com/acme/billing" = "/home/me/src/billing_1"');
		expect(at).toBeGreaterThan(written.split("\n").indexOf("[repos]"));
		expect(written).toContain("[[repos]] is a line of this prompt, not a table the file opens.");
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.taskTypes.review?.template).toBe(config.taskTypes.review?.template);
		expect(reloaded.taskTypes.rework?.template).toBe(config.taskTypes.rework?.template);
		expect(reloaded.sources).toEqual(config.sources);
	});

	test("a source append on a CRLF file gives its blank separator the same ending", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		const text = operatorFile("/home/me/src/factory").replaceAll("\n", "\r\n");
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);

		const fact = await writeConfigFile(path, {
			...config,
			sources: [...config.sources, pullRequestSource()],
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		// The blank line the plane inserts between the operator's last block and
		// its own is a line the plane writes, so it carries the file's ending too.
		const rows = written.split("\n");
		expect(rows.at(-1)).toBe("");
		expect(rows.slice(0, -1).filter((line) => !line.endsWith("\r"))).toEqual([]);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.sources.map((source) => source.name)).toEqual([
			"acme-issues",
			"acme/factory-pull-requests",
		]);
	});

	test("a mapping-shaped line inside an operator's multiline string stays their prose", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		// The operator wrote one mapping value as a multiline string, and its
		// prose carries a line that reads exactly like a mapping the plane holds.
		// The scan knows the line stands inside a string, so the edit leaves the
		// prose alone and the file keeps its comments instead of falling back to
		// the full rewrite.
		const text = operatorFile("/home/me/src/factory").replace(
			'"github.com/acme/factory" = "/home/me/src/factory"',
			[
				'"github.com/acme/factory" = """',
				"Why this checkout sits here, in the operator's own words.",
				'"github.com/acme/billing" = not-a-mapping',
				'"""',
			].join("\n"),
		);
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);
		expect(typeof config.repos["github.com/acme/factory"]).toBe("string");

		const fact = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain('"github.com/acme/billing" = not-a-mapping');
		expect(written).toContain('"github.com/acme/billing" = "/home/me/src/billing_1"');
		expect(commentLines(written)).toHaveLength(commentLines(text).length);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.taskTypes.implement?.template).toBe(config.taskTypes.implement?.template);
		expect(reloaded.sources).toEqual(config.sources);
	});

	test("a file with no [repos] table gets the table the plane writes at its end", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		const text = operatorFile("/home/me/src/factory")
			.replace(
				[
					"# The checkouts the plane works in. The mapping is the one the plane writes",
					"# back when it discovers a sibling clone.",
					"[repos]",
					'"github.com/acme/factory" = "/home/me/src/factory"',
					"",
				].join("\n"),
				"",
			)
			.replaceAll("\n\n\n", "\n\n");
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);
		expect(config.repos).toEqual({});

		const fact = await writeConfigFile(path, {
			...config,
			repos: { "github.com/acme/billing": "/home/me/src/billing_1" },
		});

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(
			written.endsWith('[repos]\n"github.com/acme/billing" = "/home/me/src/billing_1"\n'),
		).toBe(true);
		expect(commentLines(written)).toHaveLength(commentLines(text).length);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos).toEqual({ "github.com/acme/billing": "/home/me/src/billing_1" });
		expect(reloaded.sources).toEqual(config.sources);
	});

	test("a [sources] table instead of blocks falls back to the full rewrite", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(path);
		// The operator turned the source array-of-tables into a `[sources]` table
		// while the plane ran. The startup loader refuses that shape, so the plane
		// can only meet it mid-run, and the section edit refuses it the same way:
		// an edit beside that table could land inside it.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				["[[sources]]", 'name = "acme-issues"', 'kind = "github-issues"'].join("\n"),
				["[sources]", 'name = "acme-issues"', 'kind = "github-issues"'].join("\n"),
			),
			"utf8",
		);

		const fact = await writeConfigFile(path, config);

		expect(fact.mode).toBe("rewrite");
		expect(readFileSync(path, "utf8")).toBe(configToToml(config));
		expect(configWriteLine(fact, "saved the mapping")).toContain("did not survive");
	});

	test("a [[sources]] block that names no name falls back to the full rewrite", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(path);
		// The startup loader refuses a source block with no name. Mid-run the
		// plane can meet one, and it cannot tell which source that block stands
		// for, so it refuses to edit beside it.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace('name = "acme-issues"', "# the name line is gone"),
			"utf8",
		);
		const updated = { ...config, sources: [...config.sources, pullRequestSource()] };

		const fact = await writeConfigFile(path, updated);

		expect(fact.mode).toBe("rewrite");
		expect(readFileSync(path, "utf8")).toBe(configToToml(updated));
		expect(configWriteLine(fact, "registered 1 new source")).toContain("did not survive");
	});

	test("a mapping the operator re-points while the plane runs takes the plane's own value", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		const text = operatorFile("/home/me/src/factory");
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);
		// The `[repos]` table is the plane's own region: it writes the value it
		// holds. An operator who re-points that key while the plane runs has
		// their value replaced on the next write-back, with no line to say so.
		// The `[[sources]]` blocks behave the other way - see the test above -
		// and docs/configuration/index.md states both to the operator.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				'"github.com/acme/factory" = "/home/me/src/factory"',
				'"github.com/acme/factory" = "/home/me/src/my-own-pick"',
			),
			"utf8",
		);

		const fact = await writeConfigFile(path, config);

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain('"github.com/acme/factory" = "/home/me/src/factory"');
		expect(written).not.toContain("/home/me/src/my-own-pick");
		expect(commentLines(written)).toHaveLength(commentLines(text).length);
	});

	test("a line the operator deletes from an owned region comes back", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(path);
		// The plane writes what its own config holds, so a deletion inside one of
		// its two regions is undone by the next write-back: the mapping key is
		// re-added inside the table, and the source block is re-appended in the
		// plane's own serialization. Nothing says the deletion was undone, so
		// docs/configuration/index.md states it to the operator.
		writeFileSync(
			path,
			readFileSync(path, "utf8")
				.replace('\n"github.com/acme/factory" = "/home/me/src/factory"', "")
				.replace(
					[
						"# The feed the operator reads by hand: the issues of the one repository.",
						"[[sources]]",
						'name = "acme-issues"',
						'kind = "github-issues"',
						"refresh-interval-seconds = 60",
						'repositories = [ "acme/factory" ]',
					].join("\n"),
					"",
				),
			"utf8",
		);

		const fact = await writeConfigFile(path, config);

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain('[repos]\n"github.com/acme/factory" = "/home/me/src/factory"');
		expect(written).toContain('name = "acme-issues"');
		expect(written).toContain('kind = "github-issues"');
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos).toEqual(config.repos);
		expect(reloaded.sources.map((source) => source.name)).toEqual(["acme-issues"]);
	});

	test("a mapping value the plane cannot carry in place falls back to the rewrite", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(path);
		// The operator restates a mapping the plane holds as a value spanning lines
		// while the plane runs. The plane's own serializer writes a one-line
		// string, so it has no in-place form for that key, and it takes the rewrite
		// instead of writing a second line beside the operator's.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				'"github.com/acme/factory" = "/home/me/src/factory"',
				'"github.com/acme/factory" = [\n\t"/home/me/src/factory",\n]',
			),
			"utf8",
		);
		const updated = {
			...config,
			repos: { ...config.repos, "github.com/acme/factory": "/home/me/src/factory_2" },
		};

		const fact = await writeConfigFile(path, updated);

		expect(fact.mode).toBe("rewrite");
		expect(readFileSync(path, "utf8")).toBe(configToToml(updated));
	});

	test("a file the operator made unparseable while the plane ran falls back to the rewrite", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(path);
		// A line the operator typed that is not TOML at all. The plane cannot vouch
		// for an edit of that text, so it replaces the file and names the loss.
		writeFileSync(path, `${readFileSync(path, "utf8")}this line is not TOML\n`, "utf8");
		const updated = { ...config, repos: { ...config.repos, "github.com/acme/billing": "/b" } };

		const fact = await writeConfigFile(path, updated);

		expect(fact.mode).toBe("rewrite");
		expect(readFileSync(path, "utf8")).toBe(configToToml(updated));
		expect(configWriteLine(fact, "saved the mapping")).toContain("did not survive");
	});

	test("a file the plane serialized stays editable in sections mode", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		writeFileSync(path, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(path);
		// The promise the whole design rests on: the steady state. A file the
		// plane itself wrote with `configToToml` is a file its own section edit
		// can read, so a later write-back edits it instead of replacing it. This
		// is the drift guard between the two serializers.
		writeFileSync(path, configToToml(config), "utf8");

		const mapping = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
		});
		expect(mapping.mode).toBe("sections");

		const append = await writeConfigFile(path, {
			...config,
			repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
			sources: [...config.sources, pullRequestSource()],
		});
		expect(append.mode).toBe("sections");

		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos["github.com/acme/billing"]).toBe("/home/me/src/billing_1");
		expect(reloaded.sources.map((source) => source.name)).toEqual([
			"acme-issues",
			"acme/factory-pull-requests",
		]);
		// A no-op on the plane's own file writes nothing at all.
		const noop = await writeConfigFile(path, reloaded);
		expect(noop.mode).toBe("unchanged");
	});

	test("an inline table on a mapping key the plane holds is rewritten in place", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		const text = operatorFile("/home/me/src/factory");
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);
		// The operator restates a mapping the plane holds as an inline table while
		// the plane runs. The value closes on its own line, so the scan reads that
		// line the way it reads any key line the plane owns: the plane writes its
		// own value over it, and the edit stays inside the one line.
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace(
				'"github.com/acme/factory" = "/home/me/src/factory"',
				'"github.com/acme/factory" = { path = "/home/me/src/my-own-pick" }',
			),
			"utf8",
		);
		const updated = { ...config, repos: { ...config.repos, "github.com/acme/factory": "/new" } };

		const fact = await writeConfigFile(path, updated);

		expect(fact.mode).toBe("sections");
		const written = readFileSync(path, "utf8");
		expect(written).toContain('"github.com/acme/factory" = "/new"');
		expect(written).not.toContain("{ path =");
		expect(commentLines(written)).toHaveLength(commentLines(text).length);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos["github.com/acme/factory"]).toBe("/new");
	});

	test("a tail append adds the one blank line an in-region insert adds", async () => {
		const temp = inTempDir();
		const source = pullRequestSource();
		// The file already holds a `[[sources]]` block, so the new block is inserted
		// inside the region the file names.
		const inside = temp("inside.toml");
		writeFileSync(inside, operatorFile("/home/me/src/factory"), "utf8");
		const { config } = await loadConfigFile(inside);
		await writeConfigFile(inside, { ...config, sources: [...config.sources, source] });
		expect(blankLinesAboveTheLastBlock(readFileSync(inside, "utf8").split("\n"))).toBe(1);
		// The file holds no block at all, so the new block is appended at the end.
		// The plane writes one blank line there too, not two.
		const operatorText = operatorFile("/home/me/src/factory").replace(
			[
				"# The feed the operator reads by hand: the issues of the one repository.",
				"[[sources]]",
				'name = "acme-issues"',
				'kind = "github-issues"',
				"refresh-interval-seconds = 60",
				'repositories = [ "acme/factory" ]',
			].join("\n"),
			"",
		);
		const tail = temp("tail.toml");
		writeFileSync(tail, operatorText, "utf8");
		const { config: empty } = await loadConfigFile(tail);
		expect(empty.sources).toEqual([]);
		await writeConfigFile(tail, { ...empty, sources: [source] });
		expect(blankLinesAboveTheLastBlock(readFileSync(tail, "utf8").split("\n"))).toBe(1);
		// The operator's own last line is blank, so their blank line is the
		// separator and the plane adds no second one.
		const blankEnd = temp("blank-end.toml");
		writeFileSync(blankEnd, `${operatorText}\n`, "utf8");
		const { config: alsoEmpty } = await loadConfigFile(blankEnd);
		await writeConfigFile(blankEnd, { ...alsoEmpty, sources: [source] });
		expect(blankLinesAboveTheLastBlock(readFileSync(blankEnd, "utf8").split("\n"))).toBe(1);
	});

	test("a tail append that writes both regions separates the two tables it wrote", async () => {
		const temp = inTempDir();
		const path = temp("config.toml");
		// A file holding neither region the plane owns - the shape the shipped
		// default config carries. The write-back appends both tables at the file's
		// end, and they stand apart with the same blank separator the plane's own
		// whole-file form puts between every table.
		const text = operatorFile("/home/me/src/factory")
			.replace(
				[
					"# The checkouts the plane works in. The mapping is the one the plane writes",
					"# back when it discovers a sibling clone.",
					"[repos]",
					'"github.com/acme/factory" = "/home/me/src/factory"',
					"",
				].join("\n"),
				"",
			)
			.replace(
				[
					"# The feed the operator reads by hand: the issues of the one repository.",
					"[[sources]]",
					'name = "acme-issues"',
					'kind = "github-issues"',
					"refresh-interval-seconds = 60",
					'repositories = [ "acme/factory" ]',
				].join("\n"),
				"",
			)
			.replaceAll("\n\n\n", "\n\n");
		writeFileSync(path, text, "utf8");
		const { config } = await loadConfigFile(path);
		expect(config.repos).toEqual({});
		expect(config.sources).toEqual([]);

		const fact = await writeConfigFile(path, {
			...config,
			repos: { "github.com/acme/billing": "/home/me/src/billing_1" },
			sources: [...config.sources, pullRequestSource()],
		});

		expect(fact.mode).toBe("sections");
		const lines = readFileSync(path, "utf8").split("\n");
		const reposAt = lines.indexOf("[repos]");
		const sourcesAt = lines.lastIndexOf("[[sources]]");
		expect(reposAt).toBeGreaterThan(-1);
		expect(sourcesAt).toBeGreaterThan(reposAt);
		// The two tables the plane wrote, and the one blank line between them.
		expect(lines.slice(reposAt)).toEqual([
			"[repos]",
			'"github.com/acme/billing" = "/home/me/src/billing_1"',
			"",
			"[[sources]]",
			'name = "acme/factory-pull-requests"',
			'kind = "github-pull-requests"',
			"refresh-interval-seconds = 300",
			'repositories = [ "acme/factory" ]',
			"",
		]);
		expect(commentLines(readFileSync(path, "utf8"))).toHaveLength(commentLines(text).length);
		const { config: reloaded } = await loadConfigFile(path);
		expect(reloaded.repos).toEqual({ "github.com/acme/billing": "/home/me/src/billing_1" });
		expect(reloaded.sources.map((source) => source.name)).toEqual(["acme/factory-pull-requests"]);
	});
});

// ---------------------------------------------------------------------------
// What the line scan reads, and what a fallback costs (issue #228)
// ---------------------------------------------------------------------------

/**
 * The shapes the line scan does not read, measured instead of asserted by rule.
 *
 * The scan reads a table header, a key assignment whose value closes on its own
 * line - a plain string, an inline table written on one line - and the string
 * forms a config file carries: a basic string with its escapes, a literal
 * string, and the multiline form of each. It does not read a value that runs
 * past the end of its line (a multiline array, an inline table written across
 * lines), a dotted key, or any other TOML form the plane's own serializer does
 * not write.
 *
 * The rule says such a shape costs the operator their comments as a named full
 * rewrite. The tables below measure that cost rather than trust the rule: each
 * case restates one shape in the operator's file, runs every write-back over it,
 * and records the mode the write lands as, the comment lines that survive it and
 * the ones that do not, and the Message line the write leaves. The shapes the
 * scan reads today stand in the second table, so a change to the scan that moves
 * a shape from the group it reads into the group it does not turns a record red
 * before an operator meets it.
 *
 * The plane meets an unread shape through an edit made while it runs: the
 * startup loader refuses some of these shapes outright. A shape the loader does
 * accept stands `fromShape`, so the plane starts by holding what that file says.
 */

/** The `[repos]` line the plane holds in the operator's fixture file. */
const HELD_MAPPING_LINE = '"github.com/acme/factory" = "/home/me/src/factory"';
/** The `[[sources]]` block the plane holds in the operator's fixture file. */
const HELD_SOURCE_BLOCK = [
	"[[sources]]",
	'name = "acme-issues"',
	'kind = "github-issues"',
	"refresh-interval-seconds = 60",
	'repositories = [ "acme/factory" ]',
].join("\n");

/** The operator's file with the mapping line the plane holds restated as `shape`. */
function withReposShape(shape: string): string {
	return operatorFile("/home/me/src/factory").replace(HELD_MAPPING_LINE, shape);
}

/** The operator's file with the source block the plane holds restated as `shape`. */
function withSourceShape(shape: string): string {
	return operatorFile("/home/me/src/factory").replace(HELD_SOURCE_BLOCK, shape);
}

/** One write-back the plane does, with the words its Message line carries. */
interface WriteBack {
	readonly name: string;
	/** What the plane wrote, handed to `configWriteLine`. */
	readonly written: string;
	readonly updated: (config: FactoryConfig) => FactoryConfig;
}

const ADD_A_MAPPING: WriteBack = {
	name: "the mapping write",
	written: "saved the mapping",
	updated: (config) => ({
		...config,
		repos: { ...config.repos, "github.com/acme/billing": "/home/me/src/billing_1" },
	}),
};

const REPOINT_A_HELD_MAPPING: WriteBack = {
	name: "the mapping write on a key the plane already holds",
	written: "saved the mapping",
	updated: (config) => ({
		...config,
		repos: { ...config.repos, "github.com/acme/factory": "/home/me/src/factory_2" },
	}),
};

const APPEND_A_SOURCE: WriteBack = {
	name: "the Repository init's source write",
	written: "registered 1 new source",
	updated: (config) => ({ ...config, sources: [...config.sources, pullRequestSource()] }),
};

/** The init's re-init of a repository whose sources already stand: nothing new to write. */
const NOTHING_NEW: WriteBack = {
	name: "a write-back that holds nothing new",
	written: "",
	updated: (config) => config,
};

/** What one write-back costs a file written in one shape. */
interface ShapeCost {
	mode: ConfigWriteMode;
	/** The operator's comment lines that still stand in the file the write left. */
	commentsKept: string[];
	/** The operator's comment lines the write dropped. */
	commentsLost: string[];
	/** The Message line the write left, with the config file shown as `<file>`. */
	message: string;
	/** The source names the file carries after the write. */
	sources: string[];
}

/**
 * Run one write-back over `file` and report what it cost.
 *
 * By default the plane starts from the operator's readable file, and the shape
 * lands as an edit made while the plane runs.
 */
async function costOfWriteBack(
	file: string,
	writeBack: WriteBack,
	{ fromShape = false }: { fromShape?: boolean } = {},
): Promise<ShapeCost> {
	const temp = inTempDir();
	const path = temp("config.toml");
	writeFileSync(path, fromShape ? file : operatorFile("/home/me/src/factory"), "utf8");
	const { config } = await loadConfigFile(path);
	if (!fromShape) writeFileSync(path, file, "utf8");
	const fact = await writeConfigFile(path, writeBack.updated(config));
	const written = readFileSync(path, "utf8");
	const commentsKept = commentLines(written);
	const { config: reloaded } = await loadConfigFile(path);
	return {
		mode: fact.mode,
		commentsKept,
		commentsLost: commentLines(file).filter((line) => !commentsKept.includes(line)),
		message: configWriteLine(fact, writeBack.written).replaceAll(path, "<file>"),
		sources: reloaded.sources.map((source) => source.name),
	};
}

/** One write-back's recorded cost on one shape. */
interface CostRecord {
	readonly via: WriteBack;
	readonly mode: ConfigWriteMode;
	/** Whether the write drops every comment line the operator wrote, or none of them. */
	readonly commentsLost: "all" | "none";
	/** The Message line the write leaves, with the config file shown as `<file>`. */
	readonly message: string;
	/** The source names the file carries after the write, for a shape that costs more than prose. */
	readonly sources?: readonly string[];
}

/** One shape, why the scan reads it or does not, and what each write-back costs on it. */
interface ShapeRecord {
	readonly shape: string;
	readonly why: string;
	readonly file: string;
	/** The plane starts from the shaped file instead of meeting the shape mid-run. */
	readonly fromShape?: boolean;
	readonly costs: readonly CostRecord[];
}

/** Every write-back pays the full rewrite on a file the check will not vouch for. */
function rewriteCosts(): CostRecord[] {
	return [
		{
			via: ADD_A_MAPPING,
			mode: "rewrite",
			commentsLost: "all",
			message:
				"saved the mapping in <file>; the whole config file was rewritten, " +
				"and the comments in it did not survive",
		},
		{
			via: REPOINT_A_HELD_MAPPING,
			mode: "rewrite",
			commentsLost: "all",
			message:
				"saved the mapping in <file>; the whole config file was rewritten, " +
				"and the comments in it did not survive",
		},
		{
			via: APPEND_A_SOURCE,
			mode: "rewrite",
			commentsLost: "all",
			message:
				"registered 1 new source in <file>; the whole config file was rewritten, " +
				"and the comments in it did not survive",
		},
		{
			via: NOTHING_NEW,
			mode: "rewrite",
			commentsLost: "all",
			message:
				"the whole config file at <file> was rewritten, and the comments in it did not survive",
		},
	];
}

/** Every write-back keeps its section edit on a file whose shapes the scan reads. */
function sectionEditCosts(): CostRecord[] {
	return [
		{
			via: ADD_A_MAPPING,
			mode: "sections",
			commentsLost: "none",
			message: "saved the mapping in <file>",
		},
		{
			via: REPOINT_A_HELD_MAPPING,
			mode: "sections",
			commentsLost: "none",
			message: "saved the mapping in <file>",
		},
		{
			via: APPEND_A_SOURCE,
			mode: "sections",
			commentsLost: "none",
			message: "registered 1 new source in <file>",
		},
	];
}

/**
 * The same write-backs without the re-point.
 *
 * A shape the scan reads as a string, but cannot write in place, keeps its
 * section edit only while the plane leaves that line alone. The write that must
 * put a new value on such a line is recorded in the table above.
 */
function sectionEditsThatLeaveTheLineAlone(): CostRecord[] {
	return sectionEditCosts().filter((cost) => cost.via !== REPOINT_A_HELD_MAPPING);
}

const UNREAD_SHAPE_COSTS: readonly ShapeRecord[] = [
	{
		shape: "a multiline array on a key the plane holds",
		why: "the value runs past the end of its line, and an array is not a checkout path",
		file: withReposShape('"github.com/acme/factory" = [\n\t"/home/me/src/factory",\n]'),
		costs: rewriteCosts(),
	},
	{
		shape: "an inline table written across lines on a key the plane holds",
		why: "the value runs past the end of its line, and a table is not a checkout path",
		file: withReposShape('"github.com/acme/factory" = {\n\tpath = "/home/me/src/factory",\n}'),
		costs: rewriteCosts(),
	},
	{
		shape: "a dotted key in the [repos] table",
		why: "the scan reads no dotted key, and the loader refuses the sub-table one opens inside [repos]",
		file: withReposShape(`${HELD_MAPPING_LINE}\nacme.factory = "/home/me/src/other"`),
		costs: rewriteCosts(),
	},
	{
		shape: "a dotted key naming a key the plane holds",
		why: "the scan reads no dotted key, so the line the plane would rewrite is never found",
		file: withReposShape('"github.com/acme/factory".path = "/home/me/src/factory"'),
		costs: rewriteCosts(),
	},
	{
		shape: "a multiline string on a key the plane holds, restated while the plane runs",
		why:
			"the scan leaves the operator's lines alone, so the file no longer carries the value the " +
			"plane holds, and the check refuses every write-back - even one that holds nothing new",
		file: withReposShape('"github.com/acme/factory" = """\n/home/me/src/factory\n"""'),
		costs: rewriteCosts(),
	},
	{
		shape:
			"a multiline string on a key the plane holds, when the plane must write a new value there",
		why: "the plane's serializer has no in-place form for a value that spans lines",
		file: withReposShape('"github.com/acme/factory" = """\n/home/me/src/factory\n"""'),
		fromShape: true,
		costs: [
			{
				via: REPOINT_A_HELD_MAPPING,
				mode: "rewrite",
				commentsLost: "all",
				message:
					"saved the mapping in <file>; the whole config file was rewritten, " +
					"and the comments in it did not survive",
			},
		],
	},
	{
		shape: "a multiline array on a key the plane does not hold",
		why: "the line is the operator's own and stays, but the loader refuses an array where a path stands",
		file: withReposShape(`${HELD_MAPPING_LINE}\nacme-other = [\n\t"/home/me/src/other",\n]`),
		costs: rewriteCosts(),
	},
	{
		shape: "a dotted key inside a [[sources]] block the plane holds",
		why: "the block stands byte for byte, and the loader refuses what the dotted key makes of it",
		file: withSourceShape(`${HELD_SOURCE_BLOCK}\nauth.note = "written by hand"`),
		costs: rewriteCosts(),
	},
	{
		shape: "a multiline array inside a [[sources]] block the plane holds",
		why: "the scan names the block, so no line inside it is ever rewritten and nothing is lost",
		file: withSourceShape(
			[
				"[[sources]]",
				'name = "acme-issues"',
				'kind = "github-issues"',
				"refresh-interval-seconds = 60",
				"repositories = [",
				'\t"acme/factory",',
				"]",
			].join("\n"),
		),
		costs: [
			{
				via: ADD_A_MAPPING,
				mode: "sections",
				commentsLost: "none",
				message: "saved the mapping in <file>",
			},
			{
				via: REPOINT_A_HELD_MAPPING,
				mode: "sections",
				commentsLost: "none",
				message: "saved the mapping in <file>",
			},
			{
				via: APPEND_A_SOURCE,
				mode: "sections",
				commentsLost: "none",
				message: "registered 1 new source in <file>",
			},
			{ via: NOTHING_NEW, mode: "unchanged", commentsLost: "none", message: "" },
		],
	},
	{
		shape: "a source name written as a multiline string inside a block the plane holds",
		why: "the scan cannot name the block, so the plane appends its own copy of the source it holds",
		file: withSourceShape(
			[
				"[[sources]]",
				'name = """',
				"acme-issues",
				'"""',
				'kind = "github-issues"',
				"refresh-interval-seconds = 60",
				'repositories = [ "acme/factory" ]',
			].join("\n"),
		),
		costs: [
			{
				via: ADD_A_MAPPING,
				mode: "sections",
				commentsLost: "none",
				message: "saved the mapping in <file>",
				sources: ["acme-issues\n", "acme-issues"],
			},
			{
				via: REPOINT_A_HELD_MAPPING,
				mode: "sections",
				commentsLost: "none",
				message: "saved the mapping in <file>",
				sources: ["acme-issues\n", "acme-issues"],
			},
			{
				via: APPEND_A_SOURCE,
				mode: "sections",
				commentsLost: "none",
				message: "registered 1 new source in <file>",
				sources: ["acme-issues\n", "acme-issues", "acme/factory-pull-requests"],
			},
			{
				via: NOTHING_NEW,
				mode: "sections",
				commentsLost: "none",
				message: "",
				sources: ["acme-issues\n", "acme-issues"],
			},
		],
	},
];

const READ_SHAPE_COSTS: readonly ShapeRecord[] = [
	{
		shape: "a literal string on a key the plane holds",
		why: "the value closes on its own line",
		file: withReposShape("'github.com/acme/factory' = '/home/me/src/factory'"),
		costs: sectionEditCosts(),
	},
	{
		shape: "a basic string with its escapes on a key the plane holds",
		why: "the value closes on its own line, and the scan decodes its escapes",
		file: withReposShape('"github.com/acme/factory" = "C:\\\\Users\\\\me\\\\src\\\\factory"'),
		fromShape: true,
		costs: sectionEditCosts(),
	},
	{
		shape: "an inline table written on one line on a key the plane holds",
		why: "the value closes on its own line, so the plane writes its own value over the line it owns",
		file: withReposShape('"github.com/acme/factory" = { path = "/x" }'),
		costs: sectionEditCosts(),
	},
	{
		shape: "a multiline basic string on a key the plane holds",
		why:
			"the scan reads the string, so the key counts as standing and no second line lands " +
			"beside it; a write that must re-point that key is the rewrite the table above records",
		file: withReposShape('"github.com/acme/factory" = """\n/home/me/src/factory\n"""'),
		fromShape: true,
		costs: sectionEditsThatLeaveTheLineAlone(),
	},
	{
		shape: "a multiline literal string on a key the plane holds",
		why:
			"the scan reads the string, so the key counts as standing and no second line lands " +
			"beside it; a write that must re-point that key is the rewrite the table above records",
		file: withReposShape("'github.com/acme/factory' = '''\n/home/me/src/factory\n'''"),
		fromShape: true,
		costs: sectionEditsThatLeaveTheLineAlone(),
	},
	{
		shape:
			"a multiline string on a key the plane holds whose prose reads like a mapping the plane holds",
		why: "the scan knows the line stands inside the string, so it is prose and never a key line to rewrite",
		file: withReposShape(
			'"github.com/acme/factory" = """\nWhy this checkout sits here, in my own words.\n"github.com/acme/billing" = not-a-mapping\n"""',
		),
		fromShape: true,
		costs: sectionEditsThatLeaveTheLineAlone(),
	},
	{
		shape: "a multiline literal string whose prose reads like a table header and a comment",
		why: "the scan tracks the string, so its prose is never a line of the file's own tables",
		file: operatorFile("/home/me/src/factory").replace(
			'template = """Review pull request {external-key}: {title}."""',
			[
				"template = '''Review prose.",
				"",
				"[[repos]] is a line of this prompt, not a table the file opens.",
				'It holds " a quote and a # hash.',
				"'''",
			].join("\n"),
		),
		costs: sectionEditCosts(),
	},
	{
		shape: "a comment riding on the key line the plane holds",
		why: "the scan reads the comment apart from the value, so the plane rewrites the value and keeps the note",
		file: withReposShape(`${HELD_MAPPING_LINE} # the checkout I keep`),
		costs: sectionEditCosts(),
	},
];

/** Compare one measured cost against the record a reviewer reads. */
function expectCost(measured: ShapeCost, record: CostRecord, file: string): void {
	const where = record.via.name;
	expect(measured.mode, `${where}: the mode the write landed as`).toBe(record.mode);
	expect(measured.commentsLost, `${where}: the comment lines the write dropped`).toEqual(
		record.commentsLost === "all" ? commentLines(file) : [],
	);
	expect(measured.commentsKept, `${where}: the comment lines the write kept`).toEqual(
		record.commentsLost === "all" ? [] : commentLines(file),
	);
	expect(measured.message, `${where}: the Message line the write left`).toBe(record.message);
	if (record.sources !== undefined) {
		expect(measured.sources, `${where}: the sources the file carries after the write`).toEqual([
			...record.sources,
		]);
	}
}

describe("the shapes the config write-back's line scan does not read (ADR 0103)", () => {
	for (const record of UNREAD_SHAPE_COSTS) {
		test(`${record.shape}: ${record.why}`, async () => {
			for (const cost of record.costs) {
				expectCost(
					await costOfWriteBack(record.file, cost.via, { fromShape: record.fromShape }),
					cost,
					record.file,
				);
			}
		});
	}
});

describe("the shapes the config write-back's line scan reads today (ADR 0103)", () => {
	for (const record of READ_SHAPE_COSTS) {
		test(`the scan reads ${record.shape}: ${record.why}`, async () => {
			for (const cost of record.costs) {
				expectCost(
					await costOfWriteBack(record.file, cost.via, { fromShape: record.fromShape }),
					cost,
					record.file,
				);
			}
		});
	}
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

	test("a rewrite leads the confirmation it rides with", () => {
		const confirmation = "acme/factory: pushed 1 commit, created 2 labels";
		// The Repository init's confirmation is longer than the Message row, so the
		// fact the operator most needs - the one naming the lost comments - leads it.
		expect(
			writeFactWithConfirmation(
				{ mode: "rewrite", path: "/home/me/config.toml" },
				configWriteLine(
					{ mode: "rewrite", path: "/home/me/config.toml" },
					"registered 1 new source",
				),
				confirmation,
			),
		).toBe(
			"registered 1 new source in /home/me/config.toml; the whole config file was " +
				"rewritten, and the comments in it did not survive. acme/factory: pushed 1 commit, " +
				"created 2 labels",
		);
		// A write that edited only what the plane owns trails it, the way it always did.
		expect(
			writeFactWithConfirmation(
				{ mode: "sections", path: "/home/me/config.toml" },
				configWriteLine(
					{ mode: "sections", path: "/home/me/config.toml" },
					"registered 1 new source",
				),
				confirmation,
			),
		).toBe(`${confirmation}, registered 1 new source in /home/me/config.toml`);
		// A write that changed nothing adds nothing to the confirmation.
		expect(
			writeFactWithConfirmation(
				{ mode: "unchanged", path: "/home/me/config.toml" },
				configWriteLine(
					{ mode: "unchanged", path: "/home/me/config.toml" },
					"registered 0 new sources",
				),
				confirmation,
			),
		).toBe(confirmation);
	});

	test("a write that carried no new count words itself, or says nothing", () => {
		// The Repository init's re-init of a repository whose sources already stand
		// registers nothing new, so its write-back hands the line no count to word.
		// A write that edited nothing, or edited only what the plane owns, adds no
		// row. A full rewrite says the fact on its own, with no count in it.
		expect(configWriteLine({ mode: "unchanged", path: "/home/me/config.toml" }, "")).toBe("");
		expect(configWriteLine({ mode: "sections", path: "/home/me/config.toml" }, "")).toBe("");
		expect(configWriteLine({ mode: "created", path: "/home/me/config.toml" }, "")).toBe(
			"the config file was created at /home/me/config.toml",
		);
		const rewrite = configWriteLine({ mode: "rewrite", path: "/home/me/config.toml" }, "");
		expect(rewrite).toBe(
			"the whole config file at /home/me/config.toml was rewritten, " +
				"and the comments in it did not survive",
		);
		expect(rewrite).not.toContain("0");
		// The count-free rewrite leads the confirmation the way a counted one does,
		// and a write with nothing to say leaves the confirmation standing alone.
		expect(
			writeFactWithConfirmation(
				{ mode: "rewrite", path: "/home/me/config.toml" },
				rewrite,
				"acme/factory: pushed 1 commit, created 0 labels",
			),
		).toBe(`${rewrite}. acme/factory: pushed 1 commit, created 0 labels`);
		expect(
			writeFactWithConfirmation(
				{ mode: "unchanged", path: "/home/me/config.toml" },
				configWriteLine({ mode: "unchanged", path: "/home/me/config.toml" }, ""),
				"acme/factory: pushed 1 commit, created 0 labels",
			),
		).toBe("acme/factory: pushed 1 commit, created 0 labels");
	});
});
