/**
 * A rule module exports what a caller reads (issue #223 review, ADR 0105).
 *
 * `src/domain/` holds the plane's rules, and its interface is what the rest of
 * the plane asks. An export nobody asks is one of two things, and both cost the
 * next reader: a value the module uses itself and hands out anyway, which reads
 * as a rule with a caller the reader cannot find; and an alias of another export
 * of the same module, which is one question with two answers. The review of #223
 * found the second shape standing in this very directory: `topUpCycleOpen` was a
 * pure wrapper of `freshWorkHold`, called by no `src` file and by nine tests, and
 * it survived a rename only because the tests kept the old name alive.
 *
 * Three rules, and the third is deliberately weaker than the first two:
 *
 * 1. A value export (`const`, `let`, `var`, `function`, `class`) in
 *    `src/domain/**` is read by some file under `src/` outside its own module,
 *    or by a test that asks for it by name. Neither, and it is refused: the
 *    module keeps the value and drops the `export`.
 * 2. An export that is a pure alias of another export of the same module is
 *    refused, whether or not a test reads it. This is the shape rule 1 cannot
 *    see, because the alias has readers.
 * 3. A type or interface export read by neither `src/` nor `test/` is allowed
 *    only while it stands in `UNREAD_TYPE_BASELINE` beside its module. A new one
 *    is refused, and a name that no longer needs the list is refused too, so the
 *    list can only shrink. A type is a module's interface vocabulary, and the
 *    seams `docs/agents/shape.md` documents lean on it, so this class is held
 *    still rather than cleaned here. The 14 names measured on the branch that
 *    added the check are filed as issue #301, which states the three answers each
 *    one can get.
 *
 * The rule is a declared dependency rule, not a behavior test: what the operator
 * sees is checked by the flow suites.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sourceFiles } from "./static-checks.ts";

/** The rule modules the check reads. */
const DOMAIN = "src/domain";

/**
 * A type or interface export in `src/domain/**` that neither `src/` nor `test/`
 * asks for by name. Each entry is the module and the name, and the list can only
 * shrink: a name that stops being unread fails the check until it is removed.
 *
 * These are the 14 measured on the branch that added the check. A caller can
 * hold one of these without naming it, because the value it reads carries the
 * shape, so an unread type name is not proof of a dead export the way an unread
 * value is. That is why this class is held still here and policed by the two
 * rules above instead.
 */
const UNREAD_TYPE_BASELINE: string[] = [
	"src/domain/agent.ts :: AgentStatus (type)",
	"src/domain/attempt-hold.ts :: UnreachedOutcome (type)",
	"src/domain/decision-facts.ts :: DecisionFacts (interface)",
	"src/domain/decision-facts.ts :: DecisionOffer (type)",
	"src/domain/section-facts.ts :: SectionFacts (interface)",
	"src/domain/ticket.ts :: TicketIgnoreFacts (interface)",
	"src/domain/top-up.ts :: AutomaticAddFacts (interface)",
	"src/domain/top-up.ts :: AutomaticBareHold (interface)",
	"src/domain/top-up.ts :: AutomaticHoldReason (type)",
	"src/domain/top-up.ts :: AutomaticRowHold (interface)",
	"src/domain/top-up.ts :: AutomaticRowHoldReason (type)",
	"src/domain/top-up.ts :: ContinuationRowFacts (interface)",
	"src/domain/top-up.ts :: OpenTicketRowGate (type)",
	"src/domain/top-up.ts :: OpenTicketWaitsFacts (interface)",
];

/** The value export kinds rule 1 polices. */
const VALUE_KINDS = new Set(["const", "let", "var", "function", "class"]);

/** The type export kinds rule 3 ratchets. */
const TYPE_KINDS = new Set(["type", "interface", "enum"]);

type Export = { name: string; kind: string; line: string };

/** Every export of one module, with its kind and the line that declares it. */
function exportsOf(source: string): Export[] {
	const found: Export[] = [];
	for (const match of source.matchAll(
		/^export\s+(?:(?:async|declare|abstract)\s+)?(const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)[^\n]*/gm,
	)) {
		found.push({ name: match[2], kind: match[1], line: match[0] });
	}
	for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const part of match[1].split(",")) {
			const entry = part.trim();
			if (!entry) {
				continue;
			}
			const bits = entry.split(/\s+as\s+/);
			const exported = (bits[bits.length - 1] ?? "").trim().replace(/^type\s+/, "");
			if (exported) {
				found.push({ name: exported, kind: "re-export", line: entry });
			}
		}
	}
	return found;
}

type Import = { specifier: string; names: Set<string> | null };

/**
 * Every import in one file. `names` is the set of names the file asks for, with
 * `type` markers and `as` renames resolved to the exported name; `null` is a
 * namespace import, which asks for the whole module.
 */
function importsOf(source: string): Import[] {
	const found: Import[] = [];
	for (const match of source.matchAll(
		/import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g,
	)) {
		const names = new Set<string>();
		for (const part of match[1].split(",")) {
			const entry = part.trim();
			if (!entry) {
				continue;
			}
			const bits = entry.split(/\s+as\s+/);
			const exported = (bits[0] ?? "").trim().replace(/^type\s+/, "");
			const local = (bits[bits.length - 1] ?? "").trim().replace(/^type\s+/, "");
			if (exported) {
				names.add(exported);
			}
			// `import { a as b }` binds `b`, and the file may read the value
			// through that name alone.
			if (bits.length > 1 && local) {
				names.add(local);
			}
		}
		found.push({ specifier: match[2], names });
	}
	for (const match of source.matchAll(
		/import\s+(?:type\s+)?\*\s*as\s*[A-Za-z_$][\w$]*\s*from\s*["']([^"']+)["']/g,
	)) {
		found.push({ specifier: match[1], names: null });
	}
	return found;
}

/** Whether an import specifier, resolved against its file, names `module`. */
function namesModule(importer: string, specifier: string, module: string): boolean {
	if (!specifier.startsWith(".")) {
		return false;
	}
	const target = resolve(dirname(importer), specifier).slice(resolve(process.cwd()).length + 1);
	return target.replace(/\.tsx?$/, "") === module.replace(/\.tsx?$/, "");
}

const domainFiles = sourceFiles(DOMAIN);
const srcFiles = sourceFiles("src");
const testFiles = sourceFiles("test");

/** The names `module` exports that some other file asks for, split by reader. */
function readersOf(module: string): { src: Set<string>; test: Set<string>; namespace: boolean } {
	const src = new Set<string>();
	const test = new Set<string>();
	let namespace = false;
	const read = (file: string, into: Set<string>) => {
		for (const imp of importsOf(readFileSync(file, "utf8"))) {
			if (!namesModule(file, imp.specifier, module)) {
				continue;
			}
			if (imp.names === null) {
				namespace = true;
				continue;
			}
			for (const name of imp.names) {
				into.add(name);
			}
		}
	};
	for (const file of srcFiles) {
		if (file !== module) {
			read(file, src);
		}
	}
	for (const file of testFiles) {
		read(file, test);
	}
	return { src, test, namespace };
}

describe("a domain export is read, or it is not an export", () => {
	test("every domain module is read by the check", () => {
		// The check is only worth the modules it walks, so the walk is stated.
		expect(domainFiles.length).toBeGreaterThanOrEqual(10);
	});

	test("no domain value export stands unread by the plane and its tests", () => {
		const offenders: string[] = [];
		for (const module of domainFiles) {
			const { src, test, namespace } = readersOf(module);
			if (namespace) {
				continue;
			}
			for (const exp of exportsOf(readFileSync(module, "utf8"))) {
				if (!VALUE_KINDS.has(exp.kind)) {
					continue;
				}
				if (!src.has(exp.name) && !test.has(exp.name)) {
					offenders.push(`${module} :: ${exp.name} (${exp.kind})`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no domain export is an alias of another export of its own module", () => {
		const offenders: string[] = [];
		for (const module of domainFiles) {
			const source = readFileSync(module, "utf8");
			const own = new Set(exportsOf(source).map((exp) => exp.name));
			for (const exp of exportsOf(source)) {
				// `export const held = freshWorkHold;` and
				// `export { freshWorkHold as held };` are one question with two
				// answers, whatever name either one carries.
				const valueAlias = new RegExp(
					`^export\\s+const\\s+${exp.name}\\s*(?::[^=]+)?=\\s*([A-Za-z_$][\\w$]*)\\s*;?$`,
				).exec(exp.line);
				if (valueAlias && own.has(valueAlias[1]) && valueAlias[1] !== exp.name) {
					offenders.push(`${module} :: ${exp.name} aliases ${valueAlias[1]}`);
				}
				for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
					for (const part of match[1].split(",")) {
						const bits = part.trim().split(/\s+as\s+/);
						if (
							bits.length === 2 &&
							bits[0].trim() === exp.name &&
							own.has(bits[1].trim()) &&
							bits[0].trim() !== bits[1].trim()
						) {
							offenders.push(`${module} :: ${bits[1].trim()} aliases ${bits[0].trim()}`);
						}
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the unread domain types stay the list the check already holds", () => {
		const unread: string[] = [];
		for (const module of domainFiles) {
			const { src, test, namespace } = readersOf(module);
			if (namespace) {
				continue;
			}
			for (const exp of exportsOf(readFileSync(module, "utf8"))) {
				if (!TYPE_KINDS.has(exp.kind)) {
					continue;
				}
				if (!src.has(exp.name) && !test.has(exp.name)) {
					unread.push(`${module} :: ${exp.name} (${exp.kind})`);
				}
			}
		}
		expect(unread.sort()).toEqual(UNREAD_TYPE_BASELINE.slice().sort());
	});
});

/**
 * The probes the quality gate's probe rule asks for, written as steps and each
 * re-run on the tree, by hand:
 *
 * - Probe A, rule 1: add `export const anUnreadRule = () => true;` to any file
 *   under `src/domain/`. The value-export case goes red with that one line, and
 *   nothing else moves.
 * - Probe B, rule 2: add `export const freshWorkHoldAlias = freshWorkHold;` to
 *   `src/domain/top-up.ts`, the exact shape the #223 review found. The alias case
 *   goes red and names both sides. A test that reads the alias does not save it:
 *   rule 2 does not ask whether it has readers.
 * - Probe C, rule 3: add `export interface ABrandNewUnreadType { readonly a: 1 }`
 *   to any file under `src/domain/`. The ratchet case goes red with that one name
 *   added, and the only way it turns green is writing the name into
 *   `UNREAD_TYPE_BASELINE`, which is the point.
 */
