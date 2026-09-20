/**
 * The Work queue's list (ADR 0034): the manual starts waiting for a Parallel
 * limit seat, in the one shared order across kinds. A row carries the
 * identity of the start it waits for - the ticket's title for a handoff, the
 * record's identity prefix for the Consultation's item (issue #90) - the
 * start's origin word, and the item's place in the queue.
 */
import type { BoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { useRef } from "react";
import type { WorkQueueItem } from "../state.ts";
import { usePaneGeometry } from "./geometry.ts";
import { listMouse, listWindow } from "./list-pane.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { paint } from "./theme.ts";

export interface WorkQueueRow {
	/** The queue's item, in queue order. */
	item: WorkQueueItem;
	/** The ticket's title while it is still in the projection, its identity once it is gone. */
	title: string;
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

const ORIGIN_WIDTH = 10;

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
	return item.kind === "handoff" ? item.ticketIdentity : item.consultationId;
}

/** The word a row stands under, in the cell before its identity (ADR 0034):
 * the handoff's origin the pickup re-checks, and the Consultation item's
 * kind, the record the pointer names (issue #90). */
function originWord(item: WorkQueueItem): string {
	return item.kind === "handoff" ? `[${item.origin}]` : "consultation";
}

function itemRow(row: WorkQueueRow, selected: boolean, width: number) {
	const marker = selected ? "❯ " : "  ";
	const origin = originWord(row.item);
	const place = ` ${row.item.position + 1}`;
	const prefix = `${marker}${padToWidth(origin, ORIGIN_WIDTH)} `;
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
