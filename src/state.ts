/**
 * The open seam of the state module.
 *
 * One aggregate per aggregate: each answers its own facts and runs its own
 * operations, and the app shell reaches a fact or an operation only through
 * the aggregate that owns it. This file opens the file, hands the composition
 * to `composeGraph`, and closes the file. It holds no rule of its own.
 *
 * What a caller holds is `FactoryState`: the nine aggregate interfaces, the
 * path, the clock, and the close. The composition type the aggregates call
 * each other through is a different type, and it is not exported from here -
 * a caller cannot pick up the whole graph, and cannot pick up an aggregate's
 * internal operations.
 */

import type { ConsultationRecordAggregate } from "./state/consultation-record.ts";
import { composeGraph } from "./state/graph.ts";
import type { GroupingAggregate } from "./state/grouping.ts";
import type { HandoffAggregate } from "./state/handoff.ts";
import type { LeaseAggregate } from "./state/lease.ts";
import type { PlaneActionAggregate } from "./state/plane-action.ts";
import type { RepositoryInitAggregate } from "./state/repository-init.ts";
import type { SourceFactAggregate } from "./state/source-fact.ts";
import { openStore, StateError, type StateStore } from "./state/store.ts";
import type { TicketWorkCycleAggregate } from "./state/ticket-work-cycle.ts";
import type { WorkQueueAggregate } from "./state/work-queue.ts";

export { SCHEMA_VERSION } from "./state/schema.ts";
export { StateError } from "./state/store.ts";

/** The nine aggregates, each held as its own interface. */
export interface FactoryAggregates {
	lease: LeaseAggregate;
	repositoryInit: RepositoryInitAggregate;
	grouping: GroupingAggregate;
	sourceFact: SourceFactAggregate;
	handoff: HandoffAggregate;
	planeAction: PlaneActionAggregate;
	workQueue: WorkQueueAggregate;
	ticketWorkCycle: TicketWorkCycleAggregate;
	consultationRecord: ConsultationRecordAggregate;
}

/** The composed state: the nine aggregate interfaces, and the file's own facts. */
export interface FactoryState extends FactoryAggregates {
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

	const graph = composeGraph(store);

	let hasClosed = false;
	return {
		lease: graph.lease,
		repositoryInit: graph.repositoryInit,
		grouping: graph.grouping,
		sourceFact: graph.sourceFact,
		handoff: graph.handoff,
		planeAction: graph.planeAction,
		workQueue: graph.workQueue,
		ticketWorkCycle: graph.ticketWorkCycle,
		consultationRecord: graph.consultationRecord,
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
			store.close();
		},
	};
}
