/**
 * The Work queue surface (ADR 0034, issue #88).
 *
 * The third Main view Section below the Consultation section: the ordered,
 * durable list of manual starts that wait for a free Parallel limit seat.
 * Its rows select into the shared detail pane, which shows the captured
 * facts of the item: the ticket, the origin, and the operator's choice.
 * The reorder and the removal keys live in the control catalogue under the
 * queue's own modes; this surface only shows the items and the facts.
 */
import type { BoxRenderable } from "@opentui/core";
import { createElement } from "@opentui/react";
import { useRef } from "react";
import { type HandoffOrigin, type WorkQueueItem, workQueueStartOf } from "../state.ts";
import { usePaneGeometry, windowOf } from "./geometry.ts";
import { listMouse, listWindow } from "./list-pane.ts";
import { paneMouse } from "./pane-mouse.ts";
import { padToWidth, truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

/** One line of the queue item's detail: the text and the color it paints. */
export interface WorkQueueDetailLine {
	text: string;
	fg: string | undefined;
	bold?: boolean;
}

/** The origin word a row and a detail line show for the item's origin. */
export const workQueueOriginWord = (origin: HandoffOrigin | null): string =>
	origin === null
		? "unreadable"
		: origin === "open"
			? "ticket detail"
			: origin === "workflow"
				? "workflow route"
				: "restart";

/** A setting the operator left empty leaves the room to the agent. */
const settingOf = (value: string): string => (value === "" ? "(the agent's default)" : value);

/**
 * The captured facts of one Work queue item, as the detail pane shows them:
 * the ticket, the origin, and the operator's choice. A setting the operator
 * left empty says the agent's own default stands, the way the override
 * panel's empty rows do. A row the store damaged says its damage in place of
 * the choice it cannot read, so the pane never shows a start the operator did
 * not ask for.
 */
export function workQueueDetailLines(
	item: WorkQueueItem | undefined,
	width: number,
): WorkQueueDetailLine[] {
	const lines: WorkQueueDetailLine[] = [];
	if (item === undefined) return [{ text: "no Work queue item selected", fg: paint("subtext0") }];
	const push = (text: string, fg: string | undefined = paint("text"), bold?: boolean) => {
		for (const line of wrapToWidth(text, width))
			lines.push({ text: line, fg, ...(bold ? { bold: true } : {}) });
	};
	const finish = (lines: WorkQueueDetailLine[]): WorkQueueDetailLine[] =>
		lines.map((line) => ({ ...line, text: truncateToWidth(line.text, width) }));
	push("Work queue item", paint("text"), true);
	push(`Ticket: ${item.ticketIdentity === "" ? "(unreadable)" : item.ticketIdentity}`);
	push(`Origin: ${workQueueOriginWord(item.origin)}`);
	// The stored time is UTC, and the line says so: a bare clock reading could
	// stand for the operator's own zone.
	push(`Enqueued: ${item.createdAt.slice(0, 16).replace("T", " ")} UTC`, paint("subtext0"));
	const start = workQueueStartOf(item);
	if (!start.ok) {
		push(`Damaged: ${start.reason}`, paint("yellow"));
		return finish(lines);
	}
	const choice = start.choice;
	push(`Agent: ${settingOf(choice.agentType)}`);
	push(`Environment: ${choice.environment}`);
	push(`Task type: ${settingOf(choice.taskType)}`);
	push(`Model: ${settingOf(choice.model)}`);
	push(`Thinking: ${settingOf(choice.thinking)}`);
	push(`Context window: ${settingOf(choice.contextWindow)}`);
	return finish(lines);
}

interface WorkQueueListProps {
	items: readonly WorkQueueItem[];
	selectedIndex: number;
	focused: boolean;
	/** The box's exact height in cells, from the Main view's section layout. */
	rows: number;
	emptyMessage?: string;
	/** False while a surface above the panes owns the input. */
	active?: boolean;
	onFocus: () => void;
	onSelect: (index: number) => void;
	onMove: (delta: number) => void;
}

/** The cells a row's origin word holds before the ticket identity. */
const ORIGIN_WIDTH = 14;

/**
 * The Work queue's list box, the third section of the Main view's left
 * column. One row per waiting item: its origin and its ticket, with the
 * shared list focus, wheel, and row-click policy.
 */
export function WorkQueueList({
	items,
	selectedIndex,
	focused,
	rows,
	emptyMessage,
	active = true,
	onFocus,
	onSelect,
	onMove,
}: WorkQueueListProps) {
	const geometry = usePaneGeometry("list");
	const visibleRows = Math.max(1, rows - 4);
	const rootRef = useRef<BoxRenderable | null>(null);
	const { start, visible } = listWindow(items, selectedIndex, visibleRows);
	const handleMouse = listMouse({
		active: () => active,
		onFocus,
		onMove,
		onSelect,
		rootRef,
		start,
		visibleRows: visible.length,
		itemCount: items.length,
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
				height: rows,
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
						truncateToWidth(emptyMessage ?? "no Work queue items", geometry.usableCols),
					),
				]
			: visible.map((item) =>
					createElement(
						"text",
						{ key: item.id },
						...row(item, item.id === items[selectedIndex]?.id, geometry.usableCols),
					),
				)),
	);
}

function row(item: WorkQueueItem, selected: boolean, width: number) {
	const marker = selected ? "❯ " : "  ";
	const prefix = `${marker}${padToWidth(workQueueOriginWord(item.origin), ORIGIN_WIDTH)} `;
	const available = Math.max(1, width - widthOf(prefix));
	return [
		selected
			? createElement("b", { fg: paint("text") }, prefix)
			: createElement("span", { fg: paint("subtext0") }, prefix),
		selected
			? createElement("b", { fg: paint("text") }, truncateToWidth(item.ticketIdentity, available))
			: createElement(
					"span",
					{ fg: paint("text") },
					truncateToWidth(item.ticketIdentity, available),
				),
	];
}

interface WorkQueueDetailProps {
	/** The captured facts, as `workQueueDetailLines` read the item. */
	lines: readonly WorkQueueDetailLine[];
	/** The rows the box can paint at once, from the shared detail geometry. */
	visibleRows: number;
	/** The pane's own scroll, clamped to the lines it holds. */
	scroll: number;
	focused: boolean;
	/** False while a surface above the panes owns the input. */
	active?: boolean;
	onFocus: () => void;
	onWheel: (delta: number) => void;
}

/**
 * The Work queue item's detail pane: the captured facts in a bordered box,
 * the same chrome the Consultation detail wears. The facts are static, but a
 * long ticket identity wraps the rows past the pane at the smallest frames, so
 * the pane slides a window over its lines like every other base detail.
 */
export function WorkQueueDetail({
	lines,
	visibleRows,
	scroll,
	focused,
	active = true,
	onFocus,
	onWheel,
}: WorkQueueDetailProps) {
	const rootRef = useRef<BoxRenderable | null>(null);
	return createElement(
		"box",
		{
			ref: rootRef,
			title: focused ? "❯ Work queue item" : "  Work queue item",
			border: true,
			borderColor: focused ? paint("accent") : paint("surface_dim"),
			padding: 1,
			style: { flexGrow: 1, flexShrink: 1, flexDirection: "column", overflow: "hidden" },
			onMouse: paneMouse({
				active: () => active,
				onFocus,
				onWheel: (direction) => onWheel(direction === "up" ? -1 : 1),
			}),
		},
		...windowOf(lines, scroll, visibleRows).map((line, index) =>
			createElement(
				"text",
				{ key: index, fg: line.fg },
				line.bold ? createElement("b", undefined, line.text) : line.text,
			),
		),
	);
}
