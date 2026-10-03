/**
 * The state module's boundary: one interface per aggregate (issue #202,
 * ADR 0095).
 *
 * Ten declared dependency rules hold it:
 *
 * 1. No caller outside the open path holds the whole composition. It does not
 *    import `FactoryState`, it does not open the state file itself, and it does
 *    not name every aggregate - which is what holding the composition looks
 *    like from the outside whatever name the caller bound it to.
 * 2. Every aggregate a caller reads is one the caller names. The rule follows
 *    the call, not one fixed variable name: a caller that reaches `.handoff.`
 *    through a deps object, a field, or a name of its own still has to name
 *    `HandoffAggregate`. The rule reads the aggregate's method name as well as
 *    the access in front of it, so a caller that binds `state.sourceFact` to
 *    `this.sf` and calls `this.sf.initializeSources(...)` is named: the method
 *    is the aggregate's, and the aggregate's name is gone from the file. The
 *    name a caller may lean on is the name that caller's own file declares,
 *    never the union of names every caller declares (issue #202 review); the
 *    few call sites the rule cannot read on its own are written in
 *    `NAME_ALLOWANCE` beside the reason.
 * 3. A caller holds an aggregate under the aggregate's own name. A field, a
 *    variable, a parameter, a getter, a destructured entry, or a function's
 *    return value that carries a `<Aggregate>` type under another name is the
 *    alias rule 2 cannot see once the call moves behind it, so the alias itself
 *    is refused. A method pulled out of the aggregate as a value - a destructured
 *    entry, a `.bind`, a method handed to a function - is the same hole read from
 *    the other end: no `.<aggregate>.<method>` call is left for rule 2 to see, so
 *    the pull is refused where it happens (issue #202 review).
 * 4. Inside the module, an aggregate reaches only the tables it owns, and every
 *    table the schema creates has exactly one owner. A table no aggregate
 *    claims is a table nobody is answerable for, and it fails here.
 * 5. An aggregate's internal operations - the methods it publishes to the
 *    module for another aggregate to call - stay inside the module.
 * 6. No caller outside the module imports the store, the composition, the
 *    ownership map, the migration chain, the batch helper, or the JSON decoders.
 *    Those are how a scope over an arbitrary table gets built, so the door the
 *    first four rules close is not left open by an import.
 * 7. An operation another aggregate calls never opens a transaction. The file
 *    holds one write transaction at a time, so the first cross-aggregate call
 *    to a transactional method would fail inside the caller's own transaction.
 *    The rule reads the whole far side of a `graph().<aggregate>.<method>` call
 *    - the method's own body, every method it calls on itself through `this.`,
 *    and every method it reaches in a third aggregate through `graph()`
 *    (issue #202, ADR 0095).
 * 8. An operation an aggregate publishes to the module never opens a
 *    transaction, read the same transitive way.
 * 9. Every method an aggregate's interface declares is reached - by a caller in
 *    the plane, by another aggregate across the boundary, or by the aggregate's
 *    own tests. A method no one reaches is neither the contract nor the test
 *    surface, and it is the interface carrying plumbing the split exists to
 *    remove (issue #202 review).
 * 10. The auto top-up's walk takes a fact it cannot read off the row it holds as
 *    one read for the list it walks. A per-candidate read of the state module
 *    costs a statement for every Ticket the walk passes, which is the read-shape
 *    line ADR 0095 holds (issue #202 review).
 *
 * The open path is the one exception to the first two rules: it opens the file,
 * takes the lease, and closes it, so it holds the whole composition.
 *
 * Rule 4 also stands at runtime: the store hands each aggregate a statement
 * handle scoped to its own tables (src/state/tables.ts), so a statement built
 * from a variable is refused when it is prepared. The check reads the same
 * matcher the runtime uses, and it catches what the runtime handle cannot: a
 * new table nobody owns. `test/state/seam.test.ts` shows the runtime refusal.
 *
 * The rules read the source; they are not behavior tests. What the operator
 * sees is checked by the flow tests that drive the real screens. The last three
 * tests run the rules over probe sources, so a shape the rules are meant to
 * refuse is measured here instead of confirmed by hand and forgotten.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openStore } from "../src/state/store.ts";
import { RETIRED_TABLES, SEAM_TABLES, TABLES_OWNED, tablesNamed } from "../src/state/tables.ts";
import { cleanup, statePath } from "./state/harness.ts";
import { sourceFiles } from "./static-checks.ts";

/** The open path: it opens the file, takes the lease, and closes it, so it
 * holds the whole composition. Every other caller names its own list. */
const OPEN_PATH = "src/startup.ts";

/** The open seam: it is not a caller, but it does reach the aggregates. */
const OPEN_SEAM = "src/state.ts";

const AGGREGATE_KEYS = Object.keys(TABLES_OWNED) as readonly (keyof typeof TABLES_OWNED)[];

/** The ownership map, read as sets. */
const OWNED: Record<string, ReadonlySet<string>> = Object.fromEntries(
	Object.entries(TABLES_OWNED).map(([key, tables]) => [key, new Set<string>(tables)]),
);

const CALLERS = sourceFiles("src", (file) => !file.startsWith("src/state/") && file !== OPEN_SEAM);

/** The plane's tests. This file is not one of them: its probe sources name
 * aggregate methods on purpose, and a probe is not a reach. */
const TEST_FILES = sourceFiles("test").filter((file) => file !== "test/state-architecture.test.ts");

function aggregateFile(key: string): string {
	return `src/state/${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}.ts`;
}

/** Read a production source. The rules read the file a shape names, and a
 * probe rule swaps this out for the text it wants measured. */
function moduleSource(file: string): string {
	return readFileSync(file, "utf8");
}

/** One aggregate's declared shapes: its interface's methods and the public
 * methods its module holds beyond that interface. */
interface AggregateShape {
	key: string;
	interfaceName: string;
	file: string;
	interfaceMethods: Set<string>;
	internalMethods: Set<string>;
	privateMethods: Set<string>;
}

let shapeCache: AggregateShape[] | null = null;

function aggregateShapes(): AggregateShape[] {
	if (shapeCache !== null) return shapeCache;
	const shapes: AggregateShape[] = [];
	for (const key of AGGREGATE_KEYS) {
		const file = aggregateFile(key);
		const source = moduleSource(file);
		const interfaceName = `${key.charAt(0).toUpperCase()}${key.slice(1)}Aggregate`;
		const interfaceStart = source.indexOf(`export interface ${interfaceName} {`);
		if (interfaceStart < 0) throw new Error(`${file} declares no ${interfaceName}`);
		const interfaceBody = source.slice(interfaceStart, source.indexOf("\n}", interfaceStart));
		const interfaceMethods = new Set(
			[...interfaceBody.matchAll(/^\t(\w+)\(/gmu)].map((match) => match[1]),
		);
		const classStart = source.indexOf(
			`export class ${interfaceName.replace("Aggregate", "Module")}`,
		);
		if (classStart < 0) throw new Error(`${file} declares no module class`);
		const classBody = source.slice(classStart);
		const publicMethods = new Set(
			[...classBody.matchAll(/^\t(?!private\s)(\w+)\(/gmu)]
				.map((match) => match[1])
				.filter((name) => name !== "constructor"),
		);
		const privateMethods = new Set(
			[...classBody.matchAll(/^\tprivate\s+(\w+)\(/gmu)].map((match) => match[1]),
		);
		shapes.push({
			key,
			interfaceName,
			file,
			interfaceMethods,
			internalMethods: new Set([...publicMethods].filter((name) => !interfaceMethods.has(name))),
			privateMethods,
		});
	}
	shapeCache = shapes;
	return shapes;
}

let shapeKeyCache: Map<string, AggregateShape> | null = null;

function shapeByKey(): Map<string, AggregateShape> {
	if (shapeKeyCache === null) shapeKeyCache = new Map(aggregateShapes().map((s) => [s.key, s]));
	return shapeKeyCache;
}

/** The state module's own plumbing: no caller outside the module imports it. */
const MODULE_INNERS = /(?:^|\/)state\/(store|graph|tables|schema|batch|json)\.ts$/u;

/**
 * The SQL a module holds: the text inside every string literal in its source,
 * one entry per literal.
 *
 * A comment is not a statement, and neither is an identifier, so the table
 * rule reads only the text a `prepare` or an `exec` can be handed. A comment
 * that names another aggregate's table says something; it does not reach it.
 * A literal's own delimiters are stripped, because the rule then reads a
 * statement the way the running handle does: SQL written in a single-quoted
 * string is read as its text, and a single quote inside it is the SQL's own
 * quoted value, which `tablesNamed` blanks out. Each literal is read on its
 * own, so an apostrophe in one message cannot blank the text of the next.
 */
function sqlLiterals(source: string): string[] {
	const literals: string[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === "/" && source[index + 1] === "/") {
			while (index < source.length && source[index] !== "\n") index++;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let end = index + 1;
			while (end < source.length) {
				if (source[end] === "\\") {
					end += 2;
					continue;
				}
				if (source[end] === char) {
					end += 1;
					break;
				}
				end += 1;
			}
			literals.push(source.slice(index + 1, end - 1));
			index = end;
			continue;
		}
		index += 1;
	}
	return literals;
}

/**
 * One class member's own text: its signature line through the line before the
 * next member at the same level. Body lines are indented deeper, so a call
 * inside a body never ends the chunk. The search starts at the module class,
 * because an interface declares the same method name and holds no body. null
 * when the module holds no such member - a `this.` call may name a field that
 * holds a function, and the transaction walk follows a member it can find.
 */
function memberChunk(source: string, name: string): string | null {
	const lines = source.split("\n");
	const classStart = lines.findIndex((line) => /^export class [A-Za-z_$][\w$]*\b/u.test(line));
	const member = new RegExp(`^\\t(?:private\\s+|async\\s+)*${name}\\s*[({=]`, "u");
	const start = lines.findIndex((line, index) => index > classStart && member.test(line));
	if (start < 0) return null;
	for (let index = start + 1; index < lines.length; index++) {
		if (
			/^\t(?:private\s+|readonly\s+|static\s+|async\s+)*[A-Za-z_$][\w$]*\s*[({=]/u.test(
				lines[index],
			)
		)
			return lines.slice(start, index).join("\n");
		if (lines[index] === "}") return lines.slice(start, index).join("\n");
	}
	return lines.slice(start).join("\n");
}

/** How many times a pattern matches in the source. */
function countMatches(source: string, pattern: RegExp): number {
	return [...source.matchAll(pattern)].length;
}

/**
 * The tables one module's source reaches: every literal it could hand a
 * `prepare` or an `exec`, read with the store's own matcher.
 */
function tableReaches(source: string): string[] {
	return sqlLiterals(source).flatMap((sql) => tablesNamed(sql));
}

/**
 * The source with every comment blanked to spaces and every string literal
 * left alone. The call rules read code, not prose: a comment between an
 * aggregate and its method is not a break in the call, and a commented-out
 * call is not a call.
 */
function codeOnly(source: string): string {
	let code = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === "/" && source[index + 1] === "/") {
			while (index < source.length && source[index] !== "\n") {
				code += " ";
				index += 1;
			}
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			const stop = end < 0 ? source.length : end + 2;
			for (const char of source.slice(index, stop)) code += char === "\n" ? "\n" : " ";
			index = stop;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let end = index + 1;
			while (end < source.length) {
				if (source[end] === "\\") {
					end += 2;
					continue;
				}
				if (source[end] === char) {
					end += 1;
					break;
				}
				end += 1;
			}
			code += source.slice(index, end);
			index = end;
			continue;
		}
		code += char;
		index += 1;
	}
	return code;
}

/** The words that open a control, not a declaration. */
const KEYWORDS = new Set([
	"await",
	"case",
	"catch",
	"do",
	"else",
	"for",
	"if",
	"import",
	"new",
	"return",
	"switch",
	"throw",
	"typeof",
	"var",
	"while",
	"yield",
]);

/**
 * The callables one caller file declares for itself: a method, a function, a
 * getter, or a bound arrow. The name is followed by its parameter list and
 * then by a body, a return type, or an arrow, so a call standing at the front
 * of a statement is not a declaration, and an object property or a props field
 * is not one either.
 */
function declaredNames(source: string): Set<string> {
	const names = new Set<string>();
	for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*\(/gmu)) {
		const name = match[1];
		if (KEYWORDS.has(name)) continue;
		// A call reached through a dot is somebody else's method.
		const before = source.slice(0, match.index).trimEnd();
		if (before.endsWith(".") || before.endsWith("this")) continue;
		// Walk the parameter list to its close, then read what follows it.
		let index = match.index + match[0].length;
		let depth = 1;
		while (index < source.length && depth > 0) {
			const char = source[index];
			if (char === "(") depth += 1;
			else if (char === ")") depth -= 1;
			else if (char === '"' || char === "'" || char === "`") {
				index += 1;
				while (index < source.length && source[index] !== char) {
					if (source[index] === "\\") index += 1;
					index += 1;
				}
			}
			index += 1;
		}
		const after = source.slice(index, index + 40).trimStart();
		if (/^[{:]|^=>/.test(after)) names.add(name);
	}
	return names;
}

/** The names a caller imports from the state module's aggregate files. */
function namedInterfaces(source: string): Set<string> {
	const named = new Set<string>();
	for (const match of source.matchAll(/import type \{([^}]*)\} from "[^"]*state\//gmu)) {
		for (const name of match[1].split(",").map((part) => part.trim())) named.add(name);
	}
	for (const match of source.matchAll(/import type \{([^}]*)\} from "[^"]*\/state\.ts"/gmu)) {
		for (const name of match[1].split(",").map((part) => part.trim())) named.add(name);
	}
	return named;
}

/**
 * The call sites the bare-method-name rule cannot read on its own, recorded per
 * file with the reason (issue #202 review). Each one is a method the caller
 * file does not reach through the aggregate's name, and the file either declares
 * that name for itself or reaches it through a module the plane owns outside the
 * state module. The boundary test asserts the allowances a run leans on are
 * exactly this list, so the list cannot gather allowances nobody uses and a new
 * hole has to be written here to be allowed.
 */
const NAME_ALLOWANCE: Record<string, string> = {
	"src/components/app.ts ticketWorkCycle.closeWorkCycle":
		"the Handoff dispatch module's own closeWorkCycle, reached through the dispatch field",
	"src/handoff-dispatch.ts workQueue.enqueueWork":
		"the dispatch's own enqueueWork, declared in the same file beside the queue's enqueueWork it calls",
};

/** Rule 1: no caller outside the open path holds the whole composition. */
function compositionOffenders(file: string, source: string, shapes: AggregateShape[]): string[] {
	const offenders: string[] = [];
	// The composition module is the only thing that hands a caller every
	// aggregate. Importing from it is the hold whatever name the caller
	// bound the import to, so the rule reads the import and not the name.
	if (/^import\b[^\n]*from\s*"[^"]*state\.ts"/mu.test(source))
		offenders.push(`${file} imports the composed state`);
	if (/\bopenFactoryState\s*\(/u.test(source))
		offenders.push(`${file} opens the state file itself`);
	const named = namedInterfaces(source);
	const namedAggregates = shapes.filter((shape) => named.has(shape.interfaceName));
	if (namedAggregates.length === shapes.length)
		offenders.push(`${file} names every aggregate, which is the composition`);
	return offenders;
}

interface NamingFacts {
	offenders: string[];
	/** The caller/aggregate pairs the rule saw a read of. */
	reads: Set<string>;
	/** The allowances this run actually leaned on. */
	allowed: Set<string>;
}

/** Rule 2: every aggregate a caller reads is one the caller names. */
function namingOffenders(file: string, source: string, shapes: AggregateShape[]): NamingFacts {
	// A method name this file declares for itself is this file's own, so it is
	// not read as an aggregate reached through another name. The set is the
	// file's, never the union over every caller (issue #202 review).
	const owned = declaredNames(source);
	const named = namedInterfaces(source);
	const offenders: string[] = [];
	const reads = new Set<string>();
	const allowed = new Set<string>();
	for (const shape of shapes) {
		// The call is what counts, whatever the caller called the state.
		// A method name is part of the match so a domain object's own
		// field is not mistaken for an aggregate.
		for (const method of shape.interfaceMethods) {
			const call = new RegExp(`\\.${shape.key}\\.${method}\\s*\\(`, "gu");
			if (!call.test(source)) continue;
			reads.add(`${file} reads ${shape.key}`);
			if (!named.has(shape.interfaceName))
				offenders.push(
					`${file} calls ${shape.key}.${method} without naming ${shape.interfaceName}`,
				);
		}
		// The method name alone is a read too. A caller that holds the
		// aggregate under a name of its own - `this.sf`, a destructured
		// entry, a deps object, a function's return value - calls
		// `this.sf.initializeSources(...)`: the aggregate's name is gone from
		// the file, and the method is the only fact left that says whose it
		// is. Every call of one of the aggregate's own methods has to stand
		// behind the aggregate's name, or the file is named for reading the
		// aggregate without it.
		for (const method of shape.interfaceMethods) {
			const bare = countMatches(source, new RegExp(`\\.${method}\\s*\\(`, "gu"));
			if (bare === 0) continue;
			// A call chain may break the line between the aggregate and its
			// method, so the two names may have whitespace between them.
			const through = countMatches(
				source,
				new RegExp(`\\b${shape.key}\\s*\\.\\s*${method}\\s*\\(`, "gu"),
			);
			if (bare === through) continue;
			reads.add(`${file} reads ${shape.key}`);
			if (owned.has(method)) {
				allowed.add(`${file} ${shape.key}.${method}`);
				continue;
			}
			const allowance = `${file} ${shape.key}.${method}`;
			if (NAME_ALLOWANCE[allowance] !== undefined) {
				allowed.add(allowance);
				continue;
			}
			if (!named.has(shape.interfaceName))
				offenders.push(
					`${file} calls ${shape.key}.${method} through another name without naming ${shape.interfaceName}`,
				);
			else
				offenders.push(
					`${file} calls ${shape.key}.${method} through a name that is not ${shape.key}`,
				);
		}
	}
	return { offenders, reads, allowed };
}

/** Rule 3: a caller holds an aggregate under the aggregate's own name. */
function aliasOffenders(
	file: string,
	source: string,
	shapes: AggregateShape[],
): { offenders: string[]; held: Set<string> } {
	// The alias is what the call rule cannot see once the call moves behind
	// it: `this.sf = state.sourceFact`, `const { handoff: h } = state`, a
	// field declared `sf: SourceFactAggregate`, a function declared
	// `pickHandoff(...): HandoffAggregate`. Each one holds an aggregate under
	// a name the boundary rules do not read, so the alias is refused where it
	// is made (issue #202 review).
	const keys = shapes.map((shape) => shape.key).join("|");
	// The composition is held under a name that says what it is. A hand-over is
	// read out of that root; a domain object's own `ticket.handoff` field is not
	// the composition handing an aggregate over.
	const root = "(?:[A-Za-z_$][\\w$]*\\.)*(?:state|deps|aggregates|composition)\\.";
	const path = "(?:[A-Za-z_$][\\w$]*\\.)*";
	const offenders: string[] = [];
	const held = new Set<string>();
	// A binding whose value is the aggregate itself: the value is a plain
	// path from the composition to the aggregate's name and nothing is
	// called through it. A chain that goes on - `.ticketWorkCycle` with a
	// method after it - reads a fact and is not a hand-over.
	const bind = new RegExp(
		`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${root}${path}(?:${keys})(?![\\w$])(?!\\s*\\.)|` +
			`(?:this|[A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\s*=\\s*${root}${path}(?:${keys})(?![\\w$])(?!\\s*\\.)`,
		"gu",
	);
	for (const match of source.matchAll(bind)) {
		const bound = match[1] ?? match[2] ?? "";
		const key = shapes.find((shape) =>
			new RegExp(`\\.${shape.key}(?![\\w$])`, "gu").test(match[0]),
		);
		if (key === undefined || bound === "" || bound === key.key) continue;
		offenders.push(`${file} binds the ${key.key} aggregate to ${bound}`);
	}
	// A destructured entry: `const { handoff, sourceFact: sf } = state`.
	for (const match of source.matchAll(
		/\b(?:const|let|var)\s*\{([^}]*)\}\s*=[^\n]*\b(?:state|deps|aggregates|composition)\b/gu,
	)) {
		for (const entry of match[1].split(",")) {
			const parts = entry.split(":").map((part) => part.trim());
			const key = shapes.find((shape) => shape.key === parts[0]);
			if (key === undefined) continue;
			const bound = parts.length > 1 ? parts[1] : parts[0];
			if (bound !== key.key) {
				offenders.push(`${file} destructures the ${key.key} aggregate into ${bound}`);
				continue;
			}
			// Destructured under its own name, so the calls still name the
			// aggregate; the interface has to be named beside it.
			if (!namedInterfaces(source).has(key.interfaceName))
				offenders.push(`${file} destructures ${key.key} without naming ${key.interfaceName}`);
		}
	}
	// A declaration that carries an aggregate interface under another name: a
	// field, a variable, a parameter, a getter, or a function's return value.
	// The return value is the hand-over the call rules cannot see: the aggregate
	// arrives as a value the caller never names (issue #202 review).
	for (const shape of shapes) {
		const declared = new RegExp(
			`([A-Za-z_$][\\w$]*)\\s*(?:\\([^)]*\\))?\\s*(?::|\\(\\s*\\)\\s*:)\\s*${shape.interfaceName}\\b`,
			"gu",
		);
		for (const match of source.matchAll(declared)) {
			held.add(`${file} holds ${shape.key}`);
			if (match[1] === shape.key) continue;
			offenders.push(`${file} holds ${shape.interfaceName} under the name ${match[1]}`);
		}
	}
	// A method pulled out of the aggregate and moved as a value: a destructured
	// entry, a `.bind`, or a method handed to a function as an argument. The call
	// rules read `.<aggregate>.<method>(`; a method that leaves the aggregate as
	// a value leaves no call behind for them to read, so the pull itself is
	// refused where it happens (issue #202 review).
	const pulled = new RegExp(`${root}${path}(${keys})(?![\\w$])\\.([A-Za-z_$][\\w$]*)`, "gu");
	for (const match of source.matchAll(pulled)) {
		const shape = shapes.find((item) => item.key === match[1]);
		if (shape === undefined) continue;
		const method = match[2];
		if (!shape.interfaceMethods.has(method) && !shape.internalMethods.has(method)) continue;
		// A call is the method doing its work; anything else is the method
		// standing on its own as a value.
		if (
			source
				.slice(match.index + match[0].length)
				.trimStart()
				.startsWith("(")
		)
			continue;
		offenders.push(`${file} takes ${shape.key}.${method} out of the aggregate as a value`);
	}
	// The same pull read from the other end: a destructuring whose source is the
	// aggregate hands the aggregate's methods over as bare names.
	const fromAggregate = new RegExp(
		`\\b(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*${root}${path}(${keys})(?![\\w$])`,
		"gu",
	);
	for (const match of source.matchAll(fromAggregate)) {
		const shape = shapes.find((item) => item.key === match[2]);
		if (shape === undefined) continue;
		for (const entry of match[1].split(",")) {
			const name =
				entry
					.split(":")
					.map((part) => part.trim())
					.pop() ?? "";
			if (!shape.interfaceMethods.has(name) && !shape.internalMethods.has(name)) continue;
			offenders.push(`${file} takes ${shape.key}.${name} out of the aggregate as a value`);
		}
	}
	return { offenders, held };
}

/** Rule 6: no caller outside the module imports its plumbing. */
function plumbingOffenders(file: string, source: string): string[] {
	const offenders: string[] = [];
	for (const match of source.matchAll(/^import\b[^\n]*?from\s*"([^"]+)"/gmu)) {
		if (!MODULE_INNERS.test(match[1])) continue;
		offenders.push(`${file} imports ${match[1]}, the state module's own plumbing`);
	}
	return offenders;
}

/** The calls one method's body makes: on itself through `this.`, and into
 * another aggregate through `graph()`. */
function callsIn(body: string): Array<{ key: string | null; method: string }> {
	const calls: Array<{ key: string | null; method: string }> = [];
	for (const match of body.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/gu))
		calls.push({ key: null, method: match[1] });
	for (const match of body.matchAll(/\bgraph\(\)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/gu))
		calls.push({ key: match[1], method: match[2] });
	return calls;
}

/**
 * The whole far side of a call: the method's own body, every method it calls on
 * itself through `this.`, and every method it reaches in another aggregate
 * through `graph()`, followed to the end (issue #202 review). A method that
 * opens its transaction two calls away is the same nested open as one that
 * writes it in its own body, so the rule reads the walk and not the one body.
 */
function methodReaches(
	key: string,
	method: string,
	read: (file: string) => string,
	seen = new Set<string>(),
): Array<{ id: string; body: string }> {
	const shape = shapeByKey().get(key);
	if (shape === undefined) return [];
	const id = `${key}.${method}`;
	if (seen.has(id)) return [];
	seen.add(id);
	const body = memberChunk(read(shape.file), method);
	if (body === null) return [];
	const reached: Array<{ id: string; body: string }> = [{ id, body }];
	for (const call of callsIn(body))
		reached.push(...methodReaches(call.key ?? key, call.method, read, seen));
	return reached;
}

/** Rules 7 and 8: no method on the far side of a cross-aggregate call, and no
 * operation the module publishes, opens a transaction. */
interface TransactionFacts {
	/** Rule 7: a transaction on the far side of `graph().<aggregate>.<method>`. */
	acrossOffenders: string[];
	/** Rule 8: a transaction reached from an operation the module publishes. */
	publishedOffenders: string[];
	/** The far-side methods rule 7 read. */
	acrossCovered: Set<string>;
	/** The published methods rule 8 read. */
	publishedCovered: Set<string>;
}

function transactionOffenders(
	read: (file: string) => string = moduleSource,
	shapes: AggregateShape[] = aggregateShapes(),
): TransactionFacts {
	const acrossOffenders: string[] = [];
	const publishedOffenders: string[] = [];
	const acrossCovered = new Set<string>();
	const publishedCovered = new Set<string>();
	for (const shape of shapes) {
		const callerSource = read(shape.file);
		// The published operations are not the only cross-aggregate calls: some
		// of them land on a method the interface declares, so the rule reads the
		// call graph and not one list of names (issue #202 review).
		for (const match of callerSource.matchAll(
			/\bgraph\(\)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/gu,
		)) {
			const target = shapeByKey().get(match[1]);
			if (target === undefined) continue;
			acrossCovered.add(`${target.key}.${match[2]}`);
			for (const reached of methodReaches(target.key, match[2], read)) {
				if (!/\btransaction\s*\(/u.test(reached.body)) continue;
				acrossOffenders.push(
					`${target.file} opens a transaction in ${reached.id}, reached from ${shape.key} by ${match[2]}`,
				);
			}
		}
		// A published operation, and the private method it can call, both run
		// inside whoever opened the write (issue #202, ADR 0095).
		for (const method of [...shape.internalMethods, ...shape.privateMethods]) {
			publishedCovered.add(`${shape.key}.${method}`);
			for (const reached of methodReaches(shape.key, method, read)) {
				if (!/\btransaction\s*\(/u.test(reached.body)) continue;
				publishedOffenders.push(
					`${shape.file} opens a transaction in ${reached.id}, reached from ${method}, an operation the module publishes`,
				);
			}
		}
	}
	return { acrossOffenders, publishedOffenders, acrossCovered, publishedCovered };
}

/** Rule 9: every interface method is reached by a caller or by the tests. */
function interfaceReachFacts(): { unreached: string[]; testOnly: string[] } {
	const unreached: string[] = [];
	const testOnly: string[] = [];
	const production = [...CALLERS, OPEN_SEAM];
	// A cross-aggregate call stands inside a state module, so the far side of it
	// counts as a production reach even though no caller outside the module names
	// the method.
	const moduleFiles = sourceFiles("src/state");
	for (const shape of aggregateShapes()) {
		const through = new RegExp(`\\.${shape.key}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "gu");
		const across = new RegExp(`graph\\(\\)\\.${shape.key}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, "gu");
		for (const method of shape.interfaceMethods) {
			const reachedBy = (file: string, patterns: RegExp[]): boolean => {
				const source = moduleSource(file);
				return patterns.some((pattern) => {
					pattern.lastIndex = 0;
					return [...source.matchAll(pattern)].some((match) => match[1] === method);
				});
			};
			const inProduction =
				production.some((file) => reachedBy(file, [through, across])) ||
				moduleFiles.some((file) => reachedBy(file, [across]));
			// The aggregate reaching its own answer through `this.` is plumbing the
			// interface does not need, so it does not make the method a contract.
			const inTests = TEST_FILES.some((file) => reachedBy(file, [through]));
			if (!inProduction && !inTests) {
				unreached.push(`${shape.key}.${method}`);
				continue;
			}
			if (!inProduction) testOnly.push(`${shape.key}.${method}`);
		}
	}
	return { unreached, testOnly };
}

afterEach(cleanup);

describe("the state module's boundary", () => {
	test("no caller outside the open path holds the whole composition", () => {
		const shapes = aggregateShapes();
		const offenders: string[] = [];
		for (const file of CALLERS) {
			// The open path is the rule's one exception: it is the caller that
			// opens the file and holds the composition on purpose.
			if (file === OPEN_PATH) continue;
			offenders.push(...compositionOffenders(file, readFileSync(file, "utf8"), shapes));
		}
		expect(offenders).toEqual([]);
	});

	test("every aggregate a caller reads is one the caller names", () => {
		const shapes = aggregateShapes();
		const offenders: string[] = [];
		const reads = new Set<string>();
		const allowed = new Set<string>();
		for (const file of CALLERS) {
			// The open path holds the whole composition, so it reads through every
			// aggregate; the first rule names it as the single exception.
			if (file === OPEN_PATH) continue;
			const facts = namingOffenders(file, codeOnly(readFileSync(file, "utf8")), shapes);
			offenders.push(...facts.offenders);
			for (const read of facts.reads) reads.add(read);
			for (const allowance of facts.allowed) allowed.add(allowance);
		}
		// The rule is only worth having while a caller actually reads an
		// aggregate through its interface.
		expect(reads.size).toBeGreaterThan(20);
		// The name-based allowance is read per file, and the run's allowances are
		// exactly the written list: a call site that needs one and is not written
		// goes red, and a written allowance no call site needs any more goes red.
		expect([...allowed].sort()).toEqual(Object.keys(NAME_ALLOWANCE).sort());
		expect(offenders).toEqual([]);
	});

	test("a caller holds an aggregate under the aggregate's own name", () => {
		const shapes = aggregateShapes();
		const offenders: string[] = [];
		const held = new Set<string>();
		for (const file of CALLERS) {
			if (file === OPEN_PATH) continue;
			const facts = aliasOffenders(file, codeOnly(readFileSync(file, "utf8")), shapes);
			offenders.push(...facts.offenders);
			for (const holding of facts.held) held.add(holding);
		}
		// The rule is only worth having while callers really do hold aggregates
		// by name; a rule that matched no holding at all would pass an alias too.
		expect(held.size).toBeGreaterThan(20);
		expect(offenders).toEqual([]);
	});

	test("each aggregate reaches only the tables it owns", () => {
		const offenders: string[] = [];
		const reads = new Set<string>();
		for (const [key, owned] of Object.entries(OWNED)) {
			const file = aggregateFile(key);
			// The same matcher the store's scoped handle refuses with, so the two
			// rules read the SQL the same way: either case, a quoted name as the
			// table it spells, and no CTE or subquery alias mistaken for a reach.
			for (const table of tableReaches(readFileSync(file, "utf8"))) {
				const anyOwner = Object.values(OWNED).some((set) => set.has(table));
				if (!anyOwner) continue;
				reads.add(`${file} reads ${table}`);
				if (!owned.has(table)) offenders.push(`${file} reaches ${table}`);
			}
		}
		// Every owned table must still be reached, or the map has drifted from
		// the module.
		const reachedTables = new Set([...reads].map((read) => read.split(" reads ")[1]));
		const allOwned = new Set([...Object.values(OWNED)].flatMap((set) => [...set]));
		expect([...allOwned].filter((table) => !reachedTables.has(table))).toEqual([]);
		expect(offenders).toEqual([]);
	});

	test("the table rule reads a quoted table name as the table it spells", () => {
		// The probe is the shape the guard missed (issue #202 review): a private
		// method in the Grouping module that reaches `handoffs` through a quoted
		// name. SQLite spells an identifier quoted three ways, so a matcher that
		// read only a bare name let every one of them past - and a statement held
		// in a single-quoted string was invisible to the text rule at all.
		const statements = [
			'SELECT COUNT(*) AS n FROM "handoffs"',
			"SELECT COUNT(*) AS n FROM [handoffs]",
			"SELECT COUNT(*) AS n FROM `handoffs`",
			'UPDATE "handoffs" SET leftover_reason = ?',
			'DELETE FROM "handoffs"',
			"SELECT COUNT(*) AS n FROM handoffs",
		];
		const probeModule = (sql: string): string =>
			[
				"export class GroupingModule implements GroupingAggregate {",
				"\tprivate probeCount(): number {",
				`\t\tconst row = this.db.prepare('${sql}').get() as { n: number };`,
				"\t\treturn row.n;",
				"\t}",
				"}",
			].join("\n");
		for (const sql of statements) {
			const reached = tableReaches(probeModule(sql));
			expect(reached, `probe statement ${sql}`).toEqual(["handoffs"]);
			// The Grouping module owns neither table, so the rule names the reach.
			expect(
				reached.filter((table) => !OWNED.grouping.has(table)),
				`probe statement ${sql}`,
			).toEqual(["handoffs"]);
		}
		// The module's own table, quoted the same way, is no offender.
		expect(tableReaches(probeModule('SELECT COUNT(*) AS n FROM "group_order"'))).toEqual([
			"group_order",
		]);
	});

	test("every table the state file holds has exactly one owner", () => {
		// The tables are read from a real file the migration chain has built, so
		// a scratch table a migration renames away is not mistaken for a table the
		// file keeps, and a table the chain creates is never left out.
		const path = statePath();
		openStore(path).close();
		const database = new Database(path, { readonly: true });
		const created = (
			database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		database.close();
		expect(created.length).toBeGreaterThan(20);
		const claimed = new Map<string, string>();
		for (const [key, tables] of Object.entries(OWNED))
			for (const table of tables) claimed.set(table, key);
		const unclaimed: string[] = [];
		for (const table of created) {
			if (claimed.has(table)) continue;
			if ((SEAM_TABLES as readonly string[]).includes(table)) continue;
			if ((RETIRED_TABLES as readonly string[]).includes(table)) continue;
			unclaimed.push(`${table} is created by the schema and claimed by no aggregate`);
		}
		// A table claimed twice is a table two aggregates can write.
		const shared = [...claimed.keys()].filter(
			(table) =>
				Object.values(OWNED).filter((set) => set.has(table)).length > 1 &&
				!(RETIRED_TABLES as readonly string[]).includes(table),
		);
		expect([...new Set(unclaimed)]).toEqual([]);
		expect(shared).toEqual([]);
	});

	test("an aggregate's internal operations stay inside the module", () => {
		const offenders: string[] = [];
		const covered = new Set<string>();
		for (const shape of aggregateShapes()) {
			for (const method of shape.internalMethods) {
				covered.add(`${shape.key}.${method}`);
				for (const file of CALLERS) {
					const source = readFileSync(file, "utf8");
					if (!new RegExp(`\\.${method}\\s*\\(`, "gu").test(source)) continue;
					offenders.push(`${file} calls ${shape.key}.${method}, an internal operation`);
				}
			}
		}
		// The module really does publish internal operations; an empty set would
		// mean the split moved them somewhere the rule cannot see.
		expect(covered.size).toBeGreaterThan(10);
		expect(offenders).toEqual([]);
	});

	test("no aggregate holds the raw database handle", () => {
		const offenders: string[] = [];
		for (const key of AGGREGATE_KEYS) {
			const file = aggregateFile(key);
			const source = readFileSync(file, "utf8");
			if (/\bnew Database\s*\(/u.test(source)) offenders.push(`${file} opens the file itself`);
			if (/\bStateScope\b/u.test(source) === false)
				offenders.push(`${file} does not run on the store's scoped handle`);
		}
		expect(offenders).toEqual([]);
	});

	test("the composition is built as a whole, not cast into place", () => {
		const graph = readFileSync("src/state/graph.ts", "utf8");
		expect(graph).toContain("const graph: StateGraph = {");
		expect(graph).not.toMatch(/as StateGraph/u);
		for (const key of AGGREGATE_KEYS) expect(graph).toContain(`${key}: new `);
	});

	test("the table matcher reads SQL in either case and lets a statement's own names through", () => {
		// The matcher is the one the store's scoped handle refuses with, so a
		// statement written in lower case is read the same way (issue #202).
		expect(tablesNamed("select title from tickets")).toEqual(["tickets"]);
		expect(tablesNamed("update tickets set ignored = 1")).toEqual(["tickets"]);
		expect(tablesNamed("update or ignore tickets set ignored = 1")).toEqual(["tickets"]);
		expect(
			tablesNamed(
				"select a.title from tickets a join memberships m on m.ticket_identity = a.ticket_identity",
			),
		).toEqual(["tickets", "memberships"]);
		// An upsert's `DO UPDATE SET` names no table of its own, and a column
		// whose name starts with the keyword is not a table either.
		expect(
			tablesNamed(
				"insert into repository_init(repository, settings_hash) values (?, ?) on conflict(repository) do update set settings_hash = excluded.settings_hash",
			),
		).toEqual(["repository_init"]);
		// A quoted value is text the statement stores, not a table it reaches.
		expect(
			tablesNamed(
				"update source_health set health = 'removed', error = 'source removed from config' where source_name = ?",
			),
		).toEqual(["source_health"]);
		expect(tablesNamed("insert into tickets (identity) values ('it''s from handoffs')")).toEqual([
			"tickets",
		]);
		// A CTE's name and a subquery's alias are names the statement binds for
		// itself, not tables it reaches.
		expect(tablesNamed("with held as (select 1) select * from held")).toEqual([]);
		expect(tablesNamed("select * from (select 1) as held")).toEqual([]);
		expect(tablesNamed("select * from (select 1) held")).toEqual([]);
		// The reach inside an aliased subquery is still a reach.
		expect(tablesNamed("select * from (select title from tickets) held")).toEqual(["tickets"]);
		// A name the statement binds for itself is only its own while no
		// aggregate claims it (issue #202 review). Standing a claimed table in
		// for the statement's own result hides the reach, so the hiding is the
		// reach - for a derived table and for a CTE alike.
		expect(
			tablesNamed("select attempt_id from (select attempt_id from handoffs) as handoffs"),
		).toEqual(["handoffs"]);
		expect(
			tablesNamed("select attempt_id from (select attempt_id from handoffs) handoffs"),
		).toEqual(["handoffs"]);
		expect(tablesNamed("with handoffs as (select * from handoffs) select * from handoffs")).toEqual(
			["handoffs", "handoffs"],
		);
		// A quoted name is the same table in another spelling (issue #202 review):
		// SQLite lets an identifier be quoted in three ways, and the matcher reads
		// the name inside the quotes, so no quoted form slips past the guard.
		expect(tablesNamed('SELECT "attempt_id" FROM "handoffs"')).toEqual(["handoffs"]);
		expect(tablesNamed("SELECT attempt_id FROM [handoffs]")).toEqual(["handoffs"]);
		expect(tablesNamed("SELECT attempt_id FROM `handoffs`")).toEqual(["handoffs"]);
		expect(tablesNamed('UPDATE "handoffs" SET leftover_reason = ?')).toEqual(["handoffs"]);
		expect(tablesNamed('DELETE FROM "handoffs"')).toEqual(["handoffs"]);
		expect(tablesNamed('select attempt_id from "main"."handoffs"')).toEqual(["handoffs"]);
		expect(tablesNamed('select attempt_id from (select attempt_id from "handoffs") x')).toEqual([
			"handoffs",
		]);
		// A quoted value stays a value, so a quoted string that names a table is
		// still not a reach.
		expect(tablesNamed("update tickets set title = 'from handoffs' where 1 = 1")).toEqual([
			"tickets",
		]);
	});

	test("no caller outside the module imports its plumbing", () => {
		// `openStore` beside `scopeOf` builds a handle over any table the caller
		// names, so the door the other rules close is open to a file that imports
		// the store itself. The open seam (`src/state.ts`) is the only file that
		// may, and it is not a caller.
		const offenders: string[] = [];
		for (const file of CALLERS)
			offenders.push(...plumbingOffenders(file, readFileSync(file, "utf8")));
		expect(offenders).toEqual([]);
	});

	test("an operation another aggregate calls never opens a transaction", () => {
		// Three of the cross-aggregate calls land on a method the interface
		// declares (`planeActionAttemptCount`, `agentNameForTicket`,
		// `sourceReverifiedSinceCycleEnd`), and the published-operation rule does
		// not look at those (issue #202 review). This rule reads every method on
		// the far side of a `graph().<aggregate>.<method>` call.
		const facts = transactionOffenders();
		// The module really does call across the boundary; an empty set would mean
		// the rule reads nothing.
		expect(facts.acrossCovered.size).toBeGreaterThan(20);
		expect(facts.acrossOffenders).toEqual([]);
	});

	test("an operation an aggregate publishes to the module never opens a transaction", () => {
		// The file holds one write transaction at a time, so an aggregate may open
		// it and call another aggregate's operations inside it. A published
		// operation that opened one of its own would fail inside the caller's -
		// `store.ts` refuses the nested open, and this rule keeps it from being
		// written at all (issue #202, ADR 0095). The rule follows the published
		// method's own calls, so a transaction two calls away is read too.
		const facts = transactionOffenders();
		expect(facts.publishedCovered.size).toBeGreaterThan(10);
		expect(facts.publishedOffenders).toEqual([]);
	});

	test("the auto top-up's walks take their per-Ticket facts from one read of the list", () => {
		// The top-up's gate reads the Ticket's start count and the queue's own item for
		// the candidate it holds. Asked of the aggregate per candidate, each costs a
		// statement for every Ticket the walk passes (issue #202 review): the restart
		// walk holds no row of its own, so its facts arrive as one read for the whole
		// in-flight list - the Handoff aggregate's `handoffCountsFor` and the Work
		// queue's `items`, the same read the cycle gate already pays for its depth.
		// The open-ticket walk reads the start count off the row it holds.
		const source = codeOnly(readFileSync("src/observation.ts", "utf8"));
		const offenders: string[] = [];
		for (const member of ["topUpFreshWork", "topUpOpenTicket", "askContinuations"]) {
			const body = memberChunk(source, member);
			if (body === null) {
				offenders.push(`src/observation.ts holds no ${member} for the rule to read`);
				continue;
			}
			for (const perTicket of [/\.handoff\.handoffCount\s*\(/u, /\.workQueue\.hasWorkItem\s*\(/u]) {
				if (!perTicket.test(body)) continue;
				offenders.push(
					`src/observation.ts ${member} asks the aggregate for one Ticket's fact instead of the list's`,
				);
			}
		}
		// The fresh-work walk names the two batched answers it takes in their place.
		const walk = memberChunk(source, "topUpFreshWork") ?? "";
		if (!/\.handoff\.handoffCountsFor\s*\(/u.test(walk))
			offenders.push("src/observation.ts topUpFreshWork names no handoffCountsFor read");
		if (!/\.workQueue\.items\s*\(/u.test(walk))
			offenders.push("src/observation.ts topUpFreshWork names no workQueue items read");
		expect(offenders).toEqual([]);
	});

	test("every method an aggregate's interface answers is reached", () => {
		// An interface method is either a caller's contract or the aggregate's test
		// surface (issue #202 review). A method no caller and no test
		// reaches is neither, and it is the interface carrying plumbing the split
		// exists to remove.
		const facts = interfaceReachFacts();
		expect(facts.unreached).toEqual([]);
		// The methods with no production caller are written down, so a reader can
		// tell the contract from the test surface and a new one has to be added
		// here before it can stand in the interface.
		expect(facts.testOnly.sort()).toEqual(TEST_ONLY_INTERFACE_METHODS);
	});

	test("the boundary rules refuse a caller that hands an aggregate over", () => {
		// The shapes the rules are meant to refuse, kept as probes so a reviewer
		// does not have to add a file under `src/`, run it, and delete it to find
		// out (issue #202 review).
		const shapes = aggregateShapes();
		const probes: Array<{ name: string; source: string; mustName: string[] }> = [
			{
				name: "a field alias",
				source: `
					import type { SourceFactAggregate } from "../src/state/source-fact.ts";
					export class Probe {
						sf: SourceFactAggregate;
						constructor(deps: { sourceFact: SourceFactAggregate }) {
							this.sf = deps.sourceFact;
						}
						run(): void {
							this.sf.initializeSources();
						}
					}
				`,
				mustName: [
					"holds SourceFactAggregate under the name sf",
					"binds the sourceFact aggregate to sf",
					"calls sourceFact.initializeSources through a name that is not sourceFact",
				],
			},
			{
				name: "a local alias",
				source: `
					import type { SourceFactAggregate } from "../src/state/source-fact.ts";
					export function probeRefresh(state: { sourceFact: SourceFactAggregate }): void {
						const sf = state.sourceFact;
						sf.initializeSources();
					}
				`,
				mustName: [
					"binds the sourceFact aggregate to sf",
					"calls sourceFact.initializeSources through a name that is not sourceFact",
				],
			},
			{
				name: "an aggregate handed over as a function's return value",
				source: `
					import type { HandoffAggregate } from "../src/state/handoff.ts";
					function pickHandoff(state: { handoff: HandoffAggregate }): HandoffAggregate {
						return state.handoff;
					}
					export function probeAttempts(state: { handoff: HandoffAggregate }): number {
						return pickHandoff(state).openAttemptTickets().length;
					}
				`,
				mustName: [
					"holds HandoffAggregate under the name pickHandoff",
					"calls handoff.openAttemptTickets through a name that is not handoff",
				],
			},
			{
				name: "a method name another caller declares, which is no allowance here",
				source: `
					import type { WorkQueueAggregate } from "../src/state/work-queue.ts";
					function pickQueue(state: { workQueue: WorkQueueAggregate }): WorkQueueAggregate {
						return state.workQueue;
					}
					export function probePaused(state: { workQueue: WorkQueueAggregate }): boolean {
						return pickQueue(state).queuePaused();
					}
				`,
				mustName: [
					"holds WorkQueueAggregate under the name pickQueue",
					"calls workQueue.queuePaused through a name that is not workQueue",
				],
			},
			{
				name: "a method destructured out of the aggregate",
				source: `
					import type { HandoffAggregate } from "../src/state/handoff.ts";
					export function probeClaim(state: { handoff: HandoffAggregate }): unknown {
						const { claimHandoff } = state.handoff;
						return claimHandoff("T1", { agentType: "pi", environment: "worktree", taskType: "implement", model: "", thinking: "", contextWindow: "" }, "open");
					}
				`,
				mustName: ["takes handoff.claimHandoff out of the aggregate as a value"],
			},
			{
				name: "a method bound off the aggregate",
				source: `
					import type { HandoffAggregate } from "../src/state/handoff.ts";
					export class Probe {
						claim: HandoffAggregate["claimHandoff"];
						constructor(state: { handoff: HandoffAggregate }) {
							this.claim = state.handoff.claimHandoff.bind(state.handoff);
						}
					}
				`,
				mustName: ["takes handoff.claimHandoff out of the aggregate as a value"],
			},
			{
				name: "a method handed to a function as a value",
				source: `
					import type { HandoffAggregate } from "../src/state/handoff.ts";
					export function probeRun(
						state: { handoff: HandoffAggregate },
						run: (claim: unknown) => void,
					): void {
						run(state.handoff.claimHandoff);
					}
				`,
				mustName: ["takes handoff.claimHandoff out of the aggregate as a value"],
			},
		];
		for (const probe of probes) {
			const source = codeOnly(probe.source);
			const offenders = [
				...compositionOffenders("probe.ts", source, shapes),
				...namingOffenders("probe.ts", source, shapes).offenders,
				...aliasOffenders("probe.ts", source, shapes).offenders,
			];
			for (const phrase of probe.mustName)
				expect(
					offenders.some((offender) => offender.includes(phrase)),
					`${probe.name}: expected an offender naming "${phrase}" in ${offenders.join("; ")}`,
				).toBe(true);
		}
	});

	test("the transaction rule follows the calls a far-side method makes on itself", () => {
		// The probe is the shape the direct-body reading missed (issue #202
		// review): a published internal method that calls an interface method on
		// itself, where the transaction stands in the interface method's body.
		// The members stand at one tab because that is the level a module class
		// holds them at, and the rule reads a member by that level.
		const probeModule = [
			"export class HandoffModule implements HandoffAggregate {",
			"\tnewestHandoffsFor(identities: readonly string[]): number[] {",
			'\t\tthis.settleHandoff("probe-attempt", true);',
			"\t\treturn identities.length;",
			"\t}",
			"\tmarkSettled(attemptId: string): void {",
			"\t\tthis.settleHandoff(attemptId, true);",
			"\t}",
			"\tsettleHandoff(attemptId: string, clean: boolean): boolean {",
			"\t\treturn this.db.transaction(() => {",
			"\t\t\treturn clean;",
			"\t\t});",
			"\t}",
			"}",
		].join("\n");
		const read = (file: string): string =>
			file === "src/state/handoff.ts" ? probeModule : moduleSource(file);
		const probeShape: AggregateShape = {
			key: "handoff",
			interfaceName: "HandoffAggregate",
			file: "src/state/handoff.ts",
			interfaceMethods: new Set(["settleHandoff"]),
			internalMethods: new Set(["newestHandoffsFor", "markSettled"]),
			privateMethods: new Set(),
		};
		const reached = methodReaches("handoff", "newestHandoffsFor", read).map((step) => step.id);
		expect(reached).toContain("handoff.settleHandoff");
		expect(transactionOffenders(read, [probeShape]).publishedOffenders).toEqual([
			"src/state/handoff.ts opens a transaction in handoff.settleHandoff, reached from newestHandoffsFor, an operation the module publishes",
			"src/state/handoff.ts opens a transaction in handoff.settleHandoff, reached from markSettled, an operation the module publishes",
		]);
	});

	test("the transaction rule follows a call into a third aggregate", () => {
		// A far-side method that reaches a third aggregate and lands on a
		// transaction there is the same nested open (issue #202 review).
		const probeModule = [
			"export class HandoffModule implements HandoffAggregate {",
			"\tnewestHandoffsFor(identities: readonly string[]): number[] {",
			'\t\treturn this.graph().workQueue.enqueueWork({ ticketIdentity: "T1" }).ok;',
			"\t}",
			"}",
		].join("\n");
		const read = (file: string): string =>
			file === "src/state/handoff.ts" ? probeModule : moduleSource(file);
		const probeShape: AggregateShape = {
			key: "handoff",
			interfaceName: "HandoffAggregate",
			file: "src/state/handoff.ts",
			interfaceMethods: new Set(["enqueueWork"]),
			internalMethods: new Set(["newestHandoffsFor"]),
			privateMethods: new Set(),
		};
		const reached = methodReaches("handoff", "newestHandoffsFor", read).map((step) => step.id);
		expect(reached).toContain("workQueue.enqueueWork");
		expect(transactionOffenders(read, [probeShape]).publishedOffenders).toEqual([
			"src/state/handoff.ts opens a transaction in workQueue.enqueueWork, reached from newestHandoffsFor, an operation the module publishes",
		]);
	});
});

/**
 * The interface methods with no caller in the plane today, recorded beside the
 * reason (issue #202 review, ADR 0095). Each one answers a fact or runs an
 * operation the aggregate owns, and the aggregate's tests cross it, so it stays
 * on the interface as the aggregate's answer surface. A method no caller and no
 * test reaches fails the rule above instead of standing here.
 *
 * The #202 review's rework took five off this list. `pendingConsultationResponse`,
 * `leftoverEnvironments`, `ticketObligation`, and `visibleTickets` each answered
 * a fact another operation on the same interface already answers - the stored
 * record's own `pendingResponse`, the batched `leftoverEnvironmentsFor`, the
 * ignore write's refusal, and `ticketListViews`'s `rows` - so they are private on
 * their modules or gone. `enqueueConsultationWork` duplicated the Consultation
 * record's own schedule path and is gone.
 */
const TEST_ONLY_INTERFACE_METHODS = [
	// The ledger of Tickets the operator put away. No other operation answers the
	// set: the projection carries the flag per row, and this is the one read of
	// the whole pile the ignore tests cross.
	"ticketWorkCycle.ignoredTickets",
];
