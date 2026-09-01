/**
 * The control plane's one keyboard and display catalogue.
 *
 * A control is not only a key. It is an action, its aliases, its scope, its
 * Action bar priority, and the reason it is unavailable in the current
 * state. The shell and the utility overlays use this catalogue for both
 * dispatch and display so the operator never sees a binding the app does
 * not accept.
 */
import type { Ticket } from "../domain/ticket.ts";

export type InteractionMode =
	| "ticket-list"
	| "ticket-detail"
	| "override-list"
	| "override-text"
	| "key-guide"
	| "message-view";

export type ControlScope =
	| "global"
	| "control-plane"
	| "ticket-list"
	| "ticket-detail"
	| "override"
	| "utility";
export type ControlKey =
	| "up"
	| "down"
	| "left"
	| "right"
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
	/** A text override row owns printable aliases such as `?` and `m`. */
	textEntry: boolean;
}

export interface ControlDefinition {
	id: string;
	label: string;
	/** Displayed in familiar arrow order, then Vim aliases. */
	keys: readonly ControlKey[];
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

const canHandoff = (context: ControlContext): ControlAvailability => {
	if (context.handoffActive) return unavailable("a Handoff is active");
	// Reaching an override panel already proves that its source Ticket passed
	// the base eligibility check. The panel's Enter confirms its edited choice.
	if (context.mode === "override-list" || context.mode === "override-text") return available();
	const ticket = context.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (ticket.state !== "open") return unavailable("only an open Ticket can be handed off");
	if (ticket.handoffRecoveryRequired)
		return unavailable("Handoff recovery is required before another handoff");
	if (!ticket.actionable)
		return unavailable("Ticket is not actionable because source data is stale, removed, or absent");
	return available();
};

const canOverride = (context: ControlContext): ControlAvailability => {
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

/** The exhaustive fixed control definitions. */
export const CONTROL_DEFINITIONS: readonly ControlDefinition[] = [
	{
		id: "move-list",
		label: "Move",
		keys: ["up", "down", "j", "k"],
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
		keys: ["right", "l"],
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
		keys: ["up", "down", "j", "k"],
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
		keys: ["left", "h"],
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
		keys: ["left", "right", "h", "l"],
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
		keys: [],
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
		keys: ["backspace"],
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
		keys: ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 70,
		modes: [...baseModes, ...overrideModes],
		availability: canHandoff,
	},
	{
		id: "override",
		label: "Override",
		keys: ["e"],
		keyLabel: "e",
		scope: "control-plane",
		actionBar: true,
		priority: 55,
		modes: [...baseModes],
		availability: canOverride,
	},
	{
		id: "refresh",
		label: "Refresh",
		keys: ["r"],
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
		keys: ["escape"],
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
		keys: ["?", "f1"],
		keyLabel: "?/F1",
		scope: "global",
		actionBar: true,
		priority: 1000,
		modes: [...baseModes, "override-list", "override-text"],
		availability: available,
	},
	{
		id: "message",
		label: "Message",
		keys: ["m", "f2"],
		keyLabel: "m/F2",
		scope: "global",
		actionBar: true,
		priority: 900,
		modes: [...baseModes, ...overrideModes],
		availability: message,
	},
	{
		id: "auto-handoff",
		label: "Toggle auto-handoff",
		keys: ["a"],
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
		keys: ["q"],
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
		keys: ["ctrl+c"],
		keyLabel: "Ctrl+C",
		scope: "global",
		actionBar: false,
		priority: 1,
		modes: [
			"ticket-list",
			"ticket-detail",
			"override-list",
			"override-text",
			"key-guide",
			"message-view",
		],
		availability: available,
	},
	{
		id: "guide-scroll",
		label: "Scroll",
		keys: ["up", "down", "j", "k"],
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
		keys: ["escape", "f1", "?"],
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
		keys: ["up", "down", "j", "k"],
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
		keys: ["escape", "f2"],
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

export function actionBarControls(
	mode: InteractionMode,
	context: ControlContext,
): ControlDefinition[] {
	return controlsForMode(mode).filter(
		(control) =>
			control.actionBar &&
			control.id !== "emergency-exit" &&
			(control.id !== "message" ? true : control.availability(context).available),
	);
}

/** Find a control accepted by this mode for one OpenTUI key event. */
export function controlForKey(
	mode: InteractionMode,
	key: { name: string; ctrl?: boolean; meta?: boolean },
	_context: ControlContext,
): ControlDefinition | undefined {
	const name = key.ctrl && key.name === "c" ? "ctrl+c" : key.name;
	return controlsForMode(mode).find((control) => control.keys.includes(name as ControlKey));
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
): Array<{ group: string; control: ControlDefinition }> {
	// "Current" means the contextual controls shown by the Action bar. Less
	// common controls such as Quit and auto-handoff remain in their scope
	// sections even though they are accepted in a base mode.
	const current = controlsForMode(mode).filter(
		(control) => control.actionBar && control.id !== "emergency-exit",
	);
	const seen = new Set(current.map((control) => control.id));
	const result = current.map((control) => ({ group: "Current interaction mode", control }));
	for (const control of CONTROL_DEFINITIONS) {
		if (seen.has(control.id)) continue;
		if (control.scope === "global") {
			result.push({ group: "Global controls", control });
			seen.add(control.id);
		}
	}
	for (const control of CONTROL_DEFINITIONS) {
		if (seen.has(control.id)) continue;
		if (control.scope === "control-plane") {
			result.push({ group: "Control plane controls", control });
			seen.add(control.id);
		}
	}
	for (const control of CONTROL_DEFINITIONS) {
		if (seen.has(control.id)) continue;
		result.push({ group: "Other interaction modes", control });
		seen.add(control.id);
	}
	return result;
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
		case "key-guide":
			return "Key guide";
		case "message-view":
			return "Message view";
	}
}

export function keyLabelFor(mode: InteractionMode, control: ControlDefinition): string {
	if (control.id === "move-list" && mode === "override-text") return "↑↓";
	if (control.id === "help" && (mode === "ticket-list" || mode === "ticket-detail")) return "?";
	if (control.id === "help" && mode === "override-list") return "F1/?";
	if (control.id === "help" && mode === "override-text") return "F1";
	if (control.id === "message" && mode === "ticket-list") return "m";
	if (control.id === "message" && mode === "ticket-detail") return "m";
	if (control.id === "message" && (mode === "override-list" || mode === "override-text"))
		return "F2";
	return control.keyLabel;
}

/** The key's printable text can be handled by an override text row. */
export function guideKeyLabel(mode: InteractionMode, control: ControlDefinition): string {
	if (control.id === "move-list" && mode === "override-text") return "↑↓";
	if (control.id === "help" && mode === "override-text") return "F1";
	if (control.id === "message" && (mode === "override-list" || mode === "override-text"))
		return "F2";
	return control.keyLabel;
}

export function isPrintableKey(name: string): boolean {
	return [...name].length === 1 && !/\p{Cc}/u.test(name);
}

export function contextFor(
	mode: InteractionMode,
	values: Omit<ControlContext, "mode">,
): ControlContext {
	return { ...values, mode };
}
