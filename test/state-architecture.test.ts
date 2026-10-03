/**
 * The state module's boundary: one interface per aggregate (issue #202).
 *
 * The split is only worth keeping if a caller cannot reach past the interface
 * it was given. Three declared dependency rules hold it:
 *
 * 1. A caller names only the aggregates it reads. It does not import the whole
 *    composition, so a new method on an aggregate cannot reach a caller that
 *    never asked for it.
 * 2. Every call a caller makes is on an aggregate the caller names.
 * 3. Inside the module, an aggregate reaches only the tables it owns.
 *
 * The open path is the one exception to the first two rules: it opens the file,
 * takes the lease, and closes it, so it holds the whole composition.
 *
 * The rules read the source; they are not behavior tests. What the operator
 * sees is checked by the flow tests that drive the real screens.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "./static-checks.ts";

/** The open path: it opens the file, takes the lease, and closes it, so it
 * holds the whole composition. Every other caller names its own list. */
const OPEN_PATH = "src/startup.ts";

/** The tables each aggregate owns. `schema.ts` defines them all, so it is
 * outside the rule; `store.ts`, `graph.ts`, and `json.ts` hold no table. */
const TABLES_OWNED: Record<string, ReadonlySet<string>> = {
	"consultation-record.ts": new Set([
		"consultations",
		"consultation_turns",
		"consultation_snapshots",
		"consultation_resources",
		"consultation_remaining_resources",
		"consultation_pending_responses",
		"checkout_conflict_confirmations",
	]),
	"grouping.ts": new Set(["grouping_axis", "group_order"]),
	"handoff.ts": new Set(["handoffs", "handoff_attempts", "auto_handoff_mode"]),
	"lease.ts": new Set(["lease"]),
	"plane-action.ts": new Set(["plane_action_attempts"]),
	"repository-init.ts": new Set(["repository_init"]),
	"source-fact.ts": new Set(["source_health", "memberships"]),
	"ticket-work-cycle.ts": new Set(["tickets", "completion_traces"]),
	"work-queue.ts": new Set(["work_queue", "queue_pause"]),
};

const CALLERS = sourceFiles(
	"src",
	(file) => !file.startsWith("src/state/") && file !== "src/state.ts",
);
const AGGREGATE_FILES = sourceFiles("src/state", (file) =>
	Object.keys(TABLES_OWNED).includes(file.slice("src/state/".length)),
);

/** Every aggregate interface the module declares, by its aggregate key. */
function aggregateInterfaces(): Map<string, string> {
	const found = new Map<string, string>();
	for (const file of sourceFiles("src/state")) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/export interface (\w+Aggregate)\b/gu)) {
			const name = match[1];
			const key = name.slice(0, -"Aggregate".length);
			found.set(key.charAt(0).toLowerCase() + key.slice(1), name);
		}
	}
	return found;
}

describe("the state module's boundary", () => {
	test("no caller imports the whole composition", () => {
		const offenders: string[] = [];
		for (const file of CALLERS) {
			if (/^import\b[^\n]*\bFactoryState\b/mu.test(readFileSync(file, "utf8")))
				offenders.push(file);
		}
		expect(offenders).toEqual([OPEN_PATH]);
	});

	test("every aggregate a caller reads is one the caller names", () => {
		const interfaces = aggregateInterfaces();
		const offenders: string[] = [];
		const reads = new Set<string>();
		for (const file of CALLERS) {
			// The open path holds the whole composition, so it reads through every
			// aggregate; the first rule names it as the single exception.
			if (file === OPEN_PATH) continue;
			const source = readFileSync(file, "utf8");
			const named = new Set<string>();
			for (const match of source.matchAll(/import type \{([^}]*)\} from "[^"]*state\//gu)) {
				for (const name of match[1].split(",").map((part) => part.trim())) named.add(name);
			}
			for (const match of source.matchAll(/\bstate\.([A-Za-z][A-Za-z0-9]*)\./gu)) {
				const key = match[1];
				const iface = interfaces.get(key);
				if (iface === undefined) continue;
				reads.add(`${file} reads ${key}`);
				if (!named.has(iface)) offenders.push(`${file} calls ${key} without naming ${iface}`);
			}
		}
		// The rule is only worth having while a caller actually reads an
		// aggregate through its interface.
		expect(reads.size).toBeGreaterThan(20);
		expect(offenders).toEqual([]);
	});

	test("each aggregate reaches only the tables it owns", () => {
		const offenders: string[] = [];
		const reads = new Set<string>();
		for (const file of AGGREGATE_FILES) {
			const source = readFileSync(file, "utf8");
			const owned = TABLES_OWNED[file.slice("src/state/".length)] ?? new Set<string>();
			for (const match of source.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/gu)) {
				const table = match[1];
				const anyOwner = Object.values(TABLES_OWNED).some((set) => set.has(table));
				if (!anyOwner) continue;
				reads.add(`${file} reads ${table}`);
				if (!owned.has(table)) offenders.push(`${file} reaches ${table}`);
			}
		}
		// Every owned table must still be reached, or the map has drifted from
		// the module.
		const reachedTables = new Set([...reads].map((read) => read.split(" reads ")[1]));
		const allOwned = new Set([...Object.values(TABLES_OWNED)].flatMap((set) => [...set]));
		expect([...allOwned].filter((table) => !reachedTables.has(table))).toEqual([]);
		expect(offenders).toEqual([]);
	});
});
