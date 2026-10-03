/**
 * The repositoryInit aggregate's own tests (issue #202): the one row a
 * repository carries once the plane has pushed its settings branch, read back
 * on a fresh open, replaced by the next push, and refused in the file's words
 * when the write cannot run.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { openFactoryState } from "../../src/state.ts";
import { cleanup, statePath } from "./harness.ts";

afterEach(cleanup);

describe("the repositoryInit aggregate", () => {
	test("a fresh file answers no init fact", () => {
		const state = openFactoryState(statePath());
		expect(state.repositoryInit.repositoryInitFact("acme/factory")).toBeNull();
		state.close();
	});

	test("the fact is durable factory state: a fresh open reads it back", () => {
		const path = statePath();
		const state = openFactoryState(path, () => Date.parse("2026-09-24T10:00:00Z"));
		state.repositoryInit.setRepositoryInitFact("acme/factory", "hash-one", "commit-one");
		expect(state.repositoryInit.repositoryInitFact("acme/factory")).toEqual({
			repository: "acme/factory",
			settingsHash: "hash-one",
			pushedCommit: "commit-one",
			at: "2026-09-24T10:00:00.000Z",
		});
		state.close();

		const reopened = openFactoryState(path);
		expect(reopened.repositoryInit.repositoryInitFact("acme/factory")?.settingsHash).toBe(
			"hash-one",
		);
		reopened.close();
	});

	test("a second push replaces the fact, and the file holds one row per repository", () => {
		const path = statePath();
		const state = openFactoryState(path);
		state.repositoryInit.setRepositoryInitFact("acme/factory", "hash-one", "commit-one");
		state.repositoryInit.setRepositoryInitFact("acme/factory", "hash-two", "commit-two");
		state.close();

		const check = new Database(path, { readonly: true });
		expect(check.prepare("SELECT COUNT(*) AS count FROM repository_init").get()).toEqual({
			count: 1,
		});
		check.close();

		const reopened = openFactoryState(path);
		expect(reopened.repositoryInit.repositoryInitFact("acme/factory")).toEqual(
			expect.objectContaining({ settingsHash: "hash-two", pushedCommit: "commit-two" }),
		);
		reopened.close();
	});

	test("each repository keeps its own fact", () => {
		const state = openFactoryState(statePath());
		state.repositoryInit.setRepositoryInitFact("acme/factory", "hash-a", "commit-a");
		state.repositoryInit.setRepositoryInitFact("acme/billing", "hash-b", "commit-b");
		expect(state.repositoryInit.repositoryInitFact("acme/factory")?.pushedCommit).toBe("commit-a");
		expect(state.repositoryInit.repositoryInitFact("acme/billing")?.pushedCommit).toBe("commit-b");
		expect(state.repositoryInit.repositoryInitFact("acme/other")).toBeNull();
		state.close();
	});

	test("a file stamped at the target without the table heals on open", () => {
		const path = statePath();
		openFactoryState(path).close();

		const db = new Database(path);
		db.exec("DROP TABLE repository_init");
		db.close();

		const reopened = openFactoryState(path);
		expect(reopened.repositoryInit.repositoryInitFact("acme/factory")).toBeNull();
		reopened.repositoryInit.setRepositoryInitFact("acme/factory", "hash-one", "commit-one");
		expect(reopened.repositoryInit.repositoryInitFact("acme/factory")?.pushedCommit).toBe(
			"commit-one",
		);
		reopened.close();
	});
});
