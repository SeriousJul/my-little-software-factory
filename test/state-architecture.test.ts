/**
 * The state module's boundary: one interface per aggregate (issue #202,
 * ADR 0092).
 *
 * The split is only worth keeping if a caller cannot reach past the interface
 * it was given. Seven declared dependency rules hold it:
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
 *    is the aggregate's, and the aggregate's name is gone from the file.
 * 3. A caller holds an aggregate under the aggregate's own name. A field, a
 *    variable, a parameter, a getter, or a destructured entry that carries a
 *    `<Aggregate>` type under another name is the alias rule 2 cannot see once
 *    the call moves behind it, so the alias itself is refused.
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
 *    The rule reads every method on the far side of a `graph().<aggregate>.<method>`
 *    call - the module's internal operations and the interface methods alike
 *    (issue #202, ADR 0092).
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
 * sees is checked by the flow tests that drive the real screens.
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

const AGGREGATE_KEYS = Object.keys(TABLES_OWNED) as readonly (keyof typeof TABLES_OWNED)[];

/** The ownership map, read as sets. */
const OWNED: Record<string, ReadonlySet<string>> = Object.fromEntries(
	Object.entries(TABLES_OWNED).map(([key, tables]) => [key, new Set<string>(tables)]),
);

const CALLERS = sourceFiles(
	"src",
	(file) => !file.startsWith("src/state/") && file !== "src/state.ts",
);

function aggregateFile(key: string): string {
	return `src/state/${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}.ts`;
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

function aggregateShapes(): AggregateShape[] {
	const shapes: AggregateShape[] = [];
	for (const key of AGGREGATE_KEYS) {
		const file = aggregateFile(key);
		const source = readFileSync(file, "utf8");
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
	return shapes;
}

/** The state module's own plumbing: no caller outside the module imports it. */
const MODULE_INNERS = /(?:^|\/)state\/(store|graph|tables|schema|batch|json)\.ts$/u;

/**
 * The SQL a module holds: every string literal in its source.
 *
 * A comment is not a statement, and neither is an identifier, so the table
 * rule reads only the text a `prepare` or an `exec` can be handed. A comment
 * that names another aggregate's table says something; it does not reach it.
 */
function stringLiterals(source: string): string {
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
			literals.push(source.slice(index, end));
			index = end;
			continue;
		}
		index += 1;
	}
	return literals.join("\n");
}

/**
 * One class member's own text: its signature line through the line before the
 * next member at the same level. Body lines are indented deeper, so a call
 * inside a body never ends the chunk.
 */
function memberChunk(source: string, name: string): string {
	const lines = source.split("\n");
	const member = new RegExp(`^\\t(?:private\\s+)?${name}\\s*[({=]`, "u");
	// A line that ends in a semicolon is an interface signature, not the
	// implementation. The rule reads the body the module actually runs.
	const start = lines.findIndex((line) => member.test(line) && !line.trimEnd().endsWith(";"));
	if (start < 0) throw new Error(`no member ${name} in the module source`);
	for (let index = start + 1; index < lines.length; index++) {
		if (/^\t(?:private\s+|readonly\s+|static\s+)?[A-Za-z_$][\w$]*\s*[({=]/u.test(lines[index]))
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

/**
 * The member names every caller declares, so a name a caller owns is not
 * counted as an aggregate's. `dispatch.closeWorkCycle(...)` is the dispatch's
 * own method, not the Ticket work cycle's reached through another name.
 */
function callerMemberNames(): Set<string> {
	const names = new Set<string>();
	for (const file of CALLERS) {
		const source = codeOnly(readFileSync(file, "utf8"));
		for (const match of source.matchAll(
			/^\s*(?:export\s+)?(?:async\s+)?(?:private\s+|readonly\s+|static\s+|get\s+|function\s+)*([A-Za-z_$][\w$]*)\s*[({=:]|\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*(?::|=>)/gmu,
		)) {
			names.add(match[1] ?? match[2] ?? "");
		}
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

afterEach(cleanup);

describe("the state module's boundary", () => {
	test("no caller outside the open path holds the whole composition", () => {
		const offenders: string[] = [];
		for (const file of CALLERS) {
			// The open path is the rule's one exception: it is the caller that
			// opens the file and holds the composition on purpose.
			if (file === OPEN_PATH) continue;
			const source = readFileSync(file, "utf8");
			// The composition module is the only thing that hands a caller every
			// aggregate. Importing from it is the hold whatever name the caller
			// bound the import to, so the rule reads the import and not the name.
			if (/^import\b[^\n]*from\s*"[^"]*state\.ts"/mu.test(source))
				offenders.push(`${file} imports the composed state`);
			if (/\bopenFactoryState\s*\(/u.test(source))
				offenders.push(`${file} opens the state file itself`);
			const named = namedInterfaces(source);
			const shapes = aggregateShapes();
			const namedAggregates = shapes.filter((shape) => named.has(shape.interfaceName));
			if (namedAggregates.length === shapes.length)
				offenders.push(`${file} names every aggregate, which is the composition`);
		}
		expect(offenders).toEqual([]);
	});

	test("every aggregate a caller reads is one the caller names", () => {
		const shapes = aggregateShapes();
		// A method name some caller declares for itself is that caller's own, so
		// it is not read as an aggregate reached through another name.
		const owned = callerMemberNames();
		const offenders: string[] = [];
		const reads = new Set<string>();
		for (const file of CALLERS) {
			// The open path holds the whole composition, so it reads through every
			// aggregate; the first rule names it as the single exception.
			if (file === OPEN_PATH) continue;
			const source = codeOnly(readFileSync(file, "utf8"));
			const named = namedInterfaces(source);
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
				// entry, a deps object - calls `this.sf.initializeSources(...)`:
				// the aggregate's name is gone from the file, and the method is
				// the only fact left that says whose it is. Every call of one of
				// the aggregate's own methods has to stand behind the aggregate's
				// name, or the file is named for reading the aggregate without it.
				for (const method of shape.interfaceMethods) {
					if (owned.has(method)) continue;
					const bare = countMatches(source, new RegExp(`\\.${method}\\s*\\(`, "gu"));
					if (bare === 0) continue;
					// A call chain may break the line between the aggregate and its
					// method, so the two names may have whitespace between them.
					const through = countMatches(
						source,
						new RegExp(`\\.${shape.key}\\s*\\.\\s*${method}\\s*\\(`, "gu"),
					);
					if (bare === through) continue;
					reads.add(`${file} reads ${shape.key}`);
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
		}
		// The rule is only worth having while a caller actually reads an
		// aggregate through its interface.
		expect(reads.size).toBeGreaterThan(20);
		expect(offenders).toEqual([]);
	});

	test("a caller holds an aggregate under the aggregate's own name", () => {
		// The alias is what the call rule cannot see once the call moves behind
		// it: `this.sf = state.sourceFact`, `const { handoff: h } = state`, a
		// field declared `sf: SourceFactAggregate`. Each one holds an aggregate
		// under a name the boundary rules do not read, so the alias is refused
		// where it is made (issue #202 review).
		const shapes = aggregateShapes();
		const keys = shapes.map((shape) => shape.key).join("|");
		// The composition is held under a name that says what it is. A hand-over is
		// read out of that root; a domain object's own `ticket.handoff` field is not
		// the composition handing an aggregate over.
		const root = "(?:[A-Za-z_$][\\w$]*\\.)*(?:state|deps|aggregates|composition)\\.";
		const path = "(?:[A-Za-z_$][\\w$]*\\.)*";
		const offenders: string[] = [];
		const held = new Set<string>();
		for (const file of CALLERS) {
			if (file === OPEN_PATH) continue;
			const source = codeOnly(readFileSync(file, "utf8"));
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
			// A declaration that carries an aggregate interface under another
			// name: a field, a variable, a parameter, or a getter.
			for (const shape of shapes) {
				const declared = new RegExp(
					`([A-Za-z_$][\\w$]*)\\s*(?::|\\(\\s*\\)\\s*:)\\s*${shape.interfaceName}\\b`,
					"gu",
				);
				for (const match of source.matchAll(declared)) {
					held.add(`${file} holds ${shape.key}`);
					if (match[1] === shape.key) continue;
					offenders.push(`${file} holds ${shape.interfaceName} under the name ${match[1]}`);
				}
			}
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
			// rules read the SQL the same way: either case, and no CTE or subquery
			// alias mistaken for a reach.
			for (const table of tablesNamed(stringLiterals(readFileSync(file, "utf8")))) {
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
				for (const file of CALLERS) {
					const source = readFileSync(file, "utf8");
					if (!new RegExp(`\\.${method}\\s*\\(`, "gu").test(source)) continue;
					offenders.push(`${file} calls ${shape.key}.${method}, an internal operation`);
				}
				covered.add(`${shape.key}.${method}`);
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
	});

	test("no caller outside the module imports its plumbing", () => {
		// `openStore` plus `scopeOf` builds a handle over any table the caller
		// names, so the door the other rules close is open to a file that imports
		// the store itself. The open seam (`src/state.ts`) is the only file that
		// may, and it is not a caller.
		const offenders: string[] = [];
		for (const file of CALLERS) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/^import\b[^\n]*?from\s*"([^"]+)"/gmu)) {
				if (!MODULE_INNERS.test(match[1])) continue;
				offenders.push(`${file} imports ${match[1]}, the state module's own plumbing`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("an operation another aggregate calls never opens a transaction", () => {
		// The published operations are not the only cross-aggregate calls: three
		// of them land on a method the interface declares (`planeActionAttemptCount`,
		// `agentNameForTicket`, `sourceReverifiedSinceCycleEnd`), and the published-
		// operation rule does not look at those (issue #202 review). This rule reads
		// every method on the far side of a `graph().<aggregate>.<method>` call, so
		// wrapping an interface method in a transaction goes red.
		const shapes = aggregateShapes();
		const byKey = new Map(shapes.map((shape) => [shape.key, shape]));
		const offenders: string[] = [];
		const covered = new Set<string>();
		for (const shape of shapes) {
			const callerSource = readFileSync(shape.file, "utf8");
			for (const match of callerSource.matchAll(
				/\bgraph\(\)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/gu,
			)) {
				const target = byKey.get(match[1]);
				if (target === undefined) continue;
				const method = match[2];
				covered.add(`${target.key}.${method}`);
				const body = memberChunk(readFileSync(target.file, "utf8"), method);
				if (!/\btransaction\s*\(/u.test(body)) continue;
				offenders.push(
					`${target.file} opens a transaction in ${method}, which ${shape.key} calls across the aggregate boundary`,
				);
			}
		}
		// The module really does call across the boundary; an empty set would mean
		// the rule reads nothing.
		expect(covered.size).toBeGreaterThan(20);
		expect(offenders).toEqual([]);
	});

	test("an operation an aggregate publishes to the module never opens a transaction", () => {
		// The file holds one write transaction at a time, so an aggregate may open
		// it and call another aggregate's operations inside it. A published
		// operation that opened one of its own would fail inside the caller's -
		// `store.ts` refuses the nested open, and this rule keeps it from being
		// written at all (issue #202, ADR 0092).
		const offenders: string[] = [];
		const covered = new Set<string>();
		for (const shape of aggregateShapes()) {
			const source = readFileSync(shape.file, "utf8");
			// A published operation, and the private method it can call, both run
			// inside whoever opened the write.
			for (const method of [...shape.internalMethods, ...shape.privateMethods]) {
				covered.add(`${shape.key}.${method}`);
				if (/\btransaction\s*\(/u.test(memberChunk(source, method)))
					offenders.push(
						`${shape.file} opens a transaction in ${method}, an operation the module publishes`,
					);
			}
		}
		expect(covered.size).toBeGreaterThan(10);
		expect(offenders).toEqual([]);
	});
});
