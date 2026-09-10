/** Shared list windowing and pointer behavior for Main section list panes. */
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { windowOf } from "./geometry.ts";
import { paneMouse } from "./pane-mouse.ts";

export interface ListWindow<T> {
	start: number;
	visible: readonly T[];
}

/** Keep the selected row visible, placing it at the bottom when it moves down. */
export function listWindow<T>(
	items: readonly T[],
	selectedIndex: number,
	visibleRows: number,
): ListWindow<T> {
	const start = Math.max(
		0,
		Math.min(selectedIndex - visibleRows + 1, Math.max(0, items.length - visibleRows)),
	);
	return { start, visible: windowOf(items, start, visibleRows) };
}

interface ListMouseOptions {
	active: () => boolean;
	onFocus: () => void;
	onMove: (delta: number) => void;
	onSelect: (index: number) => void;
	rootRef: { readonly current: BoxRenderable | null };
	start: number;
	visibleRows: number;
	itemCount: number;
}

/** Apply the shared list focus, wheel, and row-click policy. */
export function listMouse(options: ListMouseOptions): (event: MouseEvent) => void {
	return paneMouse({
		active: options.active,
		onFocus: options.onFocus,
		onWheel: (direction) => options.onMove(direction === "up" ? -1 : 1),
		onPress: (event) => {
			// One border and one padding row precede the list's first row.
			const box = (event.currentTarget as BoxRenderable | null) ?? options.rootRef.current;
			const row = event.y - (box?.y ?? event.y) - 2;
			const index = options.start + row;
			if (row >= 0 && row < options.visibleRows && index >= 0 && index < options.itemCount)
				options.onSelect(index);
		},
	});
}
