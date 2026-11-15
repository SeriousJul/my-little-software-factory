/**
 * The plane's screen stack (ADR 0150).
 *
 * The plane holds exactly one active screen at a time. The Main view is the
 * bottom of the stack, and the screens that open above it - the launcher, the
 * guide, the message view, the panels, the override, the Live view - sit on
 * top in the order they opened. Opening a screen suspends the screen beneath
 * it: the suspended screen unmounts, so its timers stop, its spinner faces
 * stop, it sends no read through the runner, and it holds no key
 * subscription. It keeps its place and its facts in the stack. Closing the
 * active screen resumes the screen beneath it: the screen remounts, reads the
 * factory's facts fresh from the store, takes its preserved facts back, and
 * stands on the same frame it was suspended on, with no re-pop-in, until its
 * next tick moves it.
 *
 * This module owns three things and nothing else: the stack's record (the
 * ordered suspended screens, the Main view at the bottom, the active screen
 * at the top), the transitions (open, close, replace), and the contract that
 * a suspended screen runs nothing. It changes which screens stand and when;
 * it never changes how a screen presents, how its controls dispatch, or what
 * its controls mean. The stack composes the screens; it re-implements none of
 * their controls, so the shared control library's rule stands (ADR 0014).
 *
 * One rule carries the whole contract: a suspended screen unmounts. The
 * standard unmount cleanup stops every presentational subscription a screen
 * owns - its reads, its spinner faces, its key wrapper - the way the plane
 * already stops the subscriptions of a closed screen. The decision of which
 * screen is active is made in one place, here; no screen's hook asks an
 * "active screen" fact whether to tick, so the stack's one decision is not
 * scattered across the screens.
 */

import type { KeyEvent } from "@opentui/core";
import { createElement, useRenderer } from "@opentui/react";
import {
	createContext,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Panel, PendingOverride, Utility } from "./app.ts";
import { type ControlDispatchSpec, createControlDispatch } from "./control-dispatch.ts";
/**
 * The screens of the stack.
 *
 * The Main view is the bottom. The screens that open above it are the
 * Consultation launcher (the Replacement Consultation is the same screen in a
 * second context), the Key guide, the Message view, the Decision modal, the
 * Missing modal, the ticket close, the Consultation close, safety, recovery,
 * force, and delete panels, the repository select, the repository init, the
 * override panel, and the Live view. The response editor and the Agent
 * terminal are not screens: they are modes of the Main view's detail pane,
 * they suspend with the Main view, and their facts are preserved facts of the
 * Main view. The Live view's sub-modes - its stream, its decision, its
 * missing face - are not screens: they switch in place on the Live view's one
 * surface (ADR 0040), and the stack never sees a sub-mode.
 */
export type ScreenId =
	| "main"
	| "launcher"
	| "guide"
	| "message"
	| "decision"
	| "missing"
	| "ticket-close"
	| "consultation-close"
	| "consultation-safety"
	| "consultation-recovery"
	| "consultation-force"
	| "consultation-delete"
	| "repository-select"
	| "repository-init"
	| "override"
	| "live";

/** The ordered set of the screens, from the Main view up. */
export const SCREEN_IDS: readonly ScreenId[] = [
	"main",
	"launcher",
	"guide",
	"message",
	"decision",
	"missing",
	"ticket-close",
	"consultation-close",
	"consultation-safety",
	"consultation-recovery",
	"consultation-force",
	"consultation-delete",
	"repository-select",
	"repository-init",
	"override",
	"live",
];

/**
 * The screen's key dispatch slot.
 *
 * The key bus holds one stable wrapper per screen slot, not per mounting of a
 * screen. The wrapper is created once, when the slot stands, and it keeps its
 * identity through every suspend and resume of the screen, so a walk's
 * snapshot of the key bus keeps its meaning across a suspend and resume of the
 * screen it snapshotted. `latest` holds the dispatch the screen's most recent
 * render built; the wrapper calls it. `live` is the liveness flag the
 * dispatch reads: the stack drops it the moment the screen is no longer the
 * active one, in the commit that draws the resumed frame, so a key that
 * reaches the undrawn screen's wrapper in the window before its key release
 * claims nothing and runs no behavior.
 */
export interface ScreenSlot {
	readonly id: ScreenId;
	/** True while the screen is the active screen. */
	live: { current: boolean };
	/** The dispatch the screen's latest render built. */
	latest: { current: (key: KeyEvent) => boolean };
	/** The stable wrapper the bus holds: one per slot, for the slot's life. */
	busKey: (key: KeyEvent) => boolean;
	/**
	 * The screen's preserved facts: the record the stack stores on suspend and
	 * hands back on resume. The screen reads and writes it through this
	 * object, so no screen holds a second private copy of a fact the stack
	 * preserves. The record stands in the shell, which is never suspended.
	 */
	facts: Record<string, unknown>;
}

/**
 * The stack's record for one render.
 *
 * `active` is the screen at the top. `suspended` is the ordered screens
 * beneath it, from the Main view (bottom) up to the screen just under the
 * active one. `activeIsResume` states whether the active screen was suspended
 * in the previous render - a return that stands at full size, with no
 * re-pop-in - as opposed to a fresh opening that pops in once.
 */
export interface StackRecord {
	readonly active: ScreenId;
	readonly suspended: readonly ScreenId[];
	readonly activeIsResume: boolean;
	readonly slots: ReadonlyMap<ScreenId, ScreenSlot>;
}

/** The stack, handed to the screens through the context the shell provides. */
export interface ScreenStack extends StackRecord {
	/**
	 * The screen's preserved facts for `id`: the record a screen reads on
	 * resume and writes on suspend. Stable for the screen's whole life in the
	 * run, across suspend and resume.
	 */
	factsFor: (id: ScreenId) => Record<string, unknown>;
	/**
	 * The key dispatch slot for `id`, or undefined for the Main view, whose
	 * keys the shell's own base subscription owns.
	 */
	slotFor: (id: ScreenId) => ScreenSlot | undefined;
}

const ScreenStackContext = createContext<ScreenStack | null>(null);

/**
 * The provider the shell stands over the one active screen. The screens read
 * their slot, their preserved facts, and their resume flag from it.
 */
export function ScreenStackProvider(props: { value: ScreenStack; children?: ReactNode }) {
	return createElement(ScreenStackContext.Provider, { value: props.value }, props.children);
}

/** The screens' read of the stack the shell stands. */
export function useStackContext(): ScreenStack {
	const stack = useContext(ScreenStackContext);
	if (stack === null) {
		throw new Error(
			"the screens read the stack the shell stands; a screen rendered outside it holds none",
		);
	}
	return stack;
}

/**
 * The four screen states the shell owns. The stack's record derives from
 * them; the stack never holds a second copy of them.
 */
export interface StackStates {
	launcher: boolean;
	panel: Panel;
	override: PendingOverride | null;
	utility: Utility;
}

/** The screen a Consultation panel stands for, or null when no panel stands. */
export function panelScreen(panel: Panel | null): ScreenId | null {
	if (panel === null) return null;
	switch (panel.kind) {
		case "decision":
			return "decision";
		case "missing":
			return "missing";
		case "live":
			return "live";
		case "ticket-close":
			return "ticket-close";
		case "consultation-close":
			return "consultation-close";
		case "consultation-safety":
			return "consultation-safety";
		case "consultation-recovery":
			return "consultation-recovery";
		case "consultation-force":
			return "consultation-force";
		case "consultation-delete":
			return "consultation-delete";
		case "repository-select":
			return "repository-select";
		case "repository-init":
			return "repository-init";
	}
	// The switch covers every panel kind. This check keeps a future kind from
	// escaping the stack unmanaged: rendered, but its timers and keys
	// unmanaged.
	const unmanaged: never = panel;
	throw new Error(`the stack manages no screen for the panel ${unmanaged}`);
}

/**
 * The ordered stack, from the Main view (bottom) to the active screen (top),
 * derived from the shell's four screen states. The plane runs one of the
 * launcher or a panel over the Main view, the override over a screen it can
 * return to, and a utility over any screen, so the record is a subsequence of
 * the Main view, one of the launcher or a panel, the override, and the
 * utility.
 */
export function deriveStack(states: StackStates): { active: ScreenId; suspended: ScreenId[] } {
	const list: ScreenId[] = ["main"];
	if (states.launcher) {
		list.push("launcher");
	} else {
		const panelActive = panelScreen(states.panel);
		if (panelActive !== null) list.push(panelActive);
	}
	if (states.override !== null) list.push("override");
	if (states.utility !== null) {
		list.push(states.utility.kind === "guide" ? "guide" : "message");
	}
	const active = list[list.length - 1];
	const suspended = list.slice(0, -1);
	return { active, suspended };
}

/**
 * The stack, owned by the plane's shell.
 *
 * It stands the one record the shell's four screen states derive, it owns the
 * key dispatch slots - one stable wrapper per screen slot, created once and
 * held for the run's life - and it makes the key bus hold the active screen's
 * wrapper and only that, in the commit that draws the frame. The shell's own
 * base subscription, which owns the emergency exit in every mode and the
 * base screen's legacy keys, stands on the bus through every transition and
 * keeps its identity; this hook never touches it.
 */
export function useScreenStack(states: StackStates): ScreenStack {
	const renderer = useRenderer();

	// The slots stand once, for the run's life. The Main view has no slot: its
	// keys are the shell's own base subscription.
	const slotsRef = useRef<Map<ScreenId, ScreenSlot> | null>(null);
	if (slotsRef.current === null) {
		const map = new Map<ScreenId, ScreenSlot>();
		for (const id of SCREEN_IDS) {
			if (id === "main") continue;
			const live = { current: false };
			const latest = { current: (_key: KeyEvent) => false };
			const busKey = (key: KeyEvent) => latest.current(key);
			map.set(id, { id, live, latest, busKey, facts: {} });
		}
		slotsRef.current = map;
	}
	const slots = slotsRef.current;

	const derived = deriveStack(states);
	const active = derived.active;
	const suspended = derived.suspended;

	// A screen is a return - it stands at full size, with no re-pop-in - when
	// it was suspended in the previous render. The previous suspended set
	// stands in a ref the layout effect updates after the commit.
	const prevSuspendedRef = useRef<Set<ScreenId>>(new Set());
	const activeIsResume = prevSuspendedRef.current.has(active);

	useLayoutEffect(() => {
		prevSuspendedRef.current = new Set(suspended);
	}, [suspended]);

	// The bus adds a listener on every `on` and does not deduplicate, so the
	// attach and detach stand on the state the previous pass left behind: a
	// re-render without a transition adds nothing and removes nothing.
	const attachedRef = useRef<Set<ScreenId>>(new Set());

	// The one place the key bus learns which screen's wrapper stands: the
	// active screen's slot goes live and onto the bus, and every other slot
	// goes quiet and off it. A suspended screen holds no subscription at all,
	// not an inert one. The layout pass runs after the screens' own layout
	// passes - which register each screen's latest dispatch - and before the
	// frame is drawn, so the frame the operator sees and the wrappers the bus
	// holds commit together.
	useLayoutEffect(() => {
		const bus = renderer.keyInput;
		const inStack = new Set<ScreenId>([active, ...suspended]);
		for (const slot of slots.values()) {
			const isActive = slot.id === active;
			slot.live.current = isActive;
			const wasAttached = attachedRef.current.has(slot.id);
			if (isActive && !wasAttached) {
				bus.on("keypress", slot.busKey);
				attachedRef.current.add(slot.id);
			} else if (!isActive && wasAttached) {
				bus.off("keypress", slot.busKey);
				attachedRef.current.delete(slot.id);
			}
			// A screen that left the stack is closed, not suspended: its
			// preserved facts leave with it, so the next open of the screen
			// stands on the screen's own defaults, not on a run of its past.
			if (!inStack.has(slot.id)) slot.facts = {};
		}
		// Detach every slot when the shell goes away.
		return () => {
			for (const slot of slots.values()) {
				slot.live.current = false;
				bus.off("keypress", slot.busKey);
			}
			attachedRef.current.clear();
		};
	}, [active, suspended, renderer, slots]);

	const value = useMemo<ScreenStack>(
		() => ({
			active,
			suspended,
			activeIsResume,
			slots,
			factsFor: (id) => slots.get(id)?.facts ?? {},
			slotFor: (id) => slots.get(id),
		}),
		[active, suspended, activeIsResume, slots],
	);

	return value;
}

/**
 * A screen's registration of its latest dispatch with the stack's slot.
 *
 * The screen builds its dispatch the way it always has - the same catalogue
 * resolution, the same gate, the same refusal - and hands it to the slot the
 * stack owns. The stack's stable wrapper calls it. The screen holds no
 * subscription of its own: while it is suspended its slot is off the bus and
 * its liveness flag is down, so it claims no key. When it resumes, the same
 * wrapper comes back on the bus with the same identity.
 *
 * A surface rendered outside the stack - the gallery's examples, a unit of a
 * screen in isolation - passes no slot and keeps the shared dispatch's own
 * rule: it subscribes its own wrapper and releases it on unmount, the way a
 * closed screen's subscriptions stop.
 */
export function useSlotDispatch(slot: ScreenSlot | undefined, spec: ControlDispatchSpec): void {
	const selfLive = useRef(true);
	const latest = useRef<(key: KeyEvent) => boolean>(() => false);
	const wrapper = useRef<(key: KeyEvent) => boolean>((key) => latest.current(key));
	useLayoutEffect(() => {
		latest.current =
			slot !== undefined
				? createControlDispatch({ ...spec, isLive: () => slot.live.current })
				: createControlDispatch({ ...spec, isLive: () => selfLive.current });
		if (slot !== undefined) slot.latest.current = latest.current;
	});
	const renderer = useRenderer();
	useLayoutEffect(() => {
		if (slot !== undefined) return;
		selfLive.current = true;
		const bus = renderer.keyInput;
		bus.on("keypress", wrapper.current);
		return () => {
			selfLive.current = false;
			bus.off("keypress", wrapper.current);
		};
	}, [slot, renderer]);
}

/**
 * A screen whose surface cannot stand this render owes its keys to nothing:
 * the slot's wrapper stands on the bus while the screen is the active one, so
 * the screen hands the wrapper a dispatch that claims no key, until the
 * surface stands or the screen closes. The wrapper itself never changes.
 */
export function useSlotQuiet(slot: ScreenSlot | undefined, quiet: boolean): void {
	useLayoutEffect(() => {
		if (slot !== undefined && quiet) slot.latest.current = () => false;
	});
}

/**
 * A screen-local fact the stack preserves: seeded from the slot's record on
 * mount, mirrored into it on every change, and handed back when the screen
 * resumes. The slot's record is the one place the fact stands between the
 * screen's mounts; the screen holds no second private copy of it.
 */
export function useSlotFact<T>(
	slot: ScreenSlot | undefined,
	key: string,
	fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
	const [value, setValue] = useState<T>(() =>
		slot !== undefined && key in slot.facts ? (slot.facts[key] as T) : fallback,
	);
	// The mirror is a layout effect, not a passive one: a suspended screen
	// unmounts in the next commit after its last paint, and a passive effect
	// can still be owed at that commit, so the fact the paint stood on would
	// stand one step behind it in the record the resume seeds from.
	useLayoutEffect(() => {
		if (slot !== undefined) slot.facts[key] = value;
	}, [slot, key, value]);
	return [value, setValue];
}

/**
 * The row under the cursor of the screen's region stands back in the slot's
 * record, so a resume of the screen from the stack's preserved facts stands
 * on the row the operator left. Outside the stack the mirror stands still.
 */
export function useSlotRegionMirror(slot: ScreenSlot | undefined, regionAt: number): void {
	useLayoutEffect(() => {
		if (slot !== undefined) slot.facts.regionAt = regionAt;
	}, [slot, regionAt]);
}

/**
 * The text one screen slot preserved under a key, or the empty word when the
 * slot holds none: a screen that resumes stands on the value its slot kept,
 * whatever the plane resolved meanwhile (ADR 0150).
 */
export function slotText(slot: ScreenSlot | undefined, key: string): string {
	return typeof slot?.facts[key] === "string" ? (slot.facts[key] as string) : "";
}
