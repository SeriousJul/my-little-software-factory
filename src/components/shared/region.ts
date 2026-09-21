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
	/** Confirm the selected row, then clear the selection. */
	confirm: (run: (row: ActionRow) => void) => void;
	/** The rows the region shows, in order. */
	window: readonly ActionRow[];
	/**
	 * The region's range text: first-last of total, behind the selection's
	 * hint on the Action bar. Absent when the region shows every row.
	 */
	rangeText: string | undefined;
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
 * the cursor when the step would leave it.
 */
export function useDecisionRegion(rows: readonly ActionRow[], visibleRows: number): DecisionRegion {
	const [selected, setSelected] = useState(0);
	const [top, setTop] = useState(0);
	const ref = useRef(0);
	const count = rows.length;
	const last = Math.max(0, count - 1);
	const limit = Math.max(0, Math.floor(visibleRows));
	const at = Math.min(selected, last);
	const maxTop = Math.max(0, count - limit);
	const windowTop = Math.min(top, maxTop);
	const window = limit === 0 ? [] : rows.slice(windowTop, windowTop + limit);
	return {
		at,
		move: (delta: number) => {
			if (count === 0) return;
			ref.current = (Math.min(ref.current, last) + delta + count) % count;
			setSelected(ref.current);
			// The auto-scroll: the window slides to the cursor's row when the
			// step would leave it, and stays put otherwise, so a scroll the
			// region's own rows ask for never crosses the cursor.
			setTop((current) => {
				const t = Math.min(current, maxTop);
				if (ref.current < t) return ref.current;
				if (ref.current >= t + limit) return ref.current - limit + 1;
				return t;
			});
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
