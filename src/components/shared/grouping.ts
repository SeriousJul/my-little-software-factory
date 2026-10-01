/**
 * The Groups a section's list splits into: the shared grouping mechanism.
 *
 * A **Group** is a run of rows that share one value of one **Grouping axis**,
 * under one **Group header** the operator can collapse. The Groups stand in
 * the order the axis names (ADR 0071): the operator's own order of the Group
 * values, kept in the state file per axis, and the axis' fixed default order
 * where the operator has moved no Group. A Group's slot moves only on the
 * operator's own press, never on a refresh of the tickets' facts, and the
 * order *inside* a Group is exactly the order the flat list holds. Nothing
 * here re-sorts work, and nothing here reaches the queue order, the Top-up's
 * choice, or a detail pane.
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
import { holdsDecision, TICKET_STATES, type Ticket } from "../../domain/ticket.ts";
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
	const row = rows[settleRowIndex(rows, index)];
	if (row === undefined) return undefined;
	if (row.kind === "item") return { kind: "ticket", identity: row.item.identity };
	if (row.kind === "group") return { kind: "group", value: row.group.value };
	// The settle above never leaves the read on the air between Groups, so an
	// anchor is only ever missing where the list holds no row at all.
	return undefined;
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
	const clamped = (index: number) =>
		settleRowIndex(rows, Math.max(0, Math.min(index, Math.max(0, rows.length - 1))));
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
 * count among them, whether it stands collapsed, and the marker the section's
 * own facts stand on the header.
 */
export interface GroupHeader {
	/** The Group's own value word, in the same words the row badge uses. */
	value: string;
	/** The tickets the Group holds, open or collapsed. */
	count: number;
	/** The held turns among them: the decisions the fold cannot hide. */
	held: number;
	collapsed: boolean;
	/**
	 * The written-word marker the section stands on the header, in the marker
	 * column a ticket row owns. The section's own facts supply it (ADR 0075
	 * names the init marker on a repository Group header), and it is absent for
	 * a Group the section has no marker for. The word, not a color, is the fact,
	 * so it stands in the no-color presentation and under an inherited Theme.
	 */
	marker?: string;
}

/**
 * One row of a section's list: a row of the list itself, the header that opens
 * a Group of them, or the blank row that parts one Group from the next.
 *
 * The window, the mouse hit test, and the cursor step all read this one list,
 * so a header costs a window row and takes the cursor exactly like a row does.
 * The gap costs a window row as well, but it holds no cursor: the step crosses
 * over it and a click on it lands on the Group it belongs to.
 */
export type ListedRow<T> =
	| { kind: "item"; item: T }
	| { kind: "group"; group: GroupHeader }
	| { kind: "gap" };

/**
 * The row the cursor can hold at `index`, or the header below it for a gap.
 *
 * The air belongs to the Group under it, so the settle moves down to that
 * Group's header. A list never opens or closes with a gap, so a gap always has
 * a row below it to land on.
 */
export function settleRowIndex<T>(rows: readonly ListedRow<T>[], index: number): number {
	if (rows[index]?.kind !== "gap") return index;
	for (let at = index + 1; at < rows.length; at += 1) {
		if (rows[at]?.kind !== "gap") return at;
	}
	return index;
}

/**
 * The row `delta` steps from `from`, with the air between Groups crossed over.
 *
 * A gap is presentation, so no step may end on one: one step moves to the next
 * row that holds something, exactly the row a list without spacing walks to.
 * The walk stops at the list's own edge, so a step past the last row rests
 * there the way the flat list always did.
 */
export function stepRowIndex<T>(
	rows: readonly ListedRow<T>[],
	from: number,
	delta: number,
): number {
	if (rows.length === 0) return 0;
	let at = settleRowIndex(rows, Math.max(0, Math.min(rows.length - 1, from)));
	const direction = delta < 0 ? -1 : 1;
	for (let remaining = Math.abs(delta); remaining > 0; remaining -= 1) {
		const next = advanceRowIndex(rows, at, direction);
		if (next === at) break;
		at = next;
	}
	return at;
}

/** One row in `direction`'s direction, crossing the air that holds no cursor. */
function advanceRowIndex<T>(
	rows: readonly ListedRow<T>[],
	from: number,
	direction: 1 | -1,
): number {
	let at = Math.max(0, Math.min(rows.length - 1, from + direction));
	while (rows[at]?.kind === "gap") {
		const stepped = at + direction;
		// The list's edge row is never a gap, so the crossing cannot run off.
		if (stepped < 0 || stepped >= rows.length) return from;
		at = stepped;
	}
	return at;
}

/** The rows the cursor can rest on: the air between Groups holds none. */
export function cursorRowCount<T>(rows: readonly ListedRow<T>[]): number {
	let count = 0;
	for (const row of rows) {
		if (row.kind !== "gap") count += 1;
	}
	return count;
}

/** What the grouping mechanism asks the section for: the facts one row carries. */
export interface GroupingOf<T> {
	/** The axis in effect. `none` draws today's flat list, with no header. */
	axis: GroupingAxis;
	/** The Group value one row belongs to on the axis in effect. */
	keyOf: (item: T) => string;
	/** Whether the row holds a decision the operator owes. */
	heldOf: (item: T) => boolean;
	/** Whether the Group under this value stands collapsed. */
	isFolded: (value: string) => boolean;
	/**
	 * The Group values the operator ordered on the axis in effect, in the
	 * stored order (ADR 0071). It may name values no row carries today: the
	 * render drops them, and a move keeps their slots for the value's return.
	 */
	storedOrder?: readonly string[];
	/**
	 * The default order of Group values on the axis in effect (ADR 0071),
	 * smaller stands first. Only the split axes read it: `none` returns before
	 * the sort, and a caller that names none falls back to the value's name.
	 */
	defaultCompare?: (a: string, b: string) => number;
	/**
	 * The written-word marker the section stands on one Group header, by the
	 * Group's value, or null for none. The mechanism supplies the column and the
	 * render; the section supplies the fact (ADR 0075's init marker on a
	 * repository Group header). Absent for a section that wears no marker.
	 */
	groupMarker?: (value: string) => string | null;
}

/**
 * The full order one axis keeps in its store (ADR 0071): every stored value,
 * in the stored order, then every value a row carries that the operator never
 * ordered, in the axis' default order.
 *
 * The store is the operator's fact, so it is never pruned here: a value no row
 * carries keeps its slot, and a move that trades two values trades them in
 * this order, which is what lets a Group the filter hides keep the slot it
 * held while the visible list stands exactly as the press asked for.
 */
function fullOrderOf(
	stored: readonly string[],
	present: readonly string[],
	defaultCompare: (a: string, b: string) => number,
): string[] {
	const storedSet = new Set(stored);
	const rest = present
		.filter((value) => !storedSet.has(value))
		.sort((a, b) => defaultCompare(a, b) || a.localeCompare(b));
	return [...stored, ...rest];
}

/**
 * The Group order the render reads under the axis in effect (ADR 0071): the
 * stored order, only the values a row carries today, then the values the
 * operator never ordered, in the axis' default order.
 *
 * The render and the move both read the same rule, so a refresh and a press
 * can never disagree on where a Group stands, and a value the operator moved
 * comes back to the slot the move wrote when its rows return.
 */
export function groupOrderOf(
	stored: readonly string[],
	present: readonly string[],
	defaultCompare: (a: string, b: string) => number,
): readonly string[] {
	const presentSet = new Set(present);
	return fullOrderOf(stored, present, defaultCompare).filter((value) => presentSet.has(value));
}

/**
 * The stored order after the operator's move of one Group next to its visible
 * neighbor (ADR 0071): the two values trade their places in the full order,
 * and the answer is the order to store whole.
 *
 * One small table, one write rule: the store gains every value the list holds
 * on the first move of an axis, and a value the operator never moves again
 * keeps the slot the first move wrote. Null is the answer where either value
 * stands nowhere in the full order, the refusal the caller states on the
 * Message line.
 */
export function movedGroupOrder(
	stored: readonly string[],
	present: readonly string[],
	defaultCompare: (a: string, b: string) => number,
	value: string,
	neighbor: string,
): readonly string[] | null {
	const full = fullOrderOf(stored, present, defaultCompare);
	const from = full.indexOf(value);
	const to = full.indexOf(neighbor);
	if (from < 0 || to < 0) return null;
	const swap = full[from];
	full[from] = full[to];
	full[to] = swap;
	return full;
}

/**
 * The default order of one axis' Group values (ADR 0071): the order the
 * operator's own facts name, the one a Group stands in while the operator has
 * moved no Group on the axis.
 *
 * `position` reads the Workflow's own order of its positions, the order the
 * config's states stand in, with `unmatched` last and a position the config no
 * longer names after every named one. `state` reads the Ticket states in their
 * declared order. The name axes read the name, and `unknown` stands last the
 * way `unmatched` does. A value the axis does not name loses to the one it
 * does, and two values the axis names alike stand by their name.
 */
export function ticketGroupCompare(
	axis: SplitGroupingAxis,
	positionOrder: readonly string[],
): (a: string, b: string) => number {
	const rank = (value: string): number => {
		if (axis === "position") {
			if (value === UNMATCHED_GROUP) return Number.MAX_SAFE_INTEGER;
			const index = positionOrder.indexOf(value);
			return index >= 0 ? index : positionOrder.length;
		}
		if (axis === "state") {
			const index = (TICKET_STATES as readonly string[]).indexOf(value);
			return index >= 0 ? index : TICKET_STATES.length;
		}
		return value === UNKNOWN_GROUP ? Number.MAX_SAFE_INTEGER : 0;
	};
	return (a, b) => rank(a) - rank(b) || a.localeCompare(b);
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
		held: number;
	}
	const byValue = new Map<string, Running>();
	const groups: Running[] = [];
	for (const item of items) {
		const value = grouping.keyOf(item);
		let group = byValue.get(value);
		if (group === undefined) {
			group = { value, items: [], held: 0 };
			byValue.set(value, group);
			groups.push(group);
		}
		group.items.push(item);
		if (grouping.heldOf(item)) group.held += 1;
	}
	// A Group with no tickets cannot come from the rows, so no stale header
	// ever stands: the header set is derived from the rows on every read
	// (story 26, story 64). The order the Groups stand in is the order the axis
	// names (ADR 0071), and it reads no ticket's facts, so a refresh of the
	// facts cannot move a slot.
	const order = groupOrderOf(
		grouping.storedOrder ?? [],
		groups.map((group) => group.value),
		grouping.defaultCompare ?? ((a, b) => a.localeCompare(b)),
	);
	const slot = new Map(order.map((value, index) => [value, index]));
	groups.sort((left, right) => (slot.get(left.value) ?? 0) - (slot.get(right.value) ?? 0));
	const rows: ListedRow<T>[] = [];
	for (const group of groups) {
		const collapsed = grouping.isFolded(group.value);
		const marker = grouping.groupMarker?.(group.value) ?? null;
		// One blank row parts a Group from the one above it, and none stands
		// above the first: the list opens on its header exactly as it did before
		// the spacing, and every Group keeps the same air at its head.
		if (rows.length > 0) rows.push({ kind: "gap" });
		rows.push({
			kind: "group",
			group: {
				value: group.value,
				count: group.items.length,
				held: group.held,
				collapsed,
				...(marker === null ? {} : { marker }),
			},
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

/**
 * The Ticket list's rows under the axis in effect, with the operator's stored
 * order of the axis' Group values, and the Workflow's own order of its
 * positions for the `position` axis' default (ADR 0071).
 */
export function ticketRows(
	tickets: readonly Ticket[],
	axis: GroupingAxis,
	folds: GroupFolds,
	storedOrder: readonly string[],
	positionOrder: readonly string[],
	groupMarker?: (value: string) => string | null,
): readonly ListedRow<Ticket>[] {
	const folded = foldedValues(folds, axis);
	return groupedRows(tickets, {
		axis,
		keyOf: (ticket) => ticketGroupKey(axis, ticket),
		heldOf: holdsDecision,
		isFolded: (value) => folded.has(value),
		storedOrder,
		defaultCompare: axis === "none" ? undefined : ticketGroupCompare(axis, positionOrder),
		...(groupMarker === undefined ? {} : { groupMarker }),
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
	const dim = paint("subtext0");
	// One budget, spent by the fixed cells first, so the line never costs more
	// than the `usableCols` it is laid out on. The section's marker rides at the
	// row's end the way a ticket's trailing markers do, and it is reserved
	// before the counts so the value, not the marker, gives up cells.
	let room = usableCols - widthOf(prefix);
	const markerWord = group.marker === undefined ? "" : `  ${group.marker}`;
	const marker = markerWord !== "" && widthOf(markerWord) <= room ? markerWord : "";
	room -= widthOf(marker);
	const held = widthOf(counts.held) <= room ? counts.held : "";
	room -= widthOf(held);
	const total = widthOf(counts.total) <= room ? counts.total : "";
	room -= widthOf(total);
	// A room below one cell yields no value at all: the Group's words are the
	// first thing a narrow pane gives up, and its counts are the last.
	const value = truncateTailToWidth(group.value, room);
	return [
		createElement("span", { fg: selected ? paint("text") : dim }, prefix),
		// The Group's value leads the line the way a section header's name does,
		// and the cursor's row wears bold: the emphasis the plane carries
		// everywhere else.
		...(selected
			? [createElement("b", { fg: paint("text") }, value)]
			: [createElement("span", { fg: dim }, value)]),
		createElement("span", { fg: dim }, `${total}${held}`),
		// The marker the section's own facts stand on the header (ADR 0075's
		// init marker): a written word, so it stands in the no-color
		// presentation and under an inherited Theme alike.
		...(marker === "" ? [] : [createElement("span", { fg: paint("yellow") }, marker)]),
	];
}
