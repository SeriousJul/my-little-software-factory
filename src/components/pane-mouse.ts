/**
 * Mouse activation for the two panes of the split, shared by the list
 * and the detail.
 *
 * Both panes activate on the same events: a left button press, and a
 * vertical wheel turn without shift. The pane that receives an
 * activating event takes the app focus, then runs its own action: the
 * list moves its selection, the detail scrolls its content. One shared
 * policy keeps the two panes in step, so neither pane can activate on a
 * gesture the other ignores.
 */
import type { MouseEvent } from "@opentui/core";

/** The vertical wheel direction the panes act on, or null for a turn they ignore. */
export function wheelTurn(event: MouseEvent): "up" | "down" | null {
	if (event.modifiers.shift) return null;
	if (event.scroll?.direction === "up") return "up";
	if (event.scroll?.direction === "down") return "down";
	return null;
}

export interface PaneMouse {
	/** False while a modal owns all input above the panes. */
	readonly active: () => boolean;
	/** The pane takes the app focus. */
	readonly onFocus: () => void;
	/** A vertical wheel turn over an active pane. */
	readonly onWheel: (direction: "up" | "down", event: MouseEvent) => void;
	/**
	 * A wheel turn the pane must not act on: shifted, horizontal, or a
	 * modal above the panes. The detail zeros its native wheel multiplier
	 * here so the turn stays inert.
	 */
	readonly onWheelBlocked?: (event: MouseEvent) => void;
	/** A left button press over an active pane. The detail has none: the press only takes focus. */
	readonly onPress?: (event: MouseEvent) => void;
}

/** The shared mouse handler of one pane of the split. */
export function paneMouse(pane: PaneMouse): (event: MouseEvent) => void {
	return (event: MouseEvent) => {
		if (event.type === "scroll") {
			const direction = wheelTurn(event);
			if (direction === null || !pane.active()) {
				pane.onWheelBlocked?.(event);
				return;
			}
			pane.onFocus();
			pane.onWheel(direction, event);
			return;
		}
		if (event.type !== "down" || event.button !== 0 || !pane.active()) return;
		pane.onFocus();
		pane.onPress?.(event);
	};
}
