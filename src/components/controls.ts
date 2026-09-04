/**
 * The control plane's one keyboard and display catalogue.
 *
 * A control is not only a key. It is an action, its aliases, its scope, its
 * Action bar priority, and the reason it is unavailable in the current
 * state. The shell, the modals, and the overlays use this catalogue for
 * dispatch and display, so the operator never sees a binding the app does
 * not accept.
 *
 * A control's accepted keys are its own per mode: the same Move control is
 * `↑↓/jk` plus the page and jump keys in the Ticket list, `↑↓/jk` plus
 * `Tab` on the override panel's list rows, and plain `↑↓` on its text rows,
 * where `j` and `k` are printable text. The aliases a mode accepts are the
 * only aliases that mode dispatches, and they are what its hints and guide
 * rows may name.
 */
import type { Ticket } from "../domain/ticket.ts";
import { widthOf } from "./text.ts";

export type InteractionMode =
	| "ticket-list"
	| "ticket-detail"
	| "override-list"
	| "override-model"
	| "override-text"
	| "decision-modal"
	| "missing-modal"
	| "key-guide"
	| "message-view";

type ControlScope =
	| "global"
	| "control-plane"
	| "ticket-list"
	| "ticket-detail"
	| "override"
	| "modal"
	| "utility";
type ControlKey =
	| "up"
	| "down"
	| "left"
	| "right"
	| "pageup"
	| "pagedown"
	| "home"
	| "end"
	| "tab"
	| "j"
	| "k"
	| "h"
	| "l"
	| "q"
	| "e"
	| "r"
	| "a"
	| "m"
	| "c"
	| "v"
	| "w"
	| "delete"
	| "f1"
	| "f2"
	| "?"
	| "return"
	| "escape"
	| "backspace"
	| "ctrl+c";

export interface ControlAvailability {
	available: boolean;
	reason?: string;
}

export interface ControlContext {
	mode: InteractionMode;
	/** The Ticket the base panes point at, if the list holds one. */
	selectedTicket?: Ticket;
	listCanMove: boolean;
	detailCanScroll: boolean;
	sourceCount: number;
	refreshingSourceCount: number;
	handoffActive: boolean;
	messageTruncated: boolean;
	/** Whether the config defines any [consultation-types.<name>] block. */
	consultationTypesConfigured: boolean;
	/**
	 * The decision modal's row under the cursor carries settings to edit.
	 *
	 * The modal states it from its own rows; the catalogue stays the single
	 * gate, the bar stays the single display, and neither special-cases the
	 * `e` key by control id.
	 */
	editableActionSelected?: boolean;
}

export interface ControlDefinition {
	id: string;
	label: string;
	/** The keys the control accepts in each interaction mode. */
	keys: (mode: InteractionMode) => readonly ControlKey[];
	/** Displayed in familiar arrow order, then Vim aliases. */
	keyLabel: string;
	scope: ControlScope;
	/** Controls with this flag are candidates for the contextual Action bar. */
	actionBar: boolean;
	/**
	 * Whether one candidate earns a place on the bar in this context.
	 *
	 * A control whose keys work and whose view would show nothing answers for
	 * itself elsewhere, so the Message control states that here rather than
	 * making the bar test control ids.
	 */
	showInBar?: (context: ControlContext) => boolean;
	/**
	 * Whether the control's hint holds the row's right-hand cells.
	 *
	 * This is the one hint a narrow frame may not pack away, because it is the
	 * way out of the surface or the way to find the rest: Help on a bar that
	 * can open the Key guide, and the overlay's own Close on a utility overlay,
	 * which outranks Help there. Where a frame cannot hold the whole hint, the
	 * row states one of the control's whole keys instead, and never a slice.
	 */
	barAnchor?: boolean;
	/** Larger values survive narrow Action bar packing first. */
	priority: number;
	modes: readonly InteractionMode[];
	availability: (context: ControlContext) => ControlAvailability;
	/**
	 * The note the Key guide shows beside a control that is always available.
	 * A consequence of the control, not a claim about the current state, so it
	 * never dims the row: the Emergency exit's recovery warning is the one.
	 */
	guideNote?: string;
}

const available = (): ControlAvailability => ({ available: true });
const unavailable = (reason: string): ControlAvailability => ({ available: false, reason });

/**
 * The two catalogue strings a surface other than the Message line shows.
 *
 * The Key guide names both, so they live here with the controls they belong
 * to: a reason the guide cuts is a reason the operator cannot act on.
 */
const CONSULTATION_TYPES_MISSING =
	"no Consultation types configured; add [consultation-types.<name>] to the config file";
/** Why an emergency exit is not a clean shutdown. */
const EMERGENCY_EXIT_NOTE = "may require Handoff recovery on the next start";
/** What the settled meaning of Enter does, for the guide's current section. */
const DECIDE_NOTE = "opens the decision on a settled Ticket";

/** The Handoff and Override eligibility rules, with one source for each reason. */
const handoffEligibility = (context: ControlContext): ControlAvailability => {
	if (context.handoffActive) return unavailable("a Handoff is active");
	const ticket = context.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (ticket.state !== "open") return unavailable("only an open Ticket can be handed off");
	if (ticket.handoffRecoveryRequired)
		return unavailable("Handoff recovery is required before another handoff");
	if (!ticket.actionable)
		return unavailable("Ticket is not actionable because source data is stale, removed, or absent");
	return available();
};

/** A settled Ticket uses Enter to decide its completed work, not to hand it off. */
const completionEligibility = (context: ControlContext): ControlAvailability => {
	if (context.handoffActive) return unavailable("a Handoff is active");
	return context.selectedTicket?.state === "awaiting"
		? available()
		: unavailable("the selected Ticket has no completion to decide");
};
const listMove = (context: ControlContext): ControlAvailability =>
	context.mode === "override-list" ||
	context.mode === "override-model" ||
	context.mode === "override-text" ||
	context.listCanMove
		? available()
		: unavailable("the Ticket list has nowhere to move");
const detailScroll = (context: ControlContext): ControlAvailability =>
	context.detailCanScroll ? available() : unavailable("the Ticket detail has nowhere to scroll");
const refresh = (context: ControlContext): ControlAvailability => {
	if (context.sourceCount === 0) return unavailable("no Ticket sources exist");
	if (context.refreshingSourceCount >= context.sourceCount)
		return unavailable("every Ticket source is already refreshing");
	return available();
};
const activeQuit = (context: ControlContext): ControlAvailability =>
	context.handoffActive ? unavailable("normal Quit is unavailable during a Handoff") : available();
const message = (context: ControlContext): ControlAvailability =>
	context.messageTruncated
		? available()
		: unavailable("the current Message fits on the Message line");

/** The selected Ticket's leftover environment, and the reason one is missing. */
const leftoverClear = (context: ControlContext): ControlAvailability => {
	const ticket = context.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (ticket.leftover === null)
		return unavailable(`no leftover environment is recorded for ticket ${ticket.identity}`);
	return available();
};

const baseModes = ["ticket-list", "ticket-detail"] as const;
const overrideModes = ["override-list", "override-model", "override-text"] as const;
const modalModes = ["decision-modal", "missing-modal"] as const;
const allModes: readonly InteractionMode[] = [
	...baseModes,
	...overrideModes,
	...modalModes,
	"key-guide",
	"message-view",
];

/**
 * The exhaustive fixed control definitions.
 *
 * The Action bar priorities form one ladder for the whole plane, highest
 * first: Help, the conditional Message control, the overlay's own Cancel,
 * mode navigation, the primary action, the secondary actions the spec names
 * for the base modes (Override, then Refresh), and last the Consultation
 * entries the control plane reached for. Two controls of one mode never
 * share a priority, so the packing order is total.
 */
const CONTROL_DEFINITIONS: readonly ControlDefinition[] = [
	{
		id: "move-list",
		label: "Move",
		keys: (mode) =>
			mode === "ticket-list"
				? ["up", "down", "j", "k", "pageup", "pagedown", "home", "end"]
				: mode === "override-list"
					? ["up", "down", "j", "k", "tab"]
					: ["up", "down", "tab"],
		keyLabel: "↑↓/jk",
		scope: "control-plane",
		actionBar: true,
		priority: 80,
		modes: ["ticket-list", "override-list", "override-model", "override-text"],
		availability: listMove,
	},
	{
		id: "detail",
		label: "Detail",
		keys: () => ["right", "l"],
		keyLabel: "→/l",
		scope: "ticket-list",
		actionBar: true,
		priority: 75,
		modes: ["ticket-list"],
		availability: available,
	},
	{
		id: "scroll-detail",
		label: "Scroll",
		keys: () => ["up", "down", "j", "k", "pageup", "pagedown", "home", "end"],
		keyLabel: "↑↓/jk",
		scope: "ticket-detail",
		actionBar: true,
		priority: 80,
		modes: ["ticket-detail"],
		availability: detailScroll,
	},
	{
		id: "tickets",
		label: "Tickets",
		keys: () => ["left", "h"],
		keyLabel: "←/h",
		scope: "ticket-detail",
		actionBar: true,
		priority: 75,
		modes: ["ticket-detail"],
		availability: available,
	},
	{
		id: "change-override",
		label: "Change",
		// The Model row types its letters, so h and l belong to its text and
		// only the arrows cycle its value.
		keys: (mode) => (mode === "override-model" ? ["left", "right"] : ["left", "right", "h", "l"]),
		keyLabel: "←→/hl",
		scope: "override",
		actionBar: true,
		priority: 80,
		modes: ["override-list", "override-model"],
		availability: available,
	},
	{
		id: "edit-override",
		label: "Edit",
		// Display-only: a free-text row is a standard input that owns its
		// typing, and the Model list row types into its type-ahead. Neither
		// key reaches the panel, so the hint claims none.
		keys: () => [],
		keyLabel: "Type",
		scope: "override",
		actionBar: true,
		priority: 80,
		modes: ["override-model", "override-text"],
		availability: available,
	},
	{
		id: "delete-override",
		label: "Delete",
		// Display-only: the standard input owns Backspace and its caret-aware
		// deletion, so the panel must not intercept it.
		keys: () => [],
		keyLabel: "Backspace",
		scope: "override",
		actionBar: true,
		priority: 75,
		modes: ["override-text"],
		availability: available,
	},
	{
		id: "clear-override",
		label: "Clear",
		// Backspace on a list row gives the setting back to the agent. The
		// free-text rows are standard inputs that own their own Backspace, so
		// they keep the display-only Delete hint and never reach this control.
		keys: () => ["backspace", "delete"],
		keyLabel: "⌫",
		scope: "override",
		actionBar: true,
		priority: 75,
		modes: ["override-list", "override-model"],
		availability: available,
	},
	{
		id: "handoff",
		label: "Hand off",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 70,
		modes: [...baseModes, ...overrideModes],
		availability: handoffEligibility,
	},
	{
		id: "decide-completion",
		label: "Decide",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 70,
		modes: [...baseModes],
		availability: completionEligibility,
		// Enter means two things in the base modes, and the Key guide names
		// both whatever the selected Ticket runs, so the guide has to say what
		// this meaning of Enter is for.
		guideNote: DECIDE_NOTE,
	},
	{
		id: "consultations",
		label: "Consultations",
		keys: () => ["v"],
		keyLabel: "v",
		scope: "control-plane",
		actionBar: true,
		priority: 45,
		modes: [...baseModes],
		availability: available,
	},
	{
		id: "launch",
		label: "Launch consultation",
		keys: () => ["c"],
		keyLabel: "c",
		scope: "control-plane",
		actionBar: true,
		priority: 40,
		modes: [...baseModes],
		availability: (context) =>
			context.consultationTypesConfigured ? available() : unavailable(CONSULTATION_TYPES_MISSING),
	},
	{
		id: "override",
		label: "Override",
		keys: () => ["e"],
		keyLabel: "e",
		scope: "control-plane",
		actionBar: true,
		priority: 65,
		modes: [...baseModes],
		availability: handoffEligibility,
	},
	{
		id: "refresh",
		label: "Refresh",
		keys: () => ["r"],
		keyLabel: "r",
		scope: "control-plane",
		actionBar: true,
		priority: 60,
		modes: [...baseModes],
		availability: refresh,
	},
	{
		id: "leftover",
		label: "clear leftover",
		keys: () => ["w"],
		keyLabel: "w",
		scope: "control-plane",
		actionBar: true,
		priority: 35,
		modes: [...baseModes],
		availability: leftoverClear,
	},
	{
		id: "cancel",
		label: "Cancel",
		keys: () => ["escape"],
		keyLabel: "Esc",
		scope: "override",
		actionBar: true,
		priority: 90,
		modes: [...overrideModes],
		availability: available,
	},
	{
		id: "help",
		label: "Help",
		// `?` opens Help wherever the mode does not own printable text. In the
		// override text row and on the Model list row, which types its letters,
		// it stays text, and only F1 reaches Help.
		keys: (mode) => (mode === "override-text" || mode === "override-model" ? ["f1"] : ["f1", "?"]),
		keyLabel: "F1/?",
		scope: "global",
		actionBar: true,
		barAnchor: true,
		priority: 1000,
		modes: [...allModes],
		availability: available,
	},
	{
		id: "message",
		label: "Message",
		// `m` opens the Message view only from the base panes. F2 is the
		// alias in every interaction mode, so text input keeps its `m`.
		keys: (mode) => (mode === "ticket-list" || mode === "ticket-detail" ? ["m", "f2"] : ["f2"]),
		keyLabel: "m/F2",
		scope: "global",
		actionBar: true,
		priority: 900,
		modes: [...allModes],
		availability: message,
		// The bar never offers a Message view with nothing to read: the hint
		// belongs to a Message the terminal has cut short.
		showInBar: (context) => context.messageTruncated,
	},
	{
		id: "auto-handoff",
		label: "Toggle auto-handoff",
		keys: () => ["a"],
		keyLabel: "a",
		scope: "control-plane",
		actionBar: false,
		priority: 10,
		modes: [...baseModes],
		availability: available,
	},
	{
		id: "quit",
		label: "Quit",
		keys: () => ["q"],
		keyLabel: "q",
		scope: "global",
		actionBar: false,
		priority: 5,
		modes: [...baseModes],
		availability: activeQuit,
	},
	{
		id: "emergency-exit",
		label: "Emergency exit",
		keys: () => ["ctrl+c"],
		keyLabel: "Ctrl+C",
		scope: "global",
		actionBar: false,
		priority: 1,
		modes: [...allModes],
		availability: available,
		guideNote: EMERGENCY_EXIT_NOTE,
	},
	{
		id: "select-action",
		label: "Select action",
		keys: () => ["up", "down"],
		keyLabel: "↑↓",
		scope: "modal",
		actionBar: true,
		priority: 80,
		modes: [...modalModes],
		availability: available,
	},
	{
		id: "scroll-turn-log",
		label: "Scroll log",
		// The page and jump keys are aliases of the same scroll: they are
		// accepted, and the j/k hint is the one the bar and guide show.
		keys: () => ["j", "k", "pageup", "pagedown", "home", "end"],
		keyLabel: "j/k",
		scope: "modal",
		actionBar: true,
		priority: 75,
		modes: ["decision-modal"],
		availability: available,
	},
	{
		id: "scroll-message",
		label: "Scroll message",
		keys: () => ["j", "k"],
		keyLabel: "j/k",
		scope: "modal",
		actionBar: true,
		priority: 75,
		modes: ["missing-modal"],
		availability: available,
	},
	{
		id: "edit-action",
		label: "Edit handoff",
		keys: () => ["e"],
		keyLabel: "e",
		scope: "modal",
		actionBar: true,
		priority: 72,
		modes: ["decision-modal"],
		// Only a Handoff row carries settings to edit: Close and Goto decide
		// about the turn that ended, not about a new Agent.
		availability: (context) =>
			context.editableActionSelected === true
				? available()
				: unavailable("the selected action has no settings to edit"),
	},
	{
		id: "confirm-action",
		label: "Confirm action",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "modal",
		actionBar: true,
		priority: 70,
		modes: [...modalModes],
		availability: available,
	},
	{
		id: "cancel-action",
		label: "Cancel",
		keys: () => ["escape"],
		keyLabel: "Esc",
		scope: "modal",
		actionBar: true,
		priority: 90,
		modes: [...modalModes],
		availability: available,
	},
	{
		id: "guide-scroll",
		label: "Scroll",
		keys: () => ["up", "down", "j", "k"],
		keyLabel: "↑↓/jk",
		scope: "utility",
		actionBar: true,
		priority: 70,
		modes: ["key-guide"],
		availability: available,
	},
	{
		id: "guide-close",
		label: "Close",
		keys: () => ["escape", "f1", "?"],
		keyLabel: "Esc/F1/?",
		scope: "utility",
		actionBar: true,
		barAnchor: true,
		priority: 1100,
		modes: ["key-guide"],
		availability: available,
	},
	{
		id: "message-scroll",
		label: "Scroll",
		keys: () => ["up", "down", "j", "k"],
		keyLabel: "↑↓/jk",
		scope: "utility",
		actionBar: true,
		priority: 70,
		modes: ["message-view"],
		availability: available,
	},
	{
		id: "message-close",
		label: "Close",
		keys: () => ["escape", "f2"],
		keyLabel: "Esc/F2",
		scope: "utility",
		actionBar: true,
		barAnchor: true,
		priority: 1100,
		modes: ["message-view"],
		availability: available,
	},
];

function controlsForMode(mode: InteractionMode): ControlDefinition[] {
	return CONTROL_DEFINITIONS.filter((control) => control.modes.includes(mode));
}

export function controlById(id: string): ControlDefinition {
	const control = CONTROL_DEFINITIONS.find((candidate) => candidate.id === id);
	if (control === undefined) throw new Error(`unknown control: ${id}`);
	return control;
}

export function actionBarControls(
	mode: InteractionMode,
	context: ControlContext,
): ControlDefinition[] {
	return controlsForMode(mode).filter(
		(control) =>
			control.actionBar &&
			isReachableInMode(mode, control, context) &&
			(control.showInBar?.(context) ?? true),
	);
}

/**
 * Whether any alias of the control still resolves to it in this mode.
 *
 * Derived from the same dispatch the shell uses, so the bar never shows a
 * hint whose keys do something else: in the Key guide, F1 and ? close the
 * guide, and in the Message view F2 closes the view.
 */
function isReachableInMode(
	mode: InteractionMode,
	control: ControlDefinition,
	context: ControlContext,
): boolean {
	const keys = control.keys(mode);
	if (keys.length === 0) return true;
	return keys.some((key) => {
		const event = key === "ctrl+c" ? { name: "c", ctrl: true } : { name: key };
		return controlForKey(mode, event, context)?.id === control.id;
	});
}

/**
 * The control one key resolves to, before the current facts choose between
 * the controls that accept it.
 *
 * `return` is accepted by two base-mode controls whose availability answers
 * for different Ticket states, while a utility overlay's Close takes its keys
 * from every other control whatever the state. This is that precedence list:
 * the guide uses it to name every meaning a mode dispatches, and the bar uses
 * it with the facts to hide a meaning the state does not run.
 */
function candidatesForKey(mode: InteractionMode, key: ControlKey): readonly ControlDefinition[] {
	// Utility close controls take precedence over global aliases that share
	// their keys. The catalogue still owns both meanings.
	if (mode === "key-guide" && (key === "escape" || key === "f1" || key === "?"))
		return [controlById("guide-close")];
	if (mode === "message-view" && (key === "escape" || key === "f2"))
		return [controlById("message-close")];
	return controlsForMode(mode).filter((control) => control.keys(mode).includes(key));
}

/** The whole key one accepted binding is called by, as a hint states it. */
const KEY_NAMES: Record<ControlKey, string> = {
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	pageup: "PgUp",
	pagedown: "PgDn",
	home: "Home",
	end: "End",
	tab: "Tab",
	j: "j",
	k: "k",
	h: "h",
	l: "l",
	q: "q",
	e: "e",
	r: "r",
	a: "a",
	m: "m",
	c: "c",
	v: "v",
	f1: "F1",
	f2: "F2",
	"?": "?",
	return: "Enter",
	escape: "Esc",
	backspace: "Backspace",
	delete: "Delete",
	w: "w",
	"ctrl+c": "Ctrl+C",
};

/**
 * The whole keys that still run this control in this mode, best first.
 *
 * A frame too narrow for a hint's full text states one key instead, and a key
 * named here is always whole: `Esc/F1/?` degrades to `Esc`, never to `Esc/F`.
 * Escape leads, because it is the key an operator reaches for when a screen
 * will not answer them, and the shortest alias follows so a row of one column
 * can still name something.
 */
export function compactKeyLabels(mode: InteractionMode, control: ControlDefinition): string[] {
	const ranked = control
		.keys(mode)
		.map((key) => KEY_NAMES[key])
		.map((label) => ({ label, rank: label === KEY_NAMES.escape ? 0 : 1, cells: widthOf(label) }));
	ranked.sort((a, b) => a.rank - b.rank || a.cells - b.cells);
	return [...new Set(ranked.map((entry) => entry.label))];
}

/** Find a control accepted by this mode for one OpenTUI key event. */
export function controlForKey(
	mode: InteractionMode,
	key: { name: string; ctrl?: boolean; meta?: boolean },
	context: ControlContext,
): ControlDefinition | undefined {
	const name = key.ctrl && key.name === "c" ? "ctrl+c" : key.name;
	const candidates = candidatesForKey(mode, name as ControlKey);
	// Enter has a state-specific completion action as well as Hand off. An
	// available meaning wins. If none is available, the first definition owns
	// the key and supplies its stable unavailable reason.
	return candidates.find((control) => availabilityFor(control, context).available) ?? candidates[0];
}

export function availabilityFor(
	control: ControlDefinition,
	context: ControlContext,
): ControlAvailability {
	return control.availability(context);
}

/**
 * Whether the Key guide lists this control among the mode's own.
 *
 * The guide is the app's only complete catalog, so it names every meaning of
 * a key the mode dispatches: Enter is Hand off on an open Ticket and Decide on
 * a settled one, and an operator on either one has to learn that the other
 * exists (user stories 12 and 16). A control whose keys the mode hands to
 * another control outright, as both utility overlays take F1 and ?, is not a
 * control of this mode, so neither the bar nor the guide may name it.
 */
function isCataloguedInMode(mode: InteractionMode, control: ControlDefinition): boolean {
	// A control of another mode is cataloged on its own terms: the guide
	// states what it does and claims nothing about this mode's keys.
	if (!control.modes.includes(mode)) return true;
	const keys = control.keys(mode);
	// A display-only hint (the text row's Type and Backspace) claims no key.
	if (keys.length === 0) return true;
	return keys.some((key) =>
		candidatesForKey(mode, key).some((candidate) => candidate.id === control.id),
	);
}

/** Current-mode controls, then global and control-plane controls, then other modes. */
export function guideControls(
	mode: InteractionMode,
): Array<{ group: string; control: ControlDefinition }> {
	// The current section is every control this mode dispatches a key for. The
	// bar shows only the meaning the current state runs; the guide shows both.
	const current = controlsForMode(mode).filter(
		(control) =>
			control.actionBar && control.id !== "emergency-exit" && isCataloguedInMode(mode, control),
	);
	const seen = new Set(current.map((control) => control.id));
	const append = (group: string, predicate: (control: ControlDefinition) => boolean) =>
		CONTROL_DEFINITIONS.filter(
			(control) => !seen.has(control.id) && predicate(control) && isCataloguedInMode(mode, control),
		).map((control) => {
			seen.add(control.id);
			return { group, control };
		});
	return [
		...current.map((control) => ({ group: "Current interaction mode", control })),
		...append("Global controls", (control) => control.scope === "global"),
		...append("Control plane controls", (control) => control.scope === "control-plane"),
		...append("Other interaction modes", () => true),
	];
}

export function modeTitle(mode: InteractionMode): string {
	switch (mode) {
		case "ticket-list":
			return "Ticket list";
		case "ticket-detail":
			return "Ticket detail";
		case "override-list":
			return "Override list row";
		case "override-model":
			return "Override model row";
		case "override-text":
			return "Override text row";
		case "decision-modal":
			return "Decision modal";
		case "missing-modal":
			return "Missing modal";
		case "key-guide":
			return "Key guide";
		case "message-view":
			return "Message view";
	}
}

function displayKeyLabel(
	mode: InteractionMode,
	control: ControlDefinition,
	includeAllAliases: boolean,
): string {
	if (control.id === "move-list" && (mode === "override-text" || mode === "override-model"))
		return "↑↓";
	if (control.id === "change-override" && mode === "override-model") return "←→";
	if (control.id === "help") {
		// The Model row types its letters, and `?` is one of them: only F1
		// opens the guide there.
		if (mode === "override-text" || mode === "override-model") return "F1";
		if (mode === "override-list") return includeAllAliases ? "F1/?" : "F1";
		if (mode === "ticket-list" || mode === "ticket-detail") return includeAllAliases ? "F1/?" : "?";
	}
	if (control.id === "message") {
		if (mode === "ticket-list" || mode === "ticket-detail") return includeAllAliases ? "m/F2" : "m";
		return "F2";
	}
	return control.keyLabel;
}

export function keyLabelFor(mode: InteractionMode, control: ControlDefinition): string {
	return displayKeyLabel(mode, control, false);
}

/** The Key guide shows all aliases which are valid in its source mode. */
export function guideKeyLabel(mode: InteractionMode, control: ControlDefinition): string {
	return displayKeyLabel(mode, control, true);
}

export function contextFor(
	mode: InteractionMode,
	values: Omit<ControlContext, "mode">,
): ControlContext {
	return { ...values, mode };
}
