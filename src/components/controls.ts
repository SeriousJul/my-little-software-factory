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
import type { GroupingAxis } from "../domain/grouping.ts";
import type { Ticket, TicketListFilter, TicketMarker } from "../domain/ticket.ts";
import { ignoreRefusal, nextTicketListFilter, obligationOf } from "../domain/ticket.ts";
import { inFlight } from "../domain/ticket-facts.ts";
import type { Consultation } from "../state/consultation-record.ts";
import type { WorkQueueItem } from "../state/work-queue.ts";
import type { GroupHeader } from "./shared/grouping.ts";
import { groupingAxisHint } from "./shared/grouping.ts";
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
	/** The modal that selects the repository to init (ADR 0082). */
	| "repository-select"
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
	| "space"
	| "j"
	| "k"
	| "h"
	| "l"
	| "q"
	| "e"
	| "r"
	| "a"
	| "m"
	| "o"
	| "c"
	| "f"
	| "i"
	| "g"
	| "s"
	| "p"
	| "x"
	| "d"
	| "w"
	| "u"
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

/**
 * The plane's standing facts.
 *
 * Every Interaction mode reads these, and no surface restates them: one
 * record of them is read the same way in every mode, and the constructor
 * below places it in every mode's facts.
 */
export interface StandingFacts {
	/**
	 * True while a Handoff holds the seat. The fact the normal Quit gates on
	 * (ADR 0064): the ask controls no longer wait on a run, and the Quit is
	 * the one control that tears the process down mid-run.
	 */
	handoffActive: boolean;
	/**
	 * Whether the run's Message history holds an entry (ADR 0119): the fact the
	 * Message control gates on, with the truncation fact gone in its place.
	 */
	messageRecorded: boolean;
	/** Whether the config defines any [consultation-types.<name>] block. */
	consultationTypesConfigured: boolean;
	sourceCount: number;
	refreshingSourceCount: number;
	/** The configured key that leaves Agent interaction mode. */
	interactionExitKey: string;
	/**
	 * The Queue pause (ADR 0052, ADR 0111): the operator's brake on the Work
	 * queue's drain. It is a standing fact because the control every mode
	 * dispatches must read a fact every mode states, and a missing one is a
	 * compile error: the surfaces that state the facts fill it from the queue
	 * module's one read, the way the other standing facts do.
	 */
	queuePaused: boolean;
}

/**
 * The facts the Ticket section's list pane states for its own cursor.
 *
 * The Group facts come from the shared grouping module's row list, so the
 * position, the count, and the fold read the same rows the list draws and the
 * step walks (issue #159, ADR 0071).
 */
export interface TicketListFacts extends StandingFacts {
	mode: "ticket-list";
	/** The Ticket the base panes point at, if the list holds one. */
	selectedTicket: Ticket | undefined;
	/**
	 * The Grouping axis in effect for the Ticket section's list (issue #159).
	 *
	 * The shell states it from the factory state it read at boot and the press
	 * that moved it, and the axis control's hint names it, so the operator never
	 * has to infer the split from the rows.
	 */
	groupingAxis: GroupingAxis;
	/**
	 * The Group header the Ticket cursor stands on, or null when it stands on a
	 * Ticket row (issue #159).
	 *
	 * The list states it from the row under the cursor, and the fold control
	 * gates on it: `Space` folds the Group under a header and answers nothing
	 * anywhere else, and the Action bar names the key the facts under the
	 * cursor run.
	 */
	selectedGroupHeader: GroupHeader | null;
	/**
	 * Whether the Ticket cursor stands on a Group header (issue #159).
	 *
	 * No Ticket is selected there, so every Ticket control refuses with the
	 * catalogue's own words, and the fold control takes the `Space` key.
	 */
	groupHeaderSelected: boolean;
	/**
	 * The position of the Group under the cursor among the visible Group
	 * headers, zero-based, and their count beside it (ADR 0071).
	 *
	 * The move control gates on both: a Group at the top of its axis has no
	 * visible neighbor above to trade places with, and the catalogue states
	 * that refusal in its own words, the way the queue's order keys do.
	 */
	selectedGroupPosition: number;
	visibleGroupHeaderCount: number;
	/**
	 * The failure marker the last poll set on the selected Ticket (ADR 0060):
	 * the same fact the list row's failure badge wears. The ignore's obligation
	 * predicate reads it, because a missing Agent is not a Ticket state, and the
	 * refusal must name what the row's own face names.
	 */
	selectedTicketMarker: TicketMarker | null;
	/**
	 * The Ticket section's List filter (ADR 0060): the `f` hint names the state
	 * the cycle moves to, so the bar reads the filter that stands.
	 */
	ticketListFilter: TicketListFilter;
	/**
	 * Whether the selected Ticket's Agent pane is alive in the last herdr
	 * poll. Goto focuses that pane, so an in-flight Ticket needs it (ADR 0033).
	 */
	ticketPaneAlive: boolean;
	/**
	 * Whether the selected Ticket's recorded pane holds a live agent that is
	 * not the Ticket's own. Herdr hands the id of a closed pane out again, so
	 * the recorded pane of an awaiting Ticket can name a pane a different
	 * agent owns, and Goto must not focus it there (ADR 0033's recorded-pane
	 * standing gives way to the agent's identity).
	 */
	ticketPaneForeign: boolean;
	listCanMove: boolean;
	/**
	 * The Work queue item the row under the cursor waits with (ADR 0049): Enter
	 * on such a row jumps to the item instead of starting or deciding.
	 */
	queueItemForSelectedRow: WorkQueueItem | null;
}

/** The facts the Ticket section's detail pane states for its own Body. */
export interface TicketDetailFacts extends StandingFacts {
	mode: "ticket-detail";
	selectedTicket: Ticket | undefined;
	groupingAxis: GroupingAxis;
	selectedGroupHeader: GroupHeader | null;
	groupHeaderSelected: boolean;
	selectedGroupPosition: number;
	visibleGroupHeaderCount: number;
	selectedTicketMarker: TicketMarker | null;
	ticketListFilter: TicketListFilter;
	ticketPaneAlive: boolean;
	ticketPaneForeign: boolean;
	detailCanScroll: boolean;
}

/** Whether the Consultation section can re-read its durable projection. */
export interface ConsultationSectionFacts {
	/** The Consultation the base panes point at, if the list holds one. */
	selectedConsultation: Consultation | undefined;
	/** Whether the Consultation section can re-read its durable projection. */
	consultationRefreshAvailable: boolean;
	/** The observed status of the selected Consultation Agent. */
	consultationAgentStatus: string | null;
	/**
	 * Whether the selected Consultation's Agent pane is alive in the last
	 * herdr poll. Goto focuses that pane, so it needs it.
	 */
	consultationPaneAlive: boolean;
}

/** The facts the Consultation section's list pane states for its own cursor. */
export interface ConsultationListFacts extends StandingFacts, ConsultationSectionFacts {
	mode: "consultation-list";
	listCanMove: boolean;
	/**
	 * The Work queue item the row under the cursor waits with (ADR 0049): Enter
	 * on such a row jumps to the item instead of starting or deciding.
	 */
	queueItemForSelectedRow: WorkQueueItem | null;
}

/** The facts the Consultation section's detail pane states for its own Body. */
export interface ConsultationDetailFacts extends StandingFacts, ConsultationSectionFacts {
	mode: "consultation-detail";
	detailCanScroll: boolean;
}

/**
 * The facts the Work queue module states for its own rows.
 *
 * The item under the cursor and the queue's depth come from the queue itself,
 * so the queue's keys cannot disagree with the queue (ADR 0034). The queue
 * pause stands in the plane's standing facts (ADR 0111): it is the fact a
 * control every mode dispatches reads.
 */
export interface WorkQueueSectionFacts {
	/**
	 * The Work queue's item under the cursor (ADR 0034). The item's own position
	 * is the queue order's.
	 */
	selectedWorkQueueItem: WorkQueueItem | null;
	/** The queue's depth: the items it holds. */
	workQueueDepth: number;
}

/** The facts the Work queue's list pane states for its own cursor. */
export interface WorkQueueListFacts extends StandingFacts, WorkQueueSectionFacts {
	mode: "work-queue-list";
	listCanMove: boolean;
}

/** The facts the Work queue's detail pane states for its own Body. */
export interface WorkQueueDetailFacts extends StandingFacts, WorkQueueSectionFacts {
	mode: "work-queue-detail";
	detailCanScroll: boolean;
}

/**
 * The facts the override panel's list row states.
 *
 * The panel owns no list the plane's cursor could run out of: its mode follows
 * the row the cursor is on, and `move-list` answers for it before any step
 * fact, so this row states nothing beside the plane's standing facts.
 */
export interface OverrideListFacts extends StandingFacts {
	mode: "override-list";
}

/** The facts the override panel's Model row states. */
export interface OverrideModelFacts extends StandingFacts {
	mode: "override-model";
	/** The focused field has a text selection the Copy control could hand over. */
	fieldHasSelection: boolean;
}

/** The facts the override panel's free-text row states. */
export interface OverrideTextFacts extends StandingFacts {
	mode: "override-text";
	fieldHasSelection: boolean;
}

/**
 * The facts a shared form states while its field holds the focus.
 *
 * A form owns one keyboard rule per slot, and the slot's own facts are the
 * form module's to state (ADR 0014). Each slot's record names only what that
 * slot's controls read: the field's Copy control, the selector's cycle, and
 * the action's Confirm each state their own fact and nothing beside it.
 */
export interface FormFieldFacts extends StandingFacts {
	mode: "form-field";
	/** The focused field holds a text selection the Copy control could hand over. */
	fieldHasSelection: boolean;
}

/** The facts a shared form states while its selector holds the focus. */
export interface FormSelectorFacts extends StandingFacts {
	mode: "form-selector";
	/** The focused slot holds a text selection the Copy control could hand over. */
	fieldHasSelection: boolean;
	/** How many values the focused selector offers. One of them cycles nowhere. */
	formCycleCount: number;
}

/** The facts a shared form states while its action holds the focus. */
export interface FormActionFacts extends StandingFacts {
	mode: "form-action";
	/** The focused slot holds a text selection the Copy control could hand over. */
	fieldHasSelection: boolean;
	/** Why the form's Confirm action cannot run, in the surface's own words. */
	formRefusal: string | null;
}

/**
 * The facts the Decision modal states for its own regions.
 *
 * The Decision region's row count and the Body pane's window come from the
 * shared region module, the one that owns the rows they count (ADR 0039).
 */
export interface DecisionModalFacts extends StandingFacts {
	mode: "decision-modal";
	/**
	 * The rows the surface's Decision region holds.
	 *
	 * The surface states it from its own rows, and the catalogue refuses the
	 * region's selection when the region holds one row, on the same rule the
	 * form's selector already uses for a cycle that goes nowhere.
	 */
	actionRowCount: number;
	/**
	 * Whether the surface's Body pane scrolls: the body holds more rows than
	 * its window. The surface states it from its own rows, and the catalogue
	 * gates the body's scroll on it, so the bar never hints a scroll that
	 * cannot run (ADR 0039).
	 */
	bodyScrollable: boolean;
	/** Whether the surface's Body pane carries nothing at all. */
	bodyEmpty: boolean;
	/**
	 * The decision modal's row under the cursor carries settings to edit.
	 *
	 * The modal states it from its own rows; the catalogue stays the single
	 * gate, the bar stays the single display, and neither special-cases the
	 * `e` key by control id.
	 */
	editableActionSelected: boolean;
	/**
	 * The decision modal's row under the cursor asks for the plane action, which
	 * holds no settings to edit (ADR 0068): the surface states it from its own
	 * rows, and the catalogue keeps the one gate with the reason it names.
	 */
	planeActionSelected: boolean;
}

/** The facts the Missing agent modal states for its own rows. */
export interface MissingModalFacts extends StandingFacts {
	mode: "missing-modal";
	actionRowCount: number;
}

/** The facts the shared action panel states for its own rows. */
export interface ActionPanelFacts extends StandingFacts {
	mode: "action-panel";
	actionRowCount: number;
}

/** The facts the Live view states for its own Body pane and its own Ticket. */
export interface LiveViewFacts extends StandingFacts {
	mode: "live-view";
	/** The Ticket the Live view streams. The Goto focuses that Ticket's pane. */
	selectedTicket: Ticket | undefined;
	ticketPaneAlive: boolean;
	ticketPaneForeign: boolean;
	bodyScrollable: boolean;
	bodyEmpty: boolean;
}

/** The facts the init's repository select list states for its own rows (ADR 0082). */
export interface RepositorySelectFacts extends StandingFacts {
	mode: "repository-select";
	listCanMove: boolean;
	/**
	 * The count of repositories in the init's select list (ADR 0082).
	 *
	 * The confirm control reads the fact: while the list is loading or holds
	 * nothing, Enter is refused in the catalogue's words.
	 */
	repositoryCount: number;
	/** The text of the init's select list's search (ADR 0082). */
	searchText: string;
	/**
	 * The count of rows the operator marked for the init queue (ADR 0083).
	 *
	 * The confirm control reads the fact: a marking of two or more names the
	 * queue on the bar, because Enter then starts it instead of selecting one.
	 */
	pendingCount: number;
}

/** The facts the Key guide states. It owns no rows, so it states none. */
export interface KeyGuideFacts extends StandingFacts {
	mode: "key-guide";
}

/**
 * The facts the Message view states. Its body is the shared Body pane over the
 * run's history, so it states the pane's window beside the standing facts,
 * the way the Decision modal and the Live view do.
 */
export interface MessageViewFacts extends StandingFacts {
	mode: "message-view";
	bodyScrollable: boolean;
	bodyEmpty: boolean;
}

/** The facts Agent interaction mode states. The Agent owns every other key. */
export interface ConsultationInteractionFacts extends StandingFacts {
	mode: "consultation-interaction";
}

/**
 * The Availability facts, stated per Interaction mode.
 *
 * One record per mode, holding only the facts that mode's controls read. Every
 * fact in a record is required, so an availability rule never answers from an
 * absence. A record is the plane's standing facts plus the facts the surface
 * that owns the mode states; `availabilityFacts` is the one constructor.
 */
export interface ModeFacts {
	"ticket-list": TicketListFacts;
	"ticket-detail": TicketDetailFacts;
	"consultation-list": ConsultationListFacts;
	"consultation-detail": ConsultationDetailFacts;
	"work-queue-list": WorkQueueListFacts;
	"work-queue-detail": WorkQueueDetailFacts;
	"override-list": OverrideListFacts;
	"override-model": OverrideModelFacts;
	"override-text": OverrideTextFacts;
	"form-field": FormFieldFacts;
	"form-selector": FormSelectorFacts;
	"form-action": FormActionFacts;
	"action-panel": ActionPanelFacts;
	"decision-modal": DecisionModalFacts;
	"missing-modal": MissingModalFacts;
	"repository-select": RepositorySelectFacts;
	"live-view": LiveViewFacts;
	"key-guide": KeyGuideFacts;
	"message-view": MessageViewFacts;
	"consultation-interaction": ConsultationInteractionFacts;
}

/** The facts of one Interaction mode, as the catalogue reads them. */
export type AvailabilityFacts = ModeFacts[InteractionMode];

/** `Omit` that keeps each member of a union a member, not one merged record. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The facts a surface states for one mode, beside the plane's standing facts. */
export type OwnFacts<M extends InteractionMode> = DistributiveOmit<
	ModeFacts[M],
	"mode" | keyof StandingFacts
>;

/**
 * The one constructor of the Availability facts.
 *
 * A surface names its mode, hands over the plane's standing facts it reads
 * without restating them, and states exactly the facts its mode names. A
 * missing one is a compile error, so no control can read an absence.
 */
export function availabilityFacts<M extends InteractionMode>(
	mode: M,
	standing: StandingFacts,
	own: OwnFacts<M>,
): ModeFacts[M] {
	// The one assertion in the facts' interface. The compiler checks both sides
	// of every call - the mode, the standing record, and the exact own-facts
	// record that mode names - and this body only places the three pieces
	// beside each other. It cannot prove to itself that the union of every
	// mode's record equals the record of one mode chosen at the call.
	return { ...standing, ...own, mode } as unknown as ModeFacts[M];
}

/** The Ticket section's two modes. */
type TicketBaseFacts = TicketListFacts | TicketDetailFacts;
/** The Consultation section's two modes. */
type ConsultationBaseFacts = ConsultationListFacts | ConsultationDetailFacts;
/** The Work queue's two modes. */
type WorkQueueBaseFacts = WorkQueueListFacts | WorkQueueDetailFacts;
/** The Main view's six base modes. */
type BaseFacts = TicketBaseFacts | ConsultationBaseFacts | WorkQueueBaseFacts;
/** The override panel's three row modes. */
type OverrideFacts = OverrideListFacts | OverrideModelFacts | OverrideTextFacts;
/** The three modes one shared form runs. */
type FormFacts = FormFieldFacts | FormSelectorFacts | FormActionFacts;
/** The modes that show action rows in a Decision region. */
type ActionRegionFacts = DecisionModalFacts | MissingModalFacts | ActionPanelFacts;
/** The modes whose surface owns a Body pane. */
type BodyPaneFacts = DecisionModalFacts | LiveViewFacts | MessageViewFacts;
/** The modes that own a list the cursor steps through. */
type ListFacts =
	| TicketListFacts
	| ConsultationListFacts
	| WorkQueueListFacts
	| OverrideListFacts
	| OverrideModelFacts
	| OverrideTextFacts
	| RepositorySelectFacts;
/** The modes that own a detail pane the cursor scrolls. */
type DetailFacts = TicketDetailFacts | ConsultationDetailFacts | WorkQueueDetailFacts;
/** The modes the `Enter`-on-a-waiting-row meaning runs in. */
type QueueJumpFacts = TicketListFacts | ConsultationListFacts;
/** The modes the Hand off control runs in. */
type HandoffFacts = TicketBaseFacts | OverrideFacts;
/** The modes the Ticket Goto runs in, the Live view's own Goto included. */
type TicketGotoFacts = TicketBaseFacts | LiveViewFacts;
/** The modes the Copy-selection control runs in. */
type CopySelectionFacts = FormFacts | OverrideModelFacts | OverrideTextFacts;

/**
 * The section guards a handler uses to name the modes its behavior runs in.
 *
 * A handler reaches a fact only where the mode that owns the key states it, so
 * a behavior says which section it belongs to instead of reading a field that
 * mode never named. The Main view's Ticket, Consultation, and Work queue
 * handlers each narrow with their section's guard and then act on the row the
 * catalogue gated, never on a second read of the list behind it.
 */
export function ticketSectionFacts(facts: AvailabilityFacts): facts is TicketBaseFacts {
	return ticketBaseMode(facts.mode);
}
export function consultationSectionFacts(facts: AvailabilityFacts): facts is ConsultationBaseFacts {
	return consultationMode(facts.mode);
}
export function workQueueSectionFacts(facts: AvailabilityFacts): facts is WorkQueueBaseFacts {
	return workQueueMode(facts.mode);
}

export interface ControlDefinition {
	id: string;
	label: string;
	/**
	 * The keys the control accepts in each interaction mode.
	 *
	 * One control answers to a key the operator configures: the Agent
	 * terminal's exit key is read from the facts, so the catalogue, the bar,
	 * and the dispatch still share one source for what a key means.
	 */
	// Every member below is declared as a method, not as a property holding a
	// function. A method's parameter is checked bivariantly, so a rule may name
	// just the mode-group facts it reads - `ListFacts`, `TicketBaseFacts` - and
	// the catalogue still calls it with any mode's facts.
	keys(mode: InteractionMode, facts: AvailabilityFacts): readonly ControlKey[];
	/** Displayed in familiar arrow order, then Vim aliases. */
	keyLabel: string;
	scope: ControlScope;
	/** Controls with this flag are candidates for the contextual Action bar. */
	actionBar: boolean;
	/**
	 * Whether one candidate earns a place on the bar in this facts.
	 *
	 * A control whose keys work and whose view would show nothing answers for
	 * itself elsewhere, so the Message control states that here rather than
	 * making the bar test control ids.
	 */
	showInBar?(facts: AvailabilityFacts): boolean;
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
	barLabel?(facts: AvailabilityFacts): string | undefined;
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
	/**
	 * The control belongs to the Ticket section alone (ADR 0060).
	 *
	 * The mirror of the two markers above, and read by the same three rules: the
	 * other sections' modes state the Ticket section's refusal, and their guides
	 * and bars name the control nowhere.
	 */
	ticketSectionOnly?: true;
	/**
	 * The words a section-only control states where no section owns its key.
	 *
	 * The standing sentence names one owning section, and that holds while one
	 * list owns the key. The Ticket section's List filter and the Consultation
	 * section's History answer `f` in two lists, so the Work queue - which owns
	 * neither - states the two owners instead of one (ADR 0060). Omitted: the
	 * marker's own sentence stands.
	 */
	sectionRefusal?(mode: InteractionMode): string;
	/** Larger values survive narrow Action bar packing first. */
	priority: number;
	modes: readonly InteractionMode[];
	availability(facts: AvailabilityFacts): ControlAvailability;
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

/**
 * The Handoff and Override eligibility rules, with one source for each
 * reason. An Override on a settled Ticket misses its Handoff row by one
 * step, so it names that step instead of the state rule. In the panel's own
 * modes, Enter confirms the panel's ticket, not the list's selection, so the
 * state rule belongs to the claim: it re-checks the panel's ticket when the
 * confirm lands. A Handoff in flight holds no ask (ADR 0064): the start it
 * guards answers by its own claim, seat, and cleanup rules.
 */
const handoffEligibility =
	(awaitingReason?: string) =>
	(facts: HandoffFacts): ControlAvailability => {
		// The panel's own modes: while one is open, Enter confirms the panel's
		// ticket, not the list's selection, so the list's Ticket facts are not
		// stated there and this rule answers before them.
		if (
			facts.mode === "override-list" ||
			facts.mode === "override-model" ||
			facts.mode === "override-text"
		)
			return available();
		const ticket = facts.selectedTicket;
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

/**
 * A settled Ticket uses Enter to decide its completed work, not to hand it
 * off. A Handoff in flight holds no decision (ADR 0064): the decision rows
 * answer by their own rules, and the turn decides through its own close. A
 * routed Ticket has decided its turn at the ask (ADR 0072) and rests open
 * behind the wait, so the screen refuses it, and the wait is the Work queue's
 * to show.
 */
const completionEligibility = (facts: TicketBaseFacts): ControlAvailability => {
	// A Group header holds no Ticket (issue #159), and the refusal is this
	// catalogue's own words, not a surface that swallows the key.
	if (facts.selectedTicket === undefined) return unavailable("no Ticket is selected");
	const state = facts.selectedTicket.state;
	return state === "awaiting"
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
const liveViewEligibility = (facts: TicketBaseFacts): ControlAvailability => {
	const ticket = facts.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (inFlight(ticket)) return available();
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
 * Why `f` answers nothing in the Work queue (ADR 0060).
 *
 * The key has two list owners now - the Ticket section cycles its List filter,
 * the Consultation section cycles its history - and the Work queue has neither.
 * The standing one-section sentence is untrue for it, so both controls state
 * these words there: the refusal cannot depend on which candidate the
 * catalogue reaches first.
 */
const LIST_SECTIONS_ONLY =
	"this control is available only in the Ticket section and the Consultation section";
/**
 * Why a Ticket-section control answers nothing in the Consultation section.
 *
 * The control stays a candidate in both sections so the key the operator
 * already knows states a readable refusal instead of doing nothing at all.
 */
const ticketOnly = (facts: AvailabilityFacts): ControlAvailability =>
	ticketBaseMode(facts.mode) ? available() : unavailable(TICKET_ONLY);
const listMove = (facts: ListFacts): ControlAvailability =>
	// The override panel's three rows answer first: its mode follows the row
	// the cursor is on, and the panel owns no list the plane's cursor could run
	// out of, so no step fact is read there.
	facts.mode === "override-list" ||
	facts.mode === "override-model" ||
	facts.mode === "override-text" ||
	facts.listCanMove
		? available()
		: unavailable(
				facts.mode === "repository-select"
					? "the repository list has nowhere to move"
					: consultationMode(facts.mode)
						? "the Consultation list has nowhere to move"
						: workQueueMode(facts.mode)
							? "the Work queue has nowhere to move"
							: "the Ticket list has nowhere to move",
			);
const detailScroll = (facts: DetailFacts): ControlAvailability =>
	facts.detailCanScroll
		? available()
		: unavailable(
				facts.mode === "consultation-detail"
					? "the Consultation detail has nowhere to scroll"
					: workQueueMode(facts.mode)
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
	(facts: WorkQueueBaseFacts): ControlAvailability => {
		const item = facts.selectedWorkQueueItem;
		if (item === null) return unavailable("no queue item is under the cursor");
		const depth = facts.workQueueDepth;
		if (direction === "up" && item.position > 0) return available();
		if (direction === "down" && item.position < depth - 1) return available();
		return unavailable(
			direction === "up" ? "the item is first in the queue" : "the item is last in the queue",
		);
	};
/**
 * Why the Group's move answers the way it does (ADR 0071).
 *
 * The move trades the Group under the cursor with its visible neighbor in the
 * direction, so it stands available while a visible neighbor stands there, and
 * refuses at the edge of the list in the catalogue's own words. A Group the
 * filter hides is no neighbor at all: the position and the count read the
 * visible headers, and the hidden Group keeps its slot in the stored order
 * under the move the operator runs on the visible ones.
 */
const groupOrderMove =
	(direction: "up" | "down") =>
	(facts: TicketBaseFacts): ControlAvailability => {
		if (facts.selectedGroupHeader === null)
			return unavailable("no Group header is under the cursor");
		const position = facts.selectedGroupPosition;
		const count = facts.visibleGroupHeaderCount;
		if (direction === "up" && position > 0) return available();
		if (direction === "down" && position < count - 1) return available();
		return unavailable(
			direction === "up" ? "the group is first in the list" : "the group is last in the list",
		);
	};
const queueRemove = (facts: WorkQueueListFacts): ControlAvailability =>
	facts.selectedWorkQueueItem !== null
		? available()
		: unavailable("no queue item is under the cursor");
/**
 * Why Enter answers a Work queue item with the force-dispatch (issue #89,
 * ADR 0034).
 *
 * The force-dispatch is the queue's only meaning of Enter, and it starts the
 * item now, over a full Parallel limit: every hard start check the pickup
 * runs still runs, only the cap is skipped. A Handoff in flight holds no
 * force-dispatch (ADR 0064): the seat it runs on answers by the module's own
 * seat and cleanup rules, the way the pickup's does, and a Consultation item
 * runs its own pickup seam and never parks on the herdr seat (ADR 0034,
 * issue #90). An empty queue refuses with the one reason the operator can
 * act on, like the queue's other row keys.
 */
const queueForceDispatch = (facts: WorkQueueListFacts): ControlAvailability => {
	if (facts.selectedWorkQueueItem === null) return unavailable("no queue item is under the cursor");
	return available();
};
const refresh = (facts: BaseFacts): ControlAvailability => {
	// The Consultation section's re-read is its own fact, stated only in its own
	// two modes; the other four sections gate on the source facts instead.
	if (facts.mode === "consultation-list" || facts.mode === "consultation-detail")
		return facts.consultationRefreshAvailable
			? available()
			: unavailable("Consultations require SQLite state");
	if (facts.sourceCount === 0) return unavailable("no Ticket sources exist");
	if (facts.refreshingSourceCount >= facts.sourceCount)
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
const consultationRecovery = (facts: ConsultationBaseFacts): ControlAvailability => {
	const consultation = facts.selectedConsultation;
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
const consultationResponse = (facts: ConsultationBaseFacts): ControlAvailability =>
	facts.selectedConsultation?.state === "awaiting-response" &&
	facts.consultationAgentStatus !== "blocked"
		? available()
		: unavailable("only an awaiting Consultation can receive a response");
const consultationInteraction = (facts: ConsultationBaseFacts): ControlAvailability =>
	(facts.selectedConsultation?.state === "working" ||
		(facts.selectedConsultation?.state === "awaiting-response" &&
			facts.consultationAgentStatus === "blocked")) &&
	facts.selectedConsultation?.paneId !== null &&
	facts.selectedConsultation?.paneId !== undefined
		? available()
		: unavailable("only a working or blocked Consultation with an Agent can be interacted with");
/**
 * Why Goto answers nothing (ADR 0025): the Consultation needs a selected
 * row with an Agent pane the last herdr poll reported alive. Goto is
 * navigation: it focuses the pane and leaves the Consultation record
 * untouched.
 */
const consultationGoto = (facts: ConsultationBaseFacts): ControlAvailability =>
	facts.selectedConsultation?.paneId !== null &&
	facts.selectedConsultation?.paneId !== undefined &&
	facts.consultationPaneAlive
		? available()
		: unavailable("the Agent's pane is not alive in the last poll");
/**
 * Why Goto answers nothing on a Ticket (ADR 0033): the Ticket needs a
 * selected row with a handoff pane, an in-flight Ticket needs the Agent's
 * pane alive in the last herdr poll, and an `awaiting` Ticket keeps its
 * recorded pane. Goto is navigation: it focuses the pane and leaves the
 * Ticket, its work cycle, and its traces untouched.
 */
const ticketGoto = (facts: TicketGotoFacts): ControlAvailability => {
	const ticket = facts.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	const paneId = ticket.handoff?.paneId;
	if (paneId === null || paneId === undefined)
		return unavailable("the Agent's pane is not alive in the last poll");
	// The recorded pane stands for an awaiting Ticket, except when herdr has
	// handed the closed pane's id out again: the live agent in the pane that
	// is not the Ticket's own is not the agent the operator went to look at.
	if (ticket.state === "awaiting")
		return facts.ticketPaneForeign
			? unavailable("the Agent's pane is not alive in the last poll")
			: available();
	if (inFlight(ticket) && facts.ticketPaneAlive) return available();
	return unavailable("the Agent's pane is not alive in the last poll");
};
/**
 * Why Close answers nothing on a Ticket (ADR 0031). Key `w` ends the work
 * cycle of the selected Ticket, in both Ticket base modes. An `open` Ticket
 * holds no work in flight, so the close refuses it with that reason, a routed
 * Ticket among them (ADR 0072): the wait is the Work queue's to remove. Every
 * state the close runs on - `handed-off`, `running`, and `awaiting` - has a
 * live agent or a settled turn behind it, and all open the confirmation
 * dialog before anything moves (ADR 0067).
 *
 * A Handoff in flight is no refusal here: the close takes the shared
 * environment seat and queues behind that Handoff, so a hung start still ends
 * in the close the operator asked for (ADR 0031).
 */
const ticketClose = (facts: TicketBaseFacts): ControlAvailability => {
	const ticket = facts.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (ticket.state === "open")
		return unavailable("the selected Ticket is open: no work is in flight to close");
	return available();
};
/**
 * Why `i` answers nothing (ADR 0060): the ignore ends where an obligation
 * begins.
 *
 * One predicate answers this moment and the write's refusal, so the control and
 * the plane cannot tell the operator two stories about the same Ticket. The row
 * reads it from its own facts: the Ticket state, the newest settled turn, and
 * the last poll's missing-Agent marker. Taking a Ticket back is never refused -
 * it hides nothing, and it costs the same effort as putting one away.
 */
const ticketIgnore = (facts: TicketBaseFacts): ControlAvailability => {
	const ticket = facts.selectedTicket;
	if (ticket === undefined) return unavailable("no Ticket is selected");
	if (ticket.ignored) return available();
	const refusal = ignoreRefusal(obligationOf(ticket, facts.selectedTicketMarker));
	return refusal === null ? available() : unavailable(refusal);
};
/**
 * Why `i` answers the Repository init on a Group header (ADR 0075). The key
 * already hides a resting Ticket on a Ticket row, so the two meanings split on
 * the row the cursor stands on: a Group header under the repository axis runs
 * the init, and everywhere else the catalogue states the refusal in its own
 * words. On any other axis the repository the header names is not the split
 * that init acts on, so the key refuses there too.
 */
const repositoryInit = (facts: TicketBaseFacts): ControlAvailability => {
	if (facts.groupingAxis !== "repository")
		return unavailable("init is available on the repository axis only");
	if (!facts.groupHeaderSelected) return unavailable("no Group header is under the cursor");
	return available();
};
/**
 * The state the Ticket section's `f` moves the List filter to (ADR 0060).
 *
 * The hint names the next view, the way the queue pause flips between Pause and
 * Resume, so the key says what it shows before the operator presses it.
 */
/**
 * Why `u` answers nothing (ADR 0070): the mute is the operator's act on the
 * source, and it acts on no ticket of the source in particular, so the row's
 * facts refuse it nowhere. A ticket that owes a decision now, or whose Agent
 * is missing, mutes its source all the same - the act rides on the row and
 * acts on the source - and the same key on a muted row takes the mute back.
 * What it asks is the row itself: a selected Ticket.
 */
const ticketMute = (facts: TicketBaseFacts): ControlAvailability => {
	if (facts.selectedTicket === undefined) return unavailable("no Ticket is selected");
	return available();
};
/**
 * The state the Ticket section's `f` moves the List filter to (ADR 0060,
 * widened by ADR 0070).
 *
 * The hint names the next view, the way the queue pause flips between Pause and
 * Resume, so the key says what it shows before the operator presses it. The
 * mute's ledger stands beside the ignore's in the same cycle, so the hint
 * names the muted view too.
 */
const ticketFilterLabel = (facts: TicketBaseFacts): string =>
	`Show ${nextTicketListFilter(facts.ticketListFilter)}`;
/**
 * The source the `u` act reaches on one row (ADR 0070).
 *
 * The bar names the source the act will act on: every source the row's Ticket
 * came in on, the way the act mutes and un-mutes them together, so the key
 * says what it reaches before the operator presses it. A row that names no
 * source names the act's object alone.
 */
const ticketMuteLabel = (facts: TicketBaseFacts): string => {
	const ticket = facts.selectedTicket;
	if (ticket === undefined) return "Mute";
	const sources = [
		...new Set(ticket.memberships.map((membership) => membership.sourceName)),
	].sort();
	const name = sources.length === 0 ? "source" : sources.join(", ");
	return ticket.muted === true ? `Un-mute ${name}` : `Mute ${name}`;
};
const consultationClose = (facts: ConsultationBaseFacts): ControlAvailability => {
	const consultation = facts.selectedConsultation;
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
const consultationDelete = (facts: ConsultationBaseFacts): ControlAvailability => {
	const state = facts.selectedConsultation?.state;
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
const consultationSchedule = (facts: ConsultationBaseFacts): ControlAvailability => {
	const consultation = facts.selectedConsultation;
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
const consultationStartNow = (facts: ConsultationBaseFacts): ControlAvailability => {
	const consultation = facts.selectedConsultation;
	if (consultation === undefined) return unavailable("no Consultation is selected");
	if (consultation.state === "unscheduled") return available();
	if (consultation.state === "queued")
		return unavailable("the selected Consultation waits in the Work queue for a free seat");
	return unavailable("only an unscheduled Consultation can be started now");
};
const activeQuit = (facts: StandingFacts): ControlAvailability =>
	facts.handoffActive ? unavailable("normal Quit is unavailable during a Handoff") : available();
const message = (facts: StandingFacts): ControlAvailability =>
	facts.messageRecorded ? available() : unavailable("no message has been recorded yet");
/**
 * Why the body's scroll answers nothing (ADR 0039).
 *
 * The control is gated on the facts: unavailable, with a stated reason, when
 * the body already fills the pane's window or carries nothing, so the Action
 * bar never hints a scroll that cannot run and a pressed key says why.
 */
const bodyScroll = (facts: BodyPaneFacts): ControlAvailability => {
	if (facts.bodyEmpty) return unavailable("the body carries no rows");
	if (!facts.bodyScrollable) return unavailable("the body fills its pane");
	return available();
};

/**
 * Why Enter on a row in a list pane jumps or does not (ADR 0049).
 *
 * The row under the cursor carries the fact: a row that waits in the Work
 * queue resolves to its item, and a row that holds no Ticket and no waiting
 * item - a Group header - answers with the section's own missing-selection
 * words.
 */
const queueJump = (facts: QueueJumpFacts): ControlAvailability => {
	if (facts.queueItemForSelectedRow !== null) return available();
	if (facts.mode === "ticket-list" && facts.selectedTicket === undefined)
		return unavailable("no Ticket is selected");
	return unavailable("the selected row has no waiting queue item");
};
const ticketIgnoreLabel = (facts: TicketBaseFacts): string =>
	facts.selectedTicket?.ignored === true ? "Un-ignore" : "Ignore";
/** The init's select list: its own rows, its own search, its own markings (ADR 0082, ADR 0083). */
const repositorySelectConfirm = (facts: RepositorySelectFacts): ControlAvailability =>
	facts.repositoryCount > 0 ? available() : unavailable("the list holds no repository");
const repositorySelectClear = (facts: RepositorySelectFacts): ControlAvailability =>
	facts.searchText !== "" ? available() : unavailable("the search holds no text");
const repositorySelectLabel = (facts: RepositorySelectFacts): string =>
	facts.pendingCount >= 2 ? "Start queue" : "Select";
/** The Ticket section's Grouping axis, as the bar states it (issue #159). */
const groupAxisLabel = (facts: TicketBaseFacts): string | undefined =>
	facts.groupingAxis === "none" ? undefined : groupingAxisHint(facts.groupingAxis);
const groupAxisShown = (facts: TicketBaseFacts): boolean => facts.groupingAxis !== "none";
const groupFoldLabel = (facts: TicketBaseFacts): string =>
	facts.selectedGroupHeader?.collapsed === true ? "Unfold group" : "Fold group";
const groupFoldShown = (facts: TicketBaseFacts): boolean => facts.groupHeaderSelected;
const groupFoldAvailability = (facts: TicketBaseFacts): ControlAvailability =>
	facts.groupHeaderSelected ? available() : unavailable("no Group header is under the cursor");
const groupMoveShown = (facts: TicketBaseFacts): boolean => facts.selectedGroupHeader !== null;
const queuePauseLabel = (facts: StandingFacts): string =>
	facts.queuePaused ? "Resume queue" : "Pause queue";
/** The `e` key on a base-mode row: the Ticket section's override, nowhere else. */
const overrideControl = (facts: BaseFacts): ControlAvailability =>
	facts.mode === "ticket-list" || facts.mode === "ticket-detail"
		? handoffEligibility(
				"awaiting ticket: press Enter, then e on a Handoff row to edit its settings",
			)(facts)
		: ticketOnly(facts);
const consultationRecoveryControl = (facts: ConsultationBaseFacts): ControlAvailability =>
	facts.selectedConsultation?.state === "opening"
		? available()
		: unavailable("only an interrupted opening needs recovery");
/** The focused selector's cycle: a choice with no other value goes nowhere. */
const formCycle = (facts: FormSelectorFacts): ControlAvailability =>
	facts.formCycleCount > 1 ? available() : unavailable("this choice has no other value");
/** The focused action's Confirm: the surface states why it cannot run. */
const formConfirm = (facts: FormActionFacts): ControlAvailability =>
	facts.formRefusal === null ? available() : unavailable(facts.formRefusal);
/** F3 hands a text selection over, and only a selection. */
const copySelection = (facts: CopySelectionFacts): ControlAvailability =>
	facts.fieldHasSelection
		? available()
		: unavailable("the focused field holds no selection to copy");
const copySelectionShown = (facts: CopySelectionFacts): boolean => facts.fieldHasSelection;
/** A Launch needs a Consultation type to launch with. */
const consultationLaunch = (facts: StandingFacts): ControlAvailability =>
	facts.consultationTypesConfigured ? available() : unavailable(CONSULTATION_TYPES_MISSING);
/** A Decision region's selection goes nowhere where the region holds one row. */
const regionSelection = (facts: ActionRegionFacts): ControlAvailability =>
	facts.actionRowCount === 1 ? unavailable("the region holds one row") : available();
/** Only a Handoff row in the decision carries settings to edit (ADR 0068). */
const editAction = (facts: DecisionModalFacts): ControlAvailability =>
	facts.planeActionSelected
		? unavailable("the plane action holds no settings")
		: facts.editableActionSelected
			? available()
			: unavailable("the selected action has no settings to edit");

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
	"repository-select",
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
							: mode === "repository-select"
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
			"repository-select",
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
		availability: queueJump,
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
		// `i` takes the selected Ticket out of the factory's way (ADR 0060): the
		// flag is factory state on the state file, the plane writes nothing to the
		// source, and the same key on an ignored row puts the Ticket back.
		id: "ticket-ignore",
		label: "Ignore",
		barLabel: ticketIgnoreLabel,
		keys: () => ["i"],
		keyLabel: "i",
		scope: "control-plane",
		actionBar: true,
		// Below the Grouping axis hint and above the Launch: the ignore is a row key
		// of the Ticket section, and where the bar has room for one row key only, the
		// axis readout stands (ADR 0058) and the guide carries the ignore. At the
		// flat `none` axis the hint is out of the bar and the ignore names itself in
		// both Ticket panes (ADR 0060, user story 24).
		priority: 42,
		modes: [...baseModes],
		ticketSectionOnly: true,
		availability: ticketIgnore,
		// The reveal rule, not the withheld-row absolute the first version stated:
		// the flag hides a resting row, while a row with live work or a decision owed
		// stays listed under it (ADR 0060).
		guideNote: "hides a resting row and stops every automatic start",
	},
	{
		// The Repository init (ADR 0075): `i` on a Group header under the
		// repository axis makes that repository factory-ready from the
		// factory's own settings, with no agent. The catalogue splits it from
		// the ignore's `i` on the row the cursor stands on, the way it splits
		// the fold's `Space` from the row keys. It stands behind the ignore in
		// the catalogue: on a Group header under the repository axis the init is
		// available and wins the key outright, while on a Ticket row and on any
		// other axis the ignore - first in the list - supplies the refusal, so a
		// press on a resting row or a non-repository header never reads as an init
		// refusal. The handler opens the panel that shows what the act will
		// change before the operator confirms.
		id: "repository-init",
		label: "Init repository",
		keys: () => ["i"],
		keyLabel: "i",
		scope: "control-plane",
		// The init is not a row key the bar names: the operator finds it on the
		// marker the uninit or drifted repository's Group header wears. The bar
		// spends its cells on the keys the rows answer.
		actionBar: false,
		// Guide-only, out of the Action bar: the operator finds the init on the
		// marker the uninit or drifted repository's Group header wears, so the
		// bar spends no cell on a contextual act. The guide still lists the key,
		// and the key resolves through the catalogue's availability.
		guideOnly: true,
		priority: 43,
		modes: [...ticketBaseModes],
		availability: repositoryInit,
	},
	{
		// The init's select list (ADR 0082): `o` opens the list of the
		// repositories the operator's gh identity can init - the user's own,
		// and those of their organizations - from any base pane. The list is
		// the bootstrap path for a repository that has no ticket and no source
		// yet, the case the Group header's `i` cannot reach. The bar names it,
		// because the operator has no row the cursor stands on there.
		id: "repository-select-open",
		label: "Select repository",
		keys: () => ["o"],
		keyLabel: "o",
		scope: "control-plane",
		actionBar: true,
		priority: 38,
		modes: [...baseModes],
		availability: available,
	},
	{
		// The select list's confirm (ADR 0082): Enter hands the row under the
		// cursor to the init's planning, and the confirmation panel the
		// operator reads next is the one the Group header's `i` opens.
		id: "select-repository",
		label: "Select",
		keys: () => ["return"],
		keyLabel: "Enter",
		scope: "control-plane",
		actionBar: true,
		// A marking of two or more turns the select into a queue start (ADR
		// 0083): the hint names the act the key takes then.
		barLabel: repositorySelectLabel,
		priority: 70,
		modes: ["repository-select"],
		availability: repositorySelectConfirm,
	},
	{
		// The select list's queue mark (ADR 0083): Tab marks the row under the
		// cursor for the init queue, and the key unmarks it. A marking of two
		// or more makes Enter run the queue, one repository per confirmation
		// panel, in list order.
		id: "repository-select-toggle",
		label: "Toggle",
		keys: () => ["tab"],
		keyLabel: "Tab",
		scope: "control-plane",
		actionBar: true,
		// Beside the confirm: the mark is the primary act the operator reaches
		// for, so it outranks the confirm and the clear on the bar.
		priority: 75,
		modes: ["repository-select"],
		availability: repositorySelectConfirm,
		guideNote: "marks the row under the cursor for the queue, and unmarks it",
	},
	{
		// The select list's explicit clear (ADR 0082): Backspace edits the
		// search text character by character, and Del takes the whole query
		// back in one key, the way the Model row's clear does.
		id: "repository-select-clear",
		label: "Clear search",
		keys: () => ["delete"],
		keyLabel: "Del",
		scope: "control-plane",
		actionBar: true,
		priority: 60,
		modes: ["repository-select"],
		availability: repositorySelectClear,
	},
	{
		// The select list's way out (ADR 0082): closing discards nothing,
		// because the list keeps no draft.
		id: "repository-select-cancel",
		label: "Cancel",
		keys: () => ["escape"],
		keyLabel: "Esc",
		scope: "control-plane",
		actionBar: true,
		priority: 90,
		modes: ["repository-select"],
		availability: available,
	},
	{
		// `u` takes a source out of the factory's way (ADR 0070): the flag is
		// factory state on the source's row, the same key on a muted row takes
		// it back, and the bar names the source the act will reach. The act
		// settles the rows it takes away in the same write, the way the ignore
		// settles the waiting start it hides.
		id: "ticket-mute",
		label: "Mute",
		barLabel: ticketMuteLabel,
		keys: () => ["u"],
		keyLabel: "u",
		scope: "control-plane",
		actionBar: true,
		// Beside the ignore: the mute is a row key of the Ticket section too, and
		// the bar packs the rarer reveals - the `f` cycle, then the mute - away
		// before they touch the measured ladder's Launch rung (ADR 0070).
		priority: 39,
		modes: [...baseModes],
		ticketSectionOnly: true,
		availability: ticketMute,
		guideNote: "mutes the source the Ticket came in on, and the key un-mutes",
	},
	{
		// `f` cycles the Ticket section's List filter (ADR 0060, widened by ADR
		// 0070): the pile the ignore made and the ledger the mute names are each
		// one keypress from view in either direction. The filter is a view, not
		// factory state, and it opens on the active rows at every boot. The
		// Consultation section's history answers the same key in its own section,
		// the way `w` and `g` carry one meaning per section.
		id: "ticket-filter",
		label: "Filter",
		barLabel: ticketFilterLabel,
		// The filter answers even when its own view holds nothing: an empty
		// active list is exactly when the operator reaches for the pile.
		keys: () => ["f"],
		keyLabel: "f",
		scope: "control-plane",
		actionBar: true,
		// The lowest rung the Ticket section's keys hold: the reveal is the rarest
		// ask of the section's row keys, so a narrow bar packs it away before it
		// touches the Launch, the section toggle, or the Close (ADR 0060).
		priority: 38,
		modes: [...baseModes],
		ticketSectionOnly: true,
		sectionRefusal: (mode) => (workQueueMode(mode) ? LIST_SECTIONS_ONLY : TICKET_ONLY),
		availability: available,
		guideNote: "cycles the Ticket list: active, ignored, muted, all",
	},
	{
		// The Grouping axis (issue #159): one press steps the Ticket section's list
		// to the next split, and `none` is always in the cycle, so the flat list is
		// one press away. `Tab` is bound in no list mode today, and the shared
		// form's field movement is a different mode set, so the plane spends no
		// letter twice. The hint names the axis in effect, and the shell writes the
		// axis to the state file the moment the key lands (ADR 0058).
		id: "group-axis",
		label: "Group",
		keys: () => ["tab"],
		keyLabel: "Tab",
		scope: "control-plane",
		actionBar: true,
		// Only a split axis names a hint: at `none` the entry is hidden from the bar
		// by `showInBar` below, so no word stands here for a flat list.
		barLabel: groupAxisLabel,
		// Just above the Launch entry: the split the list wears outranks the
		// entry the control plane reached for, and the base modes' common
		// controls outrank it, so a narrow row keeps Move, Detail, the Enter
		// meaning, Goto, Close, and the Section toggle first (ADR 0034's
		// packing ladder).
		priority: 43,
		// The flat list needs no hint that says so: the bar states the axis only
		// where a Group header is on screen to explain it. The Key guide names
		// the control whatever the axis in effect, and the Message line states
		// every change.
		modes: [...ticketBaseModes],
		// The axis answers everywhere the plane does, a collapsed Ticket section
		// included: a press still records the operator's choice (user story 10).
		showInBar: groupAxisShown,
		availability: available,
		guideNote: "cycles the grouping axis: none, repository, source, task, state, position",
	},
	{
		// The Group fold (issue #159): `Space` is free in every Main view list
		// mode, and it answers only on a Group header row, where it is the only
		// meaning the key holds (issue #170). `Space` is bound in no other mode
		// here, so no surface spends it twice. A fold hides rows and never
		// facts (ADR 0059), and it lives in memory for the run alone (ADR 0058).
		id: "group-fold",
		label: "Fold",
		keys: () => ["space"],
		keyLabel: "Space",
		scope: "control-plane",
		actionBar: true,
		barLabel: groupFoldLabel,
		// The bar names the fold where its key runs: on a Group header row. On
		// any other row the key refuses, and the bar spends its cells on the
		// keys the rows under the cursor answer, the way the bar spent them
		// before the fold shared its key.
		showInBar: groupFoldShown,
		// The fold outranks the section toggle in the bar, so a header row
		// names both keys, each with its one meaning.
		priority: 47,
		modes: [...ticketBaseModes],
		availability: groupFoldAvailability,
		guideNote: "folds the Group under the cursor, or opens it back",
	},
	{
		// The Group's order keys (ADR 0071): `+` (or `=`, its unshifted form)
		// moves the Group under the cursor to the visible header above it, `-`
		// to the one below it. The queue's own promote and demote read the same
		// keys, and the catalogue keeps the two meanings apart the way it keeps
		// them apart in the queue: by the section the cursor stands in. The
		// move is the operator's fact, written whole to the state file, and the
		// Group's slot never moves on a refresh of the tickets' facts.
		id: "group-move-up",
		label: "Move group up",
		keys: () => ["=", "+"],
		keyLabel: "+",
		scope: "control-plane",
		actionBar: true,
		barLabel: () => "Move up",
		// The bar states only the meaning the facts under the cursor run: the
		// move names itself on a Group header, and a ticket row keeps the bar's
		// old hints, the axis hint among them.
		showInBar: groupMoveShown,
		// Beside the fold it shares the cursor with: the move runs only on a
		// Group header, the way the fold does.
		priority: 46,
		modes: [...ticketBaseModes],
		availability: groupOrderMove("up"),
		guideNote: "moves the Group under the cursor toward the top of the list",
	},
	{
		id: "group-move-down",
		label: "Move group down",
		keys: () => ["-"],
		keyLabel: "-",
		scope: "control-plane",
		actionBar: true,
		barLabel: () => "Move down",
		showInBar: groupMoveShown,
		priority: 44,
		modes: [...ticketBaseModes],
		availability: groupOrderMove("down"),
		guideNote: "moves the Group under the cursor toward the bottom of the list",
	},
	{
		id: "section-toggle",
		label: "Section",
		// `x` collapses the section the cursor is in, or expands it back. The
		// sections stay visible as long as the frame can hold them, so the
		// toggle is a matter of room, not of access. One key, one meaning, on
		// every row of a section, a Group header row included (issue #170).
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
		// in the plane, and the brake reaches the whole plane (ADR 0111):
		// every plane mode names the letter key, the field modes - where the
		// letter types into the row - name the F4 alias the way F1 and F2
		// already carry Help and Message, and the Agent terminal names neither
		// and forwards both to the Agent. The bar hint stands only while the
		// pause stands, in every mode: the standing brake earns its width at the
		// point of action, and the Key guide carries the key the rest of the
		// time.
		id: "queue-pause",
		label: "Pause queue",
		barLabel: queuePauseLabel,
		keys: (mode) => (fieldModes.includes(mode) ? ["f4"] : ["p"]),
		keyLabel: "p/F4",
		scope: "control-plane",
		actionBar: true,
		showInBar: (facts) => facts.queuePaused,
		priority: 58,
		modes: [...planeModes],
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
		availability: consultationLaunch,
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
		// The Work queue owns neither meaning of `f`, so it states the two lists
		// that own the key (ADR 0060).
		consultationSectionOnly: true,
		sectionRefusal: (mode) => (workQueueMode(mode) ? LIST_SECTIONS_ONLY : CONSULTATION_ONLY),
	},
	{
		id: "consultation-close",
		label: "Close",
		// The Delete key closes the Consultation: the same key the Work queue
		// removes an item with, so taking a Consultation out of the queue is
		// one key in both sections. `w` is retired here - the Ticket section
		// keeps it for its own Close, which ends a work cycle rather than
		// removing a queue row.
		keys: () => ["delete"],
		keyLabel: "Delete",
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
		availability: overrideControl,
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
		availability: consultationRecoveryControl,
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
		keys: (_mode, facts) => [exitControlKey(facts.interactionExitKey)],
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
		availability: formCycle,
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
		availability: formConfirm,
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
		availability: copySelection,
		showInBar: copySelectionShown,
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
		// belongs to a history that holds an entry.
		showInBar: (facts) => facts.messageRecorded,
	},
	{
		// `a` flips the Auto-handoff mode (ADR 0036), and it carries the same
		// reach as the Queue pause does (ADR 0111): every plane mode names the
		// letter key, the field modes name the F5 alias, and the Agent terminal
		// names neither and forwards both to the Agent. The two plane-level
		// mode keys carry one reach rule. The mode gets no bar hint: the
		// lamp's word already states the mode.
		id: "auto-handoff",
		label: "Toggle auto-handoff",
		keys: (mode) => (fieldModes.includes(mode) ? ["f5"] : ["a"]),
		keyLabel: "a/F5",
		scope: "control-plane",
		actionBar: false,
		priority: 10,
		modes: [...planeModes],
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
		availability: regionSelection,
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
		modes: ["decision-modal", "live-view", "message-view"],
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
		// about the turn that ended, not about a new Agent. The plane action's
		// row carries none at all, and the reason says so (ADR 0068).
		availability: editAction,
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
		availability: ticketGoto,
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
	facts: AvailabilityFacts,
): ControlDefinition[] {
	return controlsForMode(mode).filter(
		(control) =>
			control.actionBar &&
			!omitFromOtherSection(mode, control) &&
			isReachableInMode(mode, control, facts) &&
			(control.showInBar?.(facts) ?? true),
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
	facts: AvailabilityFacts,
): boolean {
	const keys = control.keys(mode, facts);
	if (keys.length === 0) return true;
	return keys.some((key) => {
		const event = key === "ctrl+c" ? { name: "c", ctrl: true } : { name: key };
		return controlForKey(event, facts)?.id === control.id;
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
function candidatesForKey(facts: AvailabilityFacts, key: ControlKey): readonly ControlDefinition[] {
	const mode = facts.mode;
	// Utility close controls take precedence over global aliases that share
	// their keys. The catalogue still owns both meanings.
	if (mode === "key-guide" && (key === "escape" || key === "f1" || key === "?"))
		return [controlById("guide-close")];
	if (mode === "message-view" && (key === "escape" || key === "f2"))
		return [controlById("message-close")];
	return controlsForMode(mode).filter((control) => control.keys(mode, facts).includes(key));
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
	space: "Space",
	j: "j",
	k: "k",
	h: "h",
	l: "l",
	q: "q",
	e: "e",
	f: "f",
	i: "i",
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
	facts: AvailabilityFacts,
): string[] {
	const ranked = control
		.keys(mode, facts)
		.map(keyName)
		.map((label) => ({ label, rank: label === KEY_NAMES.escape ? 0 : 1, cells: widthOf(label) }));
	ranked.sort((a, b) => a.rank - b.rank || a.cells - b.cells);
	return [...new Set(ranked.map((entry) => entry.label))];
}

/** Find a control accepted by this mode for one OpenTUI key event. */
export function controlForKey(
	key: { name: string; ctrl?: boolean; meta?: boolean },
	facts: AvailabilityFacts,
): ControlDefinition | undefined {
	const name = key.ctrl === true && /^[a-z]$/.test(key.name) ? `ctrl+${key.name}` : key.name;
	const candidates = candidatesForKey(facts, name as ControlKey);
	// Enter has a state-specific completion action as well as Hand off. An
	// available meaning wins. If none is available, the first definition owns
	// the key and supplies its stable unavailable reason - the queue jump
	// excepted: a row that holds no waiting item has no jump to refuse, so it
	// never masks the mode's own Enter reason.
	return (
		candidates.find((control) => availabilityFor(control, facts).available) ??
		candidates.find((control) => control.id !== "queue-jump") ??
		candidates[0]
	);
}

export function availabilityFor(
	control: ControlDefinition,
	facts: AvailabilityFacts,
): ControlAvailability {
	// A Consultation-section control states the section refusal in every other
	// section's modes: the Ticket section and the Work queue both answer the key
	// with the owning section's words. The marker is the single place the
	// ownership is written, so the dispatch, the guide, and the bar all read the
	// same words. The Work queue's own keys state their refusal in the same
	// way (ADR 0049, ADR 0052).
	if (control.consultationSectionOnly === true && otherSectionMode(facts.mode))
		return unavailable(control.sectionRefusal?.(facts.mode) ?? CONSULTATION_ONLY);
	if (control.queueSectionOnly === true && !workQueueMode(facts.mode))
		return unavailable(QUEUE_ONLY);
	if (control.ticketSectionOnly === true && !ticketBaseMode(facts.mode))
		return unavailable(control.sectionRefusal?.(facts.mode) ?? TICKET_ONLY);
	return control.availability(facts);
}

/**
 * Whether the control reaches every mode of the plane and stops at the Agent
 * terminal's door (issue #319, ADR 0111): the Queue pause and the
 * Auto-handoff mode keys. Their reach is a standing fact of the plane, not a
 * property of the mode the guide is open in, so the guide states them once,
 * under the Control plane controls group, in every mode they dispatch in,
 * and the Agent terminal - whose door they stop at - names them nowhere.
 */
function isPlaneWide(control: ControlDefinition): boolean {
	return (
		control.scope === "control-plane" && planeModes.every((mode) => control.modes.includes(mode))
	);
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
	if (
		!workQueueMode(mode) &&
		(control.scope === "work-queue-list" || control.scope === "work-queue-detail")
	)
		return true;
	// The Agent terminal forwards every key to the Agent, so the plane-level
	// keys - the controls every other mode of the plane dispatches - name
	// nowhere in its guide (issue #319, ADR 0111): a key the terminal gives to
	// the Agent is not a key the guide can promise.
	return mode === "consultation-interaction" && isPlaneWide(control);
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
		(!workQueueMode(mode) && control.queueSectionOnly === true) ||
		(!ticketBaseMode(mode) && control.ticketSectionOnly === true)
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
	facts: AvailabilityFacts,
): boolean {
	// A control of another mode is cataloged on its own terms: the guide
	// states what it does and claims nothing about this mode's keys.
	if (!control.modes.includes(mode)) return true;
	const keys = control.keys(mode, facts);
	// A display-only hint (the text row's Type and Backspace) claims no key.
	if (keys.length === 0) return true;
	return keys.some((key) =>
		candidatesForKey(facts, key).some((candidate) => candidate.id === control.id),
	);
}

/** Current-mode controls, then global and control-plane controls, then other modes. */
export function guideControls(facts: AvailabilityFacts): Array<{
	group: string;
	control: ControlDefinition;
}> {
	const mode = facts.mode;
	// The current section is every control this mode dispatches a key for. The
	// bar shows only the meaning the current state runs; the guide shows both.
	const current = controlsForMode(mode).filter(
		(control) =>
			control.actionBar &&
			control.id !== "emergency-exit" &&
			control.guideOnly !== true &&
			// The plane-level keys stand in the Control plane controls group in
			// every mode (issue #319, ADR 0111), not in the mode's own rows: their
			// reach is a standing fact of the plane, and the guide states it once.
			!isPlaneWide(control) &&
			!omitFromOtherSection(mode, control) &&
			isCataloguedInMode(mode, control, facts),
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
				isCataloguedInMode(mode, control, facts),
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
		case "repository-select":
			return "Repository select";
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
	facts: AvailabilityFacts,
): string {
	if (control.id === "interact-exit") return interactionExitLabel(facts.interactionExitKey);
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
	if (control.id === "queue-pause") {
		// A field owns its printable keys, and `p` is one of them: in the field
		// modes only F4 pauses the queue, the way only F1 opens the guide.
		return fieldModes.includes(mode) ? "F4" : "p";
	}
	if (control.id === "auto-handoff") return fieldModes.includes(mode) ? "F5" : "a";
	return control.keyLabel;
}

export function keyLabelFor(
	mode: InteractionMode,
	control: ControlDefinition,
	facts: AvailabilityFacts,
): string {
	return displayKeyLabel(mode, control, false, facts);
}

/** The Key guide shows all aliases which are valid in its source mode. */
export function guideKeyLabel(
	mode: InteractionMode,
	control: ControlDefinition,
	facts: AvailabilityFacts,
): string {
	return displayKeyLabel(mode, control, true, facts);
}
