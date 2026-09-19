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
import type { HandoffOrigin, WorkQueueItem } from "../state.ts";
import { usePaneGeometry } from "./geometry.ts";
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
export const workQueueOriginWord = (origin: HandoffOrigin): string =>
	origin === "open" ? "ticket detail" : origin === "workflow" ? "workflow route" : "restart";

/**
 * The captured facts of one Work queue item, as the detail pane shows them:
 * the ticket, the origin, and the operator's choice. A setting the operator
 * left empty says the agent's own default stands, the way the override
 * panel's empty rows do.
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
	push("Work queue item", paint("text"), true);
	push(`Ticket: ${item.ticketIdentity}`);
	push(`Origin: ${workQueueOriginWord(item.origin)}`);
	push(`Enqueued: ${item.createdAt.slice(0, 16).replace("T", " ")}`, paint("subtext0"));
	push(`Agent: ${item.choice.agentType === "" ? "(the agent's default)" : item.choice.agentType}`);
	push(`Environment: ${item.choice.environment}`);
	push(
		`Task type: ${item.choice.taskType === "" ? "(the agent's default)" : item.choice.taskType}`,
	);
	push(`Model: ${item.choice.model === "" ? "(the agent's default)" : item.choice.model}`);
	push(`Thinking: ${item.choice.thinking === "" ? "(the agent's default)" : item.choice.thinking}`);
	push(
		`Context window: ${item.choice.contextWindow === "" ? "(the agent's default)" : item.choice.contextWindow}`,
	);
	return lines.map((line) => ({ ...line, text: truncateToWidth(line.text, width) }));
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
	/** The item the shared detail pane points at, if the queue holds one. */
	item: WorkQueueItem | undefined;
	/** The detail's text width in cells. */
	width: number;
	focused: boolean;
	/** False while a surface above the panes owns the input. */
	active?: boolean;
	onFocus: () => void;
}

/**
 * The Work queue item's detail pane: the captured facts in a bordered box,
 * the same chrome the Consultation detail wears. The facts are static - the
 * item does not change while it waits - so the pane holds its lines without
 * a scroll.
 */
export function WorkQueueDetail({
	item,
	width,
	focused,
	active = true,
	onFocus,
}: WorkQueueDetailProps) {
	const rootRef = useRef<BoxRenderable | null>(null);
	const lines = workQueueDetailLines(item, width);
	return createElement(
		"box",
		{
			ref: rootRef,
			title: focused ? "❯ Work queue item" : "  Work queue item",
			border: true,
			borderColor: focused ? paint("accent") : paint("surface_dim"),
			padding: 1,
			style: { flexGrow: 1, flexShrink: 1, flexDirection: "column", overflow: "hidden" },
			onMouse: paneMouse({ active: () => active, onFocus, onWheel: () => undefined }),
		},
		...lines.map((line, index) =>
			createElement(
				"text",
				{ key: index, fg: line.fg },
				line.bold ? createElement("b", undefined, line.text) : line.text,
			),
		),
	);
}
