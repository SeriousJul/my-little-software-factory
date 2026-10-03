/**
 * The lease aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import type { StateGraph } from "./graph.ts";
import type { StateScope, StateStore } from "./store.ts";
import { StateError } from "./store.ts";
import { TABLES_OWNED } from "./tables.ts";

export interface LeaseAggregate {
	acquireLease(): void;
	releaseLease(): void;
}

export class LeaseModule implements LeaseAggregate {
	leaseToken: string | null = null;
	readonly db: StateScope;
	readonly graph: () => StateGraph;
	constructor(store: StateStore, graph: () => StateGraph) {
		this.db = store.scopeOf("lease", TABLES_OWNED.lease);
		this.graph = graph;
	}
	acquireLease(): void {
		const owner = randomUUID();
		const host = os.hostname();
		const now = Date.now();
		this.db.transaction(() => {
			const current = this.db
				.prepare("SELECT owner_token, pid, host FROM lease WHERE name = 'control-plane'")
				.get() as { owner_token: string; pid: number; host: string } | null;
			if (current != null && !this.isDeadLocalOwner(current, host))
				throw new StateError(
					`state database is already in use by process ${current.pid} on ${current.host}`,
				);
			this.db
				.prepare(
					"INSERT OR REPLACE INTO lease(name, owner_token, pid, host, heartbeat_at) VALUES ('control-plane', ?, ?, ?, ?)",
				)
				.run(owner, process.pid, host, now);
		});
		this.leaseToken = owner;
	}
	private isDeadLocalOwner(current: { pid: number; host: string }, host: string): boolean {
		if (current.host !== host) return false;
		// PID liveness is the safe local reclaim signal. A PID can theoretically
		// be reused before this check, so the heartbeat remains diagnostic data,
		// not proof that a different process owns the lease.
		try {
			process.kill(current.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH";
		}
	}
	releaseLease(): void {
		if (this.leaseToken == null) return;
		this.db
			.prepare("DELETE FROM lease WHERE name = 'control-plane' AND owner_token = ?")
			.run(this.leaseToken);
		this.leaseToken = null;
	}
}
