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
import { useLayoutEffect, useRef } from "react";

import {
	type AvailabilityFacts,
	availabilityFor,
	type ControlAvailability,
	type ControlDefinition,
	controlForKey,
} from "./controls.ts";

/** What a control's behavior is called with: one object, so a handler names
 *  only the parts it uses. */
export interface ControlCall {
	/** The Availability facts the control was gated on. */
	facts: AvailabilityFacts;
	/** The raw key event: some behaviors need its name, and some must call
	 *  `preventDefault` so the surface's own text field cannot claim it. */
	key: KeyEvent;
	/** The control the catalogue resolved. */
	control: ControlDefinition;
	/** Report this control's catalogue refusal, in the catalogue's words. */
	refuse: () => void;
}

/** The behavior of one control. */
export type ControlHandler = (call: ControlCall) => void;

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
export const refusalReason = (control: ControlDefinition, facts: AvailabilityFacts): string =>
	refusalText(control, availabilityFor(control, facts));

interface ControlDispatchSpec {
	/**
	 * The Availability facts the mode's controls are gated on.
	 *
	 * The record names its own mode, so the dispatch never carries a mode
	 * beside facts that could disagree with it. The override panel passes a
	 * function: its mode follows the row the cursor is on, and one key can
	 * move that cursor, so the facts it states belong to the row the key
	 * lands on.
	 */
	facts: AvailabilityFacts | (() => AvailabilityFacts);
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
	/**
	 * Whether the surface that owns this dispatch is still drawn.
	 *
	 * The close's commit draws the fallback frame, and the passive cleanup
	 * that removes the subscription can stand pending on the scheduler's
	 * clock long past it (issue #317). A key in that window must not run a
	 * behavior the operator no longer sees, so the dispatch reads the flag on
	 * every key: a handler of an undrawn surface runs no behavior, claims
	 * nothing, and reports nothing. `useControlDispatch` supplies it, and a
	 * spec built by hand passes none and stands live.
	 */
	isLive?: () => boolean;
	/** Keys this surface must not touch, checked before the catalogue. */
	skip?: (key: KeyEvent) => boolean;
	/** Handles keys not claimed by the catalogue, such as Agent input. */
	onUnclaimed?: (key: KeyEvent) => boolean | undefined;
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
		// The subscription outlives the frame: the close's commit drew the
		// fallback already, and the cleanup that removes the handler stands
		// pending. The layout effect's cleanup set the flag down in that same
		// commit, before the frame was drawn, so by this key the flag says the
		// surface is gone and the key goes to the surface the operator sees
		// (issue #317).
		if (spec.isLive !== undefined && !spec.isLive()) return false;
		// The super key is the terminal's own, and a skipped key is the
		// surface's own text field.
		if (key.meta || spec.skip?.(key)) return false;
		const facts = typeof spec.facts === "function" ? spec.facts() : spec.facts;
		const control = controlForKey(key, facts);
		if (control === undefined) return spec.onUnclaimed?.(key) === true;
		const availability = availabilityFor(control, facts);
		if (!availability.available && !spec.ungated?.includes(control.id)) {
			spec.onUnavailable?.(refusalReason(control, facts));
			// A refused key must not also reach a focused text field: the
			// catalogue named it, so nothing else may claim it.
			key.preventDefault?.();
			return true;
		}
		if (control.id === "emergency-exit") {
			spec.onEmergencyExit();
			return true;
		}
		const refuse = () => spec.onUnavailable?.(refusalReason(control, facts));
		spec.handlers[control.id]?.({ facts, key, control, refuse });
		return true;
	};
}

/**
 * Subscribe one surface's controls to the keyboard.
 *
 * The subscription lives longer than the surface that drew it: the passive
 * cleanup that removes it flushes after the close's commit, and under load
 * the flush lags the drawn frame by far more than a keypress (issue #317).
 * The flag the dispatch reads drops in a layout effect's cleanup, which
 * React runs in the commit that unmounts the surface, before the frame is
 * drawn: the flag is already down when the frame the operator sees says the
 * surface is gone, and a key in the window reaches the subscription but
 * runs no behavior.
 */
export function useControlDispatch(spec: ControlDispatchSpec): void {
	const live = useRef(true);
	useLayoutEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	});
	useKeyboard(createControlDispatch({ ...spec, isLive: () => live.current }));
}
