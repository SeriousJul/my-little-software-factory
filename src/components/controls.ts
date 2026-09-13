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
	| "override-list"
	| "override-model"
	| "override-text"
	/** The controls one shared form runs, on the slots it holds. */
	| "form-field"
	| "form-selector"
	| "form-action"
	| "action-panel"
	| "decision-modal"
	| "missing-modal"
	| "key-guide"
	| "message-view"
	| "consultation-interaction";

/**
 * Which screen area owns the control's meaning.
 *
 * `form` is the controls one shared form runs, on the slots it holds.
 */
type ControlScope =
	| "global"
	| "control-plane"
	| "form"
	| "ticket-list"
	| "ticket-detail"
	| "consultation-list"
	| "consultation-detail"
	| "override"
	| "modal"
	| "utility"
	| "consultation-interaction";
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
	| "t"
	| "f"
	| "x"
	| "d"
	| "v"
	| "w"
	| "delete"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12"
	| "f13"
	| "f14"
	| "f15"
	| "f16"
	| "f17"
	| "f18"
	| "f19"
	| "f20"
	| "f21"
	| "f22"
	| "f23"
	| "f24"
	| `ctrl+${string}`
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
	/** The Consultation the base panes point at, if the list holds one. */
	selectedConsultation?: Consultation;
	listCanMove: boolean;
	detailCanScroll: boolean;
	sourceCount: number;
	refreshingSourceCount: number;
	/** Whether the Consultation list pane is rendered at the current width. */
	consultationListVisible?: boolean;
	/** The observed status of the selected Consultation Agent. */
	consultationAgentStatus?: string | null;
	handoffActive: boolean;
	messageTruncated: boolean;
	/** Whether the config defines any [consultation-types.<name>] block. */
	consultationTypesConfigured: boolean;
	/** The configured key that leaves Agent interaction mode. */
	interactionExitKey?: string;
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
}

export interface ControlDefinition {
	id: string;
	label: string;
	/**
	 * The keys the control accepts in each interaction mode.
	 *
	 * One control answers to a key the operator configures: the Agent
	 * terminal's exit key is read from the context, so the catalogue, the bar,
	 * and the dispatch still share one source for what a key means.
	 */
	keys: (mode: InteractionMode, context: ControlContext) => readonly ControlKey[];
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
	 * The wording of the control's hint on the Action bar. Default: `label`.
	 *
	 * A hint is a word an operator reads at the bottom of the screen, and for a
	 * few controls it is not the control's own name: a bar that already lives in
	 * the Consultation section does not restate "consultation", and a Refresh
	 * that recovers a Consultation names the recovery. The wording rides on the
	 * control that owns it, so the bar packs the catalogue and no second map has
	 * to remember which hint went with which id.
	 */
	barLabel?: (context: ControlContext) => string | undefined;
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
/** What the Consultation section does when a Consultation needs the operator. */
const CONSULTATIONS_NOTE = "opens on the Consultation that needs the operator, if one does";

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
/**
 * The configured interaction exit key, as the catalogue names a key.
 *
 * The Config accepts a function key or Ctrl plus a letter. A key outside that
 * set is a broken Config, and `F12` is what the app falls back to.
 */
function exitControlKey(exitKey: string | undefined): ControlKey {
	const normalized = (exitKey ?? "f12")
		.trim()
		.toLowerCase()
		.replace(/^ctrl-/, "ctrl+");
	const functionKey = /^f(?:[1-9]|1[0-9]|2[0-4])$/.exec(normalized);
	if (functionKey !== null) return normalized as ControlKey;
	if (/^ctrl\+[a-z]$/.test(normalized)) return normalized as ControlKey;
	return "f12";
}

/** The interaction exit key, as a hint states it. */
function interactionExitLabel(exitKey: string | undefined): string {
	return keyName(exitControlKey(exitKey));
}

/** What the in-flight meaning of Enter does, for the guide's current section. */
const LIVE_VIEW_NOTE = "opens the Live view on an in-flight Ticket";
const consultationMode = (mode: InteractionMode): boolean =>
	mode === "consultation-list" || mode === "consultation-detail";
const ticketBaseMode = (mode: InteractionMode): boolean =>
	mode === "ticket-list" || mode === "ticket-detail";
/**
 * Why a Ticket-section control answers nothing in the Consultation section.
 *
 * The control stays a candidate in both sections so the key the operator
 * already knows states a readable refusal instead of doing nothing at all.
 */
const ticketOnly = (context: ControlContext): ControlAvailability =>
	ticketBaseMode(context.mode)
		? available()
		: unavailable("this control is available only in the Ticket section");
const consultationListNavigation = (context: ControlContext): ControlAvailability =>
	context.consultationListVisible === false
		? unavailable("the Consultation list is hidden below 80 columns")
		: available();
const listMove = (context: ControlContext): ControlAvailability =>
	context.mode === "override-list" ||
	context.mode === "override-model" ||
	context.mode === "override-text" ||
	context.listCanMove
		? available()
		: unavailable(
				consultationMode(context.mode)
					? "the Consultation list has nowhere to move"
					: "the Ticket list has nowhere to move",
			);
const detailScroll = (context: ControlContext): ControlAvailability =>
	context.detailCanScroll
		? available()
		: unavailable(
				context.mode === "consultation-detail"
					? "the Consultation detail has nowhere to scroll"
					: "the Ticket detail has nowhere to scroll",
			);
/**
 * Why `r` answers nothing: the refresh reads the Ticket sources, and the
 * Consultation section runs the same refresh as the Ticket section, so both
 * sections share this one gate and this one reason.
 */
const refresh = (context: ControlContext): ControlAvailability => {
	if (context.sourceCount === 0) return unavailable("no Ticket sources exist");
	if (context.refreshingSourceCount >= context.sourceCount)
		return unavailable("every Ticket source is already refreshing");
	return available();
};
const consultationResponse = (context: ControlContext): ControlAvailability =>
	context.selectedConsultation?.state === "awaiting-response" &&
	context.consultationAgentStatus !== "blocked"
		? available()
		: unavailable("only an awaiting Consultation can receive a response");
const consultationInteraction = (context: ControlContext): ControlAvailability =>
	(context.selectedConsultation?.state === "working" ||
		(context.selectedConsultation?.state === "awaiting-response" &&
			context.consultationAgentStatus === "blocked")) &&
	context.selectedConsultation?.paneId !== null &&
	context.selectedConsultation?.paneId !== undefined
		? available()
		: unavailable("only a working or blocked Consultation with an Agent can be interacted with");
const consultationClose = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	return consultation.state === "closed"
		? unavailable("the selected Consultation is already closed")
		: available();
};
const consultationDelete = (context: ControlContext): ControlAvailability =>
	context.selectedConsultation?.state === "closed"
		? available()
		: unavailable("only a closed Consultation can be deleted");
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

const ticketBaseModes = ["ticket-list", "ticket-detail"] as const;
const consultationBaseModes = ["consultation-list", "consultation-detail"] as const;
const baseModes = [...ticketBaseModes, ...consultationBaseModes] as const;
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
const planeModes: readonly InteractionMode[] = [
	...baseModes,
	...overrideModes,
	...formModes,
	"action-panel",
	...modalModes,
	"key-guide",
	"message-view",
];
const allModes: readonly InteractionMode[] = [...planeModes, "consultation-interaction"];
// The Agent terminal owns its keys: Help, Message, and every control-plane
// action stay out of its mode, and only the controls named below, plus the
// emergency exit, reach it.

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
		// The base panes share one list movement: a row list the operator can
		// step through, with no detail pane to open on the way.
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
		modes: ["ticket-detail", "consultation-detail"],
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
		// The same pane navigation, named for the section that owns it. Left
		// returns to the Consultation list, never to the Ticket list.
		id: "consultation-list",
		label: "List",
		keys: () => ["left", "h"],
		keyLabel: "←/h",
		scope: "consultation-detail",
		actionBar: true,
		priority: 75,
		modes: ["consultation-detail"],
		availability: consultationListNavigation,
		showInBar: (context) => context.consultationListVisible !== false,
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
		modes: [...ticketBaseModes, ...overrideModes],
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
		modes: [...ticketBaseModes],
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
		modes: [...ticketBaseModes],
		availability: completionEligibility,
		// Enter means three things in the base modes, and the Key guide names
		// all of them whatever the selected Ticket runs, so the guide has to
		// say what this meaning of Enter is for.
		guideNote: DECIDE_NOTE,
	},
	{
		id: "consultations",
		label: "Consultations",
		// `v` expands the Consultation section from the Ticket section. It is
		// absent from Consultation modes, so repeating it is a no-op. On entry
		// from Tickets it may select the Consultation that needs the operator.
		keys: () => ["v"],
		keyLabel: "v",
		scope: "control-plane",
		actionBar: true,
		priority: 45,
		modes: [...ticketBaseModes],
		availability: available,
		guideNote: CONSULTATIONS_NOTE,
	},
	{
		id: "open-tickets",
		label: "Tickets",
		// `t` returns to the Ticket section from either Consultation pane. Agent
		// interaction uses Enter in the detail, so one key has one meaning.
		keys: () => ["t"],
		keyLabel: "t",
		scope: "control-plane",
		actionBar: true,
		priority: 45,
		modes: ["consultation-list", "consultation-detail"],
		availability: available,
	},
	{
		id: "launch",
		label: "Launch",
		// A Consultation can be opened from either section: from the Ticket
		// section it carries the selected Ticket's Repository into the launcher.
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
		id: "history",
		label: "History",
		// The filter answers even when the current filter holds nothing: an
		// empty open list is exactly when the operator reaches for the history.
		keys: () => ["f"],
		keyLabel: "f",
		scope: "control-plane",
		actionBar: true,
		priority: 55,
		modes: [...consultationBaseModes],
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
		modes: [...consultationBaseModes],
		availability: consultationClose,
	},
	{
		id: "consultation-delete",
		label: "Delete",
		keys: () => ["d"],
		keyLabel: "d",
		scope: "control-plane",
		actionBar: true,
		priority: 35,
		modes: [...consultationBaseModes],
		availability: consultationDelete,
	},
	{
		id: "consultation-respond",
		label: "Respond",
		// Enter answers an awaiting Consultation from either pane. `r` remains
		// the shared Refresh key, including while a response is available.
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 70,
		modes: [...consultationBaseModes],
		availability: consultationResponse,
	},
	{
		id: "consultation-interact",
		label: "Interact",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 69,
		modes: [...consultationBaseModes],
		availability: consultationInteraction,
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
		availability: (context) =>
			ticketBaseMode(context.mode)
				? handoffEligibility(
						"awaiting ticket: press Enter, then e on a Handoff row to edit its settings",
					)(context)
				: ticketOnly(context),
	},
	{
		id: "refresh",
		label: "Refresh",
		keys: () => ["r"],
		keyLabel: "r",
		scope: "control-plane",
		actionBar: true,
		priority: 61,
		modes: [...baseModes],
		// The interrupted opening answers to `r` as the recovery, so the
		// Consultation section hands its `r` over while a row opens. Listed
		// before Recover, it owns the key the bar and the dispatch state when
		// both meanings are refused: a missing source is a fact about refresh.
		availability: (context) =>
			consultationMode(context.mode) && context.selectedConsultation?.state === "opening"
				? unavailable("the interrupted opening answers to r as recovery")
				: refresh(context),
	},
	{
		id: "recover",
		label: "Recover",
		// `r` names the recovery an interrupted opening needs, and stays Refresh
		// for every other Consultation row.
		keys: () => ["r"],
		keyLabel: "r",
		scope: "control-plane",
		actionBar: true,
		priority: 60,
		modes: [...consultationBaseModes],
		availability: (context) =>
			context.selectedConsultation?.state === "opening"
				? available()
				: unavailable("only an interrupted opening needs recovery"),
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
		availability: (context) =>
			ticketBaseMode(context.mode) ? leftoverClear(context) : ticketOnly(context),
	},
	{
		// The Agent terminal forwards every key to the Agent. Only the
		// configured exit key and the emergency exit answer to the plane, so
		// this mode claims nothing else.
		id: "interact-exit",
		label: "Exit interaction",
		keys: (_mode, context) => [exitControlKey(context.interactionExitKey)],
		keyLabel: "F12",
		scope: "consultation-interaction",
		actionBar: true,
		barAnchor: true,
		priority: 100,
		modes: ["consultation-interaction"],
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
		// A focused field owns its own editing keys, so this control moves the
		// form's selection. In a selector or an action it is Tab, as on the
		// plane's list rows; the field's arrows belong to the caret.
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
		// A focused selector cycles the offered values on the row.
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
		// The focused action runs on Enter. The bar's refusal line states
		// why it cannot run; the surface supplies the reason in its own words.
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
		modes: [...planeModes],
		availability: available,
	},
	{
		id: "message",
		label: "Message",
		// `m` opens the Message view only from the base panes. F2 is the
		// alias in every interaction mode, so text input keeps its `m`.
		keys: (mode) => (ticketBaseMode(mode) || consultationMode(mode) ? ["m", "f2"] : ["f2"]),
		keyLabel: "m/F2",
		scope: "global",
		actionBar: true,
		priority: 900,
		modes: [...planeModes],
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
		modes: [...ticketBaseModes],
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
	const keys = control.keys(mode, context);
	if (keys.length === 0) return true;
	return keys.some((key) => {
		const event = key === "ctrl+c" ? { name: "c", ctrl: true } : { name: key };
		return controlForKey(event, context)?.id === control.id;
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
function candidatesForKey(context: ControlContext, key: ControlKey): readonly ControlDefinition[] {
	const mode = context.mode;
	// Utility close controls take precedence over global aliases that share
	// their keys. The catalogue still owns both meanings.
	if (mode === "key-guide" && (key === "escape" || key === "f1" || key === "?"))
		return [controlById("guide-close")];
	if (mode === "message-view" && (key === "escape" || key === "f2"))
		return [controlById("message-close")];
	return controlsForMode(mode).filter((control) => control.keys(mode, context).includes(key));
}

/** The whole key one accepted binding is called by, as a hint states it. */
const KEY_NAMES: Record<string, string> = {
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
	f4: "F4",
	f5: "F5",
	f6: "F6",
	f7: "F7",
	f8: "F8",
	f9: "F9",
	f10: "F10",
	f11: "F11",
	f12: "F12",
	f13: "F13",
	f14: "F14",
	f15: "F15",
	f16: "F16",
	f17: "F17",
	f18: "F18",
	f19: "F19",
	f20: "F20",
	f21: "F21",
	f22: "F22",
	f23: "F23",
	f24: "F24",
	"?": "?",
	return: "Enter",
	escape: "Esc",
	backspace: "Backspace",
	delete: "Delete",
	w: "w",
	"ctrl+c": "Ctrl+C",
};

function keyName(key: ControlKey): string {
	if (key.startsWith("ctrl+")) return `Ctrl+${key.slice(5).toUpperCase()}`;
	return KEY_NAMES[key] ?? key;
}

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
	context: ControlContext,
): string[] {
	const ranked = control
		.keys(mode, context)
		.map(keyName)
		.map((label) => ({ label, rank: label === KEY_NAMES.escape ? 0 : 1, cells: widthOf(label) }));
	ranked.sort((a, b) => a.rank - b.rank || a.cells - b.cells);
	return [...new Set(ranked.map((entry) => entry.label))];
}

/** Find a control accepted by this mode for one OpenTUI key event. */
export function controlForKey(
	key: { name: string; ctrl?: boolean; meta?: boolean },
	context: ControlContext,
): ControlDefinition | undefined {
	const name = key.ctrl === true && /^[a-z]$/.test(key.name) ? `ctrl+${key.name}` : key.name;
	const candidates = candidatesForKey(context, name as ControlKey);
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

/** Ticket-section controls have no useful meaning in a Consultation guide. */
function omitFromConsultationGuide(mode: InteractionMode, control: ControlDefinition): boolean {
	return (
		consultationMode(mode) &&
		control.scope !== "global" &&
		(control.scope === "control-plane" ||
			control.scope === "ticket-list" ||
			control.scope === "ticket-detail") &&
		!control.modes.some(consultationMode)
	);
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
function isCataloguedInMode(
	mode: InteractionMode,
	control: ControlDefinition,
	context: ControlContext,
): boolean {
	// A control of another mode is cataloged on its own terms: the guide
	// states what it does and claims nothing about this mode's keys.
	if (!control.modes.includes(mode)) return true;
	const keys = control.keys(mode, context);
	// A display-only hint (the text row's Type and Backspace) claims no key.
	if (keys.length === 0) return true;
	return keys.some((key) =>
		candidatesForKey({ ...context, mode }, key).some((candidate) => candidate.id === control.id),
	);
}

/** Current-mode controls, then global and control-plane controls, then other modes. */
export function guideControls(context: ControlContext): Array<{
	group: string;
	control: ControlDefinition;
}> {
	const mode = context.mode;
	// The current section is every control this mode dispatches a key for. The
	// bar shows only the meaning the current state runs; the guide shows both.
	const current = controlsForMode(mode).filter(
		(control) =>
			control.actionBar &&
			control.id !== "emergency-exit" &&
			control.guideOnly !== true &&
			isCataloguedInMode(mode, control, context),
	);
	const seen = new Set(current.map((control) => control.id));
	const append = (group: string, predicate: (control: ControlDefinition) => boolean) =>
		CONTROL_DEFINITIONS.filter(
			(control) =>
				!seen.has(control.id) &&
				control.guideOnly !== true &&
				!omitFromConsultationGuide(mode, control) &&
				predicate(control) &&
				isCataloguedInMode(mode, control, context),
		).map((control) => {
			seen.add(control.id);
			return { group, control };
		});
	// The guide states how a focused field edits, so the guide is the one
	// catalog that covers it: the rows name the keys a field owns outright.
	const fieldEditing = fieldModes.includes(mode)
		? FIELD_EDITING_ROWS.filter((control) => control.modes.includes(mode))
		: [];
	for (const control of fieldEditing) seen.add(control.id);
	return [
		...current.map((control) => ({ group: "Current interaction mode", control })),
		...fieldEditing.map((control) => ({ group: "Field editing", control })),
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
			return "Consultation detail";
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
		case "form-field":
			return "Form field";
		case "form-selector":
			return "Form selector";
		case "form-action":
			return "Form action";
		case "action-panel":
			return "Action panel";
		case "consultation-interaction":
			return "Agent terminal";
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
	context: ControlContext,
): string {
	if (control.id === "interact-exit") return interactionExitLabel(context.interactionExitKey);
	if (control.id === "consultation-interact") return "Enter";
	if (control.id === "move-list" && (mode === "override-text" || mode === "override-model"))
		return "↑↓";
	if (control.id === "help") {
		// A field owns its printable keys, and `?` is one of them: in the field
		// modes only F1 opens the guide.
		if (fieldModes.includes(mode)) return "F1";
		if (mode === "override-list") return includeAllAliases ? "F1/?" : "F1";
		if (ticketBaseMode(mode) || consultationMode(mode)) return includeAllAliases ? "F1/?" : "?";
	}
	if (control.id === "message") {
		if (ticketBaseMode(mode) || consultationMode(mode)) return includeAllAliases ? "m/F2" : "m";
		return "F2";
	}
	return control.keyLabel;
}

export function keyLabelFor(
	mode: InteractionMode,
	control: ControlDefinition,
	context: ControlContext,
): string {
	return displayKeyLabel(mode, control, false, context);
}

/** The Key guide shows all aliases which are valid in its source mode. */
export function guideKeyLabel(
	mode: InteractionMode,
	control: ControlDefinition,
	context: ControlContext,
): string {
	return displayKeyLabel(mode, control, true, context);
}

export function contextFor(
	mode: InteractionMode,
	values: Omit<ControlContext, "mode">,
): ControlContext {
	return { ...values, mode };
}
