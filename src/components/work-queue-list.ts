/**
 * The Work queue's list (ADR 0034): the manual starts waiting for a Parallel
 * limit seat, in the one shared order across kinds. A row carries the task
 * type the start runs - the handoff's captured choice, the plane action's
 * task type, the Consultation record's type - the name the row stands under,
 * and the item's place in the queue. The name is the ask: the ticket's
 * title, the Consultation's input, the text the operator typed on the new
 * consultation screen. Being in the queue is the item's own state, so a row
 * wears no state word.
 */
import type { BoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { useRef } from "react";
import type { WorkQueueItem } from "../state/work-queue.ts";
import type { WorkQueueSectionFacts } from "./controls.ts";
import { usePaneGeometry } from "./geometry.ts";
import { listMouse, listWindow } from "./list-pane.ts";
import { firstLineOf, padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { paint } from "./theme.ts";

export interface WorkQueueRow {
	/** The queue's item, in queue order. */
	item: WorkQueueItem;
	/** The name the row stands under: the ticket's title while it is still in the projection, its identity once it is gone, the Consultation's input while the record holds one, the record's identity prefix once it is gone or its input holds no line (issue #90). */
	title: string;
	/** The task type the start runs: the handoff's captured choice, the plane action's task type (ADR 0068), the Consultation record's type. Empty when the record the Consultation item names is gone. */
	taskType: string;
	/** The method the plane action's item runs with, from its task type's action form (ADR 0068). */
	method?: string;
}

/**
 * The reads the row conversion draws on, owned by the surface that holds the
 * projections the words stand on. The conversion is the one source of truth
 * the list and the detail both read, so no surface assembles a row's words
 * on its own.
 */
export interface WorkQueueRowSources {
	/** The ticket's title while it stands in the projection; undefined once it is gone. */
	ticketTitle: (ticketIdentity: string) => string | undefined;
	/** The type the Consultation record the item names stands in; undefined when the record is gone. */
	consultationType: (consultationId: string) => string | undefined;
	/** The input the operator typed for the Consultation record the item names, on the new consultation screen; undefined when the record is gone. */
	consultationInput: (consultationId: string) => string | undefined;
	/** The method the plane action's task type's action form names (ADR 0068). */
	planeActionMethod: (taskType: string) => string | undefined;
}

export function workQueueRowFacts(
	items: readonly WorkQueueItem[],
	sources: WorkQueueRowSources,
): readonly WorkQueueRow[] {
	return items.map((item): WorkQueueRow => {
		if (item.kind === "consultation") {
			// The row stands under the ask the operator typed, the word the
			// Consultation section's list stands the record under, and keeps
			// the identity prefix where the input holds no line.
			const ask = firstLineOf(sources.consultationInput(item.consultationId) ?? "");
			return {
				item,
				title: ask === "" ? item.consultationId.slice(0, 8) : ask,
				taskType: sources.consultationType(item.consultationId) ?? "",
			};
		}
		const title = sources.ticketTitle(item.ticketIdentity) ?? item.ticketIdentity;
		if (item.kind === "plane-action") {
			const method = sources.planeActionMethod(item.taskType);
			return {
				item,
				title,
				taskType: item.taskType,
				...(method === undefined ? {} : { method }),
			};
		}
		return { item, title, taskType: item.choice.taskType };
	});
}

interface WorkQueueListProps {
	rows: readonly WorkQueueRow[];
	selectedIndex: number;
	focused: boolean;
	/** The box's exact height in cells, from the Main view's section layout. */
	height: number;
	emptyMessage?: string;
	/** False while a surface above the panes owns the input. */
	active?: boolean;
	onFocus: () => void;
	onSelect: (index: number) => void;
	onMove: (delta: number) => void;
}

/** The cell the row's task type stands in, before the row's name. */
const TYPE_CELL_WIDTH = 10;

export function WorkQueueList({
	rows,
	selectedIndex,
	focused,
	height,
	emptyMessage,
	active = true,
	onFocus,
	onSelect,
	onMove,
}: WorkQueueListProps) {
	const geometry = usePaneGeometry("list");
	// The Main view hands the box its exact height: two border rows and two
	// padding rows are chrome, and the rest is the window's room.
	const visibleRows = Math.max(1, height - 4);
	const rootRef = useRef<BoxRenderable | null>(null);
	const { start, visible } = listWindow(rows, selectedIndex, visibleRows);
	const handleMouse = listMouse({
		active: () => active,
		onFocus,
		onMove,
		onSelect,
		rootRef,
		start,
		visibleRows: visible.length,
		itemCount: rows.length,
	});
	return createElement(
		"box",
		{
			ref: rootRef,
			onMouse: handleMouse,
			title: focused ? "❯ Work queue" : "  Work queue",
			border: true,
			borderColor: focused ? paint("accent") : paint("surface_dim"),
			padding: 1,
			style: {
				width: geometry.paneCols,
				height,
				flexGrow: 0,
				flexShrink: 0,
				flexDirection: "column",
				overflow: "hidden",
			},
		},
		...(visible.length === 0
			? [
					createElement(
						"text",
						{ key: "empty", fg: paint("subtext0") },
						truncateToWidth(emptyMessage ?? "no waiting starts", geometry.usableCols),
					),
				]
			: visible.map((row) =>
					createElement(
						"text",
						{ key: rowKey(row.item) },
						...itemRow(
							row,
							rowKey(row.item) === rowKey(rows[selectedIndex]?.item ?? row.item) &&
								rows[selectedIndex]?.item.kind === row.item.kind,
							geometry.usableCols,
						),
					),
				)),
	);
}

/** The one identity that stands in the row's key and its selection check. */
function rowKey(item: WorkQueueItem): string {
	return item.kind === "consultation" ? item.consultationId : item.ticketIdentity;
}

/** The origin word the detail pane names (ADR 0034, ADR 0068): the
 * handoff's origin the pickup re-checks, the Consultation item's kind, and
 * the plane action's kind, the merge the action runs. */
export function workQueueOriginWord(item: WorkQueueItem): string {
	if (item.kind === "plane-action") return "merge";
	return item.kind === "handoff" ? item.origin : "consultation";
}

function itemRow(row: WorkQueueRow, selected: boolean, width: number) {
	const marker = selected ? "❯ " : "  ";
	const place = ` ${row.item.position + 1}`;
	const prefix = `${marker}${padToWidth(row.taskType, TYPE_CELL_WIDTH)} `;
	const suffix = place;
	const available = Math.max(1, width - widthOf(prefix) - widthOf(suffix));
	// The selected row's prefix and title wear bold: the emphasis the old
	// palette carried in a brighter text color.
	return [
		selected
			? createElement("b", { fg: paint("text") }, prefix)
			: createElement("span", { fg: paint("subtext0") }, prefix),
		selected
			? createElement("b", { fg: paint("text") }, truncateToWidth(row.title, available))
			: createElement("span", { fg: paint("text") }, truncateToWidth(row.title, available)),
		createElement(
			"span",
			{ fg: paint("subtext0") },
			truncateToWidth(suffix, Math.max(0, width - widthOf(prefix) - available)),
		),
	];
}

/**
 * The Availability facts the Work queue's own rows produce for one cursor.
 *
 * The item under the cursor and the queue's depth come from the queue this
 * section draws, so the queue's order keys and its force-dispatch cannot
 * disagree with the queue itself (ADR 0034). The queue pause stands in the
 * plane's standing facts (ADR 0111): it is the fact a control every mode
 * dispatches reads, and the queue's rows read it from there.
 */
export type WorkQueueCursorFacts = WorkQueueSectionFacts;

export function workQueueCursorFacts(
	items: readonly WorkQueueItem[],
	index: number,
): WorkQueueCursorFacts {
	return {
		selectedWorkQueueItem: items[index] ?? null,
		workQueueDepth: items.length,
	};
}

/**
 * The item that waits under a Ticket row (ADR 0049).
 *
 * A row whose Ticket has a waiting start in the queue carries that item, and
 * Enter on the row jumps to it. A row that holds no Ticket - a Group header -
 * waits with nothing.
 */
export function handoffItemWaitingForTicket(
	items: readonly WorkQueueItem[],
	ticketIdentity: string | undefined,
): WorkQueueItem | null {
	if (ticketIdentity === undefined) return null;
	return (
		items.find((item) => item.kind === "handoff" && item.ticketIdentity === ticketIdentity) ?? null
	);
}

/** The item that waits under a Consultation row (ADR 0049). */
export function consultationItemWaitingFor(
	items: readonly WorkQueueItem[],
	consultationId: string | undefined,
): WorkQueueItem | null {
	if (consultationId === undefined) return null;
	return (
		items.find((item) => item.kind === "consultation" && item.consultationId === consultationId) ??
		null
	);
}
