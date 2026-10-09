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
 *    still rather than cleaned here. Issue #301 answered each of the 14 names the
 *    branch that added the check measured, and the list stands empty: 13 are
 *    reached through a value the plane calls, and the suite that drives that value
 *    now names the type at the seam (the module map names the call site); one,
 *    `UnreachedOutcome` in `attempt-hold.ts`, types a field of its own module's
 *    record and is module-private now. A domain type neither side names is
 *    therefore refused outright until it is read, made private, or written into
 *    the list with the reason it stays exported. Each entry carries that reason
 *    as a field the check reads, so an entry without one is refused too: the
 *    reason is not a comment left for a reviewer to catch.
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
 * asks for by name. Each entry carries the name and the reason it stays
 * exported with no reader, and the list can only shrink: a name that stops
 * being unread fails the check until it is removed.
 *
 * The list stands empty since issue #301 answered the 14 names the branch that
 * added the check measured. It stays as the ratchet: a new domain type neither
 * side names goes red until a reader asks for it by name, until the module keeps
 * it privately, or until it is written here with its reason. A caller can hold
 * such a type without naming it, because the value it reads carries the shape,
 * so an unread type name is not proof of a dead export the way an unread value
 * is. That is why the list is the escape hatch and the two rules above stay the
 * strict ones.
 */
const UNREAD_TYPE_BASELINE: readonly { readonly name: string; readonly reason: string }[] = [];

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
			for (const name of importPartNames(entry)) names.add(name);
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

/** The names one import clause part asks for, with `type` and `as` resolved. */
function importPartNames(entry: string): string[] {
	const names: string[] = [];
	const bits = entry.split(/\s+as\s+/);
	const exported = (bits[0] ?? "").trim().replace(/^type\s+/, "");
	const local = (bits[bits.length - 1] ?? "").trim().replace(/^type\s+/, "");
	if (exported) {
		names.push(exported);
	}
	// `import { a as b }` binds `b`, and the file may read the value
	// through that name alone.
	if (bits.length > 1 && local) {
		names.push(local);
	}
	return names;
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
		for (const module of domainFiles) offenders.push(...unreadValueOffenders(module));
		expect(offenders).toEqual([]);
	});

	/** The domain value exports one module leaves unread by the plane and its tests. */
	function unreadValueOffenders(module: string): string[] {
		const offenders: string[] = [];
		const { src, test, namespace } = readersOf(module);
		if (namespace) {
			return offenders;
		}
		for (const exp of exportsOf(readFileSync(module, "utf8"))) {
			if (!VALUE_KINDS.has(exp.kind)) {
				continue;
			}
			if (!src.has(exp.name) && !test.has(exp.name)) {
				offenders.push(`${module} :: ${exp.name} (${exp.kind})`);
			}
		}
		return offenders;
	}

	test("no domain export is an alias of another export of its own module", () => {
		const offenders: string[] = [];
		for (const module of domainFiles) offenders.push(...moduleAliasOffenders(module));
		expect(offenders).toEqual([]);
	});

	/** The domain exports one module aliases onto its own exports. */
	function moduleAliasOffenders(module: string): string[] {
		const offenders: string[] = [];
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
			reExportAliasOffenders(module, source, own, { name: exp.name, offenders });
		}
		return offenders;
	}

	/** The re-exports one module's braces alias onto its own exports. */
	function reExportAliasOffenders(
		module: string,
		source: string,
		own: Set<string>,
		fields: { name: string; offenders: string[] },
	): void {
		const { name, offenders } = fields;
		for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
			for (const part of match[1].split(",")) {
				const bits = part.trim().split(/\s+as\s+/);
				if (
					bits.length === 2 &&
					bits[0].trim() === name &&
					own.has(bits[1].trim()) &&
					bits[0].trim() !== bits[1].trim()
				) {
					offenders.push(`${module} :: ${bits[1].trim()} aliases ${bits[0].trim()}`);
				}
			}
		}
	}

	test("the unread domain types stay the list the check already holds", () => {
		// The list stands empty since issue #301, so this is the strict form of the
		// ratchet: a domain type neither side names is refused, and a name written
		// into the list that has a reader is refused the other way.
		const unread: string[] = [];
		for (const module of domainFiles) unread.push(...unreadTypeNames(module));
		expect(unread.sort()).toEqual(UNREAD_TYPE_BASELINE.map((entry) => entry.name).sort());
	});

	/** The domain type exports one module leaves unread by the plane and its tests. */
	function unreadTypeNames(module: string): string[] {
		const unread: string[] = [];
		const { src, test, namespace } = readersOf(module);
		if (namespace) {
			return unread;
		}
		for (const exp of exportsOf(readFileSync(module, "utf8"))) {
			if (!TYPE_KINDS.has(exp.kind)) {
				continue;
			}
			if (!src.has(exp.name) && !test.has(exp.name)) {
				unread.push(`${module} :: ${exp.name} (${exp.kind})`);
			}
		}
		return unread;
	}

	test("every baseline entry states the reason it stays exported", () => {
		// The reason is a field the check reads, not a comment beside the name: an
		// entry that names a type and leaves the reason blank is refused, so the
		// escape hatch cannot be taken without writing down why it is taken.
		const nameless = UNREAD_TYPE_BASELINE.filter((entry) => entry.reason.trim() === "").map(
			(entry) => entry.name,
		);
		expect(nameless).toEqual([]);
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
 *   added to a list that stands empty, and the only way it turns green is writing
 *   the name into `UNREAD_TYPE_BASELINE`, which is the point.
 * - Probe D, rule 3 the other way: write
 *   `{ name: "src/domain/top-up.ts :: AutomaticHold (interface)", reason: "the walk holds it" }`
 *   into `UNREAD_TYPE_BASELINE`. `AutomaticHold` has readers, so the ratchet case
 *   goes red with that one name on the list side and nothing on the unread side.
 *   The list can only shrink, and a stale entry is refused with it.
 * - Probe E, the reason field: run probe C's `ABrandNewUnreadType` and write
 *   `{ name: "src/domain/top-up.ts :: ABrandNewUnreadType (interface)", reason: "" }`
 *   into `UNREAD_TYPE_BASELINE`. The ratchet case goes green, because the name is
 *   on the list, and the reason case goes red with that one name. An entry cannot
 *   be taken without its reason.
 */
