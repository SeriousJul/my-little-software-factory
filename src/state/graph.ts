/**
 * The composition of the nine aggregates (issue #202, ADR 0095).
 *
 * The graph is the module's internal wiring: each key holds the aggregate's
 * module, so an aggregate reaches the narrow operations another aggregate
 * publishes to the module. A caller outside the module never sees this type -
 * it holds the module's internal operations, not just each aggregate's public
 * interface.
 */

import { ConsultationRecordModule } from "./consultation-record.ts";
import { GroupingModule } from "./grouping.ts";
import { HandoffModule } from "./handoff.ts";
import { LeaseModule } from "./lease.ts";
import { PlaneActionModule } from "./plane-action.ts";
import { RepositoryInitModule } from "./repository-init.ts";
import { SourceFactModule } from "./source-fact.ts";
import type { StateStore } from "./store.ts";
import { TicketWorkCycleModule } from "./ticket-work-cycle.ts";
import { WorkQueueModule } from "./work-queue.ts";

export interface StateGraph {
	lease: LeaseModule;
	repositoryInit: RepositoryInitModule;
	grouping: GroupingModule;
	sourceFact: SourceFactModule;
	handoff: HandoffModule;
	planeAction: PlaneActionModule;
	workQueue: WorkQueueModule;
	ticketWorkCycle: TicketWorkCycleModule;
	consultationRecord: ConsultationRecordModule;
}

/**
 * Build the composition. Each module is handed the graph as a read it performs
 * when it calls another aggregate, so the object literal is the composition
 * itself: an aggregate that is missing, or a module that is not the one the
 * key names, is a type error here rather than a cast that says nothing.
 */
export function composeGraph(store: StateStore): StateGraph {
	const graph: StateGraph = {
		lease: new LeaseModule(store, () => graph),
		repositoryInit: new RepositoryInitModule(store, () => graph),
		grouping: new GroupingModule(store, () => graph),
		sourceFact: new SourceFactModule(store, () => graph),
		handoff: new HandoffModule(store, () => graph),
		planeAction: new PlaneActionModule(store, () => graph),
		workQueue: new WorkQueueModule(store, () => graph),
		ticketWorkCycle: new TicketWorkCycleModule(store, () => graph),
		consultationRecord: new ConsultationRecordModule(store, () => graph),
	};
	return graph;
}
