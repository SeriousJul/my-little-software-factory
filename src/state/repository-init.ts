/**
 * The repository init aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 */

import type { StateGraph } from "./graph.ts";
import type { StateStore } from "./store.ts";
import { StateError } from "./store.ts";

export interface RepositoryInitFact {
	/** The repository identity the fact stands for, matching the Config repository key. */
	repository: string;
	/** The hash of the settings that generated the content the act pushed. */
	settingsHash: string;
	/** The commit the act pushed to the remote default branch. */
	pushedCommit: string;
	/** The time the fact was written, an ISO string. */
	at: string;
}

export interface RepositoryInitAggregate {
	repositoryInitFact(repository: string): RepositoryInitFact | null;
	setRepositoryInitFact(repository: string, settingsHash: string, pushedCommit: string): void;
}

export class RepositoryInitModule implements RepositoryInitAggregate {
	readonly store: StateStore;
	readonly graph: StateGraph;
	constructor(store: StateStore, graph: StateGraph) {
		this.store = store;
		this.graph = graph;
	}
	repositoryInitFact(repository: string): RepositoryInitFact | null {
		const row = this.store.db
			.prepare(
				"SELECT repository, settings_hash, pushed_commit, at FROM repository_init WHERE repository = ?",
			)
			.get(repository) as {
			repository: string;
			settings_hash: string;
			pushed_commit: string;
			at: string;
		} | null;
		if (row === null) return null;
		return {
			repository: row.repository,
			settingsHash: row.settings_hash,
			pushedCommit: row.pushed_commit,
			at: row.at,
		};
	}
	setRepositoryInitFact(repository: string, settingsHash: string, pushedCommit: string): void {
		try {
			this.store.db
				.prepare(
					"INSERT INTO repository_init(repository, settings_hash, pushed_commit, at) VALUES (?, ?, ?, ?) ON CONFLICT(repository) DO UPDATE SET settings_hash = excluded.settings_hash, pushed_commit = excluded.pushed_commit, at = excluded.at",
				)
				.run(repository, settingsHash, pushedCommit, new Date(this.store.now()).toISOString());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StateError(`cannot store the init fact at ${this.store.path}: ${message}`);
		}
	}
}
