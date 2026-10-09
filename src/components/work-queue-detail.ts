/**
 * The Work queue's detail pane (ADR 0034): the facts of the item under the
 * cursor - the name it waits for, the origin word, its place in the shared
 * order, the facts it carries, and the message the start would carry in. The
 * shared line pane scrolls it, like the Consultation detail. The builder
 * stands in its own module, not in the App, so the gallery's examples and the
 * App's pane read the same lines from the same function, the way the other
 * shared controls do.
 */
import { DEFAULT_MERGE_METHOD } from "../plane-action-registry.ts";
import type { Consultation } from "../state/consultation-record.ts";
import type {
	WorkQueueHandoffItem,
	WorkQueueItem,
	WorkQueuePlaneActionItem,
} from "../state/work-queue.ts";
import { paint } from "./theme.ts";
import { type WorkQueueRow, workQueueOriginWord } from "./work-queue-list.ts";

/** One Work queue detail line: the text, the color it paints, the emphasis. */
export interface WorkQueueDetailLine {
	text: string;
	fg: string | undefined;
	/** The emphasis the old palette carried in a brighter text color. */
	bold?: boolean;
}

/**
 * The facts of the item under the cursor, as the detail pane shows them.
 *
 * A handoff item shows the ticket's title while it stands in the projection,
 * the identity beside it, the operator's captured choice, and the message the
 * start would carry in. A Consultation item (issue #90) shows the record it
 * names: the record holds the ask, so the detail reads the record the
 * pane's caller passes, and the record gone is said in its place.
 */
export function workQueueDetailLines(
	row: WorkQueueRow | undefined,
	workQueueDepth: number,
	consultation?: Consultation,
): WorkQueueDetailLine[] {
	if (row === undefined) return [{ text: "no queue item is selected", fg: paint("subtext0") }];
	const { item, title } = row;
	const lines: WorkQueueDetailLine[] = [
		{ text: title, fg: paint("text"), bold: true },
		{
			text: item.kind === "consultation" ? item.consultationId : item.ticketIdentity,
			fg: paint("subtext0"),
		},
		{
			text: `Origin: ${workQueueOriginWord(item)}   place ${item.position + 1} of ${workQueueDepth}`,
			fg: paint("text"),
		},
		// Who asked for the start (ADR 0051, ADR 0068): the operator staged
		// this row, or the factory's top-up added it. The origin word alone
		// cannot tell them apart - the operator's route and the factory's
		// continuation are both `workflow` - and the queue's depth is the
		// operator's queue, not the factory's noise, so the detail says whose
		// start this is.
		{
			text:
				(item.kind === "handoff" && item.automatic) ||
				(item.kind === "plane-action" && item.automatic)
					? "Asked by: the factory's auto top-up"
					: "Asked by: the operator",
			fg: paint("subtext0"),
		},
		{ text: `Enqueued: ${item.enqueuedAt.slice(11, 19)}`, fg: paint("subtext0") },
	];
	lines.push(...kindDetailLines(item, row.method, consultation));
	lines.push({
		// The queue's row keys run in the queue's list, not in this pane:
		// the detail says where they answer instead of hinting keys the
		// mode it stands in never dispatches. The Consultation's Delete
		// unschedules the record instead of cancelling a start (issue #91,
		// ADR 0122), so the hint names what the record keeps.
		text:
			item.kind === "consultation"
				? "In the list: + and - reorder, Delete unschedules the Consultation"
				: "In the list: + and - reorder, Delete removes the start",
		fg: paint("subtext0"),
	});
	return lines;
}

/** The kind's own detail lines: the record, the action form, or the choice. */
function kindDetailLines(
	item: WorkQueueItem,
	method: string | undefined,
	consultation: Consultation | undefined,
): WorkQueueDetailLine[] {
	if (item.kind === "consultation") return consultationDetailLines(consultation);
	if (item.kind === "plane-action") return planeActionDetailLines(item, method);
	return handoffDetailLines(item);
}

/** The detail lines one Consultation item's record states. */
function consultationDetailLines(consultation: Consultation | undefined): WorkQueueDetailLine[] {
	if (consultation === undefined) {
		// The record the item names is gone: the pointer stands in the
		// queue with the fact that its record is not there to read.
		return [{ text: "Record: not found", fg: paint("yellow") }];
	}
	return [
		{ text: `Type: ${consultation.typeName}`, fg: paint("text") },
		{ text: `State: ${consultation.state}`, fg: paint("text") },
		{ text: `Repository: ${consultation.repository.displayName}`, fg: paint("text") },
	];
}

/** The detail lines one plane-action item's form states (ADR 0068). */
function planeActionDetailLines(
	item: WorkQueuePlaneActionItem,
	method: string | undefined,
): WorkQueueDetailLine[] {
	// The plane action's item carries the action form's facts (ADR 0068):
	// the task type whose action form the pickup runs, and the method the
	// form names. The item holds no settings of its own: the action form
	// stands in its place, and the run re-reads the form when it starts.
	return [
		{ text: `Task type: ${item.taskType}`, fg: paint("text") },
		{ text: `Method: ${method ?? DEFAULT_MERGE_METHOD}`, fg: paint("text") },
		{
			text: "The action holds no settings to edit: the merge runs on the task type's action form",
			fg: paint("subtext0"),
		},
	];
}

/** The detail lines one handoff item's choice states. */
function handoffDetailLines(item: WorkQueueHandoffItem): WorkQueueDetailLine[] {
	const lines: WorkQueueDetailLine[] = [
		{ text: `Agent: ${item.choice.agentType}`, fg: paint("text") },
		{ text: `Environment: ${item.choice.environment}`, fg: paint("text") },
		{ text: `Task type: ${item.choice.taskType}`, fg: paint("text") },
		{
			text: `Model: ${item.choice.model === "" ? "left to agent" : item.choice.model}`,
			fg: paint("text"),
		},
		{
			text: `Thinking: ${item.choice.thinking === "" ? "left to agent" : item.choice.thinking}`,
			fg: paint("text"),
		},
		{
			text: `Context: ${item.choice.contextWindow === "" ? "left to agent" : item.choice.contextWindow}`,
			fg: paint("text"),
		},
	];
	if (item.previousMessage !== "") {
		lines.push({ text: "Message carried in:", fg: paint("subtext0") });
		for (const line of item.previousMessage.split("\n"))
			lines.push({ text: line, fg: paint("text") });
	}
	return lines;
}
