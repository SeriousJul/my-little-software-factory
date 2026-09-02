/**
 * The README's configuration documentation is a contract, so it is tested.
 *
 * The complete example claims it "sets every key the control plane reads,
 * optional keys included, so the example and the key reference agree line for
 * line". These checks hold that claim: the example must stay a config the
 * reader accepts, and its key set must match the reference table for every
 * group. A new config key that lands in one of the two and not the other
 * fails here, which is how a documented feature and a shipped feature drift
 * apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vitest";
import { configToToml, validateConfig } from "../src/config.ts";

const README = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");

/** The fenced toml block under the "Complete example" heading. */
function exampleToml(): string {
	const heading = README.indexOf("### Complete example");
	const start = README.indexOf("```toml", heading);
	const end = README.indexOf("```", start + "```toml".length);
	expect(start, "the README has no complete config example").toBeGreaterThan(-1);
	return README.slice(start + "```toml".length, end);
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
	// An array-of-tables group: [[workflows]], [[sources]], and
	// [[task-rules]]. Their entries carry the group's keys.
	const tableArrays = new Set(["workflows", "sources", "task-rules"]);
	for (const [key, value] of Object.entries(config)) {
		add("top", key);
		if (key === "scroll" && typeof value === "object" && value !== null) {
			for (const inner of Object.keys(value as Record<string, unknown>)) add("scroll", inner);
			continue;
		}
		if (namedTables.has(key) && typeof value === "object" && value !== null) {
			for (const table of Object.values(value as Record<string, unknown>)) {
				if (typeof table !== "object" || table === null) continue;
				for (const inner of Object.keys(table)) add(key, inner);
			}
			continue;
		}
		if (tableArrays.has(key) && Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry !== "object" || entry === null) continue;
				for (const [inner, innerValue] of Object.entries(entry)) {
					add(key, inner);
					// [task-rules.when] documents its conditions as their own
					// group, so its keys go there and not under the rule.
					if (inner === "when" && typeof innerValue === "object" && innerValue !== null) {
						for (const condition of Object.keys(innerValue as Record<string, unknown>)) {
							add("task-rules.when", condition);
						}
					}
				}
			}
		}
	}
	return groups;
}

/** The group name a reference heading names: `Top level.` becomes `top`. */
function groupOf(heading: string): string | null {
	if (heading.startsWith("**Top level.")) return "top";
	// A heading names its table in code span: **`[agents.<name>]`**,
	// **`[[workflows]]`**. The trailing prose is part of the same line.
	const table = heading.replace(/^\*\*/u, "").match(/^`\[+([^\]`]+)\]/u);
	if (table === null) return null;
	return table[1].replace(/\.<name>$/u, "");
}

/** The key paths the "Key reference" section documents, by group. */
function referenceGroups(): Map<string, Set<string>> {
	const start = README.indexOf("### Key reference");
	const end = README.indexOf("\n## ", start);
	const section = README.slice(start, end < 0 ? README.length : end);
	const groups = new Map<string, Set<string>>();
	let group: string | null = null;
	for (const line of section.split("\n")) {
		if (line.startsWith("**")) {
			group = groupOf(line);
			if (group !== null && !groups.has(group)) groups.set(group, new Set());
			continue;
		}
		if (group === null) continue;
		const key = line.match(/^\|\s*`([^`]+)`\s*\|/u)?.[1];
		if (key === undefined) continue;
		groups.get(group)?.add(key);
	}
	// A heading with no rows documents itself in prose: [repos] holds
	// repository identities, so it has no fixed key names to compare.
	for (const [group, keys] of [...groups]) if (keys.size === 0) groups.delete(group);
	return groups;
}

describe("the README configuration documentation", () => {
	const parsed = validateConfig(parseToml(exampleToml()));

	test("the complete example is a config the reader accepts", () => {
		expect(() => validateConfig(parseToml(configToToml(parsed)))).not.toThrow();
	});

	test("the example and the key reference agree key for key", () => {
		const example = exampleGroups(parseToml(exampleToml()));
		const reference = referenceGroups();
		expect([...reference.keys()].sort()).toEqual([...example.keys()].sort());
		for (const [group, keys] of reference) {
			expect(
				[...keys].sort(),
				`the key reference and the complete example disagree about [${group}]`,
			).toEqual([...(example.get(group) ?? [])].sort());
		}
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
