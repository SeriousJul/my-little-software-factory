/**
 * The catalogue's one dispatch loop.
 *
 * Every surface that takes a key does the same five steps: resolve the key
 * to a control, gate it on the current facts, run the control's behavior,
 * report a refusal, and leave the emergency exit alone. The shell, the
 * override panel, both modals, and the utility overlays each wrote those
 * steps out by hand, which is five copies of the rule that a refusal is one
 * Warning. One hook owns the rule, so a surface cannot drift from it, and
 * the difference between surfaces is only what they pass in.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import {
	availabilityFor,
	type ControlAvailability,
	type ControlContext,
	type ControlDefinition,
	contextFor,
	controlForKey,
	type InteractionMode,
} from "./controls.ts";

/** What a control's behavior is called with: one object, so a handler names
 *  only the parts it uses. */
interface ControlCall {
	/** The facts the control was gated on. */
	context: ControlContext;
	/** The raw key event: some behaviors need its name, and some must call
	 *  `preventDefault` so the surface's own text field cannot claim it. */
	key: KeyEvent;
	/** The control the catalogue resolved. */
	control: ControlDefinition;
	/** Report this control's catalogue refusal, in the catalogue's words. */
	refuse: () => void;
}

/** The behavior of one control. */
type ControlHandler = (call: ControlCall) => void;

/**
 * What a refusal says.
 *
 * One function owns the sentence, so a surface that gates a control itself
 * and the dispatch loop that gates the rest can never tell the operator two
 * different stories about the same key.
 */
export function refusalText(control: ControlDefinition, availability: ControlAvailability): string {
	return availability.reason ?? `${control.label} is unavailable`;
}

/** The refusal of a control judged against the current facts. */
export const refusalReason = (control: ControlDefinition, context: ControlContext): string =>
	refusalText(control, availabilityFor(control, context));

interface ControlDispatchSpec {
	/**
	 * The mode that owns the key. The override panel passes a function: its
	 * mode follows the row the cursor is on, and one key can move that cursor.
	 */
	mode: InteractionMode | (() => InteractionMode);
	/** The facts availability is judged on, in the dispatch mode. */
	context: ControlContext;
	/** The behavior by control id. A control with no behavior is inert. */
	handlers: Readonly<Record<string, ControlHandler>>;
	/**
	 * Ids dispatched before the gate, because the same key means something
	 * else in the current facts: Enter on an in-flight Ticket goes to that
	 * Ticket rather than refusing as Hand off. Each one reports its own
	 * refusal, so the rule stays in one sentence: an unavailable control
	 * runs no behavior and says why once.
	 */
	ungated?: readonly string[];
	/** Reports the catalogue reason for a refused control. Omitted: inert. */
	onUnavailable?: (reason: string) => void;
	/** The emergency exit. The catalogue owns it in every mode. */
	onEmergencyExit: () => void;
	/** False while a surface above this one owns input. Default: true. */
	active?: boolean;
	/** Keys this surface must not touch, checked before the catalogue. */
	skip?: (key: KeyEvent) => boolean;
}

/**
 * The dispatcher for one render.
 *
 * It closes over the render's facts, so it must be built inside the render.
 * `useControlDispatch` does that and subscribes it; the app shell keeps its
 * own subscription because the Consultation surfaces still dispatch their
 * legacy keys ahead of the catalogue.
 */
export function createControlDispatch(spec: ControlDispatchSpec): (key: KeyEvent) => boolean {
	if (spec.active === false) return () => false;
	return (key) => {
		// The super key is the terminal's own, and a skipped key is the
		// surface's own text field.
		if (key.meta || spec.skip?.(key)) return false;
		const mode = typeof spec.mode === "function" ? spec.mode() : spec.mode;
		const context = contextFor(mode, spec.context);
		const control = controlForKey(mode, key, context);
		if (control === undefined) return false;
		const availability = availabilityFor(control, context);
		if (!availability.available && !spec.ungated?.includes(control.id)) {
			spec.onUnavailable?.(refusalReason(control, context));
			// A refused key must not also reach a focused text field: the
			// catalogue named it, so nothing else may claim it.
			key.preventDefault?.();
			return true;
		}
		if (control.id === "emergency-exit") {
			spec.onEmergencyExit();
			return true;
		}
		const refuse = () => spec.onUnavailable?.(refusalReason(control, context));
		spec.handlers[control.id]?.({ context, key, control, refuse });
		return true;
	};
}

/** Subscribe one surface's controls to the keyboard. */
export function useControlDispatch(spec: ControlDispatchSpec): void {
	useKeyboard(createControlDispatch(spec));
}
