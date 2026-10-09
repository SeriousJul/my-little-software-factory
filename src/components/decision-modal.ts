/**
 * The decision modal: the turn log of a settled turn, and the actions the
 * operator can take on it.
 *
 * The control plane opens it on an awaiting ticket. It is the modal the
 * awaiting ticket exists for: the operator reads what the agent did and
 * decides the next step. The body is the turn log the trace carries, the
 * agent's messages in order: text blocks with light markdown dressing, and
 * one dim note per tool call. It opens at the bottom, where the agent's
 * conclusion is.
 *
 * The box is two regions (ADR 0039): a bordered, titled Body pane holds the
 * Turn log by itself, and the Decision region - the held cause row and the
 * decision rows - is pinned to the box's floor. The region is bounded and
 * scrolls: it shows as many rows as the box has room for once the log has
 * paid its floor, and its range rides the Action bar behind the selection's
 * hint. An empty turn log states its reason as one row inside the pane, and
 * the pane keeps its chrome.
 *
 * The shape: near-fullscreen, one cell of margin on every side, so the log
 * gets the whole terminal. It pops in over the app: a short fade with the
 * box growing to its final size. Its chrome is the shared modal chrome, so
 * the Action bar keeps its own row at every size, and no in-box hint row
 * stands between the rows the operator confirms and the bar.
 *
 * The keys dispatch through the shared control catalogue hook in the
 * decision-modal interaction mode: up and down move the region's rows, j/k
 * scroll the body one row with the page and jump keys as aliases, e edits
 * the settings of a selected handoff row before it starts, enter confirms
 * the selected action, and esc cancels. While it is open, the keys of the
 * app below are disabled.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import { type Dispatch, type SetStateAction, useMemo, useState } from "react";

import { isHeldCause, type TurnEndCause, type TurnLogEntry } from "../turn-log.ts";
import { type ControlHandler, useControlDispatch } from "./control-dispatch.ts";
import { availabilityFacts, type StandingFacts } from "./controls.ts";
import { maxScrollOf } from "./geometry.ts";
import { type MdColors, type MdLine, renderMarkdown } from "./markdown.ts";
import type { MessageFact } from "./messages.ts";
import {
	type ActionRow,
	bodyScrollWindow,
	decisionActionRows,
	decisionTitle,
	heldCauseRow,
	type ModalBody,
	ModalSurface,
	modalFrame,
	PANE_BORDERS,
	TURN_LOG_PANE,
	turnLogPane,
	useModalPopScale,
} from "./modal-chrome.ts";
import { bodyPaneFacts, type DecisionRegion, useDecisionRegion } from "./shared/region.ts";
import { truncateToWidth } from "./text.ts";
import { paint } from "./theme.ts";

interface DecisionModalProps {
	/** The ticket's title, for the border. */
	title: string;
	/** One context row under the border: repository, task type, agent, time. */
	contextLine: string;
	/** The settled turn's log, in order. */
	entries: readonly TurnLogEntry[];
	/** The turn's end cause; a held cause shows its warning above the rows. */
	cause?: TurnEndCause | null;
	/** The agent's or provider's text for the cause; empty when none. */
	detail?: string;
	/**
	 * The label facts the settled turn's transition wrote, one line per
	 * surface (ADR 0027), above the rows that decide on them.
	 */
	factLines?: readonly string[];
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	/** The `e` key on a row flagged editable: change its Handoff's settings. */
	onEditAction?: (key: string) => void;
	onCancel: () => void;
	/** The base control facts, preserved when this modal owns input. */
	/** The plane's standing facts, read the same way in every mode. */
	standing: StandingFacts;
	/** False while a Key guide or Message view is above this modal. */
	inputActive?: boolean;
	onHelp?: () => void;
	onMessage?: () => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** The Message fact this modal's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this surface (issue #319, ADR 0111): the brake
	 * reaches every surface the plane draws, so the modal dispatches the key
	 * the way it dispatches Help and Message, and the screen that owns the
	 * state runs the toggle. Required, because a surface that resolves the key
	 * and swallows it would be a key the plane takes and never answers.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this surface (issue #319, ADR 0111), the
	 * same reach as the Queue pause's: required for the same reason.
	 */
	onAutoHandoff: () => void;
}

/** The modal leaves one cell of margin on every side. */
const MARGIN = 1;
/** The one row under the border that names the context. */
const CONTEXT_ROWS = 1;
/** The pane's border cells, top and bottom. */

/** The pane's vertical padding cells, one per side: its full chrome with the border. */
const PANE_PADDING = 2;
/** The rows the Turn log keeps before the pane yields its chrome. */
export const DECISION_LOG_FLOOR = 3;
/** The rows the Turn log keeps after the pane has yielded its chrome. */
export const DECISION_LOG_MIN = 1;
/** The one row an empty Turn log states inside the pane. */
export const EMPTY_TURN_LOG_NOTE = "No turn log is recorded for this turn";

/**
 * Fit the regions of the box the decision and the Live view share: the
 * pane's chrome, the body's rows, and the region's visible rows.
 *
 * The body pays its floor of three rows behind the pane's full chrome, and
 * the region - bounded, scrolling - takes the rows the floor leaves it,
 * capped at the rows it holds. A box with no room for the floor yields the
 * pane's padding to the body before the body yields its floor to the region:
 * a box without room for the floor holds the region, the border, and a
 * one-row body. An action row is the only way out, so the region keeps at
 * least its one row before the surface stands down to the size message. The
 * caller passes the box's content rows, the region's rows, the held
 * cause, and the extra region rows above the actions - the transition's
 * fact lines (ADR 0027); `null` is the stand-down.
 */
export function decisionBodyLayout(
	contentRows: number,
	actionRows: number,
	heldCause: boolean,
	extraRegionRows = 0,
): { paneRows: number; panePadding: 0 | 1; regionVisible: number } | null {
	const held = (heldCause ? 1 : 0) + extraRegionRows;
	// The region's one row is its only way out; a region with no rows asks
	// for none, the way the streaming sub-mode's body does.
	const regionMinimum = Math.min(1, actionRows);
	// 1. The body pays its floor behind the pane's full chrome; the region
	//    takes the rows the floor leaves it.
	let regionVisible = Math.min(
		actionRows,
		Math.max(
			0,
			contentRows - CONTEXT_ROWS - held - PANE_BORDERS - PANE_PADDING - DECISION_LOG_FLOOR,
		),
	);
	if (regionVisible >= regionMinimum)
		return {
			paneRows: contentRows - CONTEXT_ROWS - held - PANE_BORDERS - PANE_PADDING - regionVisible,
			panePadding: 1,
			regionVisible,
		};
	// 2. The pane's chrome yields to the body: the border alone, the floor
	//    kept, the region the rest.
	regionVisible = Math.min(
		actionRows,
		Math.max(0, contentRows - CONTEXT_ROWS - held - PANE_BORDERS - DECISION_LOG_FLOOR),
	);
	if (regionVisible >= regionMinimum)
		return {
			paneRows: contentRows - CONTEXT_ROWS - held - PANE_BORDERS - regionVisible,
			panePadding: 0,
			regionVisible,
		};
	// 3. Only then does the body yield rows: the region, the border, and a
	//    one-row body.
	regionVisible = Math.min(
		actionRows,
		Math.max(0, contentRows - CONTEXT_ROWS - held - PANE_BORDERS - DECISION_LOG_MIN),
	);
	if (regionVisible >= regionMinimum)
		return { paneRows: DECISION_LOG_MIN, panePadding: 0, regionVisible };
	return null;
}

/**
 * The turn log's rows at a width: text blocks render with the markdown
 * rules, tool calls are one dim note, "▸ name: target". A blank row stands
 * between two text blocks; a tool note sits close to the text that asked
 * for it. Failed calls wear the warning color.
 */
export function turnLogBody(entries: readonly TurnLogEntry[], width: number): MdLine[] {
	// The log's voices are asked of the theme when the log is drawn, the way
	// every other surface paints at render time: a resolution that changes
	// after this module loads is the resolution the rows paint.
	const colors: MdColors = { text: paint("text"), dim: paint("subtext0") };
	const out: MdLine[] = [];
	let previousWasText = false;
	for (const entry of entries) {
		if (entry.kind === "text") {
			if (previousWasText) out.push([]);
			const lines = renderMarkdown(entry.text, width, colors);
			if (lines.length === 0) out.push([]);
			else out.push(...lines);
			previousWasText = true;
		} else {
			const note = entry.target === "" ? entry.name : `${entry.name}: ${entry.target}`;
			out.push([
				{
					text: truncateToWidth(`▸ ${note}`, width),
					fg: entry.failed ? paint("yellow") : paint("subtext0"),
				},
			]);
			previousWasText = false;
		}
	}
	return out;
}

export function DecisionModal(props: DecisionModalProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	// The pop-in: a short fade with the box growing to its final size, the
	// one the shared chrome owns for every surface it boxes.
	const { pop, scale } = useModalPopScale();
	// The modal is a near-fullscreen surface: it takes the room the terminal
	// offers above its Action bar, and the body scrolls inside it. The shared
	// chrome keeps the box above the bar's row, so its border can never draw
	// through the bar at a short size.
	const frame = modalFrame(terminalWidth, terminalHeight, { margin: MARGIN, scale });
	// A held turn shows its cause in the region, above the rows it refuses
	// (ADR 0016): one row the log yields to, so the operator reads why the
	// turn is held before the rows that decide it.
	const held = props.cause !== null && isHeldCause(props.cause);
	const unscaled = modalFrame(terminalWidth, terminalHeight, { margin: MARGIN });
	const bodyFacts = useDecisionBodyFacts(props, frame, held, unscaled.contentRows);
	// The region's selection, its wrap, its auto-scroll, its visible window,
	// and its range text are the shared region's, beside the field, the
	// selector row, and the form (ADR 0039 and ADR 0040).
	const region = useDecisionRegion(props.actions, bodyFacts.layout?.regionVisible ?? 0);
	// The fact the gate and the bar share: the row under the cursor carries
	// settings to edit, and this surface can open the panel for them. Close
	// and Goto decide about the turn that ended, so their rows leave the
	// control dimmed and say why when it is pressed.
	const editableActionSelected =
		props.onEditAction !== undefined && props.actions[region.at]?.editable === true;
	// The plane action's row holds no settings (ADR 0068): the surface states
	// it, and the catalogue keeps the one gate with the reason it names.
	const planeActionSelected = props.actions[region.at]?.planeAction === true;
	// The modal states the facts its own regions produce: the Decision
	// region's row count, and the Body pane's window beside it.
	const facts = availabilityFacts("decision-modal", props.standing, {
		editableActionSelected,
		planeActionSelected,
		...bodyPaneFacts(bodyFacts.renderedBody.length, bodyFacts.bodyRows, bodyFacts.emptyLog),
		actionRowCount: props.actions.length,
	});
	const scrollBody = useDecisionScroll(
		bodyFacts.maxBodyScroll,
		bodyFacts.bodyRows,
		bodyFacts.setBodyScroll,
	);
	const { visibleBody, thumbRows } = bodyScrollWindow(bodyFacts);
	useControlDispatch({
		facts,
		active: props.inputActive,
		onUnavailable: props.onUnavailable,
		onEmergencyExit: props.onEmergencyExit,
		handlers: decisionModalHandlers(props, {
			region,
			editableActionSelected,
			scrollBody,
		}),
	});

	const modalBody = decisionModalBody(props, {
		frame,
		held,
		region,
		bodyFacts,
		visibleBody,
		thumbRows,
	});

	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title: decisionTitle(props.title),
		opacity: pop,
		body: modalBody,
		message: props.message,
		bar: {
			mode: "decision-modal",
			facts,
			rangeIndicator: region.rangeText,
		},
		queuePaused: props.standing.queuePaused,
	});
}

/** The body pane's facts: the layout, the body, the scroll's range. */
function useDecisionBodyFacts(
	props: DecisionModalProps,
	frame: ReturnType<typeof modalFrame>,
	held: boolean,
	contentRows: number,
): DecisionBodyFacts {
	const { entries, actions, factLines = [] } = props;
	// The pane's chrome yields before the log yields rows: padding first,
	// border second, and only then does the surface stand down to the size
	// message. The scrollbar is decided at the final size, so the thumb does
	// not flicker in and out while the pop-in grows the box.
	// The transition's fact lines stand above the action rows, like the
	// held-cause row: the rows decide on the facts, so the log yields to
	// them (ADR 0027).
	const finalLayout = decisionBodyLayout(contentRows, actions.length, held, factLines.length);
	const layout = decisionBodyLayout(frame.contentRows, actions.length, held, factLines.length);
	// An empty turn log states its reason as one row inside the pane, and
	// the pane keeps its chrome.
	const emptyLog = entries.length === 0;
	// The pane's body width at this render: the box's content minus the
	// pane's border and padding, and one column for the inline thumb when
	// the body scrolls. A scrollbar can add wrap rows, so determine overflow
	// once at the full pane width, then wrap at the narrower text width.
	// The pane's padding is the one its layout decided, on every side.
	const panePadding = layout?.panePadding ?? 0;
	const paneInnerWidth = Math.max(1, frame.contentWidth - PANE_BORDERS - 2 * panePadding);
	const fullWidthBody = useMemo(
		() =>
			emptyLog
				? [[{ text: EMPTY_TURN_LOG_NOTE, fg: paint("subtext0") }]]
				: turnLogBody(entries, paneInnerWidth),
		[entries, emptyLog, paneInnerWidth],
	);
	const hasScrollbar = finalLayout !== null && fullWidthBody.length > finalLayout.paneRows;
	const bodyWidth = Math.max(1, paneInnerWidth - (hasScrollbar ? 1 : 0));
	// Wrap at the width the box has right now, so a line is never wider
	// than the frame being drawn while the pop-in grows the box.
	const renderedBody = useMemo(
		() =>
			emptyLog
				? [[{ text: EMPTY_TURN_LOG_NOTE, fg: paint("subtext0") }]]
				: turnLogBody(entries, bodyWidth),
		[entries, emptyLog, bodyWidth],
	);
	const bodyRows = layout === null ? 0 : Math.min(renderedBody.length, layout.paneRows);
	const maxBodyScroll = maxScrollOf(renderedBody.length, bodyRows);
	// A settled turn ends with its conclusion: open at the bottom, with the
	// newest line in view. `null` pins the view to the bottom until the
	// operator scrolls: the bottom's index moves while the box grows in.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);
	return {
		layout,
		emptyLog,
		panePadding,
		hasScrollbar,
		bodyWidth,
		renderedBody,
		bodyRows,
		maxBodyScroll,
		bodyScroll,
		setBodyScroll,
	};
}

/**
 * The body pane's facts: the layout, the body, the scroll's range, and the
 * view the body stands at.
 */
interface DecisionBodyFacts {
	layout: ReturnType<typeof decisionBodyLayout>;
	emptyLog: boolean;
	panePadding: 0 | 1;
	hasScrollbar: boolean;
	bodyWidth: number;
	renderedBody: MdLine[];
	bodyRows: number;
	maxBodyScroll: number;
	bodyScroll: number | null;
	setBodyScroll: Dispatch<SetStateAction<number | null>>;
}

/** The modal's control catalogue handlers. */
function decisionModalHandlers(
	props: DecisionModalProps,
	fields: {
		region: DecisionRegion;
		editableActionSelected: boolean;
		scrollBody: (name: string) => void;
	},
): Record<string, ControlHandler> {
	const { region, editableActionSelected, scrollBody } = fields;
	// Scroll the body by one step of the named key: a page moves one viewport
	// minus the shared row, and the jump keys take either edge. A null view
	// is the bottom, so the first step reads the bottom's index.
	return {
		help: () => props.onHelp?.(),
		message: () => props.onMessage?.(),
		"cancel-action": props.onCancel,
		"confirm-action": () => region.confirm((row) => props.onAction(row.key)),
		"edit-action": () => {
			const row = props.actions[region.at];
			if (row !== undefined && editableActionSelected) props.onEditAction?.(row.key);
		},
		"select-action": ({ key }) => region.move(key.name === "up" ? -1 : 1),
		"scroll-body": ({ key }) => scrollBody(key.name),
		// The plane-level keys reach every surface the chrome owns (issue
		// #319, ADR 0111): the brake and the mode flip on the modal the way
		// they do on the base panes, and the bar's hint and the border's lamp
		// read the facts the toggle writes.
		"queue-pause": props.onQueuePause,
		"auto-handoff": props.onAutoHandoff,
	};
}

/** The body's scroll step for one named key. */
function useDecisionScroll(
	maxBodyScroll: number,
	bodyRows: number,
	setBodyScroll: Dispatch<SetStateAction<number | null>>,
): (name: string) => void {
	return (name: string) => {
		if (name === "pageup")
			setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - Math.max(1, bodyRows)));
		else if (name === "pagedown")
			setBodyScroll((current) =>
				Math.min(maxBodyScroll, (current ?? maxBodyScroll) + Math.max(1, bodyRows)),
			);
		else if (name === "home") setBodyScroll(0);
		else if (name === "end") setBodyScroll(maxBodyScroll);
		else if (name === "j")
			setBodyScroll((current) => Math.min((current ?? maxBodyScroll) + 1, maxBodyScroll));
		else setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - 1));
	};
}

/** The modal's body: the context line, the turn log pane, the region rows. */
function decisionModalBody(
	props: DecisionModalProps,
	fields: {
		frame: ReturnType<typeof modalFrame>;
		held: boolean;
		region: DecisionRegion;
		bodyFacts: DecisionBodyFacts;
		visibleBody: MdLine[];
		thumbRows: ReadonlySet<number> | null;
	},
): ModalBody {
	const { frame, held, region, bodyFacts, visibleBody, thumbRows } = fields;
	return {
		above: [
			createElement(
				"text",
				{ key: "context", fg: paint("subtext0") },
				truncateToWidth(props.contextLine, frame.contentWidth),
			),
		],
		pane: turnLogPane({
			paneRows: bodyFacts.layout?.paneRows ?? null,
			panePadding: bodyFacts.panePadding,
			visibleBody,
			bodyWidth: bodyFacts.bodyWidth,
			thumbRows,
			title: TURN_LOG_PANE,
		}),
		below: [
			...(held && props.cause != null
				? [heldCauseRow(props.cause, props.detail ?? "", frame.contentWidth)]
				: []),
			...(props.factLines ?? []).map((line, index) =>
				createElement(
					"text",
					{ key: `fact-${index}`, fg: paint("blue") },
					truncateToWidth(line, frame.contentWidth),
				),
			),
			...decisionActionRows(region, props.actions, frame.contentWidth),
		],
		minRows:
			CONTEXT_ROWS +
			(held ? 1 : 0) +
			(props.factLines ?? []).length +
			PANE_BORDERS +
			DECISION_LOG_MIN +
			Math.min(1, props.actions.length),
	};
}
