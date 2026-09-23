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
import type { Consultation, WorkQueueItem } from "../state.ts";
import { widthOf } from "./text.ts";

export type InteractionMode =
	| "ticket-list"
	| "ticket-detail"
	| "consultation-list"
	| "consultation-detail"
	/** The Work queue's list and detail panes (ADR 0034). */
	| "work-queue-list"
	| "work-queue-detail"
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
	/** The Live view's streaming sub-mode (ADR 0040). */
	| "live-view"
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
	| "work-queue-list"
	| "work-queue-detail"
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
	| "f"
	| "g"
	| "s"
	| "p"
	| "x"
	| "d"
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
	| "ctrl+c"
	| "-"
	| "="
	| "+";

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
	/**
	 * The Work queue's item under the cursor, with the queue's depth beside it
	 * (ADR 0034). The item's own position is the queue order's.
	 */
	selectedWorkQueueItem?: WorkQueueItem | null;
	workQueueDepth?: number;
	/**
	 * The queue pause for the Work queue's section (ADR 0052): the `p` key's
	 * hint reads its own state, and the other sections refuse it in the
	 * catalogue's words.
	 */
	queuePaused?: boolean;
	/**
	 * The Work queue item the row under the cursor waits with, in the Ticket
	 * and Consultation list panes (ADR 0049): Enter on such a row jumps to
	 * the item instead of starting or deciding.
	 */
	queueItemForSelectedRow?: WorkQueueItem | null;
	listCanMove: boolean;
	detailCanScroll: boolean;
	sourceCount: number;
	refreshingSourceCount: number;
	/** Whether the Consultation section can re-read its durable projection. */
	consultationRefreshAvailable?: boolean;
	/** The observed status of the selected Consultation Agent. */
	consultationAgentStatus?: string | null;
	/**
	 * Whether the selected Consultation's Agent pane is alive in the last
	 * herdr poll. Goto focuses that pane, so it needs it.
	 */
	consultationPaneAlive?: boolean;
	/**
	 * Whether the selected Ticket's Agent pane is alive in the last herdr
	 * poll. Goto focuses that pane, so an in-flight Ticket needs it (ADR 0033).
	 */
	ticketPaneAlive?: boolean;
	/**
	 * Whether the selected Ticket's recorded pane holds a live agent that is
	 * not the Ticket's own. Herdr hands the id of a closed pane out again, so
	 * the recorded pane of an awaiting Ticket can name a pane a different
	 * agent owns, and Goto must not focus it there (ADR 0033's recorded-pane
	 * standing gives way to the agent's identity).
	 */
	ticketPaneForeign?: boolean;
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
	 * Whether the surface's Body pane scrolls: the body holds more rows than
	 * its window. The surface states it from its own rows, and the catalogue
	 * gates the body's scroll on it, so the bar never hints a scroll that
	 * cannot run (ADR 0039).
	 */
	bodyScrollable?: boolean;
	/** Whether the surface's Body pane carries nothing at all. */
	bodyEmpty?: boolean;
	/**
	 * The rows the surface's Decision region holds.
	 *
	 * The surface states it from its own rows, and the catalogue refuses the
	 * region's selection when the region holds one row, on the same rule the
	 * form's selector already uses for a cycle that goes nowhere.
	 */
	actionRowCount?: number;
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
	/**
	 * The control belongs to the Consultation section alone (issue #85).
	 *
	 * Stated once here, and read by every place the section shows: every other
	 * section's modes state the section refusal for the key (availabilityFor),
	 * those sections' guides omit the control (omitFromOtherSection), and their
	 * bars omit its hint (actionBarControls). A future Consultation-only key
	 * cannot refuse in another section and still show up in that section's
	 * guide or bar: the three rules read this one marker, and the catalogue
	 * guard test fails if a refused key is hinted where the guide does not name
	 * it.
	 */
	consultationSectionOnly?: true;
	/**
	 * The control belongs to the Work queue section alone (ADR 0049, ADR
	 * 0052).
	 *
	 * The mirror of `consultationSectionOnly`: the key still resolves in the
	 * other base sections and states the owning section's refusal, but those
	 * sections' guides and bars name the control nowhere. The marker is the
	 * single place the ownership is written, so the dispatch, the guide, and
	 * the bar read the same words.
	 */
	queueSectionOnly?: true;
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
/** What the section toggle does with the section under the cursor. */
const SECTION_TOGGLE_NOTE = "collapses the section the cursor is in, or expands it back";

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
const workQueueMode = (mode: InteractionMode): boolean =>
	mode === "work-queue-list" || mode === "work-queue-detail";
const ticketBaseMode = (mode: InteractionMode): boolean =>
	mode === "ticket-list" || mode === "ticket-detail";
/**
 * The base modes of a section other than the Consultation section.
 *
 * The plane has three sections that share one list surface, and a control one
 * section owns answers nothing in the others: the key still resolves there and
 * states the owning section's refusal, but the guide and the Action bar of a
 * section that does not own it name it nowhere (issue #85, ADR 0034).
 */
const otherSectionMode = (mode: InteractionMode): boolean =>
	ticketBaseMode(mode) || workQueueMode(mode);
/** The Ticket section's refusal words, mirrored by ticketOnly. */
const TICKET_ONLY = "this control is available only in the Ticket section";
/**
 * The Work queue section's refusal words (ADR 0049, ADR 0052), the mirror of
 * the two that stand above: a key one section owns states the owning
 * section's refusal in the sections that do not own it.
 */
const QUEUE_ONLY = "this control is available only in the Work queue section";
/**
 * The Consultation section's refusal words, the mirror of TICKET_ONLY.
 *
 * availabilityFor states them for every Consultation-section control in the
 * Ticket base modes and in the Work queue's two, so the key the operator
 * already knows from the owning section refuses readably instead of doing
 * nothing at all.
 */
const CONSULTATION_ONLY = "this control is available only in the Consultation section";
/**
 * Why a Ticket-section control answers nothing in the Consultation section.
 *
 * The control stays a candidate in both sections so the key the operator
 * already knows states a readable refusal instead of doing nothing at all.
 */
const ticketOnly = (context: ControlContext): ControlAvailability =>
	ticketBaseMode(context.mode) ? available() : unavailable(TICKET_ONLY);
const listMove = (context: ControlContext): ControlAvailability =>
	context.mode === "override-list" ||
	context.mode === "override-model" ||
	context.mode === "override-text" ||
	context.listCanMove
		? available()
		: unavailable(
				consultationMode(context.mode)
					? "the Consultation list has nowhere to move"
					: workQueueMode(context.mode)
						? "the Work queue has nowhere to move"
						: "the Ticket list has nowhere to move",
			);
const detailScroll = (context: ControlContext): ControlAvailability =>
	context.detailCanScroll
		? available()
		: unavailable(
				context.mode === "consultation-detail"
					? "the Consultation detail has nowhere to scroll"
					: workQueueMode(context.mode)
						? "the Work queue detail has nowhere to scroll"
						: "the Ticket detail has nowhere to scroll",
			);
/**
 * Why the queue's order keys answer nothing (ADR 0049).
 *
 * `+` promotes the item under the cursor, `-` demotes it, the keys the
 * operator already knew for raising and lowering a rank. The queue order is
 * the order of work, so a move that would place the item where it already
 * stands refuses with the position's own fact, and an empty queue refuses
 * like the queue's other row keys.
 */
const queueOrderMove =
	(direction: "up" | "down") =>
	(context: ControlContext): ControlAvailability => {
		const item = context.selectedWorkQueueItem;
		if (item === null || item === undefined)
			return unavailable("no queue item is under the cursor");
		const depth = context.workQueueDepth ?? 0;
		if (direction === "up" && item.position > 0) return available();
		if (direction === "down" && item.position < depth - 1) return available();
		return unavailable(
			direction === "up" ? "the item is first in the queue" : "the item is last in the queue",
		);
	};
const queueRemove = (context: ControlContext): ControlAvailability =>
	context.selectedWorkQueueItem !== null && context.selectedWorkQueueItem !== undefined
		? available()
		: unavailable("no queue item is under the cursor");
/**
 * Why Enter answers a Work queue item with the force-dispatch (issue #89,
 * ADR 0034).
 *
 * The force-dispatch is the queue's only meaning of Enter, and it starts the
 * item now, over a full Parallel limit: every hard start check the pickup
 * runs still runs, only the cap is skipped. For a Handoff item, a Handoff
 * already in flight holds the shared environment seat, and the key refuses
 * rather than queue the item behind it, the way the Ticket section's Hand off
 * refuses the same fact. A cleanup that holds the seat while a Handoff does
 * not still lets the key through: the module parks the claim, and the item
 * leaves the queue when that parked start settles. A Consultation item runs
 * its own pickup seam and never parks on the herdr seat, so the refusal does
 * not reach it: a Consultation start stands while a Handoff is active, the
 * way a launcher submit does (ADR 0034, issue #90). An empty queue refuses
 * with the one reason the operator can act on, like the queue's other row
 * keys.
 */
const queueForceDispatch = (context: ControlContext): ControlAvailability => {
	const item = context.selectedWorkQueueItem;
	if (item === null || item === undefined) return unavailable("no queue item is under the cursor");
	if (item.kind === "handoff" && context.handoffActive) return unavailable("a Handoff is active");
	return available();
};
const refresh = (context: ControlContext): ControlAvailability => {
	if (consultationMode(context.mode))
		return context.consultationRefreshAvailable === true
			? available()
			: unavailable("Consultations require SQLite state");
	if (context.sourceCount === 0) return unavailable("no Ticket sources exist");
	if (context.refreshingSourceCount >= context.sourceCount)
		return unavailable("every Ticket source is already refreshing");
	return available();
};
/**
 * The one reason a closed record gives for any control that asks it to work.
 *
 * The close and the recovery control both refuse a `closed` Consultation, and
 * the two sentences must not drift: one fact, one string.
 */
const CONSULTATION_CLOSED_REASON = "the selected Consultation is already closed";
/**
 * Why Enter opens the recovery panel, and why it opens nothing elsewhere.
 *
 * One rule, stated per record state: Enter reaches the Agent or the response
 * on a live record, opens the surface the record needs on a broken or stuck
 * one, and says so on a closed one. A `closing` record is stuck mid-cleanup,
 * and its recovery is the close panel's own Retry and Force-close rows, so
 * this control answers for it too and its behavior sends it there.
 *
 * The live states carry a reason rather than staying silent because this is
 * the first `return` candidate in the Consultation section: a record whose
 * Agent cannot be reached at all resolves to no available meaning, and then
 * it is this sentence the operator reads.
 */
const consultationRecovery = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	if (
		consultation.state === "opening" ||
		consultation.state === "missing" ||
		consultation.state === "failed" ||
		consultation.state === "closing"
	)
		return available();
	if (consultation.state === "closed") return unavailable(CONSULTATION_CLOSED_REASON);
	// A `queued` record (ADR 0034, issue #90) has no Agent to reach: it waits
	// in the Work queue for a free seat, and the pickup is the only starter.
	if (consultation.state === "queued")
		return unavailable("the selected Consultation waits in the Work queue for a free seat");
	// An `unscheduled` record (issue #91) starts with Enter over the cap: the
	// start control owns that meaning, and its refusal stands here for the
	// guide's rows.
	if (consultation.state === "unscheduled")
		return unavailable(
			"the selected Consultation is unscheduled; Enter starts it now over the cap",
		);
	return unavailable("the selected Consultation reaches its Agent or its response with Enter");
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
/**
 * Why Goto answers nothing (ADR 0025): the Consultation needs a selected
 * row with an Agent pane the last herdr poll reported alive. Goto is
 * navigation: it focuses the pane and leaves the Consultation record
 * untouched.
 */
const consultationGoto = (context: ControlContext): ControlAvailability =>
	context.selectedConsultation?.paneId !== null &&
	context.selectedConsultation?.paneId !== undefined &&
	context.consultationPaneAlive === true
		? available()
		: unavailable("the Agent's pane is not alive in the last poll");
/**
 * Why Goto answers nothing on a Ticket (ADR 0033): the Ticket needs a
 * selected row with a handoff pane, an in-flight Ticket needs the Agent's
 * pane alive in the last herdr poll, and an `awaiting` Ticket keeps its
 * recorded pane. Goto is navigation: it focuses the pane and leaves the
 * Ticket, its work cycle, and its traces untouched.
 */
const ticketGoto = (context: ControlContext): ControlAvailability => {
	const ticket = context.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	const paneId = ticket.handoff?.paneId;
	if (paneId === null || paneId === undefined)
		return unavailable("the Agent's pane is not alive in the last poll");
	// The recorded pane stands for an awaiting Ticket, except when herdr has
	// handed the closed pane's id out again: the live agent in the pane that
	// is not the Ticket's own is not the agent the operator went to look at.
	if (ticket.state === "awaiting")
		return context.ticketPaneForeign === true
			? unavailable("the Agent's pane is not alive in the last poll")
			: available();
	if (
		(ticket.state === "handed-off" || ticket.state === "running") &&
		context.ticketPaneAlive === true
	)
		return available();
	return unavailable("the Agent's pane is not alive in the last poll");
};
/**
 * Why Close answers nothing on a Ticket (ADR 0031). Key `w` ends the work
 * cycle of the selected Ticket, in both Ticket base modes. An `open` Ticket
 * holds no work in flight, so the close refuses it with that reason; every
 * state the close runs on - `handed-off`, `running`, and `awaiting` - has a
 * live agent or a settled turn behind it, and both open the confirmation
 * dialog before anything moves.
 *
 * A Handoff in flight is no refusal here: the close takes the shared
 * environment seat and queues behind that Handoff, so a hung start still ends
 * in the close the operator asked for (ADR 0031).
 */
const ticketClose = (context: ControlContext): ControlAvailability => {
	const ticket = context.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (ticket.state === "open")
		return unavailable("the selected Ticket is open: no work is in flight to close");
	return available();
};
const consultationClose = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	return consultation.state === "closed" ? unavailable(CONSULTATION_CLOSED_REASON) : available();
};
/**
 * Why Delete answers nothing (issue #91).
 *
 * A `closed` record's history is removable, and an `unscheduled` record is
 * the ask itself: it holds no environment and no Agent, so deleting it
 * removes the record and nothing else. Every other state still runs - the
 * close or the recovery answers the key - and the delete refuses it.
 */
const consultationDelete = (context: ControlContext): ControlAvailability => {
	const state = context.selectedConsultation?.state;
	if (state === "closed" || state === "unscheduled") return available();
	return unavailable("only a closed or unscheduled Consultation can be deleted");
};
/**
 * Why Schedule answers nothing (issue #91).
 *
 * `s` puts an `unscheduled` Consultation back into the Work queue, at its
 * tail: the record the queue's pickup takes when a seat frees. Every other
 * state refuses the key with the state's own fact, so a record that is
 * started, waiting, or broken never silently re-enters the queue.
 */
const consultationSchedule = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	if (consultation.state === "unscheduled") return available();
	if (consultation.state === "queued")
		return unavailable("the selected Consultation already waits in the Work queue");
	if (consultation.state === "closed") return unavailable(CONSULTATION_CLOSED_REASON);
	return unavailable("only an unscheduled Consultation can be scheduled");
};
/**
 * Why Start now answers nothing (issue #91).
 *
 * Enter starts an `unscheduled` Consultation now, over the Parallel limit,
 * the Consultation's face of the queue's force-dispatch: every start check
 * the pickup runs still runs, only the cap is skipped. A `queued` record's
 * start is the Work queue's pickup, and a started or broken record reaches
 * its Agent or its recovery with Enter instead.
 */
const consultationStartNow = (context: ControlContext): ControlAvailability => {
	const consultation = context.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	if (consultation.state === "unscheduled") return available();
	if (consultation.state === "queued")
		return unavailable("the selected Consultation waits in the Work queue for a free seat");
	return unavailable("only an unscheduled Consultation can be started now");
};
const activeQuit = (context: ControlContext): ControlAvailability =>
	context.handoffActive ? unavailable("normal Quit is unavailable during a Handoff") : available();
const message = (context: ControlContext): ControlAvailability =>
	context.messageTruncated
		? available()
		: unavailable("the current Message fits on the Message line");
/**
 * Why the body's scroll answers nothing (ADR 0039).
 *
 * The control is gated on the facts: unavailable, with a stated reason, when
 * the body already fills the pane's window or carries nothing, so the Action
 * bar never hints a scroll that cannot run and a pressed key says why.
 */
const bodyScroll = (context: ControlContext): ControlAvailability => {
	if (context.bodyEmpty === true) return unavailable("the body carries no rows");
	if (context.bodyScrollable === false) return unavailable("the body fills its pane");
	return available();
};

const ticketBaseModes = ["ticket-list", "ticket-detail"] as const;
const consultationBaseModes = ["consultation-list", "consultation-detail"] as const;
const workQueueBaseModes = ["work-queue-list", "work-queue-detail"] as const;
const baseModes = [...ticketBaseModes, ...consultationBaseModes, ...workQueueBaseModes] as const;
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
	"live-view",
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
						: mode === "work-queue-list"
							? ["up", "down", "j", "k", "pageup", "pagedown", "home", "end"]
							: ["up", "down", "tab"],
		keyLabel: "↑↓/jk",
		scope: "control-plane",
		actionBar: true,
		priority: 80,
		modes: [
			"ticket-list",
			"consultation-list",
			"work-queue-list",
			"override-list",
			"override-model",
			"override-text",
		],
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
		modes: ["ticket-list", "consultation-list", "work-queue-list"],
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
		modes: ["ticket-detail", "consultation-detail", "work-queue-detail"],
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
		availability: available,
	},
	{
		// The same pane navigation, named for the section that owns it. Left
		// returns to the Work queue's list (ADR 0034).
		id: "queue-list",
		label: "List",
		keys: () => ["left", "h"],
		keyLabel: "←/h",
		scope: "work-queue-detail",
		actionBar: true,
		priority: 75,
		modes: ["work-queue-detail"],
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
		// Enter on a waiting row jumps to its queue item (ADR 0049): the row
		// under the cursor in the Ticket or Consultation list holds a waiting
		// start, and the cursor moves to the item in the Work queue, where the
		// queue's keys act on it. It resolves ahead of the other Enter meanings
		// while the row waits, so the start the operator is about to make is
		// the one the cursor lands on. The detail panes keep their own keys.
		id: "queue-jump",
		label: "Queue item",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 71,
		modes: ["ticket-list", "consultation-list"],
		availability: (context) =>
			context.queueItemForSelectedRow !== null && context.queueItemForSelectedRow !== undefined
				? available()
				: unavailable("the selected row has no waiting queue item"),
		guideNote: "jumps to the row's waiting item in the Work queue",
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
		id: "ticket-goto",
		label: "Goto",
		// `g` focuses the Agent's pane in herdr from either Ticket pane, the
		// way `g` does from either Consultation pane, and changes nothing
		// (ADR 0033).
		keys: () => ["g"],
		keyLabel: "g",
		scope: "control-plane",
		actionBar: true,
		// Below the Enter meanings, above Override: navigation outranks the
		// re-read and the one-shot setting, the way it does in the
		// Consultation section.
		priority: 68,
		modes: [...ticketBaseModes],
		availability: ticketGoto,
	},
	{
		id: "ticket-close",
		label: "Close",
		// `w` ends the selected Ticket's work cycle from either Ticket pane,
		// behind the shared confirmation panel, the way the Consultation section's
		// Close asks (ADR 0031). The Decision modal keeps its Close row: it is the
		// close with the turn log beside it, and `w` is the direct route to that
		// same action.
		keys: () => ["w"],
		keyLabel: "w",
		scope: "control-plane",
		actionBar: true,
		// One ladder place with the Consultation section's Close: below Goto and
		// the re-read, above the section toggle and the Launch.
		priority: 50,
		modes: [...ticketBaseModes],
		availability: ticketClose,
	},
	{
		id: "section-toggle",
		label: "Section",
		// `x` collapses the section the cursor is in, or expands it back. The
		// sections stay visible as long as the frame can hold them, so the
		// toggle is a matter of room, not of access.
		keys: () => ["x"],
		keyLabel: "x",
		scope: "control-plane",
		actionBar: true,
		priority: 45,
		modes: [...baseModes],
		availability: available,
		guideNote: SECTION_TOGGLE_NOTE,
	},
	{
		// The queue's order keys (ADR 0049): `+` (or `=`, its unshifted form)
		// promotes the item under the cursor, `-` demotes it, the keys the
		// operator already knew for raising and lowering a rank. `u` and `d`
		// are gone, so the queue has one key system. Reordering never changes
		// an item's captured choice.
		id: "queue-promote",
		label: "Promote",
		keys: () => ["=", "+"],
		keyLabel: "+",
		scope: "work-queue-list",
		actionBar: true,
		priority: 60,
		modes: [...baseModes],
		queueSectionOnly: true,
		availability: queueOrderMove("up"),
		guideNote: "moves the item toward the front of the queue",
	},
	{
		id: "queue-demote",
		label: "Demote",
		keys: () => ["-"],
		keyLabel: "-",
		scope: "work-queue-list",
		actionBar: true,
		priority: 59,
		modes: [...baseModes],
		queueSectionOnly: true,
		availability: queueOrderMove("down"),
		guideNote: "moves the item toward the back of the queue",
	},
	{
		// `p` pauses the Work queue's drain (ADR 0052): the pickup takes no
		// item and the top-up adds none while it stands, and the force-dispatch
		// passes it the way it passes the cap. The key takes no other meaning
		// in the plane, so the queue section claims it outright, and the other
		// sections refuse it in the catalogue's words.
		id: "queue-pause",
		label: "Pause queue",
		barLabel: (context) => (context.queuePaused === true ? "Resume queue" : "Pause queue"),
		keys: () => ["p"],
		keyLabel: "p",
		scope: "work-queue-list",
		actionBar: true,
		priority: 58,
		modes: [...baseModes],
		queueSectionOnly: true,
		availability: available,
		guideNote: "pauses the queue's drain; the force-dispatch passes it",
	},
	{
		id: "queue-remove",
		label: "Remove",
		keys: () => ["delete"],
		keyLabel: "Delete",
		scope: "work-queue-list",
		actionBar: true,
		priority: 55,
		modes: ["work-queue-list"],
		availability: queueRemove,
	},
	{
		// Enter on a queue row force-dispatches the item under the cursor
		// (issue #89, ADR 0034): the start runs now, over a full Parallel
		// limit, and the dispatch module owns the claim, the row, and every
		// line the start or its failure leaves.
		id: "queue-force-dispatch",
		label: "Force-dispatch",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "work-queue-list",
		actionBar: true,
		// Below the queue's row keys, at the primary-action rung the other
		// sections give their Enter meaning: the bar's packing order stays
		// total.
		priority: 70,
		modes: ["work-queue-list"],
		availability: queueForceDispatch,
		guideNote: "starts the item over a full Parallel limit; a failure leaves the queue",
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
		modes: [...baseModes],
		availability: available,
		// A Consultation-section control: in the Ticket section the key states
		// the section refusal, and the Ticket guide and bar omit the control.
		consultationSectionOnly: true,
	},
	{
		id: "consultation-close",
		label: "Close",
		// `w` closes the Consultation: `x` is the shared section toggle.
		keys: () => ["w"],
		keyLabel: "w",
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
		modes: [...baseModes],
		availability: consultationDelete,
		// A Consultation-section control: in the Ticket section the key states
		// the section refusal, and the Ticket guide and bar omit the control.
		consultationSectionOnly: true,
		guideNote: "removes a closed or unscheduled record and its history",
	},
	{
		// `s` schedules an `unscheduled` Consultation back into the Work queue
		// (issue #91): the record returns to `queued` at the queue's tail, and
		// the pickup is the only starter, the way the launcher's submit is.
		id: "consultation-schedule",
		label: "Schedule",
		keys: () => ["s"],
		keyLabel: "s",
		scope: "control-plane",
		actionBar: true,
		priority: 52,
		modes: [...consultationBaseModes],
		availability: consultationSchedule,
		// A Consultation-section control: the section that does not own it
		// states the section refusal and names it nowhere.
		consultationSectionOnly: true,
		guideNote: "puts the unscheduled Consultation back into the Work queue",
	},
	{
		id: "consultation-recovery",
		label: "Recovery",
		// Enter answers a broken or stuck Consultation with the surface its
		// state needs. It is cataloged ahead of Respond and Interact on purpose:
		// a live record resolves to those, because an available meaning outranks
		// an unavailable one, and a record with no meaning at all reads this
		// control's reason.
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		priority: 70,
		modes: [...consultationBaseModes],
		availability: consultationRecovery,
		// The Key guide names what this meaning of Enter is for, so a row that
		// only says "Recovery" cannot be taken for the `r` recovery of an
		// interrupted opening.
		guideNote: "opens the recovery surface a broken or stuck Consultation needs",
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
		// Enter starts an `unscheduled` Consultation now (issue #91): the
		// pickup seam with the cap skipped, the Consultation section's face of
		// the queue's force-dispatch. The record's own progress line takes
		// over from the start. It is cataloged after the other Enter meanings,
		// so a record with no Enter meaning at all still reads Recovery's
		// reason, and the start is found wherever its record stands.
		id: "consultation-start-now",
		label: "Start now",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		// The primary-action rung the other sections give their Enter meaning:
		// it is available only where their Enter meanings are not.
		priority: 70,
		modes: [...consultationBaseModes],
		availability: consultationStartNow,
		consultationSectionOnly: true,
		guideNote: "starts the unscheduled Consultation over the Parallel limit",
	},
	{
		id: "consultation-goto",
		label: "Goto",
		// `g` focuses the Agent's pane in herdr from either Consultation pane,
		// the way `g` does on a Ticket row, and changes nothing.
		keys: () => ["g"],
		keyLabel: "g",
		scope: "control-plane",
		actionBar: true,
		// Below Interact, above Refresh: navigation is worth the row's space
		// more than a re-read, less than reaching the Agent itself.
		priority: 68,
		modes: [...consultationBaseModes],
		availability: consultationGoto,
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
		id: "recover",
		label: "Recover",
		// `r` names the recovery an interrupted opening needs, and stays Refresh
		// for every other Consultation row.
		keys: () => ["r"],
		keyLabel: "r",
		scope: "control-plane",
		actionBar: true,
		priority: 61,
		modes: [...consultationBaseModes],
		availability: (context) =>
			context.selectedConsultation?.state === "opening"
				? available()
				: unavailable("only an interrupted opening needs recovery"),
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
		keys: (mode) =>
			ticketBaseMode(mode) || consultationMode(mode) || workQueueMode(mode) ? ["m", "f2"] : ["f2"],
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
		// The region's range rides the bar behind this hint, the way the Key
		// guide and the Message view already use the range anchor.
		rangeAnchor: true,
		priority: 80,
		modes: [...modalModes, "action-panel"],
		// A selection in a region that holds one row goes nowhere: the same
		// rule the form's selector already uses for a cycle with no other
		// value, and the reason lands on the Message line.
		availability: (context) =>
			context.actionRowCount === 1 ? unavailable("the region holds one row") : available(),
	},
	{
		id: "scroll-body",
		label: "Scroll body",
		// The page and jump keys are aliases of the same scroll: they are
		// accepted, and the j/k hint is the one the bar and guide show. The
		// body it scrolls may be the Agent view and not the Turn log
		// (ADR 0039), so it carries the shared name.
		keys: () => ["j", "k", "pageup", "pagedown", "home", "end"],
		keyLabel: "j/k",
		scope: "modal",
		actionBar: true,
		priority: 75,
		modes: ["decision-modal", "live-view"],
		availability: bodyScroll,
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
		modes: [...modalModes, "action-panel", "live-view"],
		availability: available,
	},
	{
		// Enter in the Live view's streaming sub-mode is the Goto: pure focus,
		// the same navigation the Ticket section runs on `g` (ADR 0033), and
		// the row it confirms on the decision sub-mode is the decision's own
		// Goto row. A turn settling under the open view stays a live view
		// until the factory leaves the decision to the operator, so the pane
		// fact the Ticket Goto gates on is the gate here too.
		id: "live-goto",
		label: "Goto",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "modal",
		actionBar: true,
		priority: 70,
		modes: ["live-view"],
		availability: (context) => ticketGoto(context),
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

/** Every control the mode dispatches a key for, in the catalogue's order. */
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
			!omitFromOtherSection(mode, control) &&
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
	f: "f",
	x: "x",
	d: "d",
	r: "r",
	a: "a",
	m: "m",
	c: "c",
	s: "s",
	p: "p",
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
	// the key and supplies its stable unavailable reason - the queue jump
	// excepted: a row that holds no waiting item has no jump to refuse, so it
	// never masks the mode's own Enter reason.
	return (
		candidates.find((control) => availabilityFor(control, context).available) ??
		candidates.find((control) => control.id !== "queue-jump") ??
		candidates[0]
	);
}

export function availabilityFor(
	control: ControlDefinition,
	context: ControlContext,
): ControlAvailability {
	// A Consultation-section control states the section refusal in every other
	// section's modes: the Ticket section and the Work queue both answer the key
	// with the owning section's words. The marker is the single place the
	// ownership is written, so the dispatch, the guide, and the bar all read the
	// same words. The Work queue's own keys state their refusal in the same
	// way (ADR 0049, ADR 0052).
	if (control.consultationSectionOnly === true && otherSectionMode(context.mode))
		return unavailable(CONSULTATION_ONLY);
	if (control.queueSectionOnly === true && !workQueueMode(context.mode))
		return unavailable(QUEUE_ONLY);
	return control.availability(context);
}

/** Ticket-section controls have no useful meaning in a Consultation guide. */
function omitFromGuide(mode: InteractionMode, control: ControlDefinition): boolean {
	if (
		consultationMode(mode) &&
		control.scope !== "global" &&
		(control.scope === "control-plane" ||
			control.scope === "ticket-list" ||
			control.scope === "ticket-detail") &&
		!control.modes.some(consultationMode)
	)
		return true;
	// The Work queue's own keys stay out of the other sections' guides
	// (ADR 0034): each section's guide names the keys it dispatches, and the
	// queue's reorder, cancel, and list-focus keys belong to the queue alone.
	return (
		!workQueueMode(mode) &&
		(control.scope === "work-queue-list" || control.scope === "work-queue-detail")
	);
}

/**
 * Whether a section other than a control's own omits it from its guide and
 * its bar.
 *
 * Delete and History keep their catalog place in the Consultation section
 * alone (issue #85), and the queue's order and pause keys keep theirs in the
 * Work queue section alone (ADR 0049, ADR 0052): a key still resolves in the
 * sections that do not own the control and refuses there, in the catalogue's
 * words, but those sections name the control nowhere, and the bar hints no
 * key its guide omits. The rule reads each section marker against the modes
 * that do not own it, so a future section-only key is omitted from the same
 * two places at once (ADR 0034 widened the base modes with the Work queue's
 * two).
 */
function omitFromOtherSection(mode: InteractionMode, control: ControlDefinition): boolean {
	return (
		(otherSectionMode(mode) && control.consultationSectionOnly === true) ||
		(!workQueueMode(mode) && control.queueSectionOnly === true)
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
 * control of this mode, so neither the bar nor the guide may name it. The one
 * exception is a key that carries only the other section's refusal: a
 * Consultation-section control refuses in the Ticket base modes and in the
 * Work queue's two, and those sections name it in neither their guide nor
 * their bar (issue #85, ADR 0034).
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
			!omitFromOtherSection(mode, control) &&
			isCataloguedInMode(mode, control, context),
	);
	const seen = new Set(current.map((control) => control.id));
	const append = (group: string, predicate: (control: ControlDefinition) => boolean) =>
		CONTROL_DEFINITIONS.filter(
			(control) =>
				!seen.has(control.id) &&
				control.guideOnly !== true &&
				!omitFromGuide(mode, control) &&
				!omitFromOtherSection(mode, control) &&
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
		case "work-queue-list":
			return "Work queue list";
		case "work-queue-detail":
			return "Work queue detail";
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
		case "live-view":
			return "Live view";
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
		if (ticketBaseMode(mode) || consultationMode(mode) || workQueueMode(mode))
			return includeAllAliases ? "F1/?" : "?";
	}
	if (control.id === "message") {
		if (ticketBaseMode(mode) || consultationMode(mode) || workQueueMode(mode))
			return includeAllAliases ? "m/F2" : "m";
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
