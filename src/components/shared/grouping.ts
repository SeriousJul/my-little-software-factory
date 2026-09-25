/**
 * The Groups a section's list splits into: the shared grouping mechanism.
 *
 * A **Group** is a run of rows that share one value of one **Grouping axis**,
 * under one **Group header** the operator can collapse. The whole shape is
 * presentation of the order the list already holds (ADR 0059): the Groups stand
 * by the best Attention band among the rows they hold, then by the newest
 * external update in the Group, then by the Group value, and the order *inside*
 * a Group is exactly the order the flat list holds. Nothing here re-sorts work,
 * and nothing here reaches the queue order, the Top-up's choice, or a detail
 * pane.
 *
 * The mechanism is shared; the facts a section's rows carry come in through
 * `GroupingOf`, so a second list that takes grouping later supplies its own key
 * rule and reuses the ordering, the fold store, the header, and the window over
 * the mixed row list. Only the Ticket section asks for it today (issue #159).
 *
 * A fold hides rows and never facts (ADR 0059): the rows a fold takes away are
 * the only thing this module removes, and a collapsed header still carries its
 * count and its held count so an owed decision stays named at the fold. Which
 * Groups stand folded is a session fact (`GroupFolds`) and never a durable one
 * (ADR 0058); the axis itself is factory state and lives in the state file.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";

import type { GroupingAxis, SplitGroupingAxis } from "../../domain/grouping.ts";
import { attentionBand, holdsDecision, type Ticket } from "../../domain/ticket.ts";
import { newestMembership } from "../../task-selection.ts";
import { truncateTailToWidth, widthOf } from "../text.ts";
import { paint, ticketTaskType } from "../theme.ts";

/** The word a header stands on when the `position` axis finds no State. */
export const UNMATCHED_GROUP = "unmatched";
/** The word a header stands on when a row carries no fact for the axis. */
const UNKNOWN_GROUP = "unknown";

/**
 * The cursor's place in a row list, kept as the fact that identifies it.
 *
 * A row index is meaningless across a change of the axis or the folds, so the
 * cursor carries the ticket identity it stands on, or the Group value when it
 * stands on a header. That anchor is what lets a press of the axis, a fold, and
 * a re-read all keep the operator's place (issue #159, user stories 42 and 43).
 */
export type RowAnchor = { kind: "ticket"; identity: string } | { kind: "group"; value: string };

/** A row list whose items the cursor can hold onto by the item's own identity. */
export interface IdentifiedItem {
	identity: string;
}

/** The anchor for the cursor's row, or nothing for an index past the list. */
export function rowAnchorOf<T extends IdentifiedItem>(
	rows: readonly ListedRow<T>[],
	index: number,
): RowAnchor | undefined {
	const row = rows[index];
	if (row === undefined) return undefined;
	return row.kind === "item"
		? { kind: "ticket", identity: row.item.identity }
		: { kind: "group", value: row.group.value };
}

/**
 * The row an anchor names in a new row list, or the row nearest where it stood.
 *
 * A ticket whose new Group stands folded has no row to hold, so the cursor
 * lands on that Group's header: the place stays the operator's own, the fold
 * never opens itself, and nothing is lost to a re-read (ADR 0059).
 */
export function rowIndexForAnchor<T extends IdentifiedItem>(
	rows: readonly ListedRow<T>[],
	anchor: RowAnchor | undefined,
	fallbackIndex: number,
	items: readonly T[],
	keyOf: (item: T) => string,
): number {
	const clamped = (index: number) => Math.max(0, Math.min(index, Math.max(0, rows.length - 1)));
	if (anchor === undefined) return clamped(fallbackIndex);
	const at = rows.findIndex((row) =>
		anchor.kind === "ticket"
			? row.kind === "item" && row.item.identity === anchor.identity
			: row.kind === "group" && row.group.value === anchor.value,
	);
	if (at >= 0) return at;
	if (anchor.kind === "group") return clamped(fallbackIndex);
	const item = items.find((candidate) => candidate.identity === anchor.identity);
	if (item === undefined) return clamped(fallbackIndex);
	const header = rows.findIndex((row) => row.kind === "group" && row.group.value === keyOf(item));
	// The ticket is nowhere in the list: it left with the re-read, so the cursor
	// takes the row nearest the one it held, the way a refresh always did.
	if (header < 0) return clamped(fallbackIndex);
	return header;
}

/** The Ticket list's own anchor read, with the axis' key rule applied. */
export function ticketRowIndexForAnchor(
	rows: readonly ListedRow<Ticket>[],
	anchor: RowAnchor | undefined,
	fallbackIndex: number,
	tickets: readonly Ticket[],
	axis: GroupingAxis,
): number {
	return rowIndexForAnchor(rows, anchor, fallbackIndex, tickets, (ticket) =>
		ticketGroupKey(axis, ticket),
	);
}

/**
 * The Action bar hint: the split the list wears.
 *
 * The `none` axis draws no hint: the flat list needs no word that says so, and
 * the control's `showInBar` hides its entry there (issue #159), so only an axis
 * that splits the list into Groups can reach a bar, and only those axes stand in
 * this function's type. The Key guide carries the control in every frame, and
 * the Message line states every change.
 */
export function groupingAxisHint(axis: SplitGroupingAxis): string {
	return `Group: ${axis}`;
}

/** The Message line a press of the axis control leaves on every change. */
export function groupingAxisNotice(axis: GroupingAxis): string {
	return axis === "none"
		? "Ticket list grouping off: the flat list"
		: `Ticket list grouped by ${axis}`;
}

/**
 * The empty list's message, with the axis in effect named.
 *
 * "No tickets" on its own cannot say which view the operator is reading, so a
 * grouped list states its split in the one row the empty pane shows.
 */
export function groupingEmptyMessage(base: string, axis: GroupingAxis): string {
	return axis === "none" ? base : `${base} - grouped by ${axis}`;
}

/**
 * One Group as a header row shows it: its value, the rows it holds, the held
 * count among them, and whether it stands collapsed.
 */
export interface GroupHeader {
	/** The Group's own value word, in the same words the row badge uses. */
	value: string;
	/** The tickets the Group holds, open or collapsed. */
	count: number;
	/** The held turns among them: the decisions the fold cannot hide. */
	held: number;
	collapsed: boolean;
}

/**
 * One row of a section's list: a row of the list itself, or the header that
 * opens a Group of them.
 *
 * The window, the mouse hit test, and the cursor step all read this one list,
 * so a header costs a window row and takes the cursor exactly like a row does.
 */
export type ListedRow<T> = { kind: "item"; item: T } | { kind: "group"; group: GroupHeader };

/** What the grouping mechanism asks the section for: the facts one row carries. */
export interface GroupingOf<T> {
	/** The axis in effect. `none` draws today's flat list, with no header. */
	axis: GroupingAxis;
	/** The Group value one row belongs to on the axis in effect. */
	keyOf: (item: T) => string;
	/** The row's Attention band: the list's first sort (ADR 0050). */
	bandOf: (item: T) => number;
	/** The row's newest external update, the Group's second rank. */
	updatedOf: (item: T) => string;
	/** Whether the row holds a decision the operator owes. */
	heldOf: (item: T) => boolean;
	/** Whether the Group under this value stands collapsed. */
	isFolded: (value: string) => boolean;
}

/**
 * The list's rows under the axis in effect: a Group header above each run, and
 * a collapsed Group reduced to its header.
 *
 * The items arrive in the flat list's order and keep it. `none` returns that
 * order with no header, which is the list exactly as it stood before grouping.
 */
export function groupedRows<T>(
	items: readonly T[],
	grouping: GroupingOf<T>,
): readonly ListedRow<T>[] {
	if (grouping.axis === "none") return items.map((item): ListedRow<T> => ({ kind: "item", item }));
	interface Running {
		value: string;
		items: T[];
		band: number;
		updated: string;
		held: number;
	}
	const byValue = new Map<string, Running>();
	const groups: Running[] = [];
	for (const item of items) {
		const value = grouping.keyOf(item);
		let group = byValue.get(value);
		if (group === undefined) {
			group = {
				value,
				items: [],
				band: grouping.bandOf(item),
				updated: grouping.updatedOf(item),
				held: 0,
			};
			byValue.set(value, group);
			groups.push(group);
		}
		group.items.push(item);
		// The Group ranks by the best row it holds, never by the first one it
		// met: a run that gains an awaiting ticket moves with it (story 47).
		const band = grouping.bandOf(item);
		if (band < group.band) group.band = band;
		const updated = grouping.updatedOf(item);
		if (updated > group.updated) group.updated = updated;
		if (grouping.heldOf(item)) group.held += 1;
	}
	// A Group with no tickets cannot come from the rows, so no stale header
	// ever stands: the header set is derived from the rows on every read
	// (story 26, story 64).
	groups.sort(
		(left, right) =>
			left.band - right.band ||
			right.updated.localeCompare(left.updated) ||
			left.value.localeCompare(right.value),
	);
	const rows: ListedRow<T>[] = [];
	for (const group of groups) {
		const collapsed = grouping.isFolded(group.value);
		rows.push({
			kind: "group",
			group: { value: group.value, count: group.items.length, held: group.held, collapsed },
		});
		if (collapsed) continue;
		for (const item of group.items) rows.push({ kind: "item", item });
	}
	return rows;
}

/**
 * The Groups the operator folded: one set of values per axis, in memory for the
 * run.
 *
 * Keyed by the axis as well as the value, so an axis the operator visits twice
 * in one run comes back as they left it (story 54) and a fold set for one axis
 * never folds a Group of another. It is never written to the state file
 * (ADR 0058), and the plane never folds or unfolds a Group on its own: only a
 * press or a click moves it, so a fold cannot shift under the operator when a
 * ticket's facts change (story 35).
 */
export type GroupFolds = Readonly<Partial<Record<GroupingAxis, ReadonlySet<string>>>>;

/** No Group stands folded: the shape every run starts with. */
export const NO_GROUP_FOLDS: GroupFolds = {};

/** The values folded on one axis. */
export function foldedValues(folds: GroupFolds, axis: GroupingAxis): ReadonlySet<string> {
	return folds[axis] ?? new Set<string>();
}

/** The same folds with one Group's fold moved the other way. */
export function toggleFold(folds: GroupFolds, axis: GroupingAxis, value: string): GroupFolds {
	const next = new Set(foldedValues(folds, axis));
	if (next.has(value)) next.delete(value);
	else next.add(value);
	return { ...folds, [axis]: next };
}

/** The Ticket list's rows under the axis in effect. */
export function ticketRows(
	tickets: readonly Ticket[],
	axis: GroupingAxis,
	folds: GroupFolds,
): readonly ListedRow<Ticket>[] {
	const folded = foldedValues(folds, axis);
	return groupedRows(tickets, {
		axis,
		keyOf: (ticket) => ticketGroupKey(axis, ticket),
		bandOf: attentionBand,
		updatedOf: (ticket) => ticket.externalUpdatedAt,
		heldOf: holdsDecision,
		isFolded: (value) => folded.has(value),
	});
}

/**
 * The Group value one Ticket belongs to on one axis: a fact of the ticket,
 * never a face the row wears (ADR 0059).
 *
 * A Queue wait's `queued` badge groups under `open`, a Starting window's
 * spinner under `handed-off`, and a held turn under `awaiting`, because each of
 * those is a presentation of a state and a poll-time marker. The Task axis
 * reads the row's own badge rule, so `parked` and `unknown` are Groups of their
 * own and the Group a row sits in is always explainable from the row. The
 * Position axis reads the Workflow state the projection matched on this read,
 * with `unmatched` for a ticket no State holds. The Source axis takes the
 * leading membership's name, which is the source the row's own facts come from,
 * so a ticket two feeds list appears once (story 13).
 */
export function ticketGroupKey(axis: GroupingAxis, ticket: Ticket): string {
	switch (axis) {
		case "none":
			return "";
		case "repository":
			return ticket.repository;
		case "source":
			return newestMembership(ticket.memberships)?.sourceName ?? UNKNOWN_GROUP;
		case "task":
			return ticketTaskType(ticket).value;
		case "state":
			return ticket.state;
		case "position":
			return ticket.matchedStateName ?? UNMATCHED_GROUP;
	}
}

/**
 * The counts a header carries, as the two fields a narrow budget drops in order.
 *
 * The held count is the payload a fold cannot hide (ADR 0059), so it stands
 * last: the ticket count gives up its cells before it does.
 */
function groupCountFields(group: GroupHeader): { total: string; held: string } {
	return { total: `  ${group.count}`, held: group.held > 0 ? `  held ${group.held}` : "" };
}

/**
 * One Group header as spans on an exact cell budget.
 *
 * The header owns the marker column a ticket row owns, so the cursor reads the
 * same at either kind of row and the member rows keep all their cells
 * (story 28). The row follows the list pane's rule, shared with the ticket
 * rows beside it: a field is dropped, never wrapped. A header that overflowed
 * its pane would cost the window two rows and split its counts across them, so
 * an operator who folds a Group would lose the very fact that justified the
 * fold (ADR 0059). The value gives up its tail first and its last cell too; the
 * ticket count gives up before the held count does; and the marker column
 * stands either way, because it carries the cursor and the fold. Neither side
 * is padded out to the pane: the header reads as one short line the way a row
 * with no repository does. The fold rides on the glyph and never on a color,
 * so the no-color presentation loses nothing and a fold cannot be missed where
 * the terminal paints no color.
 */
export function groupHeaderSpans(
	group: GroupHeader,
	selected: boolean,
	usableCols: number,
): ReactElement[] {
	const prefix = `${selected ? "❯ " : "  "}${group.collapsed ? "▸" : "▾"} `;
	const counts = groupCountFields(group);
	// One budget, spent by the fixed cells first, so the line never costs more
	// than the `usableCols` it is laid out on.
	let room = usableCols - widthOf(prefix);
	const held = widthOf(counts.held) <= room ? counts.held : "";
	room -= widthOf(held);
	const total = widthOf(counts.total) <= room ? counts.total : "";
	room -= widthOf(total);
	// A room below one cell yields no value at all: the Group's words are the
	// first thing a narrow pane gives up, and its counts are the last.
	const value = truncateTailToWidth(group.value, room);
	const dim = paint("subtext0");
	return [
		createElement("span", { fg: selected ? paint("text") : dim }, prefix),
		// The Group's value leads the line the way a section header's name does,
		// and the cursor's row wears bold: the emphasis the plane carries
		// everywhere else.
		...(selected
			? [createElement("b", { fg: paint("text") }, value)]
			: [createElement("span", { fg: dim }, value)]),
		createElement("span", { fg: dim }, `${total}${held}`),
	];
}
