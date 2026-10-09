/**
 * The configuration guide's documentation is a contract, so it is tested.
 *
 * The complete example claims it "sets every key the control plane reads,
 * optional keys included, so the example and the key reference agree line for
 * line". These checks hold that claim: the example must stay a config the
 * reader accepts, and its key set must match the reference table for every
 * group. A new config key that lands in one of the two and not the other
 * fails here, which is how a documented feature and a shipped feature drift
 * apart.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { configToToml, validateConfig } from "../src/config.ts";

const GUIDE = readFileSync(join(import.meta.dirname, "../docs/configuration/index.md"), "utf8");

/** The fenced toml block under the "Complete example" heading. */
function exampleToml(): string {
	const heading = GUIDE.indexOf("## Complete example");
	const start = GUIDE.indexOf("```toml", heading);
	const end = GUIDE.indexOf("```", start + "```toml".length);
	expect(start, "the guide has no complete config example").toBeGreaterThan(-1);
	return GUIDE.slice(start + "```toml".length, end);
}

/**
 * The key paths one config table holds, keyed by the group the reference
 * names. The `top` group holds every top-level key, containers included, so
 * the reference's `agents` and `task-types` rows have a partner.
 */
function exampleGroups(config: Record<string, unknown>): Map<string, Set<string>> {
	const groups = new Map<string, Set<string>>();
	const add = (group: string, key: string) => {
		const keys = groups.get(group) ?? new Set<string>();
		keys.add(key);
		groups.set(group, keys);
	};
	// A named table group: [agents.<name>], [task-types.<name>], and
	// [consultation-types.<name>] all document their keys once.
	const namedTables = new Set(["agents", "task-types", "consultation-types"]);
	// An array-of-tables group: [[states]] and [[sources]]. Their entries
	// carry the group's keys.
	const tableArrays = new Set(["states", "sources"]);
	for (const [key, value] of Object.entries(config)) {
		add("top", key);
		if (simpleTableKeys(add, key, value)) continue;
		if (namedTables.has(key) && typeof value === "object" && value !== null) {
			namedTableKeys(add, key, value);
			continue;
		}
		if (tableArrays.has(key) && Array.isArray(value)) tableArrayKeys(add, key, value);
	}
	return groups;
}

/** The inner keys one simple object table documents, true when it documented them. */
function simpleTableKeys(
	add: (group: string, key: string) => void,
	key: string,
	value: unknown,
): boolean {
	if (key !== "scroll" && key !== "priority" && key !== "logging") return false;
	if (typeof value !== "object" || value === null) return false;
	for (const inner of Object.keys(value as Record<string, unknown>)) add(key, inner);
	return true;
}

/** The keys one named table's entries document, in the groups they belong to. */
function namedTableKeys(
	add: (group: string, key: string) => void,
	key: string,
	value: unknown,
): void {
	for (const table of Object.values(value as Record<string, unknown>)) {
		if (typeof table !== "object" || table === null) continue;
		for (const [inner, innerValue] of Object.entries(table)) {
			add(key, inner);
			taskTypeTransitionKeys(add, key, inner, innerValue);
		}
	}
}

/** The transition and branch keys one task type's transition table documents. */
function taskTypeTransitionKeys(
	add: (group: string, key: string) => void,
	key: string,
	inner: string,
	innerValue: unknown,
): void {
	// [task-types.<name>.transition] documents its keys as
	// their own group, and so does the branches array under
	// it, so their keys go there and not under the task type.
	if (key !== "task-types" || inner !== "transition" || !isPlainTable(innerValue)) return;
	for (const transitionKey of Object.keys(innerValue)) add("task-types.transition", transitionKey);
	const branches = innerValue.branches;
	if (!Array.isArray(branches)) return;
	for (const branch of branches) {
		if (!isPlainTable(branch)) continue;
		for (const branchKey of Object.keys(branch)) add("task-types.transition.branches", branchKey);
	}
}

/** The keys one array-of-tables group's entries document, in the groups they belong to. */
function tableArrayKeys(
	add: (group: string, key: string) => void,
	key: string,
	value: readonly unknown[],
): void {
	for (const entry of value) {
		if (!isPlainTable(entry)) continue;
		for (const [inner, innerValue] of Object.entries(entry)) {
			add(key, inner);
			stateMatchKeys(add, inner, innerValue);
		}
	}
}

/** The condition keys one state's match table documents. */
function stateMatchKeys(
	add: (group: string, key: string) => void,
	inner: string,
	innerValue: unknown,
): void {
	// [states.match] documents its conditions as their own
	// group, so its keys go there and not under the state.
	if (inner !== "match" || !isPlainTable(innerValue)) return;
	for (const condition of Object.keys(innerValue)) add("states.match", condition);
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The group name a reference heading names: `Top level.` becomes `top`. */
function groupOf(heading: string): string | null {
	if (heading.startsWith("**Top level.")) return "top";
	// A heading names its table in code span: **`[agents.<name>]`**,
	// **`[[states]]`**, **`[task-types.<name>.transition]`**. The trailing
	// prose is part of the same line.
	const table = heading.replace(/^\*\*/u, "").match(/^`\[+([^\]`]+)\]/u);
	if (table === null) return null;
	return table[1].split(".<name>").join("");
}

/**
 * The key paths the "Key reference" section documents, by group, and the
 * keys that appear more than once in a group. The sets absorb a duplicate
 * row, so the key-for-key check cannot see one: the guide claims the
 * example and the reference "agree line for line", and two rows for one key
 * can document two different behaviors while their key sets match.
 */
function referenceGroups(): { groups: Map<string, Set<string>>; duplicates: string[] } {
	const start = GUIDE.indexOf("## Key reference");
	const end = GUIDE.indexOf("\n## ", start);
	const section = GUIDE.slice(start, end < 0 ? GUIDE.length : end);
	const groups = new Map<string, Set<string>>();
	const duplicates: string[] = [];
	const group = { current: null as string | null };
	for (const line of section.split("\n")) referenceRow(line, group, groups, duplicates);
	// A heading with no rows documents itself in prose: [repos] holds
	// repository identities, so it has no fixed key names to compare.
	for (const [group, keys] of [...groups]) if (keys.size === 0) groups.delete(group);
	return { groups, duplicates };
}

/** The keys one reference row documents into the group it stands under. */
function referenceRow(
	line: string,
	group: { current: string | null },
	groups: Map<string, Set<string>>,
	duplicates: string[],
): void {
	if (line.startsWith("**")) {
		const next = groupOf(line);
		if (next !== null && !groups.has(next)) groups.set(next, new Set());
		group.current = next;
		return;
	}
	if (group.current === null) return;
	const key = line.match(/^\|\s*`([^`]+)`\s*\|/u)?.[1];
	if (key === undefined) return;
	const keys = groups.get(group.current);
	if (keys === undefined) return;
	if (keys.has(key)) duplicates.push(`${group.current} -> ${key}`);
	keys.add(key);
}

describe("the configuration guide documentation", () => {
	const parsed = validateConfig(parseToml(exampleToml()));

	test("the complete example is a config the reader accepts", () => {
		expect(() => validateConfig(parseToml(configToToml(parsed)))).not.toThrow();
	});

	test("the example and the key reference agree key for key", () => {
		const example = exampleGroups(parseToml(exampleToml()));
		const { groups: reference } = referenceGroups();
		expect([...reference.keys()].sort()).toEqual([...example.keys()].sort());
		for (const [group, keys] of reference) {
			expect(
				[...keys].sort(),
				`the key reference and the complete example disagree about [${group}]`,
			).toEqual([...(example.get(group) ?? [])].sort());
		}
	});

	test("the key reference names each key once per group", () => {
		// A set comparison absorbs a key row that appears twice, so the
		// "agree line for line" claim needs the uniqueness on its own: two
		// rows for one key can carry two different behaviors.
		expect(referenceGroups().duplicates).toEqual([]);
	});

	test("the example carries the task profile and the default model", () => {
		// The keys this feature added: a reader that lost one of them would
		// drop the values a Task type and the config top level name.
		expect(parsed.defaultModel).toBe("anthropic/claude-opus-4-6");
		expect(parsed.taskTypes.implement).toMatchObject({ agent: "pi", model: expect.any(String) });
		expect(parsed.taskTypes.review).toMatchObject({
			agent: "codex",
			// The profile's context window resolves onto the agent its own
			// profile names, which is the pair a reader copies.
			contextWindow: "272000",
		});
	});
});
