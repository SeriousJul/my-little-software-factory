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
import type { Consultation } from "../state.ts";
import { widthOf } from "./text.ts";

export type InteractionMode =
	| "ticket-list"
	| "ticket-detail"
	| "consultation-list"
	| "consultation-detail"
	| "consultation-interaction"
	| "override-list"
	| "override-model"
	| "override-text"
	| "form-field"
	| "form-selector"
	| "form-action"
	| "action-panel"
	| "decision-modal"
	| "missing-modal"
	| "key-guide"
	| "message-view";

type ControlScope =
	| "global"
	| "control-plane"
	/** The controls one shared form runs, on the slots it holds. */
	| "form"
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
	| "t"
	| "f"
	| "x"
	| "d"
	| "r"
	| "a"
	| "m"
	| "c"
	| "v"
	| "w"
	| "delete"
	| "f1"
	| "f2"
	| "f3"
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
	/**
	 * The slot of the active form that holds the focus.
	 *
	 * A form owns one keyboard rule per slot: a field takes its own editing
	 * keys, a selector cycles, an action confirms. The surface states the fact
	 * from the slot it holds, and the catalogue gates on it, so no mode can
	 * hand a Draft field's arrows to the form's selection.
	 */
	formSlot?: "field" | "selector" | "action";
	/** The active form has a text selection the Copy control could hand over. */
	fieldHasSelection?: boolean;
	/** The Model search row holds text the clear control could remove. */
	formSearchActive?: boolean;
	/** How many values the focused selector offers. One of them cycles nowhere. */
	formCycleCount?: number;
	/** Why the form's Confirm action cannot run, in the surface's own words. */
	formRefusal?: string;
	/** The Consultation selected by the consultations section. */
	selectedConsultation?: Consultation;
	/** The last observed Agent status for the selected Consultation. */
	consultationAgentStatus?: string | null;
	consultationCanMove?: boolean;
	consultationDetailCanScroll?: boolean;
	consultationHistory?: "open" | "closed" | "all";
	/** The configured key which returns from Agent interaction mode. */
	interactionExitKey?: string;
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
	/**
	 * Whether the hint carries the surface's row-range indicator.
	 *
	 * The utility overlays hand their range to the bar, and the bar places it
	 * behind the hint that owns it: the Scroll hint of the guide and of the
	 * Message view. A hint without the flag is plain text to the bar.
	 */
	rangeAnchor?: boolean;
	/**
	 * Whether the control belongs to the Key guide alone.
	 *
	 * A field owns its editing keys outright, so the plane dispatches nothing
	 * for them and the Action bar names none. The guide still lists them: the
	 * keys an operator uses most must not stay an undocumented exception.
	 */
	guideOnly?: boolean;
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

/** The panel's own modes: while one is open, the list's selection is inert. */
const panelMode = (mode: InteractionMode) =>
	mode === "override-list" || mode === "override-model" || mode === "override-text";

/**
 * The Handoff and Override eligibility rules, with one source for each
 * reason. An Override on a settled Ticket misses its Handoff row by one
 * step, so it names that step instead of the state rule. In the panel's own
 * modes, Enter confirms the panel's ticket, not the list's selection, so the
 * state rule belongs to the claim: it re-checks the panel's ticket when the
 * confirm lands.
 */
const handoffEligibility =
	(awaitingReason?: string) =>
	(context: ControlContext): ControlAvailability => {
		if (context.handoffActive) return unavailable("a Handoff is active");
		if (panelMode(context.mode)) return available();
		const ticket = context.selectedTicket;
		if (ticket === undefined) return unavailable("no Ticket is selected");
		if (ticket.state === "awaiting" && awaitingReason !== undefined)
			return unavailable(awaitingReason);
		if (ticket.state !== "open") return unavailable("only an open Ticket can be handed off");
		if (ticket.handoffRecoveryRequired)
			return unavailable("Handoff recovery is required before another handoff");
		if (!ticket.actionable)
			return unavailable(
				"Ticket is not actionable because source data is stale, removed, or absent",
			);
		return available();
	};

/** A settled Ticket uses Enter to decide its completed work, not to hand it off. */
const completionEligibility = (context: ControlContext): ControlAvailability => {
	if (context.handoffActive) return unavailable("a Handoff is active");
	return context.selectedTicket?.state === "awaiting"
		? available()
		: unavailable("the selected Ticket has no completion to decide");
};
/**
 * An in-flight Ticket uses Enter to watch its work: the Live view streams
 * the agent's terminal, and the missing screen stands in for it when the
 * agent is gone. The view runs nothing by itself, so it stays open while a
 * Handoff is active: the rows it carries own their own gates, and the
 * operator still needs the missing screen to queue a restart. The claim
 * inside the handler owns the marker check, so the gate only states the
 * state rule.
 */
const liveViewEligibility = (context: ControlContext): ControlAvailability => {
	const ticket = context.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (ticket.state === "handed-off" || ticket.state === "running") return available();
	return unavailable("only an in-flight Ticket has a Live view");
};
/** What the in-flight meaning of Enter does, for the guide's current section. */
const LIVE_VIEW_NOTE = "opens the Live view on an in-flight Ticket";
const listMove = (context: ControlContext): ControlAvailability =>
	context.mode === "consultation-list"
		? consultationListMove(context)
		: context.mode === "override-list" ||
				context.mode === "override-model" ||
				context.mode === "override-text" ||
				context.listCanMove
			? available()
			: unavailable("the Ticket list has nowhere to move");
const detailScroll = (context: ControlContext): ControlAvailability =>
	context.detailCanScroll ? available() : unavailable("the Ticket detail has nowhere to scroll");
const consultationListMove = (context: ControlContext): ControlAvailability =>
	context.consultationCanMove === true
		? available()
		: unavailable("the Consultation list has nowhere to move");
const consultationDetailScroll = (context: ControlContext): ControlAvailability =>
	context.consultationDetailCanScroll === true
		? available()
		: unavailable("the Agent view has nowhere to scroll");
const consultationModes = ["consultation-list", "consultation-detail"] as const;
const consultationResponse = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	if (consultation.state !== "awaiting-response")
		return unavailable("only an awaiting-response Consultation accepts a response");
	if (context.consultationAgentStatus === "blocked")
		return unavailable("the Agent is blocked; Enter opens interaction mode");
	return available();
};
const consultationInteraction = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	if (consultation.paneId === null) return unavailable("the Consultation has no Agent pane");
	if (
		consultation.state === "working" ||
		(consultation.state === "awaiting-response" && context.consultationAgentStatus === "blocked")
	)
		return available();
	return unavailable("the selected Consultation has no interactive Agent");
};
const consultationClose = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	return ["opening", "working", "awaiting-response", "missing", "failed", "closing"].includes(
		consultation.state,
	)
		? available()
		: unavailable("the selected Consultation is already closed");
};
const consultationDelete = (context: ControlContext): ControlAvailability =>
	context.selectedConsultation?.state === "closed"
		? available()
		: unavailable("only a closed Consultation can be deleted");
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
	if (ticket.leftover === null || ticket.leftover === undefined)
		return unavailable(`no leftover environment is recorded for ticket ${ticket.identity}`);
	return available();
};

const baseModes = ["ticket-list", "ticket-detail"] as const;
const overrideModes = ["override-list", "override-model", "override-text"] as const;
/**
 * The modes one shared form surface runs, one per slot kind.
 *
 * A form's fields, selectors, and actions are the same controls in every
 * screen that holds them, so they share these modes instead of each screen
 * naming its own. A surface picks the mode of the slot under the focus.
 */
const formModes = ["form-field", "form-selector", "form-action"] as const;
/** Every mode in which a field holds the printable keys and edits itself. */
const fieldModes: readonly InteractionMode[] = ["form-field", "override-text", "override-model"];
const modalModes = ["decision-modal", "missing-modal"] as const;
const allModes: readonly InteractionMode[] = [
	...baseModes,
	...consultationModes,
	"consultation-interaction",
	...overrideModes,
	...formModes,
	"action-panel",
	...modalModes,
	"key-guide",
	"message-view",
];

/**
 * One field editing row: a key the focused field owns outright.
 *
 * These controls dispatch nothing, because the field itself runs them. They
 * exist so the Key guide names field editing instead of leaving the most-used
 * keys of the plane undocumented, and so the guide stays the one catalog the
 * plane has: a row here is read the same way as a dispatched control.
 */
function editingRow(
	id: string,
	label: string,
	keyLabel: string,
	modes: readonly InteractionMode[],
): ControlDefinition {
	return {
		id,
		label,
		// Display-only: a key the focused field already took claims nothing.
		keys: () => [],
		keyLabel,
		scope: "control-plane",
		actionBar: false,
		guideOnly: true,
		priority: 0,
		modes,
		availability: available,
	};
}

/**
 * The editing controls of a Text field and a Draft field, for the Key guide.
 *
 * A Draft field adds the newline row: its Enter inserts a line rather than
 * starting work, and the surface's visible action is what submits it.
 */
const FIELD_EDITING_ROWS: readonly ControlDefinition[] = [
	editingRow("edit-caret", "Move caret", "Left/Right", fieldModes),
	editingRow("edit-lines", "Move caret by line", "Up/Down", ["form-field"]),
	editingRow("edit-select", "Select text", "Shift+arrow", fieldModes),
	editingRow("edit-word", "Word movement", "Ctrl+Left/Right", fieldModes),
	editingRow("edit-edges", "Line and buffer edges", "Home/End", fieldModes),
	editingRow("edit-delete", "Delete backward, forward", "Backspace/Delete", fieldModes),
	editingRow("edit-word-delete", "Delete a word", "Ctrl+Backspace", fieldModes),
	editingRow("edit-undo", "Undo", "Ctrl+Z", fieldModes),
	editingRow("edit-redo", "Redo", "Ctrl+Y", fieldModes),
	editingRow("edit-select-all", "Select all", "Ctrl+A", fieldModes),
	editingRow("edit-paste", "Paste text", "Terminal paste", fieldModes),
	editingRow("edit-newline", "Insert a new line", "Enter", ["form-field"]),
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
					: mode === "consultation-list"
						? ["up", "down", "j", "k", "pageup", "pagedown", "home", "end"]
						: ["up", "down", "tab"],
		keyLabel: "↑↓/jk",
		scope: "control-plane",
		actionBar: true,
		priority: 80,
		modes: ["ticket-list", "consultation-list", "override-list", "override-model", "override-text"],
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
		modes: ["ticket-list", "consultation-list"],
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
		id: "scroll-consultation",
		label: "Scroll",
		keys: () => ["up", "down", "j", "k", "pageup", "pagedown", "home", "end"],
		keyLabel: "↑↓/jk",
		scope: "control-plane",
		actionBar: true,
		priority: 80,
		modes: ["consultation-detail"],
		availability: consultationDetailScroll,
	},
	{
		id: "tickets",
		label: "Tickets",
		keys: (mode) =>
			mode === "consultation-list" || mode === "consultation-detail" ? ["t"] : ["left", "h"],
		keyLabel: "←/h",
		scope: "ticket-detail",
		actionBar: true,
		priority: 75,
		modes: ["ticket-detail", "consultation-list", "consultation-detail"],
		availability: available,
	},
	{
		id: "consultation-focus-list",
		label: "List",
		keys: () => ["left", "h"],
		keyLabel: "←/h",
		scope: "control-plane",
		actionBar: true,
		priority: 75,
		modes: ["consultation-detail"],
		availability: available,
	},
	{
		id: "change-override",
		label: "Change",
		// Only a list row cycles: the Model row is a Text field that owns its
		// arrows for the caret, and the Model search edits its own text.
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
		// Display-only: a free-text row is a standard input that owns its
		// typing, and the Model row types into its visible search. Neither key
		// reaches the panel, so the hint claims none.
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
		// free-text rows and the Model search are fields that own their own
		// Backspace, so they keep the display-only Delete hint and never reach
		// this control: a search an operator is correcting one character at a
		// time must not vanish under the key they pressed to shorten it.
		keys: () => ["backspace", "delete"],
		keyLabel: "⌫",
		scope: "override",
		actionBar: true,
		priority: 75,
		modes: ["override-list"],
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
		availability: handoffEligibility(),
	},
	{
		id: "live-view",
		label: "Live view",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 70,
		modes: [...baseModes],
		availability: liveViewEligibility,
		// Enter means three things in the base modes, and the Key guide names
		// all of them whatever the selected Ticket runs, so the guide has to
		// say what this meaning of Enter is for.
		guideNote: LIVE_VIEW_NOTE,
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
		// Enter means three things in the base modes, and the Key guide names
		// all of them whatever the selected Ticket runs, so the guide has to
		// say what this meaning of Enter is for.
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
		modes: [...baseModes, ...consultationModes],
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
		availability: handoffEligibility(
			"awaiting ticket: press Enter, then e on a Handoff row to edit its settings",
		),
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
		id: "consultation-respond",
		label: "Respond",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 71,
		modes: [...consultationModes],
		availability: consultationResponse,
	},
	{
		id: "consultation-interact",
		label: "Interact",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 72,
		modes: [...consultationModes],
		availability: consultationInteraction,
	},
	{
		id: "consultation-history",
		label: "History",
		keys: () => ["f"],
		keyLabel: "f",
		scope: "control-plane",
		actionBar: true,
		priority: 60,
		modes: [...consultationModes],
		availability: available,
	},
	{
		id: "consultation-close",
		label: "Close",
		keys: () => ["x"],
		keyLabel: "x",
		scope: "control-plane",
		actionBar: true,
		priority: 50,
		modes: [...consultationModes],
		availability: consultationClose,
	},
	{
		id: "consultation-delete",
		label: "Delete",
		keys: () => ["d"],
		keyLabel: "d",
		scope: "control-plane",
		actionBar: true,
		priority: 50,
		modes: [...consultationModes],
		availability: consultationDelete,
		showInBar: (context) => consultationDelete(context).available,
	},
	{
		id: "consultation-refresh",
		label: "Refresh",
		keys: () => ["r"],
		keyLabel: "r",
		scope: "control-plane",
		actionBar: true,
		priority: 35,
		modes: [...consultationModes],
		availability: available,
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
		id: "move-field",
		label: "Field",
		// A field owns Up and Down for its own caret, so Tab is the only key
		// that leaves one. A selector or an action takes the arrows too, because
		// nothing there edits text.
		keys: (mode) => (mode === "form-field" ? ["tab"] : ["up", "down", "tab"]),
		keyLabel: "Tab",
		scope: "form",
		actionBar: true,
		priority: 82,
		modes: [...formModes],
		availability: available,
	},
	{
		id: "cycle-choice",
		label: "Change",
		keys: () => ["left", "right"],
		keyLabel: "←→",
		scope: "form",
		actionBar: true,
		priority: 80,
		modes: ["form-selector"],
		availability: (context) =>
			context.formCycleCount !== undefined && context.formCycleCount > 1
				? available()
				: unavailable("this choice has no other value"),
	},
	{
		id: "confirm-choice",
		label: "Confirm",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "form",
		actionBar: true,
		priority: 70,
		modes: ["form-action"],
		availability: (context) =>
			context.formRefusal === undefined ? available() : unavailable(context.formRefusal),
	},
	{
		id: "copy-selection",
		label: "Copy selection",
		keys: () => ["f3"],
		keyLabel: "F3",
		scope: "form",
		actionBar: true,
		priority: 45,
		modes: [...formModes, "override-text", "override-model"],
		// Copy is its own control, because Ctrl+C stays the emergency exit even
		// while a field holds a selection: a text selection may never change what
		// a safety control means.
		availability: (context) =>
			context.fieldHasSelection === true
				? available()
				: unavailable("the focused field holds no selection to copy"),
		showInBar: (context) => context.fieldHasSelection === true,
	},
	{
		id: "clear-search",
		label: "Clear",
		// Backspace belongs to the search text, so the explicit clear is its own
		// key: an operator who wants the whole query gone presses one key rather
		// than one per character. With no query left, the same key gives the
		// setting back to the agent, which is what clearing a list row does, so
		// the row is never stuck on a value the operator cannot remove.
		keys: () => ["delete"],
		keyLabel: "Del",
		scope: "override",
		actionBar: true,
		priority: 60,
		modes: ["override-model"],
		availability: available,
	},
	{
		id: "close-form",
		label: "Close",
		// Closing a form keeps what the operator typed: discarding is its own
		// visible action, never a side effect of the way out.
		keys: () => ["escape"],
		keyLabel: "Esc",
		scope: "form",
		actionBar: true,
		priority: 90,
		modes: [...formModes],
		availability: available,
	},
	{
		id: "help",
		label: "Help",
		// `?` opens Help wherever the mode does not own printable text. In the
		// override text row and on the Model list row, which types its letters,
		// it stays text, and only F1 reaches Help.
		keys: (mode) => (fieldModes.includes(mode) ? ["f1"] : ["f1", "?"]),
		keyLabel: "F1/?",
		scope: "global",
		actionBar: true,
		barAnchor: true,
		priority: 1000,
		modes: allModes.filter((mode) => mode !== "consultation-interaction"),
		availability: available,
	},
	{
		id: "message",
		label: "Message",
		// `m` opens the Message view only from the base panes. F2 is the
		// alias in every interaction mode, so text input keeps its `m`.
		keys: (mode) =>
			mode === "ticket-list" ||
			mode === "ticket-detail" ||
			mode === "consultation-list" ||
			mode === "consultation-detail"
				? ["m", "f2"]
				: ["f2"],
		keyLabel: "m/F2",
		scope: "global",
		actionBar: true,
		priority: 900,
		modes: allModes.filter((mode) => mode !== "consultation-interaction"),
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
		modes: [...baseModes, ...consultationModes],
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
		modes: [...baseModes, ...consultationModes],
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
		id: "interaction-exit",
		label: "Exit interaction",
		keys: () => [],
		keyLabel: "Exit",
		scope: "control-plane",
		actionBar: true,
		barAnchor: true,
		priority: 95,
		modes: ["consultation-interaction", ...consultationModes],
		availability: available,
		showInBar: (context) =>
			context.mode === "consultation-interaction" ||
			(context.selectedConsultation?.state === "awaiting-response" &&
				context.consultationAgentStatus === "blocked"),
	},
	{
		id: "select-action",
		label: "Select action",
		keys: () => ["up", "down"],
		keyLabel: "↑↓",
		scope: "modal",
		actionBar: true,
		priority: 80,
		modes: [...modalModes, "action-panel"],
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
		modes: ["missing-modal", "action-panel"],
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
		modes: [...modalModes, "action-panel"],
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
		modes: [...modalModes, "action-panel"],
		availability: available,
	},
	{
		id: "guide-scroll",
		label: "Scroll",
		keys: () => ["up", "down", "j", "k"],
		keyLabel: "↑↓/jk",
		scope: "utility",
		actionBar: true,
		rangeAnchor: true,
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
		rangeAnchor: true,
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
	t: "t",
	f: "f",
	x: "x",
	d: "d",
	r: "r",
	a: "a",
	m: "m",
	c: "c",
	v: "v",
	f1: "F1",
	f2: "F2",
	f3: "F3",
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
export function compactKeyLabels(
	mode: InteractionMode,
	control: ControlDefinition,
	context?: ControlContext,
): string[] {
	if (control.id === "interaction-exit" && context !== undefined)
		return [interactionExitLabel(context)];
	const ranked = control
		.keys(mode)
		.map((key) => KEY_NAMES[key])
		.map((label) => ({ label, rank: label === KEY_NAMES.escape ? 0 : 1, cells: widthOf(label) }));
	ranked.sort((a, b) => a.rank - b.rank || a.cells - b.cells);
	return [...new Set(ranked.map((entry) => entry.label))];
}

/** Match the configured key which returns from Agent interaction mode. */
function interactionExitMatches(
	context: ControlContext,
	key: { name: string; ctrl?: boolean },
): boolean {
	const configured = context.interactionExitKey?.trim().toLowerCase();
	if (configured === undefined || configured === "") return false;
	const normalized = configured.replace(/^ctrl-/, "ctrl+");
	return normalized.startsWith("ctrl+")
		? key.ctrl === true && key.name.toLowerCase() === normalized.slice(5)
		: key.ctrl !== true && key.name.toLowerCase() === normalized;
}

function interactionExitLabel(context: ControlContext): string {
	const configured = (context.interactionExitKey ?? "")
		.trim()
		.toLowerCase()
		.replace(/^ctrl-/, "ctrl+");
	return configured.startsWith("ctrl+")
		? `Ctrl+${configured.slice(5).toUpperCase()}`
		: configured.toUpperCase();
}

/** Find a control accepted by this mode for one OpenTUI key event. */
export function controlForKey(
	mode: InteractionMode,
	key: { name: string; ctrl?: boolean; meta?: boolean },
	context: ControlContext,
): ControlDefinition | undefined {
	if (mode === "consultation-interaction" && interactionExitMatches(context, key))
		return controlById("interaction-exit");
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
			control.actionBar &&
			control.guideOnly !== true &&
			control.id !== "emergency-exit" &&
			isCataloguedInMode(mode, control),
	);
	// A field owns its editing keys, so the plane dispatches none of them. The
	// guide still names them, and names them with the mode's own controls, so a
	// field's basic editing is never the undocumented exception again.
	const editing = FIELD_EDITING_ROWS.filter((control) => control.modes.includes(mode));
	const seen = new Set(current.map((control) => control.id));
	const consultationOnly = new Set([
		"consultation-respond",
		"consultation-interact",
		"consultation-history",
		"consultation-close",
		"consultation-delete",
		"consultation-refresh",
		"consultation-focus-list",
		"scroll-consultation",
		"interaction-exit",
	]);
	const append = (group: string, predicate: (control: ControlDefinition) => boolean) =>
		CONTROL_DEFINITIONS.filter(
			(control) =>
				!seen.has(control.id) &&
				predicate(control) &&
				(!consultationOnly.has(control.id) || mode.startsWith("consultation")) &&
				isCataloguedInMode(mode, control),
		).map((control) => {
			seen.add(control.id);
			return { group, control };
		});
	return [
		...current.map((control) => ({ group: "Current interaction mode", control })),
		...editing.map((control) => ({ group: "Field editing", control })),
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
		case "consultation-list":
			return "Consultation list";
		case "consultation-detail":
			return "Agent view";
		case "consultation-interaction":
			return "Agent interaction";
		case "override-list":
			return "Override list row";
		case "override-model":
			return "Override model row";
		case "override-text":
			return "Override text row";
		case "form-field":
			return "Form field";
		case "form-selector":
			return "Form choice";
		case "form-action":
			return "Form action";
		case "action-panel":
			return "Confirmation";
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
	context?: ControlContext,
): string {
	if (control.id === "interaction-exit" && context !== undefined)
		return interactionExitLabel(context);
	if (control.id === "tickets" && (mode === "consultation-list" || mode === "consultation-detail"))
		return "t";
	if (control.id === "move-list" && (mode === "override-text" || mode === "override-model"))
		return "↑↓";
	if (control.id === "help") {
		// A field types its letters, and `?` is one of them: only F1 opens the
		// guide where a field holds the printable keys.
		if (fieldModes.includes(mode)) return "F1";
		if (mode === "override-list") return includeAllAliases ? "F1/?" : "F1";
		if (mode === "ticket-list" || mode === "ticket-detail") return includeAllAliases ? "F1/?" : "?";
	}
	if (control.id === "message") {
		if (mode === "ticket-list" || mode === "ticket-detail") return includeAllAliases ? "m/F2" : "m";
		return "F2";
	}
	return control.keyLabel;
}

export function keyLabelFor(
	mode: InteractionMode,
	control: ControlDefinition,
	context?: ControlContext,
): string {
	return displayKeyLabel(mode, control, false, context);
}

/** The Key guide shows all aliases which are valid in its source mode. */
export function guideKeyLabel(
	mode: InteractionMode,
	control: ControlDefinition,
	context?: ControlContext,
): string {
	return displayKeyLabel(mode, control, true, context);
}

export function contextFor(
	mode: InteractionMode,
	values: Omit<ControlContext, "mode">,
): ControlContext {
	return { ...values, mode };
}
