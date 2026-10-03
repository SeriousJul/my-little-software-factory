/**
 * The shared store every aggregate runs on: the state file, its transaction,
 * and its clock. SQLite is the only adapter that owns factory state (ADR 0004).
 *
 * The store is the only place that holds the raw database handle. An aggregate
 * never sees that handle: `scopeOf` hands it a statement handle bound to the
 * tables that aggregate owns (issue #202, ADR 0095), and the handle refuses a
 * statement that names a table outside its scope when the statement is
 * prepared. So the boundary the architecture check reads off the source text
 * is the same boundary the file enforces at runtime, and a statement built
 * from a variable cannot slip past it.
 *
 * The store holds one write transaction at a time. The plane's atomic facts - a
 * handoff that records a start and takes a queue item - span aggregates, so an
 * aggregate opens the transaction and calls the other aggregates' operations
 * inside it. That only works while the operations an aggregate publishes to the
 * module never open a transaction of their own: `transaction` refuses a nested
 * open and names the aggregate that asked, and the boundary check refuses a
 * published operation that opens one (issue #202, ADR 0095). A write whose
 * rollback fails as well is reported as both failures, with the write's own
 * error kept as the cause (issue #202 review).
 */
import { Database, type Statement } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.ts";
import { tablesNamed } from "./tables.ts";

/** What an error says, whether or not it is an `Error`. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class StateError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StateError";
	}
}

/**
 * The statement handle one aggregate runs on. It carries the file's clock and
 * its transaction, and every statement it prepares names only the tables of
 * the aggregate it was made for.
 */
export interface StateScope {
	/** The state file this handle writes. */
	readonly path: string;
	/** The clock's reading, in milliseconds: the unit the state's timestamps take. */
	now(): number;
	/** Prepare a statement. Refuses one that names a table outside this scope. */
	prepare(sql: string): Statement<unknown>;
	/** Run a statement batch. Refuses one that names a table outside this scope. */
	exec(sql: string): void;
	/** One write: the transaction an aggregate's operation runs in. */
	transaction<T>(body: () => T): T;
}

export class StateStore {
	readonly path: string;
	private readonly database: Database;
	private readonly clock: () => number;
	/** The aggregate that holds the file's one open transaction, or null. */
	private openTransaction: string | null = null;

	constructor(path: string, now: () => number = () => Date.now()) {
		this.path = path;
		this.clock = now;
		this.database = new Database(path);
		try {
			this.database.exec("PRAGMA foreign_keys = ON");
			this.database.exec("PRAGMA secure_delete = ON");
			this.verifyIntegrity();
			this.database.exec("PRAGMA journal_mode = WAL");
			if (path !== ":memory:") chmodSync(path, 0o600);
			migrate(this.database, this.path);
			if (path !== ":memory:") {
				for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
					try {
						chmodSync(sidecar, 0o600);
					} catch {
						// A sidecar can appear between the open and the chmod.
					}
				}
			}
		} catch (error) {
			this.database.close();
			if (error instanceof StateError) throw error;
			throw new StateError(
				`cannot prepare database ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** The clock's reading, in milliseconds: the unit the state's timestamps take. */
	now(): number {
		return this.clock();
	}

	/**
	 * The statement handle one aggregate runs on, bound to the tables the
	 * aggregate owns. The aggregate key names the aggregate in the refusal, so
	 * a reach past its tables says who reached and what it reached for.
	 */
	scopeOf(aggregate: string, tables: readonly string[]): StateScope {
		const owned = new Set(tables);
		const store = this;
		const refuse = (sql: string): void => {
			const outside = tablesNamed(sql).filter((table) => !owned.has(table));
			if (outside.length > 0) {
				throw new StateError(
					`the ${aggregate} aggregate may not reach the table ${outside.join(", ")} at ${store.path}`,
				);
			}
		};
		return {
			get path(): string {
				return store.path;
			},
			now: (): number => store.now(),
			prepare(sql: string): Statement<unknown> {
				refuse(sql);
				return store.database.prepare(sql);
			},
			exec(sql: string): void {
				refuse(sql);
				store.database.exec(sql);
			},
			transaction<T>(body: () => T): T {
				return store.transaction(aggregate, body);
			},
		};
	}

	/**
	 * The file's one write transaction. The caller names the aggregate that
	 * opened it, so a nested open - the shape a cross-aggregate call to a
	 * transactional operation makes - fails with the aggregate's own name
	 * instead of SQLite's `cannot start a transaction within a transaction`.
	 */
	transaction<T>(aggregate: string, body: () => T): T {
		if (this.openTransaction !== null) {
			throw new StateError(
				`the ${aggregate} aggregate may not open a transaction while the ${this.openTransaction} aggregate holds one at ${this.path}`,
			);
		}
		this.openTransaction = aggregate;
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollbackError) {
				// The body's own failure is the reason the write ended. A rollback that
				// fails too - the body already ended the transaction, or the file went -
				// is named beside it, and the body's error stays the cause, so the
				// rollback never hides what the write did (issue #202 review).
				throw new StateError(
					`the ${aggregate} aggregate's write failed at ${this.path}: ${messageOf(error)}; ` +
						`the rollback failed too: ${messageOf(rollbackError)}`,
					{ cause: error },
				);
			}
			throw error;
		} finally {
			this.openTransaction = null;
		}
	}

	/** Close the file: the write-ahead log is folded in before the handle goes. */
	close(): void {
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {
			// A failed checkpoint leaves the log in place; the next open folds it in.
		}
		this.database.close();
	}

	private verifyIntegrity(): void {
		try {
			const integrity = this.database.prepare("PRAGMA integrity_check").get() as
				| { integrity_check?: string }
				| undefined;
			if (integrity?.integrity_check !== "ok")
				throw new StateError(
					`database integrity check failed at ${this.path}: ${integrity?.integrity_check ?? "unknown result"}`,
				);
		} catch (error) {
			if (error instanceof StateError) throw error;
			throw new StateError(
				`database integrity check failed at ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/** Open the file: the directory, the file, and the schema chain, in one place. */
export function openStore(path: string, now?: () => number): StateStore {
	try {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		if (path !== ":memory:") chmodSync(dirname(path), 0o700);
		return new StateStore(path, now);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new StateError(`cannot open factory state at ${path}: ${message}`);
	}
}
