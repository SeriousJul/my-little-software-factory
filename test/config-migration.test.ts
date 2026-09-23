/**
 * The one-time config migration to the workflow machine (ADR 0027).
 *
 * A seeded install carries the pre-machine keys and the seed's label prose,
 * and the seed never upgrades: the migration is the only path that file has
 * to the machine. These tests pin both halves - the pure rewrite, and the
 * load that runs it, backs the old file up, writes the report, and refuses
 * to touch the file when the rewrite would not validate.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

import { ConfigError, loadConfigFile, validateConfig } from "../src/config.ts";
import {
	hasOldWorkflowMachineKeys,
	migrateWorkflowMachineConfig,
} from "../src/config-migration.ts";

const SHIPPED_DEFAULT_CONFIG = fileURLToPath(new URL("../config/default.toml", import.meta.url));
const SHIPPED_TEXT = readFileSync(SHIPPED_DEFAULT_CONFIG, "utf8");
/** The pre-machine Default configuration, as a first-run install holds it. */
const PRE_MACHINE_SEED = readFileSync(
	fileURLToPath(new URL("./fixtures/pre-machine-config.toml", import.meta.url)),
	"utf8",
);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(name = "config.toml"): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-migration-"));
	dirs.push(dir);
	return join(dir, name);
}

/** The pre-machine seed with the merge type's own auto-close flag on. */
function withMergeAutoCloseOn(): string {
	const start = PRE_MACHINE_SEED.indexOf("[task-types.merge]");
	const end = PRE_MACHINE_SEED.indexOf("auto-close = false", start);
	return `${PRE_MACHINE_SEED.slice(0, end)}auto-close = true\n${PRE_MACHINE_SEED.slice(end + "auto-close = false".length)}`;
}

/** Migrate the pre-machine seed as written, with the shipped seed beside it. */
function migrate(text: string, date = "2026-09-17") {
	return migrateWorkflowMachineConfig(
		"/home/operator/.config/my-little-software-factory/config.toml",
		parseToml(text) as Record<string, unknown>,
		SHIPPED_TEXT,
		date,
	);
}

describe("the pre-machine keys", () => {
	test("one of them is enough to name an old config", () => {
		expect(hasOldWorkflowMachineKeys({ "task-rules": [] })).toBe(true);
		expect(hasOldWorkflowMachineKeys({ workflows: [] })).toBe(true);
		expect(hasOldWorkflowMachineKeys({ states: [] })).toBe(false);
		expect(hasOldWorkflowMachineKeys(undefined)).toBe(false);
		expect(hasOldWorkflowMachineKeys([])).toBe(false);
	});

	test("the shipped Default configuration carries none of them", () => {
		expect(hasOldWorkflowMachineKeys(parseToml(SHIPPED_TEXT))).toBe(false);
	});

	test("an auto-close flag alone names the config old", () => {
		// A config that carries only the flag still migrates: the strict
		// loader would otherwise reject it with an error that names a backup
		// the migration never made.
		expect(hasOldWorkflowMachineKeys({ "task-types": { merge: { "auto-close": true } } })).toBe(
			true,
		);
		expect(hasOldWorkflowMachineKeys({ "task-types": { merge: { agent: "pi" } } })).toBe(false);
	});

	test("the loader rejects an old key after the migration ran", () => {
		expect(() => validateConfig({ ...parseToml(PRE_MACHINE_SEED) })).toThrow(ConfigError);
		try {
			validateConfig(parseToml(PRE_MACHINE_SEED));
		} catch (error) {
			expect(String(error)).toContain("is a pre-workflow-machine key");
			expect(String(error)).toContain("backup");
		}
	});

	test("an auto-close flag is an old key too", () => {
		const text = withMergeAutoCloseOn();
		expect(() => validateConfig(parseToml(text))).toThrow(/pre-workflow-machine key/);
	});
});

describe("the pure rewrite", () => {
	test("the untouched pre-machine seed migrates to the shipped machine", () => {
		const result = migrate(PRE_MACHINE_SEED);
		// The rewrite validates, and it carries no old key.
		const config = validateConfig(parseToml(result.configText));
		// The three rules became three states, and the shipped machine's park
		// came with them: the default source list now carries an open pull
		// request before it holds a label, and the park is what suggests
		// nothing for a pull request the machine never placed.
		expect(config.workflowStates.map((state) => state.name)).toEqual([
			"rework",
			"review",
			"merge",
			"pull-request-unlabeled",
		]);
		expect(result.reportText).toContain("Parking states appended from the shipped machine");
		// Every task type the clean seed template was installed on carries the
		// shipped transition: an untouched install had no `workflows` edges, so
		// the label prose the templates drop has a tested replacement.
		for (const name of ["implement", "review", "rework", "merge"]) {
			expect(config.taskTypes[name]?.transition, `${name} transition`).toBeDefined();
		}
		expect(config.taskTypes.review.transition).toMatchObject({ scoreThreshold: 90 });
		expect(config.taskTypes.implement.transition).toMatchObject({
			pullRequestFacts: ["ready-for-review"],
		});
		// The clean templates carry no workflow label for the agents to obey.
		for (const task of Object.values(config.taskTypes))
			expect(task.template).not.toMatch(
				/ready-for-agent|ready-for-review|ready-to-ship|needs-work/,
			);
		expect(result.configText).toContain("# Migrated to the workflow machine on 2026-09-17");
		// The report names the behavior changes the rewrite carries: the
		// dropped comments and the wider default source list.
		expect(result.reportText).toContain("Behavior changes to know");
		expect(result.reportText).toContain("comments in the file are dropped");
		expect(result.reportText).toContain("The default source list is wider");
	});

	test("one rule becomes one state, named for its task type and matching what it matched", () => {
		const result = migrate(PRE_MACHINE_SEED);
		const states = validateConfig(parseToml(result.configText)).workflowStates;
		expect(states[1]).toEqual({
			name: "review",
			taskType: "review",
			match: { sourceKind: "github-pull-request", labelsAny: ["ready-for-review"] },
		});
	});

	test("two rules that name one task type take distinct state names", () => {
		const result = migrate(
			PRE_MACHINE_SEED.replace(
				'[[task-rules]]\ntask-type = "review"',
				'[[task-rules]]\ntask-type = "review"\n[task-rules.when]\nlabels-any = ["please-review"]\n\n[[task-rules]]\ntask-type = "review"',
			),
		);
		const names = validateConfig(parseToml(result.configText)).workflowStates.map(
			(state) => state.name,
		);
		expect(names).toContain("review");
		expect(names).toContain("review-2");
	});

	test("an expressible edge becomes the source type's transition", () => {
		// The old label workflow wired implement to review with one edge.
		const text = PRE_MACHINE_SEED.replace(
			"workflows = []",
			'workflows = [{ from = "implement", to = ["review"] }]',
		);
		const config = validateConfig(parseToml(migrate(text).configText));
		// The edge's target state matches on `ready-for-review` and names the
		// pull request, so that is the fact and the surface the transition takes.
		expect(config.taskTypes.implement.transition).toMatchObject({
			ticketFacts: [],
			pullRequestFacts: ["ready-for-review"],
		});
	});

	test("an edge that pins an agent or an environment carries the pin over", () => {
		const text = PRE_MACHINE_SEED.replace(
			"workflows = []",
			'workflows = [{ from = "implement", to = ["review"], agent = "codex", environment = "worktree" }]',
		);
		const config = validateConfig(parseToml(migrate(text).configText));
		expect(config.taskTypes.implement.transition).toMatchObject({
			agent: "codex",
			environment: "worktree",
		});
	});

	test("an edge on an issue-side state writes the ticket facts", () => {
		const text = PRE_MACHINE_SEED.replace(
			"workflows = []",
			'workflows = [{ from = "research", to = ["implement"] }]',
		).replace(
			"[task-types.merge]",
			'[task-types.research]\ntemplate = "research"\n\n[[task-rules]]\ntask-type = "implement"\n[task-rules.when]\nlabels-any = ["ready-for-agent"]\n\n[task-types.merge]',
		);
		const config = validateConfig(parseToml(migrate(text).configText));
		expect(config.taskTypes.research.transition).toMatchObject({
			ticketFacts: ["ready-for-agent"],
			pullRequestFacts: [],
		});
	});

	test("an inexpressible edge is dropped and named in the report", () => {
		const cases: Array<[string, string, string]> = [
			[
				"a fan-out edge",
				'workflows = [{ from = "implement", to = ["review", "rework"] }]',
				"must name exactly one task type",
			],
			[
				"two edges out of one type",
				'workflows = [{ from = "implement", to = ["review"] }, { from = "implement", to = ["merge"] }]',
				"a transition has one",
			],
			[
				"an edge to a type no state offers",
				'workflows = [{ from = "implement", to = ["implement"] }]',
				"no state suggests",
			],
			[
				"an edge to a state that names no label",
				'workflows = [{ from = "implement", to = ["review"] }]',
				"matches without naming any labels",
			],
		];
		for (const [name, workflows, fragment] of cases) {
			let text = PRE_MACHINE_SEED.replace("workflows = []", workflows);
			if (name === "an edge to a state that names no label")
				text = text.replace(/labels-any = \["ready-for-review"\]/, 'source-name = "pulls"');
			const report = migrate(text).reportText;
			expect(report, name).toContain("Dropped edges, named:");
			expect(report, name).toContain(fragment);
		}
	});

	test("an exact seed template is replaced and a customized one is left and named", () => {
		const text = PRE_MACHINE_SEED.replace(
			"template = '''\nRework pull request {external-key}: {title}.",
			"template = '''\nRework my pull request {external-key}: {title}.",
		);
		const report = migrate(text).reportText;
		expect(report).toContain("`implement`: replaced with the clean seed template");
		expect(report).toContain("`rework`: left untouched");
		const config = validateConfig(parseToml(migrate(text).configText));
		expect(config.taskTypes.rework.template).toContain("Rework my pull request");
		// The customized template keeps its own label prose, so the migration
		// installs no transition over it: the two writers would fight.
		expect(config.taskTypes.rework.transition).toBeUndefined();
	});

	test("an auto-close flag is dropped and named, and its replacement is pointed at", () => {
		const report = migrate(withMergeAutoCloseOn()).reportText;
		expect(report).toContain("`auto-close = true` on `merge`: dropped");
		expect(report).toContain("auto-advance");
		expect(migrate(PRE_MACHINE_SEED).reportText).toContain("No `auto-close` flags were set.");
	});

	test("the dropped auto-handoff default is named in the report", () => {
		// Every pre-machine install carries the top-level auto-handoff default.
		// The rewrite drops the key - the Auto-handoff mode is the state
		// file's own fact the a key toggles (ADR 0036) - and the report says
		// so where it says what it dropped.
		const report = migrate(PRE_MACHINE_SEED).reportText;
		expect(report).toContain("`auto-handoff = false`: dropped");
		expect(report).toContain("the state file's own fact the `a` key toggles");
		// And the rewritten config validates: the key is gone from the file.
		expect(() => validateConfig(parseToml(migrate(PRE_MACHINE_SEED).configText))).not.toThrow();
	});

	test("the report names the backup and the states the rules became", () => {
		const report = migrate(PRE_MACHINE_SEED).reportText;
		expect(report).toContain("config.toml.bak");
		expect(report).toContain("config.toml.migration-report.md");
		expect(report).toContain(
			"- `rework`: task `rework`, matches source-kind `github-pull-request`, labels-any `needs-work`.",
		);
	});

	test("a rule with no task type stops the migration with the reason", () => {
		const text = PRE_MACHINE_SEED.replace('[[task-rules]]\ntask-type = "rework"', "[[task-rules]]");
		expect(() => migrate(text)).toThrow(/task-rules/);
	});
});

describe("the priority retirement (ADR 0050)", () => {
	/** The shipped Default config with the retired table standing on it. */
	const prioritySeed = () =>
		`${SHIPPED_TEXT}\n\n[priority]\ndefault = 50\nlabels = ["critical", "high"]\n`;

	test("a retired table alone names the file old, and the loader refuses it", () => {
		const data = parseToml(prioritySeed());
		expect(hasOldWorkflowMachineKeys(data)).toBe(true);
		expect(hasOldWorkflowMachineKeys(parseToml(SHIPPED_TEXT))).toBe(false);
		expect(() => validateConfig(data)).toThrow(ConfigError);
		try {
			validateConfig(data);
		} catch (error) {
			expect(String(error)).toContain('"priority" is a retired key');
			expect(String(error)).toContain("ADR 0050");
		}
	});

	test("the rewrite drops the table and the report says what its place is", () => {
		const result = migrate(prioritySeed());
		// The rewrite validates and carries no retired key.
		const rewritten = parseToml(result.configText);
		validateConfig(rewritten);
		expect(rewritten).not.toHaveProperty("priority");
		// Only the retired table marked the file, so the report is a
		// retirement, not a machine migration.
		expect(result.configText).toContain("# The retired [priority] table was removed on 2026-09-17");
		expect(result.reportText).toContain("# Priority retirement");
		expect(result.reportText).toContain("The `[priority]` table: dropped (ADR 0050)");
		expect(result.reportText).toContain("`+` and `-`");
	});

	test("the load migrates the priority-only file, backs it up, and notes it", async () => {
		const path = tempFile();
		writeFileSync(path, prioritySeed());
		const { config, note } = await loadConfigFile(path);
		expect(note).toContain("migrated off the retired priority table");
		expect(note).toContain("config.toml.bak");
		// The rewritten file stands: the table is gone from the data, and a
		// second load cannot migrate again.
		expect(parseToml(readFileSync(path, "utf8"))).not.toHaveProperty("priority");
		expect(readFileSync(`${path}.bak`, "utf8")).toContain("[priority]");
		const report = readFileSync(`${path}.migration-report.md`, "utf8");
		expect(report).toContain("# Priority retirement");
		const again = await loadConfigFile(path);
		expect(again.note).toBeUndefined();
		expect(again.config).toEqual(config);
	});
});

describe("the load that migrates", () => {
	test("the config is rewritten, backed up, reported, and loaded", async () => {
		const path = tempFile();
		writeFileSync(path, PRE_MACHINE_SEED);
		const { config, note } = await loadConfigFile(path);
		// The migrated config runs on states and transitions, and the old keys
		// are gone: a second load cannot migrate again.
		expect(config.workflowStates.length).toBeGreaterThan(0);
		expect(note).toContain("was migrated to the workflow machine");
		expect(note).toContain("config.toml.bak");
		expect(readFileSync(`${path}.bak`, "utf8")).toBe(PRE_MACHINE_SEED);
		const report = readFileSync(`${path}.migration-report.md`, "utf8");
		expect(report).toContain("# Workflow machine migration");
		expect(readFileSync(path, "utf8")).not.toContain("task-rules");
		const again = await loadConfigFile(path);
		expect(again.note).toBeUndefined();
		expect(again.config).toEqual(config);
	});

	test("a migration that would not validate stops the load with the file unchanged", async () => {
		const path = tempFile();
		// A rule points at a task type the config never defines: the state the
		// migration derives names a task type that cannot validate.
		const broken = PRE_MACHINE_SEED.replace(
			'[[task-rules]]\ntask-type = "rework"',
			'[[task-rules]]\ntask-type = "ghost"',
		);
		expect(broken).not.toBe(PRE_MACHINE_SEED);
		writeFileSync(path, broken);
		await expect(loadConfigFile(path)).rejects.toThrow(/config migration failed/);
		await expect(loadConfigFile(path)).rejects.toThrow(/the config was not changed/);
		expect(readFileSync(path, "utf8")).toBe(broken);
		expect(() => readFileSync(`${path}.bak`, "utf8")).toThrow();
		expect(() => readFileSync(`${path}.migration-report.md`, "utf8")).toThrow();
	});

	test("a migration keeps the file's own mode on everything it writes", async () => {
		const path = tempFile();
		writeFileSync(path, PRE_MACHINE_SEED, { mode: 0o600 });
		await loadConfigFile(path);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
	});
});
