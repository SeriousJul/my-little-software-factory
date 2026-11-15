/**
 * The Decision region's state: the rows the operator confirms, bounded and
 * scrolling (ADR 0039).
 *
 * The region's selection, its wrap, the auto-scroll that keeps the cursor's
 * row visible, the visible window, and the range text are one control
 * behavior, so they live here in the shared control library, one module
 * beside the field, the selector row, and the form (ADR 0040). The chrome
 * and every surface that shows decision rows consume this module, and the
 * rows the region paints are the rows this module names, so a surface that
 * keeps its own selection state cannot drift from the range its bar states.
 */
import { useRef, useState } from "react";

import type { ActionRow } from "../modal-chrome.ts";

/**
 * The compact range readout: the first row through the last row, of the
 * total - `1-10/24`.
 *
 * This is the one home of the readout, behind both the Decision region's
 * range text and the utility overlays' own scroll windows, so the shape the
 * Action bar states cannot drift from the window that stands behind it
 * (issue #122).
 */
export function rangeTextOf(top: number, visibleCount: number, total: number): string {
	return `${total === 0 ? 0 : top + 1}-${Math.min(total, top + visibleCount)}/${total}`;
}

/** The Decision region's state at one render. */
export interface DecisionRegion {
	/** The row to paint as selected. */
	at: number;
	/** Move by a wrapped step, keeping the cursor's row visible. */
	move: (delta: number) => void;
	/** Move the cursor by one visible window, clamped at the region's edges. */
	pageMove: (direction: 1 | -1) => void;
	/** Place the cursor on the region's first or last row. */
	moveEdge: (edge: "start" | "end") => void;
	/** Confirm the selected row, then clear the selection. */
	confirm: (run: (row: ActionRow) => void) => void;
	/** The rows the region shows, in order. */
	window: readonly ActionRow[];
	/**
	 * The rows the region holds, shown or not.
	 *
	 * The catalogue refuses the region's selection where the region holds one
	 * row, so the count the region's own cursor walks is the count the gate
	 * reads (ADR 0039).
	 */
	rowCount: number;
	/**
	 * The region's range text: first-last of total, behind the selection's
	 * hint on the Action bar. Absent when the region shows every row.
	 */
	rangeText: string | undefined;
}

/**
 * The window top that shows the row: the highest window that fits the
 * region, slid so the row stands inside the window. A screen that resumes
 * seeds its region's window from this, so the window it stood on stands again.
 */
export function regionTopFor(row: number, count: number, visibleRows: number): number {
	const limit = Math.max(0, Math.floor(visibleRows));
	if (limit === 0) return 0;
	const maxTop = Math.max(0, count - limit);
	let top = Math.min(Math.max(0, row), maxTop);
	if (row - top + 1 > limit) top = row - limit + 1;
	if (top < 0) top = 0;
	return top;
}

/**
 * The bounded scrolling selection over one region's rows.
 *
 * `visibleRows` is the cap the box has room for once the body has paid its
 * floor, and a region that shows everything it holds states no range. The
 * index lives in a ref as well as in state: the operator can press the next
 * key before React re-renders, and the step must count from the row they
 * landed on rather than from the row last painted. Selecting wraps, so
 * every row stays one step away in either direction, and the window follows
 * the cursor when the step would leave it. A screen that resumes seeds the
 * selection and the window from the row the stack preserved, so the region
 * stands on the row it was suspended on.
 */
export function useDecisionRegion(
	rows: readonly ActionRow[],
	visibleRows: number,
	initialSelected = 0,
): DecisionRegion {
	const [selected, setSelected] = useState(initialSelected);
	const [top, setTop] = useState(() => regionTopFor(initialSelected, rows.length, visibleRows));
	const ref = useRef(initialSelected);
	const count = rows.length;
	const last = Math.max(0, count - 1);
	const limit = Math.max(0, Math.floor(visibleRows));
	const at = Math.min(selected, last);
	const maxTop = Math.max(0, count - limit);
	const windowTop = Math.min(top, maxTop);
	const window = limit === 0 ? [] : rows.slice(windowTop, windowTop + limit);
	// The one place a cursor lands: the index clamps to the region's rows, and
	// the auto-scroll slides the window to the cursor's row when the step
	// would leave it, so a scroll the region's own rows ask for never crosses
	// the cursor.
	const place = (index: number) => {
		const clamped = Math.max(0, Math.min(index, last));
		ref.current = clamped;
		setSelected(clamped);
		setTop((current) => {
			const t = Math.min(current, maxTop);
			if (clamped < t) return clamped;
			if (clamped >= t + limit) return clamped - limit + 1;
			return t;
		});
	};
	return {
		at,
		rowCount: count,
		move: (delta: number) => {
			if (count === 0) return;
			place((Math.min(ref.current, last) + delta + count) % count);
		},
		// The page and the edge never wrap: the step's wrap keeps every row one
		// step away, but the page and the edge reach an end, and an end past the
		// region's last row is the last row.
		pageMove: (direction: 1 | -1) => {
			if (count === 0) return;
			place(ref.current + direction * Math.max(1, limit));
		},
		moveEdge: (edge: "start" | "end") => {
			if (count === 0) return;
			place(edge === "start" ? 0 : last);
		},
		confirm: (run: (row: ActionRow) => void) => {
			const row = rows[Math.min(ref.current, last)];
			ref.current = 0;
			setSelected(0);
			setTop(0);
			if (row !== undefined) run(row);
		},
		window,
		rangeText:
			limit > 0 && count > limit ? rangeTextOf(windowTop, window.length, count) : undefined,
	};
}

/**
 * The Body pane's window facts.
 *
 * The pane holds more rows than its window shows, or it holds nothing at all.
 * The catalogue gates the body's scroll on the pair, so the Action bar never
 * hints a scroll that cannot run and a pressed key says why (ADR 0039). The
 * region module owns the window over a pane's rows, so it states the pair from
 * the counts the pane already computed.
 */
export function bodyPaneFacts(
	rows: number,
	windowRows: number,
	carriesNothing: boolean,
): { bodyScrollable: boolean; bodyEmpty: boolean } {
	return {
		bodyEmpty: carriesNothing,
		bodyScrollable: !carriesNothing && rows > windowRows,
	};
}
