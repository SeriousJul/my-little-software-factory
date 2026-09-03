/**
 * Shared pane geometry.
 *
 * Every pane is a bordered box with one cell of inner padding, so its text
 * area is four cells smaller than the box in each dimension. The list pane
 * takes half the terminal width; the detail pane takes the rest. The list
 * box takes its box width from this math as an exact cell count, so one
 * computation owns the split and the rendered boxes can never drift from
 * the geometry the panes lay their text on.
 */
import { useTerminalDimensions } from "@opentui/react";

export interface PaneGeometry {
	/** The width of the pane's box in cells. */
	paneCols: number;
	/** The width of the pane's text area in cells. */
	usableCols: number;
	/** The height of the pane's text area in cells. */
	visibleRows: number;
}

/**
 * The geometry of one pane of the split.
 *
 * "list" takes the left half of the terminal, "detail" takes the half the
 * list does not take. One function serves both panes, so the two stay in
 * step when the layout changes.
 *
 * `reservedRows` are terminal rows the panes do not take: the app shell
 * reserves one for the Message line when it carries a message, and the pane
 * boxes render one row shorter. The window math must agree with the boxes,
 * so the reservation travels to the panes as a prop.
 */
export function usePaneGeometry(kind: "list" | "detail", reservedRows = 0): PaneGeometry {
	const { width, height } = useTerminalDimensions();
	const paneCols = kind === "list" ? Math.floor(width / 2) : width - Math.floor(width / 2);
	return {
		paneCols,
		usableCols: Math.max(1, paneCols - 4),
		visibleRows: Math.max(1, height - reservedRows - 4),
	};
}

/**
 * How far a window of `visibleRows` lines can slide through `lineCount`
 * lines.
 *
 * The app shell uses this to clamp the detail scroll state, and
 * `windowOf` uses it to clamp a window start. One definition keeps the
 * two panes in step.
 */
export function maxScrollOf(lineCount: number, visibleRows: number): number {
	return Math.max(0, lineCount - visibleRows);
}

/**
 * A clamped window over a line list: `visibleRows` items starting at
 * `start`, clamped so the window never runs past either edge.
 *
 * Both panes slide a window over their lines through this one shape. The
 * list pane derives its start from the selection, the detail pane takes
 * the scroll it is handed.
 */
export function windowOf<T>(items: readonly T[], start: number, visibleRows: number): T[] {
	const offset = Math.max(0, Math.min(start, maxScrollOf(items.length, visibleRows)));
	return items.slice(offset, offset + visibleRows);
}
