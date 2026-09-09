/**
 * The focus and slot behavior every shared form surface runs.
 *
 * A form owns one keyboard rule per slot: a field takes its own editing keys, a
 * selector cycles its value, and an action confirms. That rule is the same in
 * the Consultation launcher, the response editor, and any form a later screen
 * adds, so those slots share this module instead of each screen writing its own
 * Tab order, its own mode, and its own availability facts.
 *
 * The module owns nothing the screen owns: which values a slot holds, what a
 * domain action does, and where a draft is stored all stay with the caller.
 */
import { useCallback, useRef, useState } from "react";

import type { ControlContext, InteractionMode } from "../controls.ts";

/** The kind of one form slot, and so the keys it owns. */
export type FormSlotKind = "field" | "selector" | "action";

/** One slot of a form: the name the operator reads, and what kind it is. */
export interface FormSlot {
	id: string;
	kind: FormSlotKind;
	/** The slot's name, taken from the project glossary. */
	label: string;
}

/** The facts a form's controls are gated on, beyond the focused slot. */
export interface FormFacts {
	/** Whether the focused field holds a selection the Copy control can hand over. */
	fieldHasSelection?: boolean;
	/** How many values the focused selector offers. One of them cycles nowhere. */
	formCycleCount?: number;
	/** Why the focused action cannot run, in the surface's own words. */
	formRefusal?: string;
	/** Whether the Model search row holds text its clear control can remove. */
	formSearchActive?: boolean;
}

/** The focus of one form, read the way its key handler needs it. */
export interface FormFocus {
	/** The slot that holds the focus. */
	at: number;
	/** The kind of the slot that holds the focus. */
	kind(): FormSlotKind;
	/** The catalogue mode the form runs, which follows the focused slot. */
	mode(): InteractionMode;
	/** The slot the focus is on, or undefined when the form holds none. */
	current(): FormSlot | undefined;
	/** Move the focus, wrapping so every slot stays one step away. */
	move(delta: number): void;
	/** Put the focus on one named slot, as a restored draft asks. */
	select(id: string): void;
	/** The same facts, in the shape the control catalogue gates on. */
	context(base: ControlContext, facts?: FormFacts): ControlContext;
}

/** The mode of one slot kind: the rule that slot owns the keyboard under. */
function slotMode(kind: FormSlotKind): InteractionMode {
	if (kind === "selector") return "form-selector";
	if (kind === "action") return "form-action";
	return "form-field";
}

/**
 * The focus of a form's slots.
 *
 * The index lives in a ref as well as in state: the key parser can deliver
 * several keys in one tick and React batches their updates, so the second key
 * must act on the slot the first one moved to rather than on the slot the last
 * render painted.
 */
export function useFormSlots(slots: readonly FormSlot[]): FormFocus {
	const [at, setAt] = useState(0);
	const ref = useRef(0);
	const count = slots.length;
	const clamp = useCallback(
		(index: number) => Math.max(0, Math.min(index, Math.max(0, count - 1))),
		[count],
	);
	const focused = (): FormSlot | undefined => slots[clamp(ref.current)];
	return {
		at: clamp(at),
		kind: () => focused()?.kind ?? "field",
		mode: () => slotMode(focused()?.kind ?? "field"),
		current: focused,
		move: (delta: number) => {
			if (count === 0) return;
			ref.current = (clamp(ref.current) + delta + count) % count;
			setAt(ref.current);
		},
		select: (id: string) => {
			const index = slots.findIndex((slot) => slot.id === id);
			if (index < 0) return;
			ref.current = index;
			setAt(index);
		},
		context: (base: ControlContext, facts: FormFacts = {}) => ({
			...base,
			mode: slotMode(focused()?.kind ?? "field"),
			formSlot: focused()?.kind ?? "field",
			fieldHasSelection: facts.fieldHasSelection === true,
			formCycleCount: facts.formCycleCount,
			formRefusal: facts.formRefusal,
			formSearchActive: facts.formSearchActive,
		}),
	};
}

/**
 * The `move-field` handler: Tab forward, Shift+Tab back.
 *
 * One handler for every form, so a screen cannot invent a route that leaves a
 * field or an action out. A selector and an action also answer the arrows, and
 * the caller names that difference by passing the key's own name through.
 */
export function moveFieldWith(focus: FormFocus): (name: string, shift: boolean) => void {
	return (name, shift) => {
		const back = shift === true || name === "up" || name === "k";
		focus.move(back ? -1 : 1);
	};
}
