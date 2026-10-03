/**
 * The composition: every aggregate reached through one graph. An aggregate
 * calls another aggregate only through this interface, so the graph names
 * the whole cross-aggregate dependency at once.
 */

import type { ConsultationRecordAggregate } from "./consultation-record.ts";
import type { GroupingAggregate } from "./grouping.ts";
import type { HandoffAggregate } from "./handoff.ts";
import type { LeaseAggregate } from "./lease.ts";
import type { PlaneActionAggregate } from "./plane-action.ts";
import type { RepositoryInitAggregate } from "./repository-init.ts";
import type { SourceFactAggregate } from "./source-fact.ts";
import type { TicketWorkCycleAggregate } from "./ticket-work-cycle.ts";
import type { WorkQueueAggregate } from "./work-queue.ts";

export interface StateGraph {
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
