/**
 * The Live view: the agent's terminal, streamed, above an in-flight ticket.
 *
 * The control plane opens it on a `handed-off` or `running` ticket. It is a
 * shared-chrome surface (ADR 0040): the shared modal's box, the Message
 * line, and the Action bar, with the body in its own Body pane (ADR 0039).
 * While the agent works the pane is the Agent view: plain text, the tail
 * the completion-message-lines setting names, refreshed at the one-second
 * cadence, pinned to the bottom while new output arrives. When the turn
 * settles and the factory waits for the operator's decision, the same box
 * carries the decision sub-mode: the pane re-titles to the Turn log, the
 * region's rows and their keys come in, and the border re-titles `Live:` to
 * `Decision:` in place - one screen, one pop-in per opening, the prefix the
 * shared chrome owns, so Enter on an `awaiting` ticket and a turn settling
 * under an open Live view end at one screen with one name. A settled turn
 * the factory decides for itself (auto-close) keeps streaming, because the
 * factory keeps working.
 *
 * The keys dispatch from the Control catalogue. The streaming sub-mode
 * answers to a `live-view` mode of its own: the body's scroll, the Goto
 * confirm, and the leave. The settled sub-mode dispatches in the existing
 * `decision-modal` mode: up and down move the region's rows, and e edits a
 * selected handoff row. The bar's hints follow the mode, and the Key guide
 * names it. The sub-mode switch is in place: the surface keeps its pop-in,
 * its scroll, and its box, and no in-box hint row stands in the box.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import type { Ticket } from "../domain/ticket.ts";
import { isHeldCause, type TurnEndCause, type TurnLogEntry } from "../turn-log.ts";
import { type ControlHandler, useControlDispatch } from "./control-dispatch.ts";
import { availabilityFacts, type StandingFacts } from "./controls.ts";
import { decisionBodyLayout, turnLogBody } from "./decision-modal.ts";
import { maxScrollOf } from "./geometry.ts";
import type { MdLine, MdSpan } from "./markdown.ts";
import type { MessageFact } from "./messages.ts";
import {
	type ActionRow,
	AGENT_VIEW_PANE,
	bodyScrollWindow,
	decisionActionRows,
	decisionTitle,
	heldCauseRow,
	liveTitle,
	type ModalBody,
	ModalSurface,
	modalFrame,
	PANE_BORDERS,
	TURN_LOG_PANE,
	turnLogPane,
	useModalPopScale,
} from "./modal-chrome.ts";
import { bodyPaneFacts, type DecisionRegion, useDecisionRegion } from "./shared/region.ts";
import { truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

/** The Live view leaves one cell of margin on every side. */
const MARGIN = 1;
/** The one row under the border that names the context. */
const CONTEXT_ROWS = 1;
/** The rows the body keeps behind the pane's border alone. */
const BODY_MIN = 1;

/** The body the Live view pane shows. */
export type LiveViewBody =
	| { kind: "stream"; lines: readonly string[]; note: string | null }
	| { kind: "turn-log"; entries: readonly TurnLogEntry[] };

interface LiveViewProps {
	/** The ticket title, for the border. */
	title: string;
	/** The context line under the border: repository, task type, agent. */
	contextLine: string;
	/** True while the latest observation reports the agent as blocked. */
	blocked: boolean;
	/** The pane's body: the stream, or the settled turn's log. */
	body: LiveViewBody;
	/** The turn's end cause; a held cause stands in the region, above its rows. */
	cause?: TurnEndCause | null;
	/** The agent's or provider's text for the cause; empty when none. */
	detail?: string;
	/** The decision's rows, shown in the decision sub-mode. */
	actions: readonly ActionRow[];
	onAction: (key: string) => void;
	/** The `e` key on a row flagged editable: change its Handoff's settings. */
	onEditAction?: (key: string) => void;
	/** The Goto confirm of the streaming sub-mode: focus the pane, close. */
	onGoto: () => void;
	onCancel: () => void;
	/** The base control facts, preserved when this view owns input. */
	/** The plane's standing facts, read the same way in every mode. */
	standing: StandingFacts;
	/** The Ticket the view streams: the Goto focuses that Ticket's pane. */
	ticket: Ticket;
	/** Whether that Ticket's Agent pane is alive in the last herdr poll. */
	paneAlive: boolean;
	/** Whether that Ticket's recorded pane holds an agent that is not its own. */
	paneForeign: boolean;
	/** False while a Key guide or Message view is above this view. */
	inputActive?: boolean;
	onHelp?: () => void;
	onMessage?: () => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** The Message fact this view's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this view (issue #319, ADR 0111): the brake
	 * reaches every surface the plane draws, and the view dispatches the key
	 * the way it dispatches Help and Message. Required, because a surface that
	 * resolves the key and swallows it would be a key the plane takes and never
	 * answers.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this view (issue #319, ADR 0111), the same
	 * reach as the Queue pause's: required for the same reason.
	 */
	onAutoHandoff: () => void;
}

/** One stream row as styled lines: plain text, the palette's prose voice. */
function streamLines(lines: readonly string[], note: string | null, width: number): MdLine[] {
	const out: MdLine[] = lines.flatMap((line) => {
		if (line === "") return [[]];
		return wrapToWidth(line, width).map<MdLine>((row) => [
			{ text: row, fg: paint("text") } satisfies MdSpan,
		]);
	});
	// The read's trailing newline is not a line: the tail's last row is the
	// agent's last output, so the bottom pin rests on it, not on a blank.
	if (out.length > 0 && out[out.length - 1].length === 0) out.pop();
	// A failed read keeps the last lines, with the stale note as the body's
	// last line, inside the pane.
	if (note !== null) out.push([{ text: note, fg: paint("subtext0") }]);
	return out;
}

export function LiveView(props: LiveViewProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	// The decision sub-mode, from the body the pane holds: a turn settling
	// for the operator flips it in place, without a second pop-in.
	const decideable = props.body.kind === "turn-log";
	const { pop, scale } = useModalPopScale();
	const frame = modalFrame(terminalWidth, terminalHeight, { margin: MARGIN, scale });
	// A held turn shows its cause in the region, above the rows it refuses
	// (ADR 0016): one row the body yields to, so the operator reads why the
	// turn is held before the rows that decide it.
	const held = decideable && props.cause !== null && isHeldCause(props.cause);
	const regionRows = decideable ? props.actions.length : 0;
	// The regions of the box: the pane's chrome, the body's rows, the
	// region's visible rows. The layout is decided at the final size, so
	// the scrollbar never flickers in and out while the pop-in grows the box.
	const unscaled = modalFrame(terminalWidth, terminalHeight, { margin: MARGIN });
	const bodyFacts = useLiveBodyFacts(props, { frame, decideable, held, contentFrame: unscaled });
	// The region's selection, its wrap, its auto-scroll, its visible window,
	// and its range text are the shared region's, beside the field, the
	// selector row, and the form (ADR 0039 and ADR 0040).
	const region = useDecisionRegion(
		decideable ? props.actions : [],
		bodyFacts.layout?.regionVisible ?? 0,
	);
	const editableActionSelected =
		decideable && props.onEditAction !== undefined && props.actions[region.at]?.editable === true;
	// The plane action's row holds no settings (ADR 0068): the surface states
	// it, and the catalogue keeps the one gate with the reason it names.
	const planeActionSelected = decideable && props.actions[region.at]?.planeAction === true;
	// The sub-mode dispatches from the catalogue: the streaming sub-mode
	// answers to a live-view mode of its own, the settled sub-mode to the
	// decision-modal mode the glossary already names. The record names which
	// one it is.
	//
	// The view states the facts its own Body pane and its own Decision region
	// produce, beside the Ticket it streams. The settled sub-mode adds the
	// action rows' facts; the streaming sub-mode names none of them.
	const facts = liveViewFacts(props, {
		decideable,
		regionRows,
		editableActionSelected,
		planeActionSelected,
		pane: bodyFacts.pane,
	});
	const scrollBody = useLiveScroll(bodyFacts);
	useControlDispatch({
		facts,
		active: props.inputActive,
		onUnavailable: props.onUnavailable,
		onEmergencyExit: props.onEmergencyExit,
		handlers: liveViewHandlers(props, { decideable, region, editableActionSelected, scrollBody }),
	});

	const liveBody = liveViewBody(props, { frame, decideable, held, region, bodyFacts });

	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		// The border re-titles `Live:` to `Decision:` when the turn settles
		// for the operator: the prefix is the chrome's, so both paths into
		// the decision end at one screen with one name (ADR 0040).
		title: decideable ? decisionTitle(props.title) : liveTitle(props.title),
		opacity: pop,
		body: liveBody,
		message: props.message,
		bar: {
			mode: facts.mode,
			facts,
			rangeIndicator: region.rangeText,
		},
		queuePaused: props.standing.queuePaused,
	});
}

/** The body pane's facts: the layout, the body, the scroll's range, the pane. */
interface LiveBodyFacts {
	layout: ReturnType<typeof decisionBodyLayout>;
	panePadding: 0 | 1;
	hasScrollbar: boolean;
	bodyWidth: number;
	renderedBody: MdLine[];
	bodyRows: number;
	maxBodyScroll: number;
	bodyScroll: number | null;
	setBodyScroll: Dispatch<SetStateAction<number | null>>;
	pane: ReturnType<typeof bodyPaneFacts>;
}

/** The body pane's facts: the layout, the body, the scroll's range, the pane. */
function useLiveBodyFacts(
	props: LiveViewProps,
	fields: {
		frame: ReturnType<typeof modalFrame>;
		decideable: boolean;
		held: boolean;
		contentFrame: ReturnType<typeof modalFrame>;
	},
): LiveBodyFacts {
	const { frame, decideable, held, contentFrame } = fields;
	const regionRows = decideable ? props.actions.length : 0;
	const finalLayout = decisionBodyLayout(contentFrame.contentRows, regionRows, held);
	const layout = decisionBodyLayout(frame.contentRows, regionRows, held);
	// The pane's padding is the one its layout decided, on every side: the
	// body's width is the box's content minus the pane's border and padding,
	// and one column for the inline thumb when the body scrolls. A scrollbar
	// can add wrap rows, so determine overflow once at the full pane width,
	// then wrap at the narrower text width.
	const panePadding = layout?.panePadding ?? 0;
	const paneInnerWidth = Math.max(1, frame.contentWidth - PANE_BORDERS - 2 * panePadding);
	const fullWidthBody = useMemo(
		() =>
			props.body.kind === "turn-log"
				? turnLogBody(props.body.entries, paneInnerWidth)
				: streamLines(props.body.lines, props.body.note, paneInnerWidth),
		[props.body, paneInnerWidth],
	);
	const hasScrollbar = finalLayout !== null && fullWidthBody.length > finalLayout.paneRows;
	const bodyWidth = Math.max(1, paneInnerWidth - (hasScrollbar ? 1 : 0));
	// Wrap at the width the box has right now, so a line is never wider
	// than the frame being drawn while the pop-in grows the box.
	const renderedBody = useMemo(
		() =>
			props.body.kind === "turn-log"
				? turnLogBody(props.body.entries, bodyWidth)
				: streamLines(props.body.lines, props.body.note, bodyWidth),
		[props.body, bodyWidth],
	);
	const bodyRows = layout === null ? 0 : Math.min(renderedBody.length, layout.paneRows);
	const maxBodyScroll = maxScrollOf(renderedBody.length, bodyRows);
	// The newest output is in front: the body opens at its bottom and stays
	// pinned to it while new rows arrive, until the operator scrolls.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);
	const bodyEmpty =
		props.body.kind === "turn-log"
			? props.body.entries.length === 0
			: props.body.lines.length === 0 && props.body.note === null;
	return {
		layout,
		panePadding,
		hasScrollbar,
		bodyWidth,
		renderedBody,
		bodyRows,
		maxBodyScroll,
		bodyScroll,
		setBodyScroll,
		pane: bodyPaneFacts(renderedBody.length, bodyRows, bodyEmpty),
	};
}

/** The view's control facts, by the sub-mode that stands. */
function liveViewFacts(
	props: LiveViewProps,
	fields: {
		decideable: boolean;
		regionRows: number;
		editableActionSelected: boolean;
		planeActionSelected: boolean;
		pane: ReturnType<typeof bodyPaneFacts>;
	},
) {
	const { decideable, regionRows, editableActionSelected, planeActionSelected, pane } = fields;
	return decideable
		? availabilityFacts("decision-modal", props.standing, {
				editableActionSelected,
				planeActionSelected,
				...pane,
				actionRowCount: regionRows,
			})
		: availabilityFacts("live-view", props.standing, {
				selectedTicket: props.ticket,
				ticketPaneAlive: props.paneAlive,
				ticketPaneForeign: props.paneForeign,
				...pane,
			});
}

/**
 * The body's scroll step for one named key. Reaching the bottom re-pins the
 * stream: new output comes into view again without the operator asking.
 */
function useLiveScroll(facts: LiveBodyFacts): (name: string) => void {
	const { maxBodyScroll, bodyRows, setBodyScroll } = facts;
	return (name: string) => {
		if (name === "pageup")
			setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - Math.max(1, bodyRows)));
		else if (name === "pagedown")
			setBodyScroll((current) => {
				const next = Math.min((current ?? maxBodyScroll) + Math.max(1, bodyRows), maxBodyScroll);
				return next >= maxBodyScroll ? null : next;
			});
		else if (name === "home") setBodyScroll(0);
		else if (name === "end") setBodyScroll(null);
		else if (name === "j")
			setBodyScroll((current) => {
				const next = Math.min((current ?? maxBodyScroll) + 1, maxBodyScroll);
				return next >= maxBodyScroll ? null : next;
			});
		// The catalogue feeds this handler only the named keys, so an unknown
		// name is a no-op, not a guess for `k`.
		else if (name === "k") setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - 1));
	};
}

/** The view's control catalogue handlers, by the sub-mode that stands. */
function liveViewHandlers(
	props: LiveViewProps,
	fields: {
		decideable: boolean;
		region: DecisionRegion;
		editableActionSelected: boolean;
		scrollBody: (name: string) => void;
	},
): Record<string, ControlHandler> {
	const { decideable, region, editableActionSelected, scrollBody } = fields;
	return {
		help: () => props.onHelp?.(),
		message: () => props.onMessage?.(),
		"cancel-action": props.onCancel,
		"scroll-body": ({ key }) => scrollBody(key.name),
		// The plane-level keys reach every surface the chrome owns (issue
		// #319, ADR 0111), the way the border's lamp reads the facts the
		// toggle writes.
		"queue-pause": props.onQueuePause,
		"auto-handoff": props.onAutoHandoff,
		...(decideable
			? {
					"confirm-action": () => region.confirm((row) => props.onAction(row.key)),
					"select-action": ({ key }) => region.move(key.name === "up" ? -1 : 1),
					"edit-action": () => {
						const row = props.actions[region.at];
						if (row !== undefined && editableActionSelected) props.onEditAction?.(row.key);
					},
				}
			: { "live-goto": () => props.onGoto() }),
	};
}

/** The view's body: the context row, the pane, the region's rows. */
function liveViewBody(
	props: LiveViewProps,
	fields: {
		frame: ReturnType<typeof modalFrame>;
		decideable: boolean;
		held: boolean;
		region: DecisionRegion;
		bodyFacts: LiveBodyFacts;
	},
): ModalBody {
	const { frame, decideable, held, region, bodyFacts } = fields;
	const regionRows = decideable ? props.actions.length : 0;
	const { visibleBody, thumbRows } = bodyScrollWindow(bodyFacts);
	// The context row carries the blocked status in the warning color.
	const blockedSuffix = " · blocked";
	const baseWidth = props.blocked
		? Math.max(0, frame.contentWidth - widthOf(blockedSuffix))
		: frame.contentWidth;
	return {
		above: [
			createElement(
				"text",
				{ key: "context" },
				createElement(
					"span",
					{ fg: paint("subtext0") },
					truncateToWidth(props.contextLine, baseWidth),
				),
				props.blocked && createElement("span", { fg: paint("yellow") }, blockedSuffix),
			),
		],
		pane: turnLogPane({
			paneRows: bodyFacts.layout?.paneRows ?? null,
			panePadding: bodyFacts.panePadding,
			visibleBody,
			bodyWidth: bodyFacts.bodyWidth,
			thumbRows,
			title: decideable ? TURN_LOG_PANE : AGENT_VIEW_PANE,
		}),
		below: [
			...(held && props.cause != null
				? [heldCauseRow(props.cause, props.detail ?? "", frame.contentWidth)]
				: []),
			...decisionActionRows(region, props.actions, frame.contentWidth),
		],
		minRows: CONTEXT_ROWS + (held ? 1 : 0) + PANE_BORDERS + BODY_MIN + Math.min(1, regionRows),
	};
}
