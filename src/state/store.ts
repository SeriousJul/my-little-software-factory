/**
 * The shared store every aggregate runs on: the state file, its transaction,
 * and its clock. SQLite is the only adapter that owns factory state (ADR 0004).
 * An aggregate reaches the file only through this store.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./schema.ts";

export class StateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StateError";
	}
}

export class StateStore {
	readonly path: string;
	readonly db: Database;
	private readonly clock: () => number;

	constructor(path: string, now: () => number = () => Date.now()) {
		this.path = path;
		this.clock = now;
		this.db = new Database(path);
		try {
			this.db.exec("PRAGMA foreign_keys = ON");
			this.db.exec("PRAGMA secure_delete = ON");
			this.verifyIntegrity();
			this.db.exec("PRAGMA journal_mode = WAL");
			if (path !== ":memory:") chmodSync(path, 0o600);
			migrate(this);
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
			this.db.close();
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

	/** One write: the transaction an aggregate's operation runs in. */
	transaction<T>(body: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	closeDb(): void {
		this.db.close();
	}

	private verifyIntegrity(): void {
		try {
			const integrity = this.db.prepare("PRAGMA integrity_check").get() as
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
