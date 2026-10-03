/**
 * The open seam of the state module.
 *
 * One aggregate per aggregate: each answers its own facts and runs its own
 * operations, and the app shell reaches a fact or an operation only through
 * the aggregate that owns it. This file composes the nine aggregates into the
 * graph and closes the file. It holds no rule of its own.
 */

import { ConsultationRecordModule } from "./state/consultation-record.ts";
import type { StateGraph } from "./state/graph.ts";
import { GroupingModule } from "./state/grouping.ts";
import { HandoffModule } from "./state/handoff.ts";
import { LeaseModule } from "./state/lease.ts";
import { PlaneActionModule } from "./state/plane-action.ts";
import { RepositoryInitModule } from "./state/repository-init.ts";
import { SourceFactModule } from "./state/source-fact.ts";
import { openStore, StateError, type StateStore } from "./state/store.ts";
import { TicketWorkCycleModule } from "./state/ticket-work-cycle.ts";
import { WorkQueueModule } from "./state/work-queue.ts";

export { SCHEMA_VERSION } from "./state/schema.ts";
export { StateError } from "./state/store.ts";

/** The composed state: the nine aggregate interfaces, and the close. */
export interface FactoryState extends StateGraph {
	/** The path of the state file the graph opened. */
	readonly path: string;
	/** The clock the graph reads its timestamps from. */
	now(): number;
	close(): void;
}

/** Open the state file and compose the aggregates over it. */
export function openFactoryState(path: string, now?: () => number): FactoryState {
	let store: StateStore;
	try {
		store = openStore(path, now);
	} catch (error) {
		if (error instanceof StateError) throw error;
		throw new StateError(`cannot open factory state at ${path}: ${String(error)}`);
	}

	// The aggregates call each other through the graph, so the graph is bound
	// before any of them runs. Construction order does not matter: no call
	// happens until the graph is whole.
	const graph = {} as StateGraph;
	graph.lease = new LeaseModule(store, graph);
	graph.repositoryInit = new RepositoryInitModule(store, graph);
	graph.grouping = new GroupingModule(store, graph);
	graph.sourceFact = new SourceFactModule(store, graph);
	graph.handoff = new HandoffModule(store, graph);
	graph.planeAction = new PlaneActionModule(store, graph);
	graph.workQueue = new WorkQueueModule(store, graph);
	graph.ticketWorkCycle = new TicketWorkCycleModule(store, graph);
	graph.consultationRecord = new ConsultationRecordModule(store, graph);

	let hasClosed = false;
	return {
		...graph,
		path: store.path,
		now(): number {
			return store.now();
		},
		close(): void {
			if (hasClosed) return;
			hasClosed = true;
			graph.lease.releaseLease();
			// Fold the WAL into the main file so a closed state file is complete
			// on its own: Bun's close does not checkpoint the way a final SQLite
			// close does, and the data otherwise stays in the -wal sidecar.
			try {
				store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} catch {}
			store.closeDb();
		},
	};
}
