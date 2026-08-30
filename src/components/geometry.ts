/**
 * Shared pane geometry.
 *
 * Every pane is a bordered box with one cell of inner padding, so its text
 * area is four cells smaller than the box in each dimension. The list pane
 * takes half the terminal width; the detail pane takes the rest. Keeping the
 * math in one place keeps the two panes in step when the layout changes.
 */
import { useTerminalDimensions } from "@opentui/react";

export interface PaneGeometry {
	/** The width of the pane's text area in cells. */
	usableCols: number;
	/** The height of the pane's text area in cells. */
	visibleRows: number;
}

function usePaneGeometry(kind: "list" | "detail"): PaneGeometry {
	const { width, height } = useTerminalDimensions();
	const paneCols = kind === "list" ? Math.floor(width / 2) : width - Math.floor(width / 2);
	return {
		usableCols: Math.max(1, paneCols - 4),
		visibleRows: Math.max(1, height - 4),
	};
}

/** The geometry of the list pane: the left half of the terminal. */
export function useListGeometry(): PaneGeometry {
	return usePaneGeometry("list");
}

/** The geometry of the detail pane: the half the list does not take. */
export function useDetailGeometry(): PaneGeometry {
	return usePaneGeometry("detail");
}

/**
 * How far a window of `visibleRows` lines can slide through `lineCount`
 * lines.
 *
 * The app shell uses this to clamp the detail scroll state, and the detail
 * pane uses it to clamp the scroll it is handed. One definition keeps the
 * two in step.
 */
export function maxScrollOf(lineCount: number, visibleRows: number): number {
	return Math.max(0, lineCount - visibleRows);
}
