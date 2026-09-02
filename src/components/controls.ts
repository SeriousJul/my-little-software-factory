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

export type InteractionMode =
	| "ticket-list"
	| "ticket-detail"
	| "override-list"
	| "override-text"
	| "decision-modal"
	| "missing-modal"
	| "key-guide"
	| "message-view";

export type ControlScope =
	| "global"
	| "control-plane"
	| "ticket-list"
	| "ticket-detail"
	| "override"
	| "modal"
	| "utility";
export type ControlKey =
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
	tickets: readonly Ticket[];
	selectedTicket?: Ticket;
	selectedIndex: number;
	listCanMove: boolean;
	detailCanScroll: boolean;
	sourceCount: number;
	refreshingSourceCount: number;
	handoffActive: boolean;
	messageTruncated: boolean;
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
	/** Larger values survive narrow Action bar packing first. */
	priority: number;
	modes: readonly InteractionMode[];
	availability: (context: ControlContext) => ControlAvailability;
}

const available = (): ControlAvailability => ({ available: true });
const unavailable = (reason: string): ControlAvailability => ({ available: false, reason });

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
	context.mode === "override-list" || context.mode === "override-text" || context.listCanMove
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

const baseModes = ["ticket-list", "ticket-detail"] as const;
const overrideModes = ["override-list", "override-text"] as const;
const modalModes = ["decision-modal", "missing-modal"] as const;
const allModes: readonly InteractionMode[] = [
	...baseModes,
	...overrideModes,
	...modalModes,
	"key-guide",
	"message-view",
];

/** The exhaustive fixed control definitions. */
export const CONTROL_DEFINITIONS: readonly ControlDefinition[] = [
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
		modes: ["ticket-list", "override-list", "override-text"],
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
		keys: () => ["left", "right", "h", "l"],
		keyLabel: "←→/hl",
		scope: "override",
		actionBar: true,
		priority: 80,
		modes: ["override-list"],
		availability: available,
	},
	{
		id: "edit-override",
		label: "Edit",
		// Display-only: the selected free-text row is a standard input that
		// owns its typing.
		keys: () => [],
		keyLabel: "Type",
		scope: "override",
		actionBar: true,
		priority: 80,
		modes: ["override-text"],
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
	},
	{
		id: "override",
		label: "Override",
		keys: () => ["e"],
		keyLabel: "e",
		scope: "control-plane",
		actionBar: true,
		priority: 55,
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
		priority: 40,
		modes: [...baseModes],
		availability: refresh,
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
		// `?` opens Help wherever the mode does not own printable text. In
		// the override text row it stays text, and only F1 reaches Help.
		keys: (mode) => (mode === "override-text" ? ["f1"] : ["f1", "?"]),
		keyLabel: "F1/?",
		scope: "global",
		actionBar: true,
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
		priority: 1000,
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
		priority: 1000,
		modes: ["message-view"],
		availability: available,
	},
];

export function controlsForMode(mode: InteractionMode): ControlDefinition[] {
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
			control.id !== "emergency-exit" &&
			isReachableInMode(mode, control, context) &&
			(control.id !== "message" ? true : control.availability(context).available),
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

/** Find a control accepted by this mode for one OpenTUI key event. */
export function controlForKey(
	mode: InteractionMode,
	key: { name: string; ctrl?: boolean; meta?: boolean },
	context: ControlContext,
): ControlDefinition | undefined {
	const name = key.ctrl && key.name === "c" ? "ctrl+c" : key.name;
	// Utility close controls take precedence over global aliases that share
	// their keys. The catalogue still owns both meanings.
	if (mode === "key-guide" && (name === "escape" || name === "f1" || name === "?"))
		return controlById("guide-close");
	if (mode === "message-view" && (name === "escape" || name === "f2"))
		return controlById("message-close");
	const matches = controlsForMode(mode).filter((control) =>
		control.keys(mode).includes(name as ControlKey),
	);
	// Enter has a state-specific completion action as well as Hand off. An
	// available meaning wins. If none is available, the first definition owns
	// the key and supplies its stable unavailable reason.
	return matches.find((control) => availabilityFor(control, context).available) ?? matches[0];
}

export function availabilityFor(
	control: ControlDefinition,
	context: ControlContext,
): ControlAvailability {
	return control.availability(context);
}

/** Current-mode controls, then global and control-plane controls, then other modes. */
export function guideControls(
	mode: InteractionMode,
	context: ControlContext,
): Array<{ group: string; control: ControlDefinition }> {
	// The current section shows the controls this mode actually dispatches.
	// A shadowed alias (F1 and ? in the guide close it) belongs to the
	// control that owns the key in this mode, not the one it hides.
	const current = controlsForMode(mode).filter(
		(control) =>
			control.actionBar &&
			control.id !== "emergency-exit" &&
			isReachableInMode(mode, control, context),
	);
	const seen = new Set(current.map((control) => control.id));
	const append = (group: string, predicate: (control: ControlDefinition) => boolean) =>
		CONTROL_DEFINITIONS.filter(
			(control) =>
				!seen.has(control.id) &&
				predicate(control) &&
				// A state-specific control belongs in the current section when it
				// dispatches. Do not repeat an inactive alternate in a later group.
				(!control.modes.includes(mode) || isReachableInMode(mode, control, context)),
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
	if (control.id === "move-list" && mode === "override-text") return "↑↓";
	if (control.id === "help") {
		if (mode === "override-text") return "F1";
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
