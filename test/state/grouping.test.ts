/**
 * The grouping aggregate's own tests (issue #202, re-homed from the flat state
 * suite): the axis each section of the plane carries, the Group order each axis
 * carries, and the migrations that land both on an older file.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openFactoryState, SCHEMA_VERSION } from "../../src/state.ts";
import { cleanup, fetched, sourceA, statePath, success } from "./harness.ts";

afterEach(cleanup);

describe("the grouping aggregate", () => {
	test("the write is durable: a fresh open of the same file reads it back", () => {
		const path = statePath();
		const state = openFactoryState(path);
		// A fresh state file starts at `repository`, so a newly configured
		// plane comes up grouped before any press (ADR 0066, user story 52).
		expect(state.grouping.groupingAxis("tickets")).toBe("repository");
		state.grouping.setGroupingAxis("tickets", "repository");
		expect(state.grouping.groupingAxis("tickets")).toBe("repository");
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.grouping.groupingAxis("tickets")).toBe("repository");
		reopened.grouping.setGroupingAxis("tickets", "position");
		expect(reopened.grouping.groupingAxis("tickets")).toBe("position");
		reopened.close();
		const third = openFactoryState(path);
		expect(third.grouping.groupingAxis("tickets")).toBe("position");
		third.close();
	});

	test("the record is keyed by section, not by one section", () => {
		// A second list that takes grouping later writes its own row and
		// needs no new schema version (user story 51). The row the plane
		// writes today stands beside a row it does not know yet, and each
		// reads its own answer.
		const path = statePath();
		const state = openFactoryState(path);
		state.grouping.setGroupingAxis("tickets", "task");
		state.close();

		const db = new Database(path);
		db.prepare("INSERT INTO grouping_axis(section, axis) VALUES ('consultations', 'state')").run();
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.grouping.groupingAxis("tickets")).toBe("task");
		const check = new Database(path, { readonly: true });
		expect(
			check.prepare("SELECT section, axis FROM grouping_axis ORDER BY section").all() as {
				section: string;
				axis: string;
			}[],
		).toEqual([
			{ section: "consultations", axis: "state" },
			{ section: "tickets", axis: "task" },
		]);
		check.close();
		reopened.close();
	});

	test("a value the plane does not name reads back as the default", () => {
		// The file is the operator's data, not the plane's code: a hand-edited
		// or future value must open the flat list instead of failing startup.
		const path = statePath();
		const state = openFactoryState(path);
		state.close();
		const db = new Database(path);
		db.prepare("UPDATE grouping_axis SET axis = 'sideways' WHERE section = 'tickets'").run();
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.grouping.groupingAxis("tickets")).toBe("none");
		reopened.close();
	});

	test("a v20 file migrates to v21: the axis lands at its default", () => {
		// Story 57: an upgrade never fails startup over a missing row. The
		// step seeds the default beside the work the file already carried.
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.grouping.setGroupingAxis("tickets", "source");
		state.close();

		const db = new Database(path);
		db.exec("DROP TABLE grouping_axis");
		db.prepare("UPDATE schema_version SET version = 20").run();
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.grouping.groupingAxis("tickets")).toBe("repository");
		// The work the v20 file held still reads: the migration added a row
		// and moved nothing else.
		expect(reopened.ticketWorkCycle.visibleTickets([], "implement")[0].sourceKind).toBe(
			"github-issue",
		);
		const check = new Database(path, { readonly: true });
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
		reopened.close();
	});

	test("no fold stands on the state file", () => {
		// ADR 0058 holds the folds in memory: the file gains the axis table
		// and no table that could carry a collapsed Group, so a restart can
		// never bring back a fold that hides a decision the operator owes.
		const path = statePath();
		openFactoryState(path).close();
		const check = new Database(path, { readonly: true });
		const tables = (
			check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((row) => row.name);
		check.close();
		expect(tables).toContain("grouping_axis");
		expect(tables.filter((name) => /fold|collaps/i.test(name))).toEqual([]);
	});

	test("a fresh file answers no order: the default order stands", () => {
		const state = openFactoryState(statePath());
		expect(state.grouping.groupOrder("tickets", "repository")).toEqual([]);
		state.close();
	});

	test("the write is durable, and each axis keeps its own order", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.grouping.setGroupOrder("tickets", "repository", ["acme/factory", "acme/billing"]);
		expect(state.grouping.groupOrder("tickets", "repository")).toEqual([
			"acme/factory",
			"acme/billing",
		]);
		// The other axis has no order until a move writes one.
		expect(state.grouping.groupOrder("tickets", "task")).toEqual([]);
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.grouping.groupOrder("tickets", "repository")).toEqual([
			"acme/factory",
			"acme/billing",
		]);
		reopened.grouping.setGroupOrder("tickets", "task", ["implement", "review"]);
		expect(reopened.grouping.groupOrder("tickets", "task")).toEqual(["implement", "review"]);
		// The repository order the file held still stands beside it.
		expect(reopened.grouping.groupOrder("tickets", "repository")).toEqual([
			"acme/factory",
			"acme/billing",
		]);
		reopened.close();
	});

	test("a write stores the order whole: the old rows leave with it", () => {
		const state = openFactoryState(statePath());
		state.grouping.setGroupOrder("tickets", "repository", ["acme/a", "acme/b", "acme/c"]);
		state.grouping.setGroupOrder("tickets", "repository", ["acme/c", "acme/a"]);
		expect(state.grouping.groupOrder("tickets", "repository")).toEqual(["acme/c", "acme/a"]);
		state.close();
	});

	test("a v23 file migrates to v24: no order stands, and the work keeps its state", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.sourceFact.initializeSources([sourceA]);
		state.sourceFact.applyFetch(sourceA, success([fetched()]));
		state.grouping.setGroupingAxis("tickets", "source");
		state.close();

		const db = new Database(path);
		db.exec("DROP TABLE group_order");
		db.prepare("UPDATE schema_version SET version = 23").run();
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.grouping.groupOrder("tickets", "repository")).toEqual([]);
		reopened.grouping.setGroupOrder("tickets", "repository", ["acme/a"]);
		// The work the v23 file held still reads: the migration added a table
		// and moved nothing else.
		expect(reopened.ticketWorkCycle.visibleTickets([], "implement")[0].sourceKind).toBe(
			"github-issue",
		);
		const check = new Database(path, { readonly: true });
		expect(
			(check.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		).toBe(SCHEMA_VERSION);
		check.close();
		reopened.close();
	});

	test("a file stamped at the target without the table heals on open", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.close();

		const db = new Database(path);
		db.exec("DROP TABLE group_order");
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.grouping.groupOrder("tickets", "repository")).toEqual([]);
		reopened.grouping.setGroupOrder("tickets", "repository", ["acme/a"]);
		expect(reopened.grouping.groupOrder("tickets", "repository")).toEqual(["acme/a"]);
		reopened.close();
	});
});
